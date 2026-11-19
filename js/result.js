/* Renders a scan result into the result card (same element ids on the homepage and the farmer dashboard). */

let lastScan = null;     // full scan from the server (logged-in users)
let lastSpread = null;
let lastOutbreak = null;
let lastBasic = null;    // basic result (visitors)

function resetResult() {
  lastScan = lastSpread = lastOutbreak = lastBasic = null;
  $('resultCard').style.display = 'none';
  $('errorText').textContent = '';
  renderNutrient(null);
  if (typeof Motion !== 'undefined') {
    Motion.ring($('confidenceRing'), 0, null);
    const g = $('riskGauge');
    if (g) { g.innerHTML = ''; delete g.dataset.value; }
  }
}

// A short entrance so the result does not just pop into existence.
function revealResultCard() {
  const card = $('resultCard');
  if (!card || typeof card.animate !== 'function' || typeof Motion === 'undefined' || Motion.reduce()) return;
  card.animate(
    [{ opacity: 0, transform: 'translateY(12px)' }, { opacity: 1, transform: 'none' }],
    { duration: 380, easing: 'cubic-bezier(.22,.61,.36,1)' }
  );
}

function showResultError(msg) {
  $('resultCard').style.display = 'block';
  $('stageBadge').textContent = '—';
  $('stageBadge').className = 'badge none';
  $('confidenceText').textContent = '';
  $('verdict').textContent = '';
  renderNutrient(null);
  $('errorText').textContent = t('wrong') + msg;
  ['lockedBox', 'fullBox'].forEach((id) => { if ($(id)) $(id).style.display = 'none'; });
}

function cropName(id) {
  const c = (typeof CROP_CHOICES !== 'undefined' ? CROP_CHOICES : []).find((x) => x.id === id);
  return c ? (lang === 'rw' ? c.rw : c.en) : '';
}

// The nutrient block: shown to visitors too, because the name alone lets them ask an agronomist
// about it. Visitors get the short caution from i18n; the full fix only comes with an account.
function renderNutrient(n) {
  const box = $('nutrientBox');
  if (!box) return;
  if (!n || !n.code) { box.style.display = 'none'; return; }
  $('nutrientName').textContent = n.label || '';
  $('nutrientConfidence').textContent = n.confidence != null ? t('confidence') + ' ' + Math.round(n.confidence * 100) + '%' : '';
  const signs = $('nutrientSigns');
  signs.textContent = n.signs || '';
  signs.style.display = n.signs ? 'block' : 'none';
  $('nutrientAdvice').textContent = n.advice || t('nutrientLocked');
  $('nutrientCaution').textContent = n.caution || t('nutrientCaution');
  box.style.display = 'block';
}

function renderHeader(stage, confidence, pestDetected, pest, crop, nutrient) {
  $('stageBadge').textContent = tl('stage_', stage);
  $('stageBadge').className = 'badge ' + stage;
  $('confidenceText').textContent = t('confidence') + ' ' + Math.round((confidence || 0) * 100) + '%';
  // the ring repeats the number visually for people who scan a page instead of reading it
  if (typeof Motion !== 'undefined') Motion.ring($('confidenceRing'), confidence, stage);
  const cropLabel = cropName(crop);
  const cause = pestDetection(pestDetected, pest);
  // when nothing is eating the leaf but the colour is wrong, say so in the verdict too
  const nutrientLine = !pestDetected && nutrient && nutrient.code ? t('nutrientSuspected') : '';
  $('verdict').textContent = [cropLabel, pestDetected ? t('pestYes') : nutrientLine || t('pestNo'), cause].filter(Boolean).join(' · ');
  renderNutrient(nutrient);
  $('errorText').textContent = '';
  const wasHidden = $('resultCard').style.display === 'none' || !$('resultCard').style.display;
  $('resultCard').style.display = 'block';
  if (wasHidden) revealResultCard();
}

// "Suspected cause: bean rust" — only when the AI actually named something
function pestDetection(pestDetected, pest) {
  return pestDetected && pest && pest !== 'none' ? t('suspectedCause') + ': ' + pest : '';
}

function renderBasic(d) {
  lastBasic = d;
  renderHeader(d.stage, d.confidence, d.pestDetected, d.pest, d.crop, d.nutrient);
  if ($('fullBox')) $('fullBox').style.display = 'none';
  if ($('lockedBox')) $('lockedBox').style.display = 'block';
}

function renderFull(scan, spread, outbreak) {
  lastScan = scan; lastSpread = spread; lastOutbreak = outbreak;
  renderHeader(scan.stage, scan.confidence, scan.pestDetected, scan.pest, scan.crop, scan.nutrient);
  if ($('lockedBox')) $('lockedBox').style.display = 'none';
  $('fullBox').style.display = 'block';
  $('affectedArea').textContent = scan.affectedArea || '—';
  $('recommendation').textContent = scan.recommendation || '—';
  const isNutrient = scan.issueType === 'nutrient';
  if (isNutrient) {
    // nothing spreads, so the gauge would be a made-up number — say why instead
    $('riskScore').textContent = '—';
    $('riskLevel').textContent = '—';
    $('spreadRate').textContent = '—';
    if (typeof Motion !== 'undefined' && $('riskGauge')) $('riskGauge').innerHTML = '';
    $('riskBasis').textContent = t('nutrientNoSpread');
    const note = $('outbreakNote');
    if (note) note.style.display = 'none';
    return;
  }
  $('riskScore').textContent = spread ? spread.riskScore : '—';
  $('riskLevel').textContent = spread && spread.riskLevel ? tl('risk_', spread.riskLevel) : '—';
  $('spreadRate').textContent = spread ? spread.estimatedSpreadKmPerWeek : '—';
  if (typeof Motion !== 'undefined' && $('riskGauge')) {
    Motion.gauge($('riskGauge'), spread ? spread.riskScore : 0, t('riskScore').toUpperCase());
  }

  let basis = '';
  if (!spread) basis = t('basisNoLoc');
  else {
    const n = spread.nearbyConfirmedCases || 0;
    basis = n > 0 ? t('basisSomeDb', { n, r: spread.radiusKm }) : t('basisNoneDb', { r: spread.radiusKm });
    const m = spread.mergedRepeatScans || 0;
    if (m > 0) basis += ' ' + t('basisMerged', { m });
  }
  if (scan.locSource === 'default') basis += ' ' + t('basisDefault');
  $('riskBasis').textContent = basis;

  const note = $('outbreakNote');
  if (outbreak && (outbreak.action === 'created' || outbreak.action === 'joined')) {
    note.textContent = t('outbreakJoined');
    note.style.display = 'block';
  } else note.style.display = 'none';
}

function refreshResultLabels() {
  if (lastScan) renderFull(lastScan, lastSpread, lastOutbreak);
  else if (lastBasic) renderBasic(lastBasic);
}

// Reads the scan a visitor made before logging in (kept 24 h on the server)
function pendingScanGet() {
  const p = lsGet('pendingScan', null);
  if (!p || !p.scanId || !p.claimToken) return null;
  if (Date.now() - new Date(p.createdAt).getTime() > 23 * 3600 * 1000) { pendingScanClear(); return null; }
  return p;
}
function pendingScanClear() { try { localStorage.removeItem('pendingScan'); } catch {} }
