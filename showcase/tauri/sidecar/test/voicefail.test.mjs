// A failed or timed-out tool says the error and stops the "still working" lines.
// After a statement the mic stays open, and an interrupt does not ask for the wake phrase.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FILLER_MS, PROGRESS_MS, failLine, noteToolFailure, startProgress } from '../voiceturn.mjs';
import { PROGRESS } from '../speaker.mjs';
import { keepListening, listensAfter } from '../speech.mjs';

const side = readFileSync(new URL('../sidekick.mjs', import.meta.url), 'utf8');
const swift = readFileSync(new URL('../../src-tauri/voice/main.swift', import.meta.url), 'utf8');
const barge = readFileSync(new URL('../../src-tauri/voice/barge.swift', import.meta.url), 'utf8');
const host = readFileSync(new URL('../../../roamies/host.js', import.meta.url), 'utf8');

function fakeClock() {
  let t = 0, timers = [];
  return {
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
  };
}

assert.equal(failLine('timed out'), 'That timed out.');
assert.equal(failLine('The operation was aborted due to timeout'), 'That timed out.');
assert.equal(failLine('Could not open Mail.'), 'Could not open Mail.');
assert.equal(failLine(''), 'That failed.');
assert.equal(failLine('The drawing didn\'t show (the overlay isn\'t responding). Try again later.'), 'The drawing didn\'t show (the overlay isn\'t responding).');

{
  const c = fakeClock(), said = [];
  const voice = {
    beat() { said.push('beat'); return true; },
    progress(line) { said.push(line); return true; },
  };
  const p = startProgress({ voice, live: () => true, ...c, random: () => 0 });
  c.advance(FILLER_MS);
  c.advance(PROGRESS_MS);
  assert.ok(PROGRESS.includes(said.at(-1)), 'a progress line while the work runs');
  const n = said.length;
  const line = noteToolFailure({ isError: true, result: 'timed out', progress: p, say: (s) => said.push(['say', s]) });
  assert.equal(line, 'That timed out.');
  c.advance(PROGRESS_MS * 4);
  assert.equal(said.length, n + 1, 'the failure ends the progress lines');
  assert.deepEqual(said.at(-1), ['say', 'That timed out.']);
  assert.equal(noteToolFailure({ isError: false, result: 'ok', progress: p, say: () => said.push('no') }), null);
  c.advance(PROGRESS_MS);
  assert.equal(said.length, n + 1, 'a success does not start the lines again');
  p.stop();
}

{
  const c = fakeClock(), said = [];
  const voice = { beat() { return true; }, progress(line) { said.push(line); return true; } };
  const p = startProgress({ voice, live: () => true, ...c, random: () => 0 });
  c.advance(FILLER_MS + PROGRESS_MS);
  const before = said.filter((x) => PROGRESS.includes(x)).length;
  noteToolFailure({ isError: true, result: 'Safari is not running.', progress: p, say: (s) => said.push(['say', s]) });
  c.advance(PROGRESS_MS * 3);
  assert.deepEqual(said.at(-1), ['say', 'Safari is not running.']);
  assert.equal(said.filter((x) => PROGRESS.includes(x)).length, before, 'no progress line after the error text');
  p.stop();
}

assert.equal(listensAfter('Done, the file is saved.', false), true, 'a statement keeps the mic open without the switch');
assert.equal(listensAfter('Want me to open it?', false), true);
assert.equal(listensAfter('   '), false);
assert.equal(keepListening({ reply: 'The file is saved.' }), true);
assert.equal(keepListening({ reply: '', interrupt: true }), true, 'an interrupt keeps the take; the wake phrase is not required');
assert.equal(keepListening({ reply: 'Hi there.', interrupt: true }), true);
assert.equal(keepListening({ reply: '' }), false);
assert.equal(keepListening({ reply: 'Hi.', aborted: true, interrupt: true }), false);
assert.equal(keepListening({ reply: 'Hi.', stalled: true }), false);

assert.match(side, /if \(e\.isError\) noteToolFailure\(\{ isError: true, result: e\.result, progress, say: \(line\) => voice\?\.say\?\.\(line\) \}\);/, 'a failed tool is said, and the progress lines stop');
assert.match(side, /stalled = true; progress\.pause\(\)/, 'a stall stops the progress lines at once');
assert.match(side, /keepListening\(\{ reply: byVoice \|\| interruptedAfter \? lastReply : '', interrupt: !!interruptedAfter \}\)/, 'a statement or an interrupt leaves the mic open');
assert.doesNotMatch(side, /listensAfter\(lastReply, !!config\.listenEvery\)/, 'the mic does not wait for After every reply');
assert.match(swift, /if phase == \.barge \{ bargeTake\(best\); return \}/, 'an interrupt already in progress stays a take');
assert.match(barge, /realWords\(text\)\.count >= 1/, 'any real word during speech is the take');
assert.doesNotMatch(barge, /WakeWord\.match\(text\) != nil/, 'a wake phrase is not the gate while Hydra speaks');
assert.match(swift, /func listenOverSpeech\(\)/, 'the recogniser is already on while Hydra speaks');
assert.match(swift, /Hydra speaking: the mic is open, any words are the take/, 'words are heard without a wake phrase or a clap');
assert.match(swift, /if phase == \.handsFree \|\| phase == \.holding \|\| phase == \.armed \|\| phase == \.finishing \{ return \}/, 'an open take is not replaced');
assert.doesNotMatch(host, /state === 'listening'\) \{\n      hearing = true;\n      dropAutoListen\(\);/, 'an interrupt does not cancel the follow-up mic');

console.log('voice fail and listen: ok');
