// Automatic outbreak detection.
//
// A scan "qualifies" when: it was made by an active FARMER account, the AI found damage at a
// qualifying stage (default moderate/severe) with enough confidence, and it has a real location
// (GPS or the saved farm location, never the default fallback).
//
// When at least `min_farmers` DIFFERENT farmers have qualifying scans within `radius_km` of each
// other inside the last `window_days`, a SUSPECTED outbreak alert is created and advisors covering
// the district plus all administrators are notified (in-app + email). Repeat scans by one farmer
// only ever count once (we count distinct farmer accounts). Advisors then investigate and move the
// alert to investigating / confirmed / false_alarm / resolved. Only a person can confirm.
import { tx, many } from "./db.js";
import { getSettings } from "./system.js";
import { haversineKm } from "./spread.js";
import { notifyUsers, admins, advisorsFor } from "./notify.js";

export const ACTIVE_STATUSES = ["suspected", "investigating", "confirmed"];
export const ALL_STATUSES = ["suspected", "investigating", "confirmed", "resolved", "false_alarm"];
const STAGE_RANK = { none: 0, early: 1, moderate: 2, severe: 3 };

export function scanQualifies(scan, user, settings) {
  const o = settings.outbreak;
  return (
    user?.role === "farmer" &&
    scan.pest_detected === true &&
    o.qualifying_stages.includes(scan.stage) &&
    (scan.confidence ?? 0) >= o.min_confidence &&
    (scan.loc_source === "gps" || scan.loc_source === "farm") &&
    typeof scan.lat === "number" &&
    typeof scan.lng === "number"
  );
}

