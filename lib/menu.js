import { proto, generateWAMessageFromContent, prepareWAMessageMedia, isJidGroup } from '@whiskeysockets/baileys';
import { formatUptime, greeting, mem, nowStrings } from './text.js';
import { BOT_NAME, MENU_IMAGE, OWNER_NUMBER, PREFIX, USE_BUTTONS } from './config.js';


export function aliveCaption(name) {
  const { date, time } = nowStrings();
  return [
    `╭━━━〔 💠 *${BOT_NAME}* 💠 〕━━━⬣`,
    `┃ ${greeting()}, *${name}*!`,
    '┃',
    '┃ ✅ *I am alive and running!*',
    `┃ ⏱️ Uptime  : ${formatUptime(process.uptime())}`,
    `┃ 🧠 RAM     : ${mem()}`,
    `┃ 📅 Date    : ${date}`,
    `┃ 🕒 Time    : ${time}`,
    `┃ 🔰 Prefix  : ${PREFIX}`,
    '╰━━━━━━━━━━━━━━━━━━━━⬣',
    '',
    `👇 Tap a button, or send *${PREFIX}menu*`
  ].join('\n');
}

export function menuCaption(name) {
  const p = PREFIX;
  const { date, time } = nowStrings();
  return [
    `╭━━━〔 💠 *${BOT_NAME}* 💠 〕━━━⬣`,
    `┃ 👋 Hi *${name}*, ${greeting()}`,
    `┃ 🔰 Prefix : ${p}`,
    `┃ ⏱️ Uptime : ${formatUptime(process.uptime())}`,
    `┃ 📅 ${date}  🕒 ${time}`,
    '╰━━━━━━━━━━━━━━━━━━━━⬣',
    '',
    '╭─❮ ⚙️ *GENERAL* ❯',
    `│ ✦ ${p}alive`,
    `│ ✦ ${p}ping`,
    `│ ✦ ${p}runtime`,
    `│ ✦ ${p}about`,
    `│ ✦ ${p}owner`,
    `│ ✦ ${p}status`,
    '╰──────────────⬣',
    '',
    '╭─❮ 📥 *DOWNLOAD* ❯',
    `│ ✦ ${p}tt <link>`,
    `│ ✦ ${p}fb <link>`,
    `│ ✦ ${p}pin <link>`,
    `│ ✦ ${p}song <name/link>`,
    '╰──────────────⬣',
    '',
    '╭─❮ 🎨 *MEDIA* ❯',
    `│ ✦ ${p}sticker`,
    `│ ✦ ${p}media`,
    '╰──────────────⬣',
    '',
    '╭─❮ 👥 *GROUP* ❯',
    `│ ✦ ${p}groupinfo`,
    `│ ✦ ${p}grouphelp`,
    '╰──────────────⬣',
    '',
    '╭─❮ 📲 *STATUS & VIEW-ONCE* ❯',
    `│ ✦ ${p}autostatus (settings)`,
    `│ ✦ ${p}statusseen <on/off>`,
    `│ ✦ ${p}statusreact <on/off>`,
    `│ ✦ ${p}statusemoji 😍 🔥 ❤️`,
    `│ ✦ ${p}statussave <on/off>`,
    `│ ✦ ${p}viewonce <on/off>`,
    `│ ✦ ${p}vv (reply to view-once)`,
    `│ ✦ ${p}save (reply to media)`,
    '╰──────────────⬣',
    '',
    `> ${BOT_NAME} • Powered by Rio Editz`
  ].join('\n');
}

// Owner-only menu (.momenu). Never shown in .menu.
export function ownerMenuCaption(name) {
  const p = PREFIX;
  const { date, time } = nowStrings();
  return [
    `╭━━━〔 👑 *${BOT_NAME} OWNER MENU* 👑 〕━━━⬣`,
    `┃ 👋 Hi *${name}*, ${greeting()}`,
    `┃ 🔰 Prefix : ${p}`,
    `┃ ⏱️ Uptime : ${formatUptime(process.uptime())}`,
    `┃ 📅 ${date}  🕒 ${time}`,
    '╰━━━━━━━━━━━━━━━━━━━━⬣',
    '',
    '╭─❮ 👑 *OWNER* ❯',
    `│ ✦ ${p}status`,
    `│ ✦ ${p}mode <public/private>`,
    `│ ✦ ${p}broadcast <text>`,
    `│ ✦ ${p}block / ${p}unblock`,
    `│ ✦ ${p}join <group link>`,
    `│ ✦ ${p}leave`,
    `│ ✦ ${p}setbio <text>`,
    `│ ✦ ${p}setpp (reply to image)`,
    `│ ✦ ${p}restart`,
    '╰──────────────⬣',
    '',
    '╭─❮ 📞 *CALL* ❯',
    `│ ✦ ${p}call (settings)`,
    `│ ✦ ${p}callstream <on/off>`,
    `│ ✦ ${p}callreject <on/off>`,
    `│ ✦ ${p}autoanswer <on/off>`,
    `│ ✦ ${p}setcallaudio (reply)`,
    `│ ✦ ${p}setcallvideo (reply)`,
    `│ ✦ ${p}setcallmsg <text>`,
    `│ ✦ ${p}callpreview`,
    `│ ✦ ${p}delcallmedia <audio/video>`,
    '╰──────────────⬣',
    '',
    `> ${BOT_NAME} • Owner only`
  ].join('\n');
}

/* ---------- button helpers ---------- */
export const qr = (text, id) => ({ name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: text, id }) });
const urlBtn = (text, url) => ({ name: 'cta_url', buttonParamsJson: JSON.stringify({ display_text: text, url, merchant_url: url }) });
const listBtn = (title, sections) => ({ name: 'single_select', buttonParamsJson: JSON.stringify({ title, sections }) });

