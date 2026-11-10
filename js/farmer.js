/* Farmer dashboard: overview, scanning, history, help requests, nearby help, assistant, farm profile. */

let ME = null;
let historyOffset = 0;
const PAGE = 30;

function applyLang() {
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  document.querySelectorAll('[data-q-key]').forEach((el) => { el.dataset.q = t(el.dataset.qKey); });
  refreshResultLabels();
  if (ME) renderAccountBar($('accountBar'), { logoutLabel: t('logout') });
}
$('langSelect').value = lang;
$('langSelect').addEventListener('change', () => {
  lang = $('langSelect').value;
  try { localStorage.setItem('lang', lang); } catch {}
  applyLang();
  API.put('/api/me?action=profile', { preferredLang: lang }).catch(() => {});
  if (currentTab) onTab(currentTab, currentId);
});

/* ---------------- data caches used by nearby.js ---------------- */

function toLegacyScan(s) {
  return { id: s.id, ts: s.createdAt, stage: s.stage, confidence: s.confidence, affectedArea: s.affectedArea, recommendation: s.recommendation,
    riskLevel: s.riskLevel, riskScore: s.riskScore, lat: s.lat, lng: s.lng, locSource: s.locSource, thumb: s.thumb };
}
async function loadProfile() {
  const p = await API.get('/api/me?action=profile');
  ME = p.user;
  const f = p.farm || {};
  FARM_CACHE = { farmName: f.farmName, farmerName: ME.fullName, phone: ME.phone, district: ME.district, sector: ME.sector, lat: f.lat, lng: f.lng, village: f.village, farmSizeHa: f.farmSizeHa };
  return p;
}
async function refreshScansCache() {
  try {
    const d = await API.get('/api/scans?action=list&limit=40');
    SCANS_CACHE = d.scans.map(toLegacyScan);
    return d;
  } catch { return { scans: [], total: 0 }; }
}

/* ---------------- overview ---------------- */

async function renderOverview() {
  $('hello').textContent = (lang === 'rw' ? 'Muraho, ' : 'Hello, ') + ME.fullName.split(' ')[0];
  $('farmMissing').style.display = typeof FARM_CACHE.lat === 'number' ? 'none' : 'flex';
  const [scans, reqs, near] = await Promise.all([
    API.get('/api/scans?action=list&limit=5'),
    API.get('/api/requests?action=list&limit=5'),
    API.get('/api/outbreaks?action=nearby').catch(() => ({ alerts: [] })),
  ]);
  const warn = clear($('warnings'));
  near.alerts.forEach((a) => warn.appendChild(h('div.callout.bad',
    h('strong', 'Confirmed fall armyworm outbreak near you'),
    h('div', [a.sector, a.district].filter(Boolean).join(', ') || 'your area', a.distanceKm != null ? ' · about ' + a.distanceKm + ' km from your farm' : '', ' · confirmed ' + fmtAgo(a.confirmedAt)),
    a.notes ? h('div.muted', 'Advisor: ' + a.notes) : null,
    h('div', 'Scout your maize every 2–3 days and ask for help early.'))));

  const pest = await API.get('/api/scans?action=list&pest=1&limit=1');
  const open = reqs.requests.filter((r) => ['open', 'in_progress', 'awaiting_farmer'].includes(r.status)).length;
  clear($('farmerStats')).append(
    statTile(scans.total, t('st_scans')),
    statTile(pest.total, t('st_damage')),
    statTile(open, t('st_openReq')));

  const ov = clear($('ovScans'));
  if (!scans.scans.length) ov.appendChild(h('p.muted', t('historyEmpty')));
  scans.scans.slice(0, 3).forEach((s) => ov.appendChild(scanCardEl(s)));
  const or = clear($('ovRequests'));
  if (!reqs.requests.length) or.appendChild(h('p.muted', t('noRequests')));
  reqs.requests.slice(0, 3).forEach((r) => or.appendChild(requestRowEl(r, '#requests-' + r.id)));
}
function statTile(n, text) { return h('div.stat', h('div.n', String(n ?? '—')), h('div.l', text)); }

