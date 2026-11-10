/* Shared browser helpers for every page: API calls, session, small DOM builder, formatting,
   toasts, modals and the header account bar. No framework.
   All text is inserted with textContent, so data from users or the AI can never inject HTML. */

/* ---------------- API ---------------- */

async function apiCall(method, url, body) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try { res = await fetch(url, opts); }
  catch { throw new Error('No connection. Check your internet and try again.'); }
  const raw = await res.text();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; }
  catch { throw new Error('Server returned ' + res.status + ': ' + raw.slice(0, 140)); }
  if (!res.ok || data.error) {
    const err = new Error(data.error || ('Request failed (' + res.status + ')'));
    err.status = res.status;
    throw err;
  }
  return data;
}
const API = {
  get: (u) => apiCall('GET', u),
  post: (u, b) => apiCall('POST', u, b || {}),
  put: (u, b) => apiCall('PUT', u, b || {}),
  del: (u) => apiCall('DELETE', u),
};

/* ---------------- session ---------------- */

let SESSION = null; // { user, profile, unreadNotifications }

async function loadSession() {
  try { SESSION = await API.get('/api/auth?action=me'); }
  catch { SESSION = { user: null }; }
  return SESSION;
}

function dashboardFor(role) {
  return role === 'admin' ? 'admin.html' : role === 'advisor' ? 'advisor.html' : 'farmer.html';
}

// Sends visitors to the login page and users with the wrong role to their own dashboard
async function requireRole(roles) {
  const s = await loadSession();
  if (!s.user) {
    location.replace('login.html?next=' + encodeURIComponent(location.pathname.replace(/^\//, '') + location.hash));
    return null;
  }
  if (!roles.includes(s.user.role)) {
    location.replace(dashboardFor(s.user.role) + location.hash);
    return null;
  }
  return s;
}

async function logout() {
  try { await API.post('/api/auth?action=logout'); } catch {}
  location.href = 'index.html';
}

/* ---------------- DOM ---------------- */

// h('div.card', { onclick, dataset, style, type, ... }, child, 'text', [children])
function h(tag, attrs, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'class') el.className += ' ' + v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  const add = (c) => {
    if (c === undefined || c === null || c === false) return;
    if (Array.isArray(c)) return c.forEach(add);
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  };
  children.forEach(add);
  return el;
}
const byId = (id) => document.getElementById(id);
function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

/* ---------------- formatting ---------------- */

function fmtTime(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }); }
  catch { return String(iso); }
}
function fmtAgo(iso) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  if (s < 86400 * 14) return Math.round(s / 86400) + ' d ago';
  return fmtTime(iso);
}
const pct = (x) => Math.round((Number(x) || 0) * 100) + '%';
const label = (s) => String(s || '').replace(/_/g, ' ');
function mapsLink(lat, lng) {
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  return h('a', { href: 'https://www.google.com/maps?q=' + lat.toFixed(5) + ',' + lng.toFixed(5), target: '_blank', rel: 'noopener' }, lat.toFixed(4) + ', ' + lng.toFixed(4));
}

const STATUS_TONE = {
  open: 'warn', in_progress: 'info', awaiting_farmer: 'muted', resolved: 'ok', closed: 'muted',
  suspected: 'warn', investigating: 'info', confirmed: 'bad', false_alarm: 'muted',
  sent: 'ok', failed: 'bad', pending: 'warn', skipped: 'muted',
  active: 'ok', suspended: 'bad',
  low: 'muted', normal: 'muted', high: 'warn', urgent: 'bad',
};
function pill(value, text) { return h('span.pill-status.' + (STATUS_TONE[value] || 'muted'), text || label(value)); }
function stageBadge(stage) { return h('span.badge.' + (stage || 'none'), typeof tl === 'function' ? tl('stage_', stage || 'none') : stage); }

/* ---------------- feedback ---------------- */

function toast(msg, kind) {
  let box = byId('toasts');
  if (!box) { box = h('div.toasts', { id: 'toasts' }); document.body.appendChild(box); }
  const t = h('div.toast' + (kind ? '.' + kind : ''), { role: 'status' }, msg);
  box.appendChild(t);
  setTimeout(() => t.classList.add('gone'), 4200);
  setTimeout(() => t.remove(), 4800);
}

function modal(title, body, actions) {
  const back = h('div.modal-back');
  const close = () => back.remove();
  const box = h('div.modal', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div.modal-head', h('h2', title), h('button.icon-btn', { type: 'button', 'aria-label': 'Close', onclick: close }, '×')),
    h('div.modal-body', body),
    actions ? h('div.modal-actions', actions) : null
  );
  back.appendChild(box);
  back.addEventListener('click', (e) => { if (e.target === back) close(); });
  document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } });
  document.body.appendChild(back);
  const first = box.querySelector('input, textarea, select');
  if (first) setTimeout(() => first.focus(), 30);
  return { close, el: box };
}

function confirmBox(title, text, okLabel) {
  return new Promise((resolve) => {
    let done = false;
    const m = modal(title, h('p', text), [
      h('button.secondary', { type: 'button', onclick: () => { done = true; m.close(); resolve(false); } }, 'Cancel'),
      h('button', { type: 'button', onclick: () => { done = true; m.close(); resolve(true); } }, okLabel || 'OK'),
    ]);
    const obs = new MutationObserver(() => { if (!document.body.contains(m.el) && !done) { resolve(false); obs.disconnect(); } });
    obs.observe(document.body, { childList: true });
  });
}

// runs fn while disabling the button and showing errors as a toast
async function busy(btn, fn) {
  const old = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  try { return await fn(); }
  catch (err) { toast(err.message, 'bad'); throw err; }
  finally { if (btn) { btn.disabled = false; btn.textContent = old; } }
}

