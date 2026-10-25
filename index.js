import 'dotenv/config';
import express from 'express';
import makeWASocket, {
  useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion,
  proto, generateWAMessageFromContent, prepareWAMessageMedia, isJidGroup,
  BufferJSON, initAuthCreds, makeCacheableSignalKeyStore
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { MongoClient } from 'mongodb';
import { fileURLToPath } from 'node:url';

// libsignal prints huge session dumps with console.* on every key mismatch; drop that noise.
const NOISE = /^(Closing session|Closing open session|Session error|Failed to decrypt message|Removing old closed session|Migrating session|Decrypted message with closed session|Bad MAC)/;
for (const level of ['log', 'info', 'warn', 'error']) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    const first = args[0];
    if (typeof first === 'string' && NOISE.test(first)) return;
    if (first && typeof first === 'object' && first.constructor?.name === 'SessionEntry') return;
    original(...args);
  };
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const BOT_NAME = process.env.BOT_NAME || 'RIO X MD';
const PREFIX = (process.env.PREFIX || '.').trim() || '.';
const API_KEY = (process.env.PAIRING_API_KEY || '').trim();
const PLACEHOLDER_KEY = 'change-this-to-a-long-random-secret';
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS || 20);
const PAIR_TIMEOUT_MS = 5 * 60 * 1000; // unpaired sessions are removed after 5 minutes
const MAX_MSG_AGE_S = 60; // ignore old queued messages after a reconnect
// On Render, point SESSION_DIR at the persistent disk (e.g. /var/data/sessions).
const SESSION_ROOT = path.resolve(process.env.SESSION_DIR || path.join(__dirname, 'sessions'));
fs.mkdirSync(SESSION_ROOT, { recursive: true });

const logger = pino({ level: 'silent' });
const app = express();
app.set('trust proxy', 1); // Render sits behind a proxy; needed for correct client IPs
app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const sessions = new Map(); // id -> { sock, state, qr, pairCode, status, phone, starting, removed, retries, timers }
const cooldowns = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- helpers ---------- */
function safeId(value) { return /^[a-f0-9]{24}$/.test(String(value || '')); }
function sessionPath(id) { return path.join(SESSION_ROOT, id); }
function keyIsConfigured() { return API_KEY.length >= 12 && API_KEY !== PLACEHOLDER_KEY; }
function sha(v) { return crypto.createHash('sha256').update(String(v)).digest(); }

function makeLimiter(max, windowMs) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, windowMs).unref();
  return (req, res, next) => {
    const now = Date.now();
    const k = req.ip;
    const e = hits.get(k);
    if (!e || e.reset <= now) { hits.set(k, { count: 1, reset: now + windowMs }); return next(); }
    if (++e.count > max) {
      res.set('Retry-After', String(Math.ceil((e.reset - now) / 1000)));
      return res.status(429).json({ error: 'Too many requests. Please wait a bit and try again.' });
    }
    next();
  };
}
const apiLimiter = makeLimiter(90, 60 * 1000);
const createLimiter = makeLimiter(5, 10 * 60 * 1000);

function authRequired(req, res, next) {
  if (!keyIsConfigured()) {
    return res.status(503).json({ error: 'Server is not configured: set a PAIRING_API_KEY of at least 12 characters.' });
  }
  const given = req.get('x-api-key') || '';
  if (!crypto.timingSafeEqual(sha(given), sha(API_KEY))) {
    return res.status(401).json({ error: 'Invalid API key.' });
  }
  next();
}

function clearTimers(record) {
  clearTimeout(record.expiryTimer);
  clearTimeout(record.reconnectTimer);
}

function destroySession(id, { deleteFiles = true } = {}) {
  const record = sessions.get(id);
  if (record) {
    record.removed = true;
    clearTimers(record);
    try { record.sock?.end(undefined); } catch {}
    sessions.delete(id);
  }
  if (deleteFiles) deleteSessionData(id).catch(() => {});
}


/* ---------- session storage (MongoDB or local files) ---------- */
const MONGO_URL = (process.env.MONGO_URL || '').trim();
const MONGO_DB = (process.env.MONGO_DB || 'rio_x_md').trim();
let mongoCol = null;

async function getMongoCol() {
  if (!MONGO_URL) return null;
  if (mongoCol) return mongoCol;
  const client = new MongoClient(MONGO_URL, { serverSelectionTimeoutMS: 15000 });
  await client.connect();
  const col = client.db(MONGO_DB).collection('auth');
  await col.createIndex({ sid: 1 });
  mongoCol = col;
  console.log('Auth storage: MongoDB (sessions survive redeploys).');
  return col;
}

