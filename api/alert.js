import twilio from "twilio";

// POST /api/alert
// body: { phone: "+250xxxxxxxxx", stage, riskLevel, recommendation }
// Sends an SMS to the farmer. Requires Twilio env vars to be set in Vercel;
// if they're missing, logs the message instead of failing the whole flow,
// so the detect->predict->alert pipeline stays demonstrable without a Twilio account.
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST" });
  }

  const { phone, stage, riskLevel, recommendation } = req.body || {};
  if (!phone) {
    return res.status(400).json({ error: "Missing 'phone'" });
  }

  const body = buildMessage({ stage, riskLevel, recommendation });

  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER } = process.env;

  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER) {
    console.warn("Twilio env vars not set — simulating SMS instead of sending:", body);
    return res.status(200).json({
      sent: false,
      simulated: true,
      message: body,
      note:
        "Twilio credentials not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER in Vercel to send real SMS.",
    });
  }

  try {
    const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
    const result = await client.messages.create({
      to: phone,
      from: TWILIO_FROM_NUMBER,
      body,
    });
    return res.status(200).json({ sent: true, simulated: false, sid: result.sid });
  } catch (err) {
    console.error("alert.js error:", err);
    return res.status(500).json({ error: "SMS send failed", detail: err.message });
  }
}

function buildMessage({ stage, riskLevel, recommendation }) {
  const stageLabel = stage ? stage.toUpperCase() : "UNKNOWN";
  const riskLabel = riskLevel ? riskLevel.toUpperCase() : "UNKNOWN";
  return (
    `ArmywormGuard Alert: ${stageLabel} fall armyworm damage detected. ` +
    `Regional spread risk: ${riskLabel}. ` +
    `Action: ${recommendation || "Scout your field and consult your local agronomy extension officer."}`
  );
}
