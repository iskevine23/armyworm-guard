/* Administrator dashboard. The server checks role = admin on every call; this page only displays. */
lang = 'en';
const ROLE_LABEL = { farmer: 'Farmer', advisor: 'Advisor', admin: 'Administrator' };

/* ---------------- overview ---------------- */

const sumBy = (rows, key, val) => rows.filter((r) => !key || r[key[0]] === key[1]).reduce((s, r) => s + (r[val || 'n'] || 0), 0);

async function renderOverview() {
  const [hl, st] = await Promise.all([API.get('/api/admin?action=health'), API.get('/api/admin?action=stats')]);
  const health = clear(byId('health'));
  const item = (ok, name, okText, badText, title) =>
    h('div.health-item.' + (ok ? 'ok' : 'bad'), title ? { title } : null, h('span.dotc'), h('strong', name), h('span', ok ? okText : badText));
  health.append(
    item(hl.database, 'Database',
      'connected' + (hl.dbTarget ? ` · ${hl.dbTarget.host || '?'} / ${hl.dbTarget.user || '?'} / ${hl.dbTarget.database || '?'}` : ''),
      hl.dbError ? `not reachable (${hl.dbError.code || 'error'}) — ${hl.dbError.message}` : 'not reachable — check DATABASE_URL',
      hl.dbHelp || ''),
    item(hl.email, 'Email', (hl.emailProvider || '') + (hl.emailFrom ? ' · from ' + hl.emailFrom : ''), 'not configured — set SMTP_* or GMAIL_* variables'),
    item(hl.gemini, 'AI (Gemini)', 'configured', 'GEMINI_API_KEY missing'),
    item(!!hl.appUrl, 'APP_URL', hl.appUrl || '', 'not set — email links use the request address'));

  const users = st.users;
  const openReq = sumBy(st.requests, ['status', 'open']) + sumBy(st.requests, ['status', 'in_progress']) + sumBy(st.requests, ['status', 'awaiting_farmer']);
  const openAlerts = sumBy(st.alerts, ['status', 'suspected']) + sumBy(st.alerts, ['status', 'investigating']) + sumBy(st.alerts, ['status', 'confirmed']);
  clear(byId('adminStats')).append(
    statTile(sumBy(users, ['role', 'farmer']), 'Farmers', '#users'),
    statTile(sumBy(users, ['role', 'advisor']), 'Advisors', '#users'),
    statTile(st.scans.total, 'Scans saved', '#scans'),
    statTile(st.scans.week, 'Scans this week', '#scans'),
    statTile(st.scans.pest, 'Scans with damage', '#scans'),
    statTile(openReq, 'Open help requests', '#requests'),
    statTile(openAlerts, 'Open outbreak alerts', '#outbreaks'),
    statTile(st.avgFirstResponseHours == null ? '—' : st.avgFirstResponseHours + ' h', 'Avg. first advisor reply (90 d)'),
    statTile(sumBy(st.emails, ['status', 'sent']), 'Emails sent (30 d)', '#emails'),
    statTile(sumBy(st.emails, ['status', 'failed']), 'Emails failed (30 d)', '#emails'));

  // 30-day bar chart (inline SVG)
  const chart = clear(byId('chart'));
  const max = Math.max(1, ...st.perDay.map((d) => d.scans));
  const W = 1000, H = 160, bw = W / st.perDay.length;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H + 18}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Scans per day; darker part = scans with damage');
  st.perDay.forEach((d, i) => {
    const total = (d.scans / max) * H, pest = (d.pest / max) * H;
    const r1 = document.createElementNS(svg.namespaceURI, 'rect');
    Object.entries({ x: i * bw + 1, y: H - total, width: bw - 2, height: Math.max(0, total), class: 'bar-all' }).forEach(([k, v]) => r1.setAttribute(k, v));
    const r2 = document.createElementNS(svg.namespaceURI, 'rect');
    Object.entries({ x: i * bw + 1, y: H - pest, width: bw - 2, height: Math.max(0, pest), class: 'bar-pest' }).forEach(([k, v]) => r2.setAttribute(k, v));
    const tt = document.createElementNS(svg.namespaceURI, 'title');
    tt.textContent = `${d.day}: ${d.scans} scans, ${d.pest} with damage`;
    r1.appendChild(tt);
    svg.append(r1, r2);
    if (i % 5 === 0 || i === st.perDay.length - 1) {
      const tx = document.createElementNS(svg.namespaceURI, 'text');
      Object.entries({ x: i === 0 ? 0 : i === st.perDay.length - 1 ? W : i * bw + bw / 2, y: H + 14, 'text-anchor': i === 0 ? 'start' : i === st.perDay.length - 1 ? 'end' : 'middle', class: 'axis' }).forEach(([k, v]) => tx.setAttribute(k, v));
      tx.textContent = d.day.slice(5);
      svg.appendChild(tx);
    }
  });
  chart.append(svg, h('div.legend', h('span.sw.all'), 'all scans ', h('span.sw.pest'), 'with damage', ' · peak ' + max + '/day'));

  const tbl = h('table.data', h('thead', h('tr', h('th', 'District'), h('th', 'Scans'), h('th', 'With damage'), h('th', 'Moderate/severe'))),
    h('tbody', st.districts.map((d) => h('tr', h('td', d.district), h('td', d.scans), h('td', d.pest), h('td', d.serious)))));
  clear(byId('districtTable')).appendChild(st.districts.length ? h('div.table-wrap', tbl) : h('p.muted', 'No scans in the last 30 days.'));
}

