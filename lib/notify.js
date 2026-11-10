// In-app notifications + email, sent together.
import { query, many } from "./db.js";
import { renderEmail, sendEmails } from "./mailer.js";
import { appUrl } from "./http.js";

// users: [{ id, email }]. n: { type, title, body, link, email: { subject, heading, lines, details, buttonLabel } }
export async function notifyUsers(req, users, n, { relatedType = null, relatedId = null } = {}) {
  const unique = [];
  const seen = new Set();
  for (const u of users) {
    if (u && u.id && !seen.has(u.id)) { seen.add(u.id); unique.push(u); }
  }
  if (!unique.length) return { notified: 0, email: { queued: 0, sent: 0, failed: 0, skipped: 0, pending: 0 } };

  // one INSERT for all in-app notifications
  const values = [];
  const params = [];
  unique.forEach((u, i) => {
    const b = i * 5;
    values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5})`);
    params.push(u.id, n.type, n.title.slice(0, 200), (n.body || "").slice(0, 2000), n.link || null);
  });
  await query(`INSERT INTO notifications (user_id, type, title, body, link) VALUES ${values.join(",")}`, params);

  let email = { queued: 0, sent: 0, failed: 0, skipped: 0, pending: 0 };
  if (n.email) {
    const base = appUrl(req);
    const { text, html } = renderEmail({
      heading: n.email.heading || n.title,
      lines: n.email.lines || (n.body ? [n.body] : []),
      details: n.email.details || [],
      button: n.link ? { label: n.email.buttonLabel || "Open ArmywormGuard", url: base + n.link } : null,
    });
    email = await sendEmails(
      unique.filter((u) => u.email).map((u) => ({
        to: u.email,
        userId: u.id,
        subject: n.email.subject || n.title,
        text,
        html,
        template: n.type,
        relatedType,
        relatedId,
      }))
    );
  }
  return { notified: unique.length, email };
}

export async function admins() {
  return many("SELECT id, email, full_name FROM users WHERE role='admin' AND status='active'");
}

// Advisors whose coverage includes the district (or who cover everywhere).
// If nobody covers it, every active advisor is returned so no report goes unseen.
export async function advisorsFor(district) {
  const all = await many(
    `SELECT u.id, u.email, u.full_name, COALESCE(a.coverage_districts, '{}') AS coverage
       FROM users u LEFT JOIN advisor_profiles a ON a.user_id = u.id
      WHERE u.role='advisor' AND u.status='active'`
  );
  const d = (district || "").trim().toLowerCase();
  const matched = all.filter(
    (a) => !a.coverage.length || (d && a.coverage.some((c) => String(c).trim().toLowerCase() === d))
  );
  return matched.length ? matched : all;
}
