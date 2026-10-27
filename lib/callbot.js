import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { OWNER_NUMBER, PREFIX, ROOT_DIR, SESSION_ROOT, TIMEZONE, jidNum, state } from './config.js';
import { getSetting } from './storage.js';
import { loadCallMedia } from './calls.js';
import { say } from './card.js';


/* ---------- real call answering: Go sidecar "callbot" (whatsmeow + meowcaller) ---------- */
// The sidecar links itself as a second device on the same number, answers the call and streams the saved audio / video into it.
const CALLBOT_BIN = process.env.CALLBOT_BIN || path.join(ROOT_DIR, 'bin', 'callbot');
const CALLBOT_PORT = Number(process.env.CALLBOT_PORT || 8099);
const CALLBOT_SECRET = crypto.randomBytes(24).toString('hex'); // new on every start, only this process and the sidecar know it
const CALLBOT_DIR = process.env.CALLBOT_DIR || path.join(SESSION_ROOT, '_callbot');


export function startCallbot() {
  if (!fs.existsSync(CALLBOT_BIN)) {
    console.log('Real call streaming: callbot binary not found, feature disabled (deploy with the Dockerfile to enable it).');
    return;
  }
  state.callbotAvailable = true;
  const startedAt = Date.now();
  const child = spawn(CALLBOT_BIN, [], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME || os.tmpdir(), TZ: TIMEZONE, CALLBOT_SECRET, CALLBOT_PORT: String(CALLBOT_PORT), CALLBOT_DIR },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  state.callbotProc = child;
  const relay = (stream) => stream.on('data', (d) => String(d).split('\n').filter(Boolean).forEach((l) => console.log(`[callbot] ${l}`)));
  relay(child.stdout); relay(child.stderr);
  child.on('error', (err) => console.error('callbot failed to start:', err?.message || err));
  child.on('exit', (code, signal) => {
    state.callbotProc = null;
    if (state.shuttingDown) return;
    state.callbotRestarts = Date.now() - startedAt > 60000 ? 0 : state.callbotRestarts + 1;
    console.error(`callbot exited (${signal || code}); restarting...`);
    setTimeout(startCallbot, Math.min(30000, 2000 * (state.callbotRestarts + 1))).unref?.();
  });
}

export async function callbotApi(method, apiPath, { json, body, timeout = 15000 } = {}) {
  if (!state.callbotAvailable) throw new Error('The call service is not installed on this server.');
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
export async function syncCallbot(sid, sock) {
  if (!state.callbotAvailable) return;
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
export function watchCallbotLink(sid, sock, jid) {
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
