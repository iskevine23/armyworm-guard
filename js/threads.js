/* Shared views: a scan card, and the help-request conversation used by farmers, advisors and admins. */

const REQ_STATUS_LABEL = {
  open: 'Open', in_progress: 'In progress', awaiting_farmer: 'Waiting for farmer', resolved: 'Resolved', closed: 'Closed',
};

function scanCardEl(s, opts) {
  opts = opts || {};
  const body = h('div.scan-body',
    h('div.scan-top', stageBadge(s.stage), h('span.dist', fmtTime(s.createdAt))),
    s.affectedArea ? h('p.scan-text', s.affectedArea) : null,
    s.recommendation ? h('p.scan-text.dim', s.recommendation) : null,
    h('p.scan-text.dim',
      'AI confidence ' + pct(s.confidence),
      s.riskLevel ? ' · ' + (typeof tl === 'function' ? t('riskLevel') + ': ' + tl('risk_', s.riskLevel) : 'risk ' + s.riskLevel) : '',
      [s.sector, s.district].filter(Boolean).length ? ' · ' + [s.sector, s.district].filter(Boolean).join(', ') : ''),
    s.farmer && s.farmer.name ? h('p.scan-text', h('strong', s.farmer.name), s.farmer.phone ? ' · ' : '', s.farmer.phone ? h('a', { href: 'tel:' + s.farmer.phone }, s.farmer.phone) : null) : null,
    h('div.meta-row',
      s.lat != null ? h('span', '📍 ', mapsLink(s.lat, s.lng), ' (' + label(s.locSource) + ')') : null,
      s.qualifiesOutbreak ? h('span.pill-status.warn', 'counts toward outbreaks') : null,
      s.alertId ? h('a.pill-status.bad', { href: '#outbreaks-' + s.alertId }, 'outbreak #' + s.alertId) : null),
    opts.actions ? h('div.place-actions', opts.actions) : null
  );
  return h('div.scan-item', s.thumb ? h('img', { src: s.thumb, alt: '' }) : h('div.thumb-empty', '🌽'), body);
}

function requestRowEl(r, href, showFarmer) {
  return h('a.row-card', { href },
    h('div.row-top', h('span.row-title', '#' + r.id + ' ' + r.subject), pill(r.status, REQ_STATUS_LABEL[r.status])),
    h('div.row-meta',
      r.priority !== 'normal' ? pill(r.priority, r.priority) : null,
      r.stage ? stageBadge(r.stage) : null,
      showFarmer ? h('span', r.farmer.name) : null,
      [r.sector, r.district].filter(Boolean).length ? h('span', [r.sector, r.district].filter(Boolean).join(', ')) : null,
      h('span', r.advisor ? 'Advisor: ' + r.advisor.name : 'Not assigned yet'),
      h('span', 'updated ' + fmtAgo(r.updatedAt)),
      r.messageCount ? h('span', r.messageCount + ' message' + (r.messageCount > 1 ? 's' : '')) : null)
  );
}

