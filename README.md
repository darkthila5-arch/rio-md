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
`.menu` / `.help` (image + buttons), `.alive`, `.ping`, `.owner`, `.runtime`, `.about`, `.media` / `.sticker`, `.groupinfo`, `.grouphelp`, `.status`
(Also works if you send `menu` or `help` without the prefix.)

## Security
- Pairing endpoints require `PAIRING_API_KEY` (timing-safe check, rate limited, placeholder key rejected).
- Session folders hold WhatsApp auth keys — never share or publish them.
- Use only with the account owner's consent. Baileys is an unofficial client and may break when WhatsApp changes.

## Buttons
`.menu` and `.alive` send an image with real WhatsApp buttons (quick reply + list + owner link). If buttons fail to send, the bot automatically falls back to image + text. Set `BUTTONS=off` to disable buttons. Change the picture with `MENU_IMAGE`, and set `OWNER_NUMBER` for the Owner button.