/* ---------------- scan ---------------- */

initScanner({
  fileInput: $('fileInput'), dropzone: $('dropzone'), preview: $('preview'),
  scanBtn: $('scanBtn'), clearBtn: $('clearBtn'), loading: $('loading'),
  onClear: resetResult,
  onScan: async (photo) => {
    resetResult();
    try {
      const loc = await getLocation();
      const d = await API.post('/api/scans', { ...photo, lang, lat: loc.lat, lng: loc.lng, locSource: loc.source });
      renderFull(d.scan, d.spread, d.outbreak);
      refreshScansCache();
    } catch (err) { showResultError(err.message); }
  },
});

async function claimPending() {
  const p = pendingScanGet();
  if (!p) return;
  $('loading').style.display = 'block';
  try {
    const loc = await getLocation();
    const d = await API.post('/api/scans?action=claim', { scanId: p.scanId, claimToken: p.claimToken, lat: loc.lat, lng: loc.lng, locSource: loc.source });
    pendingScanClear();
    renderFull(d.scan, d.spread, d.outbreak);
    toast(t('claimDone'), 'ok');
    refreshScansCache();
  } catch (err) {
    pendingScanClear();
    if (err.status !== 401) toast(err.message, 'bad');
  } finally { $('loading').style.display = 'none'; }
}

$('scanHelpBtn').addEventListener('click', () => { if (lastScan) openNewRequest(lastScan.id); });
$('askAiBtn').addEventListener('click', () => { location.hash = 'assistant'; });
$('emailMeBtn').addEventListener('click', async () => {
  if (!lastScan) return;
  const d = await busy($('emailMeBtn'), () => API.post('/api/alert', { channel: 'email', scanId: lastScan.id, lang }));
  toast(t('sentEmail') + ' (' + d.to + ')', 'ok');
});
$('tgBtn').addEventListener('click', async () => {
  if (!lastScan) return;
  const to = $('tgInput').value.trim();
  if (!to) return toast(t('enterChat'), 'bad');
  await busy($('tgBtn'), () => API.post('/api/alert', { channel: 'telegram', to, scanId: lastScan.id, lang }));
  lsSet('tgChat', to);
  toast(t('sentTelegram'), 'ok');
});
$('tgInput').value = lsGet('tgChat', '') || '';

/* ---------------- history ---------------- */

async function renderHistory(reset) {
  if (reset) { historyOffset = 0; clear($('historyList')); }
  const d = await API.get(`/api/scans?action=list&limit=${PAGE}&offset=${historyOffset}`);
  if (reset && !d.scans.length) $('historyList').appendChild(h('p.muted', t('historyEmpty')));
  d.scans.forEach((s) => {
    const help = h('button.btn.secondary', { type: 'button', onclick: () => openNewRequest(s.id) }, t('requestHelp'));
    const share = h('button.btn.secondary', { type: 'button', onclick: () => { selectedReportId = s.id; location.hash = 'nearby'; } }, t('h_share'));
    const del = h('button.btn.secondary', { type: 'button' }, t('h_delete'));
    del.onclick = async () => {
      if (!(await confirmBox(t('h_delete'), t('confirmDelete'), t('h_delete')))) return;
      await busy(del, () => API.del('/api/scans?id=' + s.id));
      toast(t('deleted'), 'ok');
      renderHistory(true);
      refreshScansCache();
    };
    $('historyList').appendChild(scanCardEl(s, { actions: [help, share, s.alertId ? null : del] }));
  });
  historyOffset += d.scans.length;
  $('historyMore').style.display = historyOffset < d.total ? 'inline-block' : 'none';
}
$('historyMore').addEventListener('click', () => renderHistory(false));

/* ---------------- requests ---------------- */

