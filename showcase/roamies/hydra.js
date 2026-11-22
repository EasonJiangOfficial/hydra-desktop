// The Hydra orb, the Hydra Agent's only look (DESIGN.md section 7 and 6.9): an open sphere of ink dots, not a solid
// ball. Ink #1D1D1F and grays on a translucent white disc; no glow, no gradient, no colour. It ripples with the owner's
// microphone level while he talks and with Hydra's voice while it speaks; at rest it barely breathes; asleep it is
// pale and still; under prefers-reduced-motion it holds still. Behaviour after Roamies' JARVIS globe (jarvis.js, by
// Ken Kai, AGPL-3.0); the look is Hydra's.
// Pure drawing: body() writes dots through the kit it's given. k.dot(x, y, r, shade) draws a round dot (cells, shade 0
// ink to 1 palest) where the page can; without it, k.put(x, y, level) writes LED cells (the notch lens, tests).
(() => {
  const R = window.Roamie;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const reducedMQ = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };

  // Points spread evenly over a sphere (golden spiral): few enough that it reads as open, not as a ball.
  const sphere = (n) => Array.from({ length: n }, (_, i) => {
    const y = 1 - (2 * (i + 0.5)) / n, r = Math.sqrt(1 - y * y), a = i * 2.39996;
    return [Math.cos(a) * r, y, Math.sin(a) * r];
  });
  const DOTS = { default: sphere(220), small: sphere(120) };

  R.hydra = {
    INK: '#1D1D1F', GRAY: '#6E6E73', PALE: '#A1A1A6', HAIR: '#E5E5EA',
    // 0..1: how much the surface moves. The real voice while speaking, the mic while listening, a breath otherwise.
    level(st) {
      if (st.asleep) return 0;
      if (st.mode === 'talk') return st.voice != null ? clamp(0.15 + st.voice * 0.95, 0, 1) : 0.4;
      if (st.mode === 'listen') return clamp(st.heard ?? 0.25, 0, 1);
      if (st.mode === 'think') return 0.12;
      return 0.04;
    },

    // The globe. st: { t, dt, mode, heard, voice, asleep }. cx, cy, rad in cells.
    body(k, cx, cy, rad, st) {
      const still = reducedMQ.matches;
      const t = still ? 0 : st.t, asleep = !!(st.asleep || R.asleep);
      const v = still ? 0 : this.level({ ...st, asleep });
      const spinRate = asleep ? 0 : st.mode === 'think' ? 0.9 : 0.18;
      st.spin = still ? 0 : (st.spin ?? 0) + spinRate * (st.dt ?? 0.016);
      const yaw = st.spin, pitch = -0.38;
      const cyw = Math.cos(yaw), syw = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
      const breath = asleep || still ? 1 : 1 + 0.012 * Math.sin(t * 1.3);
      const dots = rad < 9 ? DOTS.small : DOTS.default;
      for (const p of dots) {
        // A ripple runs over the surface; the voice (or the mic) raises it, pushing the dots outward.
        const band = Math.sin(p[1] * 6 - t * (st.mode === 'talk' ? 8 : 4)) * 0.6 + Math.sin(Math.atan2(p[2], p[0]) * 4 + t * 3) * 0.4;
        const r = rad * breath * (1 + v * 0.18 * band);
        let x = p[0] * cyw + p[2] * syw, z = -p[0] * syw + p[2] * cyw;
        const y = p[1] * cp - z * sp; z = p[1] * sp + z * cp;
        const px = cx + x * r, py = cy + y * r;
        // Near dots are ink and a little larger; far ones pale, so it reads as an open sphere seen through.
        const near = (z + 1) / 2;
        const shade = asleep ? 0.75 + 0.25 * (1 - near) : clamp(1 - near * 1.15, 0, 0.85);
        if (k.dot) k.dot(px, py, (0.16 + 0.14 * near) * Math.max(1, rad / 10), shade);
        else k.put(px, py, Math.max(1, Math.round((k.L - 1) * (1 - shade)) + (near > 0.8 && !asleep ? 1 : 0)));
      }
    },

    // Cursor form (a drawing holds it as its pointer): a small ring of dots round the body point, a dot at the tip.
    cursor(k, cx, cy, hx, hy, st) {
      const still = reducedMQ.matches, t = still ? 0 : st.t;
      const v = still ? 0 : this.level(st), r = 4.2 + v * 0.8;
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2 + (st.mode === 'think' && !still ? t * 1.5 : 0);
        if (k.dot) k.dot(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 0.32, 0); else k.put(cx + Math.cos(a) * r, cy + Math.sin(a) * r, k.L - 1);
      }
      if (k.dot) k.dot(hx, hy, 0.45, 0); else k.put(hx, hy, k.L);
    },
  };
})();
