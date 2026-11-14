/* Public homepage: the scanner, the interactive stepper and the live field-conditions card.
   Visitors get the basic result; logged-in users get everything. */

let scannerHandle = null;
// true when the visitor asked their system to reduce animation (or motion.js is missing)
const motionOff = () => (typeof Motion !== 'undefined' && Motion.reduce());
let progressTimers = [];
let condData = null;

/* ---------------- language ---------------- */

function applyLang() {
  document.documentElement.lang = lang;
  document.title = t('title');
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  refreshResultLabels();
  if (scannerHandle) scannerHandle.renderCropOptions();
  renderCropChips();
  if (condData) renderConditions(condData);
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

/* ---------------- crop chips (mirror of the native select) ---------------- */

function renderCropChips() {
  const box = $('cropChips');
  const sel = $('cropSelect');
  if (!box || !sel) return;
  clear(box);
  CROP_CHOICES.forEach((c) => {
    const id = c.id;
    const btn = h('button', {
      type: 'button',
      'aria-pressed': String(sel.value === id),
      onclick: () => {
        sel.value = id;
        sel.dispatchEvent(new Event('change'));
        syncChips();
        // a small confirmation so the tap feels connected to something
        const chip = box.querySelector('[data-crop="' + id + '"]');
        if (chip && !motionOff()) {
          chip.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.06)' }, { transform: 'scale(1)' }], { duration: 260, easing: 'ease-out' });
        }
      },
    }, h('span.dot'), lang === 'rw' ? c.rw : c.en);
    btn.dataset.crop = id;
    box.appendChild(btn);
  });
}

function syncChips() {
  const sel = $('cropSelect');
  if (!sel) return;
  document.querySelectorAll('#cropChips button').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.crop === sel.value));
  });
}

// scanner.js calls this once the crop list arrives from the server
function onCropChoicesLoaded() {
  renderCropChips();
  syncChips();
}

/* ---------------- stepper + anchors ---------------- */

function scrollToSection(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: motionOff() ? 'auto' : 'smooth', block: 'start' });
}

function initStepper() {
  const steps = Array.from(document.querySelectorAll('.stepper .step'));
  if (!steps.length) return;
  steps.forEach((step) => {
    step.addEventListener('click', () => {
      scrollToSection(step.dataset.goto);
      steps.forEach((s) => s.setAttribute('aria-selected', String(s === step)));
    });
  });
  // keep the highlighted step in step with what is on screen
  if (!('IntersectionObserver' in window)) return;
  const sections = steps.map((s) => document.getElementById(s.dataset.goto)).filter(Boolean);
  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      const i = sections.indexOf(entry.target);
      if (i >= 0) steps.forEach((s, j) => s.setAttribute('aria-selected', String(i === j)));
    });
  }, { rootMargin: '-45% 0px -45% 0px' });
  sections.forEach((s) => io.observe(s));
}

const heroScan = $('heroScan');
if (heroScan) heroScan.addEventListener('click', () => {
  scrollToSection('scout');
  const dz = $('dropzone');
  if (dz) setTimeout(() => dz.focus({ preventScroll: true }), motionOff() ? 0 : 420);
});

/* ---------------- scan progress bar ---------------- */

function startScanProgress() {
  const box = $('scanProgress');
  const bar = $('scanBar');
  const msg = $('scanMsg');
  if (!box || !bar || !msg) return;
  box.classList.add('on');
  bar.style.width = '8%';
  let i = 1;
  const step = () => {
    i = Math.min(4, i + 1);
    bar.style.width = (8 + ((i - 1) / 4) * 78) + '%';
    msg.textContent = t('prog' + i);
  };
  msg.textContent = t('prog1');
  progressTimers.push(setInterval(step, 1400));
}

function stopScanProgress(done) {
  progressTimers.forEach(clearInterval);
  progressTimers = [];
  const box = $('scanProgress');
  const bar = $('scanBar');
  if (!box || !bar) return;
  if (done) {
    bar.style.width = '100%';
    setTimeout(() => { box.classList.remove('on'); bar.style.width = '8%'; }, 500);
  } else {
    box.classList.remove('on');
  }
}

