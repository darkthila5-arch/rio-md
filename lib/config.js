import 'dotenv/config';
import pino from 'pino';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';


// libsignal prints huge session dumps with console.* on every key mismatch; drop that noise.
const NOISE = /^(Closing session|Closing open session|Session error|Failed to decrypt message|Removing old closed session|Migrating session|Decrypted message with closed session|Bad MAC)/;
for (const level of ['log', 'info', 'warn', 'error']) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    const first = args[0];
    if (typeof first === 'string' && NOISE.test(first)) return;
    if (first && typeof first === 'object' && first.constructor?.name === 'SessionEntry') return;
    original(...args);
  };
}

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PORT = Number(process.env.PORT || 3000);
export const BOT_NAME = process.env.BOT_NAME || 'RIO X MD';
export const PREFIX = (process.env.PREFIX || '.').trim() || '.';
export const API_KEY = (process.env.PAIRING_API_KEY || '').trim();
const PLACEHOLDER_KEY = 'change-this-to-a-long-random-secret';
export const MAX_SESSIONS = Number(process.env.MAX_SESSIONS || 20);
export const PAIR_TIMEOUT_MS = 5 * 60 * 1000; // unpaired sessions are removed after 5 minutes
export const MAX_MSG_AGE_S = 60; // ignore old queued messages after a reconnect

// On Render, point SESSION_DIR at the persistent disk (e.g. /var/data/sessions).
export const SESSION_ROOT = path.resolve(process.env.SESSION_DIR || path.join(ROOT_DIR, 'sessions'));
fs.mkdirSync(SESSION_ROOT, { recursive: true });

export const logger = pino({ level: 'silent' });

export const sessions = new Map(); // id -> { sock, state, qr, pairCode, status, phone, starting, removed, retries, timers }
export const cooldowns = new Map();
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));


/* ---------- helpers ---------- */
export function safeId(value) { return /^[a-f0-9]{24}$/.test(String(value || '')); }
export function sessionPath(id) { return path.join(SESSION_ROOT, id); }
export function keyIsConfigured() { return API_KEY.length >= 12 && API_KEY !== PLACEHOLDER_KEY; }
export function sha(v) { return crypto.createHash('sha256').update(String(v)).digest(); }


/* ---------- session storage (MongoDB or local files) ---------- */
export const MONGO_URL = (process.env.MONGO_URL || '').trim();
export const MONGO_DB = (process.env.MONGO_DB || 'rio_x_md').trim();


/* ---------- message handling ---------- */
export const MENU_IMAGE = (process.env.MENU_IMAGE || 'https://files.catbox.moe/jy9p51.jpg').trim();
export const OWNER_NUMBER = (process.env.OWNER_NUMBER || '').replace(/\D/g, '');
export const USE_BUTTONS = (process.env.BUTTONS || 'on').toLowerCase() !== 'off';
export const TIMEZONE = process.env.TIMEZONE || 'Asia/Colombo';

export const DEFAULT_MODE = (process.env.MODE || 'public').toLowerCase() === 'private' ? 'private' : 'public';
export const CARD_URL = (process.env.CARD_URL || '').trim();
export const jidNum = (j) => String(j || '').split('@')[0].split(':')[0];

// Shared mutable state (other modules import this object and read / write its fields).
export const state = {
  shuttingDown: false, // set on SIGTERM so the old instance never reconnects and steals the session from the new one
  mongoCol: null, mongoDb: null, mongoPending: null,
  callbotAvailable: false, callbotProc: null, callbotRestarts: 0,
  ytdlp: process.env.YTDLP_PATH || (fs.existsSync(path.join(ROOT_DIR, 'bin', 'yt-dlp')) ? path.join(ROOT_DIR, 'bin', 'yt-dlp') : 'yt-dlp'),
};
