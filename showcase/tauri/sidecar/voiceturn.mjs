// The voice side of a turn (W5 voice contract 2 and 3), out of sidekick.mjs so it is tested by behavior
// (test/voiceturn.test.mjs): what the owner really heard of a reply when he talked over it, the filler when no answer
// has started, and words added while Hydra thinks.
import { INPUT_PREFIX } from './relay.mjs';
import { spokenText } from './sysvoice.mjs';

export const FILLER_MS = 1100;
// ponytail: a fixed speaking rate (characters a second) turns played time into heard text; per-sentence play reports
// from the voice helper would be exact.
export const CHARS_PER_SEC = 14;

/**
 * The reply being spoken. start(id) per reply; line(text) for each sentence handed to the voice (cue-tag-only lines
 * make no audio and are left out); audio(msg) for each speech chunk ({ id, pcm base64 16-bit, rate, filler });
 * finished() when the helper said it all; interrupted() at a barge-in: the whole sentences he heard, '' if none.
 */
export function createSpokenTrack({ now = Date.now, cps = CHARS_PER_SEC } = {}) {
  let cur = null;
  return {
    start(id) { cur = { id, said: [], first: null, filler: 0, secs: 0, finished: false }; },
    line(t) { if (cur && spokenText(t)) cur.said.push(spokenText(t)); },
    audio(msg) {
      if (!cur || msg?.id !== cur.id || !msg.pcm) return;
      const secs = Buffer.byteLength(String(msg.pcm), 'base64') / 2 / (Number(msg.rate) || 24_000);
      cur.first ??= now();
      if (msg.filler) cur.filler += secs; else cur.secs += secs;
    },
    finished() { if (cur) cur.finished = true; },
    get id() { return cur?.id ?? null; },
    interrupted() {
      const s = cur;
      cur = null;
      if (!s || s.finished || s.first == null || !s.secs) return '';
      // Played so far: from the first chunk, the filler first, never more than was handed on.
      const heard = Math.min(Math.max(0, (now() - s.first) / 1000 - s.filler), s.secs);
      const out = [];
      let used = 0;
      for (const line of s.said) {
        used += line.length / cps;
        if (used > heard) break;
        out.push(line);
      }
      return out.join(' ').slice(0, 1000);
    },
  };
}

/** The filler ("One sec.") after ms when no answer has started: only while live() and never while muted(). cancel(). */
export function startFiller({ voice, ms = FILLER_MS, live, muted, setTimer = setTimeout, clearTimer = clearTimeout }) {
  if (!voice) return () => {};
  let t = setTimer(() => { t = null; if (live() && !muted()) voice.beat(); }, ms);
  return () => { if (t) clearTimer(t); t = null; };
}

/** Words added while Hydra thinks: into the running session ('turn'), else as the next request ('next'); false when
 *  nothing runs (they are a new request then). */
export function addOnTo(text, { busy, addInput, enqueue }) {
  if (!busy) return false;
  if (addInput?.(`${INPUT_PREFIX}${text}`)) return 'turn';
  enqueue(text, { byVoice: true });
  return 'next';
}

/** Words added into the session that its run ended before answering (agent.unanswered(): max turns, an error, Stop),
 *  named aloud and on screen, never dropped (R11e-6). '' when there are none. */
export function unansweredNote(list) {
  const said = (Array.isArray(list) ? list : []).map((t) => String(t)).map((t) => (t.startsWith(INPUT_PREFIX) ? t.slice(INPUT_PREFIX.length) : t).trim()).filter(Boolean);
  return said.length ? `\n(I didn't get to what you added: ${said.map((t) => `"${t}"`).join(', ')}. Say it again.)` : '';
}