export function menuButtons() {
  const p = PREFIX;
  const row = (title, description, id) => ({ header: '', title, description, id: `${p}${id}` });
  const buttons = [
    qr('🏓 Ping', `${p}ping`),
    qr('✅ Alive', `${p}alive`),
    listBtn('📂 Select Menu', [
      { title: '⚙️ GENERAL', rows: [
        row('Ping', 'Check bot speed', 'ping'),
        row('Runtime', 'How long the bot has been up', 'runtime'),
        row('About', 'About this bot', 'about'),
        row('Owner', 'Contact the owner', 'owner'),
        row('Status', 'Bot status', 'status')
      ] },
      { title: '📥 DOWNLOAD', rows: [
        row('TikTok', 'Use .tt <link>', 'tt'),
        row('Facebook', 'Use .fb <link>', 'fb'),
        row('Pinterest', 'Use .pin <link>', 'pin'),
        row('YouTube Song', 'Use .song <name or link>', 'song')
      ] },
      { title: '🎨 MEDIA', rows: [
        row('Sticker', 'Sticker help', 'sticker'),
        row('Media', 'Media command guide', 'media')
      ] },
      { title: '👥 GROUP', rows: [
        row('Group Info', 'Current group details', 'groupinfo'),
        row('Group Help', 'Group commands', 'grouphelp')
      ] },
      { title: '📲 STATUS & VIEW-ONCE', rows: [
        row('Status Settings', 'Show all status tools', 'autostatus'),
        row('Auto View', 'View statuses on/off', 'statusseen'),
        row('Auto React', 'React to statuses on/off', 'statusreact'),
        row('React Emojis', 'Set your emojis', 'statusemoji'),
        row('Auto Save', 'Save statuses on/off', 'statussave'),
        row('View-Once', 'Recover view-once on/off', 'viewonce')
      ] }
    ])
  ];
  if (OWNER_NUMBER) buttons.push(urlBtn('👑 Chat Owner', `https://wa.me/${OWNER_NUMBER}`));
  return buttons;
}
export function ownerMenuButtons() {
  const p = PREFIX;
  const row = (title, description, id) => ({ header: '', title, description, id: `${p}${id}` });
  return [
    qr('📞 Call Settings', `${p}call`),
    qr('📜 Main Menu', `${p}menu`),
    listBtn('👑 Owner Menu', [
      { title: '👑 OWNER', rows: [
        row('Mode', 'public / private', 'mode'),
        row('Broadcast', 'Send text to all groups', 'broadcast'),
        row('Block', 'Block a user', 'block'),
        row('Unblock', 'Unblock a user', 'unblock'),
        row('Join', 'Join a group by link', 'join'),
        row('Leave', 'Leave this group', 'leave'),
        row('Set Bio', 'Change bot bio', 'setbio'),
        row('Set DP', 'Reply to an image', 'setpp'),
        row('Restart', 'Restart the bot', 'restart')
      ] },
      { title: '📞 CALL', rows: [
        row('Call Settings', 'Show call settings', 'call'),
        row('Real Call Answer', 'Answer calls + play audio/video', 'callstream'),
        row('Call Reject', 'Reject calls on/off', 'callreject'),
        row('Auto Answer', 'Reply to calls with audio/video', 'autoanswer'),
        row('Call Preview', 'Send the saved audio/video', 'callpreview')
      ] }
    ])
  ];
}
export function aliveButtons() {
  const p = PREFIX;
  const buttons = [qr('📜 Menu', `${p}menu`), qr('🏓 Ping', `${p}ping`)];
  if (OWNER_NUMBER) buttons.push(urlBtn('👑 Owner', `https://wa.me/${OWNER_NUMBER}`));
  return buttons;
}

// Native-flow interactive message (the type that shows real tappable buttons).
async function sendInteractive(sock, jid, { image, body, footer, buttons }, quoted) {
  const media = image ? await prepareWAMessageMedia({ image: { url: image } }, { upload: sock.waUploadToServer }) : null;
  const IM = proto.Message.InteractiveMessage;
  const interactiveMessage = IM.create({
    header: IM.Header.create({ title: '', subtitle: '', hasMediaAttachment: !!media, ...(media || {}) }),
    body: IM.Body.create({ text: body }),
    footer: IM.Footer.create({ text: footer }),
    nativeFlowMessage: IM.NativeFlowMessage.create({ buttons, messageParamsJson: '' })
  });
  const content = {
    viewOnceMessage: {
      message: {
        messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
        interactiveMessage
      }
    }
  };
  const waMsg = generateWAMessageFromContent(jid, content, { userJid: sock.user?.id, quoted });
  const additionalNodes = [{
    tag: 'biz', attrs: {},
    content: [{ tag: 'interactive', attrs: { type: 'native_flow', v: '1' }, content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }] }]
  }];
  if (!isJidGroup(jid)) additionalNodes.push({ tag: 'bot', attrs: { biz_bot: '1' } });
  await sock.relayMessage(jid, waMsg.message, { messageId: waMsg.key.id, additionalNodes });
}

// Tries buttons first; if anything fails it falls back to image+caption, then plain text.
export async function sendRich(sock, jid, { caption, buttons, footer, image = MENU_IMAGE }, quoted) {
  if (USE_BUTTONS) {
    try {
      await sendInteractive(sock, jid, { image, body: caption, footer, buttons }, quoted);
      return;
    } catch (err) { console.error('Button send failed, using fallback:', err?.message || err); }
  }
  try {
    await sock.sendMessage(jid, { image: { url: image }, caption }, { quoted });
  } catch (err) {
    console.error('Image send failed, using text:', err?.message || err);
    await sock.sendMessage(jid, { text: caption }, { quoted });
  }
}