async function useMongoAuthState(col, sid) {
  const id = (k) => `${sid}:${k}`;
  const write = (k, v) => col.updateOne({ _id: id(k) }, { $set: { sid, data: JSON.stringify(v, BufferJSON.replacer) } }, { upsert: true });
  const read = async (k) => {
    const doc = await col.findOne({ _id: id(k) });
    return doc ? JSON.parse(doc.data, BufferJSON.reviver) : null;
  };
  const remove = (k) => col.deleteOne({ _id: id(k) });

  const creds = (await read('creds')) || initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(ids.map(async (keyId) => {
            let value = await read(`${type}-${keyId}`);
            if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
            data[keyId] = value;
          }));
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category of Object.keys(data)) {
            for (const keyId of Object.keys(data[category])) {
              const value = data[category][keyId];
              const k = `${category}-${keyId}`;
              tasks.push(value ? write(k, value) : remove(k));
            }
          }
          await Promise.all(tasks);
        }
      }
    },
    saveCreds: () => write('creds', creds)
  };
}

async function getAuthState(sid) {
  let col = null;
  try { col = await getMongoCol(); }
  catch (err) { console.error('MongoDB connection failed, using local files:', err?.message || err); }
  if (col) return useMongoAuthState(col, sid);
  return useMultiFileAuthState(sessionPath(sid));
}

async function deleteSessionData(sid) {
  try { fs.rmSync(sessionPath(sid), { recursive: true, force: true }); } catch {}
  try { const col = await getMongoCol(); if (col) await col.deleteMany({ sid }); } catch (err) { console.error('Mongo delete error:', err?.message || err); }
}

async function isMongoSessionRegistered(col, sid) {
  try {
    const doc = await col.findOne({ _id: `${sid}:creds` });
    return !!doc && JSON.parse(doc.data).registered === true;
  } catch { return false; }
}

/* ---------- WhatsApp session ---------- */
async function startSession(id, phone = '') {
  const current = sessions.get(id);
  if (current?.starting) return current;
  if (current?.sock && current.status === 'connected') return current;

  const record = current || { sock: null, state: null, qr: null, pairCode: null, status: 'starting', phone, starting: false, removed: false, retries: 0 };
  record.starting = true;
  record.status = 'starting';
  record.error = null;
  record.pairRequested = false;
  record.phone = phone || record.phone || '';
  sessions.set(id, record);

  try {
    const { state, saveCreds } = await getAuthState(id);
    record.state = state;

    const config = {
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      logger,
      browser: Browsers.ubuntu(BOT_NAME),
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false
    };
    try { config.version = (await fetchLatestBaileysVersion()).version; } catch { /* use library default */ }

    const sock = makeWASocket(config);
    record.sock = sock;

    // Unpaired sessions expire so abandoned attempts don't pile up and reconnect forever.
    if (!state.creds.registered && !record.expiryTimer) {
      record.expiryTimer = setTimeout(() => {
        const r = sessions.get(id);
        if (r && !r.state?.creds?.registered && r.status !== 'connected') {
          console.log(`Session ${id} expired before pairing; removing.`);
          destroySession(id);
        }
      }, PAIR_TIMEOUT_MS);
      record.expiryTimer.unref?.();
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      if (record.sock !== sock || record.removed) return;

      if (update.qr) {
        record.qr = update.qr;
        record.status = 'waiting_for_scan';
        // The socket is ready now: request the pair code (more reliable than a fixed delay).
        if (record.phone && !state.creds.registered && !record.pairRequested) {
          record.pairRequested = true;
          try {
            const code = await sock.requestPairingCode(record.phone);
            record.pairCode = code?.match(/.{1,4}/g)?.join('-') || code;
            record.status = 'waiting_for_pair';
          } catch (err) {
            record.status = 'pair_error';
            record.error = 'Could not generate pair code. Check the number and try again.';
            console.error('Pair code error:', err?.message || err);
          }
        }
      }

      if (update.connection === 'open') {
        record.status = 'connected';
        record.qr = null;
        record.pairCode = null;
        record.starting = false;
        record.retries = 0;
        clearTimeout(record.expiryTimer);
        record.expiryTimer = null;
        console.log(`Session ${id} connected.`);
      }

      if (update.connection === 'close') {
        const statusCode = update.lastDisconnect?.error?.output?.statusCode;
        record.starting = false;
        record.sock = null;

        if (statusCode === DisconnectReason.loggedOut) {
          record.status = 'logged_out';
          console.log(`Session ${id} logged out; deleting its files.`);
          deleteSessionData(id).catch(() => {});
          clearTimers(record);
          setTimeout(() => sessions.delete(id), 60 * 1000).unref?.();
          return;
        }
        if (statusCode === DisconnectReason.connectionReplaced) {
          record.status = 'replaced';
          record.error = 'Another device/session replaced this connection.';
          return;
        }
        record.status = 'disconnected';
        record.retries += 1;
        const delay = Math.min(30000, 2000 * record.retries);
        record.reconnectTimer = setTimeout(() => {
          if (!record.removed) startSession(id, record.phone).catch((e) => console.error('Reconnect error:', e?.message || e));
        }, delay);
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        try { await handleMessage(sock, msg, id); }
        catch (err) { console.error('Message handler error:', err?.message || err); }
      }
    });
  } catch (err) {
    // Without this, a failed start would leave `starting: true` forever.
    record.starting = false;
    record.status = 'error';
    record.error = 'Could not start the session.';
    console.error('Start session error:', err?.message || err);
    throw err;
  }
  return record;
}

