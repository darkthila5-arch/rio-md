import makeWASocket, { DisconnectReason, Browsers, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys';
import fs from 'node:fs';
import path from 'node:path';
import { MONGO_URL, PAIR_TIMEOUT_MS, SESSION_ROOT, logger, safeId, sessionPath, sessions, sleep, state } from './config.js';
import { deleteSessionData, getAuthState, getMongoCol, getSetting, isMongoSessionRegistered, loadMongoSettings } from './storage.js';
import { qr } from './menu.js';
import { syncCallbot } from './callbot.js';
import { handleCall } from './calls.js';
import { handleStatus, handleViewOnce } from './status.js';
import { handleMessage } from './router.js';

export function clearTimers(record) {
  clearTimeout(record.expiryTimer);
  clearTimeout(record.reconnectTimer);
}

export function destroySession(id, { deleteFiles = true } = {}) {
  const record = sessions.get(id);
  if (record) {
    record.removed = true;
    clearTimers(record);
    try { record.sock?.end(undefined); } catch {}
    sessions.delete(id);
  }
  if (deleteFiles) deleteSessionData(id).catch(() => {});
}


/* ---------- WhatsApp session ---------- */
export async function startSession(id, phone = '') {
  const current = sessions.get(id);
  if (current?.starting) return current;
  if (current?.sock && current.status === 'connected') return current;

  const record = current || { sock: null, state: null, qr: null, pairCode: null, status: 'starting', phone, starting: false, removed: false, retries: 0 };
  record.starting = true;
  record.status = 'starting';
  record.error = null;
  record.pairRequested = false;
  record.phone = phone || record.phone || '';
  sessions.set(id, record);

  try {
    const { state, saveCreds } = await getAuthState(id);
    record.state = state;

    const config = {
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      logger,
      browser: Browsers.ubuntu(process.env.BROWSER_NAME || 'Chrome'), // pair codes only work with a known browser name
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false
    };
    try { config.version = (await fetchLatestBaileysVersion()).version; } catch { /* use library default */ }

    const sock = makeWASocket(config);
    record.sock = sock;

    // Unpaired sessions expire so abandoned attempts don't pile up and reconnect forever.
    if (!state.creds.registered && !record.expiryTimer) {
      record.expiryTimer = setTimeout(() => {
        const r = sessions.get(id);
        if (r && !r.state?.creds?.registered && r.status !== 'connected') {
          console.log(`Session ${id} expired before pairing; removing.`);
          destroySession(id);
        }
      }, PAIR_TIMEOUT_MS);
      record.expiryTimer.unref?.();
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      if (record.sock !== sock || record.removed) return;

      if (update.qr) {
        record.qr = update.qr;
        record.status = 'waiting_for_scan';
        // The socket is ready now: request the pair code (more reliable than a fixed delay).
        if (record.phone && !state.creds.registered && !record.pairRequested) {
          record.pairRequested = true;
          try {
            const code = await sock.requestPairingCode(record.phone);
            record.pairCode = code?.match(/.{1,4}/g)?.join('-') || code;
            record.status = 'waiting_for_pair';
          } catch (err) {
            record.status = 'pair_error';
            record.error = 'Could not generate pair code. Check the number and try again.';
            console.error('Pair code error:', err?.message || err);
          }
        }
      }

      if (update.connection === 'open') {
        record.status = 'connected';
        record.phone = String(sock.user?.id || '').split(':')[0].split('@')[0] || record.phone;
        record.qr = null;
        record.pairCode = null;
        record.starting = false;
        record.retries = 0;
        record.replacedCount = 0;
        clearTimeout(record.expiryTimer);
        record.expiryTimer = null;
        console.log(`Session ${id} connected.`);
        if (state.callbotAvailable && getSetting(id, 'callStream', false)) syncCallbot(id, sock).catch(() => {});
      }

      if (update.connection === 'close') {
        if (state.shuttingDown) return;
        const statusCode = update.lastDisconnect?.error?.output?.statusCode;
        record.starting = false;
        record.sock = null;

        if (statusCode === DisconnectReason.loggedOut) {
          record.status = 'logged_out';
          console.log(`Session ${id} logged out; deleting its files.`);
          deleteSessionData(id).catch(() => {});
          clearTimers(record);
          setTimeout(() => sessions.delete(id), 60 * 1000).unref?.();
          return;
        }
        if (statusCode === DisconnectReason.connectionReplaced) {
          record.status = 'replaced';
          record.error = 'Another device/session replaced this connection.';
          record.replacedCount = (record.replacedCount || 0) + 1;
          // During a redeploy the old instance briefly holds the session; retry shortly instead of staying offline.
          if (record.replacedCount <= 5) {
            record.reconnectTimer = setTimeout(() => {
              if (!record.removed && !state.shuttingDown) startSession(id, record.phone).catch((e) => console.error('Reconnect error:', e?.message || e));
            }, 20000);
          }
          return;
        }
        record.status = 'disconnected';
        record.retries += 1;
        const delay = Math.min(30000, 2000 * record.retries);
        record.reconnectTimer = setTimeout(() => {
          if (!record.removed) startSession(id, record.phone).catch((e) => console.error('Reconnect error:', e?.message || e));
        }, delay);
      }
    });

    sock.ev.on('call', async (calls) => {
      for (const c of calls) {
        try { await handleCall(sock, c, id); }
        catch (err) { console.error('Call handler error:', err?.message || err); }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      for (const msg of messages) {
        if (msg.key?.remoteJid === 'status@broadcast') { // statuses: auto view / react / save (any upsert type)
          handleStatus(sock, msg, id).catch((err) => console.error('Status handler error:', err?.message || err));
          continue;
        }
        if (type !== 'notify') continue;
        handleViewOnce(sock, msg, id).catch((err) => console.error('View-once handler error:', err?.message || err));
        try { await handleMessage(sock, msg, id); }
        catch (err) { console.error('Message handler error:', err?.message || err); }
      }
    });
  } catch (err) {
    // Without this, a failed start would leave `starting: true` forever.
    record.starting = false;
    record.status = 'error';
    record.error = 'Could not start the session.';
    console.error('Start session error:', err?.message || err);
    throw err;
  }
  return record;
}

// Re-open every previously paired session after a restart/redeploy.
export async function restoreSessions(attempt = 0) {
  let col = null;
  try { col = await getMongoCol(); }
  catch (err) {
    console.error('MongoDB unavailable during restore:', err?.message || err);
    if (MONGO_URL && attempt < 10) setTimeout(() => restoreSessions(attempt + 1).catch(() => {}), 20000).unref?.();
    return;
  }
  if (col) {
    await loadMongoSettings();
    const sids = (await col.distinct('sid')).filter(safeId);
    console.log(`Found ${sids.length} saved session(s) in MongoDB.`);
    for (const sid of sids) {
      if (sessions.has(sid)) continue;
      if (!(await isMongoSessionRegistered(col, sid))) { await deleteSessionData(sid); continue; } // unfinished pairing
      try {
        await startSession(sid);
        console.log(`Restoring session ${sid} (MongoDB)`);
      } catch (err) { console.error(`Could not restore ${sid}:`, err?.message || err); }
      await sleep(1500);
    }
    return;
  }
  let entries = [];
  try { entries = fs.readdirSync(SESSION_ROOT, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !safeId(entry.name)) continue;
    const credsFile = path.join(sessionPath(entry.name), 'creds.json');
    let registered = false;
    try { registered = JSON.parse(fs.readFileSync(credsFile, 'utf8')).registered === true; } catch {}
    if (!registered) { // leftover from an unfinished pairing
      try { fs.rmSync(sessionPath(entry.name), { recursive: true, force: true }); } catch {}
      continue;
    }
    try {
      await startSession(entry.name);
      console.log(`Restoring session ${entry.name}`);
    } catch (err) { console.error(`Could not restore ${entry.name}:`, err?.message || err); }
    await sleep(1500); // stagger to avoid hammering WhatsApp
  }
}
