// /api/admin — administrator only. Every action here is checked on the server for role = admin.
//   GET  stats | health | users | settings | emails | activity | report
//   POST user-create | user-update&id= | user-reset&id= | email-retry&id= | email-retry-failed | email-test
//   PUT  settings
//   DELETE user&id=
import { api, HttpError, str, email as emailField, oneOf, id as idField, paging } from "../lib/http.js";
import { one, many, query, tx, dbConfigured, describeConnection, dbFailure } from "../lib/db.js";
import { getUser, hashPassword, randomToken, USER_COLUMNS, publicUser } from "../lib/auth.js";
import { getSettings, updateSettings, logActivity } from "../lib/system.js";
import { emailConfigured, emailConfig, retryEmail, renderEmail, sendEmail } from "../lib/mailer.js";
import { geminiConfigured } from "../lib/gemini.js";
import { districtList } from "../lib/format.js";
import { csvResponse } from "../lib/csv.js";
import { sendResetEmail } from "./auth.js";

const ROLES = ["farmer", "advisor", "admin"];
const ADMIN = ["admin"];

async function otherActiveAdmins(exceptId) {
  const r = await one("SELECT COUNT(*)::int AS n FROM users WHERE role='admin' AND status='active' AND id<>$1", [exceptId]);
  return r.n;
}

function dateRange(q) {
  const from = /^\d{4}-\d{2}-\d{2}$/.test(q.from || "") ? q.from : "1970-01-01";
  const to = /^\d{4}-\d{2}-\d{2}$/.test(q.to || "") ? q.to : "2999-12-31";
  return [from, to];
}