// Re-open every previously paired session after a restart/redeploy.
async function restoreSessions() {
  let col = null;
  try { col = await getMongoCol(); } catch (err) { console.error('MongoDB unavailable during restore:', err?.message || err); }
  if (col) {
    const sids = (await col.distinct('sid')).filter(safeId);
    for (const sid of sids) {
      if (sessions.has(sid)) continue;
      if (!(await isMongoSessionRegistered(col, sid))) { await deleteSessionData(sid); continue; } // unfinished pairing
      try {
        await startSession(sid);
        console.log(`Restoring session ${sid} (MongoDB)`);
      } catch (err) { console.error(`Could not restore ${sid}:`, err?.message || err); }
      await sleep(1500);
    }
    return;
  }
  let entries = [];
  try { entries = fs.readdirSync(SESSION_ROOT, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !safeId(entry.name)) continue;
    const credsFile = path.join(sessionPath(entry.name), 'creds.json');
    let registered = false;
    try { registered = JSON.parse(fs.readFileSync(credsFile, 'utf8')).registered === true; } catch {}
    if (!registered) { // leftover from an unfinished pairing
      try { fs.rmSync(sessionPath(entry.name), { recursive: true, force: true }); } catch {}
      continue;
    }
    try {
      await startSession(entry.name);
      console.log(`Restoring session ${entry.name}`);
    } catch (err) { console.error(`Could not restore ${entry.name}:`, err?.message || err); }
    await sleep(1500); // stagger to avoid hammering WhatsApp
  }
}

/* ---------- message handling ---------- */
const MENU_IMAGE = (process.env.MENU_IMAGE || 'https://files.catbox.moe/jy9p51.jpg').trim();
const OWNER_NUMBER = (process.env.OWNER_NUMBER || '').replace(/\D/g, '');
const USE_BUTTONS = (process.env.BUTTONS || 'on').toLowerCase() !== 'off';
const TIMEZONE = process.env.TIMEZONE || 'Asia/Colombo';

function unwrapMessage(message) {
  let m = message || {};
  for (let i = 0; i < 6; i++) {
    const inner = m.ephemeralMessage?.message || m.viewOnceMessage?.message || m.viewOnceMessageV2?.message
      || m.viewOnceMessageV2Extension?.message || m.documentWithCaptionMessage?.message || m.editedMessage?.message;
    if (!inner) break;
    m = inner;
  }
  return m;
}

// Reads normal text AND every kind of button / list reply.
function getText(msg) {
  const m = unwrapMessage(msg.message);
  const nativeReply = m.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson;
  if (nativeReply) {
    try {
      const parsed = JSON.parse(nativeReply);
      if (parsed?.id) return String(parsed.id);
    } catch { /* fall through */ }
    return nativeReply;
  }
  return m.conversation
    || m.extendedTextMessage?.text
    || m.imageMessage?.caption
    || m.videoMessage?.caption
    || m.buttonsResponseMessage?.selectedButtonId
    || m.templateButtonReplyMessage?.selectedId
    || m.listResponseMessage?.singleSelectReply?.selectedRowId
    || '';
}

