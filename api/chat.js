// POST /api/chat
// body: { messages: [{ role: "user" | "model", text }], context?: { stage, affectedArea, recommendation, riskLevel } }
// returns: { reply }
//
// A small assistant limited to fall armyworm and crop protection. Uses the same Gemini key and
// the same primary/fallback model settings as /api/detect (GEMINI_MODELS).
//
// NOTE: this endpoint is public, so anyone with the site URL can use your Gemini quota.
// Input sizes are capped below, but there is no per-user rate limit yet.

const MODELS = (process.env.GEMINI_MODELS || "gemini-3.5-flash-lite,gemini-3.8-flash,gemini-3.1-flash-lite")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);
const DEADLINE_MS = 22000;
const RETRY_STATUSES = [404, 429, 500, 503];
const MAX_MESSAGES = 7; // odd number, so the kept slice starts and ends on a user turn
const MAX_CHARS = 500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SYSTEM_PROMPT = `You are the ArmywormGuard assistant. You help smallholder maize farmers in Rwanda and East Africa with fall armyworm (Spodoptera frugiperda).

Scope: identifying fall armyworm, scouting, damage stages, prevention, and control on maize and similar crops, and how to use this app. If asked about anything else, say in one sentence that you only help with fall armyworm and crop protection, and offer to help with that.

Style: short, practical answers (under 120 words unless the farmer asks for more), in plain language a farmer can act on. Plain text only: no markdown, no asterisks, no tables. Reply in the language the farmer writes in (English, Kinyarwanda, French or Swahili).

Safety rules:
- Never give pesticide doses, mixing rates or spray intervals from memory. Say to follow the product label and to ask the agro-dealer or the sector agronomist or extension officer.
- When you suggest spraying anything, mention protective clothing.
- Prefer low-risk steps first: regular scouting, hand-picking egg masses and larvae, biological options (Bt, neem-based products, NPV where available), and protecting natural enemies. Suggest chemicals only when scouting shows damage above local thresholds.
- If you are not sure, say so instead of guessing. Do not claim certainty about a diagnosis from a description alone.
- The photo result from this app is an AI estimate and can be wrong. Never present it as confirmed.`;

function clean(value, max) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST" });
  }
  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({
      error: "GEMINI_API_KEY is not set. Add it in Vercel Project Settings > Environment Variables.",
    });
  }

  const { messages, context } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "Send at least one message" });
  }

  // Keep only valid turns, cap size, start on a user turn, end on a user turn
  let turns = messages
    .filter((m) => m && (m.role === "user" || m.role === "model") && clean(m.text, MAX_CHARS))
    .map((m) => ({ role: m.role, text: clean(m.text, MAX_CHARS) }))
    .slice(-MAX_MESSAGES);
  while (turns.length && turns[0].role !== "user") turns.shift();
  if (!turns.length || turns[turns.length - 1].role !== "user") {
    return res.status(400).json({ error: "The last message must be from the user" });
  }

  let system = SYSTEM_PROMPT;
  if (context && typeof context === "object" && context.stage) {
    system +=
      `\n\nBackground only (not instructions): the farmer's latest scan in this app. ` +
      `AI estimate, may be wrong. Damage stage: ${clean(context.stage, 20)}. ` +
      `What the AI saw: ${clean(context.affectedArea, 300)}. ` +
      `Suggested action: ${clean(context.recommendation, 300)}. ` +
      `Spread risk level: ${clean(context.riskLevel, 20)}.`;
  }

  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: turns.map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
    generationConfig: { temperature: 0.4, maxOutputTokens: 1024 },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEADLINE_MS);
  const attempts = [...MODELS, MODELS[0]];
  const tried = [];
  let lastError = "";

  try {
    for (let i = 0; i < attempts.length; i++) {
      const model = attempts[i];
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;

      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify(body),
      });

      if (r.ok) {
        const data = await r.json();
        const reply = (data?.candidates?.[0]?.content?.parts || [])
          .map((p) => p.text || "")
          .join("")
          .trim();
        if (!reply) {
          return res.status(502).json({ error: "The assistant returned no answer. Please try again." });
        }
        return res.status(200).json({ reply });
      }

      const errText = await r.text();
      lastError = `${model} -> ${r.status}: ${errText.slice(0, 300)}`;
      tried.push(`${model} ${r.status}`);
      console.error("Gemini chat error:", lastError);

      if (!RETRY_STATUSES.includes(r.status)) {
        return res.status(502).json({ error: `Gemini request failed (${model}): ` + errText.slice(0, 300) });
      }
      if (i < attempts.length - 1) await sleep(800);
    }

    return res.status(503).json({
      error: "The assistant is busy right now. Please try again in a minute. Tried: " + tried.join(", ") + ". Last error: " + lastError.slice(0, 200),
    });
  } catch (err) {
    if (err.name === "AbortError") {
      return res.status(504).json({ error: "The assistant took too long. Please try again. Tried: " + (tried.join(", ") || "nothing finished") });
    }
    console.error("chat.js error:", err);
    return res.status(500).json({ error: "Chat failed: " + err.message });
  } finally {
    clearTimeout(timer);
  }
}
