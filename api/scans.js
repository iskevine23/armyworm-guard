// /api/scans
//   POST              scan a photo. Anyone may scan; visitors get the BASIC result only.
//                     Logged-in users get the full result, spread risk, and the scan is saved.
//   POST ?action=claim attach a visitor's scan to the account after logging in -> full result
//   GET  ?action=list  scans the caller may see (farmer: own; advisor: coverage area; admin: all)
//   GET  ?action=get&id=
//   DELETE ?id=        farmer deletes own scan (not when it is part of a request or an outbreak)
//   GET  ?action=export  CSV of the scans the caller may see
import { api, HttpError, num, oneOf, id as idField, paging, str } from "../lib/http.js";
import { one, many, query } from "../lib/db.js";
import { getUser, randomToken, sha256 } from "../lib/auth.js";
import { detectImage } from "../lib/gemini.js";
import { predictSpread } from "../lib/spread.js";
import { evaluateScan, scanQualifies } from "../lib/outbreak.js";
import { getSettings, rateLimit, logActivity, housekeeping } from "../lib/system.js";
import { scanScope } from "../lib/access.js";
import { csvResponse } from "../lib/csv.js";
import { formatScan } from "../lib/format.js";

const LOC_SOURCES = ["gps", "farm", "default", "none"];

function validThumb(t) {
  if (typeof t !== "string") return null;
  if (!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(t)) return null;
  return t.length <= 40000 ? t : null;
}

async function resolveLocation(user, body) {
  const farm = user.role === "farmer"
    ? await one("SELECT lat, lng FROM farmer_profiles WHERE user_id=$1", [user.id])
    : null;
  const hasFarm = farm && typeof farm.lat === "number" && typeof farm.lng === "number";
  let source = LOC_SOURCES.includes(body.locSource) ? body.locSource : "none";
  const lat = num(body.lat, { min: -90, max: 90, name: "Latitude" });
  const lng = num(body.lng, { min: -180, max: 180, name: "Longitude" });
  if (source === "gps" && lat !== null && lng !== null) return { lat, lng, source: "gps" };
  if (hasFarm) return { lat: farm.lat, lng: farm.lng, source: "farm" }; // trust the saved farm, not the browser
  if (source === "default" && lat !== null && lng !== null) return { lat, lng, source: "default" };
  return { lat: null, lng: null, source: "none" };
}

// Spread risk using every logged-in farmer's recent reports near this location (not only this phone)
async function spreadFor(loc, stage, excludeId) {
  if (loc.lat === null) return null;
  const dLat = 6 / 111, dLng = 6 / (111 * Math.max(0.2, Math.cos((loc.lat * Math.PI) / 180)));
  const rows = await many(
    `SELECT lat, lng, stage, created_at FROM scans
      WHERE user_id IS NOT NULL AND stage <> 'none' AND id <> $5 AND loc_source IN ('gps','farm')
        AND created_at >= now() - interval '30 days'
        AND lat BETWEEN $1 AND $2 AND lng BETWEEN $3 AND $4
      ORDER BY created_at DESC LIMIT 1000`,
    [loc.lat - dLat, loc.lat + dLat, loc.lng - dLng, loc.lng + dLng, excludeId || 0]
  );
  return predictSpread(
    rows.map((r) => ({ lat: r.lat, lng: r.lng, stage: r.stage, timestamp: new Date(r.created_at).toISOString() })),
    { lat: loc.lat, lng: loc.lng, stage, timestamp: new Date().toISOString() }
  );
}

