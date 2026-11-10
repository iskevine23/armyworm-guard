// Real email delivery over SMTP (nodemailer). Every message is written to email_log first,
// then sent; the log row records 'sent' (with the provider's message id) or 'failed' (with the error),
// so administrators can see and retry failures. Nothing is ever "simulated".
//
// Configure ONE of:
//   SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, EMAIL_FROM   (any provider: Brevo, Resend, SendGrid, Mailgun, Zoho, Gmail…)
//   GMAIL_USER, GMAIL_APP_PASSWORD                                       (Gmail with 2-Step Verification + app password)
import nodemailer from "nodemailer";
import { query, one } from "./db.js";

let transporter = null;

export function emailConfig() {
  const e = process.env;
  if (e.SMTP_HOST) {
    const port = Number(e.SMTP_PORT || 587);
    return {
      kind: "smtp",
      from: e.EMAIL_FROM || e.SMTP_USER,
      transport: {
        host: e.SMTP_HOST,
        port,
        secure: e.SMTP_SECURE ? e.SMTP_SECURE === "true" : port === 465,
        auth: e.SMTP_USER ? { user: e.SMTP_USER, pass: e.SMTP_PASS || "" } : undefined,
        ignoreTLS: e.SMTP_IGNORE_TLS === "true", // only for a local test server
      },
    };
  }
  if (e.GMAIL_USER && e.GMAIL_APP_PASSWORD) {
    return {
      kind: "gmail",
      from: e.EMAIL_FROM || `ArmywormGuard <${e.GMAIL_USER}>`,
      transport: { service: "gmail", auth: { user: e.GMAIL_USER, pass: e.GMAIL_APP_PASSWORD } },
    };
  }
  return null;
}

export function emailConfigured() {
  return !!emailConfig();
}

