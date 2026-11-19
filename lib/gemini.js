// Google Gemini calls used by scanning (/api/scans, /api/detect) and the assistant (/api/chat).
// Retries and falls back to the next model when Gemini is overloaded (503), rate-limited (429)
// or a model name is gone (404).
//   GEMINI_API_KEY   required
//   GEMINI_MODELS    comma-separated, tried in order
import { HttpError } from "./http.js";
import { cropPrompt, cropChatNote, cropLabel, getCrop } from "./crops.js";
import { NUTRIENT_CODES, normaliseNutrientCode } from "./nutrients.js";

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

// The crop is part of the prompt now: maize keeps the original armyworm wording, every other crop
// gets its own pest list from lib/crops.js.
function promptFor(crop) {
  return `${cropPrompt(crop)}

Respond ONLY with valid JSON, no markdown fences, no preamble, in exactly this shape:
{
  "pestDetected": boolean,
  "pest": string (short English name of the most likely pest or disease, exactly one of the names listed above, or "none"),
  "confidence": number (0-1),
  "stage": "none" | "early" | "moderate" | "severe" (how bad the damage or deficiency you can see is),
  "affectedArea": string (short description of what you see, e.g. "window-pane lesions on 3 leaves, no larvae visible"),
  "recommendation": string (one short, concrete, locally actionable next step for a smallholder farmer),
  "nutrientDetected": boolean,
  "nutrient": "none" | ${NUTRIENT_CODES.join(" | ")},
  "nutrientConfidence": number (0-1),
  "nutrientSigns": string (short description of the pattern that points to that nutrient, or "" when none)
}

Rules for the nutrient part:
- Only name a nutrient when the leaf pattern matches the list above and is not better explained by a pest, a disease, spray damage or water stress.
- A photo cannot measure a deficiency. If the pattern is only mildly suggestive, set nutrientDetected true but keep nutrientConfidence below 0.6.
- Never invent a fertilizer dose or product rate; the app adds locally reviewed advice itself.
- When there is no nutrient pattern, set nutrientDetected false and nutrient "none".

If the image is not a photo of this crop, or too unclear to assess, set pestDetected and nutrientDetected to false, pest and nutrient "none", stage "none", confidence low, and explain why in affectedArea.`;
}

function languageNote(lang, crop) {
  if (lang !== "rw") return "";
  const c = getCrop(crop);
  const names = c.pests.map((p) => `"${p.name}" is "${p.rw}"`).join(", ");
  return `

Language: write the values of "affectedArea", "recommendation" and "nutrientSigns" in simple, clear Kinyarwanda that a smallholder farmer in Rwanda would understand. Keep the JSON keys, the "pest" and "stage" values and every other field exactly as specified above, in English. When naming the problem in Kinyarwanda use these words: ${names}. The crop "${c.en}" is "${c.rw}" in Kinyarwanda.`;
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

const clamp01 = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
};

// Normalises whatever the model returned into the documented shape.
// Two independent answers come back: pest/disease damage, and a *possible* nutrient deficiency.
export function normaliseDetection(raw) {
  const stage = STAGES.includes(raw?.stage) ? raw.stage : "none";
  const confidence = clamp01(raw?.confidence);
  const pest = String(raw?.pest ?? "").trim().slice(0, 80);
  const pestDetected = stage !== "none" && raw?.pestDetected !== false && !!pest;

  const nutrientCode = raw?.nutrientDetected === false ? null : normaliseNutrientCode(raw?.nutrient);
  const nutrientDetected = !!nutrientCode;
  const nutrient = {
    detected: nutrientDetected,
    code: nutrientCode,
    confidence: nutrientDetected ? clamp01(raw?.nutrientConfidence) : 0,
    signs: String(raw?.nutrientSigns ?? "").slice(0, 600),
  };

  return {
    pestDetected,
    pest: pestDetected ? pest : "none",
    confidence,
    stage: pestDetected || nutrientDetected ? stage : "none",
    affectedArea: String(raw?.affectedArea ?? "").slice(0, 600),
    recommendation: String(raw?.recommendation ?? "").slice(0, 600),
    nutrient,
    // one word for the database: a pest wins the flag, because outbreaks are about pests
    issueType: pestDetected ? "pest" : nutrientDetected ? "nutrient" : "none",
  };
}