function bbox(lat, lng, km) {
  const dLat = km / 111.0;
  const dLng = km / (111.0 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  return [lat - dLat, lat + dLat, lng - dLng, lng + dLng];
}

function mostCommon(values) {
  const counts = new Map();
  for (const v of values) if (v) counts.set(v, (counts.get(v) || 0) + 1);
  let best = null;
  let n = 0;
  for (const [k, c] of counts) if (c > n) { best = k; n = c; }
  return best;
}

async function refreshCounts(client, alertId) {
  const r = await client.query(
    `SELECT COUNT(DISTINCT oas.farmer_id) AS farmers, COUNT(*) AS scans,
            MIN(s.created_at) AS first_at, MAX(s.created_at) AS last_at,
            MAX(CASE s.stage WHEN 'severe' THEN 3 WHEN 'moderate' THEN 2 WHEN 'early' THEN 1 ELSE 0 END) AS max_rank
       FROM outbreak_alert_scans oas JOIN scans s ON s.id = oas.scan_id
      WHERE oas.alert_id = $1`,
    [alertId]
  );
  const x = r.rows[0];
  const maxStage = Object.keys(STAGE_RANK).find((k) => STAGE_RANK[k] === Number(x.max_rank)) || null;
  const u = await client.query(
    `UPDATE outbreak_alerts SET farmer_count=$2, scan_count=$3, first_report_at=$4, last_report_at=$5,
            max_stage=$6, updated_at=now() WHERE id=$1 RETURNING *`,
    [alertId, Number(x.farmers), Number(x.scans), x.first_at, x.last_at, maxStage]
  );
  return u.rows[0];
}

// Called after a qualifying scan is saved. Returns { action: 'none' | 'joined' | 'created', alert }
export async function evaluateScan(req, scan) {
  if (!scan.qualifies_outbreak) return { action: "none" };
  const settings = await getSettings();
  const o = settings.outbreak;

  const outcome = await tx(async (client) => {
    // one evaluation at a time, so two farmers scanning together cannot create duplicate alerts
    await client.query("SELECT pg_advisory_xact_lock(727002)");

    // 1. Is this scan inside an alert that is still open?
    const open = await client.query(
      `SELECT * FROM outbreak_alerts
        WHERE status = ANY($1) AND last_report_at >= now() - make_interval(days => window_days)`,
      [ACTIVE_STATUSES]
    );
    let nearest = null;
    for (const a of open.rows) {
      const d = haversineKm({ lat: a.center_lat, lng: a.center_lng }, scan);
      if (d <= a.radius_km && (!nearest || d < nearest.d)) nearest = { a, d };
    }
    if (nearest) {
      const before = nearest.a.farmer_count;
      await client.query(
        `INSERT INTO outbreak_alert_scans (alert_id, scan_id, farmer_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [nearest.a.id, scan.id, scan.user_id]
      );
      const alert = await refreshCounts(client, nearest.a.id);
      if (alert.farmer_count > before) {
        await client.query(
          `INSERT INTO outbreak_updates (alert_id, old_status, new_status, note) VALUES ($1,$2,$2,$3)`,
          [alert.id, alert.status, `Another farmer reported damage in the area (${alert.farmer_count} farmers in total).`]
        );
      }
      return { action: "joined", alert, newFarmer: alert.farmer_count > before };
    }

    // 2. Otherwise, look for enough independent farmers around this scan
    const [la1, la2, ln1, ln2] = bbox(scan.lat, scan.lng, o.radius_km);
    const cand = await client.query(
      `SELECT s.id, s.user_id, s.lat, s.lng, s.stage, s.district, s.sector, s.created_at
         FROM scans s JOIN users u ON u.id = s.user_id
        WHERE s.qualifies_outbreak AND u.role = 'farmer' AND u.status = 'active'
          AND s.created_at >= now() - make_interval(days => $1)
          AND s.lat BETWEEN $2 AND $3 AND s.lng BETWEEN $4 AND $5
          AND NOT EXISTS (
            SELECT 1 FROM outbreak_alert_scans oas JOIN outbreak_alerts oa ON oa.id = oas.alert_id
             WHERE oas.scan_id = s.id AND oa.status IN ('resolved','false_alarm'))`,
      [o.window_days, la1, la2, ln1, ln2]
    );
    const cluster = cand.rows.filter((s) => haversineKm(scan, s) <= o.radius_km);
    const latestPerFarmer = new Map();
    for (const s of cluster) {
      const prev = latestPerFarmer.get(s.user_id);
      if (!prev || new Date(s.created_at) > new Date(prev.created_at)) latestPerFarmer.set(s.user_id, s);
    }
    if (latestPerFarmer.size < o.min_farmers) {
      return { action: "none", farmersNearby: latestPerFarmer.size, needed: o.min_farmers };
    }

    // one point per farmer, so a farmer who scans many times cannot pull the centre
    const pts = [...latestPerFarmer.values()];
    const centerLat = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
    const centerLng = pts.reduce((s, p) => s + p.lng, 0) / pts.length;
    const times = cluster.map((s) => new Date(s.created_at).getTime());
    const ins = await client.query(
      `INSERT INTO outbreak_alerts (status, center_lat, center_lng, radius_km, district, sector,
              threshold_farmers, window_days, first_report_at, last_report_at)
       VALUES ('suspected',$1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [centerLat, centerLng, o.radius_km, mostCommon(cluster.map((s) => s.district)), mostCommon(cluster.map((s) => s.sector)),
       o.min_farmers, o.window_days, new Date(Math.min(...times)), new Date(Math.max(...times))]
    );
    const alertId = ins.rows[0].id;
    for (const s of cluster) {
      await client.query(
        `INSERT INTO outbreak_alert_scans (alert_id, scan_id, farmer_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [alertId, s.id, s.user_id]
      );
    }
    const alert = await refreshCounts(client, alertId);
    await client.query(
      `INSERT INTO outbreak_updates (alert_id, old_status, new_status, note) VALUES ($1,NULL,'suspected',$2)`,
      [alertId, `Raised automatically: ${alert.farmer_count} different farmers reported ${o.qualifying_stages.join("/")} damage within ${o.radius_km} km in ${o.window_days} days.`]
    );
    return { action: "created", alert };
  });

  // Notifications happen after the transaction so email never holds the lock
  if (outcome.action === "created") {
    const a = outcome.alert;
    const recipients = [...(await advisorsFor(a.district)), ...(await admins())];
    const where = [a.sector, a.district].filter(Boolean).join(", ") || `${a.center_lat.toFixed(4)}, ${a.center_lng.toFixed(4)}`;
    outcome.notify = await notifyUsers(
      req,
      recipients,
      {
        type: "outbreak_new",
        title: `Suspected fall armyworm outbreak #${a.id} — ${where}`,
        body: `${a.farmer_count} different farmers reported ${a.max_stage || "significant"} damage within ${a.radius_km} km in the last ${a.window_days} days. Please investigate.`,
        link: `/dashboard.html#outbreak-${a.id}`,
        email: {
          subject: `[ArmywormGuard] Suspected outbreak #${a.id} near ${where}`,
          heading: "Suspected fall armyworm outbreak",
          lines: [
            `${a.farmer_count} different farmers have reported ${a.max_stage || "significant"} fall armyworm damage close to each other. ArmywormGuard has raised a SUSPECTED outbreak alert.`,
            "This is based on AI photo assessments and has not been checked in the field. Please investigate and update the alert status (investigating, confirmed or false alarm).",
          ],
          details: [
            ["Alert", `#${a.id} (suspected)`],
            ["Area", where],
            ["Centre", `${a.center_lat.toFixed(5)}, ${a.center_lng.toFixed(5)} (radius ${a.radius_km} km)`],
            ["Farmers reporting", String(a.farmer_count)],
            ["Scans", String(a.scan_count)],
            ["Worst damage", a.max_stage || "—"],
            ["Reports between", `${new Date(a.first_report_at).toUTCString()} and ${new Date(a.last_report_at).toUTCString()}`],
            ["Map", `https://www.google.com/maps?q=${a.center_lat.toFixed(5)},${a.center_lng.toFixed(5)}`],
          ],
          buttonLabel: "Investigate the alert",
        },
      },
      { relatedType: "outbreak", relatedId: a.id }
    );
  } else if (outcome.action === "joined" && outcome.newFarmer) {
    const a = outcome.alert;
    const recipients = a.assigned_advisor_id
      ? await many("SELECT id, email FROM users WHERE id=$1 AND status='active'", [a.assigned_advisor_id])
      : await advisorsFor(a.district);
    await notifyUsers(req, recipients, {
      type: "outbreak_update",
      title: `Outbreak #${a.id}: another farmer reported damage (${a.farmer_count} farmers)`,
      body: `Alert #${a.id} (${a.status}) now has ${a.farmer_count} farmers and ${a.scan_count} scans.`,
      link: `/dashboard.html#outbreak-${a.id}`,
    }, { relatedType: "outbreak", relatedId: a.id });
  }
  return outcome;
}

// Farmers to warn when an outbreak is confirmed or resolved: those who reported it, plus farmers
// whose saved farm location is inside the alert area.
export async function farmersInArea(alert) {
  const [la1, la2, ln1, ln2] = bbox(alert.center_lat, alert.center_lng, alert.radius_km);
  const nearby = await many(
    `SELECT u.id, u.email, f.lat, f.lng FROM users u JOIN farmer_profiles f ON f.user_id = u.id
      WHERE u.role='farmer' AND u.status='active' AND f.lat BETWEEN $1 AND $2 AND f.lng BETWEEN $3 AND $4`,
    [la1, la2, ln1, ln2]
  );
  const inside = nearby.filter((f) => haversineKm({ lat: alert.center_lat, lng: alert.center_lng }, f) <= alert.radius_km);
  const reporters = await many(
    `SELECT DISTINCT u.id, u.email FROM outbreak_alert_scans oas JOIN users u ON u.id = oas.farmer_id
      WHERE oas.alert_id = $1 AND u.status='active'`,
    [alert.id]
  );
  return [...reporters, ...inside];
}
