const $ = (id) => document.getElementById(id);
const SESSION_MS = 5 * 60 * 1000; // matches the server's unpaired-session timeout
let pollTimer = null, tickTimer = null, failures = 0, startedAt = 0;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function setStep(n) {
  [...$('steps').children].forEach((li, i) => {
    li.classList.toggle('done', i + 1 < n || n === 4 && i + 1 === 4);
    li.classList.toggle('on', i + 1 === n && n !== 4);
  });
}
function show(html) { const r = $('result'); r.hidden = false; r.innerHTML = html; }
function setLoading(on) { const b = $('connect'); b.disabled = on; b.classList.toggle('loading', on); b.querySelector('.label').textContent = on ? 'Working…' : 'Generate Pair Code'; }
function stopAll() { clearInterval(pollTimer); clearInterval(tickTimer); }

/* ---------- live bot counter ---------- */
let shown = 0;
function countTo(target) {
  const el = $('online'); const from = shown; const t0 = performance.now();
  (function step(t) {
    const p = Math.min(1, (t - t0) / 700);
    shown = Math.round(from + (target - from) * (1 - Math.pow(1 - p, 3)));
    el.textContent = shown;
    if (p < 1) requestAnimationFrame(step);
  })(t0);
}
async function loadOnline() {
  try { const d = await (await fetch('/health')).json(); countTo(Number(d.activeSessions) || 0); } catch { /* keep last value */ }
}
loadOnline(); setInterval(loadOnline, 30000);

/* ---------- connect ---------- */
$('phone').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, ''); $('phone').parentElement.classList.remove('bad'); });
$('phone').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('connect').click(); });

$('connect').addEventListener('click', async () => {
  stopAll(); failures = 0;
  const phone = $('phone').value.replace(/\D/g, '');
  if (phone.length < 8 || phone.length > 15) {
    const f = $('phone').parentElement; f.classList.remove('bad'); void f.offsetWidth; f.classList.add('bad');
    show('<p class="error">Enter a valid number with country code, e.g. 947XXXXXXXX.</p>');
    return;
  }
  setLoading(true); setStep(2);
  show('<p class="status"><span class="dot"></span>Starting a secure session…</p><div id="details"></div>');
  try {
    const session = await api('/api/session', { method: 'POST', body: JSON.stringify({ phone }) });
    startedAt = Date.now();
    pollTimer = setInterval(() => poll(session.id), 2500);
    tickTimer = setInterval(tick, 1000);
    await poll(session.id);
  } catch (e) { fail(e.message); }
});

function fail(message) {
  stopAll(); setLoading(false); setStep(1);
  show(`<p class="error">${esc(message)}</p>`);
}

function tick() {
  const left = Math.max(0, SESSION_MS - (Date.now() - startedAt));
  const t = document.getElementById('timer'), bar = document.getElementById('barfill');
  if (t) t.textContent = `Code expires in ${Math.floor(left / 60000)}:${String(Math.floor(left / 1000) % 60).padStart(2, '0')}`;
  if (bar) bar.style.transform = `scaleX(${left / SESSION_MS})`;
  if (left === 0) fail('This code expired. Tap Generate Pair Code to get a new one.');
}

const STATUS_TEXT = {
  starting: 'Starting a secure session…',
  waiting_for_scan: 'Preparing your pair code…',
  waiting_for_pair: 'Waiting for you to enter the code on WhatsApp…',
  disconnected: 'Reconnecting…'
};

function codeTiles(code) {
  let i = 0;
  return String(code).split('').map((ch) => ch === '-'
    ? '<span class="sep">-</span>'
    : `<span class="d" style="animation-delay:${(i++) * 60}ms">${esc(ch)}</span>`).join('');
}

let lastCode = '';
async function poll(id) {
  try {
    const d = await api(`/api/session/${encodeURIComponent(id)}`);
    failures = 0;

    if (d.status === 'connected') { stopAll(); setLoading(false); success(); return; }
    if (d.error) { fail(d.error); return; }
    if (['logged_out', 'pair_error', 'replaced', 'error'].includes(d.status)) { fail('Something went wrong. Please generate a new code.'); return; }

    if (d.pairCode || d.qrDataUrl) setStep(3);
    let html = `<p class="status"><span class="dot"></span>${esc(STATUS_TEXT[d.status] || d.status)}</p>`;
    if (d.pairCode) {
      html += `<p class="msg">Open <b>WhatsApp → Linked devices → Link a device → Link with phone number</b>, then type this code:</p>
        <div class="code" id="code">${codeTiles(d.pairCode)}</div>
        <button class="copy" id="copy" type="button">Copy code</button>`;
    }
    if (d.qrDataUrl) html += `<details><summary>Prefer a QR code?</summary><img class="qr" alt="WhatsApp pairing QR code" src="${d.qrDataUrl}"></details>`;
    html += '<p class="timer" id="timer"></p><div class="bar"><span id="barfill"></span></div>';

    // Only rebuild when something changed, so the digit animation does not replay every poll.
    const sig = `${d.status}|${d.pairCode || ''}|${d.qrDataUrl ? 1 : 0}`;
    if (sig !== lastCode) { lastCode = sig; show(html); const c = document.getElementById('copy'); if (c) c.onclick = () => copyCode(d.pairCode); }
    tick();
  } catch (e) {
    failures += 1;
    const definite = /expired|not found|Invalid|Too many|full|already/i.test(e.message);
    if (definite || failures >= 5) fail(e.message);
  }
}

async function copyCode(code) {
  const btn = document.getElementById('copy');
  try { await navigator.clipboard.writeText(String(code).replace(/-/g, '')); btn.textContent = 'Copied ✓'; }
  catch { btn.textContent = 'Select the code and copy it'; }
  setTimeout(() => { if (btn) btn.textContent = 'Copy code'; }, 1800);
}

function success() {
  setStep(4); lastCode = '';
  show(`<div class="ok">
    <svg class="check" viewBox="0 0 80 80"><circle cx="40" cy="40" r="27"/><path d="M28 41l9 9 17-19"/></svg>
    <h3>Connected successfully!</h3>
    <p>Your WhatsApp is linked to <b>RIO X MD</b>.</p>
    <p>Open any chat and send <code>.menu</code> or <code>.alive</code>.</p>
  </div>`);
  confetti(); loadOnline();
}

function confetti() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const colors = ['#25f4ee', '#fe2c55', '#ffffff', '#7c3aed'];
  for (let i = 0; i < 40; i++) {
    const el = document.createElement('i');
    el.className = 'confetti';
    el.style.left = Math.random() * 100 + 'vw';
    el.style.background = colors[i % colors.length];
    el.style.animationDuration = 1.8 + Math.random() * 1.8 + 's';
    el.style.animationDelay = Math.random() * 0.5 + 's';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 4500);
  }
}
