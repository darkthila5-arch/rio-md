// Group control: open / close chat, name, description, invite link, anti-link, welcome / goodbye messages.
import { BOT_NAME, PREFIX } from '../lib/config.js';
import { parseToggle } from '../lib/text.js';
import { DEFAULT_GOODBYE, DEFAULT_WELCOME, adminGuard, getGroupCfg, setGroupCfg } from '../lib/groups.js';

const onoff = (v) => (v ? '✅ ON' : '❌ OFF');

// .welcome / .goodbye share the same logic
function greeting(kind) {
  const on = `${kind}`, msgKey = `${kind}Msg`, def = kind === 'welcome' ? DEFAULT_WELCOME : DEFAULT_GOODBYE;
  return async (c) => {
    const g = await adminGuard(c, { botAdmin: false });
    if (!g) return;
    const cfg = getGroupCfg(c.sessionId, c.jid);
    const sub = (c.args[0] || '').toLowerCase();
    if (sub === 'set') {
      const text = c.args.slice(1).join(' ').trim();
      if (!text) return c.reply(`Usage: ${PREFIX}${kind} set <text>\nPlaceholders: {user} {group} {count} {desc}\nExample: ${PREFIX}${kind} set Hi {user}, welcome to {group}!`);
      setGroupCfg(c.sessionId, c.jid, { [msgKey]: text.slice(0, 500), [on]: true });
      return c.reply(`✅ ${kind} message saved and turned *ON*.`);
    }
    if (sub === 'reset') { setGroupCfg(c.sessionId, c.jid, { [msgKey]: '' }); return c.reply(`✅ ${kind} message reset to the default.`); }
    const v = parseToggle(sub);
    if (v === null) return c.reply(`${kind === 'welcome' ? '👋' : '🚪'} *${kind}* is ${onoff(cfg[on])}\n\nMessage:\n${cfg[msgKey] || def}\n\n${PREFIX}${kind} on / off\n${PREFIX}${kind} set <text>  ({user} {group} {count} {desc})\n${PREFIX}${kind} reset`);
    setGroupCfg(c.sessionId, c.jid, { [on]: v });
    return c.reply(`✅ ${kind} message: *${v ? 'ON' : 'OFF'}*`);
  };
}

