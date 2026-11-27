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
const powerSource = sidekick.match(/^let [^\n]*pendingWake = null,[\s\S]*?^const power = createPower\(\{[\s\S]*?^\}\);/m)[0];
const voiceSource = sidekick.match(/^const micPick = [^\n]*\n([\s\S]*?^function onVoice\(m\) \{[\s\S]*?^\})/m)[1];
const voiceConfigSource = sidekick.match(/^let voiceConfigSent = [^\n]*\nconst voiceConfig = \(\) => \{[\s\S]*?^\};/m)[0];
const wakeSource = readFileSync(new URL('../voiceturn.mjs', import.meta.url), 'utf8').match(/^export (function wakeActions\(why\) \{[\s\S]*?^\})/m)[1];
const wakeRoutes = sidekick.match(/^  else if \(m\.type === 'agent_power'\)[\s\S]*?^  \}/m)[0];
const panelWake = sidekick.match(/^  else if \(id === 'power:wake'\) [^\n]*/m)[0];
const cancelRoute = sidekick.match(/^  else if \(m\.type === 'listen_cancel'\)[\s\S]*?\} \/\/ Esc while the mic is on/m)[0];

function sidecar({ busy = false, holdReply = false, wakeCueDelay = 0 } = {}) {
  const clock = fakeClock();
  const said = [], logged = [], sent = [], spoken = [], hushed = [], refreshed = [];
  const noop = () => {};
  const config = { voice: true };
  const state = {
    ...powerModule,
    createPower: (options) => powerModule.createPower({ ...options, ...clock }),
    Date: { now: clock.now }, setTimeout: clock.setTimer, clearTimeout: clock.clearTimer,
    config, VOICE_OK: true, MAC: false, NEEDS_MODEL: false,
    voiceReady: () => true, phraseListening: () => false, phraseOn: () => false, wakePhraseNow: () => 'Hey Hydra',
    clapTalkOn: () => false, bargeOn: () => false, clapSensitivity: () => 0.5, notchMode: () => 'off',
    busy, voiceBusy: false, voiceHelperUp: true, saidPending: false, emptyTake: false, addOnTake: false,
    pending: new Map(), yesNoOpen: new Map(), askTake: null, takeVia: null, cutTake: false, snap: null,
    resumedAt: -Infinity, talkHowLong: () => 'Try again', VOICE_ON: () => false,
    whileBusy: ({ busy }) => busy ? 'add_on' : 'new', overReply: () => holdReply ? 'hold' : 'stop',
    afterHeld: () => 'stop', heardTrack: { said: () => '' },
    resumeCut: () => { state.cutTake = false; state.resumedAt = clock.now(); },
    say: (line) => said.push(line), logLine: (kind, meta) => logged.push([kind, { ...meta }]),
    send: (message) => {
      sent.push({ ...message });
      if (wakeCueDelay && message.type === 'cue' && message.name === 'wake') clock.advance(wakeCueDelay);
    },
    onSpoken: (words) => spoken.push(words),
    asksAsleep: noop, interruptQuietly: noop, nativeNow: noop, ui: noop, menu: noop, pushWeb: noop,
    stir: () => refreshed.push(['stir', state.voiceBusy]), pendingNow: () => refreshed.push(['pendingNow', state.voiceBusy]),
    speech: { stop: noop }, warmUp: noop, hush: (on) => hushed.push(on), whereNow: noop, micPick: noop, askArm: noop,
    problem: () => ({ text: 'Recognition failed' }),
  };
  const routeSource = `function route(m) { if (false) {}\n${wakeRoutes}\n${cancelRoute}\n}`;
  const menuSource = `function menuAction(id) { if (false) {}\n${panelWake}\n}`;
  const { power, onVoice, route, menuAction, voiceConfig } = runInNewContext(
    `${wakeSource}\n${powerSource}\n${voiceConfigSource}\n${voiceSource}\n${routeSource}\n${menuSource}\n({ power, onVoice, route, menuAction, voiceConfig });`, state);
  const voiceState = (state, mode = 'handsfree') => onVoice({ type: 'voice_state', state, mode: state === 'listening' ? mode : null });
  const nothingHeard = () => onVoice({ type: 'voice_error', code: 'nothing_heard', spoke: false });
  power.sleep();
  sent.length = 0;
  return { clock, power, route, menuAction, voiceConfig, onVoice, voiceState, nothingHeard, said, logged, sent, spoken, state, hushed, refreshed };
}

const tapRetry = "I didn't catch that. Tap and try again.";
const helperRetry = "I didn't hear anything. Try again.";

