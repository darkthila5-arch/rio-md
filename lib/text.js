import { TIMEZONE } from './config.js';

export const parseToggle = (v) => (/^(on|enable|enabled|true|yes|1)$/i.test(v || '') ? true : /^(off|disable|disabled|false|no|0)$/i.test(v || '') ? false : null);

export function unwrapMessage(message) {
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
export function getText(msg) {
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
export function formatUptime(totalSeconds) {
  const d = Math.floor(totalSeconds / 86400);
  const h = Math.floor((totalSeconds % 86400) / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  return `${d ? d + 'd ' : ''}${h}h ${m}m ${s}s`;
}
export function greeting() {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: TIMEZONE }).format(new Date()));
  if (hour < 12) return 'Good Morning ☀️';
  if (hour < 17) return 'Good Afternoon 🌤️';
  if (hour < 21) return 'Good Evening 🌇';
  return 'Good Night 🌙';
}
export function nowStrings() {
  const now = new Date();
  return {
    date: new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: TIMEZONE }).format(now),
    time: new Intl.DateTimeFormat('en-GB', { timeStyle: 'short', hour12: true, timeZone: TIMEZONE }).format(now)
  };
}
export function mem() { return `${Math.round(process.memoryUsage().rss / 1048576)} MB`; }