// Saves location, spread and outbreak flags on a scan that now belongs to `user`, then runs outbreak detection
async function finalise(req, user, scanId, body) {
  const settings = await getSettings();
  const base = await one("SELECT * FROM scans WHERE id=$1", [scanId]);
  const loc = await resolveLocation(user, body);
  const spread = await spreadFor(loc, base.stage, base.id);
  const draft = { ...base, lat: loc.lat, lng: loc.lng, loc_source: loc.source };
  const qualifies = scanQualifies(draft, user, settings);
  const s = await one(
    `UPDATE scans SET user_id=$2, lat=$3, lng=$4, loc_source=$5, district=$6, sector=$7,
            risk_score=$8, risk_level=$9, spread_km_week=$10, qualifies_outbreak=$11, claim_token_hash=NULL
      WHERE id=$1 RETURNING *`,
    [scanId, user.id, loc.lat, loc.lng, loc.source, user.district, user.sector,
     spread?.riskScore ?? null, spread?.riskLevel ?? null, spread?.estimatedSpreadKmPerWeek ?? null, qualifies]
  );
  let outbreak = { action: "none" };
  try {
    outbreak = await evaluateScan(req, s);
  } catch (err) {
    console.error("outbreak evaluation failed:", err); // the farmer still gets their result
  }
  return {
    scan: formatScan(s, user),
    spread,
    outbreak: {
      action: outbreak.action,
      alertId: outbreak.alert?.id || null,
      alertStatus: outbreak.alert?.status || null,
      qualifies,
      farmersNearby: outbreak.farmersNearby ?? null,
    },
  };
}

