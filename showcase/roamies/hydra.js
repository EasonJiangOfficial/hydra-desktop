// The Hydra orb, the Hydra Agent's only look (DESIGN.md section 7 and 6.9): an open sphere of ink dots, not a solid
// ball. Ink #1D1D1F and grays, nothing behind it (each dot a thin white rim, for dark wallpapers); no glow, no gradient, no colour. It ripples with the owner's
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
    // The shipped web orb (Phonon dust shell): listening ripples with the mic, pending is one orbiting band on the
    // 2.4 s pulse, talking pushes outward on Hydra's voice. Looks ease over 250 ms. Idle is ink on a white page, not a
    // pale gray. A wake (clap, phrase, orb, keys) does not pull the dots in and does not move the sphere: the same
    // shell goes to full ink and the dots grow, so it reads darker and denser in place. No colour, ever.
    body(k, cx, cy, rad, st) {
      const still = reducedMQ.matches, dt = st.dt ?? 0.016;
      const t = still ? 0 : st.t, asleep = !!(st.asleep || R.asleep);
      // e: 0 awake to 1 asleep, eased by the caller over 0.4 s (the shade and stillness follow it).
      const e = st.sleepE ?? (asleep ? 1 : 0), awake = 1 - e;
      const want = [st.mode === 'listen', st.mode === 'think', st.mode === 'talk'];
      st.mix = (st.mix ?? want.map(Number)).map((u, i) => (still ? +want[i] : clamp(u + (want[i] ? dt : -dt) / 0.25, 0, 1)));
      const [wL, wP, wT] = st.mix.map((u) => u * u * (3 - 2 * u) * awake);
      const wR = Math.max(0, awake - wL - wP - wT);
      const heard = still ? 0 : clamp(st.heard ?? 0.25, 0, 1);
      const voice = still ? 0 : st.voice != null ? clamp(st.voice, 0, 1) : 0.3;
      const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const pulse = still ? 0 : 0.5 - 0.5 * Math.cos((2 * Math.PI * (nowMs - (R.pendingAt ?? 0))) / 2400);
      // The wake burst (0..1 through 900 ms) and a short settle after a drag-drop (300 ms).
      const wokeU = R.wokeAt != null ? (nowMs - R.wokeAt) / 900 : 2, bk = wokeU >= 0 && wokeU < 1 ? 1 - wokeU : 0;
      const dropU = R.droppedAt != null ? (nowMs - R.droppedAt) / 300 : 2, drop = !still && dropU >= 0 && dropU < 1 ? Math.sin(Math.PI * dropU) : 0;
      // Full ink for the first ~600 ms of the burst, easing back over the last 300 ms.
      const inkU = Math.min(1, bk / 0.35), inkK = inkU * inkU * (3 - 2 * inkU);
      // Wake does not swell or shrink the shell. A drop still settles a little.
      const swell = 1 - (still ? 0 : 0.06 * drop);
      const spinRate = (0.18 + 0.32 * wP) * awake;
      st.spin = still ? 0 : (st.spin ?? 0) + spinRate * dt;
      const yaw = st.spin, pitch = -0.38;
      const cyw = Math.cos(yaw), syw = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
      const breath = still ? 1 : 1 + 0.012 * Math.sin(t * 1.3) * awake;
      const dots = rad < 9 ? DOTS.small : DOTS.default;
      for (const p of dots) {
        const lon = Math.atan2(p[2], p[0]);
        const ripple = Math.sin(p[1] * 6 - t * 4) * 0.6 + Math.sin(lon * 4 + t * 3) * 0.4;
        const syllable = Math.sin(p[1] * 6 - t * 8) * 0.6 + Math.sin(lon * 4 + t * 3) * 0.4;
        const orbit = Math.max(0, Math.cos(lon - t * 1.6)) ** 6; // the pending band, orbiting
        // No inward term. A negative ripple used to suck the shell toward the center on wake and while listening.
        const push = wR * 0.015 * Math.max(0, ripple)
          + wL * heard * 0.1 * Math.max(0, ripple)
          + wP * (0.02 + 0.06 * pulse) * orbit
          + wT * voice * (0.08 + 0.12 * Math.max(0, syllable));
        const r = rad * breath * swell * (1 + (still ? 0 : push));
        let x = p[0] * cyw + p[2] * syw, z = -p[0] * syw + p[2] * cyw;
        const y = p[1] * cp - z * sp; z = p[1] * sp + z * cp;
        const px = cx + x * r, py = cy + y * r;
        // Near dots are ink and a little larger; far ones pale, so it reads as an open sphere seen through.
        const near = (z + 1) / 2;
        // Asleep: pale gray. Pending: the band is a little darker; the wake burst takes every dot to full ink.
        // Idle stays dark enough to read on white (shade 0 is ink). Asleep stays pale. A wake takes every dot to ink.
        let shade = awake * clamp(0.34 - near * 0.55 - wP * orbit * 0.2 * pulse, 0, 0.34) + e * (0.8 + 0.18 * (1 - near));
        shade *= 1 - inkK;
        // Denser on wake: the dots grow. The sphere they sit on does not move.
        const dense = 1 + (still ? 0 : 0.7 * inkK);
        const dotR = Math.max((0.22 + 0.16 * near) * Math.max(1, rad / 10), 0.55 / (k.P ?? 2)) * dense;
        if (k.dot) k.dot(px, py, dotR, shade);
        else k.put(px, py, Math.max(1, Math.round((k.L - 1) * (1 - shade)) + (near > 0.8 && e < 0.5 ? 1 : 0)));
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