/* ---------------- users ---------------- */

async function renderUsers() {
  const q = new URLSearchParams({ action: 'users', limit: '200' });
  if (byId('uQ').value.trim()) q.set('q', byId('uQ').value.trim());
  if (byId('uRole').value) q.set('role', byId('uRole').value);
  if (byId('uStatus').value) q.set('status', byId('uStatus').value);
  const d = await API.get('/api/admin?' + q);
  byId('uCount').textContent = d.total + ' user(s)' + (d.total > d.users.length ? ' (showing ' + d.users.length + ')' : '');
  const rows = d.users.map((u) => h('tr',
    h('td', { 'data-label': 'Name' }, h('strong', u.fullName), h('div.muted', u.email)),
    h('td', { 'data-label': 'Role' }, ROLE_LABEL[u.role], u.role === 'advisor' && u.coverageDistricts.length ? h('div.muted', u.coverageDistricts.join(', ')) : null),
    h('td', { 'data-label': 'Status' }, pill(u.status)),
    h('td', { 'data-label': 'Area' }, [u.sector, u.district].filter(Boolean).join(', ') || '—'),
    h('td', { 'data-label': 'Phone' }, u.phone || '—'),
    h('td', { 'data-label': 'Activity' }, u.scanCount + ' scans · ' + u.requestCount + ' requests', h('div.muted', 'last login ' + (u.lastLoginAt ? fmtAgo(u.lastLoginAt) : 'never'))),
    h('td', h('button.btn.secondary.small', { type: 'button', onclick: () => editUser(u) }, 'Manage'))));
  clear(byId('uList')).appendChild(h('table.data.responsive',
    h('thead', h('tr', ['Name', 'Role', 'Status', 'Area', 'Phone', 'Activity', ''].map((x) => h('th', x)))), h('tbody', rows)));
}

