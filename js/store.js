/* Small helpers shared by the public scanner and the farmer dashboard:
   DOM builder, formatting, location, thumbnails. Scan history and the farm profile now live
   in the database (see farmer.js); this file only keeps short-lived caches of them. */

const $ = (id) => document.getElementById(id);

// small DOM builder: always uses textContent, so directory data and AI text can never inject HTML
function mk(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined && text !== null) el.textContent = text;
  return el;
}

function lsGet(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch { return fallback; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}

function fmtDate(iso) {
  try { return new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }); }
  catch { return String(iso || ''); }
}
function fmtDist(km) {
  return km < 1 ? Math.round(km * 1000) + ' m' : km.toFixed(km < 10 ? 1 : 0) + ' km';
}

/* ---------------- farm profile + scans (filled from the server by farmer.js) ---------------- */

let FARM_CACHE = null;   // { farmName, farmerName, phone, district, sector, lat, lng }
let SCANS_CACHE = [];    // newest first, in the shape nearby.js expects

function getFarm() { return FARM_CACHE || {}; }
function scansLoad() { return SCANS_CACHE; }

/* ---------------- Location ---------------- */

const DEFAULT_LOC = { lat: -1.4995, lng: 29.6335 }; // Musanze
let gpsCache = null;

function getGps(timeoutMs, maxAgeMs) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve(null),
      { timeout: timeoutMs || 6000, maximumAge: maxAgeMs === undefined ? 300000 : maxAgeMs }
    );
  });
}

// GPS first, then the saved farm location, then Musanze as a last resort.
async function getLocation(forceFresh) {
  if (!forceFresh && gpsCache && Date.now() - gpsCache.ts < 300000) {
    return { lat: gpsCache.lat, lng: gpsCache.lng, source: 'gps' };
  }
  const g = await getGps(6000, forceFresh ? 0 : 300000);
  if (g) {
    gpsCache = { lat: g.lat, lng: g.lng, ts: Date.now() };
    return { lat: g.lat, lng: g.lng, source: 'gps' };
  }
  const f = getFarm();
  if (typeof f.lat === 'number' && typeof f.lng === 'number') {
    return { lat: f.lat, lng: f.lng, source: 'farm' };
  }
  return { lat: DEFAULT_LOC.lat, lng: DEFAULT_LOC.lng, source: 'default' };
}

function parseCoord(value) {
  const s = String(value || '').trim().replace(',', '.');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

// small preview image saved with each scan
function makeThumb(canvas) {
  const MAX = 96;
  const r = Math.min(MAX / canvas.width, MAX / canvas.height, 1);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(canvas.width * r));
  c.height = Math.max(1, Math.round(canvas.height * r));
  c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.6);
}