function field(labelText, input, hint) {
  const id = input.id || ('f' + Math.random().toString(36).slice(2, 8));
  input.id = id;
  return h('div.field', h('label', { for: id }, labelText), input, hint ? h('div.hint', hint) : null);
}

/* ---------------- header account bar + notifications ---------------- */

function renderAccountBar(container, opts) {
  opts = opts || {};
  clear(container);
  const s = SESSION;
  if (!s || !s.user) {
    container.appendChild(h('a.btn.secondary.small', { href: 'login.html' }, opts.loginLabel || 'Log in'));
    container.appendChild(h('a.btn.small', { href: 'login.html#register' }, opts.registerLabel || 'Create account'));
    return;
  }
  const u = s.user;
  if (opts.showDashboardLink) container.appendChild(h('a.btn.small', { href: dashboardFor(u.role) }, opts.dashboardLabel || 'My dashboard'));
  const bell = h('button.icon-btn.bell', { type: 'button', 'aria-label': 'Notifications', title: 'Notifications', onclick: () => openNotifications(bell) }, '🔔',
    s.unreadNotifications ? h('span.dot', String(Math.min(99, s.unreadNotifications))) : null);
  container.appendChild(bell);
  container.appendChild(h('span.who', { title: u.email }, u.fullName.split(' ')[0], h('span.role', label(u.role))));
  container.appendChild(h('button.btn.secondary.small', { type: 'button', onclick: logout }, opts.logoutLabel || 'Log out'));
}

async function openNotifications(bell) {
  const list = h('div.notif-list', h('p.muted', 'Loading…'));
  const m = modal('Notifications', list, [
    h('button.secondary', { type: 'button', onclick: async () => { await API.post('/api/me?action=read', { all: true }); m.close(); refreshBell(bell); } }, 'Mark all read'),
  ]);
  try {
    const d = await API.get('/api/me?action=notifications');
    clear(list);
    if (!d.notifications.length) list.appendChild(h('p.muted', 'No notifications yet.'));
    d.notifications.forEach((n) => {
      list.appendChild(h('a.notif' + (n.read ? '' : '.unread'), {
        href: n.link || '#',
        onclick: async () => { try { await API.post('/api/me?action=read', { ids: [n.id] }); } catch {} m.close(); },
      }, h('div.notif-title', n.title), n.body ? h('div.notif-body', n.body) : null, h('div.notif-time', fmtAgo(n.createdAt))));
    });
  } catch (err) { clear(list).appendChild(h('p.warn', err.message)); }
}

async function refreshBell(bell) {
  try {
    const d = await API.get('/api/me?action=notifications&unread=1');
    if (SESSION) SESSION.unreadNotifications = d.unread;
    const dot = bell && bell.querySelector('.dot');
    if (dot) dot.remove();
    if (bell && d.unread) bell.appendChild(h('span.dot', String(Math.min(99, d.unread))));
  } catch {}
}

/* ---------------- tabs driven by the URL hash (#tab or #tab-123) ---------------- */

function setupTabs(names, onShow) {
  function show() {
    const raw = (location.hash || '').replace('#', '');
    const m = raw.match(/^([a-z]+)(?:-(\d+))?$/);
    let name = m ? m[1] : '';
    const idArg = m && m[2] ? Number(m[2]) : null;
    // links in emails use #request-12 / #outbreak-3
    const alias = { request: 'requests', outbreak: 'outbreaks', case: 'requests' };
    if (alias[name] && names.includes(alias[name])) name = alias[name];
    if (!names.includes(name)) name = names[0];
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
    document.querySelectorAll('.tabs [data-view]').forEach((b) => {
      b.classList.toggle('active', b.dataset.view === name);
      b.setAttribute('aria-current', b.dataset.view === name ? 'page' : 'false');
    });
    onShow(name, idArg);
  }
  document.querySelectorAll('.tabs [data-view]').forEach((b) => b.addEventListener('click', () => {
    if (location.hash === '#' + b.dataset.view) show(); else location.hash = b.dataset.view;
  }));
  window.addEventListener('hashchange', show);
  show();
}

/* ---------------- small map helper (Leaflet + OpenStreetMap) ---------------- */

function makeMap(el) {
  if (typeof L === 'undefined') { el.style.display = 'none'; return null; }
  el.style.display = 'block';
  const map = L.map(el, { scrollWheelZoom: false });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenStreetMap contributors' }).addTo(map);
  map.setView([-1.94, 29.87], 8); // Rwanda
  return map;
}

// Asks for an optional (or required) note in a modal. Resolves to the text, or null if cancelled.
function askNote(title, { required = false, placeholder = '', okLabel = 'Save' } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const ta = h('textarea', { rows: 4, maxlength: 2000, placeholder });
    const err = h('div.form-msg');
    const finish = (v) => { if (!settled) { settled = true; m.close(); resolve(v); } };
    const m = modal(title, [field(required ? 'Note (required)' : 'Note (optional)', ta), err], [
      h('button.secondary', { type: 'button', onclick: () => finish(null) }, 'Cancel'),
      h('button', { type: 'button', onclick: () => {
        if (required && !ta.value.trim()) { err.textContent = 'Please write a short note.'; err.className = 'form-msg bad'; return; }
        finish(ta.value.trim());
      } }, okLabel),
    ]);
    const obs = new MutationObserver(() => { if (!document.body.contains(m.el)) { obs.disconnect(); if (!settled) { settled = true; resolve(null); } } });
    obs.observe(document.body, { childList: true });
  });
}
