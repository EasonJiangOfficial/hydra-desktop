import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as powerModule from '../power.mjs';

function fakeClock() {
  let now = 0;
  const timers = new Set();
  return {
    now: () => now,
    setTimer(fn, ms) { const timer = { fn, at: now + ms }; timers.add(timer); return timer; },
    clearTimer: (timer) => timers.delete(timer),
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        now = next.at;
        timers.delete(next);
        next.fn();
      }
      now = end;
    },
  };
}

test('a web wake stays awake for a 40-second take and after it ends empty', () => {
  const clock = fakeClock();
  let taking = true;
  const power = powerModule.createPower({ ...clock, taking: () => taking });
  power.sleep();
  power.wake('web');
  clock.advance(40_000);
  assert.equal(power.asleep, false, 'still awake while listening');
  taking = false;
  power.takeEnded();
  assert.equal(power.asleep, false, 'still awake after an empty tap take');
  clock.advance(12_000);
  assert.equal(power.asleep, false, 'no confirmation timer remains');
});

test('an empty clap take and a phrase wake with no take go back to sleep', () => {
  const clock = fakeClock();
  const changes = [];
  const power = powerModule.createPower({ ...clock, onChange: (change) => changes.push(change) });
  power.sleep();
  power.wake('clap');
  power.takeEnded();
  assert.deepEqual(changes.at(-1), { asleep: true, why: 'unconfirmed' });
  power.wake('phrase');
  clock.advance(11_999);
  assert.equal(power.asleep, false);
  clock.advance(1);
  assert.deepEqual(changes.at(-1), { asleep: true, why: 'unconfirmed' });
});

test('a late hands-free wake cannot make a tap wake provisional', () => {
  const clock = fakeClock();
  const power = powerModule.createPower(clock);
  power.sleep();
  power.wake('web');
  assert.equal(power.wake('clap'), false);
  clock.advance(12_000);
  power.takeEnded();
  assert.equal(power.asleep, false);
});

// Run the sidecar's power callback and voice handler with the shell's message shapes and no app or microphone.
const sidekick = readFileSync(new URL('../sidekick.mjs', import.meta.url), 'utf8');
const powerSource = sidekick.match(/^const power = createPower\(\{[\s\S]*?^\}\);/m)[0];
const voiceSource = sidekick.match(/^function onVoice\(m\) \{[\s\S]*?^\}/m)[0];
const wakeSource = readFileSync(new URL('../voiceturn.mjs', import.meta.url), 'utf8').match(/^export (function wakeActions\(why\) \{[\s\S]*?^\})/m)[1];
const wakeRoutes = sidekick.match(/^  else if \(m\.type === 'agent_power'\)[\s\S]*?^  \}/m)[0];
const cancelRoute = sidekick.match(/^  else if \(m\.type === 'listen_cancel'\)[\s\S]*?\} \/\/ Esc while the mic is on/m)[0];

function sidecar({ busy = false, holdReply = false } = {}) {
  const clock = fakeClock();
  const said = [], logged = [], sent = [], spoken = [];
  const noop = () => {};
  const state = {
    ...powerModule,
    createPower: (options) => powerModule.createPower({ ...options, ...clock }),
    busy, voiceBusy: false, voiceHelperUp: true, saidPending: false, emptyTake: false, wakeTakeFrom: null, ignoreWakeNothingHeard: false,
    pending: new Map(), yesNoOpen: new Map(), askTake: null, takeVia: null, cutTake: false, snap: null,
    resumedAt: 0, talkHowLong: () => 'Try again', VOICE_ON: () => false,
    whileBusy: ({ busy }) => busy ? 'add_on' : 'new', overReply: () => holdReply ? 'hold' : 'stop',
    resumeCut: () => { state.cutTake = false; state.resumedAt = Date.now(); },
    say: (line) => said.push(line), logLine: (kind, meta) => logged.push([kind, { ...meta }]),
    send: (message) => sent.push({ ...message }), onSpoken: (words) => spoken.push(words),
    asksAsleep: noop, interruptQuietly: noop, voiceConfig: noop, ui: noop, menu: noop, pushWeb: noop,
    stir: noop, pendingNow: noop, speech: { stop: noop }, warmUp: noop, hush: noop, whereNow: noop, micPick: noop,
    problem: () => ({ text: 'Recognition failed' }),
  };
  const routeSource = `function route(m) { if (false) {}\n${wakeRoutes}\n${cancelRoute}\n}`;
  const { power, onVoice, route } = runInNewContext(`${wakeSource}\n${powerSource}\n${voiceSource}\n${routeSource}\n({ power, onVoice, route });`, state);
  const voiceState = (state, mode = 'handsfree') => onVoice({ type: 'voice_state', state, mode: state === 'listening' ? mode : null });
  const nothingHeard = () => onVoice({ type: 'voice_error', code: 'nothing_heard', spoke: false });
  power.sleep();
  sent.length = 0;
  return { clock, power, route, onVoice, voiceState, nothingHeard, said, logged, sent, spoken };
}

