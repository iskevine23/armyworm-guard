/* Public homepage: scanning only. Visitors get the basic result; logged-in users get everything. */

function applyLang() {
  document.documentElement.lang = lang;
  document.title = t('title');
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  refreshResultLabels();
  renderAccountBar($('accountBar'), {
    showDashboardLink: true, loginLabel: t('btnLogin'), registerLabel: t('btnRegisterShort'),
    dashboardLabel: t('openDashboard'), logoutLabel: t('logout'),
  });
}

const langSelect = $('langSelect');
langSelect.value = lang;
langSelect.addEventListener('change', () => {
  lang = langSelect.value;
  try { localStorage.setItem('lang', lang); } catch {}
  applyLang();
});

initScanner({
  fileInput: $('fileInput'), dropzone: $('dropzone'), preview: $('preview'),
  scanBtn: $('scanBtn'), clearBtn: $('clearBtn'), loading: $('loading'),
  onClear: resetResult,
  onScan: async (photo) => {
    resetResult();
    try {
      const user = SESSION && SESSION.user;
      const body = { ...photo, lang };
      if (user) {
        const loc = await getLocation();
        Object.assign(body, { lat: loc.lat, lng: loc.lng, locSource: loc.source });
      }
      const d = await API.post('/api/scans', body);
      if (d.basic) {
        renderBasic(d);
        lsSet('pendingScan', { scanId: d.scanId, claimToken: d.claimToken, createdAt: d.createdAt, stage: d.stage });
      } else {
        renderFull(d.scan, d.spread, d.outbreak);
        const isFarmer = user.role === 'farmer';
        $('helpLink').style.display = isFarmer ? '' : 'none';
        $('helpLink').href = 'farmer.html?scan=' + d.scan.id + '#requests';
        $('dashLink').href = isFarmer ? 'farmer.html#history' : dashboardFor(user.role);
      }
    } catch (err) {
      showResultError(err.message);
    }
  },
});

loadSession().then(applyLang);
applyLang();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
}
