// Desktop build 4 E1, the turn flow (owner: "it's still not saying phrases like "still checking" "almost there" also
// sometimes it cancels and doesnt warn me or do anything, when it's thinking and getting the result"), by behavior
// with fake clocks and fake voices, plus source checks for the wiring in sidekick.mjs:
// - C1: every take while Hydra works adds on; nothing but Stop and sleep ends a turn;
// - C2: an opener at 1.1 s, then a progress line each 5.5 s of quiet (E4 tuned it from 8 s), never twice the same,
//   never over the owner or an ask;
// - C3: an ask is logged, said aloud in a voice turn, answered by a spoken yes or no, and given up after 60 s, aloud;
// - C4: idle sleep never comes while a turn or an ask is open; C5: the sleep word is exact while a turn runs;
// - every turn that ends without an answer says why.
// C6 (the clap level while Hydra speaks with no echo reference) is in the voice helper's --test-clap.
// Run: npm test
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ASK_DEADLINE_MS, FILLER_MS, PROGRESS_MS, endNote, skippedLine, spokenAnswer, spokenQuestion, startProgress, trackAsk, whileBusy } from '../voiceturn.mjs';
import { FILLERS, PROGRESS, createSpeaker } from '../speaker.mjs';
import { createPower, heardSleepWord, SLEEP_AFTER_MS } from '../power.mjs';
import { oneYesNoAtATime } from '../tools.mjs';

const side = readFileSync(new URL('../sidekick.mjs', import.meta.url), 'utf8');
const panel = readFileSync(new URL('../../../panel/panel.js', import.meta.url), 'utf8');

// A fake clock whose timers fire as it moves on.
function fakeClock() {
  let t = 0, timers = [];
  const c = {
    now: () => t,
    setTimer: (f, ms) => { const h = { f, at: t + ms }; timers.push(h); return h; },
    clearTimer: (h) => { timers = timers.filter((x) => x !== h); },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const next = timers.filter((h) => h.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        t = next.at; timers = timers.filter((h) => h !== next); next.f();
      }
      t = end;
    },
    get pending() { return timers.length; },
  };
  return c;
}

// ---- C1: a take while Hydra works is an add-on, whatever opened it.
{
  for (const mode of ['wake', 'handsfree', 'hold', 'clap', 'keys', 'barge', '', undefined]) {
    assert.equal(whileBusy({ busy: true, mode }), 'add_on', `a ${mode || 'plain'} take while busy adds on`);
    assert.equal(whileBusy({ busy: false, mode }), 'new', `a ${mode || 'plain'} take with nothing running is a new request`);
  }
  assert.doesNotMatch(side, /interruptQuietly\('listening'\)/, 'a take never cancels the turn');
  assert.doesNotMatch(side, /interruptQuietly\('new request'\)/, 'nor does a request sent while it works');
  assert.deepEqual([...side.matchAll(/interruptQuietly\('(\w+)'\)/g)].map((m) => m[1]), ['sleep'], 'only sleep cancels quietly');
  assert.match(side, /if \(interrupt && busy && !image && addOn\(text\)\) return running;/, 'typed, clicked or spoken while busy: joins the turn');
  assert.match(side, /state === 'listening' && whileBusy\(\{ busy \}\) === 'add_on'\) \{ addOnTake = true; hush\(true\);/, 'Hydra holds its voice while the owner talks');
  assert.match(side, /m\.state === 'idle'\) \{ addOnTake = false; hush\(false\);/, 'a take that ends (heard nothing) clears the add-on and lets the voice go on');
}

