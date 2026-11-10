/* Views shared by the advisor and administrator dashboards: outbreak alerts, scan reports, cases. */

const OUTBREAK_LABEL = {
  suspected: 'Suspected', investigating: 'Investigating', confirmed: 'Confirmed', resolved: 'Resolved', false_alarm: 'False alarm',
};
const STAGE_COLOR = { none: '#7FA65B', early: '#D9A441', moderate: '#E08A3C', severe: '#C8503F' };
const ALERT_COLOR = { suspected: '#D9A441', investigating: '#5B9BD5', confirmed: '#C8503F', resolved: '#7FA65B', false_alarm: '#8E8A7A' };

let ME = null;

/* ---------------- outbreaks ---------------- */

let outbreakMap = null, outbreakLayer = null;

async function renderOutbreakList(container, filter) {
  clear(container);
  const bar = h('div.pills');
  const filters = [['active', 'Open'], ['suspected', 'Suspected'], ['investigating', 'Investigating'], ['confirmed', 'Confirmed'], ['resolved', 'Resolved'], ['false_alarm', 'False alarm'], ['', 'All']];
  filters.forEach(([v, l]) => bar.appendChild(h('button.pill' + (v === filter ? '.active' : ''), { type: 'button', onclick: () => renderOutbreakList(container, v) }, l)));
  container.appendChild(bar);
  const mapEl = h('div.map-box');
  container.appendChild(mapEl);
  const list = h('div.list', h('p.muted', 'Loading…'));
  container.appendChild(list);
  const d = await API.get('/api/outbreaks?action=list' + (filter ? '&status=' + filter : ''));
  clear(list);
  if (!d.alerts.length) list.appendChild(h('p.muted', filter === 'active' ? 'No open outbreak alerts. Alerts appear here automatically when several farmers report serious damage close together.' : 'No alerts.'));
  d.alerts.forEach((a) => list.appendChild(h('a.row-card', { href: '#outbreaks-' + a.id },
    h('div.row-top', h('span.row-title', '#' + a.id + ' ' + ([a.sector, a.district].filter(Boolean).join(', ') || 'Unnamed area')), pill(a.status, OUTBREAK_LABEL[a.status])),
    h('div.row-meta', h('span', a.farmerCount + ' farmers'), h('span', a.scanCount + ' scans'), a.maxStage ? stageBadge(a.maxStage) : null,
      h('span', 'radius ' + a.radiusKm + ' km'), h('span', 'last report ' + fmtAgo(a.lastReportAt)),
      h('span', a.assignedAdvisor ? 'Advisor: ' + a.assignedAdvisor.name : 'Unassigned')))));

  const map = makeMap(mapEl);
  if (map) {
    const pts = [];
    d.alerts.forEach((a) => {
      const c = ALERT_COLOR[a.status] || '#D9A441';
      L.circle([a.centerLat, a.centerLng], { radius: a.radiusKm * 1000, color: c, fillColor: c, fillOpacity: 0.18, weight: 2 })
        .bindPopup(h('div', h('strong', '#' + a.id + ' ' + OUTBREAK_LABEL[a.status]), h('br'), a.farmerCount + ' farmers · ', h('a', { href: '#outbreaks-' + a.id }, 'open')))
        .addTo(map);
      pts.push([a.centerLat, a.centerLng]);
    });
    if (pts.length) map.fitBounds(pts, { padding: [40, 40], maxZoom: 11 });
    setTimeout(() => map.invalidateSize(), 50);
  }
}