function userForm(u) {
  const f = {
    fullName: h('input', { type: 'text', value: u ? u.fullName : '', maxlength: 120 }),
    email: h('input', { type: 'email', value: u ? u.email : '', disabled: !!u }),
    role: h('select', ...['farmer', 'advisor', 'admin'].map((r) => h('option', { value: r, selected: u ? u.role === r : r === 'advisor' }, ROLE_LABEL[r]))),
    status: h('select', ...['active', 'suspended'].map((s) => h('option', { value: s, selected: u ? u.status === s : s === 'active' }, label(s)))),
    phone: h('input', { type: 'tel', value: u ? u.phone || '' : '', maxlength: 30 }),
    district: h('input', { type: 'text', value: u ? u.district || '' : '', list: 'districts', maxlength: 60 }),
    sector: h('input', { type: 'text', value: u ? u.sector || '' : '', maxlength: 60 }),
    organization: h('input', { type: 'text', value: u ? u.organization || '' : '', maxlength: 120 }),
    coverage: h('input', { type: 'text', value: u && u.coverageDistricts ? u.coverageDistricts.join(', ') : '', placeholder: 'Musanze, Burera (empty = all districts)' }),
  };
  const advBox = h('div', field('Organisation', f.organization), field('Districts covered (comma separated)', f.coverage, 'Advisors get cases and outbreak alerts from these districts.'));
  const syncAdv = () => { advBox.style.display = f.role.value === 'advisor' ? 'block' : 'none'; };
  f.role.addEventListener('change', syncAdv);
  syncAdv();
  const body = h('div',
    field('Full name', f.fullName), field('Email', f.email),
    h('div.grid2', field('Role', f.role), u ? field('Status', f.status) : null, field('Phone', f.phone), field('District', f.district), field('Sector', f.sector)),
    advBox);
  return { f, body };
}

function addUser() {
  const { f, body } = userForm(null);
  const msg = h('div.form-msg');
  const save = h('button', { type: 'button' }, 'Create and email invite');
  const m = modal('Add user', [body, h('p.muted', 'The person receives an email with a link to choose their own password (valid 72 hours).'), msg],
    [h('button.secondary', { type: 'button', onclick: () => m.close() }, 'Cancel'), save]);
  save.onclick = async () => {
    try {
      const d = await busy(save, () => API.post('/api/admin?action=user-create', {
        fullName: f.fullName.value, email: f.email.value, role: f.role.value, phone: f.phone.value, district: f.district.value,
        sector: f.sector.value, organization: f.organization.value, coverageDistricts: f.coverage.value,
      }));
      m.close();
      if (d.setupLink) showSetupLink(d.user.email, d.setupLink);
      else toast('Account created. Invite emailed to ' + d.user.email, 'ok');
      renderUsers();
    } catch (e) { msg.textContent = e.message; msg.className = 'form-msg bad'; }
  };
}

function showSetupLink(email, link) {
  const inp = h('input', { type: 'text', value: link, readonly: true });
  modal('Email could not be sent', [
    h('p', 'The account for ' + email + ' exists, but the invite email failed (see the Emails tab). Send this one-time link to the person yourself, by a private channel:'),
    inp,
    h('div.actions', h('button.secondary', { type: 'button', onclick: () => { inp.select(); try { navigator.clipboard.writeText(link); toast('Copied', 'ok'); } catch {} } }, 'Copy link')),
  ]);
}

function editUser(u) {
  const { f, body } = userForm(u);
  const msg = h('div.form-msg');
  const save = h('button', { type: 'button' }, 'Save changes');
  const reset = h('button.secondary', { type: 'button' }, 'Email a password link');
  const del = h('button.secondary.danger-text', { type: 'button' }, 'Delete account');
  const m = modal('Manage ' + u.fullName, [body,
    h('p.muted', 'Changing the role or suspending signs the person out everywhere immediately. Suspending keeps their data; deleting removes their scans and requests.'), msg],
  [del, reset, save]);
  save.onclick = async () => {
    try {
      await busy(save, () => API.post('/api/admin?action=user-update&id=' + u.id, {
        fullName: f.fullName.value, role: f.role.value, status: f.status.value, phone: f.phone.value, district: f.district.value,
        sector: f.sector.value, organization: f.organization.value, coverageDistricts: f.coverage.value,
      }));
      m.close(); toast('Saved', 'ok'); renderUsers();
    } catch (e) { msg.textContent = e.message; msg.className = 'form-msg bad'; }
  };
  reset.onclick = async () => {
    const d = await busy(reset, () => API.post('/api/admin?action=user-reset&id=' + u.id));
    if (d.setupLink) { m.close(); showSetupLink(u.email, d.setupLink); } else toast('Password link emailed to ' + u.email, 'ok');
  };
  del.onclick = async () => {
    if (!(await confirmBox('Delete ' + u.fullName + '?', 'This permanently deletes the account and all of its scans, requests and notifications. Suspend instead if you may need the records.', 'Delete permanently'))) return;
    try { await API.del('/api/admin?action=user&id=' + u.id); m.close(); toast('Deleted', 'ok'); renderUsers(); }
    catch (e) { msg.textContent = e.message; msg.className = 'form-msg bad'; }
  };
}
byId('uGo').addEventListener('click', () => renderUsers().catch((e) => toast(e.message, 'bad')));
byId('uQ').addEventListener('keydown', (e) => { if (e.key === 'Enter') renderUsers().catch((x) => toast(x.message, 'bad')); });
byId('uAdd').addEventListener('click', addUser);