/* ---------- looks ---------- */
function formatUptime(totalSeconds) {
  const d = Math.floor(totalSeconds / 86400);
  const h = Math.floor((totalSeconds % 86400) / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  return `${d ? d + 'd ' : ''}${h}h ${m}m ${s}s`;
}
function greeting() {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: TIMEZONE }).format(new Date()));
  if (hour < 12) return 'Good Morning ☀️';
  if (hour < 17) return 'Good Afternoon 🌤️';
  if (hour < 21) return 'Good Evening 🌇';
  return 'Good Night 🌙';
}
function nowStrings() {
  const now = new Date();
  return {
    date: new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: TIMEZONE }).format(now),
    time: new Intl.DateTimeFormat('en-GB', { timeStyle: 'short', hour12: true, timeZone: TIMEZONE }).format(now)
  };
}
function mem() { return `${Math.round(process.memoryUsage().rss / 1048576)} MB`; }

function aliveCaption(name) {
  const { date, time } = nowStrings();
  return [
    `╭━━━〔 💠 *${BOT_NAME}* 💠 〕━━━⬣`,
    `┃ ${greeting()}, *${name}*!`,
    '┃',
    '┃ ✅ *I am alive and running!*',
    `┃ ⏱️ Uptime  : ${formatUptime(process.uptime())}`,
    `┃ 🧠 RAM     : ${mem()}`,
    `┃ 📅 Date    : ${date}`,
    `┃ 🕒 Time    : ${time}`,
    `┃ 🔰 Prefix  : ${PREFIX}`,
    '╰━━━━━━━━━━━━━━━━━━━━⬣',
    '',
    `👇 Tap a button, or send *${PREFIX}menu*`
  ].join('\n');
}

function menuCaption(name) {
  const p = PREFIX;
  const { date, time } = nowStrings();
  return [
    `╭━━━〔 💠 *${BOT_NAME}* 💠 〕━━━⬣`,
    `┃ 👋 Hi *${name}*, ${greeting()}`,
    `┃ 🔰 Prefix : ${p}`,
    `┃ ⏱️ Uptime : ${formatUptime(process.uptime())}`,
    `┃ 📅 ${date}  🕒 ${time}`,
    '╰━━━━━━━━━━━━━━━━━━━━⬣',
    '',
    '╭─❮ ⚙️ *GENERAL* ❯',
    `│ ✦ ${p}alive`,
    `│ ✦ ${p}ping`,
    `│ ✦ ${p}runtime`,
    `│ ✦ ${p}about`,
    `│ ✦ ${p}owner`,
    '╰──────────────⬣',
    '',
    '╭─❮ 📥 *DOWNLOAD* ❯',
    `│ ✦ ${p}tt <link>`,
    `│ ✦ ${p}fb <link>`,
    '╰──────────────⬣',
    '',
    '╭─❮ 🎨 *MEDIA* ❯',
    `│ ✦ ${p}sticker`,
    `│ ✦ ${p}media`,
    '╰──────────────⬣',
    '',
    '╭─❮ 👥 *GROUP* ❯',
    `│ ✦ ${p}groupinfo`,
    `│ ✦ ${p}grouphelp`,
    '╰──────────────⬣',
    '',
    '╭─❮ 👑 *OWNER* ❯',
    `│ ✦ ${p}status`,
    '╰──────────────⬣',
    '',
    `> ${BOT_NAME} • Powered by Rio Editz`
  ].join('\n');
}

/* ---------- button helpers ---------- */
const qr = (text, id) => ({ name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: text, id }) });
const urlBtn = (text, url) => ({ name: 'cta_url', buttonParamsJson: JSON.stringify({ display_text: text, url, merchant_url: url }) });
const listBtn = (title, sections) => ({ name: 'single_select', buttonParamsJson: JSON.stringify({ title, sections }) });

