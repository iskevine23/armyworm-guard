// Field conditions from NASA POWER (https://power.larc.nasa.gov), the free NASA agro-climatology
// API. No account, no API key, no satellite image to download: one JSON call per ~1 km cell gives
// daily rainfall, temperature, humidity, solar radiation and root-zone soil wetness from 1981 to
// yesterday. That is enough to say "this field had 20 mm in 30 days where it normally gets 70" or
// "three straight days of 30 mm rain on saturated soil — flooding risk".
//
// Everything here is deliberately server-side and cached: the browser never calls NASA directly,
// so the app keeps working when power.larc.nasa.gov is slow, and we stay inside fair-use limits.
//
//   CLIMATE_API_BASE   override the base URL (tests point it at a local stub)
//   CLIMATE_CACHE_HOURS how long a cached summary stays fresh (default 12)

import { getCrop, waterNeed30, cropLabel, wetWeatherDisease } from "./crops.js";
import { one, query } from "./db.js";
import { HttpError } from "./http.js";

const DEFAULT_BASE = "https://power.larc.nasa.gov";
const PARAMS = {
  rain: "PRECTOTCORR",
  tmean: "T2M",
  tmax: "T2M_MAX",
  tmin: "T2M_MIN",
  rh: "RH2M",
  soil: "GWETROOT",
  solar: "ALLSKY_SFC_SW_DWN",
};
const MISSING = -999;
const CLIMATOLOGY_YEARS = 5;
const FETCH_TIMEOUT_MS = 9000;

export const ATTRIBUTION = "Climate data: NASA POWER (power.larc.nasa.gov), CC BY 4.0";

export function climateBase() {
  return (process.env.CLIMATE_API_BASE || DEFAULT_BASE).replace(/\/+$/, "");
}

export function cacheHours() {
  const n = Number(process.env.CLIMATE_CACHE_HOURS);
  return Number.isFinite(n) && n >= 0 ? n : 12;
}

/* ---------------- dates ---------------- */

const iso = (d) => new Date(d).toISOString().slice(0, 10);
const isoYearsAgo = (d, years) => {
  const x = new Date(d);
  x.setUTCFullYear(x.getUTCFullYear() - years);
  return x;
};
const hyphen = (s) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
const compact = (s) => s.replace(/-/g, "");

/* ---------------- NASA POWER ---------------- */

export function powerUrl({ lat, lng, start, end }) {
  const u = new URL(climateBase() + "/api/temporal/daily/point");
  u.searchParams.set("parameters", Object.values(PARAMS).join(","));
  u.searchParams.set("community", "AG");
  u.searchParams.set("longitude", String(lng));
  u.searchParams.set("latitude", String(lat));
  u.searchParams.set("start", compact(start));
  u.searchParams.set("end", compact(end));
  u.searchParams.set("format", "JSON");
  return u.toString();
}

// Turns the POWER response into a plain daily series, oldest first.
export function parsePower(payload) {
  const p = payload?.properties?.parameter;
  if (!p || typeof p !== "object") throw new HttpError(502, "The climate service returned an unexpected answer.");
  const dates = Object.keys(p[PARAMS.rain] || {}).sort();
  if (!dates.length) throw new HttpError(502, "The climate service had no data for this location.");
  const val = (name, d) => {
    const v = p[name]?.[d];
    return typeof v === "number" && v > MISSING ? v : null;
  };
  return dates.map((d) => ({
    date: hyphen(d),
    rain: val(PARAMS.rain, d),
    tmean: val(PARAMS.tmean, d),
    tmax: val(PARAMS.tmax, d),
    tmin: val(PARAMS.tmin, d),
    rh: val(PARAMS.rh, d),
    soil: val(PARAMS.soil, d),
    solar: val(PARAMS.solar, d),
  }));
}

