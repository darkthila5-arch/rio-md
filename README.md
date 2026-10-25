# RIO X MD

Multi-session WhatsApp MD bot with text-command menu and a QR / pair-code pairing website.

## Run locally
```bash
cp .env.example .env     # set PAIRING_API_KEY (12+ chars)
npm install
npm start
```
Open `http://localhost:3000`, enter the same `PAIRING_API_KEY`, your number (digits only, with country code) and press **Generate Pair Code**.

## Deploy on Render
1. Upload these files to a GitHub repo (never commit `.env` or `sessions/`).
2. Render → **New → Blueprint** → select the repo (uses `render.yaml`). Or create a Web Service manually:
   build `npm install`, start `npm start`, health check `/health`.
3. Environment variables: `PAIRING_API_KEY` (Render can generate it), `SESSION_DIR=/var/data/sessions`, optional `BOT_NAME`, `PREFIX`, `MAX_SESSIONS`.
4. **Persistent disk** mounted at `/var/data` (needs a paid plan). Without it, sessions are wiped on every restart/redeploy. On the free plan the service also sleeps after inactivity, so the bot goes offline.
5. Render auto-deploys on every push to the branch. The GitHub deploy workflow is optional (manual only).

## What happens on restart
Paired sessions are restored automatically from `SESSION_DIR`. Unpaired attempts expire after 5 minutes. Logged-out sessions are deleted.

## Commands
`.tt <link>` / `.fb <link>` / `.pin <link>` (download), `.menu` / `.help` (image + buttons), `.alive`, `.ping`, `.owner`, `.runtime`, `.about`, `.media` / `.sticker`, `.groupinfo`, `.grouphelp`, `.status`
(Also works if you send `menu` or `help` without the prefix.)

## Security
- Pairing endpoints require `PAIRING_API_KEY` (timing-safe check, rate limited, placeholder key rejected).
- Session folders hold WhatsApp auth keys — never share or publish them.
- Use only with the account owner's consent. Baileys is an unofficial client and may break when WhatsApp changes.

## Buttons
`.menu` and `.alive` send an image with real WhatsApp buttons (quick reply + list + owner link). If buttons fail to send, the bot automatically falls back to image + text. Set `BUTTONS=off` to disable buttons. Change the picture with `MENU_IMAGE`, and set `OWNER_NUMBER` for the Owner button.

## TikTok / Facebook downloader
`.tt <tiktok link>` or `.fb <facebook link>` shows the video preview with **Video / Audio / Document** buttons; tap one and the bot sends that format.
- TikTok uses the tikwm API first, then yt-dlp as backup. Facebook uses yt-dlp.
- Render: the build command in `render.yaml` downloads yt-dlp into `bin/`. Locally, install yt-dlp (`pip install yt-dlp` or the binary) or set `YTDLP_PATH`.
- Only public videos work. Files over `MAX_DL_MB` (default 90) are refused.
- Download only content you have the right to save.

## MongoDB session storage
Set `MONGO_URL` (MongoDB Atlas free cluster) and WhatsApp sessions are stored in the database instead of files, so they survive redeploys and restarts, even on Render free. Without `MONGO_URL` the bot uses the `SESSION_DIR` files as before. In Atlas, allow network access from `0.0.0.0/0` (Network Access) so Render can connect.

## Pinterest downloader
`.pin <pinterest or pin.it link>` — image pins are sent straight away (original size when available); video pins show **Video / Document** buttons. It reads the public pin page and falls back to yt-dlp.

## Emoji reactions & DP card
Every command message gets an emoji reaction (🏓 for ping, 🎵 for tt, 📌 for pin ...). Every text reply carries a link-preview style card with the bot's profile picture (falls back to `MENU_IMAGE` if the account has no DP). Change the card link with `CARD_URL`. After `.setpp` the DP card refreshes automatically.

## Owner commands
Work for the linked account itself or the number in `OWNER_NUMBER`:
`.mode public|private` (private = only the owner can use the bot), `.broadcast <text>` (all groups, 2 s apart), `.block` / `.unblock` (number, reply or @mention), `.join <group link>`, `.leave`, `.setbio <text>`, `.setpp` (reply to an image), `.restart` (only the main `OWNER_NUMBER`, restarts every session).
`.owner` sends the owner contact card (uses the linked number when `OWNER_NUMBER` is empty). The mode is saved in `SESSION_DIR/_settings.json`.
