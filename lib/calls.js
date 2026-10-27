import fs from 'node:fs';
import path from 'node:path';
import { MONGO_URL, OWNER_NUMBER, SESSION_ROOT, jidNum, state } from './config.js';
import { getMongoCol, getSetting, setSetting } from './storage.js';
import { callbotApi } from './callbot.js';
import { say } from './card.js';

/* ---------- call handling: reject calls, or reject + auto-reply with a saved audio / video ---------- */
// NOTE: WhatsApp has no public protocol for answering a call and streaming media into it, so "auto answer"
// rejects the ringing call and immediately sends the saved voice note / video to the caller instead.
const CALL_DIR = path.join(SESSION_ROOT, '_callmedia');
export const MAX_CALL_MEDIA = 15 * 1024 * 1024;
export const DEFAULT_CALL_MSG = '📵 Sorry, I can\'t take calls right now. Please send a message.';
const seenCalls = new Map(); // call id -> time, so one call is never handled twice

export async function saveCallMedia(sid, kind, buf, meta) {
  fs.mkdirSync(CALL_DIR, { recursive: true });
  fs.writeFileSync(path.join(CALL_DIR, `${sid}.${kind}`), buf);
  setSetting(sid, `call_${kind}`, meta);
  if (MONGO_URL) {
    try { await getMongoCol(); await state.mongoDb.collection('callmedia').updateOne({ _id: `${sid}:${kind}` }, { $set: { sid, kind, data: buf } }, { upsert: true }); }
    catch (err) { console.error('Mongo call media save error:', err?.message || err); }
  }
}
export async function loadCallMedia(sid, kind) {
  const meta = getSetting(sid, `call_${kind}`, null);
  if (!meta) return null;
  const file = path.join(CALL_DIR, `${sid}.${kind}`);
  try { return { ...meta, buf: fs.readFileSync(file) }; } catch { /* file lost (redeploy): try MongoDB */ }
  if (MONGO_URL) {
    try {
      await getMongoCol();
      const doc = await state.mongoDb.collection('callmedia').findOne({ _id: `${sid}:${kind}` });
      if (doc?.data) {
        const buf = Buffer.from(doc.data.buffer.subarray(0, doc.data.position ?? doc.data.buffer.length));
        try { fs.mkdirSync(CALL_DIR, { recursive: true }); fs.writeFileSync(file, buf); } catch {}
        return { ...meta, buf };
      }
    } catch (err) { console.error('Mongo call media load error:', err?.message || err); }
  }
  return null;
}
export async function deleteCallMedia(sid, kind) {
  try { fs.rmSync(path.join(CALL_DIR, `${sid}.${kind}`), { force: true }); } catch {}
  setSetting(sid, `call_${kind}`, null);
  if (MONGO_URL) { try { await getMongoCol(); await state.mongoDb.collection('callmedia').deleteOne({ _id: `${sid}:${kind}` }); } catch {} }
}
export async function sendCallMedia(sock, jid, media, quoted) {
  if (media.kind === 'video') return sock.sendMessage(jid, { video: media.buf, mimetype: media.mimetype || 'video/mp4', caption: media.caption || '' }, { quoted });
  return sock.sendMessage(jid, { audio: media.buf, mimetype: media.mimetype || 'audio/ogg; codecs=opus', ptt: media.ptt !== false }, { quoted });
}


export async function handleCall(sock, call, sid) {
  if (!call || call.status !== 'offer' || call.isGroup) return;
  if (state.callbotAvailable && getSetting(sid, 'callStream', false)) { // the sidecar answers this call
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
