// Shapes database rows for API responses.

import { nutrientInfo, nutrientLabel, nutrientAdvice, nutrientCause, NUTRIENT_CAUTION, lookAlikeNote } from "./nutrients.js";

// The nutrient block every scan carries: present only when something was flagged.
export function formatNutrient(scan) {
  const code = nutrientInfo(scan.nutrient) ? scan.nutrient : null;
  if (!code) return null;
  const lang = scan.lang === "rw" ? "rw" : "en";
  return {
    code,
    label: nutrientLabel(code, lang),
    confidence: scan.nutrient_confidence,
    signs: scan.nutrient_signs,
    cause: nutrientCause(code, lang),
    advice: nutrientAdvice(code, lang),
    caution: NUTRIENT_CAUTION[lang],
  };
}

export function formatScan(s, viewer) {
  const out = {
    id: s.id,
    createdAt: s.created_at,
    crop: s.crop || "maize",
    pest: s.pest_label || "none",
    pestDetected: s.pest_detected,
    issueType: s.pest_detected ? "pest" : s.issue_type === "nutrient" ? "nutrient" : "none",
    nutrient: formatNutrient(s),
    stage: s.stage,
    confidence: s.confidence,
    affectedArea: s.affected_area,
    recommendation: s.recommendation,
    lookAlike: lookAlikeNote(s.pest_label, s.lang === "rw" ? "rw" : "en"),
    riskScore: s.risk_score,
    riskLevel: s.risk_level,
    spreadKmPerWeek: s.spread_km_week,
    lat: s.lat,
    lng: s.lng,
    locSource: s.loc_source,
    district: s.district,
    sector: s.sector,
    thumb: s.thumb,
    qualifiesOutbreak: s.qualifies_outbreak,
  };
  if (viewer && viewer.role !== "farmer") {
    out.farmer = s.farmer_name !== undefined ? { id: s.user_id, name: s.farmer_name, phone: s.farmer_phone, email: s.farmer_email } : { id: s.user_id };
  }
  if (s.alert_id !== undefined) out.alertId = s.alert_id;
  if (s.request_id !== undefined) out.requestId = s.request_id;
  return out;
}

export function districtList(v) {
  const arr = Array.isArray(v) ? v : String(v || "").split(",");
  return [...new Set(arr.map((d) => String(d).trim()).filter(Boolean).map((d) => d.slice(0, 60)))].slice(0, 40);
}