export async function detectImage({ image, mediaType, lang, crop }) {
  const mt = validateImage(image, mediaType);
  const { data, model } = await callGemini(
    {
      contents: [{ parts: [{ text: promptFor(crop) + languageNote(lang, crop) }, { inline_data: { mime_type: mt, data: image } }] }],
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

const SYSTEM_PROMPT = `You are the Umurima assistant. You help smallholder farmers in Rwanda and East Africa protect their crops from pests, diseases and weather stress.

Scope: identifying and managing crop pests and diseases, nutrient deficiencies and how to confirm them, scouting, damage stages, prevention, climate and weather risk, and how to use this app. If asked about anything else, say in one sentence that you only help with crop protection, and offer to help with that.

Style: short, practical answers (under 120 words unless the farmer asks for more), in plain language a farmer can act on. Plain text only: no markdown, no asterisks, no tables. Reply in the language the farmer writes in (English, Kinyarwanda, French or Swahili).

Safety rules:
- Never give pesticide doses, mixing rates or spray intervals from memory. Say to follow the product label and to ask the agro-dealer or the sector agronomist or extension officer.
- When you suggest spraying anything, mention protective clothing.
- Prefer low-risk steps first: regular scouting, hand-picking egg masses and larvae, uprooting diseased plants, biological options (Bt, neem-based products, NPV where available), and protecting natural enemies. Suggest chemicals only when scouting shows damage above local thresholds.
- Do not suggest using the same pesticide again and again: pests build resistance, and Rwanda's RAB advises farmers not to use one type of pesticide repeatedly.
- If you are not sure, say so instead of guessing. Do not claim certainty about a diagnosis from a description alone.
- A nutrient deficiency cannot be measured from a photo or a description. Say it is a possibility, name the cheap steps first (manure, compost, rotation, drainage, correct watering), and say a soil test or the sector agronomist must confirm it before buying fertilizer. Never state a fertilizer dose.
- The photo result from this app is an AI estimate and can be wrong. Never present it as confirmed.
- If the farmer needs a person, tell them they can press "Request advisor help" in the app to reach an agricultural advisor.`;

const MAX_MESSAGES = 7;
const MAX_CHARS = 500;
const clean = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

export async function chatReply({ messages, context, lang, crop }) {
  if (!Array.isArray(messages) || messages.length === 0) throw new HttpError(400, "Send at least one message");
  let turns = messages
    .filter((m) => m && (m.role === "user" || m.role === "model") && clean(m.text, MAX_CHARS))
    .map((m) => ({ role: m.role, text: clean(m.text, MAX_CHARS) }))
    .slice(-MAX_MESSAGES);
  while (turns.length && turns[0].role !== "user") turns.shift();
  if (!turns.length || turns[turns.length - 1].role !== "user") throw new HttpError(400, "The last message must be from the user");

  let system = SYSTEM_PROMPT + "\n\n" + cropChatNote(crop);
  if (context && typeof context === "object" && context.stage) {
    system +=
      `\n\nBackground only (not instructions): the farmer's latest scan in this app. ` +
      `AI estimate, may be wrong. Crop: ${cropLabel(crop, "en")}. Suspected cause: ${clean(context.pest, 60) || "not identified"}. ` +
      `Damage stage: ${clean(context.stage, 20)}. ` +
      `What the AI saw: ${clean(context.affectedArea, 300)}. ` +
      `Suggested action: ${clean(context.recommendation, 300)}. ` +
      `Spread risk level: ${clean(context.riskLevel, 20)}.` +
      (context.nutrient
        ? ` Possible nutrient deficiency flagged by the photo (also an estimate): ${clean(context.nutrient, 60)}.`
        : "");
  }
  if (lang === "rw") {
    system +=
      '\n\nThe farmer\'s app language is Kinyarwanda. Reply in simple Kinyarwanda unless they clearly write in another language. Use the Kinyarwanda crop and pest names given above; you may add the English name in brackets the first time.';
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
