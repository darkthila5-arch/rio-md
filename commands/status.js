// Status tools and view-once recovery.
// Add a new command by adding one more object to this array (or create a new file in commands/).
import { jidNormalizedUser } from '@whiskeysockets/baileys';
import { getSetting, setSetting } from '../lib/storage.js';
import { DEFAULT_STATUS_EMOJIS, STATUS_TOGGLES, downloadPart, extractEmojis, findMedia, sendMedia, statusDebug } from '../lib/status.js';
import { PREFIX } from '../lib/config.js';
import { parseToggle, unwrapMessage } from '../lib/text.js';

export default [
  {
    name: 'autostatus', aliases: ['statussettings'], owner: true,
    async run({ sessionId, reply }) {
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
          (() => {
            const d = statusDebug.get(sessionId);
            if (!d) return '📡 No status has reached the bot yet since it started. (Statuses only arrive while the bot is online.)';
            const mins = Math.max(0, Math.round((Date.now() - d.at) / 60000));
            return `📡 Last status: ${mins} min ago from ${d.from} → ${d.steps.join(', ') || '…'}${d.error ? `\n⚠️ ${d.error}` : ''}`;
          })(),
          '',
          `${PREFIX}statusseen on/off — view every status automatically`,
          `${PREFIX}statusreact on/off — react to statuses with a random emoji from your list`,
          `${PREFIX}statusemoji 😍 🔥 ❤️ — set your emojis (${PREFIX}statusemoji reset = default)`,
          `${PREFIX}statussave on/off — send every status to your own chat`,
          `${PREFIX}viewonce on/off — send a copy of every view-once photo / video / voice note to your own chat`,
          `${PREFIX}vv — reply to a view-once message to open it here`,
          `${PREFIX}save — reply to any photo / video / voice note to send it to your own chat`
        ].join('\n'));
    },
  },
  {
    name: 'statusseen', aliases: ['autoseen', 'statusreact', 'autoreact', 'statussave', 'autosave', 'viewonce', 'antiviewonce'], owner: true,
    async run({ sessionId, args, command, reply }) {
        const [key, label] = STATUS_TOGGLES[command];
        const v = parseToggle(args[0]);
        if (v === null) return reply(`${label} is *${getSetting(sessionId, key, false) ? 'ON' : 'OFF'}*.\nUse ${PREFIX}${command} on  or  ${PREFIX}${command} off`);
        setSetting(sessionId, key, v);
        return reply(`✅ ${label}: *${v ? 'ON' : 'OFF'}*`);
    },
  },
  {
    name: 'statusemoji', owner: true,
    async run({ sessionId, args, reply }) {
        if (/^reset$/i.test(args[0] || '')) { setSetting(sessionId, 'statusEmojis', null); return reply(`✅ Emojis reset: ${DEFAULT_STATUS_EMOJIS.join(' ')}`); }
        const list = extractEmojis(args.join(' '));
        if (!list.length) {
          const cur = getSetting(sessionId, 'statusEmojis', null);
          return reply(`🎭 Current emojis: ${(Array.isArray(cur) && cur.length ? cur : DEFAULT_STATUS_EMOJIS).join(' ')}\nSet your own: ${PREFIX}statusemoji 😍 🔥 ❤️ 👏\n(one is picked randomly for every status)`);
        }
        setSetting(sessionId, 'statusEmojis', list);
        return reply(`✅ Status react emojis: ${list.join(' ')}`);
    },
  },
  {
    name: 'vv', aliases: ['save'], owner: true,
    async run({ sock, msg, jid, command, reply }) {
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
    },
  },
];
