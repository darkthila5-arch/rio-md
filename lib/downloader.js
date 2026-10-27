import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { BOT_NAME, MENU_IMAGE, PREFIX, ROOT_DIR, sleep, state } from './config.js';
import { say } from './card.js';
import { qr, sendRich } from './menu.js';

/* ---------- downloader (TikTok / Facebook) ---------- */

export const MAX_DL_BYTES = Number(process.env.MAX_DL_MB || 50) * 1024 * 1024;
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

export async function pinterest(url) {
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
    execFile(state.ytdlp, ['-J', '--no-playlist', '--no-warnings', '-f', 'best[ext=mp4]/best', '--', url],
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

export async function tikwm(url, attempt = 0) {
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
  if (await ytdlpWorks(state.ytdlp)) return true;
  if (process.platform !== 'linux') { console.error('yt-dlp is not installed. Install it or set YTDLP_PATH.'); return false; }
  const asset = process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux';
  const target = path.join(ROOT_DIR, 'bin', 'yt-dlp');
  try {
    console.log('yt-dlp not found, downloading...');
    const res = await fetch(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`, { signal: AbortSignal.timeout(180000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(await res.arrayBuffer()), { mode: 0o755 });
    state.ytdlp = target;
    const ok = await ytdlpWorks(state.ytdlp);
    console.log(ok ? 'yt-dlp installed.' : 'yt-dlp downloaded but does not run.');
    return ok;
  } catch (err) {
    console.error('Could not install yt-dlp:', err?.message || err);
    return false;
  }
}
export const ytdlpReady = ensureYtDlp();

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
    execFile(state.ytdlp, args, { timeout: 240000, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => (err ? reject(err) : resolve(`${stdout}\n${stderr}`)));
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

export async function startDownload(sock, jid, msg, platform, rawUrl) {
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

export async function sendDownload(sock, jid, msg, kind, token) {
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
    execFile(state.ytdlp, ['-J', '--no-playlist', '--no-warnings', '--skip-download', ...cookieArgs(), '--', target],
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

export async function startSong(sock, jid, msg, query) {
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

export async function sendSong(sock, jid, msg, kind, token) {
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
