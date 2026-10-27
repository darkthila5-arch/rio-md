// General commands: menus, alive, ping, runtime, about, owner contact, status.
// Add a new command by adding one more object to this array (or create a new file in commands/).
import { aliveButtons, aliveCaption, menuButtons, menuCaption, ownerMenuButtons, ownerMenuCaption, sendRich } from '../lib/menu.js';
import { BOT_NAME, OWNER_NUMBER, PREFIX, jidNum } from '../lib/config.js';
import { formatUptime, mem } from '../lib/text.js';

export default [
  {
    name: 'menu', aliases: ['help', 'list'],
    async run({ sock, msg, jid, name, footer }) {
        return sendRich(sock, jid, { caption: menuCaption(name), buttons: menuButtons(), footer }, msg);
    },
  },
  {
    name: 'momenu', aliases: ['ownermenu', 'omenu'], hidden: true,
    async run({ sock, msg, jid, name, footer }) {
        return sendRich(sock, jid, { caption: ownerMenuCaption(name), buttons: ownerMenuButtons(), footer: `${BOT_NAME} • Owner only` }, msg);
    },
  },
  {
    name: 'alive', aliases: ['bot'],
    async run({ sock, msg, jid, name, footer }) {
        return sendRich(sock, jid, { caption: aliveCaption(name), buttons: aliveButtons(), footer }, msg);
    },
  },
  {
    name: 'ping',
    async run({ sock, jid, reply }) {
        const started = Date.now();
        const sent = await reply('🏓 Pinging...');
        const ms = Date.now() - started;
        return sock.sendMessage(jid, { text: `🏓 *Pong!* ${ms} ms`, edit: sent.key });
    },
  },
  {
    name: 'runtime',
    async run({ reply }) {
        return reply(`⏱️ *Runtime:* ${formatUptime(process.uptime())}`);
    },
  },
  {
    name: 'about',
    async run({ reply }) {
        return reply(`🤖 *${BOT_NAME}*\nA multi-session WhatsApp MD bot.\nSend ${PREFIX}menu to see all commands.`);
    },
  },
  {
    name: 'owner', aliases: ['creator'],
    async run({ sock, msg, jid, reply }) {
        const num = OWNER_NUMBER || jidNum(sock.user?.id); // falls back to the linked account when OWNER_NUMBER is not set
        if (!num) return reply('👑 Owner contact is not set. Add OWNER_NUMBER in the environment variables.');
        const vcard = ['BEGIN:VCARD', 'VERSION:3.0', `FN:${BOT_NAME} Owner`, `ORG:${BOT_NAME};`, `TEL;type=CELL;type=VOICE;waid=${num}:+${num}`, 'END:VCARD'].join('\n');
        await sock.sendMessage(jid, { contacts: { displayName: `${BOT_NAME} Owner`, contacts: [{ vcard }] } }, { quoted: msg });
        return reply(`👑 *Owner:* https://wa.me/${num}`);
    },
  },
  {
    name: 'status',
    async run({ reply }) {
        return reply(`✅ *${BOT_NAME}*\nStatus: connected\nUptime: ${formatUptime(process.uptime())}\nRAM: ${mem()}`);
    },
  },
];
