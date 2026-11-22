// Hydra's interface sounds: ten short rendered chimes in one key (tools/sfx/render.mjs makes them, into
// sounds/), decoded once and played through Web Audio. Silent until the first click or key press.
// Callers still use the older names. The ones that mark something the owner cares about play a chime;
// every other name (hop, stomp, bonk, hype, blip, key, tick, pip, pop, poof, page, scribble, yawn, snore,
// the pointer-idle 'wake', ...) is silent on purpose.
(() => {
  const R = window.Roamie;
  const KEY = 'roamie-sound';
  const BASE = new URL('sounds/', document.currentScript?.src ?? location.href);
  // Caller name -> [file, gain]. working sits well under the rest: it marks a tool starting, often.
  const MAP = {
    hydra_wake: ['wake', 1], listen: ['listen', 1], heard: ['heard', 0.9], toolstart: ['working', 0.35],
    done: ['done', 1], error: ['error', 0.85], remind: ['attention', 1], shutter: ['shutter', 0.8],
    sleep: ['sleep', 1], toggle: ['toggle', 0.8],
  };
  // The shortest time between two plays of one file, so bursts never pile up.
  const GAP = { working: 0.3, done: 0.45, error: 0.45, attention: 0.6, wake: 1, sleep: 1 };
  const FILES = [...new Set(Object.values(MAP).map(([f]) => f))];
  let live = null, enabled = true, unlocked = false, volume = 1, synced = false;
  try { enabled = localStorage.getItem(KEY) !== 'off'; } catch {}
  const last = {}, buffers = {};

  const start = () => {
    if (!live) {
      const ac = new AudioContext(), out = ac.createGain();
      out.gain.value = volume; out.connect(ac.destination);
      live = { ac, out };
      for (const f of FILES) {
        fetch(new URL(`${f}.wav`, BASE)).then((r) => r.arrayBuffer()).then((b) => ac.decodeAudioData(b))
          .then((buf) => { buffers[f] = buf; }).catch(() => {});
      }
    }
    live.ac.resume(); unlocked = true;
  };
  if (window.ROAMIE_AUTOSOUND) start();
  addEventListener('pointerdown', start, { capture: true });
  addEventListener('keydown', start, { capture: true });

  R.sfx = {
    names: Object.keys(MAP),
    play(name) {
      const [file, gain] = MAP[name] ?? [];
      const buf = buffers[file];
      if (!buf || !enabled || !unlocked || !live || live.ac.state !== 'running') return;
      const now = live.ac.currentTime;
      if (now - (last[file] ?? -9) < (GAP[file] ?? 0.15)) return;
      last[file] = now;
      const src = live.ac.createBufferSource(), g = live.ac.createGain();
      src.buffer = buf; g.gain.value = gain;
      src.connect(g); g.connect(live.out); src.start(now + 0.005);
    },
    get volume() { return volume; },
    set volume(v) { volume = Number.isFinite(Number(v)) ? Math.max(0, Math.min(1, Number(v))) : 1; if (live) live.out.gain.value = volume; },
    get enabled() { return enabled; },
    // Switched on (not the first sync at start-up): one small tick says so.
    set enabled(v) {
      const on = !!v && !enabled && synced;
      enabled = !!v; synced = true;
      try { localStorage.setItem(KEY, enabled ? 'on' : 'off'); } catch {}
      if (on) R.sfx.play('toggle');
    },
    bindToggle(btn) {
      const sync = () => btn.setAttribute('aria-pressed', String(enabled));
      btn.addEventListener('click', () => { synced = true; R.sfx.enabled = !enabled; sync(); });
      sync();
    },
  };
})();