export default [
  {
    name: 'grouphelp', aliases: ['ghelp'],
    async run({ reply }) {
      const p = PREFIX;
      return reply([
        '╭━━━〔 👥 *GROUP COMMANDS* 〕━━━⬣',
        '┃ For group admins (I must be admin too)',
        '╰━━━━━━━━━━━━━━━━━━━━⬣',
        '',
        '*👮 Admin*',
        `${p}kick @user · ${p}add <number>`,
        `${p}promote @user · ${p}demote @user`,
        `${p}warn @user · ${p}resetwarn @user (3 warns = removed)`,
        `${p}tagall <text> · ${p}hidetag <text>`,
        `${p}del (reply to a message)`,
        '',
        '*⚙️ Control*',
        `${p}group open / close  (${p}mute · ${p}unmute)`,
        `${p}setname <text> · ${p}setdesc <text>`,
        `${p}link · ${p}revoke (reset the invite link)`,
        `${p}antilink off / on / all`,
        `${p}gsettings — show this group's settings`,
        '',
        '*👋 Welcome / Goodbye*',
        `${p}welcome on/off/set <text>/reset`,
        `${p}goodbye on/off/set <text>/reset`,
        '_Placeholders: {user} {group} {count} {desc}_',
        '',
        `${p}groupinfo · ${p}admins`
      ].join('\n'));
    },
  },
  {
    name: 'group', aliases: ['gc'],
    async run(c) {
      const g = await adminGuard(c);
      if (!g) return;
      const sub = (c.args[0] || '').toLowerCase();
      if (!['open', 'close'].includes(sub)) return c.reply(`Usage: ${PREFIX}group open  or  ${PREFIX}group close`);
      await c.sock.groupSettingUpdate(c.jid, sub === 'close' ? 'announcement' : 'not_announcement');
      return c.reply(sub === 'close' ? '🔒 Group closed: only admins can send messages.' : '🔓 Group opened: everyone can send messages.');
    },
  },
  {
    name: 'mute', aliases: ['unmute'],
    async run(c) {
      const g = await adminGuard(c);
      if (!g) return;
      const close = c.command === 'mute';
      await c.sock.groupSettingUpdate(c.jid, close ? 'announcement' : 'not_announcement');
      return c.reply(close ? '🔒 Group closed: only admins can send messages.' : '🔓 Group opened: everyone can send messages.');
    },
  },
  {
    name: 'setname',
    async run(c) {
      const g = await adminGuard(c);
      if (!g) return;
      const text = c.args.join(' ').trim();
      if (!text) return c.reply(`Usage: ${PREFIX}setname <new group name>`);
      await c.sock.groupUpdateSubject(c.jid, text.slice(0, 100));
      return c.reply('✅ Group name updated.');
    },
  },
  {
    name: 'setdesc',
    async run(c) {
      const g = await adminGuard(c);
      if (!g) return;
      const text = c.args.join(' ').trim();
      if (!text) return c.reply(`Usage: ${PREFIX}setdesc <new description>`);
      await c.sock.groupUpdateDescription(c.jid, text.slice(0, 500));
      return c.reply('✅ Group description updated.');
    },
  },
  {
    name: 'link', aliases: ['invite'],
    async run(c) {
      const g = await adminGuard(c);
      if (!g) return;
      const code = await c.sock.groupInviteCode(c.jid);
      return c.reply(`🔗 *${g.meta.subject}*\nhttps://chat.whatsapp.com/${code}`);
    },
  },
  {
    name: 'revoke', aliases: ['resetlink'],
    async run(c) {
      const g = await adminGuard(c);
      if (!g) return;
      const code = await c.sock.groupRevokeInvite(c.jid);
      return c.reply(`♻️ Invite link reset. New link:\nhttps://chat.whatsapp.com/${code}`);
    },
  },
  {
    name: 'antilink',
    async run(c) {
      const g = await adminGuard(c, { botAdmin: false });
      if (!g) return;
      const sub = (c.args[0] || '').toLowerCase();
      const map = { on: 'wa', wa: 'wa', all: 'all', off: 'off' };
      if (!map[sub]) {
        const m = getGroupCfg(c.sessionId, c.jid).antilink;
        return c.reply(`🔗 Anti-link: *${m === 'wa' ? 'ON (group invite links)' : m === 'all' ? 'ON (all links)' : 'OFF'}*\n\n${PREFIX}antilink on — delete WhatsApp group links\n${PREFIX}antilink all — delete every link\n${PREFIX}antilink off\n\n_Admins are never affected. I must be a group admin to delete messages._`);
      }
      setGroupCfg(c.sessionId, c.jid, { antilink: map[sub] });
      return c.reply(`✅ Anti-link: *${map[sub] === 'off' ? 'OFF' : map[sub] === 'all' ? 'ON (all links)' : 'ON (group invite links)'}*${map[sub] !== 'off' && !g.botIsAdmin ? '\n⚠️ I am not an admin yet, so I cannot delete messages.' : ''}`);
    },
  },
  { name: 'welcome', run: greeting('welcome') },
  { name: 'goodbye', aliases: ['bye'], run: greeting('goodbye') },
  {
    name: 'gsettings', aliases: ['groupsettings'],
    async run(c) {
      if (!c.jid.endsWith('@g.us')) return c.reply('👥 This command only works in groups.');
      const cfg = getGroupCfg(c.sessionId, c.jid);
      return c.reply([
        `╭━━━〔 ⚙️ *GROUP SETTINGS* 〕━━━⬣`,
        `┃ 👋 Welcome  : ${onoff(cfg.welcome)}`,
        `┃ 🚪 Goodbye  : ${onoff(cfg.goodbye)}`,
        `┃ 🔗 Anti-link: ${cfg.antilink === 'off' ? '❌ OFF' : cfg.antilink === 'all' ? '✅ all links' : '✅ group links'}`,
        '╰━━━━━━━━━━━━━━━━━━━━⬣',
        `${PREFIX}grouphelp — all group commands`
      ].join('\n'));
    },
  },
  {
    name: 'admins', aliases: ['listadmin'],
    async run(c) {
      if (!c.jid.endsWith('@g.us')) return c.reply('👥 This command only works in groups.');
      const meta = await c.sock.groupMetadata(c.jid);
      const list = meta.participants.filter((p) => p.admin);
      const ids = list.map((p) => p.id);
      return c.sock.sendMessage(c.jid, { text: `👮 *Admins of ${meta.subject}*\n\n${list.map((p, i) => `${i + 1}. @${String(p.id).split('@')[0].split(':')[0]}${p.admin === 'superadmin' ? ' 👑' : ''}`).join('\n')}\n\n> ${BOT_NAME}`, mentions: ids }, { quoted: c.msg });
    },
  },
];