test('a tap wake stays awake and gives one retry line even if the helper reports no words too', () => {
  for (const reason of ['web', 'orb', 'panel', 'asked']) {
    const { clock, power, route, voiceState, nothingHeard, said, logged, sent } = sidecar();
    route(reason === 'web' ? { type: 'orb_listen', from: 'web' } : { type: 'agent_power', on: true, from: reason });
    assert.deepEqual(sent.at(-1), { type: 'listen', via: 'wake', wait: 8 });
    voiceState('listening');
    clock.advance(40_000);
    assert.equal(power.asleep, false, `${reason}: still awake during the take`);
    if (reason === 'orb') {
      route({ type: 'orb_listen', from: 'orb' });
      assert.deepEqual(sent.at(-1), { type: 'listen_finish' });
      voiceState('processing');
    } // A quiet timeout goes straight to idle.
    voiceState('idle');
    voiceState('idle');
    if (reason === 'orb') nothingHeard(); // The Windows/Linux helper reports this after idle.
    assert.equal(power.asleep, false, `${reason}: still awake after the take`);
    assert.deepEqual(said, ["I didn't catch that. Tap and try again."], reason);
    assert.deepEqual(logged.filter(([kind]) => kind === 'nothing_heard'), [['nothing_heard', { explicit: true }]], reason);
  }
});

test('the confirmation timer holds a hands-free take open and an empty take ends silently', () => {
  for (const reason of ['clap', 'phrase']) {
    const { clock, power, route, voiceState, nothingHeard, said, logged } = sidecar();
    route({ type: 'agent_power', on: true, from: reason });
    voiceState('listening', reason === 'phrase' ? 'wake' : 'handsfree');
    clock.advance(12_000);
    assert.equal(power.asleep, false, `${reason}: still awake during the take`);
    voiceState('processing');
    voiceState('idle');
    nothingHeard();
    assert.equal(power.asleep, true, reason);
    assert.deepEqual(logged.at(-1), ['power', { asleep: true, why: 'unconfirmed' }], reason);
    assert.deepEqual(said, [], reason);
  }
});

test('the tap take also holds off the ordinary idle timer while processing', () => {
  const { clock, power, route, voiceState, said } = sidecar();
  route({ type: 'orb_listen', from: 'orb' });
  voiceState('listening');
  voiceState('processing');
  clock.advance(powerModule.SLEEP_AFTER_MS + 1000);
  assert.equal(power.asleep, false);
  voiceState('idle');
  assert.deepEqual(said, ["I didn't catch that. Tap and try again."]);
  clock.advance(powerModule.SLEEP_AFTER_MS);
  assert.equal(power.asleep, true, 'normal idle sleep still works after the take');
});

test('an empty tap take gives no retry line over a live turn or a resumed reply', () => {
  for (const options of [{ busy: true }, { holdReply: true }]) {
    const { power, route, voiceState, nothingHeard, said } = sidecar(options);
    route({ type: 'orb_listen', from: 'web' });
    voiceState('listening');
    voiceState('idle');
    nothingHeard();
    assert.equal(power.asleep, false);
    assert.deepEqual(said, []);
  }
});

test('a cancel or final words clears the wake and a later ordinary take keeps its feedback', () => {
  for (const cancel of [false, true]) {
    const { power, route, onVoice, voiceState, nothingHeard, said, spoken, sent } = sidecar();
    route({ type: 'orb_listen', from: 'web' });
    voiceState('listening');
    if (cancel) {
      route({ type: 'listen_cancel' });
      assert.deepEqual(sent.at(-1), { type: 'listen_cancel' });
    } else {
      voiceState('processing');
      onVoice({ type: 'voice', text: 'hello' });
      assert.deepEqual(spoken, ['hello']);
    }
    voiceState('idle');
    assert.equal(power.asleep, false);
    assert.deepEqual(said, []);
    voiceState('listening');
    voiceState('idle');
    nothingHeard();
    assert.deepEqual(said, ["I didn't hear anything. Try again."]);
  }
});

test('a failed or restarted helper clears the wake take without a retry line', () => {
  for (const message of [{ type: 'voice_error', code: 'recognition' }, { type: 'voice_ready' }]) {
    const { power, route, onVoice, voiceState, said } = sidecar();
    route({ type: 'orb_listen', from: 'web' });
    voiceState('listening');
    onVoice(message);
    voiceState('idle');
    assert.equal(power.asleep, false);
    assert.deepEqual(said, message.type === 'voice_error' ? ['Recognition failed'] : []);
  }
});
