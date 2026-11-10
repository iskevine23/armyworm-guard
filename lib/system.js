// System settings, activity log and rate limiting, all stored in the database.
import { query, one, many } from "./db.js";
import { HttpError } from "./http.js";

/* ---------------- settings ---------------- */

export const DEFAULT_SETTINGS = {
  outbreak: {
    min_farmers: 3,                       // independent farmers needed to raise an alert
    radius_km: 5,                         // how close their reports must be
    window_days: 7,                       // how recent their reports must be
    qualifying_stages: ["moderate", "severe"],
    min_confidence: 0.6,                  // AI confidence a scan needs to count
    notify_farmers_on_confirm: true,      // email farmers in the area when an advisor confirms
  },
  public_scan: {
    daily_limit_per_ip: 15,               // anonymous scans per IP address per day
  },
  farmer_scan: {
    daily_limit: 60,                      // scans per farmer per day
  },
  chat: {
    daily_limit: 80,                      // assistant questions per user per day
  },
  registration: {
    farmers_open: true,                   // allow farmers to self-register
  },
  requests: {
    auto_assign: true,                    // assign new requests to an advisor covering the district
  },
};

const STAGES = ["none", "early", "moderate", "severe"];

let cache = null;
let cacheAt = 0;

export async function getSettings({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cacheAt < 30000) return cache;
  const rows = await many("SELECT key, value FROM settings");
  const merged = structuredClone(DEFAULT_SETTINGS);
  for (const r of rows) {
    if (merged[r.key] && typeof r.value === "object") Object.assign(merged[r.key], r.value);
  }
  cache = merged;
  cacheAt = Date.now();
  return merged;
}

function bounded(v, min, max, name) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${name} must be between ${min} and ${max}`);
  return n;
}

// Validates a partial settings object from the admin screen and saves it
export async function updateSettings(input, userId) {
  const current = await getSettings({ fresh: true });
  const next = structuredClone(current);
  const o = input.outbreak || {};
  if (o.min_farmers !== undefined) next.outbreak.min_farmers = Math.trunc(bounded(o.min_farmers, 2, 100, "Minimum farmers"));
  if (o.radius_km !== undefined) next.outbreak.radius_km = bounded(o.radius_km, 0.5, 100, "Radius (km)");
  if (o.window_days !== undefined) next.outbreak.window_days = Math.trunc(bounded(o.window_days, 1, 60, "Time window (days)"));
  if (o.min_confidence !== undefined) next.outbreak.min_confidence = bounded(o.min_confidence, 0, 1, "Minimum confidence");
  if (o.qualifying_stages !== undefined) {
    const st = Array.isArray(o.qualifying_stages) ? o.qualifying_stages.filter((s) => STAGES.includes(s) && s !== "none") : [];
    if (!st.length) throw new HttpError(400, "Choose at least one damage stage that counts toward an outbreak");
    next.outbreak.qualifying_stages = [...new Set(st)];
  }
  if (o.notify_farmers_on_confirm !== undefined) next.outbreak.notify_farmers_on_confirm = !!o.notify_farmers_on_confirm;
  if (input.public_scan?.daily_limit_per_ip !== undefined)
    next.public_scan.daily_limit_per_ip = Math.trunc(bounded(input.public_scan.daily_limit_per_ip, 0, 1000, "Public scans per IP per day"));
  if (input.farmer_scan?.daily_limit !== undefined)
    next.farmer_scan.daily_limit = Math.trunc(bounded(input.farmer_scan.daily_limit, 1, 1000, "Scans per farmer per day"));
  if (input.chat?.daily_limit !== undefined)
    next.chat.daily_limit = Math.trunc(bounded(input.chat.daily_limit, 0, 2000, "Assistant questions per day"));
  if (input.registration?.farmers_open !== undefined) next.registration.farmers_open = !!input.registration.farmers_open;
  if (input.requests?.auto_assign !== undefined) next.requests.auto_assign = !!input.requests.auto_assign;

  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    await query(
      `INSERT INTO settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [key, JSON.stringify(next[key]), userId]
    );
  }
  cache = null;
  return next;
}

/* ---------------- activity log ---------------- */

export async function logActivity(userId, action, entityType = null, entityId = null, details = null, ip = null) {
  try {
    await query(
      "INSERT INTO activity_log (user_id, action, entity_type, entity_id, details, ip) VALUES ($1,$2,$3,$4,$5,$6)",
      [userId || null, action, entityType, entityId, details ? JSON.stringify(details) : null, ip]
    );
  } catch (err) {
    console.error("activity log failed:", err.message); // never block the user's action on logging
  }
}

/* ---------------- rate limiting (fixed window, stored in the database) ---------------- */

export async function rateLimit(key, limit, windowSeconds, message) {
  if (limit <= 0) throw new HttpError(429, message || "This feature is turned off right now.");
  const row = await one(
    `INSERT INTO rate_limits (key, window_start, count) VALUES ($1, now(), 1)
     ON CONFLICT (key) DO UPDATE SET
       count = CASE WHEN rate_limits.window_start < now() - make_interval(secs => $2) THEN 1 ELSE rate_limits.count + 1 END,
       window_start = CASE WHEN rate_limits.window_start < now() - make_interval(secs => $2) THEN now() ELSE rate_limits.window_start END
     RETURNING count`,
    [key, windowSeconds]
  );
  if (row.count > limit) {
    throw new HttpError(429, message || "Too many requests. Please wait and try again.");
  }
}

// occasional housekeeping, called opportunistically (no cron needed)
export async function housekeeping() {
  if (Math.random() > 0.05) return;
  try {
    await query("DELETE FROM rate_limits WHERE window_start < now() - interval '2 days'");
    await query("DELETE FROM scans WHERE user_id IS NULL AND created_at < now() - interval '2 days'");
    await query("DELETE FROM password_resets WHERE expires_at < now() - interval '7 days'");
  } catch (err) {
    console.error("housekeeping failed:", err.message);
  }
}
