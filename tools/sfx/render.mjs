#!/usr/bin/env node
// Renders Hydra Desktop's interface sounds to showcase/roamies/sounds/*.wav (48 kHz, 24-bit, stereo).
// Plain Node, no dependencies. Every sound sits in one key family, an F major ninth (F A C E G):
// rising figures for wake and done, falling ones for sleep and error.
// Timbres: soft FM bell, glass (quiet inharmonic partials), felt mallet. Soft attacks, exponential
// decays, a gentle low-pass, a short generated room, then loudness set to TARGET LUFS (BS.1770 gated).
// Run: node tools/sfx/render.mjs   (prints each sound's length, integrated loudness and sample peak)
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SR = 48000;
const TARGET = -22; // LUFS, integrated, per sound
const PEAK_MAX = -4; // dBFS sample peak ceiling (keeps true peak under -3 dBTP)
const OUT = join(dirname(fileURLToPath(import.meta.url)), '../../showcase/roamies/sounds');

// Notes of the key family.
const N = { F4: 349.23, A4: 440, C5: 523.25, E5: 659.26, F5: 698.46, G5: 783.99, A5: 880, C6: 1046.5, E6: 1318.51, F6: 1396.91, G6: 1567.98 };

// Seeded noise, so every render is identical.
let seed = 0x9e3779b9;
const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 2 ** 32 * 2 - 1; };

// Soft raised-cosine attack, then exponential decay with time constant tau (s).
const env = (t, attack, tau) => (t < 0 ? 0 : t < attack ? 0.5 - 0.5 * Math.cos((Math.PI * t) / attack) : Math.exp(-(t - attack) / tau));

// A voice adds into a stereo buffer {L, R} at time t0 with a constant-power pan (-1..1).
function add(buf, t0, gain, pan, sample, dur) {
  const a = ((pan + 1) * Math.PI) / 4, gl = Math.cos(a) * gain, gr = Math.sin(a) * gain;
  const i0 = Math.round(t0 * SR), n = Math.min(Math.round(dur * SR), buf.L.length - i0);
  for (let i = 0; i < n; i++) { const v = sample(i / SR); buf.L[i0 + i] += v * gl; buf.R[i0 + i] += v * gr; }
}

// Glass: a sine fundamental with quiet inharmonic partials that die faster than it does.
const glass = (f, { attack = 0.004, tau = 0.32 } = {}) => {
  const P = [[1, 1, 1], [2.76, 0.09, 0.35], [5.4, 0.025, 0.18], [8.93, 0.008, 0.1]];
  return (t) => { let s = 0; for (const [r, a, k] of P) if (f * r < 9000) s += a * Math.sin(2 * Math.PI * f * r * t) * env(t, attack, tau * k); return s; };
};
// Soft FM bell: a 1:1.4 modulator whose index falls away in the first ~60 ms, so only the strike is bright.
const bell = (f, { attack = 0.005, tau = 0.45, index = 1.1 } = {}) => (t) => {
  const I = index * Math.exp(-t / 0.06);
  return env(t, attack, tau) * Math.sin(2 * Math.PI * f * t + I * Math.sin(2 * Math.PI * f * 1.4 * t)) + 0.18 * env(t, attack, tau * 0.6) * Math.sin(4 * Math.PI * f * t);
};
// Felt mallet: round fundamental, a little second and third harmonic, slower attack, short decay.
const felt = (f, { attack = 0.007, tau = 0.16 } = {}) => (t) =>
  env(t, attack, tau) * (Math.sin(2 * Math.PI * f * t) + 0.22 * Math.sin(4 * Math.PI * f * t) * Math.exp(-t / 0.05) + 0.05 * Math.sin(6 * Math.PI * f * t) * Math.exp(-t / 0.03));
// Shaped noise burst for the shutter (filtered afterwards).
const puff = ({ attack = 0.002, tau = 0.012 } = {}) => (t) => env(t, attack, tau) * rnd();

