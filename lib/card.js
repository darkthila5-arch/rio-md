import { BOT_NAME, CARD_URL, MENU_IMAGE, OWNER_NUMBER, jidNum } from './config.js';
import { pinterest } from './downloader.js';

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
export function resetBotDp(sock) { dpCache.delete(sock); }

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
export async function say(sock, jid, text, quoted, extra = {}) {
  let contextInfo;
  try { contextInfo = await cardContext(sock); } catch { /* send without the card */ }
  return sock.sendMessage(jid, { text, ...extra, ...(contextInfo ? { contextInfo } : {}) }, { quoted });
}

/* ---------- emoji reactions ---------- */
export const REACTIONS = {
  menu: '📜', help: '📜', list: '📜', alive: '💚', bot: '🤖', ping: '🏓', runtime: '⏱️', about: 'ℹ️', owner: '👑',
  tt: '🎵', tiktok: '🎵', fb: '📘', facebook: '📘', pin: '📌', pinterest: '📌', song: '🎶', play: '🎶', yt: '🎶', ytmp3: '🎶',
  dl: '📥', ytdl: '📥', dlcheck: '🔍', media: '🎨', sticker: '🎨', groupinfo: '👥', grouphelp: '👥', status: '📊',
  mode: '⚙️', broadcast: '📢', bc: '📢', block: '⛔', unblock: '✅', join: '🔗', leave: '🚪', setbio: '✍️', setpp: '🖼️', restart: '🔄',
  autostatus: '📲', statussettings: '📲', statusseen: '👀', autoseen: '👀', statusreact: '😍', autoreact: '😍', statussave: '💾', autosave: '💾', statusemoji: '🎭', viewonce: '👁️', antiviewonce: '👁️', vv: '👁️', save: '💾',
  momenu: '👑', ownermenu: '👑', omenu: '👑',
  call: '📞', callsettings: '📞', callstream: '📞', realcall: '📞', callreject: '📵', anticall: '📵', autoanswer: '🤖', callanswer: '🤖', setcallmsg: '✍️',
  setcallaudio: '🎙️', setcallvideo: '🎬', callpreview: '▶️', delcallmedia: '🗑️'
};
export async function react(sock, jid, key, emoji) {
  try { await sock.sendMessage(jid, { react: { text: emoji, key } }); }
  catch (err) { console.error('React error:', err?.message || err); }
}
