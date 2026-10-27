# RIO X MD

Multi-session WhatsApp bot (Baileys) with a modern pairing website (pair code or QR), downloaders, owner tools, status tools and real call answering (Go service).

> Baileys is an unofficial WhatsApp client and may break when WhatsApp changes. Use it only with your own account.

## Features
| Area | What it does |
|---|---|
| Pairing site | Link your own number with a pair code or QR. Live "online" counter. |
| Menu | `.menu` image + buttons, `.alive`, emoji reaction on every command, bot DP link-preview card on every reply. |
| Downloaders | TikTok, Facebook, Pinterest, YouTube song / video. |
| Status tools | Auto view, auto react (your own emojis), auto save, view-once recovery. |
| Owner tools | public / private mode, broadcast, block, join, leave, bio, profile picture, restart. |
| Calls | Reject calls, reject + auto reply with a saved audio / video, or **really answer** and stream a saved audio / video into the call. |

## Run locally
```bash
cp .env.example .env     # set PAIRING_API_KEY (12+ chars) and OWNER_NUMBER
npm install
npm start
```
Open `http://localhost:3000`, enter your number (digits only, with country code) and press **Generate Pair Code**.
Needs Node 20+. For downloads install `ffmpeg`; yt-dlp is downloaded automatically. For real call answering also build the Go service (see below).

## Deploy on Render (Docker)
The repo ships a `Dockerfile` (Node bot + Go call service + ffmpeg + git) and `render.yaml` with `runtime: docker`.
1. Push the repo to GitHub (never commit `.env`, `sessions/`).
2. Render → **New → Blueprint** (or **New → Web Service → Language: Docker**), plan **Starter** or higher.
3. Set the environment variables below. Add a **persistent disk** mounted at `/var/data` and set `SESSION_DIR=/var/data/sessions`.
4. Health check path: `/health`.
Important: a service created as "Node" cannot be switched to Docker. Create a new Docker service, copy the variables, then delete the old one (two services on the same sessions disconnect each other).
Without a disk, files are wiped on every redeploy. With `MONGO_URL` the WhatsApp sessions, settings and saved call clips are also kept in MongoDB. The call-service link (`SESSION_DIR/_callbot`) needs the disk.

## Project layout and adding commands
```
index.js            pairing website + API, startup / shutdown
lib/                shared code (config, storage, session, router, menu, downloader, calls, status ...)
commands/           one file per group of commands, loaded automatically
```
To add a command, open a file in `commands/` (or create a new `.js` file there) and add an object:
```js
export default [
  { name: 'hello', aliases: ['hi'], async run({ reply, name }) { return reply(`Hello ${name}!`); } },
];
```
Optional fields: `owner: true` (owner only), `hidden: true` (silent for everyone else), `react: '👋'` (emoji on the command message).
`run()` receives `sock, msg, jid, sessionId, args, command, name, reply, isOwner, isAdmin, targetJid`. Then add one line for it in the menu text in `lib/menu.js`. A broken command file only disables itself, the others keep working.

## Environment variables
| Variable | Meaning |
|---|---|
| `PAIRING_API_KEY` | Secret for the pairing API (only enforced when `PAIRING_REQUIRE_KEY=true`). |
| `OWNER_NUMBER` | Your number with country code, digits only. Owner button, owner contact card, `.restart`. |
| `BOT_NAME`, `PREFIX` | Bot name and command prefix (default `.`). |
| `MENU_IMAGE` | Picture for the menu / alive message (also the DP-card fallback). |
| `BUTTONS` | `off` = image + text only, no buttons. |
| `MODE` | `public` (default) or `private` (only the owner can use the bot). `.mode` changes it per session. |
| `CARD_URL` | Link opened by the DP card on replies. |
| `MONGO_URL`, `MONGO_DB` | MongoDB Atlas connection. Sessions survive redeploys. Allow `0.0.0.0/0` in Atlas network access. |
| `SESSION_DIR` | Where sessions and settings are stored (`/var/data/sessions` on Render). |
| `MAX_SESSIONS` | Maximum linked numbers (default 20). |
| `MAX_DL_MB` | Download size limit (default 90). |
| `YTDLP_PATH`, `YTDLP_COOKIES` | yt-dlp location / YouTube cookies when YouTube asks for a bot check. |
| `CALLBOT_DIR`, `CALLBOT_PORT` | Optional, call service data folder / localhost port (8099). |
| `TIMEZONE` | Greeting and clock time zone (default `Asia/Colombo`). |

## Commands
Send `menu` or `help` without the prefix and it works too.

**Public (`.menu`)**
- General: `.alive`, `.ping`, `.runtime`, `.about`, `.owner`, `.status`
- Download: `.tt <link>`, `.fb <link>`, `.pin <link>`, `.song <name or link>`
- Media: `.sticker`, `.media`
- Group: `.groupinfo`, `.grouphelp`
- Status & view-once (work for the account that linked the bot): `.autostatus`, `.statusseen`, `.statusreact`, `.statusemoji`, `.statussave`, `.viewonce`, `.vv`, `.save`

