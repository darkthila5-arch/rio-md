// Owner-only commands: mode, broadcast, block, join, leave, bio, profile picture, restart.
// Add a new command by adding one more object to this array (or create a new file in commands/).
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { getMode, setMode } from '../lib/storage.js';
import { BOT_NAME, PREFIX, jidNum, logger, sleep } from '../lib/config.js';
import { resetBotDp, say } from '../lib/card.js';
import { unwrapMessage } from '../lib/text.js';

export default [
  {
    name: 'mode', owner: true,
    async run({ sessionId, args, reply }) {
        const m = (args[0] || '').toLowerCase();
        if (m !== 'public' && m !== 'private') return reply(`⚙️ Current mode: *${getMode(sessionId)}*\nUse ${PREFIX}mode public or ${PREFIX}mode private\n(private = only the owner can use the bot)`);
        setMode(sessionId, m);
        return reply(`✅ Mode changed to *${m}*.`);
    },
  },
  {
    name: 'broadcast', aliases: ['bc'], owner: true,
    async run({ sock, args, reply }) {
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
    },
  },
  {
    name: 'block', aliases: ['unblock'], owner: true,
    async run({ sock, msg, jid, command, reply, targetJid }) {
        const target = targetJid();
        if (!target) return reply(`Usage: ${PREFIX}${command} <number> (or reply to / @mention the user)`);
        if (jidNum(target) === jidNum(sock.user?.id)) return reply("❌ I can't do that to myself.");
        await sock.updateBlockStatus(target, command);
        return say(sock, jid, `✅ ${command === 'block' ? 'Blocked' : 'Unblocked'} @${jidNum(target)}`, msg, { mentions: [target] });
    },
  },
  {
    name: 'join', owner: true,
    async run({ sock, args, reply }) {
        const code = (args[0] || '').match(/chat\.whatsapp\.com\/([A-Za-z0-9]+)/)?.[1];
        if (!code) return reply(`Usage: ${PREFIX}join https://chat.whatsapp.com/xxxx`);
        try { await sock.groupAcceptInvite(code); return reply('✅ Joined the group.'); }
        catch (err) { console.error('Join error:', err?.message || err); return reply('❌ Could not join (link expired, revoked, or group needs approval).'); }
    },
  },
  {
    name: 'leave', owner: true,
    async run({ sock, jid, command, reply }) {
        if (!jid.endsWith('@g.us')) return reply('This command only works in groups.');
        await reply('👋 Leaving this group. Bye!');
        return sock.groupLeave(jid);
    },
  },
  {
    name: 'setbio', owner: true,
    async run({ sock, args, reply }) {
        const bio = args.join(' ').trim();
        if (!bio) return reply(`Usage: ${PREFIX}setbio <text>`);
        await sock.updateProfileStatus(bio.slice(0, 139));
        return reply('✅ Bio updated.');
    },
  },
  {
    name: 'setpp', owner: true,
    async run({ sock, msg, jid, reply }) {
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
    },
  },
  {
    name: 'restart', owner: true,
    async run({ reply, isAdmin }) {
        if (!isAdmin) return reply('🚫 Restart works only for the main OWNER_NUMBER, because it restarts every linked session.');
        await reply('🔄 Restarting...');
        return setTimeout(() => process.exit(0), 1500); // Render / pm2 starts it again automatically
    },
  },
];
