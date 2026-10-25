const $ = (id) => document.getElementById(id);
let pollTimer = null;
function show(html) { $('result').innerHTML = html; }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
async function api(url, options = {}) {
  const key = $('apikey').value.trim();
  const response = await fetch(url, { ...options, headers: { 'Content-Type':'application/json', 'x-api-key':key, ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
$('connect').addEventListener('click', async () => {
  clearInterval(pollTimer);
  const phone = $('phone').value.replace(/\D/g,'');
  if ($('apikey').value.trim().length < 12) { show('<span class="error">Enter the API key provided by the site owner.</span>'); return; }
  if (phone.length < 8 || phone.length > 15) { show('<span class="error">Enter a valid international phone number.</span>'); return; }
  $('connect').disabled = true;
  show('Starting a secure session…');
  try {
    const session = await api('/api/session', { method:'POST', body:JSON.stringify({phone}) });
    show(`<p class="status">Session started. Waiting for WhatsApp…</p><p>Session ID: ${esc(session.id)}</p><div id="details">Checking connection…</div>`);
    pollTimer = setInterval(() => poll(session.id), 2500);
    await poll(session.id);
  } catch (e) { show(`<span class="error">${esc(e.message)}</span>`); $('connect').disabled = false; }
});
let failures = 0;
async function poll(id) {
  try {
    const d = await api(`/api/session/${encodeURIComponent(id)}`);
    failures = 0;
    const details = document.getElementById('details');
    if (!details) return;
    let html = `<p class="status">Status: ${esc(d.status)}</p>`;
    if (d.pairCode) html += `<p>On WhatsApp, open Linked devices → Link a device → Link with phone number.</p><div class="code">${esc(d.pairCode)}</div>`;
    if (d.qrDataUrl) html += `<p>Or scan this QR from WhatsApp → Linked devices → Link a device.</p><img class="qr" alt="WhatsApp pairing QR code" src="${d.qrDataUrl}">`;
    if (d.status === 'connected') { html += '<p class="status">Connected successfully ✓</p>'; clearInterval(pollTimer); $('connect').disabled = false; }
    if (d.error) html += `<p class="error">${esc(d.error)}</p>`;
    if (['logged_out','pair_error','replaced','error'].includes(d.status)) { clearInterval(pollTimer); $('connect').disabled = false; }
    details.innerHTML = html;
  } catch (e) {
    const details = document.getElementById('details');
    // Tolerate brief network blips; stop only after repeated failures or a definite server answer.
    const definite = /expired|not found|Invalid|Too many|API key|configured/i.test(e.message);
    failures += 1;
    if (details) details.innerHTML = `<span class="error">${esc(e.message)}</span>`;
    if (definite || failures >= 5) { clearInterval(pollTimer); $('connect').disabled = false; }
  }
}
