// POST /api/predict-spread
// body: { detections: [{ lat, lng, timestamp (ISO string), stage }], newDetection: {...same shape} }
// Pure calculation (no database, no AI). The scoring rules live in lib/spread.js; logged-in
// farmer scans use the same rules with every farmer's recent reports from the database.
import { predictSpread } from "../lib/spread.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST" });
  }
  const { detections = [], newDetection } = req.body || {};
  if (!newDetection || typeof newDetection.lat !== "number" || typeof newDetection.lng !== "number") {
    return res.status(400).json({ error: "newDetection with numeric lat/lng is required" });
  }
  if (!Array.isArray(detections) || detections.length > 2000) {
    return res.status(400).json({ error: "detections must be an array (max 2000)" });
  }
  return res.status(200).json(predictSpread(detections, newDetection));
}