**Owner (`.momenu`, aliases `.ownermenu`, `.omenu`)** works only for the linked account or `OWNER_NUMBER`. For everybody else `.momenu` is ignored silently and owner commands answer "owner only".
- `.mode public|private`, `.broadcast <text>`, `.block` / `.unblock`, `.join <group link>`, `.leave`, `.setbio <text>`, `.setpp` (reply to an image), `.restart` (only `OWNER_NUMBER`, restarts every session)
- Calls: `.call`, `.callstream`, `.callreject`, `.autoanswer`, `.setcallaudio`, `.setcallvideo`, `.setcallmsg`, `.callpreview`, `.delcallmedia`

## Downloaders
- `.tt` / `.fb` show a preview with **Video / Audio / Document** buttons. TikTok uses the tikwm API first, then yt-dlp. Facebook uses yt-dlp.
- `.pin <pinterest or pin.it link>`: image pins are sent straight away (original size when possible), video pins show **Video / Document** buttons. It reads the public pin page and falls back to yt-dlp.
- `.song <name or link>`: YouTube audio / document / video. If YouTube blocks the server, add cookies (`YTDLP_COOKIES` or a Render secret file `cookies.txt`).
- Only public content works. Files over `MAX_DL_MB` are refused. Download only what you have the right to save.

## Emoji reactions and the DP card
Every command message gets an emoji reaction (🏓 ping, 🎵 tt, 📌 pin ...). Every text reply carries a link-preview style card with the bot's profile picture (falls back to `MENU_IMAGE`). `.setpp` refreshes it.

## Status tools and view-once recovery
All switches are **OFF** by default and are per linked account.
- `.statusseen on|off`: view every new status automatically.
- `.statusreact on|off`: react to fresh statuses (under 30 min old) with a random emoji from your list, after a short random pause. `.statusemoji 😍 🔥 ❤️` sets the list, `.statusemoji reset` restores the default.
- `.statussave on|off`: send every status (photo, video, voice, text) to your own chat with the sender's name. Statuses older than 6 hours are skipped.
- `.viewonce on|off`: send a copy of every view-once photo / video / voice note you receive to your own chat. `.vv` (reply to a view-once message) opens it in the current chat.
- `.save` (reply to a photo / video / voice note) sends it to your own chat. Do not reply to a **status** with `.save`: a reply to a status goes to the person who posted it. Use `.statussave on` for statuses.
- `.autostatus` shows all the switches.
Reacting to many statuses automatically can look like spam to WhatsApp, use it moderately.

## Calls
Owner only, per linked account. The owner's own number and `OWNER_NUMBER` are never rejected or answered, group calls are ignored.

**Reject / auto reply (works everywhere)**
- `.callreject on|off` rejects incoming calls and sends a message (`.setcallmsg <text>` changes it).
- `.autoanswer on|off` rejects the ringing call and sends your saved audio (voice call) or video (video call) to the caller as a message.
- Save the clips by replying to a voice note / video with `.setcallaudio` / `.setcallvideo` (max 15 MB). `.callpreview` plays them back, `.delcallmedia audio|video` removes one.

**Real answering (`.callstream`, Docker deploy only)**
`.callstream on` makes the bot pick up incoming calls and play your saved clip into the call: voice call → the audio clip, video call → the video clip (picture + its own sound). Afterwards it hangs up (`.callstream loop on` repeats until the caller hangs up).
- Baileys cannot answer calls, so a small Go service in `callbot/` (hypermeow, a whatsmeow fork, + [meowcaller](https://github.com/purpshell/meowcaller)) is started by the bot.
- First time: `.callstream on` sends an 8 character code. WhatsApp → *Linked devices → Link a device → Link with phone number instead* → type it. This links the call service as a second device on your number (WhatsApp allows up to 4). The bot confirms in the chat.
- Other commands: `.callstream status|off|unlink`, `.callstream loop on|off`.
- Clips are converted by ffmpeg: audio → 16 kHz mono, video → H.264 480 px wide, 15 fps, max 3 min.
- If the service is not installed or not linked, `.callreject` / `.autoanswer` still work.
- Local build: `cd callbot && go mod tidy && go build -o ../bin/callbot .` (Go 1.24+ and ffmpeg needed), then `npm start`. Tests: `cd callbot && go test ./...`.
- Limits: meowcaller is a young reverse-engineered library; its own docs mark outgoing video as not validated, so video may not show on every phone. WhatsApp can change its protocol at any time.

## What happens on restart
Paired sessions are restored automatically (from MongoDB or `SESSION_DIR`). Unpaired attempts expire after 5 minutes. Logged-out sessions are deleted.

## Security
- Pairing endpoints are rate limited and, with `PAIRING_REQUIRE_KEY=true`, need `PAIRING_API_KEY` (timing-safe check, placeholder key rejected).
- Session folders and the MongoDB `auth` collection hold WhatsApp auth keys: never share or publish them.
- The call service listens on `127.0.0.1` only and needs a secret that is generated on every start.
- Automated use of an account can get it restricted by WhatsApp. Use only with the account owner's consent.
