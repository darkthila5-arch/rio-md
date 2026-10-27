// Call commands (owner only): reject, auto answer, real call streaming, call clips.
// Add a new command by adding one more object to this array (or create a new file in commands/).
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { DEFAULT_CALL_MSG, MAX_CALL_MEDIA, deleteCallMedia, loadCallMedia, saveCallMedia, sendCallMedia } from '../lib/calls.js';
import { getSetting, setSetting } from '../lib/storage.js';
import { BOT_NAME, PREFIX, jidNum, logger, state } from '../lib/config.js';
import { parseToggle, unwrapMessage } from '../lib/text.js';
import { callbotApi, syncCallbot, watchCallbotLink } from '../lib/callbot.js';
import { copyBtn, sendRich } from '../lib/menu.js';

export default [
  {
    name: 'call', aliases: ['callsettings'], owner: true,
    async run({ sessionId, reply }) {
        const onoff = (v) => (v ? '✅ ON' : '❌ OFF');
        const [a, v] = await Promise.all([loadCallMedia(sessionId, 'audio'), loadCallMedia(sessionId, 'video')]);
        return reply([
          '╭━━━〔 📞 *CALL SETTINGS* 〕━━━⬣',
          `┃ 📵 Call reject   : ${onoff(getSetting(sessionId, 'callReject', false))}`,
          `┃ 🤖 Auto answer   : ${onoff(getSetting(sessionId, 'autoAnswer', false))}`,
          `┃ 🎙️ Saved audio   : ${a ? '✅ set' : '— not set'}`,
          `┃ 🎬 Saved video   : ${v ? '✅ set' : '— not set'}`,
          '╰━━━━━━━━━━━━━━━━━━━━⬣',
          '',
          `${PREFIX}callreject on/off — reject incoming calls (sends the call message)`,
          `${PREFIX}autoanswer on/off — reject the call, then send the saved audio / video to the caller (voice call → audio, video call → video)`,
          `${PREFIX}setcallaudio — reply to a voice note / audio`,
          `${PREFIX}setcallvideo — reply to a video`,
          `${PREFIX}setcallmsg <text> — message sent when a call is rejected`,
          `${PREFIX}callpreview — send the saved audio / video here`,
          `${PREFIX}delcallmedia audio|video — remove a saved file`,
          '',
          '_Note: WhatsApp does not allow bots to pick up a call and stream into it, so "auto answer" replies with the saved audio / video as a message right after rejecting the call._'
        ].join('\n'));
    },
  },
  {
    name: 'callreject', aliases: ['anticall', 'autoanswer', 'callanswer'], owner: true,
    async run({ sessionId, args, command, reply }) {
        const key = command === 'callreject' || command === 'anticall' ? 'callReject' : 'autoAnswer';
        const label = key === 'callReject' ? 'Call reject' : 'Auto call answer';
        const v = parseToggle(args[0]);
        if (v === null) return reply(`${label} is *${getSetting(sessionId, key, false) ? 'ON' : 'OFF'}*.\nUse ${PREFIX}${command} on  or  ${PREFIX}${command} off`);
        setSetting(sessionId, key, v);
        let note = '';
        if (key === 'autoAnswer' && v) {
          const [a, vid] = await Promise.all([loadCallMedia(sessionId, 'audio'), loadCallMedia(sessionId, 'video')]);
          if (!a && !vid) note = `\n⚠️ No audio/video saved yet. Reply to one with ${PREFIX}setcallaudio or ${PREFIX}setcallvideo.`;
        }
        return reply(`✅ ${label}: *${v ? 'ON' : 'OFF'}*${note}`);
    },
  },
  {
    name: 'callstream', aliases: ['realcall'], owner: true,
    async run({ sock, msg, jid, sessionId, args, reply }) {
        if (!state.callbotAvailable) return reply('❌ Real call answering is not installed on this server.\nIt needs the Docker deploy with the Go "callbot" service (see README → Real call answering). Until then use ' + PREFIX + 'autoanswer (reject + send the clip as a message).');
        const sub = (args[0] || '').toLowerCase();
        let st;
        try { st = await callbotApi('GET', `/sessions/${sessionId}`); }
        catch (err) { return reply(`❌ The call service is not answering yet (${err?.message || err}). Try again in a minute.`); }
        const on = !!getSetting(sessionId, 'callStream', false);
  
        if (!sub || sub === 'status') {
          const [a, v] = await Promise.all([loadCallMedia(sessionId, 'audio'), loadCallMedia(sessionId, 'video')]);
          return reply([
            '╭━━━〔 📞 *REAL CALL ANSWER* 〕━━━⬣',
            `┃ 🔛 Answer calls  : ${on ? '✅ ON' : '❌ OFF'}`,
            `┃ 🔗 Call service  : ${st.linked ? (st.connected ? '✅ linked' : '⚠️ linked, reconnecting') : '❌ not linked'}`,
            `┃ 🔁 Loop clip     : ${getSetting(sessionId, 'callLoop', false) ? 'ON' : 'OFF'}`,
            `┃ 🎙️ Audio clip    : ${a ? '✅ set' : '— not set'}`,
            `┃ 🎬 Video clip    : ${v ? '✅ set' : '— not set'}`,
            '╰━━━━━━━━━━━━━━━━━━━━⬣',
            '',
            `${PREFIX}callstream on / off`,
            `${PREFIX}callstream loop on / off`,
            `${PREFIX}callstream unlink — remove the linked call device`,
            `${PREFIX}setcallaudio / ${PREFIX}setcallvideo — choose what is played (voice call → audio, video call → video)`
          ].join('\n'));
        }
        if (sub === 'off') { setSetting(sessionId, 'callStream', false); await syncCallbot(sessionId, sock); return reply('✅ Real call answering: *OFF*'); }
        if (sub === 'loop') {
          const lv = parseToggle(args[1]);
          if (lv === null) return reply(`Use ${PREFIX}callstream loop on  or  ${PREFIX}callstream loop off`);
          setSetting(sessionId, 'callLoop', lv); await syncCallbot(sessionId, sock);
          return reply(`✅ Loop clip: *${lv ? 'ON' : 'OFF'}* (${lv ? 'plays until the caller hangs up' : 'hangs up when the clip ends'})`);
        }
        if (sub === 'unlink') {
          setSetting(sessionId, 'callStream', false);
          try { await callbotApi('DELETE', `/sessions/${sessionId}`); } catch (err) { return reply(`❌ ${err?.message || err}`); }
          return reply('✅ Call device unlinked and real call answering turned OFF.');
        }
        if (sub !== 'on') return reply(`Use ${PREFIX}callstream on / off / loop / unlink`);
  
        setSetting(sessionId, 'callStream', true);
        if (st.linked) {
          await syncCallbot(sessionId, sock);
          const [a, v] = await Promise.all([loadCallMedia(sessionId, 'audio'), loadCallMedia(sessionId, 'video')]);
          return reply(`✅ Real call answering: *ON*${!a && !v ? `\n⚠️ No clip saved. Reply to a voice note with ${PREFIX}setcallaudio or to a video with ${PREFIX}setcallvideo.` : ''}`);
        }
        if (!st.ffmpeg) await reply('⚠️ ffmpeg is missing on the server, saving clips will fail.');
        try {
          const phone = jidNum(sock.user?.id);
          const { code } = await callbotApi('POST', `/sessions/${sessionId}/pair`, { json: { phone }, timeout: 60000 });
          watchCallbotLink(sessionId, sock, jid);
          return sendRich(sock, jid, { caption: `🔗 *Link the call service (one time)*\n\n1. Open WhatsApp on your phone\n2. *Linked devices → Link a device*\n3. Tap *Link with phone number instead*\n4. Tap *Copy Code* below and paste it there\n\n*${code}*\n\nThe code works for 5 minutes. I will message you here when it is linked.`, buttons: [copyBtn('📋 Copy Code', code)], footer: `${BOT_NAME} • Call service`, image: null }, msg);
        } catch (err) { console.error('callbot pair error:', err?.message || err); return reply(`❌ Could not start linking: ${err?.message || err}`); }
    },
  },
  {
    name: 'setcallmsg', owner: true,
    async run({ sessionId, args, reply }) {
        const t = args.join(' ').trim();
        if (!t) return reply(`Current call message:\n${getSetting(sessionId, 'callMsg', DEFAULT_CALL_MSG)}\n\nChange it: ${PREFIX}setcallmsg <text>  (or ${PREFIX}setcallmsg reset)`);
        setSetting(sessionId, 'callMsg', /^reset$/i.test(t) ? null : t.slice(0, 500));
        return reply('✅ Call message updated.');
    },
  },
  {
    name: 'setcallaudio', aliases: ['setcallvideo'], owner: true,
    async run({ sock, msg, jid, sessionId, command, reply }) {
        const kind = command === 'setcallaudio' ? 'audio' : 'video';
        const ctx = unwrapMessage(msg.message).extendedTextMessage?.contextInfo;
        const quoted = ctx?.quotedMessage ? unwrapMessage(ctx.quotedMessage) : null;
        const part = kind === 'audio' ? quoted?.audioMessage : quoted?.videoMessage;
        if (!part) return reply(`Reply to a ${kind === 'audio' ? 'voice note / audio' : 'video'} with ${PREFIX}${command} to save it for calls.`);
        if (Number(part.fileLength || 0) > MAX_CALL_MEDIA) return reply(`❌ That file is bigger than ${Math.round(MAX_CALL_MEDIA / 1048576)} MB.`);
        try {
          const target = { key: { remoteJid: jid, id: ctx.stanzaId, participant: ctx.participant }, message: quoted };
          const buf = await downloadMediaMessage(target, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
          if (buf.length > MAX_CALL_MEDIA) return reply(`❌ That file is bigger than ${Math.round(MAX_CALL_MEDIA / 1048576)} MB.`);
          await saveCallMedia(sessionId, kind, buf, { mimetype: part.mimetype, ptt: !!part.ptt, caption: part.caption || '' });
          let streamNote = '';
          if (state.callbotAvailable) {
            try { await callbotApi('PUT', `/sessions/${sessionId}/media/${kind}`, { body: buf, timeout: 180000 }); streamNote = `\n📞 Ready for real calls too (${PREFIX}callstream on).`; }
            catch (err) { streamNote = `\n⚠️ The call service could not convert it: ${err?.message || err}`; }
          }
          return reply(`✅ Call ${kind} saved (${(buf.length / 1048576).toFixed(1)} MB).\nTurn it on with ${PREFIX}autoanswer on${streamNote}`);
        } catch (err) { console.error('setcall media error:', err?.message || err); return reply('❌ Could not save that file. Try forwarding it again and reply to the new one.'); }
    },
  },
  {
    name: 'callpreview', owner: true,
    async run({ sock, msg, jid, sessionId, reply }) {
        let sent = 0;
        for (const kind of ['audio', 'video']) {
          const media = await loadCallMedia(sessionId, kind);
          if (media) { await sendCallMedia(sock, jid, { ...media, kind }, msg); sent++; }
        }
        return sent ? undefined : reply(`Nothing saved yet. Use ${PREFIX}setcallaudio / ${PREFIX}setcallvideo.`);
    },
  },
  {
    name: 'delcallmedia', owner: true,
    async run({ sessionId, args, reply }) {
        const kind = (args[0] || '').toLowerCase();
        if (kind !== 'audio' && kind !== 'video') return reply(`Usage: ${PREFIX}delcallmedia audio  or  ${PREFIX}delcallmedia video`);
        await deleteCallMedia(sessionId, kind);
        if (state.callbotAvailable) await callbotApi('DELETE', `/sessions/${sessionId}/media/${kind}`).catch(() => {});
        return reply(`🗑️ Saved call ${kind} removed.`);
    },
  },
];
