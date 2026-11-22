// The card look shared by the Sidekick's own UI (bubbles, the thinking tag, task tags, the step list): white cards with a
// hairline outline, rounded corners and the system sans, the same as the drawings' cards (ink.js) and the reminders.
(() => {
  const R = window.Roamie;
  if (!R || typeof document === 'undefined') return;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  // Monochrome: ink, two grays, white surfaces, a tint, hairlines; red only for lost, overdue or wrong.
  const ACC = '#1D1D1F', HOT = '#1D1D1F', MID = '#6E6E73', DEEP = '#D2D2D7', EDGE = '#E5E5EA';
  const GLASS = 'rgba(255,255,255,0.97)', TEXT = '#1D1D1F', DIM = '#6E6E73', CORAL = '#B3261E', NOTE = '#424245';
  const TINT = '#F5F5F7', LINE = '#D2D2D7', GRAY = '#424245';
  const SANS = 'system-ui, -apple-system, "Helvetica Neue", sans-serif', MONO = SANS;
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const rgba = (h, a) => `rgba(${hex(h).join(',')},${a})`;

  // A tail: { side: 'top'|'right'|'bottom'|'left', at, to: [x, y] } is a small triangle on that side, centred at `at`
  // along it and leaning toward the point `to`. Returns its three points in the order the outline walks them.
  function tailPts(x, y, w, h, c, tail) {
    const b = y + h, r = x + w;
    const SIDE = { top: [[x, y], [1, 0], [0, -1]], right: [[r, y], [0, 1], [1, 0]], bottom: [[r, b], [-1, 0], [0, 1]], left: [[x, b], [0, -1], [-1, 0]] }[tail?.side];
    if (!SIDE) return null;
    const [o, e, n] = SIDE, len = Math.abs(e[0]) ? w : h;
    const w0 = tail.w ?? 12, along = clamp(Math.abs(e[0]) ? (tail.at - o[0]) * e[0] : (tail.at - o[1]) * e[1], c + w0 / 2 + 2, len - c - w0 / 2 - 2);
    const base = [o[0] + e[0] * along, o[1] + e[1] * along];
    const to = tail.to ?? [base[0] + n[0] * 14, base[1] + n[1] * 14];
    const depth = clamp((to[0] - base[0]) * n[0] + (to[1] - base[1]) * n[1], 5, Math.min(tail.max ?? 18, 9));
    const shift = clamp((to[0] - base[0]) * e[0] + (to[1] - base[1]) * e[1], -w0, w0) * 0.4;
    const P = (a, d) => [base[0] + e[0] * a + n[0] * d, base[1] + e[1] * a + n[1] * d];
    return { side: tail.side, pts: [P(-w0 / 2, 0), P(shift, depth), P(w0 / 2, 0)] };
  }
  // The outline as points, clockwise from the top-left (square corners; for hit tests), with the tail if any.
  function stepped(x, y, w, h, c = 12, tail = null) {
    const t = tailPts(x, y, w, h, c, tail), side = (s) => (t && t.side === s ? t.pts : []);
    return [[x, y], ...side('top'), [x + w, y], ...side('right'), [x + w, y + h], ...side('bottom'), [x, y + h], ...side('left')];
  }
  // A rounded rectangle (radius c) with an optional small triangular tail.
  function steppedPath(x, y, w, h, c = 12, tail = null) {
    const rad = clamp(c, 0, Math.min(w, h) / 2), r = x + w, b = y + h, p = new Path2D(), t = tailPts(x, y, w, h, rad, tail);
    const side = (s) => { if (t && t.side === s) t.pts.forEach((q) => p.lineTo(q[0], q[1])); };
    p.moveTo(x + rad, y); side('top');
    p.arcTo(r, y, r, b, rad); side('right');
    p.arcTo(r, b, x, b, rad); side('bottom');
    p.arcTo(x, b, x, y, rad); side('left');
    p.arcTo(x, y, r, y, rad); p.closePath();
    return p;
  }
  // Old pixel-step sizes to the card radii: 12 px cards, 8 px controls, 4 px small marks.
  const radius = (c) => (c == null || c >= 8 ? 12 : c >= 4 ? 8 : 4);

  // A white card with a 1 px hairline. Flat: no shadow, no glow.
  function chrome(c, x, y, w, h, o = {}) {
    const path = o.path || steppedPath(x, y, w, h, radius(o.corner), o.tail);
    c.save();
    c.fillStyle = GLASS; c.fill(path);
    c.strokeStyle = o.edge && o.edge !== ACC ? o.edge : LINE; c.lineWidth = 1; c.stroke(path);
    c.restore();
  }

  const meas = document.createElement('canvas').getContext('2d');
  const textW = (s, font) => { meas.font = font; return meas.measureText(String(s ?? '')).width; };
  // Words typing themselves in; the last couple land in ink. Returns the full width.
  function typed(c, str, x, y, font, color, u = 1, o = {}) {
    str = String(str ?? '');
    c.save(); c.font = R.rtlFont ? R.rtlFont(str, font) : font; c.textBaseline = o.baseline || 'middle'; c.textAlign = 'left';
    const full = c.measureText(str).width, x0 = o.anchor === 'middle' ? x - full / 2 : o.anchor === 'end' ? x - full : x;
    const n = Math.floor(str.length * clamp(u, 0, 1));
    if (n >= str.length) { c.fillStyle = color; c.fillText(str, x0, y); }
    else if (n > 0) { const head = str.slice(0, Math.max(0, n - 2)); c.fillStyle = color; c.fillText(head, x0, y); c.fillStyle = TEXT; c.fillText(str.slice(head.length, n), x0 + c.measureText(head).width, y); }
    c.restore();
    return full;
  }
  // Lines of at most w px (a word wider than a line is broken); past max rows the last one ends in an ellipsis.
  function wrapRows(str, w, font, max = Infinity) {
    meas.font = font;
    const fits = (t) => meas.measureText(t).width <= w, rows = [];
    for (const para of String(str ?? '').split('\n')) {
      let row = '';
      for (let wd of para.split(/\s+/).filter(Boolean)) {
        const tr = row ? `${row} ${wd}` : wd;
        if (fits(tr)) { row = tr; continue; }
        if (row) { rows.push(row); row = ''; }
        while (!fits(wd)) { let k = wd.length - 1; while (k > 1 && !fits(wd.slice(0, k))) k--; rows.push(wd.slice(0, k)); wd = wd.slice(k); }
        row = wd;
      }
      rows.push(row);
    }
    if (rows.length > max) {
      const rest = rows.splice(max), full = `${rows[max - 1]} ${rest.join(' ')}`;
      let last = full;
      while (last && !fits(`${last}…`)) last = last.slice(0, -1);
      // End on a whole word when one is close, rather than mid-word.
      const sp = last.lastIndexOf(' ');
      if (full[last.length] !== ' ' && sp > last.length * 0.6) last = last.slice(0, sp);
      rows[max - 1] = `${last.trimEnd()}…`;
    }
    return rows;
  }
  // A hand-drawn ring: a slightly wobbly circle that overshoots where it closes, the same each time for one seed.
  const ringPts = (cx, cy, r, seed = 0) => Array.from({ length: 34 }, (_, i) => {
    const a = -2.2 + (i / 30) * Math.PI * 2, k = 1 + 0.06 * Math.sin(i * 1.7 + seed) + (i > 28 ? 0.08 : 0);
    return [cx + Math.cos(a) * r * k, cy + Math.sin(a) * r * k];
  });
  // The pen's stroke: a thin white halo under it so it reads on dark and light apps, then the ink. Drawn up to u of its length.
  function pen(c, pts, color, w = 2.2, u = 1) {
    const n = Math.max(2, Math.ceil(pts.length * clamp(u, 0, 1)));
    if (u <= 0) return;
    const path = new Path2D(); pts.slice(0, n).forEach((q, i) => (i ? path.lineTo(q[0], q[1]) : path.moveTo(q[0], q[1])));
    c.save(); c.lineCap = 'round'; c.lineJoin = 'round';
    c.strokeStyle = 'rgba(255,255,255,0.9)'; c.lineWidth = w + 3; c.stroke(path);
    c.strokeStyle = color; c.lineWidth = w; c.stroke(path);
    c.restore();
  }

  // A button like the drawings' chips (ink.js): filled is ink with white text, otherwise white with a hairline and ink
  // text. focus adds an ink ring, so the keyboard's choice shows; down nudges it down a pixel.
  const CHIP_F = `500 12px ${SANS}`;
  const chipW = (label) => Math.round(textW(label, CHIP_F) + 22);
  function chip(c, x, y, w, h, label, o = {}) {
    c.save();
    if (o.focus) { c.strokeStyle = TEXT; c.lineWidth = 2; c.stroke(steppedPath(x - 3, y - 3, w + 6, h + 6, 10)); }
    if (o.down) c.translate(0, 1);
    const face = steppedPath(x, y, w, h, 8);
    if (o.filled) { c.fillStyle = o.hover ? '#424245' : TEXT; c.fill(face); }
    else { c.fillStyle = o.hover ? TINT : '#FFFFFF'; c.fill(face); c.strokeStyle = LINE; c.lineWidth = 1; c.stroke(face); }
    c.font = CHIP_F; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = o.filled ? '#FFFFFF' : TEXT;
    c.fillText(String(label ?? ''), x + w / 2, y + h / 2 + 0.5);
    c.restore();
  }

  R.glass = { ACC, HOT, MID, DEEP, EDGE, GLASS, TEXT, DIM, CORAL, NOTE, TINT, LINE, GRAY, MONO, SANS, radius, rgba, stepped, steppedPath, chrome, textW, typed, wrapRows, ringPts, pen, chip, chipW, CHIP_H: 23 };
})();
