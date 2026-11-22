// The voice side of a turn (W5 voice contract 2 and 3), out of sidekick.mjs so it is tested by behavior
// (test/voiceturn.test.mjs): what the owner really heard of a reply when he talked over it, the filler when no answer
// has started, and words added while Hydra thinks.
import { INPUT_PREFIX } from './relay.mjs';
import { spokenText } from './sysvoice.mjs';
import { PROGRESS, pickFiller } from './speaker.mjs';

export const FILLER_MS = 1100;
// A progress line after this long with nothing new (no model text, no audio still playing): every 5 to 6 s (E4).
export const PROGRESS_MS = 5500;
// ponytail: a fixed speaking rate (characters a second) turns played time into heard text; per-sentence play reports
// from the voice helper would be exact.
export const CHARS_PER_SEC = 14;

/** How long a speech chunk ({ pcm: base64 16-bit mono, rate }) plays, in seconds. */
export const pcmSecs = (msg) => Buffer.byteLength(String(msg?.pcm ?? ''), 'base64') / 2 / (Number(msg?.rate) || 24_000);

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
      const secs = pcmSecs(msg);
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

/**
 * The opener and the progress lines of a spoken turn (owner: "it's still not saying phrases like "still checking"
 * "almost there""). The opener ("Let me check.", voice.beat()) after ms when nothing has come yet, as before; then each
 * time `every` passes with no new model text and no audio still playing while live(), one PROGRESS line
 * (voice.progress), never the same twice in a row, shown too (onLine). Nothing while muted() (the owner talking, the
 * voice muted) or waiting() (an Allow ask: the ask speaks instead). touch(secs) on each text delta (0) and each chunk of
 * audio (its length); stop() when the answer starts or the turn ends.
 */
