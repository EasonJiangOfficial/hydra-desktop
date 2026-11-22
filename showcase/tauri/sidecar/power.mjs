// Hydra's sleep and wake (owner: "the agent should go inactive after 5 mins of not talking to it, but if I clap 2 times it
// should reactivate"; "if I say a certain word if it's listening it'll turn itself off until i clap my hands again or
// manually activate it in the interface").
// - Awake: it listens for "Hey Hydra" (on-device) and answers. Five minutes without the owner talking or typing to it
//   puts it to sleep.
// - Asleep: nothing is sent to the cloud; the voice helper keeps the on-device double-clap detector and the on-device
//   key phrase listening running (voice/clap.swift, W5 contract 4: "Yes, phrase wakes it"). A double clap, the key
//   phrase (its take goes on at once), a click on the orb, the panel's Wake button, the web app's wake(), or talking
//   with the talk keys wakes it.
// - The sleep word (default "Hydra, sleep"; a setting) puts it to sleep at once, from the wake listening or a take.

export const SLEEP_AFTER_MS = 5 * 60_000;
export const DEFAULT_SLEEP_WORD = 'Hydra, sleep';

const words = (t) => String(t ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/'/g, '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
function edits(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/** The sleep word's words, in order, anywhere in what was said (the same rule as SleepWord in voice/main.swift). */
export function heardSleepWord(text, phrase = DEFAULT_SLEEP_WORD) {
  const want = words(phrase).length ? words(phrase) : words(DEFAULT_SLEEP_WORD), got = words(text);
  for (let i = 0; i + want.length <= got.length; i++) {
    if (want.every((w, k) => got[i + k] === w || (w.length >= 5 && edits(got[i + k], w) <= 1))) return true;
  }
  return false;
}

/** A sleep word to save: 1 to 4 words of letters, or null for the default. */
export function cleanSleepWord(raw) {
  const t = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!t) return { ok: true, phrase: '' };
  const w = words(t);
  if (w.length < 1 || w.length > 4 || t.length > 40) return { ok: false, why: '1 to 4 words.' };
  if (w.length === 1 && w[0].length < 5) return { ok: false, why: 'Too short to be heard reliably.' };
  return { ok: true, phrase: t };
}

/**
 * The state machine. onChange({ asleep, why }) runs on every change; the caller tells the voice helper and the screens.
 * talked(): the owner spoke or typed to it (wakes it if asleep, and restarts the 5 minutes).
 */
export function createPower({ onChange, now = () => Date.now(), setTimer = (f, ms) => setTimeout(f, ms), clearTimer = (h) => clearTimeout(h), sleepAfterMs = SLEEP_AFTER_MS } = {}) {
  let asleep = false, last = now(), timer = null;
  const arm = () => {
    if (timer) clearTimer(timer);
    timer = asleep ? null : setTimer(check, Math.max(1000, last + sleepAfterMs - now()));
    timer?.unref?.();
  };
  function check() {
    timer = null;
    if (asleep) return;
    if (now() - last >= sleepAfterMs) set(true, 'idle'); else arm();
  }
  function set(on, why) {
    if (on === asleep) { if (!on) { last = now(); arm(); } return false; }
    asleep = on;
    if (!on) last = now();
    arm();
    onChange?.({ asleep, why });
    return true;
  }
  arm();
  return {
    get asleep() { return asleep; },
    sleep: (why = 'asked') => set(true, why),
    wake: (why = 'asked') => set(false, why),
    talked() { last = now(); if (asleep) set(false, 'talk'); else arm(); },
    /** Something is going on (a reply running, speech playing): the 5 minutes count from when it ends. */
    busy() { if (!asleep) { last = now(); arm(); } },
    stop() { if (timer) clearTimer(timer); timer = null; },
  };
}
