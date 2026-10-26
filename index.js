import 'dotenv/config';
import express from 'express';
import makeWASocket, {
  useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion,
  proto, generateWAMessageFromContent, prepareWAMessageMedia, isJidGroup,
  BufferJSON, initAuthCreds, makeCacheableSignalKeyStore, downloadMediaMessage, jidNormalizedUser
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
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

let shuttingDown = false; // set on SIGTERM so the old instance never reconnects and steals the session from the new one
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
const createLimiter = makeLimiter(10, 10 * 60 * 1000);

// Pairing is public by default so anyone can link their own number. Set PAIRING_REQUIRE_KEY=true to lock it behind PAIRING_API_KEY.
const REQUIRE_KEY = String(process.env.PAIRING_REQUIRE_KEY || '').toLowerCase() === 'true';
function authRequired(req, res, next) {
  if (!REQUIRE_KEY) return next();
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
let mongoDb = null;

let mongoPending = null;
async function getMongoCol() {
  if (!MONGO_URL) return null;
  if (mongoCol) return mongoCol;
  if (!mongoPending) {
    mongoPending = (async () => {
      let lastErr;
      for (let i = 0; i < 3; i++) {
        try {
          const client = new MongoClient(MONGO_URL, { serverSelectionTimeoutMS: 15000 });
          await client.connect();
          mongoDb = client.db(MONGO_DB);
          const col = mongoDb.collection('auth');
          await col.createIndex({ sid: 1 });
          mongoCol = col;
          console.log('Auth storage: MongoDB (sessions survive redeploys).');
          return col;
        } catch (err) { lastErr = err; console.error(`MongoDB connect attempt ${i + 1} failed:`, err?.message || err); await sleep(3000); }
      }
      throw lastErr;
    })().finally(() => { mongoPending = null; });
  }
  return mongoPending;
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
  const col = await getMongoCol(); // throws when MONGO_URL is set but unreachable: never silently fall back to files
  if (col) return useMongoAuthState(col, sid);
  return useMultiFileAuthState(sessionPath(sid));
}

async function deleteSessionData(sid) {
  try { fs.rmSync(sessionPath(sid), { recursive: true, force: true }); } catch {}
  for (const kind of ['audio', 'video']) { try { fs.rmSync(path.join(SESSION_ROOT, '_callmedia', `${sid}.${kind}`), { force: true }); } catch {} }
  delete settings[sid];
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings)); } catch {}
  try {
    const col = await getMongoCol();
    if (col) {
      await col.deleteMany({ sid });
      await mongoDb.collection('settings').deleteOne({ _id: sid });
      await mongoDb.collection('callmedia').deleteMany({ sid });
    }
  } catch (err) { console.error('Mongo delete error:', err?.message || err); }
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
      browser: Browsers.ubuntu(process.env.BROWSER_NAME || 'Chrome'), // pair codes only work with a known browser name
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
        record.phone = String(sock.user?.id || '').split(':')[0].split('@')[0] || record.phone;
        record.qr = null;
        record.pairCode = null;
        record.starting = false;
        record.retries = 0;
        record.replacedCount = 0;
        clearTimeout(record.expiryTimer);
        record.expiryTimer = null;
        console.log(`Session ${id} connected.`);
        if (callbotAvailable && getSetting(id, 'callStream', false)) syncCallbot(id, sock).catch(() => {});
      }

      if (update.connection === 'close') {
        if (shuttingDown) return;
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
          record.replacedCount = (record.replacedCount || 0) + 1;
          // During a redeploy the old instance briefly holds the session; retry shortly instead of staying offline.
          if (record.replacedCount <= 5) {
            record.reconnectTimer = setTimeout(() => {
              if (!record.removed && !shuttingDown) startSession(id, record.phone).catch((e) => console.error('Reconnect error:', e?.message || e));
            }, 20000);
          }
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

    sock.ev.on('call', async (calls) => {
      for (const c of calls) {
        try { await handleCall(sock, c, id); }
        catch (err) { console.error('Call handler error:', err?.message || err); }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        if (msg.key?.remoteJid === 'status@broadcast') { // statuses: auto view / react / save
          handleStatus(sock, msg, id).catch((err) => console.error('Status handler error:', err?.message || err));
          continue;
        }
        handleViewOnce(sock, msg, id).catch((err) => console.error('View-once handler error:', err?.message || err));
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
async function restoreSessions(attempt = 0) {
  let col = null;
  try { col = await getMongoCol(); }
  catch (err) {
    console.error('MongoDB unavailable during restore:', err?.message || err);
    if (MONGO_URL && attempt < 10) setTimeout(() => restoreSessions(attempt + 1).catch(() => {}), 20000).unref?.();
    return;
  }
  if (col) {
    await loadMongoSettings();
    const sids = (await col.distinct('sid')).filter(safeId);
    console.log(`Found ${sids.length} saved session(s) in MongoDB.`);
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

const DEFAULT_MODE = (process.env.MODE || 'public').toLowerCase() === 'private' ? 'private' : 'public';
const CARD_URL = (process.env.CARD_URL || '').trim();
const jidNum = (j) => String(j || '').split('@')[0].split(':')[0];

/* ---------- per-session settings (public/private mode) ---------- */
const SETTINGS_FILE = path.join(SESSION_ROOT, '_settings.json');
let settings = {};
try { settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) || {}; } catch { settings = {}; }
const getSetting = (sid, key, def) => settings[sid]?.[key] ?? def;
function setSetting(sid, key, value) {
  settings[sid] = { ...(settings[sid] || {}), [key]: value };
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings)); } catch (err) { console.error('Could not save settings:', err?.message || err); }
  if (MONGO_URL) { // also keep a copy in MongoDB so it survives redeploys
    getMongoCol().then(() => mongoDb?.collection('settings').updateOne({ _id: sid }, { $set: { data: settings[sid] } }, { upsert: true }))
      .catch((err) => console.error('Mongo settings save error:', err?.message || err));
  }
}
const getMode = (sid) => getSetting(sid, 'mode', DEFAULT_MODE);
const setMode = (sid, mode) => setSetting(sid, 'mode', mode);
async function loadMongoSettings() {
  try {
    if (!mongoDb) return;
    for await (const d of mongoDb.collection('settings').find({})) settings[d._id] = { ...(settings[d._id] || {}), ...(d.data || {}) };
  } catch (err) { console.error('Mongo settings load error:', err?.message || err); }
}

/* ---------- call handling: reject calls, or reject + auto-reply with a saved audio / video ---------- */
// NOTE: WhatsApp has no public protocol for answering a call and streaming media into it, so "auto answer"
// rejects the ringing call and immediately sends the saved voice note / video to the caller instead.
const CALL_DIR = path.join(SESSION_ROOT, '_callmedia');
const MAX_CALL_MEDIA = 15 * 1024 * 1024;
const DEFAULT_CALL_MSG = '📵 Sorry, I can\'t take calls right now. Please send a message.';
const seenCalls = new Map(); // call id -> time, so one call is never handled twice

async function saveCallMedia(sid, kind, buf, meta) {
  fs.mkdirSync(CALL_DIR, { recursive: true });
  fs.writeFileSync(path.join(CALL_DIR, `${sid}.${kind}`), buf);
  setSetting(sid, `call_${kind}`, meta);
  if (MONGO_URL) {
    try { await getMongoCol(); await mongoDb.collection('callmedia').updateOne({ _id: `${sid}:${kind}` }, { $set: { sid, kind, data: buf } }, { upsert: true }); }
    catch (err) { console.error('Mongo call media save error:', err?.message || err); }
  }
}
async function loadCallMedia(sid, kind) {
  const meta = getSetting(sid, `call_${kind}`, null);
  if (!meta) return null;
  const file = path.join(CALL_DIR, `${sid}.${kind}`);
  try { return { ...meta, buf: fs.readFileSync(file) }; } catch { /* file lost (redeploy): try MongoDB */ }
  if (MONGO_URL) {
    try {
      await getMongoCol();
      const doc = await mongoDb.collection('callmedia').findOne({ _id: `${sid}:${kind}` });
      if (doc?.data) {
        const buf = Buffer.from(doc.data.buffer.subarray(0, doc.data.position ?? doc.data.buffer.length));
        try { fs.mkdirSync(CALL_DIR, { recursive: true }); fs.writeFileSync(file, buf); } catch {}
        return { ...meta, buf };
      }
    } catch (err) { console.error('Mongo call media load error:', err?.message || err); }
  }
  return null;
}
async function deleteCallMedia(sid, kind) {
  try { fs.rmSync(path.join(CALL_DIR, `${sid}.${kind}`), { force: true }); } catch {}
  setSetting(sid, `call_${kind}`, null);
  if (MONGO_URL) { try { await getMongoCol(); await mongoDb.collection('callmedia').deleteOne({ _id: `${sid}:${kind}` }); } catch {} }
}
async function sendCallMedia(sock, jid, media, quoted) {
  if (media.kind === 'video') return sock.sendMessage(jid, { video: media.buf, mimetype: media.mimetype || 'video/mp4', caption: media.caption || '' }, { quoted });
  return sock.sendMessage(jid, { audio: media.buf, mimetype: media.mimetype || 'audio/ogg; codecs=opus', ptt: media.ptt !== false }, { quoted });
}

/* ---------- real call answering: Go sidecar "callbot" (whatsmeow + meowcaller) ---------- */
// The sidecar links itself as a second device on the same number, answers the call and streams the saved audio / video into it.
const CALLBOT_BIN = process.env.CALLBOT_BIN || path.join(__dirname, 'bin', 'callbot');
const CALLBOT_PORT = Number(process.env.CALLBOT_PORT || 8099);
const CALLBOT_SECRET = crypto.randomBytes(24).toString('hex'); // new on every start, only this process and the sidecar know it
const CALLBOT_DIR = process.env.CALLBOT_DIR || path.join(SESSION_ROOT, '_callbot');
let callbotAvailable = false;
let callbotProc = null;
let callbotRestarts = 0;

function startCallbot() {
  if (!fs.existsSync(CALLBOT_BIN)) {
    console.log('Real call streaming: callbot binary not found, feature disabled (deploy with the Dockerfile to enable it).');
    return;
  }
  callbotAvailable = true;
  const startedAt = Date.now();
  const child = spawn(CALLBOT_BIN, [], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME || os.tmpdir(), TZ: TIMEZONE, CALLBOT_SECRET, CALLBOT_PORT: String(CALLBOT_PORT), CALLBOT_DIR },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  callbotProc = child;
  const relay = (stream) => stream.on('data', (d) => String(d).split('\n').filter(Boolean).forEach((l) => console.log(`[callbot] ${l}`)));
  relay(child.stdout); relay(child.stderr);
  child.on('error', (err) => console.error('callbot failed to start:', err?.message || err));
  child.on('exit', (code, signal) => {
    callbotProc = null;
    if (shuttingDown) return;
    callbotRestarts = Date.now() - startedAt > 60000 ? 0 : callbotRestarts + 1;
    console.error(`callbot exited (${signal || code}); restarting...`);
    setTimeout(startCallbot, Math.min(30000, 2000 * (callbotRestarts + 1))).unref?.();
  });
}

async function callbotApi(method, apiPath, { json, body, timeout = 15000 } = {}) {
  if (!callbotAvailable) throw new Error('The call service is not installed on this server.');
  const res = await fetch(`http://127.0.0.1:${CALLBOT_PORT}${apiPath}`, {
    method,
    headers: { Authorization: `Bearer ${CALLBOT_SECRET}`, ...(json ? { 'content-type': 'application/json' } : {}) },
    body: json ? JSON.stringify(json) : body,
    signal: AbortSignal.timeout(timeout)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `call service error (HTTP ${res.status})`);
  return data;
}

// Pushes the on/off state, owner skip list and saved clips of one session to the sidecar.
async function syncCallbot(sid, sock) {
  if (!callbotAvailable) return;
  try {
    const skip = [OWNER_NUMBER, jidNum(sock?.user?.id)].filter(Boolean);
    await callbotApi('POST', `/sessions/${sid}/config`, { json: { enabled: !!getSetting(sid, 'callStream', false), loop: !!getSetting(sid, 'callLoop', false), hangup: true, skip } });
    const st = await callbotApi('GET', `/sessions/${sid}`);
    for (const kind of ['audio', 'video']) {
      const has = kind === 'audio' ? st.hasAudio : st.hasVideo;
      const media = await loadCallMedia(sid, kind);
      if (media && !has) await callbotApi('PUT', `/sessions/${sid}/media/${kind}`, { body: media.buf, timeout: 180000 });
      if (!media && has) await callbotApi('DELETE', `/sessions/${sid}/media/${kind}`);
    }
  } catch (err) { console.error('callbot sync error:', err?.message || err); }
}

// After the pair code was shown: wait (up to ~5 min) until the user has linked it, then confirm in the chat.
function watchCallbotLink(sid, sock, jid) {
  let tries = 0;
  const timer = setInterval(async () => {
    tries += 1;
    try {
      const st = await callbotApi('GET', `/sessions/${sid}`, { timeout: 5000 });
      if (st.linked && st.connected) {
        clearInterval(timer);
        await syncCallbot(sid, sock);
        await say(sock, jid, '✅ *Call service linked!* Real call answering is ON.\nCalls now get answered and your saved audio / video is played. Check with ' + PREFIX + 'call');
      } else if (!st.exists || tries >= 64) clearInterval(timer);
    } catch { if (tries >= 64) clearInterval(timer); }
  }, 5000);
  timer.unref?.();
}

async function handleCall(sock, call, sid) {
  if (!call || call.status !== 'offer' || call.isGroup) return;
  if (callbotAvailable && getSetting(sid, 'callStream', false)) { // the sidecar answers this call
    try {
      const st = await callbotApi('GET', `/sessions/${sid}`, { timeout: 1500 });
      if (st.linked && st.connected && st.enabled) return;
    } catch { /* sidecar not reachable: fall back to reject / message below */ }
  }
  const rejectOn = getSetting(sid, 'callReject', false);
  const answerOn = getSetting(sid, 'autoAnswer', false);
  if (!rejectOn && !answerOn) return;
  if (seenCalls.has(call.id)) return;
  seenCalls.set(call.id, Date.now());
  for (const [k, t] of seenCalls) if (Date.now() - t > 10 * 60 * 1000) seenCalls.delete(k);

  const callerNum = jidNum(call.from);
  if (callerNum === jidNum(sock.user?.id) || (OWNER_NUMBER && callerNum === OWNER_NUMBER)) return; // never block the owner

  try { await sock.rejectCall(call.id, call.from); }
  catch (err) { console.error('Reject call error:', err?.message || err); }

  const to = call.chatId && !String(call.chatId).endsWith('@g.us') ? call.chatId : call.from;
  if (answerOn) {
    // video call -> prefer the saved video, voice call -> prefer the saved audio; fall back to the other one
    const order = call.isVideo ? ['video', 'audio'] : ['audio', 'video'];
    for (const kind of order) {
      const media = await loadCallMedia(sid, kind);
      if (!media) continue;
      try { await sendCallMedia(sock, to, { ...media, kind }); return; }
      catch (err) { console.error('Call auto-reply media error:', err?.message || err); }
    }
  }
  if (rejectOn) { try { await say(sock, to, getSetting(sid, 'callMsg', DEFAULT_CALL_MSG)); } catch {} }
}
const parseToggle = (v) => (/^(on|enable|enabled|true|yes|1)$/i.test(v || '') ? true : /^(off|disable|disabled|false|no|0)$/i.test(v || '') ? false : null);

/* ---------- status tools (auto view / react / save) and view-once recovery ---------- */
const DEFAULT_STATUS_EMOJIS = ['❤️', '🔥', '😍', '👏', '💯', '🥰'];
const STATUS_TOGGLES = {
  statusseen: ['statusSeen', 'Auto status view'], autoseen: ['statusSeen', 'Auto status view'],
  statusreact: ['statusReact', 'Auto status react'], autoreact: ['statusReact', 'Auto status react'],
  statussave: ['statusSave', 'Auto status save'], autosave: ['statusSave', 'Auto status save'],
  viewonce: ['viewOnce', 'View-once recovery'], antiviewonce: ['viewOnce', 'View-once recovery']
};
const MAX_SAVE_BYTES = 64 * 1024 * 1024;
const handledIds = new Map(); // message id -> time, so one message is never processed twice
function firstTime(id) {
  const now = Date.now();
  if (handledIds.has(id)) return false;
  handledIds.set(id, now);
  if (handledIds.size > 2000) for (const [k, t] of handledIds) if (now - t > 30 * 60 * 1000) handledIds.delete(k);
  return true;
}
function extractEmojis(text) {
  const found = String(text || '').match(/(?:\p{Regional_Indicator}{2})|(?:[#*0-9]️?⃣)|(?:\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})?(?:‍\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})?)*)/gu);
  return [...new Set(found || [])].slice(0, 20);
}

// Finds image / video / audio inside any wrapper (ephemeral, view-once ...). `viewOnce` tells if it was a view-once message.
function findMedia(message) {
  let m = message || {}, viewOnce = false;
  for (let i = 0; i < 6; i++) {
    const vo = m.viewOnceMessage?.message || m.viewOnceMessageV2?.message || m.viewOnceMessageV2Extension?.message;
    const inner = vo || m.ephemeralMessage?.message || m.documentWithCaptionMessage?.message || m.editedMessage?.message;
    if (!inner) break;
    if (vo) viewOnce = true;
    m = inner;
  }
  for (const kind of ['image', 'video', 'audio']) {
    const part = m[`${kind}Message`];
    if (part) return { kind, part, viewOnce: viewOnce || !!part.viewOnce };
  }
  return { kind: null, part: null, viewOnce, text: m.conversation || m.extendedTextMessage?.text || '' };
}

async function downloadPart(sock, target, part) {
  if (Number(part?.fileLength || 0) > MAX_SAVE_BYTES) throw new Error('TOO_BIG');
  const buf = await downloadMediaMessage(target, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
  if (buf.length > MAX_SAVE_BYTES) throw new Error('TOO_BIG');
  return buf;
}
async function sendMedia(sock, to, kind, part, buf, caption) {
  if (kind === 'image') return sock.sendMessage(to, { image: buf, caption });
  if (kind === 'video') return sock.sendMessage(to, { video: buf, mimetype: part.mimetype || 'video/mp4', caption });
  await sock.sendMessage(to, { audio: buf, mimetype: part.mimetype || 'audio/ogg; codecs=opus', ptt: !!part.ptt });
  if (caption) await sock.sendMessage(to, { text: caption });
}

async function handleStatus(sock, msg, sid) {
  if (!msg.message || msg.key.fromMe) return;
  const seen = getSetting(sid, 'statusSeen', false), react = getSetting(sid, 'statusReact', false), save = getSetting(sid, 'statusSave', false);
  if (!seen && !react && !save) return;
  const poster = msg.key.participant;
  const raw = msg.message;
  if (!poster || raw.protocolMessage || raw.reactionMessage || raw.senderKeyDistributionMessage && Object.keys(raw).length === 1) return;
  if (!firstTime(`st:${msg.key.id}`)) return;
  const ts = Number(msg.messageTimestamp || 0);
  const age = ts ? Date.now() / 1000 - ts : 0;
  if (age > 24 * 3600) return;
  const me = jidNormalizedUser(sock.user?.id);

  if (seen || react) {
    try { await sock.readMessages([msg.key]); }
    catch (err) { console.error('Status view error:', err?.message || err); }
  }
  if (react && age < 30 * 60) { // only fresh statuses, a random pause keeps it human-like
    const list = getSetting(sid, 'statusEmojis', null);
    const pool = Array.isArray(list) && list.length ? list : DEFAULT_STATUS_EMOJIS;
    await sleep(1500 + Math.random() * 3500);
    try { await sock.sendMessage('status@broadcast', { react: { text: pool[Math.floor(Math.random() * pool.length)], key: msg.key } }, { statusJidList: [poster, me] }); }
    catch (err) { console.error('Status react error:', err?.message || err); }
  }
  if (save && age < 6 * 3600) {
    const head = `📥 *Status* from @${jidNum(poster)}${msg.pushName ? ` (${msg.pushName})` : ''}`;
    const found = findMedia(raw);
    try {
      if (found.kind) {
        const buf = await downloadPart(sock, msg, found.part);
        await sendMedia(sock, me, found.kind, found.part, buf, `${head}${found.part.caption ? `\n\n${found.part.caption}` : ''}`);
      } else if (found.text) {
        await sock.sendMessage(me, { text: `${head}\n\n${found.text}`, mentions: [poster] });
      }
    } catch (err) { console.error('Status save error:', err?.message || err); }
  }
}

// Sends a copy of every incoming view-once photo / video / voice note to the owner's own chat.
async function handleViewOnce(sock, msg, sid) {
  if (!msg.message || msg.key.fromMe || !getSetting(sid, 'viewOnce', false)) return;
  const found = findMedia(msg.message);
  if (!found.kind || !found.viewOnce) return;
  if (!firstTime(`vo:${msg.key.id}`)) return;
  const from = msg.key.participant || msg.key.remoteJid;
  const where = isJidGroup(msg.key.remoteJid) ? 'a group' : 'private chat';
  const caption = `👁️ *View-once recovered*\n👤 @${jidNum(from)}${msg.pushName ? ` (${msg.pushName})` : ''}\n💬 ${where}${found.part.caption ? `\n\n${found.part.caption}` : ''}`;
  try {
    const buf = await downloadPart(sock, msg, found.part);
    await sendMedia(sock, jidNormalizedUser(sock.user?.id), found.kind, found.part, buf, caption);
  } catch (err) { console.error('View-once recovery error:', err?.message || err); }
}

/* ---------- bot DP card (the "web og image" style preview on every reply) ---------- */
const dpCache = new WeakMap(); // sock -> { buf, at }
async function getBotDp(sock) {
  const c = dpCache.get(sock);
  if (c && Date.now() - c.at < 30 * 60 * 1000) return c.buf;
  let buf = null;
  try {
    const url = await sock.profilePictureUrl(sock.user.id, 'image');
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (res.ok) buf = Buffer.from(await res.arrayBuffer());
  } catch { /* no profile picture or privacy hides it */ }
  if (!buf) {
    try {
      const res = await fetch(MENU_IMAGE, { signal: AbortSignal.timeout(15000) });
      if (res.ok) buf = Buffer.from(await res.arrayBuffer());
    } catch { /* ignore */ }
  }
  dpCache.set(sock, { buf, at: Date.now() });
  return buf;
}
function resetBotDp(sock) { dpCache.delete(sock); }

async function cardContext(sock) {
  const thumbnail = await getBotDp(sock);
  const me = jidNum(sock.user?.id);
  return {
    externalAdReply: {
      title: BOT_NAME,
      body: 'Powered by Rio Editz',
      mediaType: 1,
      renderLargerThumbnail: true,
      showAdAttribution: false,
      sourceUrl: CARD_URL || (OWNER_NUMBER ? `https://wa.me/${OWNER_NUMBER}` : `https://wa.me/${me}`),
      ...(thumbnail ? { thumbnail } : {})
    }
  };
}

// Every text reply goes through here so it shows the bot's DP as a preview card.
async function say(sock, jid, text, quoted, extra = {}) {
  let contextInfo;
  try { contextInfo = await cardContext(sock); } catch { /* send without the card */ }
  return sock.sendMessage(jid, { text, ...extra, ...(contextInfo ? { contextInfo } : {}) }, { quoted });
}

/* ---------- emoji reactions ---------- */
const REACTIONS = {
  menu: '📜', help: '📜', list: '📜', alive: '💚', bot: '🤖', ping: '🏓', runtime: '⏱️', about: 'ℹ️', owner: '👑',
  tt: '🎵', tiktok: '🎵', fb: '📘', facebook: '📘', pin: '📌', pinterest: '📌', song: '🎶', play: '🎶', yt: '🎶', ytmp3: '🎶',
  dl: '📥', ytdl: '📥', dlcheck: '🔍', media: '🎨', sticker: '🎨', groupinfo: '👥', grouphelp: '👥', status: '📊',
  mode: '⚙️', broadcast: '📢', bc: '📢', block: '⛔', unblock: '✅', join: '🔗', leave: '🚪', setbio: '✍️', setpp: '🖼️', restart: '🔄',
  autostatus: '📲', statussettings: '📲', statusseen: '👀', autoseen: '👀', statusreact: '😍', autoreact: '😍', statussave: '💾', autosave: '💾', statusemoji: '🎭', viewonce: '👁️', antiviewonce: '👁️', vv: '👁️', save: '💾',
  momenu: '👑', ownermenu: '👑', omenu: '👑',
  call: '📞', callsettings: '📞', callstream: '📞', realcall: '📞', callreject: '📵', anticall: '📵', autoanswer: '🤖', callanswer: '🤖', setcallmsg: '✍️',
  setcallaudio: '🎙️', setcallvideo: '🎬', callpreview: '▶️', delcallmedia: '🗑️'
};
async function react(sock, jid, key, emoji) {
  try { await sock.sendMessage(jid, { react: { text: emoji, key } }); }
  catch (err) { console.error('React error:', err?.message || err); }
}

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
    `│ ✦ ${p}status`,
    '╰──────────────⬣',
    '',
    '╭─❮ 📥 *DOWNLOAD* ❯',
    `│ ✦ ${p}tt <link>`,
    `│ ✦ ${p}fb <link>`,
    `│ ✦ ${p}pin <link>`,
    `│ ✦ ${p}song <name/link>`,
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
    '╭─❮ 📲 *STATUS & VIEW-ONCE* ❯',
    `│ ✦ ${p}autostatus (settings)`,
    `│ ✦ ${p}statusseen <on/off>`,
    `│ ✦ ${p}statusreact <on/off>`,
    `│ ✦ ${p}statusemoji 😍 🔥 ❤️`,
    `│ ✦ ${p}statussave <on/off>`,
    `│ ✦ ${p}viewonce <on/off>`,
    `│ ✦ ${p}vv (reply to view-once)`,
    `│ ✦ ${p}save (reply to media)`,
    '╰──────────────⬣',
    '',
    `> ${BOT_NAME} • Powered by Rio Editz`
  ].join('\n');
}

// Owner-only menu (.momenu). Never shown in .menu.
function ownerMenuCaption(name) {
  const p = PREFIX;
  const { date, time } = nowStrings();
  return [
    `╭━━━〔 👑 *${BOT_NAME} OWNER MENU* 👑 〕━━━⬣`,
    `┃ 👋 Hi *${name}*, ${greeting()}`,
    `┃ 🔰 Prefix : ${p}`,
    `┃ ⏱️ Uptime : ${formatUptime(process.uptime())}`,
    `┃ 📅 ${date}  🕒 ${time}`,
    '╰━━━━━━━━━━━━━━━━━━━━⬣',
    '',
    '╭─❮ 👑 *OWNER* ❯',
    `│ ✦ ${p}status`,
    `│ ✦ ${p}mode <public/private>`,
    `│ ✦ ${p}broadcast <text>`,
    `│ ✦ ${p}block / ${p}unblock`,
    `│ ✦ ${p}join <group link>`,
    `│ ✦ ${p}leave`,
    `│ ✦ ${p}setbio <text>`,
    `│ ✦ ${p}setpp (reply to image)`,
    `│ ✦ ${p}restart`,
    '╰──────────────⬣',
    '',
    '╭─❮ 📞 *CALL* ❯',
    `│ ✦ ${p}call (settings)`,
    `│ ✦ ${p}callstream <on/off>`,
    `│ ✦ ${p}callreject <on/off>`,
    `│ ✦ ${p}autoanswer <on/off>`,
    `│ ✦ ${p}setcallaudio (reply)`,
    `│ ✦ ${p}setcallvideo (reply)`,
    `│ ✦ ${p}setcallmsg <text>`,
    `│ ✦ ${p}callpreview`,
    `│ ✦ ${p}delcallmedia <audio/video>`,
    '╰──────────────⬣',
    '',
    `> ${BOT_NAME} • Owner only`
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
        row('Owner', 'Contact the owner', 'owner'),
        row('Status', 'Bot status', 'status')
      ] },
      { title: '📥 DOWNLOAD', rows: [
        row('TikTok', 'Use .tt <link>', 'tt'),
        row('Facebook', 'Use .fb <link>', 'fb'),
        row('Pinterest', 'Use .pin <link>', 'pin'),
        row('YouTube Song', 'Use .song <name or link>', 'song')
      ] },
      { title: '🎨 MEDIA', rows: [
        row('Sticker', 'Sticker help', 'sticker'),
        row('Media', 'Media command guide', 'media')
      ] },
      { title: '👥 GROUP', rows: [
        row('Group Info', 'Current group details', 'groupinfo'),
        row('Group Help', 'Group commands', 'grouphelp')
      ] },
      { title: '📲 STATUS & VIEW-ONCE', rows: [
        row('Status Settings', 'Show all status tools', 'autostatus'),
        row('Auto View', 'View statuses on/off', 'statusseen'),
        row('Auto React', 'React to statuses on/off', 'statusreact'),
        row('React Emojis', 'Set your emojis', 'statusemoji'),
        row('Auto Save', 'Save statuses on/off', 'statussave'),
        row('View-Once', 'Recover view-once on/off', 'viewonce')
      ] }
    ])
  ];
  if (OWNER_NUMBER) buttons.push(urlBtn('👑 Chat Owner', `https://wa.me/${OWNER_NUMBER}`));
  return buttons;
}
function ownerMenuButtons() {
  const p = PREFIX;
  const row = (title, description, id) => ({ header: '', title, description, id: `${p}${id}` });
  return [
    qr('📞 Call Settings', `${p}call`),
    qr('📜 Main Menu', `${p}menu`),
    listBtn('👑 Owner Menu', [
      { title: '👑 OWNER', rows: [
        row('Mode', 'public / private', 'mode'),
        row('Broadcast', 'Send text to all groups', 'broadcast'),
        row('Block', 'Block a user', 'block'),
        row('Unblock', 'Unblock a user', 'unblock'),
        row('Join', 'Join a group by link', 'join'),
        row('Leave', 'Leave this group', 'leave'),
        row('Set Bio', 'Change bot bio', 'setbio'),
        row('Set DP', 'Reply to an image', 'setpp'),
        row('Restart', 'Restart the bot', 'restart')
      ] },
      { title: '📞 CALL', rows: [
        row('Call Settings', 'Show call settings', 'call'),
        row('Real Call Answer', 'Answer calls + play audio/video', 'callstream'),
        row('Call Reject', 'Reject calls on/off', 'callreject'),
        row('Auto Answer', 'Reply to calls with audio/video', 'autoanswer'),
        row('Call Preview', 'Send the saved audio/video', 'callpreview')
      ] }
    ])
  ];
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
const PIN_HOSTS = /(^|\.)(pinterest\.[a-z.]{2,}|pin\.it)$/i;
const PINIMG_HOSTS = /(^|\.)pinimg\.com$/i;
const pendingDl = new Map(); // token -> { info, platform, expires }

function parseUrl(raw, platform) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const hosts = platform === 'tiktok' ? TIKTOK_HOSTS : platform === 'pinterest' ? PIN_HOSTS : FB_HOSTS;
  return hosts.test(u.hostname) ? u.toString() : null;
}

// Pinterest: read the public pin page (og tags + embedded JSON) and pick the best image / video.
const decodeHtml = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
function parsePinHtml(html) {
  const text = String(html || '').replace(/\\u002F/gi, '/').replace(/\\\//g, '/');
  const meta = (name) => {
    const m = text.match(new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']*)["']`, 'i'))
      || text.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${name}["']`, 'i'));
    return m ? decodeHtml(m[1]) : '';
  };
  const pinHost = (u) => { try { return PINIMG_HOSTS.test(new URL(u).hostname); } catch { return false; } };

  // video: prefer mp4 (720p first), skip HLS playlists
  const mp4s = [...new Set(text.match(/https:\/\/v\d*\.pinimg\.com\/videos\/[^"'\\\s<>]+?\.mp4/g) || [])];
  const video = mp4s.find((u) => /720p/i.test(u)) || mp4s[0] || (pinHost(meta('og:video')) && /\.mp4/i.test(meta('og:video')) ? meta('og:video') : '');

  // image: original size when possible
  let image = '';
  const orig = text.match(/"orig"\s*:\s*\{[^}]*?"url"\s*:\s*"(https:\/\/i\.pinimg\.com\/[^"]+)"/);
  if (orig) image = orig[1];
  if (!image) {
    const og = meta('og:image');
    if (pinHost(og)) image = og.replace(/\/\d+x(\d+)?\//, '/originals/');
  }
  const title = (meta('og:title') || meta('twitter:title') || '').replace(/\s*\|\s*Pinterest.*$/i, '').trim();
  const thumb = pinHost(meta('og:image')) ? meta('og:image') : image;
  return { title, video: video || '', image: image || '', thumb };
}

async function pinterest(url) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'accept-language': 'en-US,en;q=0.9'
    },
    signal: AbortSignal.timeout(30000)
  });
  let finalHost = '';
  try { finalHost = new URL(res.url).hostname; } catch {}
  if (!PIN_HOSTS.test(finalHost)) throw new Error('Redirected outside Pinterest');
  if (!res.ok) throw new Error(`Pinterest page gave HTTP ${res.status}`);
  const parsed = parsePinHtml(await res.text());
  if (!parsed.video && !parsed.image) throw new Error('No media found on that pin');
  return { title: parsed.title, author: '', thumb: parsed.thumb || parsed.image, video: parsed.video, image: parsed.image, audio: null, headers: {} };
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
          const headers = { ...(j.http_headers || {}) };
          if (j.cookies) headers.Cookie = j.cookies; // TikTok's CDN answers 403 without these
          resolve({ title: j.title || '', author: j.uploader || '', thumb: j.thumbnail || '', video: j.url, audio: null, headers, viaYtDlp: true });
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
    if (attempt < 1 && res.status !== 403) { await sleep(1500); return tikwm(url, attempt + 1); } // free API allows ~1 request/second
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
  if (platform === 'pinterest') {
    try { return await pinterest(url); }
    catch (err) { console.error('Pinterest scrape failed, trying yt-dlp:', err?.message || err); }
  }
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

// Optional YouTube cookies (Netscape cookies.txt content in the YTDLP_COOKIES env) for when YouTube asks "confirm you're not a bot".
const COOKIE_FILE = path.join(os.tmpdir(), 'ytdlp-cookies.txt');
if (process.env.YTDLP_COOKIES) { try { fs.writeFileSync(COOKIE_FILE, process.env.YTDLP_COOKIES.replace(/\\n/g, '\n'), { mode: 0o600 }); } catch {} }
// Preferred: add cookies.txt as a Render "Secret File" (Environment -> Secret Files, filename cookies.txt). It is copied so yt-dlp can write to it.
const SECRET_COOKIES = process.env.YTDLP_COOKIES_FILE || '/etc/secrets/cookies.txt';
try { if (fs.existsSync(SECRET_COOKIES)) { fs.copyFileSync(SECRET_COOKIES, COOKIE_FILE); fs.chmodSync(COOKIE_FILE, 0o600); console.log('YouTube cookies loaded.'); } } catch (err) { console.error('Could not load cookies file:', err?.message || err); }
const cookieArgs = () => (fs.existsSync(COOKIE_FILE) ? ['--cookies', COOKIE_FILE] : []);

// Lets yt-dlp itself download the file (it knows the right headers/cookies for each site).
async function ytDlpFile(url, token, { format = 'best[ext=mp4]/best', cookies = false } = {}) {
  await ytdlpReady;
  const prefix = `rio-${token}-${Math.random().toString(36).slice(2, 6)}`;
  const template = path.join(os.tmpdir(), `${prefix}.%(ext)s`);
  const args = ['--no-playlist', '--no-warnings', '--max-filesize', `${Math.round(MAX_DL_BYTES / 1048576)}M`, '-f', format, '-o', template, ...(cookies ? cookieArgs() : []), '--', url];
  const output = await new Promise((resolve, reject) => {
    execFile(YTDLP, args, { timeout: 240000, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => (err ? reject(err) : resolve(`${stdout}\n${stderr}`)));
  });
  const file = fs.readdirSync(os.tmpdir()).find((f) => f.startsWith(prefix) && !f.endsWith('.part'));
  if (!file) throw new Error(/larger than/i.test(output) ? 'TOO_BIG' : 'yt-dlp produced no file');
  const full = path.join(os.tmpdir(), file);
  try {
    const buf = fs.readFileSync(full);
    if (buf.length > MAX_DL_BYTES) throw new Error('TOO_BIG');
    return { buf, ext: path.extname(file).slice(1).toLowerCase() };
  } finally { try { fs.unlinkSync(full); } catch {} }
}
const ytDlpDownload = async (url, token) => (await ytDlpFile(url, token)).buf;

async function getVideoBuffer(info, token) {
  try { return await fetchBuffer(info.video, info.headers); }
  catch (err) {
    if (err?.message === 'TOO_BIG' || !info.sourceUrl) throw err;
    console.error('Direct download failed, using yt-dlp download:', err?.message || err);
    return ytDlpDownload(info.sourceUrl, token);
  }
}

async function startDownload(sock, jid, msg, platform, rawUrl) {
  const reply = (t) => say(sock, jid, t, msg);
  const label = platform === 'tiktok' ? 'TikTok' : platform === 'pinterest' ? 'Pinterest' : 'Facebook';
  const cmd = platform === 'tiktok' ? 'tt' : platform === 'pinterest' ? 'pin' : 'fb';
  const url = parseUrl(rawUrl, platform);
  if (!url) return reply(`❌ Send a valid ${label} link.\nExample: ${PREFIX}${cmd} <${label} link>`);
  await reply(`⏳ Fetching ${label} ${platform === 'pinterest' ? 'pin' : 'video'}...`);
  let info;
  try { info = await resolveMedia(platform, url); }
  catch (err) {
    console.error(`${label} resolve error:`, err?.stderr || err?.message || err);
    return reply(`❌ Could not fetch that ${label} video. It may be private, removed, or the downloader is unavailable.`);
  }
  info.sourceUrl = url;

  // Pinterest image pin: no format choice needed, send the picture straight away.
  if (platform === 'pinterest' && info.image && !info.video) {
    const cap = `📌 ${(info.title || 'Pinterest image').slice(0, 200)}\n\n> ${BOT_NAME}`;
    let buf = null;
    for (const candidate of [info.image, info.thumb]) {
      if (!candidate) continue;
      try { buf = await fetchBuffer(candidate); break; } catch (err) { console.error('Pinterest image download failed:', err?.message || err); }
    }
    if (!buf) return reply('❌ Could not download that image.');
    return sock.sendMessage(jid, { image: buf, caption: cap }, { quoted: msg });
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
    ...(platform === 'pinterest' ? [] : [qr('🎵 Audio', `${p}dl audio ${token}`)]),
    qr('📄 Document', `${p}dl doc ${token}`)
  ];
  return sendRich(sock, jid, { caption, buttons, footer: `${BOT_NAME} • Link valid for 10 min`, image: info.thumb || MENU_IMAGE }, msg);
}

async function sendDownload(sock, jid, msg, kind, token) {
  const reply = (t) => say(sock, jid, t, msg);
  const entry = pendingDl.get(String(token || ''));
  if (!entry || entry.expires < Date.now()) return reply(`⌛ This download request expired. Send the link again with ${PREFIX}tt or ${PREFIX}fb.`);
  const { info } = entry;
  const safeName = `${BOT_NAME.replace(/\W+/g, '-')}-${String(token)}`;
  try {
    await reply(kind === 'audio' ? '⏳ Preparing audio...' : '⏳ Downloading...');
    if (kind === 'audio') {
      const buf = info.audio ? await fetchBuffer(info.audio) : await getVideoBuffer(info, token);
      return sock.sendMessage(jid, { audio: buf, mimetype: info.audio ? 'audio/mpeg' : 'audio/mp4', ptt: false }, { quoted: msg });
    }
    const buf = await getVideoBuffer(info, token);
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

/* ---------- YouTube song / video ---------- */
const YT_HOSTS = /(^|\.)(youtube\.com|youtu\.be|music\.youtube\.com)$/i;
const MAX_SONG_MIN = Number(process.env.MAX_SONG_MIN || 20);

function ytSearchInfo(target) {
  return new Promise(async (resolve, reject) => {
    await ytdlpReady;
    execFile(YTDLP, ['-J', '--no-playlist', '--no-warnings', '--skip-download', ...cookieArgs(), '--', target],
      { timeout: 90000, maxBuffer: 30 * 1024 * 1024 }, (err, stdout) => {
        if (err) return reject(err);
        try {
          const j = JSON.parse(stdout);
          const e = j.entries ? j.entries[0] : j;
          if (!e) return reject(new Error('NO_RESULT'));
          resolve({
            title: e.title || 'Unknown', author: e.uploader || e.channel || '', duration: Number(e.duration || 0),
            thumb: e.thumbnail || '', sourceUrl: e.webpage_url || (e.id ? `https://www.youtube.com/watch?v=${e.id}` : '')
          });
        } catch (x) { reject(x); }
      });
  });
}

async function startSong(sock, jid, msg, query) {
  const reply = (t) => say(sock, jid, t, msg);
  if (!query) return reply(`🎵 Send a song name or YouTube link.\nExample: ${PREFIX}song shape of you`);
  let target = `ytsearch1:${query}`;
  if (/^https?:\/\//i.test(query)) {
    let u; try { u = new URL(query); } catch {}
    if (!u || !YT_HOSTS.test(u.hostname)) return reply('❌ Only YouTube links are supported here.');
    target = u.toString();
  }
  await reply('🔎 Searching YouTube...');
  let info;
  try { info = await ytSearchInfo(target); }
  catch (err) {
    console.error('YouTube search error:', err?.stderr || err?.message || err);
    const bot = /confirm you.?re not a bot|sign in/i.test(String(err?.stderr || err?.message));
    return reply(bot ? '❌ YouTube blocked this server (bot check). Add YouTube cookies in the YTDLP_COOKIES env, or try again later.' : '❌ Could not find or open that video.');
  }
  if (info.duration && info.duration > MAX_SONG_MIN * 60) return reply(`❌ That video is longer than ${MAX_SONG_MIN} minutes.`);
  const token = crypto.randomBytes(4).toString('hex');
  pendingDl.set(token, { info, platform: 'youtube', expires: Date.now() + 10 * 60 * 1000 });
  const mins = info.duration ? `${Math.floor(info.duration / 60)}:${String(Math.floor(info.duration % 60)).padStart(2, '0')}` : '-';
  const p = PREFIX;
  const caption = [
    '╭━━━〔 🎵 *YOUTUBE DOWNLOADER* 〕━━━⬣',
    `┃ 🎬 ${info.title.slice(0, 120)}`,
    info.author ? `┃ 👤 ${info.author}` : null,
    `┃ ⏱️ ${mins}`,
    '╰━━━━━━━━━━━━━━━━━━━━⬣',
    '',
    '👇 Select the file format'
  ].filter((l) => l !== null).join('\n');
  const buttons = [
    qr('🎵 Audio', `${p}ytdl audio ${token}`),
    qr('📄 Document', `${p}ytdl doc ${token}`),
    qr('🎬 Video', `${p}ytdl video ${token}`)
  ];
  return sendRich(sock, jid, { caption, buttons, footer: `${BOT_NAME} • Link valid for 10 min`, image: info.thumb || MENU_IMAGE }, msg);
}

async function sendSong(sock, jid, msg, kind, token) {
  const reply = (t) => say(sock, jid, t, msg);
  const entry = pendingDl.get(String(token || ''));
  if (!entry || entry.platform !== 'youtube' || entry.expires < Date.now()) return reply(`⌛ This request expired. Search again with ${PREFIX}song.`);
  const { info } = entry;
  const name = (info.title || 'song').replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'song';
  try {
    await reply(kind === 'video' ? '⏳ Downloading video...' : '⏳ Downloading audio...');
    if (kind === 'video') {
      const { buf } = await ytDlpFile(info.sourceUrl, token, { format: 'best[ext=mp4][height<=480]/best[ext=mp4]/best', cookies: true });
      return sock.sendMessage(jid, { video: buf, mimetype: 'video/mp4', caption: `🎬 ${info.title.slice(0, 200)}\n\n> ${BOT_NAME}` }, { quoted: msg });
    }
    const { buf, ext } = await ytDlpFile(info.sourceUrl, token, { format: 'bestaudio[ext=m4a]/bestaudio', cookies: true });
    const mimes = { m4a: 'audio/mp4', mp4: 'audio/mp4', mp3: 'audio/mpeg', ogg: 'audio/ogg; codecs=opus', opus: 'audio/ogg; codecs=opus' };
    if (kind === 'audio' && mimes[ext]) return sock.sendMessage(jid, { audio: buf, mimetype: mimes[ext], ptt: false }, { quoted: msg });
    return sock.sendMessage(jid, { document: buf, mimetype: mimes[ext] || 'application/octet-stream', fileName: `${name}.${ext || 'm4a'}`, caption: `🎵 ${info.title.slice(0, 200)}` }, { quoted: msg });
  } catch (err) {
    console.error('Song download error:', err?.stderr || err?.message || err);
    if (err?.message === 'TOO_BIG') return reply(`❌ File is larger than ${Math.round(MAX_DL_BYTES / 1048576)} MB, so I can't send it.`);
    if (/confirm you.?re not a bot|sign in/i.test(String(err?.stderr || err?.message))) return reply('❌ YouTube blocked this server (bot check). Add YouTube cookies in the YTDLP_COOKIES env, or try again later.');
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

  const reply = (t) => say(sock, jid, t, msg);

  // Who sent this? "owner" = the linked account itself or OWNER_NUMBER. "admin" = OWNER_NUMBER only (affects the whole server).
  const senderNum = jidNum(msg.key.fromMe ? sock.user?.id : (msg.key.participant || jid));
  const isOwner = !!msg.key.fromMe || senderNum === jidNum(sock.user?.id) || (!!OWNER_NUMBER && senderNum === OWNER_NUMBER);
  const isAdmin = !!OWNER_NUMBER && senderNum === OWNER_NUMBER;
  const OWNER_ONLY = new Set(['mode', 'broadcast', 'bc', 'block', 'unblock', 'join', 'leave', 'setbio', 'setpp', 'restart',
    'autostatus', 'statussettings', 'statusseen', 'autoseen', 'statusreact', 'autoreact', 'statussave', 'autosave', 'viewonce', 'antiviewonce', 'statusemoji', 'vv', 'save',
    'callstream', 'realcall', 'call', 'callsettings', 'callreject', 'anticall', 'autoanswer', 'callanswer', 'setcallmsg', 'setcallaudio', 'setcallvideo', 'callpreview', 'delcallmedia']);

  if (getMode(sessionId) === 'private' && !isOwner) return; // private mode: only the owner can use the bot

  if (/^(momenu|ownermenu|omenu)$/.test(command) && !isOwner) return; // the owner menu does not exist for other people

  const known = command in REACTIONS;
  react(sock, jid, msg.key, known ? REACTIONS[command] : '❔'); // emoji reaction on the command message

  if (OWNER_ONLY.has(command) && !isOwner) {
    react(sock, jid, msg.key, '🚫');
    return reply('🚫 This command is for the bot owner only.');
  }

  // user to act on: @mention, replied-to person, or a number typed after the command
  const targetJid = () => {
    const ctx = unwrapMessage(msg.message).extendedTextMessage?.contextInfo;
    const mentioned = ctx?.mentionedJid?.[0];
    if (mentioned) return mentioned;
    if (ctx?.participant) return ctx.participant;
    const num = (args[0] || '').replace(/\D/g, '');
    if (num.length >= 8) return `${num}@s.whatsapp.net`;
    if (!jid.endsWith('@g.us')) return jid;
    return null;
  };

  switch (command) {
    case 'menu':
    case 'help':
    case 'list':
      return sendRich(sock, jid, { caption: menuCaption(name), buttons: menuButtons(), footer }, msg);
    case 'momenu':
    case 'ownermenu':
    case 'omenu':
      return sendRich(sock, jid, { caption: ownerMenuCaption(name), buttons: ownerMenuButtons(), footer: `${BOT_NAME} • Owner only` }, msg);
    case 'alive':
    case 'bot':
      return sendRich(sock, jid, { caption: aliveCaption(name), buttons: aliveButtons(), footer }, msg);
    case 'tt':
    case 'tiktok':
      return startDownload(sock, jid, msg, 'tiktok', args[0]);
    case 'fb':
    case 'facebook':
      return startDownload(sock, jid, msg, 'facebook', args[0]);
    case 'pin':
    case 'pinterest':
      return startDownload(sock, jid, msg, 'pinterest', args[0]);
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
    case 'song':
    case 'play':
    case 'yt':
    case 'ytmp3':
      return startSong(sock, jid, msg, args.join(' ').trim());
    case 'ytdl':
      return sendSong(sock, jid, msg, args[0], args[1]);
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
    case 'creator': {
      const num = OWNER_NUMBER || jidNum(sock.user?.id); // falls back to the linked account when OWNER_NUMBER is not set
      if (!num) return reply('👑 Owner contact is not set. Add OWNER_NUMBER in the environment variables.');
      const vcard = ['BEGIN:VCARD', 'VERSION:3.0', `FN:${BOT_NAME} Owner`, `ORG:${BOT_NAME};`, `TEL;type=CELL;type=VOICE;waid=${num}:+${num}`, 'END:VCARD'].join('\n');
      await sock.sendMessage(jid, { contacts: { displayName: `${BOT_NAME} Owner`, contacts: [{ vcard }] } }, { quoted: msg });
      return reply(`👑 *Owner:* https://wa.me/${num}`);
    }

    /* ----- owner commands ----- */
    case 'mode': {
      const m = (args[0] || '').toLowerCase();
      if (m !== 'public' && m !== 'private') return reply(`⚙️ Current mode: *${getMode(sessionId)}*\nUse ${PREFIX}mode public or ${PREFIX}mode private\n(private = only the owner can use the bot)`);
      setMode(sessionId, m);
      return reply(`✅ Mode changed to *${m}*.`);
    }
    case 'broadcast':
    case 'bc': {
      const body = args.join(' ').trim();
      if (!body) return reply(`📢 Usage: ${PREFIX}broadcast <text>\nSends the text to every group the bot is in.`);
      const groups = Object.keys(await sock.groupFetchAllParticipating());
      await reply(`📢 Sending to ${groups.length} group(s)...`);
      let ok = 0;
      for (const g of groups) {
        try { await say(sock, g, `📢 *${BOT_NAME} Broadcast*\n\n${body}`); ok++; } catch (err) { console.error('Broadcast error:', err?.message || err); }
        await sleep(2000); // slow on purpose, fast bulk sending gets accounts banned
      }
      return reply(`✅ Broadcast delivered to ${ok}/${groups.length} group(s).`);
    }
    case 'block':
    case 'unblock': {
      const target = targetJid();
      if (!target) return reply(`Usage: ${PREFIX}${command} <number> (or reply to / @mention the user)`);
      if (jidNum(target) === jidNum(sock.user?.id)) return reply("❌ I can't do that to myself.");
      await sock.updateBlockStatus(target, command);
      return say(sock, jid, `✅ ${command === 'block' ? 'Blocked' : 'Unblocked'} @${jidNum(target)}`, msg, { mentions: [target] });
    }
    case 'join': {
      const code = (args[0] || '').match(/chat\.whatsapp\.com\/([A-Za-z0-9]+)/)?.[1];
      if (!code) return reply(`Usage: ${PREFIX}join https://chat.whatsapp.com/xxxx`);
      try { await sock.groupAcceptInvite(code); return reply('✅ Joined the group.'); }
      catch (err) { console.error('Join error:', err?.message || err); return reply('❌ Could not join (link expired, revoked, or group needs approval).'); }
    }
    case 'leave': {
      if (!jid.endsWith('@g.us')) return reply('This command only works in groups.');
      await reply('👋 Leaving this group. Bye!');
      return sock.groupLeave(jid);
    }
    case 'setbio': {
      const bio = args.join(' ').trim();
      if (!bio) return reply(`Usage: ${PREFIX}setbio <text>`);
      await sock.updateProfileStatus(bio.slice(0, 139));
      return reply('✅ Bio updated.');
    }
    case 'setpp': {
      const ctx = unwrapMessage(msg.message).extendedTextMessage?.contextInfo;
      const quoted = ctx?.quotedMessage ? unwrapMessage(ctx.quotedMessage) : null;
      const own = unwrapMessage(msg.message);
      let target = null;
      if (quoted?.imageMessage) target = { key: { remoteJid: jid, id: ctx.stanzaId, participant: ctx.participant }, message: quoted };
      else if (own.imageMessage) target = msg;
      if (!target) return reply(`🖼️ Reply to an image with ${PREFIX}setpp to set it as the bot's profile picture.`);
      try {
        const buf = await downloadMediaMessage(target, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
        await sock.updateProfilePicture(sock.user.id, buf);
        resetBotDp(sock); // refresh the DP shown on reply cards
        return reply('✅ Profile picture updated. New replies will show it.');
      } catch (err) { console.error('setpp error:', err?.message || err); return reply('❌ Could not update the profile picture.'); }
    }
    /* ----- call commands ----- */
    case 'call':
    case 'callsettings': {
      const onoff = (v) => (v ? '✅ ON' : '❌ OFF');
      const [a, v] = await Promise.all([loadCallMedia(sessionId, 'audio'), loadCallMedia(sessionId, 'video')]);
      return reply([
        '╭━━━〔 📞 *CALL SETTINGS* 〕━━━⬣',
        `┃ 📵 Call reject   : ${onoff(getSetting(sessionId, 'callReject', false))}`,
        `┃ 🤖 Auto answer   : ${onoff(getSetting(sessionId, 'autoAnswer', false))}`,
        `┃ 🎙️ Saved audio   : ${a ? '✅ set' : '— not set'}`,
        `┃ 🎬 Saved video   : ${v ? '✅ set' : '— not set'}`,
        '╰━━━━━━━━━━━━━━━━━━━━⬣',
        '',
        `${PREFIX}callreject on/off — reject incoming calls (sends the call message)`,
        `${PREFIX}autoanswer on/off — reject the call, then send the saved audio / video to the caller (voice call → audio, video call → video)`,
        `${PREFIX}setcallaudio — reply to a voice note / audio`,
        `${PREFIX}setcallvideo — reply to a video`,
        `${PREFIX}setcallmsg <text> — message sent when a call is rejected`,
        `${PREFIX}callpreview — send the saved audio / video here`,
        `${PREFIX}delcallmedia audio|video — remove a saved file`,
        '',
        '_Note: WhatsApp does not allow bots to pick up a call and stream into it, so "auto answer" replies with the saved audio / video as a message right after rejecting the call._'
      ].join('\n'));
    }
    case 'callreject':
    case 'anticall':
    case 'autoanswer':
    case 'callanswer': {
      const key = command === 'callreject' || command === 'anticall' ? 'callReject' : 'autoAnswer';
      const label = key === 'callReject' ? 'Call reject' : 'Auto call answer';
      const v = parseToggle(args[0]);
      if (v === null) return reply(`${label} is *${getSetting(sessionId, key, false) ? 'ON' : 'OFF'}*.\nUse ${PREFIX}${command} on  or  ${PREFIX}${command} off`);
      setSetting(sessionId, key, v);
      let note = '';
      if (key === 'autoAnswer' && v) {
        const [a, vid] = await Promise.all([loadCallMedia(sessionId, 'audio'), loadCallMedia(sessionId, 'video')]);
        if (!a && !vid) note = `\n⚠️ No audio/video saved yet. Reply to one with ${PREFIX}setcallaudio or ${PREFIX}setcallvideo.`;
      }
      return reply(`✅ ${label}: *${v ? 'ON' : 'OFF'}*${note}`);
    }
    case 'callstream':
    case 'realcall': {
      if (!callbotAvailable) return reply('❌ Real call answering is not installed on this server.\nIt needs the Docker deploy with the Go "callbot" service (see README → Real call answering). Until then use ' + PREFIX + 'autoanswer (reject + send the clip as a message).');
      const sub = (args[0] || '').toLowerCase();
      let st;
      try { st = await callbotApi('GET', `/sessions/${sessionId}`); }
      catch (err) { return reply(`❌ The call service is not answering yet (${err?.message || err}). Try again in a minute.`); }
      const on = !!getSetting(sessionId, 'callStream', false);

      if (!sub || sub === 'status') {
        const [a, v] = await Promise.all([loadCallMedia(sessionId, 'audio'), loadCallMedia(sessionId, 'video')]);
        return reply([
          '╭━━━〔 📞 *REAL CALL ANSWER* 〕━━━⬣',
          `┃ 🔛 Answer calls  : ${on ? '✅ ON' : '❌ OFF'}`,
          `┃ 🔗 Call service  : ${st.linked ? (st.connected ? '✅ linked' : '⚠️ linked, reconnecting') : '❌ not linked'}`,
          `┃ 🔁 Loop clip     : ${getSetting(sessionId, 'callLoop', false) ? 'ON' : 'OFF'}`,
          `┃ 🎙️ Audio clip    : ${a ? '✅ set' : '— not set'}`,
          `┃ 🎬 Video clip    : ${v ? '✅ set' : '— not set'}`,
          '╰━━━━━━━━━━━━━━━━━━━━⬣',
          '',
          `${PREFIX}callstream on / off`,
          `${PREFIX}callstream loop on / off`,
          `${PREFIX}callstream unlink — remove the linked call device`,
          `${PREFIX}setcallaudio / ${PREFIX}setcallvideo — choose what is played (voice call → audio, video call → video)`
        ].join('\n'));
      }
      if (sub === 'off') { setSetting(sessionId, 'callStream', false); await syncCallbot(sessionId, sock); return reply('✅ Real call answering: *OFF*'); }
      if (sub === 'loop') {
        const lv = parseToggle(args[1]);
        if (lv === null) return reply(`Use ${PREFIX}callstream loop on  or  ${PREFIX}callstream loop off`);
        setSetting(sessionId, 'callLoop', lv); await syncCallbot(sessionId, sock);
        return reply(`✅ Loop clip: *${lv ? 'ON' : 'OFF'}* (${lv ? 'plays until the caller hangs up' : 'hangs up when the clip ends'})`);
      }
      if (sub === 'unlink') {
        setSetting(sessionId, 'callStream', false);
        try { await callbotApi('DELETE', `/sessions/${sessionId}`); } catch (err) { return reply(`❌ ${err?.message || err}`); }
        return reply('✅ Call device unlinked and real call answering turned OFF.');
      }
      if (sub !== 'on') return reply(`Use ${PREFIX}callstream on / off / loop / unlink`);

      setSetting(sessionId, 'callStream', true);
      if (st.linked) {
        await syncCallbot(sessionId, sock);
        const [a, v] = await Promise.all([loadCallMedia(sessionId, 'audio'), loadCallMedia(sessionId, 'video')]);
        return reply(`✅ Real call answering: *ON*${!a && !v ? `\n⚠️ No clip saved. Reply to a voice note with ${PREFIX}setcallaudio or to a video with ${PREFIX}setcallvideo.` : ''}`);
      }
      if (!st.ffmpeg) await reply('⚠️ ffmpeg is missing on the server, saving clips will fail.');
      try {
        const phone = jidNum(sock.user?.id);
        const { code } = await callbotApi('POST', `/sessions/${sessionId}/pair`, { json: { phone }, timeout: 60000 });
        watchCallbotLink(sessionId, sock, jid);
        return reply(`🔗 *Link the call service (one time)*\n\n1. Open WhatsApp on your phone\n2. *Linked devices → Link a device*\n3. Tap *Link with phone number instead*\n4. Enter this code:\n\n*${code}*\n\nThe code works for 5 minutes. I will message you here when it is linked.`);
      } catch (err) { console.error('callbot pair error:', err?.message || err); return reply(`❌ Could not start linking: ${err?.message || err}`); }
    }
    /* ----- status tools / view-once ----- */
    case 'autostatus':
    case 'statussettings': {
      const onoff = (v) => (v ? '✅ ON' : '❌ OFF');
      const list = getSetting(sessionId, 'statusEmojis', null);
      return reply([
        '╭━━━〔 📲 *STATUS TOOLS* 〕━━━⬣',
        `┃ 👀 Auto view    : ${onoff(getSetting(sessionId, 'statusSeen', false))}`,
        `┃ 😍 Auto react   : ${onoff(getSetting(sessionId, 'statusReact', false))}`,
        `┃ 🎭 Emojis       : ${(Array.isArray(list) && list.length ? list : DEFAULT_STATUS_EMOJIS).join(' ')}`,
        `┃ 💾 Auto save    : ${onoff(getSetting(sessionId, 'statusSave', false))}`,
        `┃ 👁️ View-once    : ${onoff(getSetting(sessionId, 'viewOnce', false))}`,
        '╰━━━━━━━━━━━━━━━━━━━━⬣',
        '',
        `${PREFIX}statusseen on/off — view every status automatically`,
        `${PREFIX}statusreact on/off — react to statuses with a random emoji from your list`,
        `${PREFIX}statusemoji 😍 🔥 ❤️ — set your emojis (${PREFIX}statusemoji reset = default)`,
        `${PREFIX}statussave on/off — send every status to your own chat`,
        `${PREFIX}viewonce on/off — send a copy of every view-once photo / video / voice note to your own chat`,
        `${PREFIX}vv — reply to a view-once message to open it here`,
        `${PREFIX}save — reply to any photo / video / voice note to send it to your own chat`
      ].join('\n'));
    }
    case 'statusseen': case 'autoseen': case 'statusreact': case 'autoreact':
    case 'statussave': case 'autosave': case 'viewonce': case 'antiviewonce': {
      const [key, label] = STATUS_TOGGLES[command];
      const v = parseToggle(args[0]);
      if (v === null) return reply(`${label} is *${getSetting(sessionId, key, false) ? 'ON' : 'OFF'}*.\nUse ${PREFIX}${command} on  or  ${PREFIX}${command} off`);
      setSetting(sessionId, key, v);
      return reply(`✅ ${label}: *${v ? 'ON' : 'OFF'}*`);
    }
    case 'statusemoji': {
      if (/^reset$/i.test(args[0] || '')) { setSetting(sessionId, 'statusEmojis', null); return reply(`✅ Emojis reset: ${DEFAULT_STATUS_EMOJIS.join(' ')}`); }
      const list = extractEmojis(args.join(' '));
      if (!list.length) {
        const cur = getSetting(sessionId, 'statusEmojis', null);
        return reply(`🎭 Current emojis: ${(Array.isArray(cur) && cur.length ? cur : DEFAULT_STATUS_EMOJIS).join(' ')}\nSet your own: ${PREFIX}statusemoji 😍 🔥 ❤️ 👏\n(one is picked randomly for every status)`);
      }
      setSetting(sessionId, 'statusEmojis', list);
      return reply(`✅ Status react emojis: ${list.join(' ')}`);
    }
    case 'vv':
    case 'save': {
      const ctx = unwrapMessage(msg.message).extendedTextMessage?.contextInfo;
      const found = ctx?.quotedMessage ? findMedia(ctx.quotedMessage) : null;
      if (!found?.kind) return reply(command === 'vv' ? `Reply to a view-once photo / video / voice note with ${PREFIX}vv` : `Reply to a photo / video / voice note with ${PREFIX}save and I send it to your own chat.`);
      try {
        const target = { key: { remoteJid: ctx.remoteJid || jid, id: ctx.stanzaId, participant: ctx.participant }, message: ctx.quotedMessage };
        const buf = await downloadPart(sock, target, found.part);
        const to = command === 'vv' ? jid : jidNormalizedUser(sock.user?.id);
        await sendMedia(sock, to, found.kind, found.part, buf, found.part.caption || '');
        return to === jid ? undefined : reply('✅ Sent to your own chat.');
      } catch (err) {
        console.error(`${command} error:`, err?.message || err);
        return reply(err?.message === 'TOO_BIG' ? '❌ That file is too big.' : '❌ Could not open that message (it may have expired).');
      }
    }
    case 'setcallmsg': {
      const t = args.join(' ').trim();
      if (!t) return reply(`Current call message:\n${getSetting(sessionId, 'callMsg', DEFAULT_CALL_MSG)}\n\nChange it: ${PREFIX}setcallmsg <text>  (or ${PREFIX}setcallmsg reset)`);
      setSetting(sessionId, 'callMsg', /^reset$/i.test(t) ? null : t.slice(0, 500));
      return reply('✅ Call message updated.');
    }
    case 'setcallaudio':
    case 'setcallvideo': {
      const kind = command === 'setcallaudio' ? 'audio' : 'video';
      const ctx = unwrapMessage(msg.message).extendedTextMessage?.contextInfo;
      const quoted = ctx?.quotedMessage ? unwrapMessage(ctx.quotedMessage) : null;
      const part = kind === 'audio' ? quoted?.audioMessage : quoted?.videoMessage;
      if (!part) return reply(`Reply to a ${kind === 'audio' ? 'voice note / audio' : 'video'} with ${PREFIX}${command} to save it for calls.`);
      if (Number(part.fileLength || 0) > MAX_CALL_MEDIA) return reply(`❌ That file is bigger than ${Math.round(MAX_CALL_MEDIA / 1048576)} MB.`);
      try {
        const target = { key: { remoteJid: jid, id: ctx.stanzaId, participant: ctx.participant }, message: quoted };
        const buf = await downloadMediaMessage(target, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
        if (buf.length > MAX_CALL_MEDIA) return reply(`❌ That file is bigger than ${Math.round(MAX_CALL_MEDIA / 1048576)} MB.`);
        await saveCallMedia(sessionId, kind, buf, { mimetype: part.mimetype, ptt: !!part.ptt, caption: part.caption || '' });
        let streamNote = '';
        if (callbotAvailable) {
          try { await callbotApi('PUT', `/sessions/${sessionId}/media/${kind}`, { body: buf, timeout: 180000 }); streamNote = `\n📞 Ready for real calls too (${PREFIX}callstream on).`; }
          catch (err) { streamNote = `\n⚠️ The call service could not convert it: ${err?.message || err}`; }
        }
        return reply(`✅ Call ${kind} saved (${(buf.length / 1048576).toFixed(1)} MB).\nTurn it on with ${PREFIX}autoanswer on${streamNote}`);
      } catch (err) { console.error('setcall media error:', err?.message || err); return reply('❌ Could not save that file. Try forwarding it again and reply to the new one.'); }
    }
    case 'callpreview': {
      let sent = 0;
      for (const kind of ['audio', 'video']) {
        const media = await loadCallMedia(sessionId, kind);
        if (media) { await sendCallMedia(sock, jid, { ...media, kind }, msg); sent++; }
      }
      return sent ? undefined : reply(`Nothing saved yet. Use ${PREFIX}setcallaudio / ${PREFIX}setcallvideo.`);
    }
    case 'delcallmedia': {
      const kind = (args[0] || '').toLowerCase();
      if (kind !== 'audio' && kind !== 'video') return reply(`Usage: ${PREFIX}delcallmedia audio  or  ${PREFIX}delcallmedia video`);
      await deleteCallMedia(sessionId, kind);
      if (callbotAvailable) await callbotApi('DELETE', `/sessions/${sessionId}/media/${kind}`).catch(() => {});
      return reply(`🗑️ Saved call ${kind} removed.`);
    }
    case 'restart': {
      if (!isAdmin) return reply('🚫 Restart works only for the main OWNER_NUMBER, because it restarts every linked session.');
      await reply('🔄 Restarting...');
      return setTimeout(() => process.exit(0), 1500); // Render / pm2 starts it again automatically
    }
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
  const qrOnly = req.body?.mode === 'qr';
  const phone = qrOnly ? '' : String(req.body?.phone || '').replace(/\D/g, '');
  if (!qrOnly && (phone.length < 8 || phone.length > 15)) {
    return res.status(400).json({ error: 'Enter a valid international phone number with country code, digits only.' });
  }
  if (sessions.size >= MAX_SESSIONS) {
    return res.status(429).json({ error: 'The server is full right now. Please try again later.' });
  }
  for (const [sid, r] of sessions) { // one session per number
    if (!phone || r.phone !== phone) continue;
    if (r.status === 'connected') return res.status(409).json({ error: 'This number is already linked to the bot.' });
    if (r.state?.creds?.registered) return res.status(409).json({ error: 'This number is already linked and is reconnecting. Try again in a minute.' });
    destroySession(sid); // abandoned, unfinished attempt
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
    try { qrDataUrl = await QRCode.toDataURL(record.qr, { margin: 1, width: 320 }); } catch {}
  }
  res.json({ id, status: record.status, phone: record.phone, pairCode: record.pairCode, qrDataUrl, error: record.error || null });
});

app.delete('/api/session/:id', apiLimiter, authRequired, (req, res) => {
  const { id } = req.params;
  if (!safeId(id)) return res.status(400).json({ error: 'Invalid session id.' });
  const r = sessions.get(id);
  if (r && r.status !== 'connected' && !r.state?.creds?.registered) destroySession(id); // never touches a linked session
  res.json({ ok: true });
});

app.get('/health', (_req, res) => res.json({ ok: true, bot: BOT_NAME, activeSessions: sessions.size, storage: mongoCol ? 'mongodb' : 'files' }));

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`${BOT_NAME} pairing site listening on port ${PORT}`);
  if (REQUIRE_KEY && !keyIsConfigured()) console.warn('WARNING: PAIRING_REQUIRE_KEY is on but PAIRING_API_KEY is missing/too short — pairing is disabled until you set a real one.');
  console.log(`Session directory: ${SESSION_ROOT}`);
  startCallbot();
  restoreSessions().catch((e) => console.error('Restore error:', e?.message || e));
});

/* ---------- process safety ---------- */
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err?.message || err));
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err?.message || err));
function shutdown() {
  shuttingDown = true;
  console.log('Shutting down…');
  for (const record of sessions.values()) { clearTimers(record); try { record.sock?.end(undefined); } catch {} }
  try { callbotProc?.kill('SIGTERM'); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