function menuButtons() {
  const p = PREFIX;
  const row = (title, description, id) => ({ header: '', title, description, id: `${p}${id}` });
  const buttons = [
    qr('🏓 Ping', `${p}ping`),
    qr('✅ Alive', `${p}alive`),
    listBtn('📂 Select Menu', [
      { title: '⚙️ GENERAL', rows: [
        row('Ping', 'Check bot speed', 'ping'),
        row('Runtime', 'How long the bot has been up', 'runtime'),
        row('About', 'About this bot', 'about'),
        row('Owner', 'Contact the owner', 'owner')
      ] },
      { title: '📥 DOWNLOAD', rows: [
        row('TikTok', 'Use .tt <link>', 'tt'),
        row('Facebook', 'Use .fb <link>', 'fb')
      ] },
      { title: '🎨 MEDIA', rows: [
        row('Sticker', 'Sticker help', 'sticker'),
        row('Media', 'Media command guide', 'media')
      ] },
      { title: '👥 GROUP', rows: [
        row('Group Info', 'Current group details', 'groupinfo'),
        row('Group Help', 'Group commands', 'grouphelp')
      ] },
      { title: '👑 OWNER', rows: [row('Status', 'Bot status', 'status')] }
    ])
  ];
  if (OWNER_NUMBER) buttons.push(urlBtn('👑 Chat Owner', `https://wa.me/${OWNER_NUMBER}`));
  return buttons;
}
function aliveButtons() {
  const p = PREFIX;
  const buttons = [qr('📜 Menu', `${p}menu`), qr('🏓 Ping', `${p}ping`)];
  if (OWNER_NUMBER) buttons.push(urlBtn('👑 Owner', `https://wa.me/${OWNER_NUMBER}`));
  return buttons;
}

// Native-flow interactive message (the type that shows real tappable buttons).
async function sendInteractive(sock, jid, { image, body, footer, buttons }, quoted) {
  const media = image ? await prepareWAMessageMedia({ image: { url: image } }, { upload: sock.waUploadToServer }) : null;
  const IM = proto.Message.InteractiveMessage;
  const interactiveMessage = IM.create({
    header: IM.Header.create({ title: '', subtitle: '', hasMediaAttachment: !!media, ...(media || {}) }),
    body: IM.Body.create({ text: body }),
    footer: IM.Footer.create({ text: footer }),
    nativeFlowMessage: IM.NativeFlowMessage.create({ buttons, messageParamsJson: '' })
  });
  const content = {
    viewOnceMessage: {
      message: {
        messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
        interactiveMessage
      }
    }
  };
  const waMsg = generateWAMessageFromContent(jid, content, { userJid: sock.user?.id, quoted });
  const additionalNodes = [{
    tag: 'biz', attrs: {},
    content: [{ tag: 'interactive', attrs: { type: 'native_flow', v: '1' }, content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }] }]
  }];
  if (!isJidGroup(jid)) additionalNodes.push({ tag: 'bot', attrs: { biz_bot: '1' } });
  await sock.relayMessage(jid, waMsg.message, { messageId: waMsg.key.id, additionalNodes });
}

// Tries buttons first; if anything fails it falls back to image+caption, then plain text.
async function sendRich(sock, jid, { caption, buttons, footer, image = MENU_IMAGE }, quoted) {
  if (USE_BUTTONS) {
    try {
      await sendInteractive(sock, jid, { image, body: caption, footer, buttons }, quoted);
      return;
    } catch (err) { console.error('Button send failed, using fallback:', err?.message || err); }
  }
  try {
    await sock.sendMessage(jid, { image: { url: image }, caption }, { quoted });
  } catch (err) {
    console.error('Image send failed, using text:', err?.message || err);
    await sock.sendMessage(jid, { text: caption }, { quoted });
  }
}

/* ---------- downloader (TikTok / Facebook) ---------- */
let YTDLP = process.env.YTDLP_PATH || (fs.existsSync(path.join(__dirname, 'bin', 'yt-dlp')) ? path.join(__dirname, 'bin', 'yt-dlp') : 'yt-dlp');
const MAX_DL_BYTES = Number(process.env.MAX_DL_MB || 50) * 1024 * 1024;
const TIKTOK_HOSTS = /(^|\.)tiktok\.com$/i;
const FB_HOSTS = /(^|\.)(facebook\.com|fb\.watch|fb\.com)$/i;
const pendingDl = new Map(); // token -> { info, platform, expires }

function parseUrl(raw, platform) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const ok = platform === 'tiktok' ? TIKTOK_HOSTS.test(u.hostname) : FB_HOSTS.test(u.hostname);
  return ok ? u.toString() : null;
}

