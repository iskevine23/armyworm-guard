// /api/requests — farmers ask an agricultural advisor for help; advisors respond.
//   POST ?action=create        farmer   { subject, message, scanId?, priority? }
//   GET  ?action=list          any      (scoped by role)  ?status=&mine=1
//   GET  ?action=get&id=       any      request + messages + scan + farmer details (advisor/admin)
//   POST ?action=reply&id=     any      { body, status? }
//   POST ?action=status&id=    any      { status, note? }  (farmers may only resolve/close/reopen their own)
//   POST ?action=assign&id=    advisor (claim for self) / admin { advisorId }
//   GET  ?action=advisors      advisor/admin  list of advisors for assignment
import { api, HttpError, str, oneOf, id as idField, paging } from "../lib/http.js";
import { one, many, query, tx } from "../lib/db.js";
import { getUser } from "../lib/auth.js";
import { requestScope } from "../lib/access.js";
import { notifyUsers, advisorsFor } from "../lib/notify.js";
import { getSettings, logActivity, rateLimit } from "../lib/system.js";
import { formatScan } from "../lib/format.js";

const STATUSES = ["open", "in_progress", "awaiting_farmer", "resolved", "closed"];
const PRIORITIES = ["low", "normal", "high", "urgent"];
const STATUS_LABEL = {
  open: "Open", in_progress: "In progress", awaiting_farmer: "Waiting for the farmer", resolved: "Resolved", closed: "Closed",
};

function fmt(r) {
  return {
    id: r.id,
    subject: r.subject,
    message: r.message,
    status: r.status,
    priority: r.priority,
    district: r.district,
    sector: r.sector,
    lat: r.lat,
    lng: r.lng,
    scanId: r.scan_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    resolvedAt: r.resolved_at,
    farmer: { id: r.farmer_id, name: r.farmer_name, phone: r.farmer_phone, email: r.farmer_email },
    advisor: r.advisor_id ? { id: r.advisor_id, name: r.advisor_name } : null,
    messageCount: r.message_count,
    lastMessageAt: r.last_message_at,
    stage: r.scan_stage,
  };
}

const SELECT = `
  SELECT r.*, f.full_name AS farmer_name, f.phone AS farmer_phone, f.email AS farmer_email,
         a.full_name AS advisor_name, s.stage AS scan_stage,
         (SELECT COUNT(*) FROM request_messages m WHERE m.request_id = r.id AND m.kind='message') AS message_count,
         (SELECT MAX(created_at) FROM request_messages m WHERE m.request_id = r.id) AS last_message_at
    FROM assistance_requests r
    JOIN users f ON f.id = r.farmer_id
    LEFT JOIN users a ON a.id = r.advisor_id
    LEFT JOIN scans s ON s.id = r.scan_id`;

async function loadVisible(user, requestId) {
  const scope = await requestScope(user, 2);
  const r = await one(`${SELECT} WHERE r.id = $1 AND ${scope.sql}`, [requestId, ...scope.params]);
  if (!r) throw new HttpError(404, "Request not found");
  return r;
}

async function pickAdvisor(district) {
  const list = await advisorsFor(district);
  if (!list.length) return null;
  const loads = await many(
    `SELECT advisor_id, COUNT(*) AS n FROM assistance_requests
      WHERE advisor_id = ANY($1) AND status IN ('open','in_progress','awaiting_farmer') GROUP BY advisor_id`,
    [list.map((a) => a.id)]
  );
  const load = new Map(loads.map((l) => [l.advisor_id, l.n]));
  list.sort((a, b) => (load.get(a.id) || 0) - (load.get(b.id) || 0) || a.id - b.id);
  return list[0];
}

const farmerLink = (id) => `/farmer.html#request-${id}`;
const advisorLink = (id) => `/dashboard.html#request-${id}`;