// RBJ biquads.
function biquad(x, type, f0, q = 0.707) {
  const w = (2 * Math.PI * f0) / SR, c = Math.cos(w), al = Math.sin(w) / (2 * q);
  let b0, b1, b2;
  if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; } else if (type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; } else { b0 = al; b1 = 0; b2 = -al; } // bp
  const a0 = 1 + al, a1 = -2 * c, a2 = 1 - al, y = new Float64Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) { const v = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0; x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v; }
  return y;
}
const each = (buf, fn) => ({ L: fn(buf.L), R: fn(buf.R) });

// In-place radix-2 FFT (re, im), inverse when inv.
function fft(re, im, inv) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let b = n >> 1; for (; j & b; b >>= 1) j ^= b; j ^= b; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inv ? 2 : -2) * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2, tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
  if (inv) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}
function convolve(x, h, len) {
  let n = 1; while (n < x.length + h.length) n <<= 1;
  const ar = new Float64Array(n), ai = new Float64Array(n), br = new Float64Array(n), bi = new Float64Array(n);
  ar.set(x); br.set(h); fft(ar, ai, false); fft(br, bi, false);
  for (let i = 0; i < n; i++) { const r = ar[i] * br[i] - ai[i] * bi[i]; ai[i] = ar[i] * bi[i] + ai[i] * br[i]; ar[i] = r; }
  fft(ar, ai, true);
  return ar.slice(0, len);
}

// A small, soft room: 12 ms pre-delay, decorrelated noise per side decaying to -60 dB in RT seconds,
// darkened as it decays (a low-pass that closes from 6 kHz to 2 kHz), unit energy.
function roomIR(rt = 0.55) {
  const n = Math.round(rt * SR), pre = Math.round(0.012 * SR), out = {};
  for (const side of ['L', 'R']) {
    const h = new Float64Array(pre + n);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / SR, fc = 6000 * Math.exp(-t / (rt / 1.1)) + 2000, k = 1 - Math.exp((-2 * Math.PI * fc) / SR);
      lp += k * (rnd() - lp);
      h[pre + i] = lp * Math.exp((-6.91 * t) / rt) * (t < 0.004 ? t / 0.004 : 1);
    }
    let e = 0; for (const v of h) e += v * v;
    const g = 1 / Math.sqrt(e); for (let i = 0; i < h.length; i++) h[i] *= g;
    out[side] = h;
  }
  return out;
}

