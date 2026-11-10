// POST /api/alert — send a scan result to yourself (logged-in users only)
// body: { channel: "email" | "telegram", scanId, to? (Telegram chat ID), lang }
//   email:    always goes to the account's own email address (no open relay)
//   telegram: needs TELEGRAM_BOT_TOKEN; the user must have pressed Start on the bot
// Nothing is simulated: if the channel is not configured the request fails with a clear message.
import { api, HttpError, id as idField, str } from "../lib/http.js";
import { one } from "../lib/db.js";
import { getUser } from "../lib/auth.js";
import { renderEmail, sendEmail } from "../lib/mailer.js";
import { rateLimit, logActivity } from "../lib/system.js";

const RW = {
  stage: { none: "nta cyangiritse", early: "byangiritse gake", moderate: "byangiritse mu rugero", severe: "byangiritse cyane" },
  risk: { low: "ruto", medium: "ruciriritse", high: "ruri hejuru", critical: "rukabije" },
  fallback: "Genzura umurima wawe, ubaze umukozi w'ubuhinzi (agronome) wo mu murenge wawe.",
};

function buildMessage({ stage, riskLevel, recommendation, lang }) {
  if (lang === "rw") {
    return (
      `ArmywormGuard — ubutumwa bw'iburira\n` +
      `Ibyangijwe na nkongwa (Fall Armyworm): ${RW.stage[stage] || "bitazwi"}\n` +
      `Ibyago byo gukwirakwira hafi aho: ${RW.risk[riskLevel] || "bitazwi"}\n` +
      `Icyo wakora: ${recommendation || RW.fallback}`
    );
  }
  return (
    `ArmywormGuard alert\n` +
    `Fall armyworm damage: ${(stage || "unknown").toUpperCase()}\n` +
    `Spread risk nearby: ${(riskLevel || "unknown").toUpperCase()}\n` +
    `What to do: ${recommendation || "Scout your field and consult your local agronomy extension officer."}`
  );
}

export default api(
  {
    "POST ": {
      auth: "any",
      fn: async ({ body, user, ip }) => {
        await rateLimit(`alert:${user.id}`, 30, 86400, "Too many alerts today.");
        const scan = await one("SELECT * FROM scans WHERE id=$1 AND user_id=$2", [idField(body.scanId, "scan"), user.id]);
        if (!scan) throw new HttpError(404, "Scan not found in your history");
        const lang = body.lang === "rw" ? "rw" : "en";
        const text = buildMessage({ stage: scan.stage, riskLevel: scan.risk_level, recommendation: scan.recommendation, lang });

        if (body.channel === "email") {
          const r = renderEmail({
            heading: lang === "rw" ? "Ibyavuye mu isuzuma" : "Your ArmywormGuard scan result",
            lines: text.split("\n").slice(1),
            details: [["Scan", `#${scan.id}`], ["Time", new Date(scan.created_at).toUTCString()]],
          });
          const res = await sendEmail({ to: user.email, userId: user.id, subject: lang === "rw" ? "ArmywormGuard: ibyavuye mu isuzuma" : `ArmywormGuard: ${scan.stage} fall armyworm damage`, text, html: r.html, template: "scan_result", relatedType: "scan", relatedId: scan.id, respectPreference: false });
          if (!res.sent) throw new HttpError(502, "The email could not be sent right now. The administrator has been shown the error.");
          await logActivity(user.id, "alert_email", "scan", scan.id, null, ip);
          return { sent: true, channel: "email", to: user.email };
        }

        if (body.channel === "telegram") {
          const token = process.env.TELEGRAM_BOT_TOKEN;
          if (!token) throw new HttpError(503, "Telegram is not set up on this server (TELEGRAM_BOT_TOKEN).");
          const chatId = str(body.to, 40, { required: true, name: "Telegram chat ID" });
          if (!/^-?\d{3,20}$/.test(chatId)) throw new HttpError(400, "A Telegram chat ID is a number");
          const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, text }),
          });
          const data = await r.json().catch(() => ({}));
          if (!data.ok) throw new HttpError(502, "Telegram: " + (data.description || "send failed") + ". Open the bot and press Start first.");
          await logActivity(user.id, "alert_telegram", "scan", scan.id, null, ip);
          return { sent: true, channel: "telegram" };
        }
        throw new HttpError(400, "channel must be 'email' or 'telegram'");
      },
    },
  },
  { getUser }
);
