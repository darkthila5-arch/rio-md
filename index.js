import express from 'express';
import QRCode from 'qrcode';
import path from 'node:path';
import crypto from 'node:crypto';
import { API_KEY, BOT_NAME, MAX_SESSIONS, PORT, ROOT_DIR, SESSION_ROOT, keyIsConfigured, safeId, sessions, sha, state } from './lib/config.js';
import { clearTimers, destroySession, restoreSessions, startSession } from './lib/session.js';
import { startCallbot } from './lib/callbot.js';

const app = express();
app.set('trust proxy', 1); // Render sits behind a proxy; needed for correct client IPs
app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(ROOT_DIR, 'public')));


function makeLimiter(max, windowMs) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, windowMs).unref();
  return (req, res, next) => {
    const now = Date.now();
    const k = req.ip;
    const e = hits.get(k);
    if (!e || e.reset <= now) { hits.set(k, { count: 1, reset: now + windowMs }); return next(); }
    if (++e.count > max) {
      res.set('Retry-After', String(Math.ceil((e.reset - now) / 1000)));
      return res.status(429).json({ error: 'Too many requests. Please wait a bit and try again.' });
    }
    next();
  };
}
const apiLimiter = makeLimiter(90, 60 * 1000);
const createLimiter = makeLimiter(10, 10 * 60 * 1000);

// Pairing is public by default so anyone can link their own number. Set PAIRING_REQUIRE_KEY=true to lock it behind PAIRING_API_KEY.
const REQUIRE_KEY = String(process.env.PAIRING_REQUIRE_KEY || '').toLowerCase() === 'true';
function authRequired(req, res, next) {
  if (!REQUIRE_KEY) return next();
  if (!keyIsConfigured()) {
    return res.status(503).json({ error: 'Server is not configured: set a PAIRING_API_KEY of at least 12 characters.' });
  }
  const given = req.get('x-api-key') || '';
  if (!crypto.timingSafeEqual(sha(given), sha(API_KEY))) {
    return res.status(401).json({ error: 'Invalid API key.' });
  }
  next();
}

/* ---------- HTTP API ---------- */
app.post('/api/session', createLimiter, authRequired, async (req, res) => {
  const qrOnly = req.body?.mode === 'qr';
  const phone = qrOnly ? '' : String(req.body?.phone || '').replace(/\D/g, '');
  if (!qrOnly && (phone.length < 8 || phone.length > 15)) {
    return res.status(400).json({ error: 'Enter a valid international phone number with country code, digits only.' });
  }
  if (sessions.size >= MAX_SESSIONS) {
    return res.status(429).json({ error: 'The server is full right now. Please try again later.' });
  }
  for (const [sid, r] of sessions) { // one session per number
    if (!phone || r.phone !== phone) continue;
    if (r.status === 'connected') return res.status(409).json({ error: 'This number is already linked to the bot.' });
    if (r.state?.creds?.registered) return res.status(409).json({ error: 'This number is already linked and is reconnecting. Try again in a minute.' });
    destroySession(sid); // abandoned, unfinished attempt
  }
  const id = crypto.randomBytes(12).toString('hex');
  try {
    await startSession(id, phone);
    res.json({ id, status: 'starting', message: 'Keep this page open and check status in a few seconds.' });
  } catch (err) {
    destroySession(id);
    res.status(500).json({ error: 'Could not start a session.' });
  }
});

app.get('/api/session/:id', apiLimiter, authRequired, async (req, res) => {
  const { id } = req.params;
  if (!safeId(id)) return res.status(400).json({ error: 'Invalid session id.' });
  const record = sessions.get(id);
  if (!record) return res.status(404).json({ error: 'Session expired or not found. Generate a new code.' });
  let qrDataUrl = null;
  if (record.qr) {
    try { qrDataUrl = await QRCode.toDataURL(record.qr, { margin: 1, width: 320 }); } catch {}
  }
  res.json({ id, status: record.status, phone: record.phone, pairCode: record.pairCode, qrDataUrl, error: record.error || null });
});

app.delete('/api/session/:id', apiLimiter, authRequired, (req, res) => {
  const { id } = req.params;
  if (!safeId(id)) return res.status(400).json({ error: 'Invalid session id.' });
  const r = sessions.get(id);
  if (r && r.status !== 'connected' && !r.state?.creds?.registered) destroySession(id); // never touches a linked session
  res.json({ ok: true });
});

app.get('/health', (_req, res) => res.json({ ok: true, bot: BOT_NAME, activeSessions: sessions.size, storage: state.mongoCol ? 'mongodb' : 'files' }));

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`${BOT_NAME} pairing site listening on port ${PORT}`);
  if (REQUIRE_KEY && !keyIsConfigured()) console.warn('WARNING: PAIRING_REQUIRE_KEY is on but PAIRING_API_KEY is missing/too short — pairing is disabled until you set a real one.');
  console.log(`Session directory: ${SESSION_ROOT}`);
  startCallbot();
  restoreSessions().catch((e) => console.error('Restore error:', e?.message || e));
});

/* ---------- process safety ---------- */
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err?.message || err));
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err?.message || err));
function shutdown() {
  state.shuttingDown = true;
  console.log('Shutting down…');
  for (const record of sessions.values()) { clearTimers(record); try { record.sock?.end(undefined); } catch {} }
  try { state.callbotProc?.kill('SIGTERM'); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