/* ---------------- settings ---------------- */

async function renderSettings() {
  const { settings: s } = await API.get('/api/admin?action=settings');
  byId('sMin').value = s.outbreak.min_farmers;
  byId('sRad').value = s.outbreak.radius_km;
  byId('sWin').value = s.outbreak.window_days;
  byId('sConf').value = s.outbreak.min_confidence;
  document.querySelectorAll('input[name=stage]').forEach((c) => { c.checked = s.outbreak.qualifying_stages.includes(c.value); });
  byId('sNotifyFarmers').checked = s.outbreak.notify_farmers_on_confirm;
  byId('sPub').value = s.public_scan.daily_limit_per_ip;
  byId('sFarm').value = s.farmer_scan.daily_limit;
  byId('sChat').value = s.chat.daily_limit;
  byId('sReg').checked = s.registration.farmers_open;
  byId('sAssign').checked = s.requests.auto_assign;
}
byId('setForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  await busy(byId('sSave'), () => API.put('/api/admin?action=settings', {
    outbreak: {
      min_farmers: byId('sMin').value, radius_km: byId('sRad').value, window_days: byId('sWin').value, min_confidence: byId('sConf').value,
      qualifying_stages: [...document.querySelectorAll('input[name=stage]:checked')].map((c) => c.value),
      notify_farmers_on_confirm: byId('sNotifyFarmers').checked,
    },
    public_scan: { daily_limit_per_ip: byId('sPub').value },
    farmer_scan: { daily_limit: byId('sFarm').value },
    chat: { daily_limit: byId('sChat').value },
    registration: { farmers_open: byId('sReg').checked },
    requests: { auto_assign: byId('sAssign').checked },
  }));
  toast('Settings saved. New scans use them immediately.', 'ok');
  renderSettings();
});

/* ---------------- emails ---------------- */

async function renderEmails() {
  const st = byId('eStatus').value;
  const d = await API.get('/api/admin?action=emails&limit=100' + (st ? '&status=' + st : ''));
  const rows = d.emails.map((m) => {
    const retry = m.status === 'sent' ? null : h('button.btn.secondary.small', { type: 'button' }, 'Retry');
    if (retry) retry.onclick = async () => {
      const r = await busy(retry, () => API.post('/api/admin?action=email-retry&id=' + m.id));
      toast(r.result.status === 'sent' ? 'Sent' : 'Failed: ' + (r.result.error || ''), r.result.status === 'sent' ? 'ok' : 'bad');
      renderEmails();
    };
    return h('tr',
      h('td', { 'data-label': 'Time' }, fmtTime(m.created_at)),
      h('td', { 'data-label': 'To' }, m.to_email),
      h('td', { 'data-label': 'Subject' }, m.subject, h('div.muted', label(m.template || ''))),
      h('td', { 'data-label': 'Status' }, pill(m.status), m.attempts > 1 ? h('div.muted', m.attempts + ' attempts') : null, m.error ? h('div.err', m.error) : null),
      h('td', retry));
  });
  clear(byId('eList')).appendChild(d.emails.length
    ? h('table.data.responsive', h('thead', h('tr', ['Time', 'To', 'Subject', 'Status', ''].map((x) => h('th', x)))), h('tbody', rows))
    : h('p.muted', 'No emails yet.'));
}
byId('eGo').addEventListener('click', () => renderEmails().catch((e) => toast(e.message, 'bad')));
byId('eRetryAll').addEventListener('click', async () => {
  const r = await busy(byId('eRetryAll'), () => API.post('/api/admin?action=email-retry-failed'));
  toast(`Retried ${r.tried}: ${r.sent} sent, ${r.failed} failed`, r.failed ? 'bad' : 'ok');
  renderEmails();
});
byId('eTest').addEventListener('click', async () => {
  const to = byId('eTestTo').value.trim() || ME.email;
  try {
    await busy(byId('eTest'), () => API.post('/api/admin?action=email-test', { to }));
    toast('Test email delivered to the mail server for ' + to + '. Check the inbox (and spam).', 'ok');
  } catch {}
  renderEmails();
});

