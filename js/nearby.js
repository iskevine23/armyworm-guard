/* Nearby help: advisors and agro-dealers from data/directory.json, nearest first. */

let directory = null;
let dirFailed = false;
let nearbyFilter = 'all';
let selectedReportId = null;
let nearbyMap = null;
let nearbyLayer = null;
let nearbyToken = 0;
let lastLoc = null;

function validEntry(e) {
  return !!e &&
    (e.type === 'advisor' || e.type === 'agro-dealer') &&
    typeof e.name === 'string' && e.name.trim() !== '' &&
    typeof e.lat === 'number' && typeof e.lng === 'number' &&
    Math.abs(e.lat) <= 90 && Math.abs(e.lng) <= 180;
}

async function loadDirectory() {
  if (directory) return directory;
  try {
    const r = await fetch('data/directory.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    directory = (Array.isArray(j.entries) ? j.entries : []).filter(validEntry);
    dirFailed = false;
    return directory;
  } catch {
    dirFailed = true;
    return []; // a failure is not cached, so the next visit tries again
  }
}

function haversineKm(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Rwandan numbers written as 0788..., 788... or +250 788... all become 250788...
function normalizePhone(p) {
  const d = String(p || '').replace(/[^\d]/g, '');
  if (!d) return '';
  if (d.startsWith('250') && d.length >= 12) return d;
  if (d.startsWith('0') && d.length === 10) return '250' + d.slice(1);
  if (d.length === 9) return '250' + d;
  return d;
}
function waUrl(digits, text) { return 'https://wa.me/' + digits + '?text=' + encodeURIComponent(text); }

function mkLink(cls, text, href) {
  const a = mk('a', cls, text);
  a.href = href;
  if (href.startsWith('http')) { a.target = '_blank'; a.rel = 'noopener'; }
  return a;
}

/* ---------- the report a farmer can send to an advisor ---------- */

function reportForShare() {
  const list = scansLoad();
  if (!list.length) return null;
  if (selectedReportId) {
    const r = list.find((x) => x.id === selectedReportId);
    if (r) return r;
  }
  return list[0];
}

function reportText(rec) {
  const farm = getFarm();
  const farmBits = [farm.farmName, farm.farmerName, farm.phone].filter(Boolean).join(', ') || '—';
  const hasLoc = rec.locSource !== 'default' && typeof rec.lat === 'number' && typeof rec.lng === 'number';
  const loc = hasLoc ? 'https://www.google.com/maps?q=' + rec.lat.toFixed(5) + ',' + rec.lng.toFixed(5) : t('locUnknown');
  return t('reportTpl', {
    stage: tl('stage_', rec.stage),
    seen: rec.affectedArea || '—',
    rec: rec.recommendation || '—',
    risk: rec.riskLevel ? tl('risk_', rec.riskLevel) : '—',
    farm: farmBits,
    loc: loc
  });
}

/* ---------- list ---------- */

function placeCard(e, dist, rec) {
  const isAdvisor = e.type === 'advisor';
  const card = mk('div', 'place');

  const top = mk('div', 'place-top');
  top.appendChild(mk('span', 'type ' + (isAdvisor ? 'advisor' : 'dealer'), t(isAdvisor ? 'type_advisor' : 'type_dealer')));
  top.appendChild(mk('span', 'dist', fmtDist(dist)));
  card.appendChild(top);

  card.appendChild(mk('div', 'place-name', e.name));
  if (e.organization) card.appendChild(mk('div', 'place-org', e.organization));
  const where = [e.address, [e.sector, e.district].filter(Boolean).join(', ')].filter(Boolean).join(' · ');
  if (where) card.appendChild(mk('div', 'place-meta', where));
  if (e.hours) card.appendChild(mk('div', 'place-meta', t('hoursLabel') + ': ' + e.hours));

  if (Array.isArray(e.services) && e.services.length) {
    const tags = mk('div', 'tags');
    e.services.slice(0, 8).forEach((s) => tags.appendChild(mk('span', 'tag', String(s))));
    card.appendChild(tags);
  }

  const actions = mk('div', 'place-actions');
  if (e.sample) {
    card.appendChild(mk('div', 'sample', t('sampleBadge')));
  } else {
    const phone = normalizePhone(e.phone);
    const wa = normalizePhone(e.whatsapp || e.phone);
    if (phone) actions.appendChild(mkLink('btn', t('act_call'), 'tel:+' + phone));
    if (wa) {
      const text = rec ? reportText(rec) : t('waGeneric');
      actions.appendChild(mkLink('btn secondary', rec ? t('act_report') : t('act_wa'), waUrl(wa, text)));
    }
  }
  actions.appendChild(mkLink('btn secondary', t('act_dir'), 'https://www.google.com/maps/dir/?api=1&destination=' + e.lat + ',' + e.lng));
  card.appendChild(actions);
  return card;
}

/* ---------- map (OpenStreetMap through Leaflet; the list works without it) ---------- */

function drawMap(loc, items) {
  const box = $('nearbyMap');
  if (typeof L === 'undefined') { box.style.display = 'none'; return; }
  try {
    box.style.display = 'block';
    if (!nearbyMap) {
      nearbyMap = L.map(box, { scrollWheelZoom: false });
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 18,
        attribution: '© OpenStreetMap contributors'
      }).addTo(nearbyMap);
      nearbyLayer = L.layerGroup().addTo(nearbyMap);
    }
    nearbyLayer.clearLayers();
    const pts = [[loc.lat, loc.lng]];

    const me = document.createElement('div');
    me.textContent = t('youAreHere');
    L.circleMarker([loc.lat, loc.lng], { radius: 8, color: '#F3EEE1', weight: 2, fillColor: '#7FA65B', fillOpacity: 1 })
      .bindPopup(me).addTo(nearbyLayer);

    items.forEach((it) => {
      const color = it.e.type === 'advisor' ? '#7FA65B' : '#D9A441';
      const pop = document.createElement('div');
      pop.textContent = it.e.name;
      L.circleMarker([it.e.lat, it.e.lng], { radius: 7, color: color, fillColor: color, fillOpacity: 0.85 })
        .bindPopup(pop).addTo(nearbyLayer);
      pts.push([it.e.lat, it.e.lng]);
    });
    nearbyMap.invalidateSize();
    nearbyMap.fitBounds(pts, { padding: [30, 30], maxZoom: 15 });
  } catch { box.style.display = 'none'; }
}

