/* Log in, sign up, forgot password and reset password. */
const params = new URLSearchParams(location.search);
const nextUrl = (() => {
  const n = params.get('next') || '';
  // only same-site relative pages
  return /^[a-z]+\.html(#[\w-]*)?$/.test(n) ? n : null;
})();
let resetToken = null;

function applyLang() {
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
}
$('langSelect').value = lang;
$('langSelect').addEventListener('change', () => {
  lang = $('langSelect').value;
  try { localStorage.setItem('lang', lang); } catch {}
  applyLang();
});

function showPane(name) {
  ['login', 'register', 'forgot', 'reset'].forEach((p) => { $('pane-' + p).style.display = p === name ? 'block' : 'none'; });
  document.querySelectorAll('.tabs [data-pane]').forEach((b) => b.classList.toggle('active', b.dataset.pane === name));
  document.querySelector('.tabs').style.display = name === 'reset' ? 'none' : '';
  const first = $('pane-' + name).querySelector('input');
  if (first) first.focus();
}
document.querySelectorAll('[data-pane]').forEach((b) => b.addEventListener('click', () => showPane(b.dataset.pane)));
document.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => showPane(b.dataset.goto)));
$('forgotLink').addEventListener('click', () => { $('fEmail').value = $('lEmail').value; showPane('forgot'); });

function msg(id, text, ok) { $(id).textContent = text || ''; $(id).className = 'form-msg' + (ok ? ' ok' : text ? ' bad' : ''); }

async function afterAuth(user) {
  // a farmer who scanned before logging in goes straight to the scan so it can be saved
  if (user.role === 'farmer' && pendingScanExists()) return location.replace('farmer.html#scan');
  location.replace(nextUrl && !/^login/.test(nextUrl) ? nextUrl : dashboardFor(user.role));
}
function pendingScanExists() { const p = lsGet('pendingScan', null); return !!(p && p.scanId); }

$('pane-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  msg('lMsg', '');
  try {
    const d = await busy($('lBtn'), () => API.post('/api/auth?action=login', { email: $('lEmail').value, password: $('lPass').value }));
    await afterAuth(d.user);
  } catch (err) { msg('lMsg', err.message); }
});

$('pane-register').addEventListener('submit', async (e) => {
  e.preventDefault();
  msg('rMsg', '');
  if (!$('rAgree').checked) return msg('rMsg', t('mustAgree'));
  try {
    const d = await busy($('rBtn'), () => API.post('/api/auth?action=register', {
      fullName: $('rName').value, email: $('rEmail').value, phone: $('rPhone').value,
      district: $('rDistrict').value, sector: $('rSector').value, farmName: $('rFarm').value,
      password: $('rPass').value, lang,
    }));
    await afterAuth(d.user);
  } catch (err) { msg('rMsg', err.message); }
});

$('pane-forgot').addEventListener('submit', async (e) => {
  e.preventDefault();
  msg('fMsg', '');
  try {
    const d = await busy($('fBtn'), () => API.post('/api/auth?action=forgot', { email: $('fEmail').value }));
    msg('fMsg', d.message, true);
  } catch (err) { msg('fMsg', err.message); }
});

$('pane-reset').addEventListener('submit', async (e) => {
  e.preventDefault();
  msg('nMsg', '');
  if ($('nPass').value !== $('nPass2').value) return msg('nMsg', t('passMismatch'));
  try {
    const d = await busy($('nBtn'), () => API.post('/api/auth?action=reset', { token: resetToken, password: $('nPass').value }));
    history.replaceState(null, '', 'login.html');
    await afterAuth(d.user);
  } catch (err) { msg('nMsg', err.message); }
});

applyLang();
fillDistricts();
if (pendingScanExists()) $('pendingNote').style.display = 'block';

const hash = location.hash.replace('#', '');
if (hash.startsWith('reset=')) {
  resetToken = hash.slice(6);
  // keep the token out of the address bar and browser history
  history.replaceState(null, '', 'login.html');
  showPane('reset');
} else {
  showPane(hash === 'register' ? 'register' : hash === 'forgot' ? 'forgot' : 'login');
  // already logged in? go to the dashboard
  loadSession().then((s) => { if (s.user && hash !== 'register') afterAuth(s.user); });
}