export default api(
  {
    "POST create": {
      auth: ["farmer"],
      fn: async ({ req, body, user, ip }) => {
        await rateLimit(`req:${user.id}`, 10, 86400, "You have sent many requests today. An advisor will answer soon.");
        const subject = str(body.subject, 150, { required: true, name: "Subject", min: 3 });
        const message = str(body.message, 3000, { required: true, name: "Message", min: 5 });
        const priority = oneOf(body.priority, PRIORITIES, { name: "priority", fallback: "normal" });
        let scan = null;
        if (body.scanId) {
          scan = await one("SELECT * FROM scans WHERE id=$1 AND user_id=$2", [idField(body.scanId, "scan"), user.id]);
          if (!scan) throw new HttpError(404, "That scan is not in your history");
        }
        const farm = await one("SELECT lat, lng FROM farmer_profiles WHERE user_id=$1", [user.id]);
        const lat = scan?.lat ?? farm?.lat ?? null;
        const lng = scan?.lng ?? farm?.lng ?? null;
        const settings = await getSettings();
        const advisor = settings.requests.auto_assign ? await pickAdvisor(user.district) : null;

        const r = await tx(async (c) => {
          const ins = await c.query(
            `INSERT INTO assistance_requests (farmer_id, advisor_id, scan_id, subject, message, priority, district, sector, lat, lng)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
            [user.id, advisor?.id || null, scan?.id || null, subject, message, priority, user.district, user.sector, lat, lng]
          );
          await c.query(
            "INSERT INTO request_messages (request_id, author_id, body, kind) VALUES ($1,$2,$3,'system')",
            [ins.rows[0].id, user.id, advisor ? `Request created and assigned to ${advisor.full_name}.` : "Request created. Waiting for an advisor."]
          );
          return ins.rows[0];
        });

        const recipients = advisor ? [advisor] : await advisorsFor(user.district);
        const where = [user.sector, user.district].filter(Boolean).join(", ") || "location not set";
        const details = [
          ["Request", `#${r.id}`],
          ["Farmer", user.full_name],
          ["Phone", user.phone || "—"],
          ["Area", where],
          ["Priority", priority],
          ["Subject", subject],
        ];
        if (scan) {
          details.push(["Scan result", `${scan.stage} damage (AI confidence ${Math.round((scan.confidence || 0) * 100)}%)`]);
          if (scan.affected_area) details.push(["What the AI saw", scan.affected_area]);
        }
        if (lat !== null) details.push(["Map", `https://www.google.com/maps?q=${Number(lat).toFixed(5)},${Number(lng).toFixed(5)}`]);
        const sent = await notifyUsers(
          req,
          recipients,
          {
            type: "request_new",
            title: `New help request #${r.id} from ${user.full_name}`,
            body: `${subject} — ${where}`,
            link: advisorLink(r.id),
            email: {
              subject: `[ArmywormGuard] Farmer needs help: ${subject} (#${r.id})`,
              heading: "A farmer has asked for help",
              lines: [message],
              details,
              buttonLabel: "Open the request",
            },
          },
          { relatedType: "request", relatedId: r.id }
        );
        await notifyUsers(req, [user], {
          type: "request_created",
          title: `Your request #${r.id} was sent`,
          body: advisor ? `${advisor.full_name} will look at it.` : "An advisor will look at it soon.",
          link: farmerLink(r.id),
        });
        await logActivity(user.id, "request_created", "request", r.id, { advisorId: advisor?.id || null, emails: sent.email }, ip);
        return { __status: 201, request: fmt({ ...r, farmer_name: user.full_name, advisor_name: advisor?.full_name }), notified: sent.notified, email: sent.email };
      },
    },

    "GET list": {
      auth: "any",
      fn: async ({ query: q, user }) => {
        const { limit, offset } = paging(q, { max: 200, def: 50 });
        const scope = await requestScope(user, 1);
        const where = [scope.sql];
        const params = [...scope.params];
        const add = (sql, v) => { params.push(v); where.push(sql.replace("?", "$" + params.length)); };
        if (q.status === "active") where.push("r.status IN ('open','in_progress','awaiting_farmer')");
        else if (q.status) add("r.status = ?", oneOf(q.status, STATUSES, { name: "status" }));
        if (q.mine === "1" && user.role === "advisor") add("r.advisor_id = ?", user.id);
        if (q.unassigned === "1") where.push("r.advisor_id IS NULL");
        params.push(limit, offset);
        const rows = await many(
          `${SELECT} WHERE ${where.join(" AND ")}
           ORDER BY CASE WHEN r.status IN ('open','in_progress','awaiting_farmer') THEN 0 ELSE 1 END,
                    CASE r.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
                    r.updated_at DESC
           LIMIT $${params.length - 1} OFFSET $${params.length}`,
          params
        );
        return { requests: rows.map(fmt) };
      },
    },

    "GET get": {
      auth: "any",
      fn: async ({ query: q, user }) => {
        const r = await loadVisible(user, idField(q.id, "request"));
        const messages = await many(
          `SELECT m.id, m.body, m.kind, m.created_at, m.author_id, u.full_name AS author_name, u.role AS author_role
             FROM request_messages m LEFT JOIN users u ON u.id = m.author_id
            WHERE m.request_id = $1 ORDER BY m.created_at, m.id`,
          [r.id]
        );
        let scan = null;
        if (r.scan_id) {
          const s = await one("SELECT * FROM scans WHERE id=$1", [r.scan_id]);
          if (s) scan = formatScan(s, user);
        }
        let farm = null;
        if (user.role !== "farmer") {
          farm = await one("SELECT farm_name, village, farm_size_ha, lat, lng FROM farmer_profiles WHERE user_id=$1", [r.farmer_id]);
        }
        return {
          request: fmt(r),
          farm,
          scan,
          messages: messages.map((m) => ({
            id: m.id, body: m.body, kind: m.kind, createdAt: m.created_at,
            author: m.author_id ? { id: m.author_id, name: m.author_name, role: m.author_role } : null,
          })),
        };
      },
    },

    "POST reply": {
      auth: "any",
      fn: async ({ req, query: q, body, user, ip }) => {
        const r = await loadVisible(user, idField(q.id, "request"));
        const text = str(body.body, 4000, { required: true, name: "Message", min: 1 });
        if (user.role === "farmer" && r.status === "closed") throw new HttpError(409, "This request is closed. Open a new request if you need more help.");
        await rateLimit(`reply:${user.id}`, 200, 86400);
        let newStatus = body.status ? oneOf(body.status, STATUSES, { name: "status" }) : null;
        if (user.role === "farmer" && newStatus && !["open", "resolved", "closed"].includes(newStatus)) newStatus = null;

        await tx(async (c) => {
          await c.query("INSERT INTO request_messages (request_id, author_id, body) VALUES ($1,$2,$3)", [r.id, user.id, text]);
          if (user.role === "advisor" && !r.advisor_id) {
            await c.query("UPDATE assistance_requests SET advisor_id=$2 WHERE id=$1", [r.id, user.id]);
            await c.query("INSERT INTO request_messages (request_id, author_id, body, kind) VALUES ($1,$2,$3,'system')", [r.id, user.id, `${user.full_name} took this request.`]);
          }
          let status = newStatus;
          if (!status && user.role !== "farmer" && r.status === "open") status = "in_progress";
          if (!status && user.role === "farmer" && r.status === "awaiting_farmer") status = "in_progress";
          if (status && status !== r.status) {
            await c.query(
              `UPDATE assistance_requests SET status=$2, resolved_at = CASE WHEN $2 IN ('resolved','closed') THEN now() ELSE NULL END WHERE id=$1`,
              [r.id, status]
            );
            await c.query("INSERT INTO request_messages (request_id, author_id, body, kind) VALUES ($1,$2,$3,'status')", [r.id, user.id, `Status changed to ${STATUS_LABEL[status]}.`]);
          }
          await c.query("UPDATE assistance_requests SET updated_at=now() WHERE id=$1", [r.id]);
        });
        const after = await loadVisible(user, r.id);

        let sent;
        if (user.role === "farmer") {
          const target = after.advisor_id
            ? await many("SELECT id, email FROM users WHERE id=$1 AND status='active'", [after.advisor_id])
            : await advisorsFor(after.district);
          sent = await notifyUsers(req, target, {
            type: "request_reply",
            title: `${user.full_name} replied on request #${r.id}`,
            body: text.slice(0, 300),
            link: advisorLink(r.id),
            email: {
              subject: `[ArmywormGuard] Farmer replied: ${r.subject} (#${r.id})`,
              heading: `${user.full_name} replied`,
              lines: [text],
              details: [["Request", `#${r.id} — ${r.subject}`], ["Status", STATUS_LABEL[after.status]], ["Farmer phone", user.phone || "—"]],
              buttonLabel: "Open the request",
            },
          }, { relatedType: "request", relatedId: r.id });
        } else {
          sent = await notifyUsers(req, [{ id: after.farmer_id, email: after.farmer_email }], {
            type: "request_reply",
            title: `An advisor replied to your request #${r.id}`,
            body: text.slice(0, 300),
            link: farmerLink(r.id),
            email: {
              subject: `[ArmywormGuard] An advisor answered your request: ${r.subject}`,
              heading: `${user.full_name} answered your request`,
              lines: [text],
              details: [["Request", `#${r.id} — ${r.subject}`], ["Status", STATUS_LABEL[after.status]], ["Advisor", user.full_name], ["Advisor phone", user.phone || "—"]],
              buttonLabel: "Read and reply",
            },
          }, { relatedType: "request", relatedId: r.id });
        }
        await logActivity(user.id, "request_reply", "request", r.id, { status: after.status }, ip);
        return { request: fmt(after), email: sent.email };
      },
    },

    "POST status": {
      auth: "any",
      fn: async ({ req, query: q, body, user, ip }) => {
        const r = await loadVisible(user, idField(q.id, "request"));
        const status = oneOf(body.status, STATUSES, { name: "status" });
        if (user.role === "farmer" && !["open", "resolved", "closed"].includes(status)) {
          throw new HttpError(403, "Farmers can mark a request resolved, closed, or open it again");
        }
        const note = str(body.note, 2000, { name: "Note" });
        if (status === r.status && !note) return { request: fmt(r) };
        await tx(async (c) => {
          if (user.role === "advisor" && !r.advisor_id) await c.query("UPDATE assistance_requests SET advisor_id=$2 WHERE id=$1", [r.id, user.id]);
          await c.query(
            `UPDATE assistance_requests SET status=$2, updated_at=now(),
                    resolved_at = CASE WHEN $2 IN ('resolved','closed') THEN now() ELSE NULL END WHERE id=$1`,
            [r.id, status]
          );
          await c.query("INSERT INTO request_messages (request_id, author_id, body, kind) VALUES ($1,$2,$3,'status')",
            [r.id, user.id, `Status changed to ${STATUS_LABEL[status]}.` + (note ? ` ${note}` : "")]);
        });
        const after = await loadVisible(user, r.id);
        let sent = { email: null };
        if (user.role !== "farmer") {
          sent = await notifyUsers(req, [{ id: after.farmer_id, email: after.farmer_email }], {
            type: "request_status",
            title: `Request #${r.id} is now: ${STATUS_LABEL[status]}`,
            body: note || `Your request "${r.subject}" was updated by ${user.full_name}.`,
            link: farmerLink(r.id),
            email: {
              subject: `[ArmywormGuard] Request #${r.id} updated: ${STATUS_LABEL[status]}`,
              heading: `Your request is now: ${STATUS_LABEL[status]}`,
              lines: [note || `${user.full_name} updated your request "${r.subject}".`],
              details: [["Request", `#${r.id} — ${r.subject}`], ["Updated by", user.full_name]],
              buttonLabel: "Open my request",
            },
          }, { relatedType: "request", relatedId: r.id });
        } else if (after.advisor_id) {
          sent = await notifyUsers(req, await many("SELECT id, email FROM users WHERE id=$1 AND status='active'", [after.advisor_id]), {
            type: "request_status",
            title: `Farmer marked request #${r.id} as ${STATUS_LABEL[status]}`,
            body: note || r.subject,
            link: advisorLink(r.id),
            email: {
              subject: `[ArmywormGuard] Request #${r.id}: farmer marked it ${STATUS_LABEL[status]}`,
              heading: `${user.full_name} marked the request ${STATUS_LABEL[status]}`,
              lines: [note || r.subject],
              buttonLabel: "Open the request",
            },
          }, { relatedType: "request", relatedId: r.id });
        }
        await logActivity(user.id, "request_status", "request", r.id, { from: r.status, to: status }, ip);
        return { request: fmt(after), email: sent.email };
      },
    },

    "POST assign": {
      auth: ["advisor", "admin"],
      fn: async ({ req, query: q, body, user, ip }) => {
        const r = await loadVisible(user, idField(q.id, "request"));
        let advisorId;
        if (user.role === "advisor") {
          if (r.advisor_id && r.advisor_id !== user.id) throw new HttpError(409, "Another advisor already handles this request");
          advisorId = user.id;
        } else {
          advisorId = body.advisorId ? idField(body.advisorId, "advisor") : null;
        }
        let advisor = null;
        if (advisorId) {
          advisor = await one("SELECT id, email, full_name FROM users WHERE id=$1 AND role='advisor' AND status='active'", [advisorId]);
          if (!advisor) throw new HttpError(400, "Choose an active advisor");
        }
        await query("UPDATE assistance_requests SET advisor_id=$2, updated_at=now() WHERE id=$1", [r.id, advisorId]);
        await query("INSERT INTO request_messages (request_id, author_id, body, kind) VALUES ($1,$2,$3,'system')",
          [r.id, user.id, advisor ? `Assigned to ${advisor.full_name}.` : "Unassigned."]);
        if (advisor && advisor.id !== user.id) {
          await notifyUsers(req, [advisor], {
            type: "request_assigned",
            title: `Request #${r.id} was assigned to you`,
            body: `${r.subject} — farmer ${r.farmer_name}`,
            link: advisorLink(r.id),
            email: {
              subject: `[ArmywormGuard] Request #${r.id} assigned to you: ${r.subject}`,
              heading: "A help request was assigned to you",
              lines: [r.message],
              details: [["Request", `#${r.id}`], ["Farmer", r.farmer_name], ["Phone", r.farmer_phone || "—"], ["Area", [r.sector, r.district].filter(Boolean).join(", ") || "—"]],
              buttonLabel: "Open the request",
            },
          }, { relatedType: "request", relatedId: r.id });
        }
        await logActivity(user.id, "request_assigned", "request", r.id, { advisorId }, ip);
        return { request: fmt(await loadVisible(user, r.id)) };
      },
    },

    "GET advisors": {
      auth: ["advisor", "admin"],
      fn: async () => {
        const rows = await many(
          `SELECT u.id, u.full_name, u.district, a.organization, COALESCE(a.coverage_districts,'{}') AS coverage,
                  (SELECT COUNT(*) FROM assistance_requests r WHERE r.advisor_id=u.id AND r.status IN ('open','in_progress','awaiting_farmer')) AS open_requests
             FROM users u LEFT JOIN advisor_profiles a ON a.user_id=u.id
            WHERE u.role='advisor' AND u.status='active' ORDER BY u.full_name`
        );
        return { advisors: rows.map((a) => ({ id: a.id, name: a.full_name, organization: a.organization, coverage: a.coverage, openRequests: a.open_requests })) };
      },
    },
  },
  { getUser }
);