// BS.1770 integrated loudness at 48 kHz (K-weighting, 400 ms blocks, 75% overlap, -70 / -10 gates).
function lufs(buf) {
  const kw = (x) => {
    const st = (x, b, a) => { const y = new Float64Array(x.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0; for (let i = 0; i < x.length; i++) { const v = b[0] * x[i] + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2; x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v; } return y; };
    return st(st(x, [1.53512485958697, -2.69169618940638, 1.19839281085285], [1, -1.69065929318241, 0.73248077421585]), [1, -2, 1], [1, -1.99004745483398, 0.99007225036621]);
  };
  const L = kw(buf.L), R = kw(buf.R), B = Math.round(0.4 * SR), hop = Math.round(0.1 * SR), z = [];
  for (let s = 0; s + B <= L.length; s += hop) { let e = 0; for (let i = s; i < s + B; i++) e += L[i] * L[i] + R[i] * R[i]; z.push(e / B); }
  const ld = (e) => -0.691 + 10 * Math.log10(e);
  let g = z.filter((e) => ld(e) > -70); if (!g.length) return -Infinity;
  const rel = ld(g.reduce((a, b) => a + b, 0) / g.length) - 10;
  g = g.filter((e) => ld(e) > rel);
  return ld(g.reduce((a, b) => a + b, 0) / g.length);
}

// Dry voices -> low-pass -> room -> DC block -> loudness -> fades so the first and last samples are 0.
function finish(dry, { len, lp = 7000, wet = 0.2, rt = 0.55, trim = 0, peak }) {
  const n = Math.round(len * SR);
  let x = each(dry, (c) => biquad(biquad(c, 'lp', lp, 0.6), 'lp', lp * 1.3, 0.6));
  const ir = roomIR(rt), dryG = Math.sqrt(1 - wet * wet);
  x = { L: convolve(x.L, ir.L, n).map((v, i) => dryG * (x.L[i] ?? 0) + wet * v), R: convolve(x.R, ir.R, n).map((v, i) => dryG * (x.R[i] ?? 0) + wet * v) };
  x = each(x, (c) => biquad(c, 'hp', 30, 0.6));
  let g = 10 ** ((TARGET + trim - lufs(x)) / 20), pk = 0;
  for (const c of [x.L, x.R]) for (const v of c) pk = Math.max(pk, Math.abs(v * g));
  if (peak !== undefined) g *= 10 ** ((peak - 20 * Math.log10(pk)) / 20); // a set sample peak, not the loudness target
  else if (20 * Math.log10(pk) > PEAK_MAX) g *= 10 ** ((PEAK_MAX - 20 * Math.log10(pk)) / 20);
  const fin = Math.round(0.001 * SR), fout = Math.round(Math.min(0.12, len * 0.3) * SR);
  for (const c of [x.L, x.R]) for (let i = 0; i < n; i++) {
    let w = g;
    if (i < fin) w *= 0.5 - 0.5 * Math.cos((Math.PI * i) / fin);
    if (i >= n - fout) w *= 0.5 + 0.5 * Math.cos((Math.PI * (i - (n - fout) + 1)) / fout);
    c[i] *= w;
  }
  x.L[0] = x.R[0] = x.L[n - 1] = x.R[n - 1] = 0;
  return x;
}

const blank = (len) => ({ L: new Float64Array(Math.round(len * SR)), R: new Float64Array(Math.round(len * SR)) });

// The palette. Each returns a finished stereo buffer.
const SOUNDS = {
  // Woken by a clap or a tap, just before "Hydra at your service, sir.": a rising F - C - E bell arpeggio.
  wake() {
    const b = blank(0.9);
    add(b, 0.0, 0.5, -0.2, bell(N.F5, { tau: 0.5 }), 0.9);
    add(b, 0.075, 0.42, 0.0, bell(N.C6, { tau: 0.45 }), 0.82);
    add(b, 0.15, 0.34, 0.2, bell(N.E6, { tau: 0.42 }), 0.75);
    return finish(b, { len: 0.9, lp: 6500, wet: 0.22, rt: 0.6 });
  },
  // Listening starts: two soft glass notes, a rising third (F - A).
  listen() {
    const b = blank(0.5);
    add(b, 0.0, 0.55, -0.1, glass(N.F5, { tau: 0.22 }), 0.5);
    add(b, 0.065, 0.5, 0.1, glass(N.A5, { tau: 0.24 }), 0.44);
    return finish(b, { len: 0.5, lp: 6500, wet: 0.18, rt: 0.45 });
  },
  // The owner finished talking (sent): the same third falling back (A - F), felt, rounder.
  heard() {
    const b = blank(0.48);
    add(b, 0.0, 0.5, 0.1, felt(N.A5, { tau: 0.13 }), 0.48);
    add(b, 0.06, 0.55, -0.1, felt(N.F5, { tau: 0.16 }), 0.42);
    return finish(b, { len: 0.48, lp: 5000, wet: 0.18, rt: 0.45 });
  },
  // A tool starts: one muted low felt tap. sfx.js plays it well under the others.
  working() {
    const b = blank(0.45);
    add(b, 0.0, 0.7, 0, felt(N.C5, { attack: 0.008, tau: 0.09 }), 0.45);
    return finish(b, { len: 0.45, lp: 3000, wet: 0.15, rt: 0.4 });
  },
  // A task finished: a rising fourth (C - F) with a quiet ninth (G) blooming over it.
  done() {
    const b = blank(0.85);
    add(b, 0.0, 0.5, -0.15, bell(N.C6, { tau: 0.4 }), 0.85);
    add(b, 0.09, 0.5, 0.1, bell(N.F6, { tau: 0.5 }), 0.76);
    add(b, 0.11, 0.12, 0.3, glass(N.G6, { attack: 0.008, tau: 0.35 }), 0.7);
    return finish(b, { len: 0.85, lp: 6500, wet: 0.22, rt: 0.6 });
  },
  // Something failed: soft and low, a falling minor third (C - A), felt, darker. Not an alarm.
  error() {
    const b = blank(0.6);
    add(b, 0.0, 0.5, -0.1, felt(N.C5, { attack: 0.008, tau: 0.17 }), 0.6);
    add(b, 0.1, 0.55, 0.1, felt(N.A4, { attack: 0.008, tau: 0.22 }), 0.5);
    return finish(b, { len: 0.6, lp: 2800, wet: 0.2, rt: 0.5 });
  },
  // A question needs the owner's yes: two gentle glass taps on an open fifth (C - G), the second lighter.
  attention() {
    const b = blank(0.7);
    for (const [t, g] of [[0, 0.5], [0.16, 0.36]]) {
      add(b, t, g, -0.12, glass(N.C6, { tau: 0.2 }), 0.7 - t);
      add(b, t + 0.004, g * 0.7, 0.12, glass(N.G6, { tau: 0.16 }), 0.7 - t);
    }
    return finish(b, { len: 0.7, lp: 6000, wet: 0.2, rt: 0.5 });
  },
  // Screenshot: a soft two-part shutter, band-limited noise with a small low body under it.
  shutter() {
    const b = blank(0.45);
    const tick = (t, g, f) => {
      const n = blank(0.08);
      add(n, 0, 1, 0, puff({ tau: 0.01 }), 0.08);
      const f1 = biquad(n.L, 'bp', f, 1.2);
      for (let i = 0; i < f1.length; i++) { b.L[Math.round(t * SR) + i] += f1[i] * g * 0.9; b.R[Math.round(t * SR) + i] += f1[i] * g; }
    };
    tick(0, 1, 2600);
    tick(0.07, 0.7, 2200);
    add(b, 0, 0.35, 0, felt(180, { attack: 0.003, tau: 0.03 }), 0.2);
    add(b, 0.07, 0.25, 0, felt(160, { attack: 0.003, tau: 0.03 }), 0.2);
    return finish(b, { len: 0.45, lp: 6500, wet: 0.14, rt: 0.35 });
  },
  // Going to sleep: a slow falling E - C - A - F, each softer, the last note held longest.
  sleep() {
    const b = blank(0.9);
    [[N.E6, 0, 0.42], [N.C6, 0.1, 0.38], [N.A5, 0.21, 0.34], [N.F5, 0.33, 0.34]].forEach(([f, t, g], i) =>
      add(b, t, g, 0.2 - i * 0.13, bell(f, { attack: 0.008, tau: 0.25 + i * 0.08, index: 0.7 }), 0.9 - t));
    return finish(b, { len: 0.9, lp: 5000, wet: 0.24, rt: 0.65 });
  },
  // Sound switched on: one small glass tick on C.
  toggle() {
    const b = blank(0.42);
    add(b, 0, 0.6, 0, glass(N.C6, { attack: 0.003, tau: 0.08 }), 0.42);
    return finish(b, { len: 0.42, lp: 7000, wet: 0.14, rt: 0.35 });
  },
};

// While Hydra works (thinking or running tools): a soft, low F - C dyad that swells and settles once every 2.4 s,
// looped seamlessly by the voice helper (cue.swift) under the spoken progress lines. Every partial has a whole number
// of cycles in the loop, and the swell is periodic, so the loop point has no click. No attack: it fades in and out.
// Peak about -24 dBFS (owner: quiet, premium, no harsh transients). The overlay orb pulses on the same 2.4 s.
const PENDING_S = 2.4;
function pending() {
  const n = Math.round(PENDING_S * SR), b = blank(PENDING_S);
  const cyc = (f) => Math.round(f * PENDING_S) / PENDING_S; // nearest frequency that loops cleanly
  const P = [[cyc(174.61), 0.5, -0.25], [cyc(261.63), 0.36, 0.25], [cyc(349.23), 0.16, 0], [cyc(523.25), 0.05, 0]];
  for (let i = 0; i < n; i++) {
    const t = i / SR, swell = 0.42 + 0.58 * (0.5 - 0.5 * Math.cos((2 * Math.PI * t) / PENDING_S)) ** 1.6;
    for (const [f, g, pan] of P) {
      const v = Math.sin(2 * Math.PI * f * t) * g * swell, a = ((pan + 1) * Math.PI) / 4;
      b.L[i] += v * Math.cos(a); b.R[i] += v * Math.sin(a);
    }
  }
  let pk = 0; for (const c of [b.L, b.R]) for (const v of c) pk = Math.max(pk, Math.abs(v));
  const g = 10 ** (-24 / 20) / pk;
  for (const c of [b.L, b.R]) for (let i = 0; i < n; i++) c[i] *= g;
  return b;
}
SOUNDS.pending = pending;

// Hydra starts (with the launch animation): one note per ring, low to high, an open F major (F - C - A) with a quiet
// ninth over it, blooming and settling in 1.2 s. Softer than the chimes: its sample peak is set to STARTUP_PEAK, not
// to the loudness target. Rendered last and reseeded, so its bytes are the same alone or in a full render, and no
// other sound changes.
const STARTUP_PEAK = -20; // dBFS
SOUNDS.startup = () => {
  seed = 0x9e3779b9;
  const b = blank(1.2);
  add(b, 0.0, 0.5, -0.2, bell(N.F4, { attack: 0.01, tau: 0.6, index: 0.6 }), 1.2);
  add(b, 0.09, 0.4, 0.0, bell(N.C5, { attack: 0.01, tau: 0.55, index: 0.6 }), 1.11);
  add(b, 0.18, 0.34, 0.2, bell(N.A5, { attack: 0.01, tau: 0.5, index: 0.6 }), 1.02);
  add(b, 0.2, 0.06, 0.0, glass(N.G6, { attack: 0.012, tau: 0.4 }), 1.0);
  return finish(b, { len: 1.2, lp: 5500, wet: 0.26, rt: 0.7, peak: STARTUP_PEAK });
};

function wav24(buf) {
  const n = buf.L.length, data = n * 2 * 3, b = Buffer.alloc(44 + data);
  b.write('RIFF', 0); b.writeUInt32LE(36 + data, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22); b.writeUInt32LE(SR, 24);
  b.writeUInt32LE(SR * 6, 28); b.writeUInt16LE(6, 32); b.writeUInt16LE(24, 34); b.write('data', 36); b.writeUInt32LE(data, 40);
  let o = 44;
  for (let i = 0; i < n; i++) for (const c of [buf.L, buf.R]) { b.writeIntLE(Math.max(-8388608, Math.min(8388607, Math.round(c[i] * 8388607))), o, 3); o += 3; }
  return b;
}

mkdirSync(OUT, { recursive: true });
const only = process.argv.slice(2);
for (const [name, make] of Object.entries(SOUNDS)) {
  if (only.length && !only.includes(name)) continue;
  const x = make();
  let pk = 0, dc = 0; for (const c of [x.L, x.R]) for (const v of c) { pk = Math.max(pk, Math.abs(v)); dc += v; }
  writeFileSync(join(OUT, `${name}.wav`), wav24(x));
  console.log(`${name.padEnd(10)} ${(x.L.length / SR * 1000).toFixed(0).padStart(4)} ms  ${lufs(x).toFixed(1)} LUFS  peak ${(20 * Math.log10(pk)).toFixed(1)} dBFS  dc ${(dc / (2 * x.L.length)).toExponential(1)}`);
}
