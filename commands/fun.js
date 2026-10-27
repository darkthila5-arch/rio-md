// Fun commands (all work offline, no external APIs). Send .funmenu to see them.
import { PREFIX, jidNum } from '../lib/config.js';
import { say } from '../lib/card.js';
import { unwrapMessage } from '../lib/text.js';

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const mentionsOf = (msg) => unwrapMessage(msg.message).extendedTextMessage?.contextInfo?.mentionedJid || [];
const quotedUser = (msg) => unwrapMessage(msg.message).extendedTextMessage?.contextInfo?.participant;
const tag = (jid) => `@${jidNum(jid)}`;
const hash = (s) => [...String(s)].reduce((h, ch) => (h * 31 + ch.codePointAt(0)) >>> 0, 7);

const JOKES = [
  'Why do programmers prefer dark mode? Because light attracts bugs. 🐛',
  'I told my phone I needed space. Now it only shows "Storage almost full". 📱',
  'Why did the scarecrow win an award? He was outstanding in his field. 🌾',
  'I would tell you a UDP joke, but you might not get it. 📡',
  'My WiFi and I have a lot in common: we both disconnect when things get serious. 📶',
  'Why was the math book sad? It had too many problems. 📚',
  'I asked the bot for a joke. It said: "Your sleep schedule." 😴',
  'Why did the developer go broke? He used up all his cache. 💸',
  'What do you call a fake noodle? An impasta. 🍝',
  'There are 10 kinds of people: those who understand binary and those who do not. 🔢'
];
const FACTS = [
  'Honey never spoils. Edible honey was found in ancient Egyptian tombs. 🍯',
  'Octopuses have three hearts and blue blood. 🐙',
  'Sri Lanka is home to the world\'s largest land animal on the island: the Asian elephant. 🐘',
  'A day on Venus is longer than a year on Venus. 🪐',
  'Bananas are slightly radioactive because of their potassium. 🍌',
  'Sharks existed before trees. 🦈',
  'The Eiffel Tower grows a few centimetres taller in summer heat. 🗼',
  'A group of flamingos is called a flamboyance. 🦩',
  'Your brain uses about 20% of your body\'s energy. 🧠',
  'Lightning is about five times hotter than the surface of the Sun. ⚡'
];
const QUOTES = [
  '"It always seems impossible until it is done." — Nelson Mandela',
  '"Dream big, start small, but start." — Unknown',
  '"The best time to plant a tree was 20 years ago. The second best time is now." — Proverb',
  '"Do something today that your future self will thank you for." — Unknown',
  '"Success is the sum of small efforts repeated day in and day out." — Robert Collier',
  '"Don\'t watch the clock; do what it does. Keep going." — Sam Levenson',
  '"Fall seven times, stand up eight." — Japanese proverb',
  '"Believe you can and you are halfway there." — Theodore Roosevelt'
];
const BALL = ['Yes, definitely! ✅', 'It is certain. ✅', 'Most likely. 👍', 'Signs point to yes. 👍', 'Ask again later. 🤔', 'Cannot predict now. 🔮', 'Do not count on it. 👎', 'My answer is no. ❌', 'Very doubtful. ❌', 'Absolutely not! 🚫'];
const TRUTHS = [
  'What is the most embarrassing thing you have done in public?',
  'What is a secret talent nobody knows about?',
  'Who was your first crush?',
  'What is the last lie you told?',
  'What is your biggest fear?',
  'What is the weirdest thing you have ever eaten?',
  'Which app do you use the most when you should be doing something else?',
  'What is one habit you wish you could quit?'
];
const DARES = [
  'Send a voice note singing the first song that comes to mind. 🎤',
  'Change your WhatsApp status to "I love homework" for 1 hour. 📝',
  'Send your last emoji used 10 times in this chat.',
  'Talk only in emojis for the next 5 minutes. 😎',
  'Send a selfie making the silliest face you can. 🤪',
  'Tell the group your most-played song right now. 🎧',
  'Compliment every person who replies in the next 5 minutes. 💬',
  'Write a two-line poem about the person above you. ✍️'
];
const WYR = [
  'Would you rather be able to fly or be invisible?',
  'Would you rather never use social media again or never watch a movie again?',
  'Would you rather have unlimited data or unlimited battery?',
  'Would you rather speak every language or play every instrument?',
  'Would you rather live in the past or in the future?',
  'Would you rather always be 10 minutes late or always be 20 minutes early?'
];
const HUGS = ['gives a big warm hug to', 'hugs tightly', 'sends virtual hugs to'];
const SLAPS = ['playfully slaps', 'throws a pillow at', 'gently boops'];