export default api(
  {
    "GET stats": {
      auth: ADMIN,
      fn: async () => {
        const users = await many("SELECT role, status, COUNT(*)::int AS n FROM users GROUP BY role, status");
        const scans = await one(
          `SELECT COUNT(*) FILTER (WHERE user_id IS NOT NULL)::int AS total,
                  COUNT(*) FILTER (WHERE user_id IS NOT NULL AND created_at > now() - interval '7 days')::int AS week,
                  COUNT(*) FILTER (WHERE user_id IS NOT NULL AND pest_detected)::int AS pest,
                  COUNT(*) FILTER (WHERE user_id IS NOT NULL AND qualifies_outbreak)::int AS qualifying,
                  COUNT(*) FILTER (WHERE user_id IS NULL)::int AS anonymous_recent
             FROM scans`
        );
        const stages = await many("SELECT stage, COUNT(*)::int AS n FROM scans WHERE user_id IS NOT NULL GROUP BY stage");
        const requests = await many("SELECT status, COUNT(*)::int AS n FROM assistance_requests GROUP BY status");
        const alerts = await many("SELECT status, COUNT(*)::int AS n FROM outbreak_alerts GROUP BY status");
        const emails = await many("SELECT status, COUNT(*)::int AS n FROM email_log WHERE created_at > now() - interval '30 days' GROUP BY status");
        const perDay = await many(
          `SELECT to_char(d, 'YYYY-MM-DD') AS day,
                  (SELECT COUNT(*)::int FROM scans s WHERE s.user_id IS NOT NULL AND s.created_at >= d AND s.created_at < d + interval '1 day') AS scans,
                  (SELECT COUNT(*)::int FROM scans s WHERE s.user_id IS NOT NULL AND s.pest_detected AND s.created_at >= d AND s.created_at < d + interval '1 day') AS pest
             FROM generate_series(date_trunc('day', now()) - interval '29 days', date_trunc('day', now()), interval '1 day') d ORDER BY d`
        );
        const districts = await many(
          `SELECT COALESCE(NULLIF(district,''),'(not set)') AS district, COUNT(*)::int AS scans,
                  COUNT(*) FILTER (WHERE pest_detected)::int AS pest,
                  COUNT(*) FILTER (WHERE stage IN ('moderate','severe'))::int AS serious
             FROM scans WHERE user_id IS NOT NULL AND created_at > now() - interval '30 days'
            GROUP BY 1 ORDER BY serious DESC, scans DESC LIMIT 15`
        );
        const avgResponse = await one(
          `SELECT EXTRACT(EPOCH FROM AVG(first_reply - r.created_at))/3600 AS hours FROM assistance_requests r
             JOIN LATERAL (SELECT MIN(m.created_at) AS first_reply FROM request_messages m JOIN users u ON u.id=m.author_id
                            WHERE m.request_id=r.id AND m.kind='message' AND u.role IN ('advisor','admin')) fr ON fr.first_reply IS NOT NULL
            WHERE r.created_at > now() - interval '90 days'`
        );
        return { users, scans, stages, requests, alerts, emails, perDay, districts, avgFirstResponseHours: avgResponse?.hours == null ? null : +Number(avgResponse.hours).toFixed(1) };
      },
    },

    // Deliberately open: when the database credentials are broken nobody can log in, so an
    // admin-only endpoint could never be reached to diagnose exactly that outage. Anonymous
    // callers get a redacted summary; administrators get the full target and fix instructions.
    "GET health": {
      auth: null,
      fn: async ({ user }) => {
        const isAdmin = user?.role === "admin";
        let db = false;
        let failure = null;
        try {
          await one("SELECT 1 AS ok");
          db = true;
        } catch (err) {
          failure = dbFailure(err) || { code: err?.code || "ERROR", client: "Database error", help: String(err?.message || err) };
        }
        const base = {
          ok: true,
          database: db && dbConfigured(),
          databaseConfigured: dbConfigured(),
          dbCode: db ? null : failure?.code || "ERROR",
        };
        if (!isAdmin) {
          // Redacted: enough for a "status" page to explain why nothing saves, no infra details.
          return { ...base, message: db ? "Database connected" : failure?.client || "Database unavailable" };
        }
        const cfg = emailConfig();
        return {
          ...base,
          dbTarget: describeConnection(),
          dbError: db ? null : { code: failure.code, message: failure.client },
          dbHelp: db ? null : failure.help,
          email: emailConfigured(),
          emailProvider: cfg ? (cfg.kind === "gmail" ? "Gmail" : process.env.SMTP_HOST) : null,
          emailFrom: cfg?.from || null,
          gemini: geminiConfigured(),
          appUrl: process.env.APP_URL || null,
          jwt: (process.env.JWT_SECRET || "").length >= 32,
        };
      },
    },

    "GET users": {
      auth: ADMIN,
      fn: async ({ query: q }) => {
        const { limit, offset } = paging(q, { max: 200, def: 50 });
        const params = [];
        const w = ["TRUE"];
        const add = (sql, v) => { params.push(v); w.push(sql.replaceAll("?", "$" + params.length)); };
        if (q.role) add("u.role = ?", oneOf(q.role, ROLES, { name: "role" }));
        if (q.status) add("u.status = ?", oneOf(q.status, ["active", "suspended"], { name: "status" }));
        if (q.q) add("(u.full_name ILIKE ? OR u.email ILIKE ? OR u.phone ILIKE ? OR u.district ILIKE ?)", `%${String(q.q).slice(0, 80)}%`);
        params.push(limit, offset);
        const rows = await many(
          `SELECT ${USER_COLUMNS.split(", ").map((c) => "u." + c).join(", ")},
                  a.organization, COALESCE(a.coverage_districts,'{}') AS coverage, f.farm_name, f.lat AS farm_lat, f.lng AS farm_lng,
                  (SELECT COUNT(*) FROM scans s WHERE s.user_id=u.id)::int AS scan_count,
                  (SELECT COUNT(*) FROM assistance_requests r WHERE r.farmer_id=u.id OR r.advisor_id=u.id)::int AS request_count,
                  COUNT(*) OVER() AS total
             FROM users u LEFT JOIN advisor_profiles a ON a.user_id=u.id LEFT JOIN farmer_profiles f ON f.user_id=u.id
            WHERE ${w.join(" AND ")} ORDER BY u.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
          params
        );
        return {
          total: rows[0]?.total || 0,
          users: rows.map((u) => ({
            ...publicUser(u), organization: u.organization, coverageDistricts: u.coverage, farmName: u.farm_name,
            farmLocation: u.farm_lat != null ? { lat: u.farm_lat, lng: u.farm_lng } : null, scanCount: u.scan_count, requestCount: u.request_count,
          })),
        };
      },
    },

    "POST user-create": {
      auth: ADMIN,
      fn: async ({ req, body, user, ip }) => {
        const email = emailField(body.email);
        const fullName = str(body.fullName, 120, { required: true, name: "Full name", min: 2 });
        const role = oneOf(body.role, ROLES, { name: "role" });
        const phone = str(body.phone, 30, { name: "Phone" }) || null;
        const district = str(body.district, 60, { name: "District" }) || null;
        const sector = str(body.sector, 60, { name: "Sector" }) || null;
        if (await one("SELECT 1 FROM users WHERE lower(email)=$1", [email])) throw new HttpError(409, "An account with this email already exists");
        // a random password nobody knows; the person chooses their own through the emailed link
        const hash = await hashPassword(randomToken(24));
        const created = await tx(async (c) => {
          const r = await c.query(
            `INSERT INTO users (email, password_hash, full_name, phone, role, district, sector, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${USER_COLUMNS}`,
            [email, hash, fullName, phone, role, district, sector, user.id]
          );
          const u = r.rows[0];
          if (role === "farmer") await c.query("INSERT INTO farmer_profiles (user_id) VALUES ($1)", [u.id]);
          if (role === "advisor") {
            await c.query("INSERT INTO advisor_profiles (user_id, organization, coverage_districts) VALUES ($1,$2,$3)",
              [u.id, str(body.organization, 120, { name: "Organisation" }) || null, districtList(body.coverageDistricts)]);
          }
          return u;
        });
        const { result, link } = await sendResetEmail(req, created, { invite: true });
        await logActivity(user.id, "user_created", "user", created.id, { role, email: result }, ip);
        return {
          __status: 201,
          user: publicUser(created),
          inviteEmail: result,
          // shown to the administrator only if the email could not be delivered, so the account is still usable
          setupLink: result.sent ? null : link,
        };
      },
    },

    "POST user-update": {
      auth: ADMIN,
      fn: async ({ query: q, body, user, ip }) => {
        const targetId = idField(q.id, "user");
        const t = await one(`SELECT ${USER_COLUMNS} FROM users WHERE id=$1`, [targetId]);
        if (!t) throw new HttpError(404, "User not found");
        const role = body.role !== undefined ? oneOf(body.role, ROLES, { name: "role" }) : t.role;
        const status = body.status !== undefined ? oneOf(body.status, ["active", "suspended"], { name: "status" }) : t.status;
        if (targetId === user.id && (role !== "admin" || status !== "active")) {
          throw new HttpError(400, "You cannot remove your own administrator access. Ask another administrator.");
        }
        if (t.role === "admin" && t.status === "active" && (role !== "admin" || status !== "active") && (await otherActiveAdmins(targetId)) === 0) {
          throw new HttpError(400, "This is the last active administrator. Make someone else an administrator first.");
        }
        const fullName = body.fullName !== undefined ? str(body.fullName, 120, { required: true, name: "Full name", min: 2 }) : t.full_name;
        const phone = body.phone !== undefined ? str(body.phone, 30, { name: "Phone" }) || null : t.phone;
        const district = body.district !== undefined ? str(body.district, 60, { name: "District" }) || null : t.district;
        const sector = body.sector !== undefined ? str(body.sector, 60, { name: "Sector" }) || null : t.sector;
        const sessionChange = role !== t.role || status !== t.status;
        await tx(async (c) => {
          await c.query(
            `UPDATE users SET role=$2, status=$3, full_name=$4, phone=$5, district=$6, sector=$7, updated_at=now(),
                    token_version = token_version + $8 WHERE id=$1`,
            [targetId, role, status, fullName, phone, district, sector, sessionChange ? 1 : 0]
          );
          if (role === "farmer") await c.query("INSERT INTO farmer_profiles (user_id) VALUES ($1) ON CONFLICT DO NOTHING", [targetId]);
          if (role === "advisor") {
            await c.query("INSERT INTO advisor_profiles (user_id) VALUES ($1) ON CONFLICT DO NOTHING", [targetId]);
            if (body.coverageDistricts !== undefined || body.organization !== undefined) {
              await c.query(
                `UPDATE advisor_profiles SET coverage_districts = COALESCE($2, coverage_districts), organization = COALESCE($3, organization), updated_at=now() WHERE user_id=$1`,
                [targetId, body.coverageDistricts !== undefined ? districtList(body.coverageDistricts) : null, body.organization !== undefined ? str(body.organization, 120) : null]
              );
            }
          }
          // an advisor who stops being an advisor hands their open requests back to the pool
          if (t.role === "advisor" && (role !== "advisor" || status !== "active")) {
            await c.query("UPDATE assistance_requests SET advisor_id=NULL WHERE advisor_id=$1 AND status IN ('open','in_progress','awaiting_farmer')", [targetId]);
          }
        });
        await logActivity(user.id, "user_updated", "user", targetId, { from: { role: t.role, status: t.status }, to: { role, status } }, ip);
        const fresh = await one(`SELECT ${USER_COLUMNS} FROM users WHERE id=$1`, [targetId]);
        return { user: publicUser(fresh) };
      },
    },

    "POST user-reset": {
      auth: ADMIN,
      fn: async ({ req, query: q, user, ip }) => {
        const t = await one(`SELECT ${USER_COLUMNS} FROM users WHERE id=$1`, [idField(q.id, "user")]);
        if (!t) throw new HttpError(404, "User not found");
        const { result, link } = await sendResetEmail(req, t, { invite: true });
        await logActivity(user.id, "user_password_reset_sent", "user", t.id, { email: result }, ip);
        return { inviteEmail: result, setupLink: result.sent ? null : link };
      },
    },

    "DELETE user": {
      auth: ADMIN,
      fn: async ({ query: q, user, ip }) => {
        const targetId = idField(q.id, "user");
        if (targetId === user.id) throw new HttpError(400, "You cannot delete your own account");
        const t = await one("SELECT id, role, status, email FROM users WHERE id=$1", [targetId]);
        if (!t) throw new HttpError(404, "User not found");
        if (t.role === "admin" && (await otherActiveAdmins(targetId)) === 0) throw new HttpError(400, "You cannot delete the last administrator");
        await query("DELETE FROM users WHERE id=$1", [targetId]);
        await logActivity(user.id, "user_deleted", "user", targetId, { email: t.email, role: t.role }, ip);
        return { ok: true };
      },
    },

    "GET settings": { auth: ADMIN, fn: async () => ({ settings: await getSettings({ fresh: true }) }) },

    "PUT settings": {
      auth: ADMIN,
      fn: async ({ body, user, ip }) => {
        const before = await getSettings({ fresh: true });
        const settings = await updateSettings(body.settings || body, user.id);
        await logActivity(user.id, "settings_updated", "settings", null, { before, after: settings }, ip);
        return { settings };
      },
    },

    "GET emails": {
      auth: ADMIN,
      fn: async ({ query: q }) => {
        const { limit, offset } = paging(q, { max: 200, def: 50 });
        const params = [];
        let w = "TRUE";
        if (q.status) { params.push(oneOf(q.status, ["pending", "sent", "failed", "skipped"], { name: "status" })); w = "status=$1"; }
        params.push(limit, offset);
        const rows = await many(
          `SELECT id, to_email, subject, template, status, error, attempts, related_type, related_id, created_at, sent_at, COUNT(*) OVER() AS total
             FROM email_log WHERE ${w} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
          params
        );
        return { total: rows[0]?.total || 0, emails: rows };
      },
    },

    "POST email-retry": {
      auth: ADMIN,
      fn: async ({ query: q }) => ({ result: await retryEmail(idField(q.id, "email")) }),
    },

    "POST email-retry-failed": {
      auth: ADMIN,
      fn: async ({ user, ip }) => {
        const rows = await many(
          "SELECT id FROM email_log WHERE status IN ('failed','pending') AND created_at > now() - interval '3 days' AND attempts < 5 ORDER BY id LIMIT 25"
        );
        const results = [];
        for (const r of rows) results.push(await retryEmail(r.id));
        await logActivity(user.id, "emails_retried", "email", null, { count: rows.length }, ip);
        return { tried: rows.length, sent: results.filter((r) => r.status === "sent").length, failed: results.filter((r) => r.status !== "sent").length };
      },
    },

    "POST email-test": {
      auth: ADMIN,
      fn: async ({ body, user, ip }) => {
        const to = emailField(body.to || user.email);
        const { text, html } = renderEmail({
          heading: "ArmywormGuard test email",
          lines: ["If you can read this, email delivery from ArmywormGuard works.", `Sent by ${user.full_name} at ${new Date().toUTCString()}.`],
        });
        const result = await sendEmail({ to, subject: "ArmywormGuard test email", text, html, template: "test", respectPreference: false });
        await logActivity(user.id, "email_test", "email", null, { to, result }, ip);
        if (!result.sent) {
          const last = await one("SELECT error FROM email_log WHERE to_email=$1 AND template='test' ORDER BY id DESC LIMIT 1", [to]);
          throw new HttpError(502, "The test email was not delivered: " + (last?.error || "unknown error"));
        }
        return { ok: true, to };
      },
    },

    "GET activity": {
      auth: ADMIN,
      fn: async ({ query: q }) => {
        const { limit, offset } = paging(q, { max: 200, def: 60 });
        const rows = await many(
          `SELECT a.id, a.action, a.entity_type, a.entity_id, a.details, a.ip, a.created_at, u.full_name, u.role, COUNT(*) OVER() AS total
             FROM activity_log a LEFT JOIN users u ON u.id = a.user_id
            ORDER BY a.created_at DESC LIMIT $1 OFFSET $2`,
          [limit, offset]
        );
        return { total: rows[0]?.total || 0, activity: rows };
      },
    },

    // CSV reports. type = scans | requests | outbreaks | users | districts ; optional from/to (YYYY-MM-DD)
    "GET report": {
      auth: ADMIN,
      fn: async ({ query: q, user, ip }) => {
        const type = oneOf(q.type, ["scans", "requests", "outbreaks", "users", "districts", "emails"], { name: "type" });
        const [from, to] = dateRange(q);
        await logActivity(user.id, "report_generated", "report", null, { type, from, to }, ip);
        const span = (t) => `${t}created_at >= $1::date AND ${t}created_at < $2::date + 1`;
        if (type === "scans") {
          const rows = await many(
            `SELECT s.*, u.full_name, u.phone FROM scans s JOIN users u ON u.id=s.user_id WHERE ${span("s.")} ORDER BY s.created_at DESC LIMIT 50000`, [from, to]);
          return csvResponse(`scans_${from}_${to}.csv`,
            ["id", "time", "farmer", "phone", "pest_detected", "stage", "confidence", "risk_level", "risk_score", "district", "sector", "lat", "lng", "location_source", "counts_for_outbreak", "what_ai_saw", "suggested_action"],
            rows.map((s) => [s.id, s.created_at, s.full_name, s.phone, s.pest_detected, s.stage, s.confidence, s.risk_level, s.risk_score, s.district, s.sector, s.lat, s.lng, s.loc_source, s.qualifies_outbreak, s.affected_area, s.recommendation]));
        }
        if (type === "requests") {
          const rows = await many(
            `SELECT r.*, f.full_name AS farmer, a.full_name AS advisor,
                    (SELECT MIN(m.created_at) FROM request_messages m JOIN users x ON x.id=m.author_id WHERE m.request_id=r.id AND m.kind='message' AND x.role<>'farmer') AS first_reply
               FROM assistance_requests r JOIN users f ON f.id=r.farmer_id LEFT JOIN users a ON a.id=r.advisor_id
              WHERE ${span("r.")} ORDER BY r.created_at DESC`, [from, to]);
          return csvResponse(`requests_${from}_${to}.csv`,
            ["id", "created", "farmer", "advisor", "status", "priority", "district", "sector", "subject", "first_advisor_reply", "resolved_at"],
            rows.map((r) => [r.id, r.created_at, r.farmer, r.advisor, r.status, r.priority, r.district, r.sector, r.subject, r.first_reply, r.resolved_at]));
        }
        if (type === "outbreaks") {
          const rows = await many(
            `SELECT o.*, a.full_name AS advisor, c.full_name AS confirmer FROM outbreak_alerts o
               LEFT JOIN users a ON a.id=o.assigned_advisor_id LEFT JOIN users c ON c.id=o.confirmed_by
              WHERE ${span("o.")} ORDER BY o.created_at DESC`, [from, to]);
          return csvResponse(`outbreaks_${from}_${to}.csv`,
            ["id", "created", "status", "district", "sector", "center_lat", "center_lng", "radius_km", "farmers", "scans", "worst_stage", "first_report", "last_report", "assigned_advisor", "confirmed_by", "confirmed_at", "closed_at", "notes"],
            rows.map((o) => [o.id, o.created_at, o.status, o.district, o.sector, o.center_lat, o.center_lng, o.radius_km, o.farmer_count, o.scan_count, o.max_stage, o.first_report_at, o.last_report_at, o.advisor, o.confirmer, o.confirmed_at, o.closed_at, o.notes]));
        }
        if (type === "users") {
          const rows = await many(`SELECT ${USER_COLUMNS} FROM users WHERE ${span("")} ORDER BY created_at DESC`, [from, to]);
          return csvResponse(`users_${from}_${to}.csv`,
            ["id", "created", "name", "email", "phone", "role", "status", "district", "sector", "last_login"],
            rows.map((u) => [u.id, u.created_at, u.full_name, u.email, u.phone, u.role, u.status, u.district, u.sector, u.last_login_at]));
        }
        if (type === "emails") {
          const rows = await many(`SELECT * FROM email_log WHERE ${span("")} ORDER BY created_at DESC LIMIT 50000`, [from, to]);
          return csvResponse(`emails_${from}_${to}.csv`,
            ["id", "created", "to", "subject", "template", "status", "attempts", "error", "sent_at"],
            rows.map((e) => [e.id, e.created_at, e.to_email, e.subject, e.template, e.status, e.attempts, e.error, e.sent_at]));
        }
        const rows = await many(
          `SELECT COALESCE(NULLIF(s.district,''),'(not set)') AS district, COUNT(*) AS scans, COUNT(DISTINCT s.user_id) AS farmers,
                  COUNT(*) FILTER (WHERE s.pest_detected) AS pest, COUNT(*) FILTER (WHERE s.stage='early') AS early,
                  COUNT(*) FILTER (WHERE s.stage='moderate') AS moderate, COUNT(*) FILTER (WHERE s.stage='severe') AS severe
             FROM scans s WHERE s.user_id IS NOT NULL AND ${span("s.")} GROUP BY 1 ORDER BY severe DESC, moderate DESC`, [from, to]);
        return csvResponse(`districts_${from}_${to}.csv`,
          ["district", "scans", "farmers", "pest_detected", "early", "moderate", "severe"],
          rows.map((r) => [r.district, r.scans, r.farmers, r.pest, r.early, r.moderate, r.severe]));
      },
    },
  },
  { getUser }
);
