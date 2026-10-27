// Group admin commands: kick, add, promote, demote, warn, tagall, hidetag, delete a message.
// They work for group admins (and the bot owner). The bot itself must be a group admin for kick / add / promote / demote.
import { PREFIX, jidNum } from '../lib/config.js';
import { adminGuard, getGroupCfg, setGroupCfg } from '../lib/groups.js';
import { say } from '../lib/card.js';
import { unwrapMessage } from '../lib/text.js';

const MAX_WARNS = 3;
const tag = (jid) => `@${jidNum(jid)}`;
const ctxOf = (msg) => unwrapMessage(msg.message).extendedTextMessage?.contextInfo;

async function change(c, action, doneText) {
  const g = await adminGuard(c);
  if (!g) return;
  const target = c.targetJid();
  if (!target) return c.reply(`Mention or reply to the person, or type their number.\nExample: ${PREFIX}${c.command} @user`);
  if (jidNum(target) === jidNum(c.sock.user?.id)) return c.reply('😅 I cannot do that to myself.');
  try {
    const res = await c.sock.groupParticipantsUpdate(c.jid, [target], action);
    const status = String(res?.[0]?.status || '200');
    if (status !== '200') {
      const why = status === '403' ? 'their privacy settings do not allow it (send them the group link instead)' : status === '408' ? 'they recently left the group' : status === '409' ? 'they are already in the group' : `WhatsApp refused (code ${status})`;
      return c.reply(`❌ Could not do that: ${why}.`);
    }
    return say(c.sock, c.jid, `${doneText} ${tag(target)}`, c.msg, { mentions: [target] });
  } catch (err) { return c.reply(`❌ Failed: ${err?.message || err}`); }
}

export default [
  { name: 'kick', aliases: ['remove'], run: (c) => change(c, 'remove', '👢 Removed') },
  { name: 'add', run: async (c) => {
      const num = (c.args[0] || '').replace(/\D/g, '');
      if (num.length < 8) return c.reply(`Usage: ${PREFIX}add <number with country code>\nExample: ${PREFIX}add 94771234567`);
      c.args[0] = num; // targetJid() reads the number from the first argument
      c.targetJid = () => `${num}@s.whatsapp.net`;
      return change(c, 'add', '➕ Added');
  } },
  { name: 'promote', run: (c) => change(c, 'promote', '⬆️ Promoted to admin:') },
  { name: 'demote', run: (c) => change(c, 'demote', '⬇️ Demoted from admin:') },
  {
    name: 'tagall', aliases: ['everyone'],
    async run(c) {
      const g = await adminGuard(c, { botAdmin: false });
      if (!g) return;
      const ids = g.meta.participants.map((p) => p.id);
      const note = c.args.join(' ').trim();
      const lines = [`📢 *${note || 'Attention everyone!'}*`, '', ...ids.map((id) => `• ${tag(id)}`)];
      return say(c.sock, c.jid, lines.join('\n'), c.msg, { mentions: ids });
    },
  },
  {
    name: 'hidetag', aliases: ['tag'],
    async run(c) {
      const g = await adminGuard(c, { botAdmin: false });
      if (!g) return;
      const quoted = ctxOf(c.msg)?.quotedMessage ? unwrapMessage(ctxOf(c.msg).quotedMessage) : null;
      const text = c.args.join(' ').trim() || quoted?.conversation || quoted?.extendedTextMessage?.text || '';
      if (!text) return c.reply(`Usage: ${PREFIX}hidetag <text>  (or reply to a text message)`);
      return c.sock.sendMessage(c.jid, { text, mentions: g.meta.participants.map((p) => p.id) });
    },
  },
  {
    name: 'del', aliases: ['delete'],
    async run(c) {
      const g = await adminGuard(c);
      if (!g) return;
      const ctx = ctxOf(c.msg);
      if (!ctx?.stanzaId) return c.reply(`Reply to the message you want to delete with ${PREFIX}del`);
      const mine = jidNum(ctx.participant) === jidNum(c.sock.user?.id);
      try { await c.sock.sendMessage(c.jid, { delete: { remoteJid: c.jid, fromMe: mine, id: ctx.stanzaId, participant: ctx.participant } }); }
      catch (err) { return c.reply(`❌ Could not delete: ${err?.message || err}`); }
    },
  },
  {
    name: 'warn',
    async run(c) {
      const g = await adminGuard(c);
      if (!g) return;
      const target = c.targetJid();
      if (!target) return c.reply(`Mention or reply to the person: ${PREFIX}warn @user <reason>`);
      const key = jidNum(target);
      const warns = { ...getGroupCfg(c.sessionId, c.jid).warns };
      warns[key] = (warns[key] || 0) + 1;
      if (warns[key] >= MAX_WARNS) {
        delete warns[key];
        setGroupCfg(c.sessionId, c.jid, { warns });
        try { await c.sock.groupParticipantsUpdate(c.jid, [target], 'remove'); }
        catch (err) { return c.reply(`⚠️ ${MAX_WARNS}/${MAX_WARNS} warnings but I could not remove them: ${err?.message || err}`); }
        return say(c.sock, c.jid, `🚫 ${tag(target)} reached ${MAX_WARNS} warnings and was removed.`, c.msg, { mentions: [target] });
      }
      setGroupCfg(c.sessionId, c.jid, { warns });
      return say(c.sock, c.jid, `⚠️ Warning ${warns[key]}/${MAX_WARNS} for ${tag(target)}.\nAt ${MAX_WARNS} warnings the member is removed.`, c.msg, { mentions: [target] });
    },
  },
  {
    name: 'resetwarn',
    async run(c) {
      const g = await adminGuard(c, { botAdmin: false });
      if (!g) return;
      const target = c.targetJid();
      if (!target) return c.reply(`Mention or reply to the person: ${PREFIX}resetwarn @user`);
      const warns = { ...getGroupCfg(c.sessionId, c.jid).warns };
      delete warns[jidNum(target)];
      setGroupCfg(c.sessionId, c.jid, { warns });
      return say(c.sock, c.jid, `✅ Warnings cleared for ${tag(target)}.`, c.msg, { mentions: [target] });
    },
  },
];