async function runYtDlp(url) {
  await ytdlpReady;
  return new Promise((resolve, reject) => {
    execFile(YTDLP, ['-J', '--no-playlist', '--no-warnings', '-f', 'best[ext=mp4]/best', '--', url],
      { timeout: 60000, maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => {
        if (err) return reject(err);
        try {
          const j = JSON.parse(stdout);
          if (!j.url) return reject(new Error('yt-dlp returned no direct url'));
          resolve({ title: j.title || '', author: j.uploader || '', thumb: j.thumbnail || '', video: j.url, audio: null, headers: j.http_headers || {} });
        } catch (e) { reject(e); }
      });
  });
}

async function tikwm(url, attempt = 0) {
  const res = await fetch('https://www.tikwm.com/api/', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' },
    body: new URLSearchParams({ url, hd: '1' }),
    signal: AbortSignal.timeout(30000)
  });
  const text = await res.text();
  let j;
  try { j = JSON.parse(text); }
  catch {
    if (attempt < 1) { await sleep(1500); return tikwm(url, attempt + 1); } // free API allows ~1 request/second
    throw new Error(`tikwm gave an empty/invalid reply (HTTP ${res.status})`);
  }
  if (j.code !== 0 || !j.data) throw new Error(j.msg || 'tikwm failed');
  const abs = (v) => (v ? (v.startsWith('/') ? `https://www.tikwm.com${v}` : v) : null);
  const d = j.data;
  return { title: d.title || '', author: d.author?.nickname || '', thumb: abs(d.cover), video: abs(d.hdplay || d.play), audio: abs(d.music), headers: {} };
}

const ytdlpWorks = (bin) => new Promise((r) => execFile(bin, ['--version'], { timeout: 20000 }, (e) => r(!e)));
// Downloads the standalone yt-dlp binary (no Python needed) if it is not installed yet.
async function ensureYtDlp() {
  if (await ytdlpWorks(YTDLP)) return true;
  if (process.platform !== 'linux') { console.error('yt-dlp is not installed. Install it or set YTDLP_PATH.'); return false; }
  const asset = process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux';
  const target = path.join(__dirname, 'bin', 'yt-dlp');
  try {
    console.log('yt-dlp not found, downloading...');
    const res = await fetch(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`, { signal: AbortSignal.timeout(180000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(await res.arrayBuffer()), { mode: 0o755 });
    YTDLP = target;
    const ok = await ytdlpWorks(YTDLP);
    console.log(ok ? 'yt-dlp installed.' : 'yt-dlp downloaded but does not run.');
    return ok;
  } catch (err) {
    console.error('Could not install yt-dlp:', err?.message || err);
    return false;
  }
}
const ytdlpReady = ensureYtDlp();

async function resolveMedia(platform, url) {
  if (platform === 'tiktok') {
    try { return await tikwm(url); }
    catch (err) { console.error('tikwm failed, trying yt-dlp:', err?.message || err); }
  }
  return runYtDlp(url);
}

async function fetchBuffer(url, headers = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len && len > MAX_DL_BYTES) throw new Error('TOO_BIG');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_DL_BYTES) throw new Error('TOO_BIG');
  return buf;
}

async function startDownload(sock, jid, msg, platform, rawUrl) {
  const reply = (t) => sock.sendMessage(jid, { text: t }, { quoted: msg });
  const label = platform === 'tiktok' ? 'TikTok' : 'Facebook';
  const cmd = platform === 'tiktok' ? 'tt' : 'fb';
  const url = parseUrl(rawUrl, platform);
  if (!url) return reply(`❌ Send a valid ${label} link.\nExample: ${PREFIX}${cmd} <${label} link>`);
  await reply(`⏳ Fetching ${label} video...`);
  let info;
  try { info = await resolveMedia(platform, url); }
  catch (err) {
    console.error(`${label} resolve error:`, err?.stderr || err?.message || err);
    return reply(`❌ Could not fetch that ${label} video. It may be private, removed, or the downloader is unavailable.`);
  }
  const token = crypto.randomBytes(4).toString('hex');
  pendingDl.set(token, { info, platform, expires: Date.now() + 10 * 60 * 1000 });
  const p = PREFIX;
  const caption = [
    `╭━━━〔 📥 *${label.toUpperCase()} DOWNLOADER* 〕━━━⬣`,
    `┃ 🎬 ${(info.title || 'No title').slice(0, 120)}`,
    info.author ? `┃ 👤 ${info.author}` : null,
    '╰━━━━━━━━━━━━━━━━━━━━⬣',
    '',
    '👇 Select the file format'
  ].filter((l) => l !== null).join('\n');
  const buttons = [
    qr('🎬 Video', `${p}dl video ${token}`),
    qr('🎵 Audio', `${p}dl audio ${token}`),
    qr('📄 Document', `${p}dl doc ${token}`)
  ];
  return sendRich(sock, jid, { caption, buttons, footer: `${BOT_NAME} • Link valid for 10 min`, image: info.thumb || MENU_IMAGE }, msg);
}

async function sendDownload(sock, jid, msg, kind, token) {
  const reply = (t) => sock.sendMessage(jid, { text: t }, { quoted: msg });
  const entry = pendingDl.get(String(token || ''));
  if (!entry || entry.expires < Date.now()) return reply(`⌛ This download request expired. Send the link again with ${PREFIX}tt or ${PREFIX}fb.`);
  const { info } = entry;
  const safeName = `${BOT_NAME.replace(/\W+/g, '-')}-${String(token)}`;
  try {
    await reply(kind === 'audio' ? '⏳ Preparing audio...' : '⏳ Downloading...');
    if (kind === 'audio') {
      const src = info.audio || info.video;
      const buf = await fetchBuffer(src, info.audio ? {} : info.headers);
      return sock.sendMessage(jid, { audio: buf, mimetype: info.audio ? 'audio/mpeg' : 'audio/mp4', ptt: false }, { quoted: msg });
    }
    const buf = await fetchBuffer(info.video, info.headers);
    if (kind === 'doc') {
      return sock.sendMessage(jid, { document: buf, mimetype: 'video/mp4', fileName: `${safeName}.mp4`, caption: `📄 ${BOT_NAME}` }, { quoted: msg });
    }
    return sock.sendMessage(jid, { video: buf, mimetype: 'video/mp4', caption: `🎬 ${(info.title || '').slice(0, 200)}\n\n> ${BOT_NAME}` }, { quoted: msg });
  } catch (err) {
    console.error('Send download error:', err?.message || err);
    if (err?.message === 'TOO_BIG') return reply(`❌ File is larger than ${Math.round(MAX_DL_BYTES / 1048576)} MB, so I can't send it.`);
    return reply('❌ Download failed. Please try again.');
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingDl) if (v.expires < now) pendingDl.delete(k);
}, 60 * 1000).unref();