export async function fetchSeries({ lat, lng, start, end }) {
  const url = powerUrl({ lat, lng, start, end });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
    if (!r.ok) {
      console.error("NASA POWER error:", r.status, (await r.text()).slice(0, 300));
      throw new HttpError(502, "The climate service is unavailable right now. Please try again later.");
    }
    return parsePower(await r.json());
  } catch (err) {
    if (err.name === "AbortError") throw new HttpError(504, "The climate service took too long to answer. Please try again.");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- maths ---------------- */

const nums = (arr) => arr.filter((v) => typeof v === "number" && Number.isFinite(v));
const sum = (arr) => nums(arr).reduce((a, b) => a + b, 0);
const avg = (arr) => (nums(arr).length ? sum(arr) / nums(arr).length : null);
const round = (v, d = 0) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
const windowEnding = (days, endDate, length) => {
  const endIdx = days.findIndex((d) => d.date === endDate);
  if (endIdx < 0) return [];
  return days.slice(Math.max(0, endIdx - length + 1), endIdx + 1);
};

// Pure function: no network, no database. Everything the UI shows is computed here so it can be
// unit-tested against fixed series.
export function summariseClimate(days, { crop, today } = {}) {
  const c = getCrop(crop);
  if (!days?.length) throw new HttpError(502, "No climate data for this location.");
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const last = today || sorted[sorted.length - 1].date;
  const last30 = windowEnding(sorted, last, 30);
  const last7 = windowEnding(sorted, last, 7);
  const last3 = windowEnding(sorted, last, 3);
  const last14 = windowEnding(sorted, last, 14);

  const rainLast30 = sum(last30.map((d) => d.rain));
  const rainLast7 = sum(last7.map((d) => d.rain));

  // Same 30-day window in each of the previous years; the mean is the local normal.
  const normalWindows = [];
  for (let y = 1; y <= CLIMATOLOGY_YEARS; y++) {
    const w = windowEnding(sorted, iso(isoYearsAgo(new Date(last + "T00:00:00Z"), y)), 30);
    if (w.length === 30) normalWindows.push(sum(w.map((d) => d.rain)));
  }
  const normal30 = normalWindows.length ? avg(normalWindows) : null;
  const anomalyPct = normal30 && normal30 >= 5 ? round(((rainLast30 - normal30) / normal30) * 100) : null;

  // How long since it really rained (>= 1 mm counts as a rainy day)
  let drySpellDays = 0;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const r = sorted[i].rain;
    if (r == null) break;
    if (r >= 1) break;
    if (sorted[i].date > last) continue;
    drySpellDays++;
  }

  const soilNow = [...sorted].reverse().find((d) => d.soil != null)?.soil ?? null;
  const soilNormal = avg(last30.map((d) => d.soil));

  const heatDays7 = last7.filter((d) => d.tmax != null && d.tmax >= c.heatC).length;
  const gdd14 = sum(last14.map((d) => {
    const t = d.tmax != null && d.tmin != null ? (d.tmax + d.tmin) / 2 : d.tmean;
    return t == null ? 0 : Math.max(0, t - 10);
  }));

  // Fungal pressure: rainy days + high humidity + mild-to-warm air
  const rainyDays7 = last7.filter((d) => d.rain != null && d.rain >= 1).length;
  const rh7 = avg(last7.map((d) => d.rh));
  const temp7 = avg(last7.map((d) => d.tmax));
  let fungalRisk = "low";
  if (rainyDays7 >= 4 && (rh7 ?? 0) >= 85 && (temp7 ?? 0) >= 18) fungalRisk = "high";
  else if (rainyDays7 >= 3 || ((rh7 ?? 0) >= 85 && rainyDays7 >= 2)) fungalRisk = "moderate";

  const heavy3 = sum(last3.map((d) => d.rain));
  const need30 = waterNeed30(c.id);

  const flags = [];
  const advisory = [];
  if ((anomalyPct != null && anomalyPct <= -35 && rainLast30 < need30 * 0.7) || drySpellDays >= 14) {
    flags.push("drought");
    advisory.push({ code: "drought", level: "high", crop: c.en, need30 });
  }
  if (heavy3 >= 50 || (heavy3 >= 30 && (soilNow ?? 0) >= 0.9)) {
    flags.push("flood");
    advisory.push({ code: "flood", level: "high", crop: c.en, mm: round(heavy3) });
  }
  if (heatDays7 >= 3) {
    flags.push("heat");
    advisory.push({ code: "heat", level: "moderate", crop: c.en, days: heatDays7, threshold: c.heatC });
  }
  if (fungalRisk === "high") {
    flags.push("disease");
    advisory.push({ code: "disease", level: "high", crop: c.en, disease: wetWeatherDisease(c.id) });
  }

  return {
    crop: { id: c.id, label: c.en, rw: c.rw },
    period: { start: last30[0]?.date || last, end: last, days: last30.length },
    rain: {
      last30mm: round(rainLast30, 1),
      normal30mm: round(normal30, 1),
      anomalyPct,
      last7mm: round(rainLast7, 1),
    },
    soil: { rootZone: round(soilNow, 2), normal: round(soilNormal, 2) },
    drySpellDays,
    heavyRain3dMm: round(heavy3, 1),
    heat: { thresholdC: c.heatC, days7: heatDays7 },
    growingDegreeDays14: round(gdd14),
    fungalRisk,
    waterNeed30mm: need30,
    flags,
    advisory,
    attribution: ATTRIBUTION,
  };
}

