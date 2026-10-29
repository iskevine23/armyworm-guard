import nodemailer from "nodemailer";

// POST /api/alert
// body: { channel: "telegram" | "email", to, stage, riskLevel, recommendation }
//   telegram: `to` is the farmer's numeric Telegram chat ID (falls back to TELEGRAM_CHAT_ID env var)
//   email:    `to` is the farmer's email address
//
// If the credentials for a channel are missing, the message is simulated (returned, not sent)
// so the detect -> predict -> alert flow can still be demoed.
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST" });
  }

  const { channel, to, stage, riskLevel, recommendation, lang } = req.body || {};
  const text = buildMessage({ stage, riskLevel, recommendation, lang });

  if (channel === "telegram") return sendTelegram(res, to, text);
  if (channel === "email") return sendEmail(res, to, text, stage, lang);

  return res.status(400).json({ error: "channel must be 'telegram' or 'email'" });
}

async function sendTelegram(res, to, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = (to || process.env.TELEGRAM_CHAT_ID || "").toString().trim();

  if (!chatId) {
    return res.status(400).json({ error: "Missing Telegram chat ID" });
  }
  if (!token) {
    return res.status(200).json({
      sent: false,
      simulated: true,
      channel: "telegram",
      message: text,
      note: "TELEGRAM_BOT_TOKEN is not set on the server, so nothing was sent.",
    });
  }

  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    const data = await r.json();
    if (!data.ok) {
      // Typical cause: the farmer never pressed Start on the bot ("chat not found" / "bot can't initiate conversation")
      return res.status(502).json({ error: "Telegram: " + (data.description || "send failed") });
    }
    return res.status(200).json({ sent: true, simulated: false, channel: "telegram" });
  } catch (err) {
    console.error("telegram error:", err);
    return res.status(500).json({ error: "Telegram request failed: " + err.message });
  }
}

async function sendEmail(res, to, text, stage, lang) {
  const { GMAIL_USER, GMAIL_APP_PASSWORD } = process.env;
  const address = (to || "").trim();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
    return res.status(400).json({ error: "Enter a valid email address" });
  }
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
    return res.status(200).json({
      sent: false,
      simulated: true,
      channel: "email",
      message: text,
      note: "GMAIL_USER / GMAIL_APP_PASSWORD are not set on the server, so nothing was sent.",
    });
  }

  try {
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    });
    await transporter.sendMail({
      from: `ArmywormGuard <${GMAIL_USER}>`,
      to: address,
      subject: subjectFor(stage, lang),
      text,
    });
    return res.status(200).json({ sent: true, simulated: false, channel: "email" });
  } catch (err) {
    console.error("email error:", err);
    return res.status(500).json({ error: "Email failed: " + err.message });
  }
}

const RW = {
  stage: { none: "nta cyangiritse", early: "byangiritse gake", moderate: "byangiritse mu rugero", severe: "byangiritse cyane" },
  risk: { low: "ruto", medium: "ruciriritse", high: "ruri hejuru", critical: "rukabije" },
  fallback: "Genzura umurima wawe, ubaze umukozi w'ubuhinzi (agronome) wo mu murenge wawe.",
};

function subjectFor(stage, lang) {
  if (lang === "rw") {
    return `ArmywormGuard: ubutumwa bw'iburira (${RW.stage[stage] || "bitazwi"})`;
  }
  return `ArmywormGuard alert: ${(stage || "unknown").toUpperCase()} fall armyworm damage`;
}

function buildMessage({ stage, riskLevel, recommendation, lang }) {
  if (lang === "rw") {
    return (
      `ArmywormGuard — ubutumwa bw'iburira\n` +
      `Ibyangijwe na nkongwa (Fall Armyworm): ${RW.stage[stage] || "bitazwi"}\n` +
      `Ibyago byo gukwirakwira hafi aho: ${RW.risk[riskLevel] || "bitazwi"}\n` +
      `Icyo wakora: ${recommendation || RW.fallback}`
    );
  }
  const stageLabel = stage ? stage.toUpperCase() : "UNKNOWN";
  const riskLabel = riskLevel ? riskLevel.toUpperCase() : "UNKNOWN";
  return (
    `ArmywormGuard alert\n` +
    `Fall armyworm damage: ${stageLabel}\n` +
    `Spread risk nearby: ${riskLabel}\n` +
    `What to do: ${recommendation || "Scout your field and consult your local agronomy extension officer."}`
  );
}