/* ---------- command handler ---------- */
async function handleMessage(sock, msg, sessionId) {
  if (!msg.message) return;
  const jid = msg.key.remoteJid;
  if (!jid || jid === 'status@broadcast' || jid.endsWith('@newsletter')) return;

  const ts = Number(msg.messageTimestamp || 0);
  if (ts && Date.now() / 1000 - ts > MAX_MSG_AGE_S) return;

  const text = getText(msg).trim();
  if (!text) return;

  const name = msg.pushName || 'User';
  const footer = `${BOT_NAME} • Tap a button`;
  let commandText = text;
  if (!commandText.startsWith(PREFIX)) {
    if (!msg.key.fromMe && /^(menu|help|alive)$/i.test(commandText)) commandText = PREFIX + commandText.toLowerCase();
    else return;
  }

  const [rawCommand, ...args] = commandText.slice(PREFIX.length).trim().split(/\s+/);
  const command = (rawCommand || '').toLowerCase();
  if (!command) return;

  const now = Date.now();
  const key = `${sessionId}:${jid}:${command}:${args[0] || ''}`;
  if (cooldowns.has(key) && now - cooldowns.get(key) < 700) return;
  cooldowns.set(key, now);

  const reply = (t) => sock.sendMessage(jid, { text: t }, { quoted: msg });

  switch (command) {
    case 'menu':
    case 'help':
    case 'list':
      return sendRich(sock, jid, { caption: menuCaption(name), buttons: menuButtons(), footer }, msg);
    case 'alive':
    case 'bot':
      return sendRich(sock, jid, { caption: aliveCaption(name), buttons: aliveButtons(), footer }, msg);
    case 'tt':
    case 'tiktok':
      return startDownload(sock, jid, msg, 'tiktok', args[0]);
    case 'fb':
    case 'facebook':
      return startDownload(sock, jid, msg, 'facebook', args[0]);
    case 'dlcheck': {
      const lines = ['🔍 *Downloader check*'];
      await ytdlpReady;
      try {
        const v = await new Promise((resolve, reject) => execFile(YTDLP, ['--version'], { timeout: 15000 }, (e, out) => (e ? reject(e) : resolve(String(out).trim()))));
        lines.push(`✅ yt-dlp: ${v}`);
      } catch (e) { lines.push(`❌ yt-dlp not available (${e?.code || e?.message}). Check the logs for 'Could not install yt-dlp'.`); }
      try {
        const info = await tikwm('https://www.tiktok.com/@scout2015/video/6718335390845095173');
        lines.push(info.video ? '✅ TikTok API (tikwm): working' : '⚠️ TikTok API replied without a video');
      } catch (e) { lines.push(`❌ TikTok API (tikwm): ${e?.message || e}`); }
      lines.push(`🧠 RAM: ${mem()}`, `📦 Max file: ${Math.round(MAX_DL_BYTES / 1048576)} MB`);
      return reply(lines.join('\n'));
    }
    case 'dl':
      return sendDownload(sock, jid, msg, args[0], args[1]);
    case 'ping': {
      const started = Date.now();
      const sent = await reply('🏓 Pinging...');
      const ms = Date.now() - started;
      return sock.sendMessage(jid, { text: `🏓 *Pong!* ${ms} ms`, edit: sent.key });
    }
    case 'runtime':
      return reply(`⏱️ *Runtime:* ${formatUptime(process.uptime())}`);
    case 'about':
      return reply(`🤖 *${BOT_NAME}*\nA multi-session WhatsApp MD bot.\nSend ${PREFIX}menu to see all commands.`);
    case 'owner':
      return reply(OWNER_NUMBER ? `👑 Owner: https://wa.me/${OWNER_NUMBER}` : '👑 Owner contact is not set. Add OWNER_NUMBER in the environment variables.');
    case 'media':
    case 'sticker':
      return reply(`🎨 *MEDIA MENU*\n${PREFIX}sticker — sticker help\n${PREFIX}media — media command guide\n\nMedia conversion plugins can be added later.`);
    case 'grouphelp':
      return reply(`👥 *GROUP MENU*\n${PREFIX}groupinfo — current group details\n\nAdmin moderation commands are not enabled yet.`);
    case 'groupinfo': {
      if (!jid.endsWith('@g.us')) return reply('This command only works in groups.');
      const meta = await sock.groupMetadata(jid);
      return reply(`👥 *${meta.subject}*\nMembers: ${meta.participants.length}\nGroup ID: ${jid}`);
    }
    case 'status':
      return reply(`✅ *${BOT_NAME}*\nStatus: connected\nUptime: ${formatUptime(process.uptime())}\nRAM: ${mem()}`);
    default:
      return reply(`❔ Unknown command: ${PREFIX}${command}\nSend ${PREFIX}menu to view commands.`);
  }
}

