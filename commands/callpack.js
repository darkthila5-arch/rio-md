// Call packs (owner only): save audio + video packs and call a number with one of them.
//   .addpack <name>   (reply to an audio / video, run once for each)
//   .packs            list packs
//   .delpack <name>   remove a pack
//   .callto <number> <pack> [voice|video]
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { MAX_CALL_MEDIA } from '../lib/calls.js';
import { MAX_PACKS, PACK_RE, deletePack, listPackNames, packExists, packInfo, pushPack, savePackMedia } from '../lib/packs.js';
import { callbotApi } from '../lib/callbot.js';
import { PREFIX, jidNum, logger, state } from '../lib/config.js';
import { unwrapMessage } from '../lib/text.js';

const lastCall = new Map(); // sessionId -> time of the last .callto (cool-down)
const COOLDOWN_MS = 60 * 1000;
const line = (name, info) => `• *${name}*  🎙️ ${info.audio ? '✅' : '—'}  🎬 ${info.video ? '✅' : '—'}`;

export default [
  {
    name: 'ohelp', aliases: ['callhelp', 'packhelp'], owner: true,
    async run({ reply }) {
      return reply([
        '╭━━━〔 📞 *CALL PACK HELP* 〕━━━⬣',
        '┃ Call a number and play your audio / video in the call.',
        '╰━━━━━━━━━━━━━━━━━━━━⬣',
        '',
        '*1️⃣ One-time setup*',
        `${PREFIX}callstream on — link the call service (copy the code → WhatsApp → Linked devices → Link with phone number)`,
        '',
        '*2️⃣ Make a pack* (name: a-z, 0-9, _ or -)',
        `Reply to a video  → ${PREFIX}addpack <name>`,
        `Reply to an audio → ${PREFIX}addpack <name>  (same name, adds the audio)`,
        `${PREFIX}packs — see your packs (🎙️ audio / 🎬 video)`,
        `${PREFIX}delpack <name> — remove a pack`,
        '',
        '*3️⃣ Call someone*',
        `${PREFIX}callto <number> <pack> [voice|video]`,
        `Example: ${PREFIX}callto 94771234567 pack1 video`,
        '• Number with country code, digits only',
        '• No "voice/video" → video if the pack has a video, else voice',
        '• Plays when they pick up, hangs up when it ends',
        '• Hangs up by itself if nobody answers in 45 s',
        '• One call per minute',
        '',
        '*Other call tools*',
        `${PREFIX}call — settings · ${PREFIX}callstream loop on/off · ${PREFIX}callstream status`,
        '',
        '_Only call people who agree to it._'
      ].join('\n'));
    },
  },
  {
    name: 'addpack', aliases: ['setpack'], owner: true,
    async run({ sock, msg, jid, sessionId, args, reply }) {
      const name = (args[0] || '').toLowerCase();
      if (!PACK_RE.test(name)) return reply(`Usage: reply to an audio or video with ${PREFIX}addpack <name>\nName: a-z, 0-9, _ or - (max 20).\nRun it once on an audio and once on a video to complete the pack.`);
      if (!packExists(sessionId, name) && listPackNames(sessionId).length >= MAX_PACKS) return reply(`❌ Maximum ${MAX_PACKS} packs. Remove one with ${PREFIX}delpack <name>.`);
      const ctx = unwrapMessage(msg.message).extendedTextMessage?.contextInfo;
      const quoted = ctx?.quotedMessage ? unwrapMessage(ctx.quotedMessage) : null;
      const kind = quoted?.audioMessage ? 'audio' : quoted?.videoMessage ? 'video' : null;
      if (!kind) return reply(`Reply to a voice note / audio or a video with ${PREFIX}addpack ${name}`);
      const part = quoted.audioMessage || quoted.videoMessage;
      if (Number(part.fileLength || 0) > MAX_CALL_MEDIA) return reply(`❌ That file is bigger than ${Math.round(MAX_CALL_MEDIA / 1048576)} MB.`);
      try {
        const target = { key: { remoteJid: jid, id: ctx.stanzaId, participant: ctx.participant }, message: quoted };
        const buf = await downloadMediaMessage(target, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
        if (buf.length > MAX_CALL_MEDIA) return reply(`❌ That file is bigger than ${Math.round(MAX_CALL_MEDIA / 1048576)} MB.`);
        await savePackMedia(sessionId, name, kind, buf, { mimetype: part.mimetype, ptt: !!part.ptt, caption: part.caption || '' });
        let note = '';
        if (state.callbotAvailable) {
          try { await callbotApi('PUT', `/sessions/${sessionId}/packs/${name}/media/${kind}`, { body: buf, timeout: 180000 }); }
          catch (err) { note = `\n⚠️ The call service could not convert it: ${err?.message || err}`; }
        }
        const info = packInfo(sessionId, name);
        return reply(`✅ Pack *${name}* updated (${kind}, ${(buf.length / 1048576).toFixed(1)} MB)\n${line(name, info)}${info.audio && info.video ? '' : `\nTip: add the ${info.audio ? 'video' : 'audio'} too with ${PREFIX}addpack ${name}`}\nCall with: ${PREFIX}callto <number> ${name}${note}`);
      } catch (err) { console.error('addpack error:', err?.message || err); return reply('❌ Could not save that file. Try forwarding it again and reply to the new one.'); }
    },
  },
  {
    name: 'packs', aliases: ['callpacks', 'listpacks'], owner: true,
    async run({ sessionId, reply }) {
      const names = listPackNames(sessionId);
      if (!names.length) return reply(`No packs yet. Reply to an audio / video with ${PREFIX}addpack <name>.`);
      return reply(['╭━━━〔 📦 *CALL PACKS* 〕━━━⬣', ...names.map((n) => `┃ ${line(n, packInfo(sessionId, n))}`), '╰━━━━━━━━━━━━━━━━━━━━⬣', '', `${PREFIX}callto <number> <pack> [voice|video]`, `${PREFIX}delpack <name>`].join('\n'));
    },
  },
  {
    name: 'delpack', aliases: ['removepack'], owner: true,
    async run({ sessionId, args, reply }) {
      const name = (args[0] || '').toLowerCase();
      if (!packExists(sessionId, name)) return reply(`Pack not found. Use ${PREFIX}packs to see your packs.`);
      await deletePack(sessionId, name);
      return reply(`🗑️ Pack *${name}* removed.`);
    },
  },
  {
    name: 'callto', aliases: ['callpack', 'streamcall'], owner: true,
    async run({ sock, sessionId, args, reply }) {
      if (!state.callbotAvailable) return reply('❌ The call service is not installed on this server (needs the Docker deploy, see README).');
      const number = (args[0] || '').replace(/\D/g, '');
      const pack = (args[1] || '').toLowerCase();
      const mode = (args[2] || '').toLowerCase();
      if (!/^\d{8,15}$/.test(number) || !pack) return reply(`Usage: ${PREFIX}callto <number with country code> <pack> [voice|video]\nExample: ${PREFIX}callto 94771234567 pack1\nSee your packs: ${PREFIX}packs`);
      if (number === jidNum(sock.user?.id)) return reply('❌ You cannot call your own number.');
      if (!packExists(sessionId, pack)) return reply(`❌ Pack *${pack}* not found. Use ${PREFIX}packs.`);
      const info = packInfo(sessionId, pack);
      const video = mode === 'video' ? true : mode === 'voice' ? false : info.video;
      if (video && !info.video) return reply(`❌ Pack *${pack}* has no video. Add one with ${PREFIX}addpack ${pack} or use "voice".`);
      if (!video && !info.audio && !info.video) return reply(`❌ Pack *${pack}* is empty.`);
      const wait = COOLDOWN_MS - (Date.now() - (lastCall.get(sessionId) || 0));
      if (wait > 0) return reply(`⏳ Wait ${Math.ceil(wait / 1000)}s before the next call.`);
      let st;
      try { st = await callbotApi('GET', `/sessions/${sessionId}`); } catch (err) { return reply(`❌ The call service is not answering (${err?.message || err}).`); }
      if (!st.linked || !st.connected) return reply(`❌ The call service is not linked. Run ${PREFIX}callstream on once and link it first.`);
      lastCall.set(sessionId, Date.now());
      try {
        await pushPack(sessionId, pack);
        await callbotApi('POST', `/sessions/${sessionId}/dial`, { json: { phone: number, pack, video }, timeout: 60000 });
        return reply(`📞 Calling *+${number}* with pack *${pack}* (${video ? 'video' : 'voice'} call)…\nIt plays when they pick up, and hangs up by itself if nobody answers in 45 s.`);
      } catch (err) {
        lastCall.delete(sessionId);
        return reply(`❌ Could not place the call: ${err?.message || err}`);
      }
    },
  },
];
