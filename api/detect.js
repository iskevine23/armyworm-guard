// POST /api/detect
// body: { image: "<base64 string, no data-uri prefix>", mediaType: "image/jpeg", crop: "maize", lang: "en" }
// returns: { pestDetected, pest, confidence, stage, affectedArea, recommendation, crop, model }
//
// Thin wrapper around lib/gemini.js so the public endpoint and /api/scans share ONE prompt.
// The prompt itself now comes from lib/crops.js, so every supported crop gets its own pest list.
// Models can be changed from Vercel without editing code:
//   GEMINI_MODELS  comma-separated, tried in order
//                  (default gemini-3.5-flash-lite,gemini-3.8-flash,gemini-3.1-flash-lite)

import { detectImage } from "../lib/gemini.js";
import { getCrop } from "../lib/crops.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST" });
  }
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON body" }); }
  }
  body = body || {};
  if (!body.image) {
    return res.status(400).json({ error: "Missing 'image' (base64) in request body" });
  }

  const crop = getCrop(body.crop).id;
  const lang = body.lang === "rw" ? "rw" : "en";
  try {
    const { result, model } = await detectImage({ image: body.image, mediaType: body.mediaType, lang, crop });
    return res.status(200).json({ ...result, crop, model });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error("detect.js error:", err);
    return res.status(status).json({ error: err.message || "Detection failed. Please try again." });
  }
}