export function startProgress({ voice, live, muted = () => false, waiting = () => false, onLine = () => {}, ms = FILLER_MS, every = PROGRESS_MS, lines = PROGRESS,
  random = Math.random, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  if (!voice) return { touch() {}, stop() {} };
  let t = null, stopped = false, opened = false, quietFrom = now(), last = null;
  const arm = (at) => { if (t) clearTimer(t); t = stopped ? null : setTimer(fire, Math.max(0, at - now())); t?.unref?.(); };
  const stop = () => { stopped = true; if (t) clearTimer(t); t = null; };
  function fire() {
    t = null;
    if (stopped) return;
    if (!live()) return stop();
    const due = quietFrom + (opened ? every : ms);
    if (now() < due) return arm(due); // audio queued since: it is still playing
    const hush = muted() || waiting();
    if (!opened) { opened = true; if (!hush) voice.beat(); }
    else if (!hush) {
      const line = pickFiller(last, lines, random);
      if (!voice.progress?.(line)) return stop();
      last = line; onLine(line);
    }
    quietFrom = now(); arm(quietFrom + every);
  }
  arm(quietFrom + ms);
  return {
    touch(secs = 0) {
      if (stopped) return;
      opened = true; // something came: no opener after it
      quietFrom = Math.max(quietFrom, now()) + Math.max(0, secs) * 1000;
      arm(quietFrom + every);
    },
    stop,
  };
}

/** What a wake does (build 4 E4; owner: "when I wake hydra up from sleep it should go into listenting for my commands").
 *  Every wake opens a take at once and says no greeting (it delayed the take, and the mic heard it): the wake chime
 *  and a silent take (via 'wake') for a clap, the orb, the web, the panel or the tray. A phrase wake's take is already
 *  open in the voice helper, with its own listen chime; a talk wake is a take. The orb's wake burst (overlay and web)
 *  is for a double clap or the key phrase. */
export function wakeActions(why) {
  const own = why === 'phrase' || why === 'talk';
  return { cue: !own, listen: !own, woke: why === 'clap' || why === 'phrase' };
}

/** The soft pending sound (the voice helper's loop) and the orb's pending look (E4): a spoken turn at work, from its
 *  start until its answer is said (a tool after it starts again), never while the owner talks or a yes/no waits. */
export const pendingWanted = ({ voice, busy, answerSaid, listening, asking }) => !!voice && !!busy && !answerSaid && !listening && !asking;

/** Whether a take that starts while Hydra works adds on (owner: "speech added while Hydra thinks is added onto the
 *  prompt, never cancelled"): every take, whatever opened it (the phrase, a clap, the talk keys, barge-in). */
export const whileBusy = ({ busy }) => (busy ? 'add_on' : 'new');

// ---- Allow asks in a voice turn (owner: "sometimes it cancels and doesnt warn me or do anything") ----
export const ASK_DEADLINE_MS = 60_000;
// A clear yes or no: every word from its side's words, one strong one among them, nothing from the other side.
const YES_STRONG = new Set(['yes', 'yeah', 'yea', 'yep', 'yup', 'sure', 'ok', 'okay', 'alright', 'allow', 'absolutely', 'definitely', 'course', 'ahead']);
const YES_WORDS = new Set([...YES_STRONG, 'go', 'do', 'it', 'please', 'of', 'fine', 'thing', 'for', 'right', 'all', 'that', 'thanks', 'thank', 'you', 'hydra', 'um', 'uh', 'oh', 'well']);
const NO_STRONG = new Set(['no', 'nope', 'nah', "don't", 'dont', 'not', 'skip', 'cancel', 'never', 'stop']);
const NO_WORDS = new Set([...NO_STRONG, 'do', 'it', 'allow', 'now', 'thanks', 'thank', 'you', 'mind', 'leave', 'way', 'please', 'hydra', 'um', 'uh', 'oh', 'well', 'that']);
/** A take's words as the answer to a waiting yes/no: 'yes', 'no', or null when they aren't a clear one (then they're
 *  words for the turn): "yeah, do it", "go ahead", "no thanks", "don't allow it". */
export function spokenAnswer(text) {
  const w = String(text ?? '').toLowerCase().replace(/[’]/g, "'").split(/[^\p{L}\p{N}']+/u).filter(Boolean);
  if (!w.length || w.length > 6) return null;
  const yes = (w.some((x) => YES_STRONG.has(x)) || w.join(' ') === 'do it') && w.every((x) => YES_WORDS.has(x)), no = w.some((x) => NO_STRONG.has(x)) && w.every((x) => NO_WORDS.has(x));
  return yes && !no ? 'yes' : no && !yes ? 'no' : null;
}
const VERBS = /^(open|search|fetch|bring|put|save|drop|change|forget|snooze|schedule|remove|replace|delete|list|install|quit|close|hide|minimize|run|read|send|type|move|copy|write|restore|overwrite|connect|start|use|remember)\b/i;
const short = (q) => String(q ?? '').trim().replace(/\bhttps?:\/\//g, '').replace(/\/(?=[?\s]|$)/g, '');
/** The question as Hydra says it: "Can I open ui.elevenlabs.io? Say yes or no." A long or many-line one points at the
 *  screen, where it's shown in full. */
export function spokenQuestion(q) {
  const s = short(q);
  if (!s || /\n/.test(s) || s.length > 140) return 'Can I go ahead? The details are on the screen. Say yes or no.';
  const asked = VERBS.test(s) ? `Can I ${s[0].toLowerCase()}${s.slice(1)}` : s;
  return `${asked}${/\?$/.test(asked) ? '' : '?'} Say yes or no.`;
}
const ING = { open: 'opening it', search: 'the search', fetch: 'fetching it', bring: 'bringing it forward', save: 'saving it', drop: 'dropping it', change: 'the change',
  forget: 'forgetting it', snooze: 'the snooze', schedule: 'scheduling it', remove: 'removing it', replace: 'replacing it', delete: 'deleting it', install: 'installing it',
  quit: 'quitting it', close: 'closing it', hide: 'hiding it', minimize: 'minimizing it', read: 'reading it', send: 'sending it', write: 'writing it', restore: 'restoring it' };
/** Said when a yes/no ask runs out: "I didn't hear a yes, so I skipped opening it." */
export function skippedLine(q) {
  const verb = VERBS.exec(short(q))?.[1]?.toLowerCase();
  return `I didn't hear a yes, so I skipped ${ING[verb] ?? 'that'}.`;
}
/**
 * One local ask's life (sidekick showAsk, the one function every local ask passes through): logged when shown ('ask')
 * and when done ('ask_done': yes, no, typed, cancelled or expired, never the typed words), a yes/no one said aloud in a
 * voice turn (voice.progress), and a yes/no one given up after deadlineMs: said ("I didn't hear a yes…") in a voice
 * turn, closed on screen (close()), and answered null (a no), so the turn never waits in silence. deadlineMs 0: none.
 */
export function trackAsk({ id, route, question, choices = false, voice = null, deadlineMs = ASK_DEADLINE_MS, log = () => {}, resolve, close = () => {},
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const t0 = now(), voiced = !!(choices && voice);
  let open = true, timer = null;
  log('ask', { id, route, ...(choices ? { yesno: true } : {}), ...(voiced ? { spoken: true } : {}) });
  if (voiced) voice.progress?.(spokenQuestion(question), 'ask');
  const done = (answer, how, by) => {
    if (!open) return false;
    open = false;
    if (timer) clearTimer(timer);
    log('ask_done', { id, route, answer: how, ms: now() - t0, ...(by ? { by } : {}) });
    resolve(answer);
    return true;
  };
  if (choices && deadlineMs > 0) {
    timer = setTimer(() => { if (!open) return; if (voiced) voice.progress?.(skippedLine(question), 'ask'); close(); done(null, 'expired'); }, deadlineMs);
    timer?.unref?.();
  }
  return {
    get open() { return open; },
    voiced,
    /** text: what the screen sent ('yes' for the first choice, null for the rest or a cancel); by: 'voice' when said. */
    answer(text, by) { return done(text, choices ? (text === 'yes' ? 'yes' : 'no') : text == null ? 'cancelled' : 'typed', by); },
    cancel() { return done(null, 'cancelled'); },
  };
}

/**
 * Why a turn ended without an answer, in one short line (owner: every turn that ends without an answer says why), or ''
 * when it answered. spoken: say it too (a voice turn; never after Stop or the sleep word, which mean silence).
 * how: 'stop' (Stop, Esc), 'sleep' (the sleep word, idle sleep), 'stall', 'error' (with message), 'max_turns', or 'end'.
 * answered: it said something, drew, launched an agent or a tool did what was asked.
 */
export function endNote({ how, answered = false, message = '', voice = false }) {
  const line = how === 'stop' ? 'Okay, stopping.'
    : how === 'sleep' ? "I stopped that because I'm going to sleep."
      : how === 'stall' || how === 'error' ? message
        : answered ? ''
          : how === 'max_turns' ? "I ran out of steps before I finished. Say keep going and I'll carry on."
            : "I didn't get an answer back that time. Ask me again?";
  return { line, spoken: !!(line && voice && how !== 'stop' && how !== 'sleep') };
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
