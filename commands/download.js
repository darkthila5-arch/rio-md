// Downloaders: TikTok, Facebook, Pinterest, YouTube song / video.
// Add a new command by adding one more object to this array (or create a new file in commands/).
import { execFile } from 'node:child_process';
import { MAX_DL_BYTES, sendDownload, sendSong, startDownload, startSong, tikwm, ytdlpReady } from '../lib/downloader.js';
import { state } from '../lib/config.js';
import { mem } from '../lib/text.js';

export default [
  {
    name: 'tt', aliases: ['tiktok'],
    async run({ sock, msg, jid, args }) {
        return startDownload(sock, jid, msg, 'tiktok', args[0]);
    },
  },
  {
    name: 'fb', aliases: ['facebook'],
    async run({ sock, msg, jid, args }) {
        return startDownload(sock, jid, msg, 'facebook', args[0]);
    },
  },
  {
    name: 'ig', aliases: ['instagram', 'insta'],
    async run({ sock, msg, jid, args }) {
        return startDownload(sock, jid, msg, 'instagram', args[0]);
    },
  },
  {
    name: 'tw', aliases: ['twitter', 'x'],
    async run({ sock, msg, jid, args }) {
        return startDownload(sock, jid, msg, 'twitter', args[0]);
    },
  },
  {
    name: 'video', aliases: ['ytv', 'ytvideo'],
    async run({ sock, msg, jid, args }) {
        return startSong(sock, jid, msg, args.join(' ').trim());
    },
  },
  {
    name: 'pin', aliases: ['pinterest'],
    async run({ sock, msg, jid, args }) {
        return startDownload(sock, jid, msg, 'pinterest', args[0]);
    },
  },
  {
    name: 'dlcheck',
    async run({ reply }) {
        const lines = ['🔍 *Downloader check*'];
        await ytdlpReady;
        try {
          const v = await new Promise((resolve, reject) => execFile(state.ytdlp, ['--version'], { timeout: 15000 }, (e, out) => (e ? reject(e) : resolve(String(out).trim()))));
          lines.push(`✅ yt-dlp: ${v}`);
        } catch (e) { lines.push(`❌ yt-dlp not available (${e?.code || e?.message}). Check the logs for 'Could not install yt-dlp'.`); }
        try {
          const info = await tikwm('https://www.tiktok.com/@scout2015/video/6718335390845095173');
          lines.push(info.video ? '✅ TikTok API (tikwm): working' : '⚠️ TikTok API replied without a video');
        } catch (e) { lines.push(`❌ TikTok API (tikwm): ${e?.message || e}`); }
        lines.push(`🧠 RAM: ${mem()}`, `📦 Max file: ${Math.round(MAX_DL_BYTES / 1048576)} MB`);
        return reply(lines.join('\n'));
    },
  },
  {
    name: 'song', aliases: ['play', 'yt', 'ytmp3'],
    async run({ sock, msg, jid, args }) {
        return startSong(sock, jid, msg, args.join(' ').trim());
    },
  },
  {
    name: 'ytdl',
    async run({ sock, msg, jid, args }) {
        return sendSong(sock, jid, msg, args[0], args[1]);
    },
  },
  {
    name: 'dl',
    async run({ sock, msg, jid, args }) {
        return sendDownload(sock, jid, msg, args[0], args[1]);
    },
  },
];
