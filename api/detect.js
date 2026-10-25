// POST /api/detect
// body: { image: "<base64 string, no data-uri prefix>", mediaType: "image/jpeg" }
// returns: { pestDetected, confidence, stage, affectedArea, recommendation }
//
// Uses Google's Gemini API (free tier available). Get a key at https://aistudio.google.com/apikey
// The model can be changed without editing code: set GEMINI_MODEL in Vercel and redeploy.

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";
const TIMEOUT_MS = 25000; // stay under the 30s maxDuration set in vercel.json

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

  const prompt = `You are an agronomy assistant specialized ONLY in fall armyworm (Spodoptera frugiperda) identification on maize and related crops.

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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;

    const geminiRes = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: prompt },
              { inline_data: { mime_type: mediaType || "image/jpeg", data: image } },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: "application/json",
        },
      }),
    });

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error("Gemini API error:", errText);
      return res
        .status(502)
        .json({ error: `Gemini API request failed (${GEMINI_MODEL}): ` + errText.slice(0, 400) });
    }

    const data = await geminiRes.json();
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const cleaned = raw.replace(/```json|```/g, "").trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      return res.status(502).json({
        error:
          "Model did not return valid JSON. Raw response: " +
          (raw ? raw.slice(0, 200) : JSON.stringify(data).slice(0, 300)),
      });
    }

    return res.status(200).json(parsed);
  } catch (err) {
    if (err.name === "AbortError") {
      return res.status(504).json({
        error: `Gemini took longer than ${TIMEOUT_MS / 1000}s (model: ${GEMINI_MODEL}). Try again, or set GEMINI_MODEL in Vercel to a faster model.`,
      });
    }
    console.error("detect.js error:", err);
    return res.status(500).json({ error: "Detection failed: " + err.message });
  } finally {
    clearTimeout(timer);
  }
}