// opts: { role, me, onBack, onChange }
async function renderRequestDetail(container, id, opts) {
  clear(container).appendChild(h('p.muted', 'Loading…'));
  let d;
  try { d = await API.get('/api/requests?action=get&id=' + id); }
  catch (err) {
    clear(container).append(h('button.secondary.small', { type: 'button', onclick: opts.onBack }, '← Back'), h('p.warn', err.message));
    return;
  }
  const r = d.request;
  const staff = opts.role !== 'farmer';
  clear(container);
  container.appendChild(h('button.secondary.small', { type: 'button', onclick: opts.onBack }, '← Back to the list'));
  container.appendChild(h('h1', '#' + r.id + ' ' + r.subject));
  container.appendChild(h('div.meta-row', pill(r.status, REQ_STATUS_LABEL[r.status]), pill(r.priority, 'priority: ' + r.priority),
    h('span', 'Opened ' + fmtTime(r.createdAt)), h('span', r.advisor ? 'Advisor: ' + r.advisor.name : 'Not assigned yet')));

  if (staff) {
    const f = d.farm || {};
    container.appendChild(h('div.panel',
      h('div.label', 'Farmer'),
      h('p', h('strong', r.farmer.name),
        r.farmer.phone ? [' · ', h('a', { href: 'tel:' + r.farmer.phone }, r.farmer.phone)] : null,
        r.farmer.email ? [' · ', h('a', { href: 'mailto:' + r.farmer.email }, r.farmer.email)] : null),
      h('p.muted', [f.farm_name, f.village, r.sector, r.district].filter(Boolean).join(' · ') || 'No farm details', f.farm_size_ha ? ' · ' + f.farm_size_ha + ' ha' : ''),
      r.lat != null ? h('p', '📍 ', mapsLink(r.lat, r.lng)) : null
    ));
  }

  if (d.scan) {
    container.appendChild(h('div.label', 'Scan report attached'));
    container.appendChild(scanCardEl(d.scan));
  }

  container.appendChild(h('div.label', 'Conversation'));
  const thread = h('div.thread');
  thread.appendChild(h('div.msg.from-farmer', h('div.msg-head', r.farmer.name, ' · ', fmtTime(r.createdAt)), h('div.msg-body', r.message)));
  d.messages.forEach((m) => {
    if (m.kind !== 'message') {
      thread.appendChild(h('div.msg-system', (m.author ? m.author.name + ': ' : '') + m.body + ' · ' + fmtAgo(m.createdAt)));
      return;
    }
    const mine = opts.me && m.author && m.author.id === opts.me.id;
    const cls = m.author && m.author.role === 'farmer' ? 'from-farmer' : 'from-staff';
    thread.appendChild(h('div.msg.' + cls + (mine ? '.mine' : ''),
      h('div.msg-head', (m.author ? m.author.name : 'Deleted user') + (m.author && m.author.role !== 'farmer' ? ' (' + m.author.role + ')' : ''), ' · ', fmtTime(m.createdAt)),
      h('div.msg-body', m.body)));
  });
  container.appendChild(thread);

  const reload = () => { renderRequestDetail(container, id, opts); if (opts.onChange) opts.onChange(); };

  // reply box
  if (!(opts.role === 'farmer' && r.status === 'closed')) {
    const ta = h('textarea', { rows: 4, maxlength: 4000, placeholder: staff ? 'Write your advice to the farmer…' : 'Write a reply…' });
    let statusSel = null;
    if (staff) {
      statusSel = h('select', { 'aria-label': 'Status after replying' },
        h('option', { value: '' }, 'Keep status (' + REQ_STATUS_LABEL[r.status] + ')'),
        ...['in_progress', 'awaiting_farmer', 'resolved', 'closed'].map((s) => h('option', { value: s }, 'Set: ' + REQ_STATUS_LABEL[s])));
    }
    const send = h('button', { type: 'submit' }, staff ? 'Send to farmer' : 'Send reply');
    const form = h('form.reply-form', field(staff ? 'Reply (the farmer is emailed)' : 'Reply (your advisor is emailed)', ta), h('div.actions', statusSel, send));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!ta.value.trim()) return;
      await busy(send, () => API.post('/api/requests?action=reply&id=' + r.id, { body: ta.value, status: statusSel && statusSel.value ? statusSel.value : undefined }));
      toast('Sent', 'ok');
      reload();
    });
    container.appendChild(form);
  }

  // status / assignment controls
  const controls = h('div.actions');
  const setStatus = async (btn, status, needNote) => {
    let note = '';
    if (needNote) {
      note = await askNote('Change status to "' + REQ_STATUS_LABEL[status] + '"', { placeholder: 'Optional note for the farmer (they are emailed)', okLabel: 'Update status' });
      if (note === null) return;
    }
    await busy(btn, () => API.post('/api/requests?action=status&id=' + r.id, { status, note }));
    toast('Status updated', 'ok');
    reload();
  };
  if (opts.role === 'farmer') {
    if (['open', 'in_progress', 'awaiting_farmer'].includes(r.status)) {
      const b1 = h('button.secondary', { type: 'button' }, 'My problem is solved');
      b1.onclick = () => setStatus(b1, 'resolved');
      controls.appendChild(b1);
    } else if (r.status === 'resolved') {
      const b2 = h('button.secondary', { type: 'button' }, 'I still need help (reopen)');
      b2.onclick = () => setStatus(b2, 'open');
      const b3 = h('button.secondary', { type: 'button' }, 'Close request');
      b3.onclick = () => setStatus(b3, 'closed');
      controls.append(b2, b3);
    }
  } else {
    const sel = h('select', { 'aria-label': 'Change status' }, ...Object.keys(REQ_STATUS_LABEL).map((s) => h('option', { value: s, selected: s === r.status }, REQ_STATUS_LABEL[s])));
    const b = h('button.secondary', { type: 'button' }, 'Update status');
    b.onclick = () => { if (sel.value !== r.status) setStatus(b, sel.value, true); };
    controls.append(sel, b);
    if (opts.role === 'advisor' && !r.advisor) {
      const claim = h('button', { type: 'button' }, 'Take this request');
      claim.onclick = async () => { await busy(claim, () => API.post('/api/requests?action=assign&id=' + r.id, {})); toast('Assigned to you', 'ok'); reload(); };
      controls.appendChild(claim);
    }
    if (opts.role === 'admin') {
      const assignSel = h('select', { 'aria-label': 'Assign advisor' }, h('option', { value: '' }, 'Unassigned'));
      API.get('/api/requests?action=advisors').then((a) => a.advisors.forEach((x) =>
        assignSel.appendChild(h('option', { value: x.id, selected: r.advisor && r.advisor.id === x.id }, x.name + ' (' + x.openRequests + ' open)'))));
      const ab = h('button.secondary', { type: 'button' }, 'Assign');
      ab.onclick = async () => { await busy(ab, () => API.post('/api/requests?action=assign&id=' + r.id, { advisorId: assignSel.value || null })); toast('Assignment saved', 'ok'); reload(); };
      controls.append(assignSel, ab);
    }
  }
  container.appendChild(controls);
  window.scrollTo(0, 0);
}