setInterval(() => { // keep the cooldown map from growing forever
  const cutoff = Date.now() - 60 * 1000;
  for (const [k, t] of cooldowns) if (t < cutoff) cooldowns.delete(k);
}, 60 * 1000).unref();

/* ---------- HTTP API ---------- */
app.post('/api/session', createLimiter, authRequired, async (req, res) => {
  const phone = String(req.body?.phone || '').replace(/\D/g, '');
  if (phone.length < 8 || phone.length > 15) {
    return res.status(400).json({ error: 'Enter a valid international phone number with country code, digits only.' });
  }
  if (sessions.size >= MAX_SESSIONS) {
    return res.status(429).json({ error: 'Session limit reached on this server.' });
  }
  const id = crypto.randomBytes(12).toString('hex');
  try {
    await startSession(id, phone);
    res.json({ id, status: 'starting', message: 'Keep this page open and check status in a few seconds.' });
  } catch (err) {
    destroySession(id);
    res.status(500).json({ error: 'Could not start a session.' });
  }
});

app.get('/api/session/:id', apiLimiter, authRequired, async (req, res) => {
  const { id } = req.params;
  if (!safeId(id)) return res.status(400).json({ error: 'Invalid session id.' });
  const record = sessions.get(id);
  if (!record) return res.status(404).json({ error: 'Session expired or not found. Generate a new code.' });
  let qrDataUrl = null;
  if (record.qr) {
    try { qrDataUrl = await QRCode.toDataURL(record.qr, { margin: 1, width: 260 }); } catch {}
  }
  res.json({ id, status: record.status, phone: record.phone, pairCode: record.pairCode, qrDataUrl, error: record.error || null });
});

app.get('/health', (_req, res) => res.json({ ok: true, bot: BOT_NAME, activeSessions: sessions.size, storage: mongoCol ? 'mongodb' : 'files' }));

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`${BOT_NAME} pairing site listening on port ${PORT}`);
  if (!keyIsConfigured()) console.warn('WARNING: PAIRING_API_KEY is missing/too short/placeholder — pairing is disabled until you set a real one.');
  console.log(`Session directory: ${SESSION_ROOT}`);
  restoreSessions().catch((e) => console.error('Restore error:', e?.message || e));
});

/* ---------- process safety ---------- */
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err?.message || err));
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err?.message || err));
function shutdown() {
  console.log('Shutting down…');
  for (const record of sessions.values()) { clearTimers(record); try { record.sock?.end(undefined); } catch {} }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