// ---- C2: the opener, then progress lines.
{
  const c = fakeClock();
  const said = [], shown = [];
  let live = true, muted = false, waiting = false;
  const voice = { beat: () => { said.push('beat'); return true; }, progress: (l) => { said.push(l); return true; } };
  const p = startProgress({ voice, live: () => live, muted: () => muted, waiting: () => waiting, onLine: (l) => shown.push(l), random: () => 0, ...c });
  assert.equal(PROGRESS_MS, 5500, 'one every 5 to 6 s (E4)');
  c.advance(FILLER_MS - 1); assert.deepEqual(said, [], 'nothing before 1.1 s');
  c.advance(1); assert.deepEqual(said, ['beat'], 'the opener at 1.1 s');
  c.advance(PROGRESS_MS - 1); assert.equal(said.length, 1, 'not before 5.5 s of quiet');
  c.advance(1); assert.equal(said.length, 2, 'a progress line after 5.5 s more');
  assert.ok(PROGRESS.includes(said[1]), 'from the PROGRESS list');
  assert.deepEqual(shown, [said[1]], 'shown as the working line too');
  c.advance(PROGRESS_MS); assert.equal(said.length, 3);
  assert.notEqual(said[2], said[1], 'never the same twice in a row');
  for (let i = 0; i < 20; i++) c.advance(PROGRESS_MS);
  for (let i = 2; i < said.length; i++) assert.notEqual(said[i], said[i - 1], 'never the same twice in a row');
  // New model text resets the 8 s; audio still playing pushes it out by its length.
  const n = said.length;
  c.advance(PROGRESS_MS / 2); p.touch(); c.advance(PROGRESS_MS - 1);
  assert.equal(said.length, n, 'text came: the 8 s start again');
  p.touch(5); c.advance(PROGRESS_MS + 4000);
  assert.equal(said.length, n, 'audio still playing (5 s): no line over it');
  c.advance(1001); assert.equal(said.length, n + 1, '8 s after the audio ends');
  // Never while the owner talks or the voice is muted, never while an ask waits.
  muted = true; c.advance(PROGRESS_MS * 3); assert.equal(said.length, n + 1, 'never while muted or the owner talks');
  muted = false; waiting = true; c.advance(PROGRESS_MS * 3); assert.equal(said.length, n + 1, 'never while an Allow ask waits');
  waiting = false; c.advance(PROGRESS_MS); assert.equal(said.length, n + 2, 'goes on after');
  // The answer started (stop), or the turn is over: no more.
  p.stop(); c.advance(PROGRESS_MS * 5); assert.equal(said.length, n + 2, 'stopped: no more lines');
  assert.equal(c.pending, 0, 'no timer left');
  const q = startProgress({ voice, live: () => live, ...c });
  live = false; c.advance(PROGRESS_MS * 3); assert.equal(said.length, n + 2, 'the turn is over: nothing');
  q.stop();
  // A voice that can't take it any more (it ended) stops the cadence.
  live = true; let tries = 0;
  const r = startProgress({ voice: { beat() {}, progress: () => { tries++; return false; } }, live: () => true, ...c });
  c.advance(FILLER_MS + PROGRESS_MS * 4); assert.equal(tries, 1, 'one refused line ends it'); r.stop();
  assert.ok(PROGRESS.includes('Still checking.') && PROGRESS.includes('Almost there.'), 'the owner\'s own phrases');
  assert.ok(PROGRESS.every((l) => !FILLERS.includes(l)), 'progress lines are not openers');
  assert.match(side, /progress\.touch\(\);/, 'model text touches it');
  assert.match(side, /if \(msg\.id === turnVoice\?\.id\) turnProgress\?\.touch\(pcmSecs\(msg\)\);/, 'and the turn\'s audio, by its length');
  assert.match(side, /if \(e\.stopReason !== 'tool_use'\) progress\.stop\(\);/, 'the answer stops it');
}