/* ---------- view ---------- */

async function renderNearby(useCachedLoc, forceFreshGps) {
  const token = ++nearbyToken;
  $('nearbyLoc').textContent = t('gettingLoc');

  const [entries, loc] = await Promise.all([
    loadDirectory(),
    useCachedLoc && lastLoc ? Promise.resolve(lastLoc) : getLocation(!!forceFreshGps)
  ]);
  if (token !== nearbyToken) return; // a newer render started meanwhile
  lastLoc = loc;

  const items = entries
    .filter((e) => nearbyFilter === 'all' || e.type === nearbyFilter)
    .map((e) => ({ e: e, d: haversineKm(loc, e) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 12);

  $('nearbyLoc').textContent = t('locLabel') + ' ' + t('loc_' + loc.source);
  $('locWarn').style.display = loc.source === 'default' ? 'block' : 'none';

  document.querySelectorAll('.pill').forEach((b) => b.classList.toggle('active', b.dataset.filter === nearbyFilter));

  const rec = reportForShare();
  $('reportLine').textContent = rec
    ? t('reportLine', { stage: tl('stage_', rec.stage), date: fmtDate(rec.ts) })
    : t('noReport');

  const list = $('nearbyList');
  list.textContent = '';
  if (dirFailed) list.appendChild(mk('p', 'risk-basis', t('dirError')));
  else if (!items.length) list.appendChild(mk('p', 'risk-basis', t('noPlaces')));
  items.forEach((it) => list.appendChild(placeCard(it.e, it.d, rec)));

  drawMap(loc, items);
}

function initNearby() {
  document.querySelectorAll('.pill').forEach((b) => {
    b.addEventListener('click', () => { nearbyFilter = b.dataset.filter; renderNearby(true); });
  });
  $('locUpdate').addEventListener('click', () => renderNearby(false, true));
}
