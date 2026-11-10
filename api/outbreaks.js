// /api/outbreaks — automatic outbreak alerts
//   GET  ?action=list         advisor/admin   ?status=active|suspected|...
//   GET  ?action=get&id=      advisor/admin   alert + linked scans + history
//   POST ?action=status&id=   advisor/admin   { status, note }
//   POST ?action=assign&id=   advisor (self) / admin { advisorId }
//   POST ?action=note&id=     advisor/admin   { note }
//   GET  ?action=nearby       farmer          CONFIRMED outbreaks near the farmer's farm (warnings)
import { api, HttpError, str, oneOf, id as idField, paging } from "../lib/http.js";
import { one, many, tx } from "../lib/db.js";
import { getUser } from "../lib/auth.js";
import { ACTIVE_STATUSES, ALL_STATUSES, farmersInArea } from "../lib/outbreak.js";
import { notifyUsers, admins, advisorsFor } from "../lib/notify.js";
import { getSettings, logActivity } from "../lib/system.js";
import { haversineKm } from "../lib/spread.js";
import { formatScan } from "../lib/format.js";

const LABEL = {
  suspected: "Suspected (not yet checked)",
  investigating: "Being investigated",
  confirmed: "Confirmed in the field",
  resolved: "Resolved",
  false_alarm: "False alarm",
};

function fmt(a) {
  return {
    id: a.id,
    status: a.status,
    centerLat: a.center_lat,
    centerLng: a.center_lng,
    radiusKm: a.radius_km,
    district: a.district,
    sector: a.sector,
    farmerCount: a.farmer_count,
    scanCount: a.scan_count,
    maxStage: a.max_stage,
    thresholdFarmers: a.threshold_farmers,
    windowDays: a.window_days,
    firstReportAt: a.first_report_at,
    lastReportAt: a.last_report_at,
    assignedAdvisor: a.assigned_advisor_id ? { id: a.assigned_advisor_id, name: a.advisor_name } : null,
    confirmedBy: a.confirmed_by ? { id: a.confirmed_by, name: a.confirmer_name } : null,
    confirmedAt: a.confirmed_at,
    closedAt: a.closed_at,
    notes: a.notes,
    createdAt: a.created_at,
    updatedAt: a.updated_at,
  };
}

const SELECT = `SELECT o.*, av.full_name AS advisor_name, cf.full_name AS confirmer_name
                  FROM outbreak_alerts o
                  LEFT JOIN users av ON av.id = o.assigned_advisor_id
                  LEFT JOIN users cf ON cf.id = o.confirmed_by`;

async function load(id) {
  const a = await one(`${SELECT} WHERE o.id=$1`, [id]);
  if (!a) throw new HttpError(404, "Alert not found");
  return a;
}

const where = (a) => [a.sector, a.district].filter(Boolean).join(", ") || `${a.center_lat.toFixed(4)}, ${a.center_lng.toFixed(4)}`;