// ---- C2: the voice takes a progress line after it began the answer (both engines), and logs progress:true.
{
  const logs = [];
  const until = async (f) => { for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 1)); };
  const made = [], out = [];
  class Studio {
    constructor(o) { Object.assign(this, o); this.said = []; made.push(this); }
    open() { return this; }
    say(t) { this.said.push(t); queueMicrotask(() => this.onAudio(new Int16Array([1, 2]), 44100)); }
    end() { queueMicrotask(() => this.onEnd()); }
    abort() {}
  }
  const sp = createSpeaker({ emit: (m) => out.push(m), log: (k, d) => logs.push([k, d]), LocalVoiceImpl: Studio, localStatus: async () => ({ ok: true }), bundled: () => null, fillers: FILLERS, keepWarmMs: 1e9 });
  sp.setProvider('voicestudio');
  const r = sp.start();
  r.say('Opening it now.');
  assert.equal(r.beat(), false, 'the opener stays once, before anything');
  assert.equal(r.progress('Still checking.'), true, 'a progress line after a sentence');
  assert.ok(logs.some(([k, d]) => k === 'speech_beat' && d.progress === true), 'logged progress:true');
  assert.equal(r.progress('Can I open it? Say yes or no.', 'ask'), true);
  assert.ok(logs.some(([k, d]) => k === 'speech_beat' && d.ask === true), 'an ask is logged as one');
  r.end();
  await until(() => out.some((m) => m.end));
  assert.deepEqual(made.at(-1).said, ['Opening it now.', 'Still checking.', 'Can I open it? Say yes or no.']);
  assert.deepEqual(out.filter((m) => m.pcm).map((m) => !!m.filler), [false, true, true], 'its audio is marked, not part of the answer');
  assert.equal(r.progress('Still on it.'), false, 'never once it ended');

  class Fish {
    constructor(o) { Object.assign(this, o); this.said = []; made.push(this); }
    open() { return this; }
    say(s) { this.said.push(s); }
    end() { this.ended = true; }
    abort() { this.aborted = true; }
    rebind(cbs) { Object.assign(this, cbs); return true; }
  }
  const fish = createSpeaker({ emit: () => {}, log: (k, d) => logs.push([k, d]), FishVoiceImpl: Fish, account: async () => ({ ok: true, credit: 4 }), beatPhrases: [], bundled: () => null });
  fish.setKey('k'); await new Promise((res) => setTimeout(res, 0));
  const f = fish.start();
  f.say('Opening it.');
  assert.equal(f.progress('Almost there.'), true, 'Fish: after a sentence too');
  assert.deepEqual(made.at(-1).said, ['Opening it.', 'Almost there.']);
  f.end();
  assert.equal(f.progress('Still on it.'), false, 'Fish: never once it ended');
}