async function renderOutbreakDetail(container, id, role) {
  clear(container).appendChild(h('p.muted', 'Loading…'));
  const d = await API.get('/api/outbreaks?action=get&id=' + id);
  const a = d.alert;
  const where = [a.sector, a.district].filter(Boolean).join(', ') || a.centerLat.toFixed(4) + ', ' + a.centerLng.toFixed(4);
  clear(container);
  container.appendChild(h('button.secondary.small', { type: 'button', onclick: () => { location.hash = 'outbreaks'; } }, '← All alerts'));
  container.appendChild(h('h1', 'Outbreak #' + a.id + ' — ' + where));
  container.appendChild(h('div.meta-row', pill(a.status, OUTBREAK_LABEL[a.status]),
    h('span', a.farmerCount + ' independent farmers'), h('span', a.scanCount + ' scans'), a.maxStage ? stageBadge(a.maxStage) : null,
    h('span', 'radius ' + a.radiusKm + ' km'), h('span', 'threshold ' + a.thresholdFarmers + ' farmers / ' + a.windowDays + ' days')));
  container.appendChild(h('div.callout' + (a.status === 'confirmed' ? '.bad' : a.status === 'suspected' ? '.warn' : ''),
    a.status === 'suspected' ? 'Raised automatically from AI photo assessments. Nobody has checked it in the field yet. Visit the area and update the status.'
      : a.status === 'investigating' ? 'An advisor is checking this in the field.'
      : a.status === 'confirmed' ? 'Confirmed in the field by ' + (a.confirmedBy ? a.confirmedBy.name : 'an advisor') + ' on ' + fmtTime(a.confirmedAt) + '. Farmers in the area were warned by email.'
      : a.status === 'false_alarm' ? 'Checked and found to be a false alarm.' : 'Closed.'));

  const info = h('div.panel',
    h('div.kv', h('span', 'Reports from'), h('span', fmtTime(a.firstReportAt) + ' to ' + fmtTime(a.lastReportAt))),
    h('div.kv', h('span', 'Centre'), h('span', mapsLink(a.centerLat, a.centerLng))),
    h('div.kv', h('span', 'Assigned advisor'), h('span', a.assignedAdvisor ? a.assignedAdvisor.name : '—')),
    a.notes ? h('div.kv', h('span', 'Latest note'), h('span', a.notes)) : null);
  container.appendChild(info);

  const mapEl = h('div.map-box');
  container.appendChild(mapEl);

  // workflow
  const act = h('div.actions');
  const go = async (btn, status, required) => {
    const note = await askNote('Mark as "' + OUTBREAK_LABEL[status] + '"', {
      required, okLabel: 'Save',
      placeholder: required ? 'What did you find in the field? (shared with the team' + (status === 'confirmed' ? ' and the farmers in the area' : '') + ')' : 'Optional note',
    });
    if (note === null) return;
    const r = await busy(btn, () => API.post('/api/outbreaks?action=status&id=' + a.id, { status, note }));
    const e = r.email || {};
    const sent = (e.staff ? e.staff.sent : 0) + (e.farmers ? e.farmers.sent : 0);
    toast('Status saved' + (sent ? ' · ' + sent + ' email(s) sent' : ''), 'ok');
    renderOutbreakDetail(container, id, role);
  };
  const btn = (text, status, required, cls) => { const b = h('button' + (cls || ''), { type: 'button' }, text); b.onclick = () => go(b, status, required); return b; };
  if (a.status === 'suspected') act.append(btn('Start investigating', 'investigating', false), btn('Confirm outbreak', 'confirmed', true, '.danger'), btn('False alarm', 'false_alarm', true, '.secondary'));
  if (a.status === 'investigating') act.append(btn('Confirm outbreak', 'confirmed', true, '.danger'), btn('False alarm', 'false_alarm', true, '.secondary'));
  if (a.status === 'confirmed') act.append(btn('Mark resolved', 'resolved', false), btn('Back to investigating', 'investigating', false, '.secondary'));
  if (a.status === 'resolved' || a.status === 'false_alarm') act.append(btn('Reopen as suspected', 'suspected', false, '.secondary'));
  const noteBtn = h('button.secondary', { type: 'button' }, 'Add note');
  noteBtn.onclick = async () => {
    const note = await askNote('Add a note', { required: true });
    if (note === null) return;
    await busy(noteBtn, () => API.post('/api/outbreaks?action=note&id=' + a.id, { note }));
    renderOutbreakDetail(container, id, role);
  };
  act.appendChild(noteBtn);
  if (role === 'advisor' && (!a.assignedAdvisor || a.assignedAdvisor.id !== ME.id)) {
    const take = h('button.secondary', { type: 'button' }, 'Assign to me');
    take.onclick = async () => { await busy(take, () => API.post('/api/outbreaks?action=assign&id=' + a.id, {})); renderOutbreakDetail(container, id, role); };
    act.appendChild(take);
  }
  if (role === 'admin') {
    const sel = h('select', { 'aria-label': 'Assign advisor' }, h('option', { value: '' }, 'Unassigned'));
    API.get('/api/requests?action=advisors').then((x) => x.advisors.forEach((v) => sel.appendChild(h('option', { value: v.id, selected: a.assignedAdvisor && a.assignedAdvisor.id === v.id }, v.name))));
    const ab = h('button.secondary', { type: 'button' }, 'Assign');
    ab.onclick = async () => { await busy(ab, () => API.post('/api/outbreaks?action=assign&id=' + a.id, { advisorId: sel.value || null })); renderOutbreakDetail(container, id, role); };
    act.append(sel, ab);
  }
  container.appendChild(act);

  container.appendChild(h('h2.sub', 'History'));
  const tl2 = h('div.timeline');
  d.updates.forEach((u) => tl2.appendChild(h('div.tl-item',
    h('div.tl-head', fmtTime(u.createdAt), ' · ', u.by, u.oldStatus !== u.newStatus && u.newStatus ? [' · ', pill(u.newStatus, OUTBREAK_LABEL[u.newStatus])] : null),
    u.note ? h('div', u.note) : null)));
  container.appendChild(tl2);

  container.appendChild(h('h2.sub', 'Scan reports in this alert'));
  const list = h('div.list');
  d.scans.forEach((s) => list.appendChild(scanCardEl(s, { actions: [h('span.dist', s.distanceKm + ' km from centre')] })));
  container.appendChild(list);

  const map = makeMap(mapEl);
  if (map) {
    const c = ALERT_COLOR[a.status];
    L.circle([a.centerLat, a.centerLng], { radius: a.radiusKm * 1000, color: c, fillColor: c, fillOpacity: 0.12, weight: 2 }).addTo(map);
    const pts = [[a.centerLat, a.centerLng]];
    d.scans.forEach((s) => {
      if (s.lat == null) return;
      L.circleMarker([s.lat, s.lng], { radius: 7, color: '#1C2818', weight: 1, fillColor: STAGE_COLOR[s.stage], fillOpacity: 0.95 })
        .bindPopup(h('div', (s.farmer && s.farmer.name) || 'Farmer', h('br'), s.stage + ' · ' + fmtTime(s.createdAt))).addTo(map);
      pts.push([s.lat, s.lng]);
    });
    map.fitBounds(pts, { padding: [40, 40], maxZoom: 14 });
    setTimeout(() => map.invalidateSize(), 50);
  }
  window.scrollTo(0, 0);
}

