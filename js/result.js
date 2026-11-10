/* Renders a scan result into the result card (same element ids on the homepage and the farmer dashboard). */

let lastScan = null;     // full scan from the server (logged-in users)
let lastSpread = null;
let lastOutbreak = null;
let lastBasic = null;    // basic result (visitors)

function resetResult() {
  lastScan = lastSpread = lastOutbreak = lastBasic = null;
  $('resultCard').style.display = 'none';
  $('errorText').textContent = '';
}

function showResultError(msg) {
  $('resultCard').style.display = 'block';
  $('stageBadge').textContent = '—';
  $('stageBadge').className = 'badge none';
  $('confidenceText').textContent = '';
  $('verdict').textContent = '';
  $('errorText').textContent = t('wrong') + msg;
  ['lockedBox', 'fullBox'].forEach((id) => { if ($(id)) $(id).style.display = 'none'; });
}

function renderHeader(stage, confidence, pestDetected) {
  $('stageBadge').textContent = tl('stage_', stage);
  $('stageBadge').className = 'badge ' + stage;
  $('confidenceText').textContent = t('confidence') + ' ' + Math.round((confidence || 0) * 100) + '%';
  $('verdict').textContent = pestDetected ? t('pestYes') : t('pestNo');
  $('errorText').textContent = '';
  $('resultCard').style.display = 'block';
}

function renderBasic(d) {
  lastBasic = d;
  renderHeader(d.stage, d.confidence, d.pestDetected);
  if ($('fullBox')) $('fullBox').style.display = 'none';
  if ($('lockedBox')) $('lockedBox').style.display = 'block';
}

function renderFull(scan, spread, outbreak) {
  lastScan = scan; lastSpread = spread; lastOutbreak = outbreak;
  renderHeader(scan.stage, scan.confidence, scan.pestDetected);
  if ($('lockedBox')) $('lockedBox').style.display = 'none';
  $('fullBox').style.display = 'block';
  $('affectedArea').textContent = scan.affectedArea || '—';
  $('recommendation').textContent = scan.recommendation || '—';
  $('riskScore').textContent = spread ? spread.riskScore : '—';
  $('riskLevel').textContent = spread && spread.riskLevel ? tl('risk_', spread.riskLevel) : '—';
  $('spreadRate').textContent = spread ? spread.estimatedSpreadKmPerWeek : '—';

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