async function renderRequests(id) {
  if (id) {
    $('reqListPane').style.display = 'none';
    $('reqDetailPane').style.display = 'block';
    return renderRequestDetail($('reqDetailPane'), id, { role: 'farmer', me: ME, onBack: () => { location.hash = 'requests'; } });
  }
  $('reqDetailPane').style.display = 'none';
  $('reqListPane').style.display = 'block';
  const list = clear($('reqList'));
  const d = await API.get('/api/requests?action=list');
  if (!d.requests.length) list.appendChild(h('p.muted', t('noRequests')));
  d.requests.forEach((r) => list.appendChild(requestRowEl(r, '#requests-' + r.id)));
}

async function openNewRequest(scanId) {
  const recent = await API.get('/api/scans?action=list&limit=15').catch(() => ({ scans: [] }));
  const subject = h('input', { type: 'text', maxlength: 150, placeholder: t('reqSubjectPh') });
  const message = h('textarea', { rows: 5, maxlength: 3000, placeholder: t('reqMessagePh') });
  const scanSel = h('select', h('option', { value: '' }, t('reqNoScan')),
    ...recent.scans.map((s) => h('option', { value: s.id, selected: Number(scanId) === s.id }, fmtTime(s.createdAt) + ' — ' + tl('stage_', s.stage))));
  const prio = h('select', ...['normal', 'high', 'urgent', 'low'].map((p) => h('option', { value: p }, t('prio_' + p))));
  const scan = recent.scans.find((s) => s.id === Number(scanId));
  if (scan && scan.pestDetected) subject.value = t('reqDefaultSubject', { stage: tl('stage_', scan.stage) });
  const err = h('div.form-msg');
  const send = h('button', { type: 'button' }, t('sendRequest'));
  const m = modal(t('newRequest'), [
    h('p.muted', typeof FARM_CACHE.lat === 'number' ? t('reqWhere') : t('reqNoFarm')),
    field(t('reqSubject'), subject), field(t('reqMessage'), message), field(t('reqScan'), scanSel), field(t('reqPriority'), prio), err,
  ], [h('button.secondary', { type: 'button', onclick: () => m.close() }, t('cancel')), send]);
  send.onclick = async () => {
    err.textContent = '';
    try {
      const d = await busy(send, () => API.post('/api/requests?action=create', {
        subject: subject.value, message: message.value, scanId: scanSel.value || undefined, priority: prio.value,
      }));
      m.close();
      toast(t('reqSent'), 'ok');
      location.hash = 'requests-' + d.request.id;
    } catch (e) { err.textContent = e.message; err.className = 'form-msg bad'; }
  };
}
$('newReqBtn').addEventListener('click', () => openNewRequest());
$('ovNewReq').addEventListener('click', () => openNewRequest());

/* ---------------- assistant (same behaviour as before, now for logged-in users) ---------------- */

