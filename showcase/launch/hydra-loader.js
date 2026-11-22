// The Hydra loading logo: the three rings draw in, then unroll into snakes and crawl away. A plain-JS port of the
// owner's own Hydra code (not Roamies'): src/lib/motion/snake-rings.ts and src/lib/motion/mount-hydra-loader.ts in the
// Hydra repo (main e0c1ec3), types stripped, logic unchanged. window.mountHydraLoader(el, opts) returns { destroy() }.
(() => {
/**
 * Hydra loading logo, pure geometry (no DOM, no clock). One loop:
 *   0.0-0.4 s  the three rings draw in (stroke reveal, ease-out), one after another
 *   0.4-0.8 s  hold, with a barely visible breath
 *   0.8-1.4 s  each ring opens at its point farthest from the centroid and unrolls into a snake:
 *              the head peels off and the body follows it, so the line keeps its length (2 pi r)
 *   1.4-2.2 s  the snakes slither away at constant speed and dissolve at the edge of the box
 *   2.2-2.4 s  empty
 * Each body is a filled outline around a spine. The spine runs along a fixed path per ring: once
 * around the ring (clockwise from the opening point), then a short turn outward and a sine path.
 * The body is the window [head - length, head] of that path, so the slither wave stays still in
 * the world and travels down the body, as a real snake moves.
 */



/* Mark geometry (design/logo/hydra-mark.svg). */
const R = 19.21;
const HALF = 2.5; // ring stroke 5
const CENTERS = [
  [34.74, 21.71],
  [21.71, 44.29],
  [47.76, 44.29],
];
const CENTROID = [(34.74 + 21.71 + 47.76) / 3, (21.71 + 44.29 + 44.29) / 3];
const LENGTH = 2 * Math.PI * R;

/* Box: 3x the mark, centred on the mark's own box (69.47 x 66). */
const MARK_W = 69.47;
const BOX = 3 * MARK_W;
const BOX_X = MARK_W / 2 - BOX / 2;
const BOX_Y = 33 - BOX / 2;
const VIEWBOX = `${BOX_X.toFixed(2)} ${BOX_Y.toFixed(2)} ${BOX.toFixed(2)} ${BOX.toFixed(2)}`;
const BOUNDS = { x: BOX_X, y: BOX_Y, size: BOX };
/** Snakes dissolve between these two radii around the centroid (an alpha mask that fits inside the box). */
const FADE = { inner: 72, outer: 99 };

/* Timeline, seconds. */
const LOOP = 2.4;
const PHASES = { drawEnd: 0.4, holdEnd: 0.8, unrollEnd: 1.4, crawlEnd: 2.2 };
const { drawEnd: DRAW_END, holdEnd: HOLD_END, unrollEnd: UNROLL_END, crawlEnd: CRAWL_END } = PHASES;
const FADE_START = 1.95;

/* Motion and body. Tune by eye. */
const SPEED = 150; // mark units per second while crawling
const STAGGER = 0.07; // draw-in offset between rings (a symmetric draw reads as a biohazard sign)
const BREATH = 0.012; // peak scale change in the hold
const TURN = 9; // radius of the turn from the ring onto the outward path
const WAVE_AMP = 2.4;
const WAVE_LEN = LENGTH / 4;
const HEAD = 3; // head half-width
const NOSE = 4.2; // length of the rounded nose
const NECK = 7; // head swell back down to the body width
const TAIL = 0.55 * LENGTH; // length of the tail taper

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const smooth = (x) => {
  const u = clamp01(x);
  return u * u * (3 - 2 * u);
};

/* ---- paths ---- */


const DS = 0.25;
const UNROLL_DIST = (SPEED * (UNROLL_END - HOLD_END)) / 2; // ease-in from rest to SPEED covers half
const EXIT_LEN = UNROLL_DIST + SPEED * (CRAWL_END - UNROLL_END) + 20;

function buildPath(c) {
  const ox = c[0] - CENTROID[0];
  const oy = c[1] - CENTROID[1];
  const on = Math.hypot(ox, oy);
  const out = [ox / on, oy / on];
  const p0 = [c[0] + R * out[0], c[1] + R * out[1]];
  // Clockwise on screen (y down) is increasing angle; its tangent is the outward vector turned +90 deg.
  const t0 = [-out[1], out[0]];

  // Dense raw exit: a quarter turn toward `out`, then a sine path along `out` whose amplitude eases in.
  const raw = [];
  const turnLen = (TURN * Math.PI) / 2;
  const step = 0.05;
  for (let s = 0; s <= turnLen; s += step) {
    const a = s / TURN;
    const k1 = TURN * Math.sin(a);
    const k2 = TURN * (1 - Math.cos(a));
    const dx = Math.cos(a) * t0[0] + Math.sin(a) * out[0];
    const dy = Math.cos(a) * t0[1] + Math.sin(a) * out[1];
    raw.push(p0[0] + k1 * t0[0] + k2 * out[0], p0[1] + k1 * t0[1] + k2 * out[1], dx, dy);
  }
  const bx = p0[0] + TURN * (t0[0] + out[0]);
  const by = p0[1] + TURN * (t0[1] + out[1]);
  const k = (2 * Math.PI) / WAVE_LEN;
  for (let x = step; x <= EXIT_LEN; x += step) {
    const r = x / WAVE_LEN;
    const ramp = smooth(r);
    const dramp = r < 1 ? (6 * r * (1 - r)) / WAVE_LEN : 0;
    const y = WAVE_AMP * ramp * Math.sin(k * x);
    const dy = WAVE_AMP * (dramp * Math.sin(k * x) + ramp * k * Math.cos(k * x));
    const tx = out[0] + dy * t0[0];
    const ty = out[1] + dy * t0[1];
    const tn = Math.hypot(tx, ty);
    raw.push(bx + x * out[0] + y * t0[0], by + x * out[1] + y * t0[1], tx / tn, ty / tn);
  }

  // Resample by arc length.
  const n = Math.ceil(EXIT_LEN / DS) + 1;
  const ex = new Float64Array(n);
  const ey = new Float64Array(n);
  const tx = new Float64Array(n);
  const ty = new Float64Array(n);
  [ex[0], ey[0], tx[0], ty[0]] = [raw[0], raw[1], raw[2], raw[3]];
  let acc = 0;
  let j = 0;
  for (let i = 4; i < raw.length && j < n - 1; i += 4) {
    const seg = Math.hypot(raw[i] - raw[i - 4], raw[i + 1] - raw[i - 3]);
    while (j < n - 1 && acc + seg >= (j + 1) * DS) {
      const f = ((j + 1) * DS - acc) / seg;
      j++;
      ex[j] = raw[i - 4] + f * (raw[i] - raw[i - 4]);
      ey[j] = raw[i - 3] + f * (raw[i + 1] - raw[i - 3]);
      const ux = raw[i - 2] + f * (raw[i + 2] - raw[i - 2]);
      const uy = raw[i - 1] + f * (raw[i + 3] - raw[i - 1]);
      const un = Math.hypot(ux, uy);
      tx[j] = ux / un;
      ty[j] = uy / un;
    }
    acc += seg;
  }
  for (j++; j < n; j++) [ex[j], ey[j], tx[j], ty[j]] = [ex[j - 1], ey[j - 1], tx[j - 1], ty[j - 1]];
  return { c, out, ex, ey, tx, ty };
}

const PATHS = CENTERS.map(buildPath);

/** Point and unit tangent at arc length s: s in [0, LENGTH] is the ring itself, beyond it the exit. */
function at(p, s) {
  if (s <= LENGTH) {
    const a = Math.atan2(p.out[1], p.out[0]) + Math.max(0, s) / R;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    return [p.c[0] + R * cos, p.c[1] + R * sin, -sin, cos];
  }
  const f = Math.min((s - LENGTH) / DS, p.ex.length - 1);
  const i = Math.min(Math.floor(f), p.ex.length - 2);
  const w = f - i;
  const ux = p.tx[i] + w * (p.tx[i + 1] - p.tx[i]);
  const uy = p.ty[i] + w * (p.ty[i + 1] - p.ty[i]);
  const un = Math.hypot(ux, uy);
  return [p.ex[i] + w * (p.ex[i + 1] - p.ex[i]), p.ey[i] + w * (p.ey[i + 1] - p.ey[i]), ux / un, uy / un];
}

/* ---- body ---- */

/** Snake half-width at arc length x from the tail: a long taper to a point, a slightly fuller round head. */
function profile(x) {
  const y = LENGTH - x; // distance from the nose tip
  if (y < NOSE) {
    const u = (NOSE - y) / NOSE;
    return HEAD * Math.sqrt(Math.max(0, 1 - u * u));
  }
  if (y < NOSE + NECK) return HEAD + (HALF - HEAD) * smooth((y - NOSE) / NECK);
  if (x < TAIL) return HALF * (1 - (1 - x / TAIL) ** 2.4);
  return HALF;
}


/** Head arc position along ring i's path at loop time t, body length shown, and how far it has become a snake. */
function motion(t, i) {
  if (t < DRAW_END) {
    const u = clamp01((t - i * STAGGER) / (DRAW_END - 2 * STAGGER));
    const head = LENGTH * (1 - (1 - u) ** 3);
    return { head, len: head, shape: 0, scale: 1, opacity: 1 };
  }
  if (t < HOLD_END) {
    const u = (t - DRAW_END) / (HOLD_END - DRAW_END);
    return { head: LENGTH, len: LENGTH, shape: 0, scale: 1 + BREATH * Math.sin(Math.PI * u) ** 2, opacity: 1 };
  }
  if (t < CRAWL_END) {
    const T = UNROLL_END - HOLD_END;
    // Velocity eases from rest to SPEED (smoothstep), so the hand-over to the constant crawl has no jolt.
    const u = (t - HOLD_END) / T;
    const dist = t < UNROLL_END ? SPEED * T * (u ** 3 - u ** 4 / 2) : UNROLL_DIST + SPEED * (t - UNROLL_END);
    return {
      head: LENGTH + dist,
      len: LENGTH,
      shape: smooth((t - HOLD_END) / 0.5),
      scale: 1,
      opacity: 1 - smooth((t - FADE_START) / (CRAWL_END - FADE_START)),
    };
  }
  return { head: 0, len: 0, shape: 0, scale: 1, opacity: 0 };
}

const f2 = (n) => (Math.round(n * 100) / 100).toString();


/** The three pieces at time t seconds (any t; it loops every LOOP seconds). Deterministic. */
function frame(t, opts = {}) {
  const n = opts.samples ?? 160;
  const tl = ((t % LOOP) + LOOP) % LOOP;
  const kind = tl < HOLD_END ? "ring" : "snake";
  return PATHS.map((p, ring) => {
    const m = motion(Number.isFinite(tl) ? tl : 0, ring);
    if (m.len <= 0 || m.opacity <= 0) return { kind, d: "", opacity: 0, spine: [], width: [] };
    const tail = m.head - m.len;
    const spine = [];
    const width = [];
    const left = [];
    const right = [];
    for (let i = 0; i <= n; i++) {
      const x = (m.len * (1 - Math.cos((Math.PI * i) / n))) / 2;
      const [px, py, tx, ty] = at(p, tail + x);
      const w = ((1 - m.shape) * HALF + m.shape * profile(x)) * m.scale;
      const sx = CENTROID[0] + (px - CENTROID[0]) * m.scale;
      const sy = CENTROID[1] + (py - CENTROID[1]) * m.scale;
      spine.push([sx, sy]);
      width.push(w);
      left.push(`${f2(sx - ty * w)} ${f2(sy + tx * w)}`);
      right.push(`${f2(sx + ty * w)} ${f2(sy - tx * w)}`);
    }
    right.reverse();
    return { kind, d: `M${left.join("L")}L${right.join("L")}Z`, opacity: m.opacity, spine, width };
  });
}

/* Framework-free mount of the Hydra loading logo. The React <HydraLoader> uses it, and Hydra Desktop
   (Tauri) can import it as is. requestAnimationFrame only, paused while the tab is hidden, the still
   mark under prefers-reduced-motion. */


const INK = "#1D1D1F";
const WHITE = "#FFFFFF";
let seq = 0;

function mountHydraLoader(el, opts = {}) {
  const size = opts.size ?? 64;
  const id = `hydra-loader-${++seq}`;
  const fill = opts.tone === "white" ? WHITE : INK;
  const [cx, cy] = CENTROID;

  el.innerHTML =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${VIEWBOX}" aria-hidden="true" focusable="false" style="display:block;overflow:hidden">` +
    `<defs><radialGradient id="${id}-g" gradientUnits="userSpaceOnUse" cx="${cx}" cy="${cy}" r="${FADE.outer}">` +
    `<stop offset="${(FADE.inner / FADE.outer).toFixed(3)}" stop-color="#fff"/><stop offset="1" stop-color="#000"/></radialGradient>` +
    `<mask id="${id}-m" maskUnits="userSpaceOnUse" x="-1000" y="-1000" width="2000" height="2000"><rect x="-1000" y="-1000" width="2000" height="2000" fill="url(#${id}-g)"/></mask></defs>` +
    `<g mask="url(#${id}-m)" fill="${fill}"><path/><path/><path/></g></svg>`;
  if (opts.label) {
    el.setAttribute("role", "status");
    const sr = document.createElement("span");
    sr.textContent = opts.label;
    sr.style.cssText = "position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0";
    el.appendChild(sr);
  }
  const paths = Array.from(el.querySelectorAll("path"));

  const draw = (t) =>
    frame(t).forEach((p, i) => {
      paths[i].setAttribute("d", p.d);
      paths[i].setAttribute("opacity", p.opacity.toFixed(3));
    });

  const reduce = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
  let raf = 0;
  let last = 0;
  let t = 0;

  const tick = (now) => {
    t = (t + Math.min(0.1, (now - last) / 1000)) % LOOP;
    last = now;
    draw(t);
    raf = requestAnimationFrame(tick);
  };
  const stop = () => {
    cancelAnimationFrame(raf);
    raf = 0;
  };
  const sync = () => {
    if (opts.at !== undefined) {
      el.dataset.state = "frozen";
      draw(opts.at);
    } else if (reduce?.matches) {
      stop();
      el.dataset.state = "still";
      draw(PHASES.drawEnd); // the drawn mark, before the breath
    } else if (document.hidden) {
      stop();
    } else if (!raf) {
      el.dataset.state = "live";
      last = performance.now();
      draw(t);
      raf = requestAnimationFrame(tick);
    }
  };

  sync();
  document.addEventListener("visibilitychange", sync);
  reduce?.addEventListener("change", sync);
  return {
    destroy() {
      stop();
      document.removeEventListener("visibilitychange", sync);
      reduce?.removeEventListener("change", sync);
      el.innerHTML = "";
      if (opts.label) el.removeAttribute("role");
      delete el.dataset.state;
    },
  };
}

  window.mountHydraLoader = mountHydraLoader;
})();
