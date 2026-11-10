// Shapes database rows for API responses.

export function formatScan(s, viewer) {
  const out = {
    id: s.id,
    createdAt: s.created_at,
    pestDetected: s.pest_detected,
    stage: s.stage,
    confidence: s.confidence,
    affectedArea: s.affected_area,
    recommendation: s.recommendation,
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
