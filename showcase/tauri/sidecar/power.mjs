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
const EXPLICIT_WAKES = new Set(['web', 'orb', 'panel', 'asked', 'talk']);
export const isExplicitWake = (why) => EXPLICIT_WAKES.has(why);

// Numbers as they're said ("3 kill" is "three kill"), digits apart from letters: voice/phrase.swift's Spoken.words.
const SMALL = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const spell = (d) => (d.length <= 2 && +d <= 20 ? [SMALL[+d]] : d.length <= 2 && +d % 10 === 0 ? [TENS[+d / 10]] : [...d].map((c) => SMALL[+c]));
const words = (t) => String(t ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/'/g, '').split(/[^\p{L}\p{N}]+|(?<=\p{N})(?=\p{L})|(?<=\p{L})(?=\p{N})/u).filter(Boolean)
  .flatMap((w) => (/^\d+$/.test(w) ? spell(w) : [w]));
function edits(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

// Words around a strict sleep word that still leave it the whole take ("okay Hydra sleep now").
const AROUND = new Set(['ok', 'okay', 'hey', 'now', 'please', 'thanks', 'thank', 'you', 'so', 'um', 'uh', 'alright', 'right', 'then', 'go', 'to']);
/** The sleep word's words, in order, anywhere in what was said (as SleepWord in voice/main.swift, without its sound
 * keys): words of 5 letters or more may be one letter off, and a word may be heard as two ("good night"). strict (while a
 * turn runs): its exact words only, no letter off, and they are the whole take but for a few fillers ("okay", "now",
 * "please"), so a near miss or a sentence that merely has them in it ("I told hydra sleep is important") never ends the
 * work. */
export function heardSleepWord(text, phrase = DEFAULT_SLEEP_WORD, { strict = false } = {}) {
  const want = words(phrase).length ? words(phrase) : words(DEFAULT_SLEEP_WORD), got = words(text);
  const same = (h, w) => h === w || (!strict && w.length >= 5 && edits(h, w) <= 1);
  const at = (i) => {
    let j = i, k = 0;
    while (k < want.length) {
      if (j >= got.length) return -1;
      if (same(got[j], want[k])) { j++; k++; } else if (j + 1 < got.length && same(got[j] + got[j + 1], want[k])) { j += 2; k++; } else if (k + 1 < want.length && same(got[j], want[k] + want[k + 1])) { j++; k += 2; } else return -1;
    }
    return j;
  };
  const alone = (i, j) => [...got.slice(0, i), ...got.slice(j)].every((x) => AROUND.has(x));
  for (let i = 0; i < got.length; i++) { const j = at(i); if (j >= 0 && (!strict || alone(i, j))) return true; }
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
/** working() and taking() hold idle sleep while a turn, ask or active take is open. */
export function createPower({ onChange, working = () => false, taking = () => false, now = () => Date.now(), setTimer = (f, ms) => setTimeout(f, ms), clearTimer = (h) => clearTimeout(h), sleepAfterMs = SLEEP_AFTER_MS, confirmMs = 12_000 } = {}) {
  let asleep = false, last = now(), timer = null, provisional = false, wokeAt = null, confirmTimer = null;
  const clearConfirm = () => { if (confirmTimer) clearTimer(confirmTimer); confirmTimer = null; };
  const armConfirm = (delay = confirmMs) => {
    clearConfirm();
    if (!provisional || asleep) return;
    confirmTimer = setTimer(() => {
      confirmTimer = null;
      if (!provisional || asleep) return;
      if (working()) { armConfirm(); return; }
      const remaining = wokeAt + 30_000 - now();
      if (remaining > 0 && taking()) { armConfirm(Math.min(confirmMs, remaining)); return; }
      provisional = false;
      set(true, 'unconfirmed');
    }, delay);
    confirmTimer?.unref?.();
  };
  const arm = () => {
    if (timer) clearTimer(timer);
    timer = asleep ? null : setTimer(check, Math.max(1000, last + sleepAfterMs - now()));
    timer?.unref?.();
  };
  function check() {
    timer = null;
    if (asleep) return;
    if (working() || taking()) { last = now(); arm(); return; }
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
    sleep: (why = 'asked') => { provisional = false; clearConfirm(); return set(true, why); },
    wake: (why = 'asked') => {
      const at = now();
      const ok = set(false, why);
      // A deliberate wake needs no confirmation. A late clap or phrase can't make an awake session provisional.
      if (isExplicitWake(why)) { provisional = false; clearConfirm(); }
      else if (ok) { provisional = true; wokeAt = at; armConfirm(); }
      return ok;
    },
    /** The take ended. No words, and nothing else confirmed the wake: back to sleep, with no sound. */
    takeEnded() { if (provisional && !working()) { provisional = false; clearConfirm(); set(true, 'unconfirmed'); } },
    talked() { provisional = false; clearConfirm(); last = now(); if (asleep) set(false, 'talk'); else arm(); },
    /** Something is going on (a reply running, speech playing): the 5 minutes count from when it ends. */
    busy() { if (!asleep) { last = now(); arm(); } },
    stop() { if (timer) clearTimer(timer); timer = null; clearConfirm(); },
  };
}
