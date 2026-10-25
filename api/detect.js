// POST /api/detect
// body: { image: "<base64 string, no data-uri prefix>", mediaType: "image/jpeg" }
// returns: { pestDetected, confidence, stage, affectedArea, recommendation }
//
// Uses Google's Gemini API. If Gemini is overloaded (503), rate-limited (429) or the model name
// is gone (404), it retries and falls back to a second model before giving up.
// Models can be changed from Vercel without editing code:
//   GEMINI_MODELS  comma-separated, tried in order
//                  (default gemini-3.5-flash-lite,gemini-3.8-flash,gemini-3.1-flash-lite)

const MODELS = (process.env.GEMINI_MODELS || "gemini-3.5-flash-lite,gemini-3.8-flash,gemini-3.1-flash-lite")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);
const DEADLINE_MS = 27000; // total budget for all attempts; vercel.json allows 30s
const RETRY_STATUSES = [404, 429, 500, 503];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST" });
  }

  const { image, mediaType } = req.body || {};
  if (!image) {
    return res.status(400).json({ error: "Missing 'image' (base64) in request body" });
  }
  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({
      error:
        "GEMINI_API_KEY is not set. Add it in Vercel Project Settings > Environment Variables.",
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEADLINE_MS);
  const attempts = [...MODELS, MODELS[0]];
  const tried = [];
  let lastError = "";

  try {
    for (let i = 0; i < attempts.length; i++) {
      const model = attempts[i];
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;

      const geminiRes = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: PROMPT },
                { inline_data: { mime_type: mediaType || "image/jpeg", data: image } },
              ],
            },
          ],
          generationConfig: { temperature: 0.2, responseMimeType: "application/json" },
        }),
      });

      if (geminiRes.ok) {
        const data = await geminiRes.json();
        const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
        const cleaned = raw.replace(/```json|```/g, "").trim();
        try {
          return res.status(200).json(JSON.parse(cleaned));
        } catch (e) {
          return res.status(502).json({
            error:
              "Model did not return valid JSON. Raw response: " +
              (raw ? raw.slice(0, 200) : JSON.stringify(data).slice(0, 300)),
          });
        }
      }

      const errText = await geminiRes.text();
      lastError = `${model} -> ${geminiRes.status}: ${errText.slice(0, 300)}`;
      tried.push(`${model} ${geminiRes.status}`);
      console.error("Gemini API error:", lastError);

      if (!RETRY_STATUSES.includes(geminiRes.status)) {
        // Bad request / bad key / permission: retrying will not help
        return res
          .status(502)
          .json({ error: `Gemini API request failed (${model}): ` + errText.slice(0, 400) });
      }
      if (i < attempts.length - 1) await sleep(1000);
    }

    return res.status(503).json({
      error:
        "Gemini is busy right now. Please try again in a minute. Tried: " + tried.join(", ") + ". Last error: " + lastError.slice(0, 250),
    });
  } catch (err) {
    if (err.name === "AbortError") {
      return res.status(504).json({
        error: `Gemini took longer than ${DEADLINE_MS / 1000}s. Please try again in a minute. Tried: ${tried.join(", ") || "nothing finished"}`,
      });
    }
    console.error("detect.js error:", err);
    return res.status(500).json({ error: "Detection failed: " + err.message });
  } finally {
    clearTimeout(timer);
  }
}