test('a tap wake stays awake and gives one retry line even if the helper reports no words too', () => {
  for (const reason of ['web', 'orb', 'panel', 'asked']) {
    const { clock, power, route, menuAction, voiceState, nothingHeard, said, logged, sent } = sidecar();
    if (reason === 'panel') menuAction('power:wake');
    else if (reason === 'web') route({ type: 'orb_listen', from: 'web' });
    else route({ type: 'agent_power', on: true, from: reason === 'asked' ? undefined : reason });
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
    const { clock, power, route, voiceState, nothingHeard, said, logged, sent } = sidecar();
    route({ type: 'agent_power', on: true, from: reason });
    assert.equal(sent.some(({ type }) => type === 'listen'), reason === 'clap', 'the phrase already opened its own take');
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

for (const ends of [false, true]) {
  test(`an awake orb take ${ends ? 'restarts idle time when it ends' : 'holds idle sleep for at most three minutes'}`, () => {
    const { clock, power, route, voiceState, nothingHeard, said, sent, logged } = sidecar();
    const idle = powerModule.SLEEP_AFTER_MS;
    power.talked();
    clock.advance(idle - 1000);
    route({ type: 'orb_listen', from: 'orb' });
    assert.deepEqual(sent.at(-1), { type: 'listen', via: 'orb' });
    voiceState('listening');
    clock.advance(2000);
    assert.equal(power.asleep, false, 'still awake at five minutes and one second into the session');
    clock.advance(60_000);
    voiceState('processing');
    if (ends) {
      voiceState('idle');
      nothingHeard();
    } else {
      clock.advance(3 * 60_000 - 62_001);
      assert.equal(power.asleep, false, 'still awake one millisecond before the continuous hold expires');
      clock.advance(1);
    }
    clock.advance(idle - 1);
    assert.equal(power.asleep, false, 'has a full five minutes from take end or expiry');
    clock.advance(1);
    assert.deepEqual(logged.at(-1), ['power', { asleep: true, why: 'idle' }]);
    assert.deepEqual(said, ends ? [helperRetry] : []);
  });
}

test('a web wake stays awake when the helper never opens a take', () => {
  const { clock, power, route, state, said } = sidecar();
  route({ type: 'agent_power', on: true, from: 'web' });
  clock.advance(12_000);
  assert.equal(power.asleep, false);
  assert.equal(state.voiceBusy, false);
  assert.deepEqual(said, []);
});

for (const open of ['yesNoOpen', 'pending']) {
  test(`an empty tap does not speak over ${open === 'pending' ? 'an approval' : 'a yes/no ask'}`, () => {
    const { power, route, voiceState, nothingHeard, said, state } = sidecar();
    route({ type: 'orb_listen', from: 'orb' });
    voiceState('listening');
    state[open].set('ask', { a: { voiced: true } });
    voiceState('idle');
    nothingHeard();
    assert.equal(power.asleep, false);
    assert.deepEqual(said, [], 'no retry with an open ask');
  });
}

for (const helperWasUp of [true, false]) {
  test(`a ready helper resumes the cut reply after losing a tap take (helper was up: ${helperWasUp})`, () => {
    const { power, route, voiceState, nothingHeard, onVoice, said, state, hushed, refreshed } = sidecar({ holdReply: true });
    route({ type: 'orb_listen', from: 'orb' });
    voiceState('listening');
    assert.equal(state.voiceBusy, true);
    assert.equal(state.cutTake, true);
    state.voiceHelperUp = helperWasUp;
    state.askTake = { id: 'ask' };
    state.snap = { waitingVoice: true };
    onVoice({ type: 'voice_ready' });
    assert.equal(state.voiceBusy, false, 'the lost take is no longer busy');
    assert.equal(state.emptyTake, false);
    assert.equal(state.cutTake, false, 'the held reply resumed without waiting for idle');
    assert.equal(state.askTake, null);
    assert.equal(state.snap.waitingVoice, false);
    assert.equal(hushed.at(-1), false);
    assert.deepEqual(refreshed.slice(-2), [['stir', false], ['pendingNow', false]]);
    state.snap = null;
    nothingHeard();
    assert.deepEqual(said, []);
    assert.equal(power.asleep, false);
  });
}

test('two desktop orb taps 100 ms apart wake once without an extra listen', () => {
  for (const secondType of ['agent_power', 'orb_listen']) {
    const { clock, power, route, voiceState, said, logged, sent } = sidecar();
    route({ type: 'agent_power', on: true, from: 'orb' });
    clock.advance(100);
    route({ type: secondType, on: true, from: 'orb' });
    voiceState('listening');
    assert.equal(power.asleep, false);
    assert.deepEqual(logged.filter(([kind, meta]) => kind === 'power' && !meta.asleep), [['power', { asleep: false, why: 'orb' }]]);
    assert.deepEqual(sent.filter(({ type }) => ['cue', 'listen', 'listen_finish'].includes(type)),
      [{ type: 'cue', name: 'wake' }, { type: 'listen', via: 'wake', wait: 8 }], 'only one cue and listen before the helper opens');
    assert.deepEqual(said, []);
  }
});

for (const from of ['orb', 'web']) {
  test(`the ${from === 'orb' ? 'desktop' : 'web'} orb ignores a tap at 999 ms and finishes at 1000 ms from wake`, () => {
    const { clock, power, route, voiceState, said, logged, sent, state } = sidecar();
    route(from === 'orb' ? { type: 'agent_power', on: true, from } : { type: 'orb_listen', from });
    clock.advance(50);
    voiceState('listening');
    const beforeTap = sent.length;
    clock.advance(949);
    route({ type: 'orb_listen', from });
    assert.deepEqual(sent.slice(beforeTap), [], 'the second tap sends no listen_finish');
    assert.deepEqual(logged.at(-1), ['orb_listen', { ignored: 'double_tap' }]);
    assert.deepEqual(said, []);
    assert.equal(power.asleep, false);
    assert.equal(state.voiceBusy, true);

    clock.advance(1);
    route({ type: 'orb_listen', from });
    assert.deepEqual(sent.slice(beforeTap), [{ type: 'listen_finish' }]);
    voiceState('processing');
    voiceState('idle');
    assert.equal(state.voiceBusy, false);
    assert.equal(power.asleep, false);
    assert.deepEqual(said, [tapRetry]);
  });
}

test('a stop tap at 2300 ms finishes a wake take that started listening at 1400 ms', () => {
  const { clock, route, voiceState, sent } = sidecar();
  route({ type: 'agent_power', on: true, from: 'orb' });
  clock.advance(1400);
  voiceState('listening');
  clock.advance(900);
  const beforeTap = sent.length;
  route({ type: 'orb_listen', from: 'orb' });
  assert.deepEqual(sent.slice(beforeTap), [{ type: 'listen_finish' }]);
});

test('an unopened wake ignores a tap at 1499 ms and retries listening at 1500 ms', () => {
  const { clock, route, voiceState, logged, sent, said, nothingHeard } = sidecar();
  route({ type: 'agent_power', on: true, from: 'orb' });
  const beforeTap = sent.length;
  const beforeLog = logged.length;
  clock.advance(1499);
  route({ type: 'orb_listen', from: 'orb' });
  const early = sent.slice(beforeTap);
  const earlyLogs = logged.slice(beforeLog);
  clock.advance(1);
  route({ type: 'orb_listen', from: 'orb' });
  assert.deepEqual({ early, earlyLogs, later: sent.slice(beforeTap) }, {
    early: [], earlyLogs: [['orb_listen', { ignored: 'wake_opening' }]], later: [{ type: 'listen', via: 'orb' }],
  });
  voiceState('listening');
  voiceState('idle');
  assert.deepEqual(said, [tapRetry], 'the fresh tap gets feedback even if the queued wake listen opened first');
  nothingHeard();
  assert.deepEqual(said, [tapRetry], 'the helper cannot add a second line');
});

for (const delay of [2500, 9000]) {
  test(`the Mac's quiet wake take gets one retry after opening at ${delay} ms`, () => {
    const { clock, power, route, voiceState, said } = sidecar();
    route({ type: 'agent_power', on: true, from: 'orb' });
    clock.advance(delay);
    voiceState('listening');
    voiceState('processing');
    voiceState('idle');
    assert.equal(power.asleep, false);
    assert.deepEqual(said, [tapRetry]); // The Mac skips nothing_heard for via: 'wake'.
  });
}

for (const [from, why, delay] of [['orb', 'orb', 1600], ['web', 'clap', 1600], ['web', 'orb', 11_000]]) {
  test(`the ${from} tap at ${delay} ms claims the queued wake take from ${why} and speaks once`, () => {
    const { clock, power, route, voiceState, sent, said } = sidecar();
    route({ type: 'agent_power', on: true, from: why });
    clock.advance(delay);
    const beforeTap = sent.length;
    route({ type: 'orb_listen', from });
    assert.deepEqual(sent.slice(beforeTap), [{ type: 'listen', via: 'orb' }]);
    voiceState('listening'); // The helper opens the queued wake listen and ignores the later orb listen.
    voiceState('processing');
    voiceState('idle');
    assert.deepEqual({ asleep: power.asleep, said }, { asleep: false, said: [tapRetry] });
  });
}

test('wake flag matches at 9999 ms and expires at 10000 ms from the listen send', () => {
  const lines = [];
  for (const delay of [9999, 10_000]) {
    const { clock, route, voiceState, sent, said } = sidecar({ wakeCueDelay: 250 });
    route({ type: 'agent_power', on: true, from: 'orb' });
    assert.deepEqual(sent.at(-1), { type: 'listen', via: 'wake', wait: 8 });
    assert.equal(clock.now(), 250, 'the cue delayed the listen send');
    clock.advance(delay);
    voiceState('listening');
    voiceState('idle');
    lines.push(said);
  }
  assert.deepEqual(lines, [[tapRetry], []]);
});

for (const [keys, mode, delay, line] of [['hold', 'hold', 1000, helperRetry], ['tap', 'handsfree', 3000, tapRetry]]) {
  test(`an empty keys ${keys} at ${delay} ms after an unopened wake gets one line`, () => {
    const { clock, power, route, voiceState, nothingHeard, said } = sidecar();
    route({ type: 'agent_power', on: true, from: 'orb' });
    clock.advance(delay);
    voiceState('listening', mode);
    voiceState('processing');
    voiceState('idle');
    nothingHeard();
    assert.equal(power.asleep, false);
    assert.deepEqual(said, [line]);
  });
}

test('a new listening restarts the capped hold after a lost idle, including through processing', () => {
  const { clock, power, voiceState, state } = sidecar();
  const minute = 60_000;
  power.talked();
  voiceState('listening');
  // A running turn keeps Hydra awake past the first take's hold and five-minute idle countdown.
  state.busy = true;
  clock.advance(8 * minute);
  state.busy = false;
  clock.advance(2 * minute);
  assert.equal(state.voiceBusy, true, 'the first take never sent idle');
  voiceState('listening');
  clock.advance(2 * minute);
  voiceState('processing');
  clock.advance(2 * minute);
  assert.equal(power.asleep, false, 'still awake four minutes after the new listening');
  clock.advance(4 * minute - 1);
  assert.equal(power.asleep, false, 'the new hold gets its own five-minute idle countdown');
  clock.advance(1);
  assert.equal(power.asleep, true, 'processing keeps the same hold cap');
});

test('a talk wake sends no second listen and arbitrary agent_power reasons stay provisional', () => {
  const { clock, power, route, logged, sent, said } = sidecar();
  power.talked();
  clock.advance(12_000);
  assert.deepEqual(logged.at(-1), ['power', { asleep: false, why: 'talk' }]);
  assert.deepEqual(sent.filter(({ type }) => ['cue', 'listen'].includes(type)), []);
  for (const from of ['orb ', 'custom']) {
    power.sleep();
    route({ type: 'agent_power', on: true, from });
    assert.deepEqual(sent.at(-1), { type: 'listen', via: 'wake', wait: 8 });
    clock.advance(12_000);
    assert.deepEqual(logged.at(-1), ['power', { asleep: true, why: 'unconfirmed' }]);
  }
  assert.deepEqual(said, []);
});

test('a helper restart leaves confirmation of a provisional wake to its timer', () => {
  const { clock, power, route, voiceState, onVoice, logged, said } = sidecar();
  route({ type: 'agent_power', on: true, from: 'clap' });
  voiceState('listening');
  clock.advance(100);
  onVoice({ type: 'voice_ready' });
  assert.equal(power.asleep, false, 'a lost take is not an empty take');
  clock.advance(11_900);
  assert.deepEqual(logged.at(-1), ['power', { asleep: true, why: 'unconfirmed' }]);
  assert.deepEqual(said, []);
});

for (const event of ['idle', 'cancel', 'error', 'ready', 'disable', 'sleep']) {
  test(`${event} clears a wake whose take has not opened`, () => {
    const { clock, power, route, voiceState, onVoice, voiceConfig, said, state } = sidecar();
    route({ type: 'agent_power', on: true, from: 'web' });
    clock.advance(100);
    if (event === 'idle') voiceState('idle');
    if (event === 'cancel') route({ type: 'listen_cancel' });
    if (event === 'error') onVoice({ type: 'voice_error', code: 'recognition' });
    if (event === 'ready') onVoice({ type: 'voice_ready' });
    if (event === 'disable') {
      state.config.voice = false;
      voiceConfig();
      state.config.voice = true;
      voiceConfig();
    }
    if (event === 'sleep') { power.sleep(); power.talked(); }
    voiceState('listening');
    voiceState('idle');
    assert.deepEqual(said, event === 'error' ? ['Recognition failed'] : [], 'the later ordinary take gives no tap retry');
  });
}

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
