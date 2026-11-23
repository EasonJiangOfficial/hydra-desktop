// Tenth review R10-13, R10-14, R10-15, R10-17: the voice side of a turn, tested by behavior (voiceturn.mjs,
// agentsettings.mjs) with a fake clock, fake voice and fake agent. Run: npm test
import assert from 'node:assert/strict';
import { FILLER_MS, addOnTo, createSpokenTrack, startProgress } from '../voiceturn.mjs';
import { createSettingsWatch, hydraModelPick, wakePhraseFor } from '../agentsettings.mjs';
import { INPUT_PREFIX } from '../relay.mjs';

// ---- What the owner heard when he talked over the reply (R10-13): played time, not chunks handed on.
{
  let t = 0;
  const track = createSpokenTrack({ now: () => t, cps: 10 });
  const pcm = (secs, rate = 1000) => Buffer.alloc(Math.round(secs * rate * 2)).toString('base64');
  track.start('s1');
  track.line('[warm] '); // a cue tag alone makes no audio: never counted as said
  track.line('Hello there.'); // 12 chars = 1.2 s at 10 a second
  track.line('Your total is five dollars.'); // 27 chars = 2.7 s
  track.audio({ id: 's1', pcm: pcm(0.5), rate: 1000, filler: true }); // the filler plays first
  for (let i = 0; i < 8; i++) track.audio({ id: 's1', pcm: pcm(1), rate: 1000 }); // all rendered at once, ahead of playback
  t = 2000; // 2 s played: the filler (0.5 s) and 1.5 s of the answer
  assert.equal(track.interrupted(), 'Hello there.', 'only the sentence that has played; chunks rendered ahead are not heard');
  assert.equal(track.interrupted(), '', 'noted once');

  t = 0; track.start('s2'); track.line('One.'); track.audio({ id: 's2', pcm: pcm(5), rate: 1000 });
  t = 300;
  assert.equal(track.interrupted(), '', 'nothing whole heard yet');
  track.start('s3'); track.line('Done now.'); track.audio({ id: 's3', pcm: pcm(1), rate: 1000 }); track.finished();
  t = 99_000;
  assert.equal(track.interrupted(), '', 'all of it was said: no cut');
  track.start('s4'); track.line('Ignored.'); track.audio({ id: 'other', pcm: pcm(1), rate: 1000 });
  assert.equal(track.interrupted(), '', 'another reply\'s audio does not count');
}

// ---- The filler (R10-17): after 1.1 s with no answer, never muted, never after the answer started.
{ // The opener (build 4 E1: startProgress, which also says the progress lines; those are in build4e1.test.mjs).
  let t = 0;
  const timers = [];
  const setTimer = (f, ms) => { const x = { f, ms, at: t + ms, on: true }; timers.push(x); return x; };
  const clearTimer = (x) => { x.on = false; };
  const fire = () => { const x = timers.filter((y) => y.on).sort((a, b) => a.at - b.at)[0]; if (x) { x.on = false; t = Math.max(t, x.at); x.f(); } };
  let beats = 0, live = true, muted = false;
  const voice = { beat: () => { beats++; }, progress: () => true };
  const opts = () => ({ voice, live: () => live, muted: () => muted, setTimer, clearTimer, now: () => t });
  let p = startProgress(opts());
  assert.equal(timers[0].ms, FILLER_MS); assert.equal(FILLER_MS, 1100);
  fire(); assert.equal(beats, 1, 'a filler when nothing started');
  p.stop();
  p = startProgress(opts());
  p.touch(); fire(); assert.equal(beats, 1, 'the answer started: no filler'); p.stop();
  p = startProgress(opts()); p.stop(); fire(); assert.equal(beats, 1, 'stopped: no filler');
  muted = true; p = startProgress(opts()); fire(); p.stop();
  assert.equal(beats, 1, 'never while muted');
  muted = false; live = false; p = startProgress(opts()); fire();
  assert.equal(beats, 1, 'the turn is over: no filler');
  assert.doesNotThrow(() => startProgress({ voice: null, live: () => true }).stop(), 'no voice: nothing');
}

// ---- Words added while thinking (R10-17): into the running session, else the next request; idle: a new request.
{
  const sent = [], queued = [];
  assert.equal(addOnTo('and Rome', { busy: true, addInput: (t) => { sent.push(t); return true; }, enqueue: (...a) => queued.push(a) }), 'turn');
  assert.deepEqual(sent, [`${INPUT_PREFIX}and Rome`]); assert.equal(queued.length, 0);
  assert.equal(addOnTo('and Paris', { busy: true, addInput: () => false, enqueue: (...a) => queued.push(a) }), 'next');
  assert.deepEqual(queued, [['and Paris', { byVoice: true }]]);
  assert.equal(addOnTo('hi', { busy: false, addInput: () => true, enqueue: () => assert.fail('not queued') }), false);
}

// ---- The wake phrase (R10-14): sent only once Hydra has answered, so the Mac's own wake name works unpaired.
{
  let ok = false;
  const api = { req: async () => (ok ? { ok: true, json: async () => ({ settings: { wake_phrase: 'Hey Jarvis' } }) } : { ok: false, status: 401 }) };
  const w = createSettingsWatch({ api, setTimer: () => null, clearTimer: () => {} });
  assert.equal(wakePhraseFor(w), undefined, 'not read yet: no phrase (the default would override the wake name)');
  await w.start();
  assert.equal(wakePhraseFor(w), undefined, 'unpaired (401): still none');
  ok = true; await w.refresh();
  assert.equal(wakePhraseFor(w), 'Hey Jarvis', "Hydra's own once it answered");
  w.stop();
  assert.equal(wakePhraseFor(w), undefined, 'stopped (unpaired): none again');
  assert.equal(JSON.parse(JSON.stringify({ wakePhrase: wakePhraseFor(w) })).wakePhrase, undefined, 'left out of voice_config');
}

// ---- Hydra's model (R10-15): only when the owner's provider is Claude or none; his pick of another stays.
{
  const canRun = (p) => p === 'anthropic';
  const want = 'claude-opus-5-5';
  assert.equal(hydraModelPick({ provider: 'openai', model: 'gpt-6', want, canRun }), null, 'OpenAI stays picked');
  assert.equal(hydraModelPick({ provider: 'gemini', model: 'g', want, canRun }), null);
  assert.equal(hydraModelPick({ provider: 'local', model: 'l', want, canRun }), null);
  assert.deepEqual(hydraModelPick({ provider: null, model: null, want, canRun }), { provider: 'anthropic', model: want });
  assert.deepEqual(hydraModelPick({ provider: 'anthropic', model: 'old', want, canRun }), { provider: 'anthropic', model: want });
  assert.deepEqual(hydraModelPick({ provider: 'anthropic', model: want, want, canRun }), { same: true });
  assert.equal(hydraModelPick({ provider: null, model: null, want, routed: true, canRun }), null, 'a routed turn keeps its model');
  assert.equal(hydraModelPick({ provider: null, model: null, want, canRun: () => false }), null, 'not signed in with Claude');
}
console.log('voice turn: passed');
