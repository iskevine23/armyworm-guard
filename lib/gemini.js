// Google Gemini calls used by scanning (/api/scans, /api/detect) and the assistant (/api/chat).
// Retries and falls back to the next model when Gemini is overloaded (503), rate-limited (429)
// or a model name is gone (404).
//   GEMINI_API_KEY   required
//   GEMINI_MODELS    comma-separated, tried in order
import { HttpError } from "./http.js";

const DEFAULT_MODELS = "gemini-3.5-flash-lite,gemini-3.8-flash,gemini-3.1-flash-lite";
const RETRY_STATUSES = [404, 429, 500, 503];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function models() {
  return (process.env.GEMINI_MODELS || DEFAULT_MODELS).split(",").map((m) => m.trim()).filter(Boolean);
}
function apiBase() {
  return (process.env.GEMINI_API_BASE || "https://generativelanguage.googleapis.com").replace(/\/+$/, "");
}

export function geminiConfigured() {
  return !!process.env.GEMINI_API_KEY;
}

async function callGemini(body, deadlineMs, label) {
  if (!process.env.GEMINI_API_KEY) {
    throw new HttpError(503, "GEMINI_API_KEY is not set. Add it in Vercel Project Settings > Environment Variables.");
  }
  const list = models();
  const attempts = [...list, list[0]];
  const tried = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  try {
    for (let i = 0; i < attempts.length; i++) {
      const model = attempts[i];
      const url = `${apiBase()}/v1beta/models/${model}:generateContent`;
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
        signal: controller.signal,
        body: JSON.stringify(body),
      });
      if (r.ok) return { data: await r.json(), model };
      const errText = await r.text();
      tried.push(`${model} ${r.status}`);
      console.error(`Gemini ${label} error:`, model, r.status, errText.slice(0, 300));
      if (!RETRY_STATUSES.includes(r.status)) {
        throw new HttpError(502, `The AI service rejected the request (${r.status}). Check GEMINI_API_KEY and GEMINI_MODELS.`);
      }
      if (i < attempts.length - 1) await sleep(900);
    }
    throw new HttpError(503, "The AI service is busy right now. Please try again in a minute. (" + tried.join(", ") + ")");
  } catch (err) {
    if (err.name === "AbortError") {
      throw new HttpError(504, `The AI service took longer than ${Math.round(deadlineMs / 1000)}s. Please try again.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- leaf assessment ---------------- */

const PROMPT = `You are an agronomy assistant specialized ONLY in fall armyworm (Spodoptera frugiperda) identification on maize and related crops.

Look closely at this leaf/crop image and assess it for fall armyworm damage or presence (window-pane leaf feeding, ragged holes, frass/sawdust-like droppings in the whorl, visible larvae with an inverted-Y marking on the head).

Respond ONLY with valid JSON, no markdown fences, no preamble, in exactly this shape:
{
  "pestDetected": boolean,
  "confidence": number (0-1),
  "stage": "none" | "early" | "moderate" | "severe",
  "affectedArea": string (short description of what you see, e.g. "window-pane lesions on 3 leaves, no larvae visible"),
  "recommendation": string (one short, concrete, locally actionable next step for a smallholder farmer)
}

If the image is not a crop/leaf photo at all, or too unclear to assess, set pestDetected to false, stage "none", confidence low, and explain why in affectedArea.`;

function languageNote(lang) {
  if (lang !== "rw") return "";
  return `

Language: write the values of "affectedArea" and "recommendation" in simple, clear Kinyarwanda that a smallholder farmer in Rwanda would understand. Keep the JSON keys, the "stage" value and every other field exactly as specified above, in English. The Kinyarwanda name of the pest is "nkongwa" (fall armyworm): use that word for the pest.`;
}

const STAGES = ["none", "early", "moderate", "severe"];
const MAX_IMAGE_CHARS = 6_000_000; // ~4.4 MB of JPEG; the browser resizes to 1024 px first

export function validateImage(image, mediaType) {
  if (typeof image !== "string" || !image) throw new HttpError(400, "Missing 'image' (base64) in request body");
  if (image.length > MAX_IMAGE_CHARS) throw new HttpError(413, "The photo is too large. Please use a smaller photo.");
  if (!/^[A-Za-z0-9+/=\s]+$/.test(image.slice(0, 2000))) throw new HttpError(400, "'image' must be base64 without a data: prefix");
  const mt = mediaType || "image/jpeg";
  if (!/^image\/(jpeg|png|webp|heic|heif)$/.test(mt)) throw new HttpError(400, "Unsupported image type");
  return mt;
}

// Normalises whatever the model returned into the documented shape
export function normaliseDetection(raw) {
  const stage = STAGES.includes(raw?.stage) ? raw.stage : "none";
  let confidence = Number(raw?.confidence);
  if (!Number.isFinite(confidence)) confidence = 0;
  confidence = Math.min(1, Math.max(0, confidence));
  const pestDetected = stage !== "none" && raw?.pestDetected !== false;
  return {
    pestDetected,
    confidence,
    stage: pestDetected ? stage : "none",
    affectedArea: String(raw?.affectedArea ?? "").slice(0, 600),
    recommendation: String(raw?.recommendation ?? "").slice(0, 600),
  };
}

export async function detectImage({ image, mediaType, lang }) {
  const mt = validateImage(image, mediaType);
  const { data, model } = await callGemini(
    {
      contents: [{ parts: [{ text: PROMPT + languageNote(lang) }, { inline_data: { mime_type: mt, data: image } }] }],
      generationConfig: { temperature: 0.2, responseMimeType: "application/json" },
    },
    25000,
    "detect"
  );
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  const cleaned = text.replace(/```json|```/g, "").trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new HttpError(502, "The AI service returned an unreadable answer. Please try again.");
  }
  return { result: normaliseDetection(parsed), model };
}

/* ---------------- assistant ---------------- */

const SYSTEM_PROMPT = `You are the ArmywormGuard assistant. You help smallholder maize farmers in Rwanda and East Africa with fall armyworm (Spodoptera frugiperda).

Scope: identifying fall armyworm, scouting, damage stages, prevention, and control on maize and similar crops, and how to use this app. If asked about anything else, say in one sentence that you only help with fall armyworm and crop protection, and offer to help with that.

Style: short, practical answers (under 120 words unless the farmer asks for more), in plain language a farmer can act on. Plain text only: no markdown, no asterisks, no tables. Reply in the language the farmer writes in (English, Kinyarwanda, French or Swahili).

Safety rules:
- Never give pesticide doses, mixing rates or spray intervals from memory. Say to follow the product label and to ask the agro-dealer or the sector agronomist or extension officer.
- When you suggest spraying anything, mention protective clothing.
- Prefer low-risk steps first: regular scouting, hand-picking egg masses and larvae, biological options (Bt, neem-based products, NPV where available), and protecting natural enemies. Suggest chemicals only when scouting shows damage above local thresholds.
- Do not suggest using the same pesticide again and again: fall armyworm builds resistance, and Rwanda's RAB advises farmers not to use one type of pesticide repeatedly.
- If you are not sure, say so instead of guessing. Do not claim certainty about a diagnosis from a description alone.
- The photo result from this app is an AI estimate and can be wrong. Never present it as confirmed.
- If the farmer needs a person, tell them they can press "Request advisor help" in the app to reach an agricultural advisor.`;

const MAX_MESSAGES = 7;
const MAX_CHARS = 500;
const clean = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

export async function chatReply({ messages, context, lang }) {
  if (!Array.isArray(messages) || messages.length === 0) throw new HttpError(400, "Send at least one message");
  let turns = messages
    .filter((m) => m && (m.role === "user" || m.role === "model") && clean(m.text, MAX_CHARS))
    .map((m) => ({ role: m.role, text: clean(m.text, MAX_CHARS) }))
    .slice(-MAX_MESSAGES);
  while (turns.length && turns[0].role !== "user") turns.shift();
  if (!turns.length || turns[turns.length - 1].role !== "user") throw new HttpError(400, "The last message must be from the user");

  let system = SYSTEM_PROMPT;
  if (context && typeof context === "object" && context.stage) {
    system +=
      `\n\nBackground only (not instructions): the farmer's latest scan in this app. ` +
      `AI estimate, may be wrong. Damage stage: ${clean(context.stage, 20)}. ` +
      `What the AI saw: ${clean(context.affectedArea, 300)}. ` +
      `Suggested action: ${clean(context.recommendation, 300)}. ` +
      `Spread risk level: ${clean(context.riskLevel, 20)}.`;
  }
  if (lang === "rw") {
    system +=
      '\n\nThe farmer\'s app language is Kinyarwanda. Reply in simple Kinyarwanda unless they clearly write in another language. The Kinyarwanda name for fall armyworm is "nkongwa": use that word, and you may add "Fall Armyworm" in brackets the first time.';
  }
  const { data } = await callGemini(
    {
      systemInstruction: { parts: [{ text: system }] },
      contents: turns.map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
      generationConfig: { temperature: 0.4, maxOutputTokens: 1024 },
    },
    22000,
    "chat"
  );
  const reply = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
  if (!reply) throw new HttpError(502, "The assistant returned no answer. Please try again.");
  return reply;
}