// ---- C3: asks.
{
  // Spoken answers: a clear yes or no, else words for the turn.
  for (const t of ['yes', 'Yes.', 'yeah, do it', 'okay', 'sure thing', 'go ahead', 'Yes please', 'do it']) assert.equal(spokenAnswer(t), 'yes', t);
  for (const t of ['no', 'No!', 'nope', 'no thanks', "don't allow it", 'Not now.', 'skip it', 'cancel']) assert.equal(spokenAnswer(t), 'no', t);
  for (const t of ['open Safari', 'yes no', 'no, open the other one', 'I said yes to the email', '', 'what is the weather like today in Paris']) assert.equal(spokenAnswer(t), null, t);
  assert.equal(spokenQuestion('Open https://ui.elevenlabs.io/?'), 'Can I open ui.elevenlabs.io? Say yes or no.', 'the owner\'s case, as he hears it');
  assert.equal(spokenQuestion('Search the web for "orbs"?'), 'Can I search the web for "orbs"? Say yes or no.');
  assert.match(spokenQuestion('In Notes, every step I\'d take:\n1. Click New'), /details are on the screen\. Say yes or no\.$/, 'a long one points at the screen');
  assert.equal(skippedLine('Open https://ui.elevenlabs.io/?'), "I didn't hear a yes, so I skipped opening it.");
  assert.equal(skippedLine('Weird question?'), "I didn't hear a yes, so I skipped that.");
  assert.equal(ASK_DEADLINE_MS, 60_000);

  // A voice-turn ask: logged, said, then given up after 60 s, said too, closed and answered no.
  const c = fakeClock(), logs = [], said = [];
  let closed = 0, got;
  const voice = { progress: (l, k) => { said.push([l, k]); return true; } };
  const a = trackAsk({ id: 'a1', route: 'panel', question: 'Open https://ui.elevenlabs.io/?', choices: true, voice, log: (k, d) => logs.push([k, d]), resolve: (v) => { got = v; }, close: () => closed++, ...c });
  assert.deepEqual(logs[0], ['ask', { id: 'a1', route: 'panel', yesno: true, spoken: true }], 'logged when shown');
  assert.deepEqual(said, [['Can I open ui.elevenlabs.io? Say yes or no.', 'ask']], 'said in Hydra\'s voice');
  assert.equal(a.voiced, true);
  c.advance(ASK_DEADLINE_MS - 1); assert.equal(got, undefined, 'waits a minute');
  c.advance(1);
  assert.equal(got, null, 'then the tool gets a no');
  assert.equal(closed, 1, 'and it closes on screen');
  assert.deepEqual(said.at(-1), ["I didn't hear a yes, so I skipped opening it.", 'ask'], 'said aloud, never a silent wait');
  assert.deepEqual(logs.at(-1), ['ask_done', { id: 'a1', route: 'panel', answer: 'expired', ms: ASK_DEADLINE_MS }]);
  assert.equal(a.answer('yes'), false, 'answered once');

  // A spoken yes answers it; the screen's answers are logged without the typed words.
  const l2 = [];
  let v2;
  const b = trackAsk({ id: 'a2', route: 'overlay', question: 'Open Mail?', choices: true, voice, log: (k, d) => l2.push([k, d]), resolve: (v) => { v2 = v; }, ...c });
  c.advance(3000);
  assert.equal(b.answer('yes', 'voice'), true);
  assert.equal(v2, 'yes');
  assert.deepEqual(l2.at(-1), ['ask_done', { id: 'a2', route: 'overlay', answer: 'yes', ms: 3000, by: 'voice' }]);
  c.advance(ASK_DEADLINE_MS * 2); assert.equal(c.pending, 0, 'the deadline is gone once answered');
  const l3 = [];
  const typed = trackAsk({ id: 'a3', route: 'overlay', question: 'Paste the code', log: (k, d) => l3.push([k, d]), resolve: () => {}, ...c });
  assert.equal(c.pending, 0, 'a typed ask has no deadline (a sign-in code can take a while)');
  typed.answer('code#secret');
  assert.equal(l3.at(-1)[1].answer, 'typed'); assert.doesNotMatch(JSON.stringify(l3), /secret/, 'never the typed words');
  const before = said.length;
  const d = trackAsk({ id: 'a4', route: 'panel', question: 'Open Mail?', choices: true, voice: null, log: () => {}, resolve: () => {}, ...c });
  c.advance(ASK_DEADLINE_MS);
  assert.equal(d.voiced, false); assert.equal(said.length, before, 'not a voice turn: nothing said, but it still ends');
  assert.equal(d.open, false);

  // The deadline frees the one-at-a-time queue, so a later yes/no is shown (it never blocks behind a lost one).
  const c2 = fakeClock(), shown = [];
  const ask = oneYesNoAtATime((opts) => new Promise((resolve) => { shown.push(opts.placeholder); trackAsk({ id: opts.placeholder, route: 'panel', question: opts.placeholder, choices: true, resolve, ...c2 }); }));
  const first = ask({ placeholder: 'Open Aside?', choices: ['Allow', "Don't allow"] });
  const second = ask({ placeholder: 'Search the web?', choices: ['Allow', "Don't allow"] });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(shown, ['Open Aside?']);
  c2.advance(ASK_DEADLINE_MS);
  assert.equal(await first, null);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(shown, ['Open Aside?', 'Search the web?'], 'the next ask shows');
  c2.advance(ASK_DEADLINE_MS); assert.equal(await second, null);

  // Wiring: every local ask goes through trackAsk; a spoken yes or no reaches the ask Hydra said, not the turn.
  assert.match(side, /const a = trackAsk\(\{ id, route, question: opts\.prompt \|\| opts\.placeholder, choices: !!opts\.choices, voice, log: logLine,/);
  assert.match(side, /const voice = opts\.choices && !onboarding && busy && turnVoice && !voiceMuted \? turnVoice : null;/, 'said only in a voice turn');
  assert.match(side, /const asked = \[\.\.\.yesNoOpen\]\.find\(\(\[, w\]\) => w\.a\.voiced && w\.a\.open\), said = asked && spokenAnswer\(text\);\n  if \(said\) \{[^\n]*w\.a\.answer\(said === 'yes' \? 'yes' : null, 'voice'\); return; \}\n  if \(addOnTake\)/, 'a yes or no answers the ask before the add-on');
  assert.match(side, /waiting: \(\) => yesNoOpen\.size > 0/, 'no progress line over an ask');
  assert.match(panel, /if \(askNow\) \{ askHeld = askNow\.m; closeAsk\(askNow\.id, false\); \}/, 'the panel losing focus never answers no');
}

// ---- C4: idle sleep never comes while a turn or an ask is open; the 5 minutes count from its end.
{
  const c = fakeClock();
  let working = true;
  const changes = [];
  const p = createPower({ ...c, working: () => working, onChange: (x) => changes.push(x) });
  c.advance(6 * 60_000);
  assert.equal(p.asleep, false, 'a 6 minute turn: still awake');
  working = false; p.busy(); // as prompt()'s end and an answered ask do in sidekick.mjs
  c.advance(SLEEP_AFTER_MS - 2000);
  assert.equal(p.asleep, false, 'the 5 minutes count from the end of the turn');
  c.advance(4000);
  assert.equal(p.asleep, true);
  assert.deepEqual(changes, [{ asleep: true, why: 'idle' }]);
  p.stop();
  assert.match(side, /working: \(\) => busy \|\| pending\.size > 0,/, 'a turn or any ask counts as working');
  assert.match(side, /busy = false; turnVoice = null; turnImage = null; addOnTake = false;\n    power\.busy\(\);/, 'the turn\'s end restarts the 5 minutes');
}

// ---- C5: the sleep word is exact while a turn runs, and what was heard is logged.
{
  assert.equal(heardSleepWord('sleep least', 'Sleep beast', { strict: true }), false, 'a near miss never ends the work');
  assert.equal(heardSleepWord('Sleep beast.', 'Sleep beast', { strict: true }), true, 'the exact words do');
  assert.equal(heardSleepWord('sleep least', 'Sleep beast'), true, 'awake and idle it stays forgiving');
  assert.equal(heardSleepWord('good night Hydra', 'Goodnight Hydra', { strict: true }), true, 'a word heard as two is still exact');
  assert.match(side, /heardSleepWord\(text, config\.sleepWord \|\| DEFAULT_SLEEP_WORD, \{ strict: busy \}\)\) \{ logLine\('sleep_word', \{ heard: text\.slice\(0, 120\), strict: busy \}\);/);
}

// ---- Every turn that ends without an answer says why.
{
  assert.deepEqual(endNote({ how: 'end', answered: true, voice: true }), { line: '', spoken: false }, 'it answered: nothing more');
  assert.deepEqual(endNote({ how: 'end', voice: true }), { line: "I didn't get an answer back that time. Ask me again?", spoken: true });
  assert.equal(endNote({ how: 'max_turns', voice: false }).spoken, false, 'shown always, said only in a voice turn');
  assert.match(endNote({ how: 'max_turns' }).line, /ran out of steps/);
  assert.deepEqual(endNote({ how: 'stall', message: 'Claude stopped answering.', voice: true }), { line: 'Claude stopped answering.', spoken: true });
  assert.deepEqual(endNote({ how: 'error', message: 'No connection.', voice: true }), { line: 'No connection.', spoken: true });
  assert.deepEqual(endNote({ how: 'stop', voice: true }), { line: 'Okay, stopping.', spoken: false }, 'Stop is silence');
  assert.deepEqual(endNote({ how: 'sleep', voice: true }), { line: "I stopped that because I'm going to sleep.", spoken: false }, 'so is sleep, but it is shown');
  assert.equal(endNote({ how: 'stop', answered: true }).line, 'Okay, stopping.', 'a stop always says so');
  assert.match(side, /else if \(e\.type === 'max_turns'\) hitMax = true;/, 'the step limit is noticed');
  assert.match(side, /if \(note\.line && !cutOff\) \{[^\n]*reply\.push\(n\);/, 'said in the reply when the voice is live');
  assert.match(side, /localSync\.record\(\{ user: turnWords, assistant: \[shown, endLine\]\.filter\(Boolean\)\.join\('\\n'\) \}\);/, 'written to the thread, a stopped turn too');
  assert.doesNotMatch(side, /!\(controller\.signal\.aborted && quiet\)\) \{\n\s+const c = new CueFilter\(\);/, 'a quiet stop is no longer left out of the thread');
}

console.log('build 4 E1 (turn flow): ok');
