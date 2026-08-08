// POST /api/predict-spread
// body: { detections: [{ lat, lng, timestamp (ISO string), stage }], newDetection: {...same shape} }
//
// IMPORTANT — HONEST SCOPE NOTE:
// This is a rule-based heuristic, NOT a trained machine-learning forecasting model.
// It estimates near-term spread risk from the density, recency, and severity of
// nearby confirmed detections, using published fall-armyworm field-spread ranges
// as rough constants. Swap this out for a real trained model (e.g. a spatio-temporal
// regression trained on historical outbreak data) before relying on it for anything
// beyond an early-warning prototype.

const RADIUS_KM = 5; // "nearby" cutoff for clustering detections
const DECAY_HALF_LIFE_DAYS = 10; // a detection's influence halves every N days
const STAGE_WEIGHT = { none: 0, early: 1, moderate: 2, severe: 3 };

function haversineKm(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST" });
  }

  const { detections = [], newDetection } = req.body || {};
  if (!newDetection || typeof newDetection.lat !== "number" || typeof newDetection.lng !== "number") {
    return res.status(400).json({ error: "newDetection with numeric lat/lng is required" });
  }

  const now = Date.now();
  let score = STAGE_WEIGHT[newDetection.stage] ?? 1;
  let nearbyCount = 0;

  for (const d of detections) {
    if (typeof d.lat !== "number" || typeof d.lng !== "number") continue;
    const distanceKm = haversineKm(newDetection, d);
    if (distanceKm > RADIUS_KM) continue;

    nearbyCount += 1;
    const ageDays = Math.max(0, (now - new Date(d.timestamp).getTime()) / 86400000);
    const decay = Math.pow(0.5, ageDays / DECAY_HALF_LIFE_DAYS);
    const proximityWeight = 1 - distanceKm / RADIUS_KM; // closer = more weight
    const severity = STAGE_WEIGHT[d.stage] ?? 1;

    score += severity * decay * proximityWeight;
  }

  // Normalize to a 0-100 risk score (soft cap; tune against real outbreak data later)
  const riskScore = Math.min(100, Math.round((score / 10) * 100));

  let riskLevel = "low";
  if (riskScore >= 75) riskLevel = "critical";
  else if (riskScore >= 50) riskLevel = "high";
  else if (riskScore >= 25) riskLevel = "medium";

  // Rough field-to-field spread distance per week, scaled by risk.
  // Based on general fall armyworm literature (larvae crawl locally, moths carry
  // it further) rather than a location-specific trained model.
  const estimatedSpreadKmPerWeek = +(0.3 + (riskScore / 100) * 2.2).toFixed(1);

  return res.status(200).json({
    riskScore,
    riskLevel,
    nearbyConfirmedCases: nearbyCount,
    estimatedSpreadKmPerWeek,
    method: "heuristic-clustering",
    note:
      "Rule-based estimate from nearby detection density, recency, and severity. Not a trained forecasting model.",
  });
}