function getTransporter(cfg) {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      ...cfg.transport,
      connectionTimeout: 8000,
      greetingTimeout: 8000,
      socketTimeout: 12000,
    });
  }
  return transporter;
}

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Builds plain-text and HTML versions from simple parts. All text is escaped.
export function renderEmail({ heading, lines = [], details = [], button, footer }) {
  const textParts = [heading, "", ...lines];
  if (details.length) textParts.push("", ...details.map(([k, v]) => `${k}: ${v}`));
  if (button) textParts.push("", `${button.label}: ${button.url}`);
  textParts.push("", footer || "ArmywormGuard — fall armyworm early warning for maize farmers.");
  const text = textParts.join("\n");

  const rows = details
    .map(([k, v]) => `<tr><td style="padding:6px 12px 6px 0;color:#6b6b5e;font-size:13px;vertical-align:top;white-space:nowrap">${esc(k)}</td><td style="padding:6px 0;font-size:14px;color:#1C2818">${esc(v)}</td></tr>`)
    .join("");
  const html = `<!doctype html><html><body style="margin:0;background:#f3eee1;font-family:Arial,Helvetica,sans-serif;color:#1C2818">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3eee1;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:6px;overflow:hidden">
<tr><td style="background:#1C2818;padding:18px 24px;font-family:Georgia,serif;font-size:20px;color:#F3EEE1">Armyworm<span style="color:#7FA65B">Guard</span></td></tr>
<tr><td style="padding:24px">
<h1 style="font-family:Georgia,serif;font-size:20px;margin:0 0 14px;color:#1C2818">${esc(heading)}</h1>
${lines.map((l) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.5;white-space:pre-wrap">${esc(l)}</p>`).join("")}
${rows ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 16px;border-top:1px solid #e6e1d3;width:100%">${rows}</table>` : ""}
${button ? `<p style="margin:20px 0 4px"><a href="${esc(button.url)}" style="display:inline-block;background:#7FA65B;color:#1C2818;text-decoration:none;font-weight:bold;padding:12px 20px;border-radius:4px">${esc(button.label)}</a></p>` : ""}
</td></tr>
<tr><td style="padding:14px 24px;background:#f7f4ec;font-size:12px;color:#6b6b5e">${esc(footer || "ArmywormGuard — fall armyworm early warning for maize farmers. You receive this because of your account role or a request you made. Turn off emails in your profile.")}</td></tr>
</table></td></tr></table></body></html>`;
  return { text, html };
}

async function attempt(logId) {
  const row = await one("SELECT * FROM email_log WHERE id = $1", [logId]);
  if (!row) return { id: logId, status: "failed", error: "not found" };
  const cfg = emailConfig();
  if (!cfg) {
    const error = "Email is not configured on the server (set SMTP_HOST/SMTP_USER/SMTP_PASS/EMAIL_FROM or GMAIL_USER/GMAIL_APP_PASSWORD).";
    await query("UPDATE email_log SET status='failed', error=$2, attempts=attempts+1 WHERE id=$1", [logId, error]);
    return { id: logId, status: "failed", error };
  }
  try {
    const info = await getTransporter(cfg).sendMail({
      from: cfg.from,
      to: row.to_email,
      subject: row.subject,
      text: row.body_text,
      html: row.body_html || undefined,
    });
    if (info.rejected && info.rejected.length) throw new Error("Rejected by mail server: " + info.rejected.join(", "));
    await query(
      "UPDATE email_log SET status='sent', error=NULL, provider_id=$2, sent_at=now(), attempts=attempts+1 WHERE id=$1",
      [logId, String(info.messageId || "").slice(0, 300)]
    );
    return { id: logId, status: "sent" };
  } catch (err) {
    const error = String(err.message || err).slice(0, 500);
    console.error("email send failed:", error);
    transporter = null; // rebuild the connection next time
    await query("UPDATE email_log SET status='failed', error=$2, attempts=attempts+1 WHERE id=$1", [logId, error]);
    return { id: logId, status: "failed", error };
  }
}

// msg: { to, subject, text, html, userId, template, relatedType, relatedId, respectPreference }
export async function queueEmail(msg) {
  let status = "pending";
  let error = null;
  if (msg.userId && msg.respectPreference !== false) {
    const u = await one("SELECT email_notifications, status FROM users WHERE id=$1", [msg.userId]);
    if (u && (!u.email_notifications || u.status !== "active")) {
      status = "skipped";
      error = u.status !== "active" ? "Account suspended" : "User turned off email notifications";
    }
  }
  const row = await one(
    `INSERT INTO email_log (user_id, to_email, subject, body_text, body_html, template, status, error, related_type, related_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [msg.userId || null, msg.to, msg.subject.slice(0, 250), msg.text, msg.html || null, msg.template || null, status, error, msg.relatedType || null, msg.relatedId || null]
  );
  return { id: row.id, status };
}

// Sends a batch of messages and waits for them (serverless functions stop when the response is sent).
// Anything still running after budgetMs stays 'pending' in the log and can be retried from the admin screen.
export async function sendEmails(messages, { budgetMs = 9000 } = {}) {
  const queued = [];
  for (const m of messages) {
    if (!m || !m.to) continue;
    queued.push(await queueEmail(m));
  }
  const toSend = queued.filter((q) => q.status === "pending");
  const results = await Promise.race([
    Promise.allSettled(toSend.map((q) => attempt(q.id))),
    new Promise((resolve) => setTimeout(() => resolve(null), budgetMs)),
  ]);
  const summary = { queued: queued.length, sent: 0, failed: 0, skipped: queued.length - toSend.length, pending: 0 };
  if (!results) {
    summary.pending = toSend.length;
    return summary;
  }
  for (const r of results) {
    if (r.status === "fulfilled" && r.value.status === "sent") summary.sent++;
    else summary.failed++;
  }
  return summary;
}

export async function sendEmail(msg) {
  return sendEmails([msg]);
}

export async function retryEmail(id) {
  const row = await one("SELECT status FROM email_log WHERE id=$1", [id]);
  if (!row) return { status: "failed", error: "Email not found" };
  if (row.status === "sent") return { status: "sent" };
  return attempt(id);
}
