/**
 * admin.js: ChessTB Admin Dashboard
 *
 * Client-side logic for templates/admin.html, which renders one of two
 * states depending on authentication:
 *   - Login form: wires the token input + login button to POST /admin/login,
 *     then reloads the page on success (the new session cookie makes the
 *     next GET /admin render the dashboard instead).
 *   - Dashboard: polls the cache-stats endpoint, renders the two cache
 *     cards and the thread-pool card, and wires the refresh/clear/logout
 *     buttons.
 * Kept as an external file - with clicks bound via addEventListener rather
 * than inline onclick="" - because the app's Content-Security-Policy
 * (`script-src 'self'`, set by app.py's after_request hook) blocks both
 * inline <script> bodies and inline event handler attributes.
 */

function _setStatus(elId, msg, cls) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = msg;
  el.className = 'status ' + (cls || '');
}
function setStatus(msg, cls)      { _setStatus('status-msg', msg, cls); }
function setLoginStatus(msg, cls) { _setStatus('login-status', msg, cls); }

const JSON_HEADERS = { 'Content-Type': 'application/json' };

async function login() {
  const input = document.getElementById('login-token-input');
  try {
    const r = await fetch('/admin/login', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ token: input.value }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok) {
      window.location.reload();
    } else {
      setLoginStatus(j.error || 'Login failed.', 'err');
    }
  } catch (e) {
    setLoginStatus('Cannot reach backend.', 'err');
  }
}

async function logout() {
  try {
    await fetch('/admin/logout', { method: 'POST' });
  } finally {
    window.location.reload();
  }
}

// A brand-new or just-cleared cache has 0 hits and 0 misses, and a
// misconfigured one can have maxsize 0 - both make the ratios below NaN
// or Infinity rather than a real percentage.
function _pct(value) {
  return Number.isFinite(value) ? value.toFixed(1) : '0.0';
}

function _renderStatRows(elId, rows) {
  const container = document.getElementById(elId);
  if (!container) return;
  container.innerHTML = '';
  for (const [label, value] of rows) {
    const row = document.createElement('div');
    row.className = 'stat';
    const labelEl = document.createElement('span');
    labelEl.className = 'label';
    labelEl.textContent = label;
    const valueEl = document.createElement('span');
    valueEl.className = 'value';
    valueEl.textContent = value;
    row.append(labelEl, valueEl);
    container.appendChild(row);
  }
}

function renderCache(elId, barId, data) {
  const pct = _pct(data.hit_rate * 100);
  document.getElementById(barId).style.width = pct + '%';
  _renderStatRows(elId, [
    ['Hit rate',   pct + '%'],
    ['Hits',       data.hits.toLocaleString()],
    ['Misses',     data.misses.toLocaleString()],
    ['Used',       data.currsize.toLocaleString() + ' / ' + data.maxsize.toLocaleString()],
    ['Fill',       _pct((data.currsize / data.maxsize) * 100) + '%'],
  ]);
}

function renderPool(data) {
  _renderStatRows('stats-pool', [
    ['Max workers',        data.thread_pool.max_workers],
    ['Parallel threshold', data.thread_pool.parallel_threshold + ' child positions'],
    ['Probe timeout',      data.thread_pool.probe_timeout_secs + ' s'],
    ['Eval cache size',    data.config.evaluate_cache_size.toLocaleString()],
    ['Probe cache size',   data.config.probe_cache_size.toLocaleString()],
    ['Block cache size',   (data.config.block_cache_bytes / (1024 * 1024)).toLocaleString() + ' MB'],
  ]);
}

async function loadStats() {
  try {
    const r = await fetch('/admin/cache/stats');   // bodyless GET - no request body means no Content-Type to declare
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      setStatus('Error ' + r.status + ': ' + (j.error || r.statusText), 'err');
      return;
    }
    const data = await r.json();
    renderCache('stats-eval',       'bar-eval',       data.evaluate_fen_cache);
    renderCache('stats-probe',      'bar-probe',      data.probe_fen_cache);
    renderPool(data);
    document.getElementById('last-updated').textContent =
      'Last updated: ' + new Date().toLocaleTimeString();
    setStatus('');
  } catch (e) {
    setStatus('Cannot reach backend.', 'err');
  }
}

async function clearCaches() {
  if (!confirm('Clear all caches? This will slow down the next few probes.')) return;
  try {
    const r = await fetch('/admin/cache/clear', { method: 'POST', headers: JSON_HEADERS });
    const j = await r.json().catch(() => ({}));
    if (r.ok) {
      setStatus('Caches cleared successfully.', 'ok');
      loadStats();
    } else {
      setStatus('Error: ' + (j.error || r.statusText), 'err');
    }
  } catch (e) {
    setStatus('Cannot reach backend.', 'err');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const loginBtn = document.getElementById('login-btn');
  if (loginBtn) {
    loginBtn.addEventListener('click', login);
    document.getElementById('login-token-input')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') login();
    });
    return;   // login page only - the dashboard elements below are not rendered
  }

  document.getElementById('logout-btn')?.addEventListener('click', logout);
  document.getElementById('refresh-btn')?.addEventListener('click', loadStats);
  document.getElementById('clear-btn')?.addEventListener('click', clearCaches);

  loadStats();
  let countdown = 5;
  setInterval(() => {
    countdown--;
    if (countdown <= 0) {
      countdown = 5;
      loadStats();
    }
    const el = document.getElementById('next-refresh');
    if (el) el.textContent = 'Auto-refreshes in ' + countdown + ' s';
  }, 1000);
});
