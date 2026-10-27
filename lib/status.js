import { isJidGroup, downloadMediaMessage, jidNormalizedUser } from '@whiskeysockets/baileys';
import { jidNum, logger, sleep } from './config.js';
import { getSetting } from './storage.js';
import { react } from './card.js';


/* ---------- status tools (auto view / react / save) and view-once recovery ---------- */
export const DEFAULT_STATUS_EMOJIS = ['❤️', '🔥', '😍', '👏', '💯', '🥰'];
export const STATUS_TOGGLES = {
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
export function extractEmojis(text) {
  const found = String(text || '').match(/(?:\p{Regional_Indicator}{2})|(?:[#*0-9]️?⃣)|(?:\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})?(?:‍\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})?)*)/gu);
  return [...new Set(found || [])].slice(0, 20);
}

// Finds image / video / audio inside any wrapper (ephemeral, view-once ...). `viewOnce` tells if it was a view-once message.
export function findMedia(message) {
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

export async function downloadPart(sock, target, part) {
  if (Number(part?.fileLength || 0) > MAX_SAVE_BYTES) throw new Error('TOO_BIG');
  const buf = await downloadMediaMessage(target, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
  if (buf.length > MAX_SAVE_BYTES) throw new Error('TOO_BIG');
  return buf;
}
export async function sendMedia(sock, to, kind, part, buf, caption) {
  if (kind === 'image') return sock.sendMessage(to, { image: buf, caption });
  if (kind === 'video') return sock.sendMessage(to, { video: buf, mimetype: part.mimetype || 'video/mp4', caption });
  await sock.sendMessage(to, { audio: buf, mimetype: part.mimetype || 'audio/ogg; codecs=opus', ptt: !!part.ptt });
  if (caption) await sock.sendMessage(to, { text: caption });
}

export const statusDebug = new Map(); // sid -> what happened with the latest status (shown in .autostatus)
function noteStatus(sid, patch) { statusDebug.set(sid, { ...(statusDebug.get(sid) || {}), ...patch }); }

export async function handleStatus(sock, msg, sid) {
  if (!msg.message || msg.key.fromMe) return;
  const seen = getSetting(sid, 'statusSeen', false), react = getSetting(sid, 'statusReact', false), save = getSetting(sid, 'statusSave', false);
  const raw = msg.message;
  const poster = msg.key.participant || msg.participant;
  if (!poster || raw.protocolMessage || raw.reactionMessage) return;
  if (!firstTime(`st:${msg.key.id}`)) return;
  const ts = Number(msg.messageTimestamp || 0);
  const age = ts ? Date.now() / 1000 - ts : 0;
  const steps = [];
  noteStatus(sid, { at: Date.now(), from: jidNum(poster), steps, error: null, on: { seen, react, save } });
  if (!seen && !react && !save) { steps.push('all status switches are OFF'); return; }
  if (age > 24 * 3600) { steps.push('older than 24h, skipped'); return; }
  const me = jidNormalizedUser(sock.user?.id);
  // newer WhatsApp versions may give a @lid id: also pass the phone-number id when WhatsApp tells us
  const alt = msg.key.participantAlt || msg.key.participantPn || null;
  const audience = [...new Set([poster, alt, me].filter(Boolean))];

  if (seen || react) {
    try { await sock.readMessages([msg.key]); steps.push('viewed'); }
    catch (err) { console.error('Status view error:', err?.message || err); steps.push('view failed'); noteStatus(sid, { error: `view: ${err?.message || err}` }); }
  }
  if (react) {
    if (age >= 30 * 60) steps.push('too old to react (over 30 min)');
    else {
      const list = getSetting(sid, 'statusEmojis', null);
      const pool = Array.isArray(list) && list.length ? list : DEFAULT_STATUS_EMOJIS;
      const emoji = pool[Math.floor(Math.random() * pool.length)];
      await sleep(1500 + Math.random() * 3500); // a short human-like pause
      let done = false, lastErr = null;
      for (const jids of [audience, [poster, me]]) { // second try with the plain list
        try { await sock.sendMessage('status@broadcast', { react: { text: emoji, key: msg.key } }, { statusJidList: jids }); done = true; break; }
        catch (err) { lastErr = err; }
      }
      if (done) steps.push(`reacted ${emoji}`);
      else { console.error('Status react error:', lastErr?.message || lastErr); steps.push('react failed'); noteStatus(sid, { error: `react: ${lastErr?.message || lastErr}` }); }
    }
  }
  if (save) {
    if (age >= 6 * 3600) steps.push('too old to save (over 6h)');
    else {
      const head = `📥 *Status* from @${jidNum(poster)}${msg.pushName ? ` (${msg.pushName})` : ''}`;
      const found = findMedia(raw);
      try {
        if (found.kind) {
          const buf = await downloadPart(sock, msg, found.part);
          await sendMedia(sock, me, found.kind, found.part, buf, `${head}${found.part.caption ? `\n\n${found.part.caption}` : ''}`);
          steps.push('saved');
        } else if (found.text) {
          await sock.sendMessage(me, { text: `${head}\n\n${found.text}`, mentions: [poster] });
          steps.push('saved (text)');
        } else steps.push('nothing to save');
      } catch (err) { console.error('Status save error:', err?.message || err); steps.push('save failed'); noteStatus(sid, { error: `save: ${err?.message || err}` }); }
    }
  }
  console.log(`[status] ${jidNum(poster)}: ${steps.join(', ')}`);
}

// Sends a copy of every incoming view-once photo / video / voice note to the owner's own chat.
export async function handleViewOnce(sock, msg, sid) {
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