function calc(expr) {
  const clean = String(expr || '').replace(/\s+/g, '').replace(/\^/g, '**').replace(/x/gi, '*');
  if (!clean || clean.length > 80 || !/^[0-9+\-*/().%*]+$/.test(clean)) return null;
  try {
    const v = Function(`"use strict"; return (${clean});`)();
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  } catch { return null; }
}

export default [
  {
    name: 'funmenu', aliases: ['fun'],
    async run({ reply }) {
      const p = PREFIX;
      return reply([
        '╭━━━〔 🎉 *FUN MENU* 〕━━━⬣',
        `┃ ${p}joke · ${p}fact · ${p}quote`,
        `┃ ${p}8ball <question>`,
        `┃ ${p}dice · ${p}coin · ${p}rps <rock/paper/scissors>`,
        `┃ ${p}pick a, b, c`,
        `┃ ${p}rate <anything>`,
        `┃ ${p}ship @user1 @user2`,
        `┃ ${p}truth · ${p}dare · ${p}wyr`,
        `┃ ${p}hug @user · ${p}slap @user`,
        `┃ ${p}reverse <text> · ${p}mock <text> · ${p}clap <text>`,
        `┃ ${p}calc <math>  e.g. ${p}calc 25*4+10`,
        `┃ ${p}password <length>`,
        '╰━━━━━━━━━━━━━━━━━━━━⬣'
      ].join('\n'));
    },
  },
  { name: 'joke', async run({ reply }) { return reply(`😂 ${pick(JOKES)}`); } },
  { name: 'fact', async run({ reply }) { return reply(`🧠 *Did you know?*\n${pick(FACTS)}`); } },
  { name: 'quote', async run({ reply }) { return reply(`💬 ${pick(QUOTES)}`); } },
  {
    name: '8ball', aliases: ['eightball'],
    async run({ args, reply }) {
      if (!args.length) return reply(`🎱 Ask a question: ${PREFIX}8ball will I pass the exam?`);
      return reply(`🎱 *${args.join(' ')}*\n\n${pick(BALL)}`);
    },
  },
  { name: 'dice', aliases: ['roll'], async run({ reply }) { return reply(`🎲 You rolled a *${1 + Math.floor(Math.random() * 6)}*`); } },
  { name: 'coin', aliases: ['flip'], async run({ reply }) { return reply(`🪙 ${Math.random() < 0.5 ? '*Heads*' : '*Tails*'}`); } },
  {
    name: 'rps',
    async run({ args, reply }) {
      const opts = ['rock', 'paper', 'scissors'];
      const me = (args[0] || '').toLowerCase();
      if (!opts.includes(me)) return reply(`Usage: ${PREFIX}rps rock | paper | scissors`);
      const bot = pick(opts);
      const emoji = { rock: '🪨', paper: '📄', scissors: '✂️' };
      const win = me === bot ? 'It is a draw! 🤝' : (me === 'rock' && bot === 'scissors') || (me === 'paper' && bot === 'rock') || (me === 'scissors' && bot === 'paper') ? 'You win! 🎉' : 'I win! 😎';
      return reply(`You: ${emoji[me]}  vs  Me: ${emoji[bot]}\n\n${win}`);
    },
  },
  {
    name: 'pick', aliases: ['choose'],
    async run({ args, reply }) {
      const items = args.join(' ').split(/[,|]/).map((s) => s.trim()).filter(Boolean);
      if (items.length < 2) return reply(`Usage: ${PREFIX}pick pizza, burger, rice`);
      return reply(`🤔 I choose: *${pick(items)}*`);
    },
  },
  {
    name: 'rate',
    async run({ args, reply }) {
      const what = args.join(' ').trim();
      if (!what) return reply(`Usage: ${PREFIX}rate <anything>`);
      return reply(`⭐ I rate *${what}*: *${hash(what.toLowerCase()) % 101}/100*`);
    },
  },
  {
    name: 'ship', aliases: ['love'],
    async run({ sock, msg, jid, args }) {
      const m = mentionsOf(msg);
      const a = m[0] || quotedUser(msg);
      const b = m[1] || (m[0] && quotedUser(msg) !== m[0] ? quotedUser(msg) : null);
      let nameA, nameB, mentions = [];
      if (a && b) { nameA = tag(a); nameB = tag(b); mentions = [a, b]; }
      else {
        const parts = args.join(' ').split(/\s*(?:\+|&|and|,)\s*/i).filter(Boolean);
        if (parts.length < 2) return say(sock, jid, `💞 Usage: ${PREFIX}ship @user1 @user2\nor ${PREFIX}ship Name1 + Name2`, msg);
        [nameA, nameB] = parts;
      }
      const pct = hash([nameA, nameB].map((s) => s.toLowerCase()).sort().join('|')) % 101;
      const bar = '█'.repeat(Math.round(pct / 10)).padEnd(10, '░');
      const verdict = pct > 80 ? 'Perfect match! 💍' : pct > 55 ? 'Looking good! 😍' : pct > 30 ? 'Maybe with some effort 🙂' : 'Just friends 😅';
      return say(sock, jid, `💘 *LOVE METER*\n${nameA} ❤️ ${nameB}\n\n[${bar}] *${pct}%*\n${verdict}`, msg, { mentions });
    },
  },
  { name: 'truth', async run({ reply }) { return reply(`🟢 *TRUTH*\n${pick(TRUTHS)}`); } },
  { name: 'dare', async run({ reply }) { return reply(`🔴 *DARE*\n${pick(DARES)}`); } },
  { name: 'wyr', aliases: ['wouldyourather'], async run({ reply }) { return reply(`🤷 *WOULD YOU RATHER*\n${pick(WYR)}`); } },
  {
    name: 'hug', aliases: ['slap'],
    async run({ sock, msg, jid, command, name, targetJid }) {
      const target = targetJid();
      if (!target) return say(sock, jid, `Mention or reply to someone: ${PREFIX}${command} @user`, msg);
      const text = command === 'hug' ? `🤗 *${name}* ${pick(HUGS)} ${tag(target)}` : `👋 *${name}* ${pick(SLAPS)} ${tag(target)}`;
      return say(sock, jid, text, msg, { mentions: [target] });
    },
  },
  {
    name: 'reverse',
    async run({ args, reply }) {
      const t = args.join(' ');
      return t ? reply([...t].reverse().join('')) : reply(`Usage: ${PREFIX}reverse <text>`);
    },
  },
  {
    name: 'mock',
    async run({ args, reply }) {
      const t = args.join(' ');
      if (!t) return reply(`Usage: ${PREFIX}mock <text>`);
      let i = 0;
      return reply([...t].map((ch) => (/[a-z]/i.test(ch) ? (i++ % 2 ? ch.toUpperCase() : ch.toLowerCase()) : ch)).join(''));
    },
  },
  {
    name: 'clap',
    async run({ args, reply }) {
      return args.length ? reply(`👏 ${args.join(' 👏 ')} 👏`) : reply(`Usage: ${PREFIX}clap <text>`);
    },
  },
  {
    name: 'calc', aliases: ['math'],
    async run({ args, reply }) {
      const expr = args.join(' ');
      if (!expr) return reply(`Usage: ${PREFIX}calc 25*4+10`);
      const v = calc(expr);
      return v === null ? reply('❌ I can only calculate numbers with + - * / % ^ and ( ).') : reply(`🧮 ${expr} = *${Number(v.toPrecision(12))}*`);
    },
  },
  {
    name: 'password', aliases: ['genpass'],
    async run({ args, reply }) {
      const len = Math.min(32, Math.max(6, Number(args[0]) || 12));
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%&*?';
      let out = '';
      for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
      return reply(`🔐 Random password (${len}):\n\n\`${out}\`\n\n_Save it somewhere safe. Never share your real passwords with a bot._`);
    },
  },
];
