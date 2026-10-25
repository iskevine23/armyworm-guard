// POST /api/predict-spread
// body: { detections: [{ lat, lng, timestamp (ISO string), stage }], newDetection: {...same shape} }
//
// HONEST SCOPE NOTE:
// This is a rule-based heuristic, NOT a trained machine-learning forecasting model.
// It estimates near-term spread risk from the distance, recency, and severity of nearby
// earlier detections, using rough field-spread constants. Replace it with a model trained
// on real outbreak data before relying on it for more than an early-warning prototype.
//
// Rules:
//  - Repeat scans of the same spot (within 100 m and 30 min) count as ONE case, so testing
//    the same leaf several times does not inflate the score.
//  - Healthy scans (stage "none") are not cases and never raise anyone's risk.

const RADIUS_KM = 5;                    // "nearby" cutoff
const DECAY_HALF_LIFE_DAYS = 10;        // a case's influence halves every N days
const STAGE_WEIGHT = { none: 0, early: 1, moderate: 2, severe: 3 };
const SAME_SPOT_KM = 0.1;               // 100 m
const SAME_SPOT_MS = 30 * 60 * 1000;    // 30 minutes

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

function isSameSpot(a, b) {
  return (
    haversineKm(a, b) <= SAME_SPOT_KM &&
    Math.abs(new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()) <= SAME_SPOT_MS
  );
}

const weightOf = (d) => STAGE_WEIGHT[d.stage] ?? 1;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST" });
  }

  const { detections = [], newDetection } = req.body || {};
  if (!newDetection || typeof newDetection.lat !== "number" || typeof newDetection.lng !== "number") {
    return res.status(400).json({ error: "newDetection with numeric lat/lng is required" });
  }

  const current = {
    ...newDetection,
    timestamp: newDetection.timestamp || new Date().toISOString(),
  };

  let mergedRepeatScans = 0;

  // 1. Earlier scans of this same spot are the same case as the new scan: drop them
  const others = [];
  for (const d of detections) {
    if (typeof d.lat !== "number" || typeof d.lng !== "number") continue;
    if (isSameSpot(current, d)) {
      mergedRepeatScans += 1;
      continue;
    }
    others.push(d);
  }

  // 2. Collapse repeat scans among the remaining history (keep the most severe per spot)
  others.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const cases = [];
  for (const d of others) {
    const i = cases.findIndex((c) => isSameSpot(c, d));
    if (i === -1) {
      cases.push(d);
    } else {
      mergedRepeatScans += 1;
      if (weightOf(d) >= weightOf(cases[i])) cases[i] = d;
    }
  }

  // 3. Score
  const now = Date.now();
  let score = weightOf(current);
  let nearbyCount = 0;

  for (const d of cases) {
    const severity = weightOf(d);
    if (severity === 0) continue; // a healthy scan is not a case

    const distanceKm = haversineKm(current, d);
    if (distanceKm > RADIUS_KM) continue;

    nearbyCount += 1;
    const ageDays = Math.max(0, (now - new Date(d.timestamp).getTime()) / 86400000);
    const decay = Math.pow(0.5, ageDays / DECAY_HALF_LIFE_DAYS);
    const proximityWeight = 1 - distanceKm / RADIUS_KM; // closer = more weight

    score += severity * decay * proximityWeight;
  }

  // Normalize to a 0-100 score (soft cap; tune against real outbreak data later)
  const riskScore = Math.min(100, Math.round((score / 10) * 100));

  let riskLevel = "low";
  if (riskScore >= 75) riskLevel = "critical";
  else if (riskScore >= 50) riskLevel = "high";
  else if (riskScore >= 25) riskLevel = "medium";

  // Rough weekly spread distance, scaled by risk; zero when there is nothing to spread
  const estimatedSpreadKmPerWeek =
    riskScore === 0 ? 0 : +(0.3 + (riskScore / 100) * 2.2).toFixed(1);

  return res.status(200).json({
    riskScore,
    riskLevel,
    nearbyConfirmedCases: nearbyCount,
    radiusKm: RADIUS_KM,
    mergedRepeatScans,
    estimatedSpreadKmPerWeek,
    method: "heuristic-clustering",
    note: "Rule-based estimate from nearby earlier cases. Not a trained forecasting model.",
  });
}
