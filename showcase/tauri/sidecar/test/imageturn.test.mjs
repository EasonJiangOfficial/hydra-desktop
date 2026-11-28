// Audit 2026-11-26, 06 A3 (lane A4): every turn with a screen snap or an image failed at once with
// "Cannot access 'note' before initialization": prompt() read its `note` parameter in the image branch while a
// `const note` lower in the same try block shadowed it (temporal dead zone).
// This runs the real prompt() source from sidekick.mjs with every outside name stubbed (no model, no voice, no
// network, no Mac): a snap turn must log request_done and no error, and its note must reach the model.
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../sidekick.mjs', import.meta.url), 'utf8');
const start = src.indexOf('async function prompt(');
const end = src.indexOf('\n}\n', start);
assert.ok(start > 0 && end > start, 'prompt() found');
const fnSrc = src.slice(start, end + 2);
// No block of prompt() declares its own `note`: the parameter is read in sibling blocks, so a shadow there is the same
// trap one hoisted line away (the catch block's end note is `ending`, as in the try block).
assert.doesNotMatch(fnSrc, /\b(const|let|var)\s+note\b/, 'prompt() never shadows its note parameter');

// Any name the stubs don't set: a do-nothing function that is also every property of itself.
const nop = new Proxy(function () {}, {
  get: (t, k) => (k === 'then' ? undefined : k === Symbol.toPrimitive ? () => '' : k === Symbol.iterator ? function* () {} : nop),
  apply: () => nop,
});
const REAL = new Set(['Promise', 'JSON', 'String', 'Number', 'Boolean', 'Date', 'Math', 'Object', 'Array', 'Error', 'Set', 'Map',
  'Symbol', 'AbortController', 'console', 'process', 'undefined', 'RegExp', 'Infinity', 'NaN']);

function run({ image, note }) {
  const lines = [], sent = [], uis = [];
  const agent = {
    setSignal() {}, getMessages: () => [], unanswered: () => [],
    prompt: (content) => { sent.push(content); return 'run'; },
  };
  const stubs = {
    config: { model: 'test', provider: 'test' }, intro: null, retryInfo: null, agent, session: null,
    notePairing: () => null, pairingLife: new AbortController(), localRequestPair: { getStore: () => undefined },
    setTimeout: () => ({}), clearTimeout() {},
    foldFirst: () => null, readyAgent: async () => null, routeForTurn: () => null, nextMessageLearn() {}, skillsUsed: new Set(),
    VOICE_ON: () => false, speech: { stop() {} }, ownTurn: () => false, startProgress: () => ({ pause() {}, resume() {}, touch() {}, stop() {} }),
    stallWatch: () => ({ event() {}, stop() {} }), STALL_MS: 1000, nextTurn: () => 1, logLine: (k, o) => lines.push([k, o]),
    frontWithin: async () => null, whereNow: () => null, frontSoon: null, briefNote: () => null, interruptedAfter: '',
    takeQuizNote: () => '', ink: { listNote: () => '', endRequest() {} }, desk: { along: () => '', started() {} },
    stampNow: () => 'now', delegateNote: () => '', wantsAgent: () => false, foldImages: null,
    agentEvents: async function* () { yield { type: 'text_delta', text: 'A red button.' }; yield { type: 'turn_end', stopReason: 'end', usage: {} }; },
    unansweredNote: () => '', keepListening: () => false, autoListenOn: () => false, snoozeListenOn: () => false,
    learningOn: () => false, shouldLearn: () => false, yesNoOpen: new Map(), activity: { asked() {}, stopped: () => [], start() {}, end() {} },
    ui: (m) => uis.push(m), hydraKey: null, lastRequest: null, rateTarget: () => null, syncSession() {}, retryNext: null,
    // The real endNote (voiceturn.mjs) is not needed: an answered turn says nothing more.
    endNote: () => ({ line: '', spoken: false }), turnWords: '', busy: false, quiet: false,
  };
  const scope = new Proxy(stubs, {
    has: (t, k) => typeof k === 'string' && !REAL.has(k),
    get: (t, k) => (k === Symbol.unscopables ? undefined : k in t ? t[k] : nop),
    set: (t, k, v) => { t[k] = v; return true; },
  });
  // Sloppy-mode wrapper so `with` resolves prompt()'s outside names to the stubs; its own names stay its own.
  const prompt = new Function('scope', `with (scope) { return (${fnSrc}); }`)(scope);
  return { lines, sent, uis, done: prompt('what is this?', image, note) };
}

for (const note of ['', 'the red one']) {
  const image = { type: 'image', data: 'AAAA', mimeType: 'image/png' };
  const r = run({ image, note });
  await r.done; // a TDZ ReferenceError would reject here (before the fix) or land in the catch as an error line
  const errs = r.uis.filter((m) => m.e?.type === 'error');
  assert.deepEqual(errs, [], `no error for an image turn (note "${note}")`);
  assert.ok(r.lines.some(([k]) => k === 'request_done'), `request_done is logged (note "${note}")`);
  assert.equal(r.sent.length, 1, 'the model got one message');
  const [text, img] = r.sent[0];
  assert.equal(img, image, 'the snap rides along as an image');
  assert.match(text.text, note ? /area of the screen I marked\. the red one\)/ : /area of the screen I selected\.\)/, 'the note reaches the model');
}
// A plain text turn still works the same way.
{
  const r = run({ image: null, note: '' });
  await r.done;
  assert.ok(r.lines.some(([k]) => k === 'request_done'));
  assert.equal(typeof r.sent[0], 'string');
}
console.log('imageturn: ok');
