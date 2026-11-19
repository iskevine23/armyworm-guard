/* Shared motion + interaction helpers for every page.
   Nothing here is required: each function is a no-op when its markup is absent, all
   animation is skipped for prefers-reduced-motion, and the pages stay usable with
   JavaScript disabled. Loaded after js/ui.js on every page. */

const Motion = (() => {
  const reduce = () => {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
    catch { return false; }
  };
  const $all = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  /* ---------- reveal on scroll ---------- */
  function reveal(root) {
    const items = $all('[data-reveal]', root).filter((el) => !el.classList.contains('in'));
    if (reduce() || !('IntersectionObserver' in window)) {
      items.forEach((el) => el.classList.add('in'));
      return;
    }
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('in');
        io.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    items.forEach((el) => {
      // siblings that arrive together animate one after another
      if (!el.style.getPropertyValue('--d')) {
        const i = Array.prototype.indexOf.call(el.parentElement?.children || [], el);
        el.style.setProperty('--d', Math.min(320, i * 55) + 'ms');
      }
      io.observe(el);
    });
  }

  /* ---------- count a number up when it scrolls into view ---------- */
  function countUp(el) {
    const to = Number(el.dataset.countTo || el.dataset.count || 0);
    const suffix = el.dataset.suffix || '';
    const decimals = Number(el.dataset.decimals || 0);
    const render = (v) => { el.textContent = v.toFixed(decimals) + suffix; };
    if (reduce() || !to) { render(to); return; }
    const run = () => {
      const dur = 900 + Math.min(900, Math.abs(to) * 18);
      let started = null;
      const tick = (now) => {
        // Start from the first frame's own timestamp: a rAF stamp can be older than a
        // performance.now() taken just before it, which used to make the first frames
        // negative and the counter jump to numbers like -878 before settling.
        if (started === null) started = now;
        const p = Math.min(1, Math.max(0, (now - started) / dur));
        const eased = 1 - Math.pow(1 - p, 3);
        render(to * eased);
        if (p < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    };
    if (!('IntersectionObserver' in window)) { run(); return; }
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) { run(); io.disconnect(); } });
    }, { threshold: 0.4 });
    io.observe(el);
  }
  const counters = (root) => $all('[data-count-to], [data-count]', root).forEach(countUp);

  /* ---------- tap ripple ---------- */
  function ripple() {
    document.addEventListener('pointerdown', (e) => {
      const target = e.target.closest('button, .btn, .pill');
      if (!target || reduce() || target.dataset.noRipple) return;
      const rect = target.getBoundingClientRect();
      const size = Math.max(rect.width, rect.height);
      const span = document.createElement('span');
      span.className = 'ripple-fx';
      span.style.width = span.style.height = size + 'px';
      span.style.left = (e.clientX - rect.left - size / 2) + 'px';
      span.style.top = (e.clientY - rect.top - size / 2) + 'px';
      target.appendChild(span);
      setTimeout(() => span.remove(), 600);
    }, { passive: true });
  }

  /* ---------- soft light that follows the pointer across a card ---------- */
  function glow() {
    document.addEventListener('pointermove', (e) => {
      const card = e.target.closest('.glow');
      if (!card) return;
      const r = card.getBoundingClientRect();
      card.style.setProperty('--mx', ((e.clientX - r.left) / r.width) * 100 + '%');
      card.style.setProperty('--my', ((e.clientY - r.top) / r.height) * 100 + '%');
    }, { passive: true });
  }

  /* ---------- sticky header + scroll progress ---------- */
  function scrollUi() {
    const bar = document.getElementById('scrollProgress');
    const header = document.querySelector('.site-header');
    let raf = 0;
    const paint = () => {
      raf = 0;
      const h = document.documentElement;
      const max = h.scrollHeight - h.clientHeight;
      const p = max > 0 ? h.scrollTop / max : 0;
      if (bar) bar.style.transform = 'scaleX(' + p.toFixed(3) + ')';
      if (header) header.classList.toggle('compact', h.scrollTop > 24);
    };
    addEventListener('scroll', () => { if (!raf) raf = requestAnimationFrame(paint); }, { passive: true });
    paint();
  }

  /* ---------- confidence ring ---------- */
  // Draws a ring into `box` (a .ring-box element) and writes the percentage inside it.
  function ring(box, value, stage) {
    if (!box) return;
    const pct = Math.max(0, Math.min(100, Math.round((Number(value) || 0) * 100)));
    const R = 30, C = 2 * Math.PI * R;
    box.innerHTML =
      '<svg class="ring' + (stage ? ' stage-' + stage : '') + '" viewBox="0 0 74 74" aria-hidden="true">' +
      '<circle class="bg" cx="37" cy="37" r="' + R + '"></circle>' +
      '<circle class="fg" cx="37" cy="37" r="' + R + '" style="--c:' + C.toFixed(1) + ';stroke-dashoffset:' + C.toFixed(1) + '"></circle>' +
      '</svg><span class="ring-num">' + pct + '%</span>';
    const fg = box.querySelector('.fg');
    requestAnimationFrame(() => {
      if (fg) fg.style.strokeDashoffset = (C * (1 - pct / 100)).toFixed(1);
    });
  }

  /* ---------- risk gauge (half dial) ---------- */
  function gauge(host, score, caption) {
    if (!host) return;
    const v = Math.max(0, Math.min(100, Number(score) || 0));
    const LEN = Math.PI * 120;
    const inner = Number(host.dataset.value || Infinity);
    if (host.querySelector('.gauge') && inner === v) return;
    host.dataset.value = String(v);
    host.innerHTML =
      '<svg class="gauge" viewBox="0 0 288 158" role="img" aria-label="' + (caption || 'Risk score') + ' ' + v + ' of 100">' +
        '<defs><linearGradient id="gaugeGrad" x1="0" y1="0" x2="1" y2="0">' +
          '<stop offset="0%" stop-color="#7FA65B"></stop><stop offset="55%" stop-color="#D9A441"></stop>' +
          '<stop offset="100%" stop-color="#A63A2C"></stop></linearGradient></defs>' +
        '<path class="arc-bg" d="M24 140 A120 120 0 0 1 264 140"></path>' +
        '<path class="arc-fg" d="M24 140 A120 120 0 0 1 264 140" style="--len:' + LEN.toFixed(0) +
          ';stroke-dashoffset:' + LEN.toFixed(0) + '"></path>' +
        '<text class="val" x="144" y="122" text-anchor="middle" style="font-size:42px">' + Math.round(v) + '</text>' +
        '<text class="cap" x="144" y="142" text-anchor="middle">' + (caption || 'RISK SCORE') + '</text>' +
        '<text class="tick" x="24" y="156" text-anchor="middle">0</text>' +
        '<text class="tick" x="264" y="156" text-anchor="middle">100</text>' +
      '</svg>';
    const fg = host.querySelector('.arc-fg');
    requestAnimationFrame(() => {
      if (fg) fg.style.strokeDashoffset = (LEN * (1 - v / 100)).toFixed(0);
    });
  }

  /* ---------- sparkline of recent values ---------- */
  function spark(host, values, opts) {
    if (!host) return;
    const o = Object.assign({ width: 100, height: 40, pad: 4 }, opts || {});
    const nums = (values || []).map(Number).filter((n) => Number.isFinite(n));
    if (nums.length < 2) { host.innerHTML = ''; return; }
    const min = Math.min(...nums), max = Math.max(...nums);
    const span = max - min || 1;
    const stepX = (o.width - o.pad * 2) / (nums.length - 1);
    const pts = nums.map((n, i) => [
      o.pad + i * stepX,
      o.pad + (o.height - o.pad * 2) * (1 - (n - min) / span),
    ]);
    const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(2) + ' ' + p[1].toFixed(2)).join(' ');
    const area = line + ' L' + pts[pts.length - 1][0].toFixed(2) + ' ' + o.height + ' L' + pts[0][0].toFixed(2) + ' ' + o.height + ' Z';
    const last = pts[pts.length - 1];
    host.innerHTML =
      '<svg class="spark" viewBox="0 0 ' + o.width + ' ' + o.height + '" preserveAspectRatio="none" aria-hidden="true">' +
        '<defs><linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0%" stop-color="#7FA65B" stop-opacity="0.5"></stop>' +
          '<stop offset="100%" stop-color="#7FA65B" stop-opacity="0"></stop></linearGradient></defs>' +
        '<path class="area" d="' + area + '"></path>' +
        '<path class="line" d="' + line + '"></path>' +
        '<circle cx="' + last[0].toFixed(2) + '" cy="' + last[1].toFixed(2) + '" r="2.4"></circle>' +
      '</svg>';
  }

  /* ---------- pulsing map marker for Leaflet ---------- */
  function pulseIcon(tone) {
    const cls = 'pulse-marker' + (tone === 'severe' ? ' severe' : '');
    return '<span class="' + cls + '"><span class="wave"></span><span class="core"></span></span>';
  }

  /* ---------- hover tilt (subtle, pointer devices only) ---------- */
  function tilt() {
    if (reduce()) return;
    document.addEventListener('pointermove', (e) => {
      const el = e.target.closest('[data-tilt]');
      if (!el) return;
      const r = el.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5;
      const y = (e.clientY - r.top) / r.height - 0.5;
      el.style.transform = 'perspective(700px) rotateX(' + (-y * 4).toFixed(2) + 'deg) rotateY(' + (x * 5).toFixed(2) + 'deg)';
    }, { passive: true });
    document.addEventListener('pointerout', (e) => {
      const el = e.target.closest('[data-tilt]');
      if (el) el.style.transform = '';
    }, { passive: true });
  }

  function init() {
    if (reduce()) document.documentElement.classList.add('no-motion');
    reveal();
    counters();
    ripple();
    glow();
    scrollUi();
    tilt();
  }

  document.addEventListener('DOMContentLoaded', init);
  return { reveal, counters, countUp, ring, gauge, spark, pulseIcon, reduce };
})();

if (typeof window !== 'undefined') window.Motion = Motion;
