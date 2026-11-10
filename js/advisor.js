/* Agricultural advisor dashboard. Every list is filtered on the server by the advisor's coverage. */
let PROFILE = null;
lang = 'en';

async function renderOverview() {
  byId('hello').textContent = 'Hello, ' + ME.fullName.split(' ')[0];
  const cov = (PROFILE.advisor && PROFILE.advisor.coverageDistricts) || [];
  const note = byId('coverageNote');
  note.style.display = 'block';
  note.textContent = cov.length
    ? 'You cover: ' + cov.join(', ') + '. You get new cases and outbreak alerts from these districts.'
    : 'You cover all districts. Set the districts you cover in My profile to receive only your area.';
  const [mine, unassigned, alerts] = await Promise.all([
    API.get('/api/requests?action=list&status=active&mine=1'),
    API.get('/api/requests?action=list&status=active&unassigned=1'),
    API.get('/api/outbreaks?action=list&status=active'),
  ]);
  clear(byId('advStats')).append(
    statTile(mine.requests.length, 'My open cases', '#requests'),
    statTile(unassigned.requests.length, 'Unassigned cases', '#requests'),
    statTile(alerts.alerts.filter((a) => a.status === 'suspected').length, 'Suspected outbreaks', '#outbreaks'),
    statTile(alerts.alerts.filter((a) => a.status === 'confirmed').length, 'Confirmed outbreaks', '#outbreaks'));
  const al = clear(byId('ovAlerts'));
  if (!alerts.alerts.length) al.appendChild(h('p.muted', 'No open outbreak alerts.'));
  alerts.alerts.slice(0, 5).forEach((a) => al.appendChild(h('a.row-card', { href: '#outbreaks-' + a.id },
    h('div.row-top', h('span.row-title', '#' + a.id + ' ' + ([a.sector, a.district].filter(Boolean).join(', ') || 'Area')), pill(a.status, OUTBREAK_LABEL[a.status])),
    h('div.row-meta', h('span', a.farmerCount + ' farmers'), h('span', 'last report ' + fmtAgo(a.lastReportAt))))));
  const cs = clear(byId('ovCases'));
  const waiting = [...mine.requests, ...unassigned.requests];
  if (!waiting.length) cs.appendChild(h('p.muted', 'No open cases. New requests from farmers in your area appear here and are emailed to you.'));
  waiting.slice(0, 8).forEach((r) => cs.appendChild(requestRowEl(r, '#requests-' + r.id, true)));
}

function renderProfile() {
  const a = PROFILE.advisor || {};
  byId('pName').value = ME.fullName || '';
  byId('pPhone').value = ME.phone || '';
  byId('pOrg').value = a.organization || '';
  byId('pTitle').value = a.title || '';
  byId('pDistrict').value = ME.district || '';
  byId('pSector').value = ME.sector || '';
  byId('pCoverage').value = (a.coverageDistricts || []).join(', ');
  byId('pEmails').checked = ME.emailNotifications !== false;
}
byId('profForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  PROFILE = await busy(byId('pSave'), () => API.put('/api/me?action=profile', {
    fullName: byId('pName').value, phone: byId('pPhone').value, district: byId('pDistrict').value, sector: byId('pSector').value,
    emailNotifications: byId('pEmails').checked,
    advisor: { organization: byId('pOrg').value, title: byId('pTitle').value, coverageDistricts: byId('pCoverage').value },
  }));
  ME = PROFILE.user;
  toast('Profile saved', 'ok');
});
byId('pwForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  await busy(byId('pwBtn'), () => API.post('/api/auth?action=change-password', { currentPassword: byId('pwCur').value, newPassword: byId('pwNew').value }));
  byId('pwCur').value = byId('pwNew').value = '';
  toast('Password changed. Other devices were signed out.', 'ok');
});

async function onTab(name, id) {
  try {
    if (name === 'overview') await renderOverview();
    else if (name === 'requests') await renderCases(byId('casesBox'), id, 'advisor');
    else if (name === 'outbreaks') {
      byId('outbreaksHead').style.display = id ? 'none' : 'block';
      await renderOutbreaks(byId('outbreaksBox'), id, 'advisor');
    } else if (name === 'scans') {
      const cov = (PROFILE.advisor && PROFILE.advisor.coverageDistricts) || [];
      await renderScanReports(byId('scansBox'), { exportHref: '/api/scans?action=export', scopeNote: cov.length ? 'your districts plus scans in cases and outbreak alerts' : 'all districts' });
    } else if (name === 'profile') renderProfile();
  } catch (err) { toast(err.message, 'bad'); }
}

(async function start() {
  const s = await requireRole(['advisor']);
  if (!s) return;
  PROFILE = await API.get('/api/me?action=profile');
  ME = PROFILE.user;
  renderAccountBar(byId('accountBar'));
  fillDistricts();
  setupTabs(['overview', 'requests', 'outbreaks', 'scans', 'profile'], onTab);
  setInterval(() => refreshBell(document.querySelector('.bell')), 60000);
})();