// scanner.js shows and hides #loading around the request; follow it instead of editing the scanner
function watchLoading() {
  const loading = $('loading');
  if (!loading) return;
  new MutationObserver(() => {
    const busy = loading.style.display === 'block';
    if (busy) startScanProgress(); else stopScanProgress(true);
  }).observe(loading, { attributes: true, attributeFilter: ['style'] });
}

/* ---------------- init scanner ---------------- */

scannerHandle = initScanner({
  fileInput: $('fileInput'), dropzone: $('dropzone'), preview: $('preview'),
  scanBtn: $('scanBtn'), clearBtn: $('clearBtn'), loading: $('loading'), cropSelect: $('cropSelect'),
  onClear: () => { resetResult(); syncChips(); },
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
      scrollToSection('result');
    } catch (err) {
      stopScanProgress(false);
      showResultError(err.message);
      scrollToSection('result');
    }
  },
});

$('cropSelect').addEventListener('change', syncChips);
loadSession().then(applyLang);
applyLang();
renderCropChips();
initStepper();
watchLoading();

/* ---------------- live field conditions (NASA POWER, public endpoint) ---------------- */

async function loadConditions() {
  const body = $('condBody');
  const btn = $('condBtn');
  if (!body || !btn) return;
  btn.disabled = true;
  clear(body).appendChild(h('div', { style: 'margin-top:16px' }, h('div.skeleton', { style: 'width:70%' }), h('div.skeleton', { style: 'width:45%' })));
  body.appendChild(h('div.risk-basis', t('condLocating')));
  let loc = { lat: -1.4995, lng: 29.6335, source: 'default' };
  try { loc = await getLocation(); } catch {}
  try {
    body.querySelector('.risk-basis').textContent = t('condLoading');
    const d = await API.get('/api/climate?action=field&crop=' + encodeURIComponent(currentCrop()) +
      '&lat=' + loc.lat + '&lng=' + loc.lng);
    condData = d;
    renderConditions(d);
  } catch {
    clear(body).appendChild(h('p.warn', { style: 'margin-top:14px' }, t('condFailed')));
  } finally {
    btn.disabled = false;
  }
}

function renderConditions(d) {
  const body = $('condBody');
  if (!body) return;
  clear(body);
  const rain = d.rain || {};
  const soil = d.soil || {};
  const tiles = [
    { n: Math.round(rain.last30mm || 0) + ' mm', l: 'rain · 30d' },
    { n: Math.round((soil.rootZone || 0) * 100) + '%', l: 'soil moisture' },
    { n: String(d.drySpellDays || 0), l: 'dry days' },
    { n: String((d.heat && d.heat.days7) || 0), l: 'hot days · 7d' },
  ];
  const grid = h('div.stat-strip', { style: 'margin:16px 0 6px' });
  tiles.forEach((tile) => grid.appendChild(h('div.item', h('div.n', tile.n), h('div.l', tile.l))));
  body.appendChild(grid);

  // a bar that fills to the rain anomaly, so a dry or wet month is obvious at a glance
  const anomaly = Number(rain.anomalyPct || 0);
  const barWrap = h('div', { style: 'margin:10px 0 0' },
    h('div.risk-basis', 'Rain vs. the 30-year normal: ' + (anomaly > 0 ? '+' : '') + anomaly + '%'),
    h('div', { style: 'height:8px;border-radius:6px;background:rgba(243,238,225,.12);overflow:hidden;margin-top:6px' },
      h('div', { style: 'height:100%;width:0;border-radius:6px;background:linear-gradient(90deg,var(--leaf),var(--sun));transition:width .9s cubic-bezier(.22,.61,.36,1)' })));
  body.appendChild(barWrap);
  const fill = barWrap.querySelector('div > div');
  const width = Math.min(100, Math.max(3, 50 + anomaly));
  requestAnimationFrame(() => { if (fill) fill.style.width = width + '%'; });

  (d.advisory || []).forEach((line) => body.appendChild(h('p.callout', { style: 'margin-top:10px' }, line)));
  if (d.attribution) body.appendChild(h('div.risk-basis', { style: 'margin-top:8px;opacity:.75' }, d.attribution));
}

$('condBtn').addEventListener('click', loadConditions);

/* ---------------- offline shell ---------------- */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
}