/* ---------------- cached public API ---------------- */

const cacheKey = (lat, lng, crop, day) => `${Number(lat).toFixed(2)},${Number(lng).toFixed(2)},${crop},${day}`;

export async function getFieldClimate({ lat, lng, crop, today, fresh = false }) {
  const c = getCrop(crop);
  const day = today || iso(Date.now());
  const key = cacheKey(lat, lng, c.id, day);

  const cachedRow = await one("SELECT payload, fetched_at FROM climate_cache WHERE key=$1", [key]).catch(() => null);
  const ageHours = cachedRow ? (Date.now() - new Date(cachedRow.fetched_at).getTime()) / 3_600_000 : Infinity;
  if (!fresh && cachedRow && ageHours < cacheHours()) {
    return { ...cachedRow.payload, cached: true, fetchedAt: cachedRow.fetched_at };
  }

  try {
    const start = iso(isoYearsAgo(new Date(day + "T00:00:00Z"), CLIMATOLOGY_YEARS + 1));
    const days = await fetchSeries({ lat, lng, start, end: day });
    const summary = summariseClimate(days, { crop: c.id, today: day });
    const payload = { ...summary, location: { lat: Number(lat), lng: Number(lng) }, source: "NASA POWER" };
    await query(
      `INSERT INTO climate_cache (key, payload, fetched_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET payload=$2, fetched_at=now()`,
      [key, payload]
    ).catch((err) => console.error("climate cache write failed:", err.message));
    // keep the table small; best effort, never blocks the answer
    query("DELETE FROM climate_cache WHERE fetched_at < now() - interval '60 days'").catch(() => {});
    return { ...payload, cached: false, fetchedAt: new Date().toISOString() };
  } catch (err) {
    if (cachedRow) return { ...cachedRow.payload, cached: true, stale: true, fetchedAt: cachedRow.fetched_at };
    throw err instanceof HttpError ? err : new HttpError(502, "Could not load field conditions. Please try again later.");
  }
}

// Human-readable label used in emails and exports
export function describeClimate(summary, lang) {
  if (!summary) return "";
  const crop = cropLabel(summary.crop?.id, lang);
  const bits = [`${crop}: ${summary.rain.last30mm} mm rain in 30 days`];
  if (summary.rain.anomalyPct != null) bits.push(`${summary.rain.anomalyPct > 0 ? "+" : ""}${summary.rain.anomalyPct}% vs normal`);
  if (summary.drySpellDays) bits.push(`${summary.drySpellDays} dry days`);
  if (summary.flags?.length) bits.push("watch: " + summary.flags.join(", "));
  return bits.join(" · ");
}