/* ---------------- activity ---------------- */

let actOffset = 0;
async function renderActivity(reset) {
  if (reset) { actOffset = 0; clear(byId('aList')).appendChild(h('table.data.responsive', h('thead', h('tr', ['Time', 'Who', 'Action', 'Item', 'IP'].map((x) => h('th', x)))), h('tbody'))); }
  const d = await API.get('/api/admin?action=activity&limit=60&offset=' + actOffset);
  const tb = byId('aList').querySelector('tbody');
  d.activity.forEach((a) => tb.appendChild(h('tr',
    h('td', { 'data-label': 'Time' }, fmtTime(a.created_at)),
    h('td', { 'data-label': 'Who' }, a.full_name ? a.full_name + ' (' + a.role + ')' : '—'),
    h('td', { 'data-label': 'Action' }, label(a.action)),
    h('td', { 'data-label': 'Item' }, a.entity_type ? a.entity_type + (a.entity_id ? ' #' + a.entity_id : '') : '—'),
    h('td', { 'data-label': 'IP' }, h('code', a.ip || '')))));
  actOffset += d.activity.length;
  byId('aMore').style.display = actOffset < d.total ? 'inline-block' : 'none';
}
byId('aMore').addEventListener('click', () => renderActivity(false));

/* ---------------- reports ---------------- */

function renderReports() {
  const grid = clear(byId('reportGrid'));
  const items = [
    ['scans', 'Scans', 'Every saved scan with farmer, stage, confidence, risk and location.'],
    ['districts', 'District summary', 'Scans, farmers and damage stages per district.'],
    ['requests', 'Help requests', 'Requests with advisor, status and first reply time.'],
    ['outbreaks', 'Outbreak alerts', 'Alerts with status, area, farmers and who confirmed them.'],
    ['users', 'Users', 'Accounts with role, status and area.'],
    ['emails', 'Email log', 'Delivery results for every email.'],
  ];
  items.forEach(([type, title, desc]) => {
    const btn = h('button', { type: 'button' }, 'Download CSV');
    btn.onclick = () => {
      const q = new URLSearchParams({ action: 'report', type });
      if (byId('rFrom').value) q.set('from', byId('rFrom').value);
      if (byId('rTo').value) q.set('to', byId('rTo').value);
      location.href = '/api/admin?' + q;
    };
    grid.appendChild(h('div.panel', h('strong', title), h('p.muted', desc), btn));
  });
}

/* ---------------- tabs ---------------- */

async function onTab(name, id) {
  try {
    if (name === 'overview') await renderOverview();
    else if (name === 'users') await renderUsers();
    else if (name === 'scans') await renderScanReports(byId('scansBox'), { pest: '', exportHref: '/api/scans?action=export' });
    else if (name === 'requests') await renderCases(byId('casesBox'), id, 'admin');
    else if (name === 'outbreaks') { byId('outbreaksHead').style.display = id ? 'none' : 'block'; await renderOutbreaks(byId('outbreaksBox'), id, 'admin'); }
    else if (name === 'settings') await renderSettings();
    else if (name === 'emails') await renderEmails();
    else if (name === 'activity') await renderActivity(true);
    else if (name === 'reports') renderReports();
  } catch (err) { toast(err.message, 'bad'); }
}

(async function start() {
  const s = await requireRole(['admin']);
  if (!s) return;
  ME = s.user;
  renderAccountBar(byId('accountBar'));
  fillDistricts();
  setupTabs(['overview', 'users', 'scans', 'requests', 'outbreaks', 'settings', 'emails', 'activity', 'reports'], onTab);
  setInterval(() => refreshBell(document.querySelector('.bell')), 60000);
})();