const chatHistory = [];
function addChatMsg(role, text) {
  const div = mk('div', 'chat-msg ' + (role === 'user' ? 'chat-user' : 'chat-bot'), text);
  $('chatLog').appendChild(div);
  $('chatLog').scrollTop = $('chatLog').scrollHeight;
  return div;
}
async function sendChat(text) {
  text = (text || '').trim();
  if (!text || $('chatSend').disabled) return;
  $('chatInput').value = '';
  addChatMsg('user', text);
  chatHistory.push({ role: 'user', text });
  $('chatSend').disabled = true;
  const pending = addChatMsg('model', t('thinking'));
  try {
    const latest = lastScan || (SCANS_CACHE[0] ? { stage: SCANS_CACHE[0].stage, affectedArea: SCANS_CACHE[0].affectedArea, recommendation: SCANS_CACHE[0].recommendation, riskLevel: SCANS_CACHE[0].riskLevel } : null);
    const context = latest ? { stage: latest.stage, affectedArea: latest.affectedArea, recommendation: latest.recommendation, riskLevel: latest.riskLevel || '' } : null;
    const d = await API.post('/api/chat', { messages: chatHistory.slice(-7), context, lang });
    pending.textContent = d.reply;
    chatHistory.push({ role: 'model', text: d.reply });
  } catch (err) {
    pending.textContent = t('chatFail') + err.message;
    chatHistory.pop();
  } finally {
    $('chatSend').disabled = false;
  }
}
$('chatSend').addEventListener('click', () => sendChat($('chatInput').value));
$('chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendChat($('chatInput').value); } });
document.querySelectorAll('.chip').forEach((b) => b.addEventListener('click', () => sendChat(b.dataset.q)));

/* ---------------- farm profile ---------------- */

function renderFarm() {
  const f = FARM_CACHE;
  $('farmerName').value = ME.fullName || '';
  $('farmPhone').value = ME.phone || '';
  $('farmName').value = f.farmName || '';
  $('farmDistrict').value = ME.district || '';
  $('farmSector').value = ME.sector || '';
  $('farmVillage').value = f.village || '';
  $('farmSize').value = f.farmSizeHa ?? '';
  $('farmLat').value = typeof f.lat === 'number' ? f.lat : '';
  $('farmLng').value = typeof f.lng === 'number' ? f.lng : '';
  $('farmEmails').checked = ME.emailNotifications !== false;
  $('farmStatus').textContent = '';
}
$('farmUseLoc').addEventListener('click', async () => {
  $('farmStatus').textContent = t('f_locating');
  const g = await getGps(10000, 0);
  if (!g) { $('farmStatus').textContent = t('f_noGps'); return; }
  $('farmLat').value = g.lat.toFixed(5);
  $('farmLng').value = g.lng.toFixed(5);
  $('farmStatus').textContent = t('f_located');
});
$('farmForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const lat = parseCoord($('farmLat').value);
  const lng = parseCoord($('farmLng').value);
  const bothEmpty = lat === null && lng === null;
  const valid = !bothEmpty && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  if (!bothEmpty && !valid) { $('farmStatus').textContent = t('f_badCoords'); return; }
  try {
    await busy($('farmSave'), () => API.put('/api/me?action=profile', {
      fullName: $('farmerName').value, phone: $('farmPhone').value, district: $('farmDistrict').value, sector: $('farmSector').value,
      emailNotifications: $('farmEmails').checked, preferredLang: lang,
      farm: { farmName: $('farmName').value, village: $('farmVillage').value, farmSizeHa: $('farmSize').value, lat: valid ? lat : null, lng: valid ? lng : null },
    }));
    await loadProfile();
    gpsCache = null;
    $('farmStatus').textContent = t('f_saved_db');
    toast(t('f_saved_db'), 'ok');
  } catch (err) { $('farmStatus').textContent = err.message; }
});
$('pwForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  await busy($('pwBtn'), () => API.post('/api/auth?action=change-password', { currentPassword: $('pwCur').value, newPassword: $('pwNew').value }));
  $('pwCur').value = $('pwNew').value = '';
  toast(t('pwChanged'), 'ok');
});

function storedLang() { try { return localStorage.getItem('lang'); } catch { return null; } }

/* ---------------- tabs ---------------- */

let currentTab = null, currentId = null;
async function onTab(name, id) {
  currentTab = name; currentId = id;
  try {
    if (name === 'overview') await renderOverview();
    else if (name === 'history') await renderHistory(true);
    else if (name === 'requests') await renderRequests(id);
    else if (name === 'nearby') await renderNearby(false);
    else if (name === 'farm') renderFarm();
  } catch (err) { toast(err.message, 'bad'); }
  window.scrollTo(0, 0);
}

(async function start() {
  const s = await requireRole(['farmer']);
  if (!s) return;
  await loadProfile();
  if (ME.preferredLang && !storedLang() && ME.preferredLang !== lang) { lang = ME.preferredLang; $('langSelect').value = lang; }
  applyLang();
  fillDistricts();
  initNearby();
  await refreshScansCache();
  if (pendingScanGet()) location.hash = 'scan';
  setupTabs(['overview', 'scan', 'history', 'requests', 'nearby', 'assistant', 'farm'], onTab);
  claimPending();
  const q = new URLSearchParams(location.search);
  if (q.get('scan')) { history.replaceState(null, '', 'farmer.html' + location.hash); openNewRequest(Number(q.get('scan'))); }
  setInterval(() => refreshBell(document.querySelector('.bell')), 60000);
})();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
}