export default api(
  {
    "POST ": {
      auth: null,
      fn: async ({ req, body, user, ip }) => {
        housekeeping();
        const settings = await getSettings();
        if (user) {
          await rateLimit(`scan:u:${user.id}`, settings.farmer_scan.daily_limit, 86400, "You have reached today's scan limit. Try again tomorrow.");
        } else {
          await rateLimit(`scan:ip:${ip}`, settings.public_scan.daily_limit_per_ip, 86400,
            "You have reached the free scan limit for today. Create a free account to keep scanning.");
        }
        const lang = body.lang === "rw" ? "rw" : "en";
        const { result, model } = await detectImage({ image: body.image, mediaType: body.mediaType, lang });
        const thumb = validThumb(body.thumb);

        if (!user) {
          const claim = randomToken(24);
          const row = await one(
            `INSERT INTO scans (user_id, claim_token_hash, pest_detected, stage, confidence, affected_area, recommendation, thumb, lang, model, loc_source)
             VALUES (NULL,$1,$2,$3,$4,$5,$6,$7,$8,$9,'none') RETURNING id, created_at`,
            [sha256(claim), result.pestDetected, result.stage, result.confidence, result.affectedArea, result.recommendation, thumb, lang, model]
          );
          // BASIC result only. Details, spread risk and help need an account.
          return {
            basic: true,
            scanId: row.id,
            claimToken: claim,
            createdAt: row.created_at,
            pestDetected: result.pestDetected,
            stage: result.stage,
            confidence: result.confidence,
          };
        }

        const row = await one(
          `INSERT INTO scans (user_id, pest_detected, stage, confidence, affected_area, recommendation, thumb, lang, model)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [user.id, result.pestDetected, result.stage, result.confidence, result.affectedArea, result.recommendation, thumb, lang, model]
        );
        const out = await finalise(req, user, row.id, body);
        await logActivity(user.id, "scan", "scan", row.id, { stage: result.stage, outbreak: out.outbreak.action }, ip);
        return { basic: false, ...out };
      },
    },

    "POST claim": {
      auth: "any",
      fn: async ({ req, body, user, ip }) => {
        const scanId = idField(body.scanId, "scan");
        const token = str(body.claimToken, 100, { required: true, name: "claimToken" });
        const s = await one(
          `SELECT id FROM scans WHERE id=$1 AND user_id IS NULL AND claim_token_hash=$2 AND created_at > now() - interval '24 hours'`,
          [scanId, sha256(token)]
        );
        if (!s) throw new HttpError(404, "This scan has expired or was already saved. Please scan the leaf again.");
        const out = await finalise(req, user, scanId, body);
        await query("UPDATE scans SET claimed_at=now() WHERE id=$1", [scanId]);
        await logActivity(user.id, "scan_claimed", "scan", scanId, { outbreak: out.outbreak.action }, ip);
        return { basic: false, ...out };
      },
    },

    "GET list": {
      auth: "any",
      fn: async ({ query: q, user }) => {
        const { limit, offset } = paging(q, { max: 200, def: 30 });
        const scope = await scanScope(user, 1);
        const where = [scope.sql];
        const params = [...scope.params];
        const add = (sql, v) => { params.push(v); where.push(sql.replace("?", "$" + params.length)); };
        if (q.stage) add("s.stage = ?", oneOf(q.stage, ["none", "early", "moderate", "severe"], { name: "stage" }));
        if (q.pest === "1") where.push("s.pest_detected");
        if (q.district) add("lower(s.district) = lower(?)", String(q.district).slice(0, 60));
        if (q.from) add("s.created_at >= ?::date", String(q.from).slice(0, 10));
        if (q.to) add("s.created_at < ?::date + 1", String(q.to).slice(0, 10));
        if (q.userId && user.role !== "farmer") add("s.user_id = ?", idField(q.userId, "userId"));
        params.push(limit, offset);
        const rows = await many(
          `SELECT s.*, u.full_name AS farmer_name, u.phone AS farmer_phone, u.email AS farmer_email,
                  (SELECT alert_id FROM outbreak_alert_scans x WHERE x.scan_id = s.id LIMIT 1) AS alert_id,
                  COUNT(*) OVER() AS total
             FROM scans s JOIN users u ON u.id = s.user_id
            WHERE ${where.join(" AND ")}
            ORDER BY s.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
          params
        );
        return { total: rows[0]?.total || 0, scans: rows.map((r) => formatScan(r, user)) };
      },
    },

    "GET get": {
      auth: "any",
      fn: async ({ query: q, user }) => {
        const scanId = idField(q.id, "scan");
        const scope = await scanScope(user, 2);
        const s = await one(
          `SELECT s.*, u.full_name AS farmer_name, u.phone AS farmer_phone, u.email AS farmer_email,
                  (SELECT alert_id FROM outbreak_alert_scans x WHERE x.scan_id = s.id LIMIT 1) AS alert_id,
                  (SELECT id FROM assistance_requests r WHERE r.scan_id = s.id ORDER BY id DESC LIMIT 1) AS request_id
             FROM scans s JOIN users u ON u.id = s.user_id WHERE s.id = $1 AND ${scope.sql}`,
          [scanId, ...scope.params]
        );
        if (!s) throw new HttpError(404, "Scan not found");
        return { scan: formatScan(s, user) };
      },
    },

    "DELETE ": {
      auth: ["farmer"],
      fn: async ({ query: q, user, ip }) => {
        const scanId = idField(q.id, "scan");
        const s = await one("SELECT id FROM scans WHERE id=$1 AND user_id=$2", [scanId, user.id]);
        if (!s) throw new HttpError(404, "Scan not found");
        const linked = await one(
          `SELECT (SELECT COUNT(*) FROM outbreak_alert_scans WHERE scan_id=$1) + (SELECT COUNT(*) FROM assistance_requests WHERE scan_id=$1) AS n`,
          [scanId]
        );
        if (linked.n > 0) throw new HttpError(409, "This scan is part of a help request or an outbreak report, so it is kept.");
        await query("DELETE FROM scans WHERE id=$1", [scanId]);
        await logActivity(user.id, "scan_deleted", "scan", scanId, null, ip);
        return { ok: true };
      },
    },

    "GET export": {
      auth: "any",
      fn: async ({ user }) => {
        const scope = await scanScope(user, 1);
        const rows = await many(
          `SELECT s.*, u.full_name AS farmer_name, u.phone AS farmer_phone FROM scans s JOIN users u ON u.id = s.user_id
            WHERE ${scope.sql} ORDER BY s.created_at DESC LIMIT 20000`,
          scope.params
        );
        const head = ["id", "time", "farmer", "phone", "pest_detected", "damage_stage", "confidence", "spread_risk_level", "spread_risk_score",
          "what_ai_saw", "suggested_action", "district", "sector", "latitude", "longitude", "location_source", "counts_for_outbreak"];
        const data = rows.map((s) => [s.id, s.created_at, s.farmer_name, s.farmer_phone, s.pest_detected, s.stage, s.confidence, s.risk_level, s.risk_score,
          s.affected_area, s.recommendation, s.district, s.sector, s.lat, s.lng, s.loc_source, s.qualifies_outbreak]);
        return csvResponse("armywormguard-scans.csv", head, data);
      },
    },
  },
  { getUser }
);
