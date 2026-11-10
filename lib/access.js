// Role-based data access rules, applied in SQL on the server (never trusted to the browser).
//
//  farmer   : only their own scans and their own assistance requests
//  advisor  : requests assigned to them, unassigned requests in their coverage area,
//             farmer scans in their coverage area (empty coverage = every district),
//             scans attached to requests they can see or to any outbreak alert,
//             all outbreak alerts
//  admin    : everything
import { one } from "./db.js";
import { HttpError } from "./http.js";

export async function advisorCoverage(userId) {
  const r = await one("SELECT coverage_districts FROM advisor_profiles WHERE user_id=$1", [userId]);
  return (r?.coverage_districts || []).map((d) => String(d).trim().toLowerCase()).filter(Boolean);
}

// Returns { sql, params } to AND into a query on `scans s`. `start` is the next $ number.
export async function scanScope(user, start = 1) {
  if (user.role === "admin") return { sql: "s.user_id IS NOT NULL", params: [] };
  if (user.role === "farmer") return { sql: `s.user_id = $${start}`, params: [user.id] };
  const cov = await advisorCoverage(user.id);
  const p = cov.length ? [user.id, cov] : [user.id];
  const covSql = cov.length ? `lower(coalesce(s.district,'')) = ANY($${start + 1}::text[])` : "TRUE";
  return {
    sql: `s.user_id IS NOT NULL AND (
            (${covSql})
         OR EXISTS (SELECT 1 FROM outbreak_alert_scans x WHERE x.scan_id = s.id)
         OR EXISTS (SELECT 1 FROM assistance_requests ar WHERE ar.scan_id = s.id AND (ar.advisor_id = $${start} OR ar.advisor_id IS NULL)))`,
    params: p,
  };
}

// Returns { sql, params } to AND into a query on `assistance_requests r`
export async function requestScope(user, start = 1) {
  if (user.role === "admin") return { sql: "TRUE", params: [] };
  if (user.role === "farmer") return { sql: `r.farmer_id = $${start}`, params: [user.id] };
  const cov = await advisorCoverage(user.id);
  const covSql = cov.length ? `lower(coalesce(r.district,'')) = ANY($${start + 1}::text[])` : "TRUE";
  return {
    sql: `(r.advisor_id = $${start} OR (r.advisor_id IS NULL AND ${covSql}))`,
    params: cov.length ? [user.id, cov] : [user.id],
  };
}

export function requireRole(user, ...roles) {
  if (!user || !roles.includes(user.role)) throw new HttpError(403, "You do not have permission to do this");
}