async function renderOutbreaks(container, id, role) {
  if (id) return renderOutbreakDetail(container, id, role);
  return renderOutbreakList(container, 'active');
}

/* ---------------- scan reports ---------------- */

async function renderScanReports(container, opts) {
  opts = opts || {};
  const state = { stage: '', district: '', pest: opts.pest ?? '1', offset: 0 };
  clear(container);
  const stageSel = h('select', { 'aria-label': 'Damage stage' }, h('option', { value: '' }, 'All stages'), ...['severe', 'moderate', 'early', 'none'].map((s) => h('option', { value: s }, s)));
  const pestSel = h('select', { 'aria-label': 'Damage' }, h('option', { value: '1' }, 'Damage found'), h('option', { value: '' }, 'All scans'));
  pestSel.value = state.pest;
  const district = h('input', { type: 'text', placeholder: 'District', list: 'districts', 'aria-label': 'District' });
  const go = h('button.secondary', { type: 'button' }, 'Filter');
  container.appendChild(h('div.filters', stageSel, pestSel, district, go,
    opts.exportHref ? h('a.btn.secondary', { href: opts.exportHref }, 'Download CSV') : null));
  const count = h('p.muted');
  const list = h('div.list');
  const more = h('button.secondary', { type: 'button', style: { display: 'none' } }, 'Load more');
  container.append(count, list, h('div.actions', more));

  async function load(reset) {
    if (reset) { state.offset = 0; clear(list); }
    const q = new URLSearchParams({ action: 'list', limit: '30', offset: String(state.offset) });
    if (stageSel.value) q.set('stage', stageSel.value);
    if (pestSel.value) q.set('pest', '1');
    if (district.value.trim()) q.set('district', district.value.trim());
    const d = await API.get('/api/scans?' + q);
    count.textContent = d.total + ' scan report(s)' + (opts.scopeNote ? ' · ' + opts.scopeNote : '');
    d.scans.forEach((s) => list.appendChild(scanCardEl(s)));
    state.offset += d.scans.length;
    more.style.display = state.offset < d.total ? 'inline-block' : 'none';
  }
  go.onclick = () => load(true).catch((e) => toast(e.message, 'bad'));
  more.onclick = () => load(false).catch((e) => toast(e.message, 'bad'));
  await load(true);
}

/* ---------------- cases (help requests) ---------------- */

async function renderCases(container, id, role) {
  if (id) return renderRequestDetail(container, id, { role, me: ME, onBack: () => { location.hash = 'requests'; } });
  clear(container);
  container.appendChild(h('h1', role === 'admin' ? 'All help requests' : 'Farmer cases'));
  const filters = role === 'admin'
    ? [['active', 'Open'], ['unassigned', 'Unassigned'], ['resolved', 'Resolved'], ['closed', 'Closed'], ['', 'All']]
    : [['active', 'Open'], ['mine', 'Assigned to me'], ['unassigned', 'Unassigned'], ['resolved', 'Resolved'], ['', 'All']];
  const bar = h('div.pills');
  const list = h('div.list');
  container.append(bar, list);
  async function load(f) {
    bar.querySelectorAll('.pill').forEach((p) => p.classList.toggle('active', p.dataset.f === f));
    clear(list).appendChild(h('p.muted', 'Loading…'));
    const q = f === 'mine' ? 'status=active&mine=1' : f === 'unassigned' ? 'status=active&unassigned=1' : f ? 'status=' + f : '';
    const d = await API.get('/api/requests?action=list&' + q);
    clear(list);
    if (!d.requests.length) list.appendChild(h('p.muted', 'No requests here.'));
    d.requests.forEach((r) => list.appendChild(requestRowEl(r, '#requests-' + r.id, true)));
  }
  filters.forEach(([v, l]) => bar.appendChild(h('button.pill', { type: 'button', dataset: { f: v }, onclick: () => load(v).catch((e) => toast(e.message, 'bad')) }, l)));
  await load('active');
}

function statTile(n, text, href) {
  return h(href ? 'a.stat' : 'div.stat', href ? { href } : null, h('div.n', n === null || n === undefined ? '—' : String(n)), h('div.l', text));
}