export default api(
  {
    "GET list": {
      auth: ["advisor", "admin"],
      fn: async ({ query: q }) => {
        const { limit, offset } = paging(q, { max: 200, def: 50 });
        const params = [];
        let w = "TRUE";
        if (q.status === "active") { params.push(ACTIVE_STATUSES); w = `o.status = ANY($1)`; }
        else if (q.status) { params.push(oneOf(q.status, ALL_STATUSES, { name: "status" })); w = `o.status = $1`; }
        params.push(limit, offset);
        const rows = await many(
          `${SELECT} WHERE ${w}
           ORDER BY CASE o.status WHEN 'confirmed' THEN 0 WHEN 'investigating' THEN 1 WHEN 'suspected' THEN 2 ELSE 3 END, o.last_report_at DESC
           LIMIT $${params.length - 1} OFFSET $${params.length}`,
          params
        );
        return { alerts: rows.map(fmt) };
      },
    },

    "GET get": {
      auth: ["advisor", "admin"],
      fn: async ({ query: q, user }) => {
        const a = await load(idField(q.id, "alert"));
        const scans = await many(
          `SELECT s.*, u.full_name AS farmer_name, u.phone AS farmer_phone, u.email AS farmer_email
             FROM outbreak_alert_scans x JOIN scans s ON s.id = x.scan_id JOIN users u ON u.id = s.user_id
            WHERE x.alert_id = $1 ORDER BY s.created_at DESC`,
          [a.id]
        );
        const updates = await many(
          `SELECT up.*, u.full_name FROM outbreak_updates up LEFT JOIN users u ON u.id = up.user_id
            WHERE up.alert_id=$1 ORDER BY up.created_at, up.id`,
          [a.id]
        );
        return {
          alert: fmt(a),
          scans: scans.map((s) => ({ ...formatScan(s, user), distanceKm: +haversineKm({ lat: a.center_lat, lng: a.center_lng }, s).toFixed(2) })),
          updates: updates.map((u) => ({ id: u.id, oldStatus: u.old_status, newStatus: u.new_status, note: u.note, createdAt: u.created_at, by: u.user_id ? u.full_name : "System" })),
        };
      },
    },

    "POST status": {
      auth: ["advisor", "admin"],
      fn: async ({ req, query: q, body, user, ip }) => {
        const a = await load(idField(q.id, "alert"));
        const status = oneOf(body.status, ALL_STATUSES, { name: "status" });
        const note = str(body.note, 2000, { name: "Note" });
        if ((status === "confirmed" || status === "false_alarm") && !note) {
          throw new HttpError(400, "Add a short note on what was found in the field");
        }
        if (status === a.status && !note) return { alert: fmt(a) };
        await tx(async (c) => {
          await c.query(
            `UPDATE outbreak_alerts SET status=$2, updated_at=now(),
                    assigned_advisor_id = COALESCE(assigned_advisor_id, CASE WHEN $3 = 'advisor' THEN $4::bigint END),
                    confirmed_by = CASE WHEN $2='confirmed' THEN $4::bigint WHEN $2 IN ('suspected','investigating') THEN NULL ELSE confirmed_by END,
                    confirmed_at = CASE WHEN $2='confirmed' THEN now() WHEN $2 IN ('suspected','investigating') THEN NULL ELSE confirmed_at END,
                    closed_at = CASE WHEN $2 IN ('resolved','false_alarm') THEN now() ELSE NULL END,
                    notes = CASE WHEN $5 <> '' THEN $5 ELSE notes END
              WHERE id=$1`,
            [a.id, status, user.role, user.id, note]
          );
          await c.query("INSERT INTO outbreak_updates (alert_id, user_id, old_status, new_status, note) VALUES ($1,$2,$3,$4,$5)",
            [a.id, user.id, a.status, status, note || null]);
        });
        const after = await load(a.id);
        const emailResults = {};

        if (status !== a.status) {
          // advisors covering the area + admins, except the person who made the change
          const staff = [...(await advisorsFor(a.district)), ...(await admins())].filter((u) => u.id !== user.id);
          const r1 = await notifyUsers(req, staff, {
            type: "outbreak_status",
            title: `Outbreak #${a.id} (${where(a)}): ${LABEL[status]}`,
            body: `${user.full_name} changed the status from ${LABEL[a.status]} to ${LABEL[status]}.` + (note ? ` Note: ${note}` : ""),
            link: `/dashboard.html#outbreak-${a.id}`,
            email: {
              subject: `[ArmywormGuard] Outbreak #${a.id} is now ${LABEL[status]}`,
              heading: `Outbreak #${a.id}: ${LABEL[status]}`,
              lines: [`${user.full_name} changed the status from "${LABEL[a.status]}" to "${LABEL[status]}".`, ...(note ? [note] : [])],
              details: [["Area", where(a)], ["Farmers reporting", String(after.farmer_count)], ["Scans", String(after.scan_count)]],
              buttonLabel: "Open the alert",
            },
          }, { relatedType: "outbreak", relatedId: a.id });
          emailResults.staff = r1.email;

          // farmers in the area hear about confirmed outbreaks, and when they end
          const settings = await getSettings();
          const tellFarmers =
            (status === "confirmed" && settings.outbreak.notify_farmers_on_confirm) ||
            ((status === "resolved" || status === "false_alarm") && a.status === "confirmed");
          if (tellFarmers) {
            const farmers = await farmersInArea(after);
            const confirmed = status === "confirmed";
            const r2 = await notifyUsers(req, farmers, {
              type: confirmed ? "outbreak_warning" : "outbreak_closed",
              title: confirmed
                ? `Fall armyworm outbreak confirmed near you (${where(a)})`
                : `Fall armyworm outbreak near you is over (${where(a)})`,
              body: confirmed
                ? "An agricultural advisor has confirmed a fall armyworm outbreak in your area. Scout your maize every few days, check the leaf whorls, and ask for help early."
                : "The advisor has closed the outbreak alert for your area. Keep scouting your field regularly.",
              link: "/farmer.html#overview",
              email: {
                subject: confirmed
                  ? `[ArmywormGuard] Warning: fall armyworm outbreak confirmed near ${where(a)}`
                  : `[ArmywormGuard] Outbreak alert closed near ${where(a)}`,
                heading: confirmed ? "Fall armyworm outbreak confirmed in your area" : "Outbreak alert closed",
                lines: confirmed
                  ? [
                      `An agricultural advisor (${user.full_name}) confirmed a fall armyworm outbreak around ${where(a)}.`,
                      "What to do now: scout your maize every 2–3 days, look inside the leaf whorls for fresh damage, droppings and small caterpillars, and crush egg masses you find. Before spraying anything, talk to your advisor or agro-dealer and follow the product label.",
                      ...(note ? ["Advisor's note: " + note] : []),
                    ]
                  : ["The outbreak alert for your area has been closed. Keep scouting your field regularly.", ...(note ? ["Advisor's note: " + note] : [])],
                buttonLabel: confirmed ? "Scan a leaf or ask for help" : "Open ArmywormGuard",
              },
            }, { relatedType: "outbreak", relatedId: a.id });
            emailResults.farmers = r2.email;
          }
        }
        await logActivity(user.id, "outbreak_status", "outbreak", a.id, { from: a.status, to: status }, ip);
        return { alert: fmt(after), email: emailResults };
      },
    },

    "POST assign": {
      auth: ["advisor", "admin"],
      fn: async ({ req, query: q, body, user, ip }) => {
        const a = await load(idField(q.id, "alert"));
        let advisorId = user.role === "advisor" ? user.id : body.advisorId ? idField(body.advisorId, "advisor") : null;
        let adv = null;
        if (advisorId) {
          adv = await one("SELECT id, email, full_name FROM users WHERE id=$1 AND role='advisor' AND status='active'", [advisorId]);
          if (!adv) throw new HttpError(400, "Choose an active advisor");
        }
        await tx(async (c) => {
          await c.query("UPDATE outbreak_alerts SET assigned_advisor_id=$2, updated_at=now() WHERE id=$1", [a.id, advisorId]);
          await c.query("INSERT INTO outbreak_updates (alert_id, user_id, old_status, new_status, note) VALUES ($1,$2,$3,$3,$4)",
            [a.id, user.id, a.status, adv ? `Assigned to ${adv.full_name}.` : "Unassigned."]);
        });
        if (adv && adv.id !== user.id) {
          await notifyUsers(req, [adv], {
            type: "outbreak_assigned",
            title: `Outbreak #${a.id} (${where(a)}) was assigned to you`,
            body: `${a.farmer_count} farmers, status ${LABEL[a.status]}.`,
            link: `/dashboard.html#outbreak-${a.id}`,
            email: {
              subject: `[ArmywormGuard] Outbreak #${a.id} assigned to you`,
              heading: "An outbreak alert was assigned to you",
              lines: ["Please visit the area, check the reports and update the alert status."],
              details: [["Area", where(a)], ["Status", LABEL[a.status]], ["Farmers reporting", String(a.farmer_count)]],
              buttonLabel: "Open the alert",
            },
          }, { relatedType: "outbreak", relatedId: a.id });
        }
        await logActivity(user.id, "outbreak_assigned", "outbreak", a.id, { advisorId }, ip);
        return { alert: fmt(await load(a.id)) };
      },
    },

    "POST note": {
      auth: ["advisor", "admin"],
      fn: async ({ query: q, body, user, ip }) => {
        const a = await load(idField(q.id, "alert"));
        const note = str(body.note, 2000, { required: true, name: "Note" });
        await tx(async (c) => {
          await c.query("INSERT INTO outbreak_updates (alert_id, user_id, old_status, new_status, note) VALUES ($1,$2,$3,$3,$4)", [a.id, user.id, a.status, note]);
          await c.query("UPDATE outbreak_alerts SET notes=$2, updated_at=now() WHERE id=$1", [a.id, note]);
        });
        await logActivity(user.id, "outbreak_note", "outbreak", a.id, null, ip);
        return { alert: fmt(await load(a.id)) };
      },
    },

    "GET nearby": {
      auth: ["farmer"],
      fn: async ({ user }) => {
        const farm = await one("SELECT lat, lng FROM farmer_profiles WHERE user_id=$1", [user.id]);
        const rows = await many(`${SELECT} WHERE o.status='confirmed' ORDER BY o.confirmed_at DESC LIMIT 200`);
        const d = (user.district || "").toLowerCase();
        const near = rows
          .map((a) => ({ a, km: farm?.lat != null ? haversineKm({ lat: a.center_lat, lng: a.center_lng }, farm) : null }))
          .filter((x) => (x.km !== null && x.km <= Math.max(30, x.a.radius_km * 3)) || (d && (x.a.district || "").toLowerCase() === d))
          .slice(0, 10);
        return {
          alerts: near.map((x) => ({
            id: x.a.id, district: x.a.district, sector: x.a.sector, confirmedAt: x.a.confirmed_at,
            distanceKm: x.km === null ? null : +x.km.toFixed(1), farmerCount: x.a.farmer_count, notes: x.a.notes,
          })),
        };
      },
    },
  },
  { getUser }
);
