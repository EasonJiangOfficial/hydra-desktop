// Build 4 lane E, review round 3: each block fails without its fix. Nothing here reaches the Mac: the hands helper is
// a stub written below, and open, osascript, screencapture and sips are stubs on PATH.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'b4fix3-'));
process.env.ROAMIES_DATA_DIR = path.join(tmp, 'data');
process.env.HOME = path.join(tmp, 'home'); fs.mkdirSync(process.env.HOME);
const bin = path.join(tmp, 'bin'), launched = path.join(tmp, 'launched.log');
fs.mkdirSync(bin);
for (const c of ['open', 'osascript', 'screencapture', 'sips']) fs.writeFileSync(path.join(bin, c), `#!/bin/sh\necho ${c} "$@" >> '${launched}'\nexit 0\n`, { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;
// The hands helper: a stub. STUB_STATE mode: 'vault' (1Password runs, no window on screen), 'gone' (nothing runs:
// every window lookup fails) or 'notes' (Notes in front).
const stub = path.join(tmp, 'hands.mjs'), stState = path.join(tmp, 'st.json'), stLog = path.join(tmp, 'log.jsonl');
fs.writeFileSync(stub, `import fs from 'node:fs';
const a = process.argv.slice(2), s = JSON.parse(fs.readFileSync(${JSON.stringify(stState)}, 'utf8'));
fs.appendFileSync(${JSON.stringify(stLog)}, JSON.stringify({ a }) + '\\n');
const out = (o) => { console.log(JSON.stringify(o)); process.exit(0); };
const none = { ok: false, error: 'No matching window' };
const w = s.mode === 'vault' ? { id: 7, pid: 70, app: '1Password', title: '1Password', bounds: [0, 0, 800, 600] } : { id: 1, pid: 10, app: 'Notes', title: 'Notes', bounds: [0, 0, 800, 600] };
if (a[0] === 'resolve') out(s.mode === 'vault' ? { ok: true, window: null, running: '1Password', runningPid: 70 } : s.mode === 'gone' ? { ok: true, window: null } : { ok: true, window: w, running: 'Notes', runningPid: 10 });
if (s.mode === 'gone' && ['locate', 'ui', 'act', 'capture'].includes(a[0])) out(none);
if (a[0] === 'locate') out({ ok: true, window: w });
if (a[0] === 'front') out({ ok: true, app: w.app, pid: w.pid });
if (a[0] === 'act') out({ ok: true, done: ['ran'], window: w });
if (a[0] === 'manage') out({ ok: true, done: 'done' });
if (a[0] === 'windows') out({ ok: true, windows: s.mode === 'gone' ? [] : [w], all: true });
out({ ok: true });
`);
process.env.ROAMIES_HANDS = stub;

const { askForTake, spokenAnswer, trackAsk } = await import('../voiceturn.mjs');
const { createSpeaker } = await import('../speaker.mjs');
const { approveAllSays, checkWindow, isPasswordApp, stepsLose } = await import('../safety.mjs');
const { createTools } = await import('../tools.mjs');
const S = await import('../store.mjs');
const { ClaudeCodeAgent } = await import('../claudecode.mjs');
const { agentEvents } = await import('../agentstream.mjs');
const side = fs.readFileSync(new URL('../sidekick.mjs', import.meta.url), 'utf8');
const tauri = new URL('../../src-tauri/', import.meta.url);
const mainRs = fs.readFileSync(new URL('src/main.rs', tauri), 'utf8'), voiceRs = fs.readFileSync(new URL('src/voice.rs', tauri), 'utf8');
const swift = fs.readFileSync(new URL('voice/main.swift', tauri), 'utf8');

function fakeClock() {
  let t = 0, timers = [];
  return {
    now: () => t,
    setTimer: (f, ms) => { const h = { f, at: t + ms, unref() {} }; timers.push(h); return h; },
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
// A piece of sidekick.mjs run on its own, its outer names given by st (with): from `from` up to `to`.
function piece(from, to, names, st) {
  const a = side.indexOf(from), b = side.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `sidekick.mjs has ${from}`);
  return new Function('st', `with (st) { ${side.slice(a, b)}; return { ${names.join(', ')} }; }`)(st);
}
// The ask machinery of sidekick.mjs on a fake clock: askPlayed, askArm, askTakeEnd, asksAsleep, and setPaused.
function askRig({ paused = false } = {}) {
  const c = fakeClock(), sent = [];
  let marks = 0;
  const V = { id: 's1', progress: () => `s1q${++marks}` };
  const st = { power: { asleep: false }, voicePaused: paused, yesNoOpen: new Map(), turnVoice: V, voiceBusy: false, askTake: null, send: (m) => sent.push(m),
    nativeSpeech: () => {}, pushWeb: () => {}, Date: { now: c.now }, setTimeout: (f, ms) => c.setTimer(f, ms), clearTimeout: (h) => h && c.clearTimer(h) };
  Object.assign(st, piece('function askPlayed(mark) {', 'function showAsk(', ['askPlayed', 'askArm', 'askTakeEnd', 'asksAsleep'], st));
  Object.assign(st, piece('function setPaused(on) {', "// Hydra's voice on the Mac plays", ['setPaused'], st));
  const ask = (id, question = 'Can I quit Safari?') => {
    const shown = [];
    const w = { voice: V, to: (m) => shown.push(m), shown };
    w.a = trackAsk({ id, route: 'overlay', question, choices: true, voice: V, resolve: (v) => { w.answer = v; st.askTakeEnd(id); st.yesNoOpen.delete(id); }, ...c });
    st.yesNoOpen.set(id, w);
    return w;
  };
  return { c, sent, st, ask, types: () => sent.map((m) => m.type).filter((t) => t !== 'ui') };
}

// ---- 1. Asleep, an ask's take never opens (its timer, the idle re-arm), and a voiced ask with no signal ends.
{
  const r = askRig();
  const w = r.ask('a1', 'Save the skill "x"?');
  r.st.askPlayed(w.a.mark); // its question played: its take's timer is armed
  r.c.advance(100);
  r.st.power.asleep = true; // the sleep word
  r.c.advance(3000);
  assert.deepEqual(r.types(), [], 'the armed timer opens nothing asleep');
  r.st.askArm('a1', w); r.c.advance(2000); // the helper's idle after the sleep-word take re-arms it
  assert.deepEqual(r.types(), [], 'nor the idle re-arm');
  r.st.asksAsleep();
  assert.equal(w.answer, null, 'the voiced ask ends as a no');
  assert.deepEqual(w.shown, [{ kind: 'cancel_ask', id: 'a1' }], 'and leaves the screen');
  assert.match(side, /if \(asleep\) \{ asksAsleep\(\); speech\.stop\(\); send\(\{ type: 'listen_cancel' \}\);/, 'the sleep runs it');
}

// ---- 2. Only the question's own audio counts, as the player played it (build4efix4, principle 1): narration before it,
// a slow voice or a late sentence never make it heard; its mark comes back only after its last audio.
{
  const r = askRig();
  const w = r.ask('a1');
  r.c.advance(20_000); // narration plays, the question's own audio is late (a slow voice, a slow sentence request)
  assert.deepEqual(r.types(), [], 'no take before the question played');
  assert.equal(askForTake(r.st.yesNoOpen, { text: 'yes', takeAt: 19_000 }), null, 'and no word answers it');
  r.st.askPlayed(w.a.mark); // the player: all of it has played
  assert.equal(w.a.heardAt, 20_000, 'heard when the player says');
  r.c.advance(400);
  assert.deepEqual(r.types(), ['listen'], 'then its take opens');
  // The voices give the mark after the question's last audio, never before it (both engines).
  const out = [];
  let sv = null;
  class Studio {
    constructor(o) { Object.assign(this, o); sv = this; this.q = []; }
    open() { return this; }
    say(t, done) { this.q.push([t, done]); }
    // VoiceStudio sends a sentence's audio, then its "done".
    sentence() { const [, done] = this.q.shift(); this.onAudio(new Int16Array(4410), 44100); this.onAudio(new Int16Array(4410), 44100); done?.(); }
    end() { this.onEnd(); }
    abort() {}
  }
  const sp = createSpeaker({ emit: (m) => out.push(m), LocalVoiceImpl: Studio, localStatus: async () => ({ ok: true }), bundled: () => null, keepWarmMs: 1e9 });
  sp.setProvider('voicestudio');
  const v = sp.start();
  v.say("Sure, I'll quit Safari for you now.");
  const m = v.progress('Can I quit Safari? Say yes or no.', 'ask');
  assert.match(m, /^s\d+q1$/, 'an ask gives back its mark');
  assert.deepEqual(out.filter((x) => x.mark), [], 'not before any audio');
  sv.sentence(); // the narration's audio
  assert.deepEqual(out.filter((x) => x.mark), [], 'nor after the narration');
  sv.sentence(); // the question's
  assert.deepEqual(out.slice(-1), [{ kind: 'speech', id: v.id, mark: m }], 'right after the last of its audio');
  assert.equal(out.filter((x) => x.pcm).length, 4);
  // Fish: the socket that said the question is sealed (stop), so its end is all of it; the reply goes on in a new one
  // whose audio waits for the old one's.
  const socks = [], fout = [];
  class Fish {
    constructor(o) { Object.assign(this, o); this.said = []; socks.push(this); }
    open() { this.opened = true; return this; }
    say(t) { this.said.push(t); }
    end() { this.ended = true; }
    abort() {}
    rebind(cbs) { Object.assign(this, cbs); return true; }
  }
  const fish = createSpeaker({ emit: (x) => fout.push(x), FishVoiceImpl: Fish, account: async () => ({ ok: true, credit: 4 }), beatPhrases: [], bundled: () => null });
  fish.setKey('k'); await new Promise((res) => setTimeout(res, 0));
  const f = fish.start();
  f.say('Opening it.');
  const fm = f.progress('Can I quit Safari? Say yes or no.', 'ask');
  assert.match(fm, /^s\d+q1$/);
  assert.equal(socks.length, 2, 'a new socket for after the question');
  assert.deepEqual([socks[0].said, socks[0].ended], [['Opening it.', 'Can I quit Safari? Say yes or no.'], true], 'the question sealed its socket');
  assert.equal(socks[1].opened, undefined, 'the next one opens with its first sentence');
  socks[0].onAudio(new Uint8Array(8));
  f.say('Quit it.'); socks[1].onAudio(new Uint8Array(4)); // the answer after a quick yes: its audio waits
  assert.equal(fout.filter((x) => x.pcm).length, 1, 'held behind the question');
  assert.deepEqual(fout.filter((x) => x.mark), [], 'no mark while the question still comes');
  socks[0].onAudio(new Uint8Array(8)); socks[0].onEnd();
  const tail = fout.slice(-3).map((x) => (x.mark ? `mark ${x.mark}` : x.pcm ? `pcm ${Buffer.from(x.pcm, 'base64').length}` : JSON.stringify(x)));
  assert.deepEqual(tail, ['pcm 8', `mark ${fm}`, 'pcm 4'], 'the question, its mark, then the answer');
  f.end(); assert.equal(socks[1].ended, true); socks[1].onEnd();
  assert.equal(fout.at(-1).end, true, 'the reply ends after its last socket');
}

// ---- 3. The owner's own pause holds the player, so a question still to play reports nothing (no take, no spoken
// answer) until it has played; setPaused only passes the pause on.
{
  const r = askRig({ paused: true });
  const w = r.ask('a1');
  r.c.advance(10_000);
  assert.deepEqual(r.types(), [], 'paused: no take');
  assert.equal(w.a.heardAt, null);
  assert.equal(askForTake(r.st.yesNoOpen, { text: 'yes', takeAt: 3300 }), null, 'paused: no word answers it');
  r.st.setPaused(false);
  r.c.advance(5000);
  assert.deepEqual(r.types(), [], 'unpaused: still not before it played');
  r.st.askPlayed(w.a.mark); r.c.advance(400);
  assert.deepEqual(r.types(), ['listen'], 'then its take');
  // The players hold their report while paused (hydraout.swift PlayMarks, voice-out.js by the audio clock).
  assert.match(fs.readFileSync(new URL('voice/hydraout.swift', tauri), 'utf8'), /completionCallbackType: \.dataPlayedBack/, 'the helper counts what was played out');
}

// ---- 4. An acknowledgement is no answer to a yes/no.
{
  const q = 'Can I quit Safari anyway?';
  for (const t of ['okay thanks', 'okay, thank you', 'ok thanks hydra', 'alright thank you hydra', 'Okay. Thanks.']) assert.equal(spokenAnswer(t, q), null, t);
  for (const t of ['yes thanks', 'yes please', 'sure', 'go ahead', "I don't mind", 'okay', 'yes, thank you']) assert.equal(spokenAnswer(t, q), 'yes', t);
  for (const t of ['no thanks', 'no thank you', 'nope']) assert.equal(spokenAnswer(t, q), 'no', t);
}

// ---- 5. An ask closes only its own take: the helper says which take it opened, and its cancel names the ask.
{
  const r = askRig();
  r.st.askPlayed(r.ask('a1').a.mark); r.c.advance(3000);
  assert.deepEqual(r.sent, [{ type: 'listen', via: 'ask', wait: 8 }]);
  // The owner pressed the talk keys as it was sent: the helper's take is his (no ask: true).
  r.st.m = { type: 'voice_state', state: 'listening', mode: 'hold' };
  new Function('st', `with (st) { ${side.slice(side.indexOf("  // A take the helper says isn't the ask's"), side.indexOf('  // Any take while Hydra works'))} }`)(r.st);
  assert.equal(r.st.askTake, null, "his take isn't the ask's");
  r.st.askTakeEnd('a1');
  assert.deepEqual(r.sent.slice(1), [], 'so the ask ending never cancels it');
  // Its own take: closed with only: 'ask'.
  const q = askRig();
  q.st.askPlayed(q.ask('a1').a.mark); q.c.advance(3000);
  q.st.m = { type: 'voice_state', state: 'listening', mode: 'handsfree', ask: true };
  new Function('st', `with (st) { ${side.slice(side.indexOf("  // A take the helper says isn't the ask's"), side.indexOf('  // Any take while Hydra works'))} }`)(q.st);
  assert.equal(q.st.askTake?.id, 'a1');
  q.st.askTakeEnd('a1');
  assert.deepEqual(q.sent.at(-1), { type: 'listen_cancel', only: 'ask' });
  // The bridge and the helper carry it.
  assert.match(mainRs, /Some\("listen_cancel"\) => to_voice\(app, &json!\(\{ "cmd": "cancel", "only": msg\.get\("only"\)/);
  assert.match(voiceRs, /"type": "voice_state", "state": msg\.get\("state"\), "mode": msg\.get\("mode"\), "ask": msg\.get\("ask"\)/);
  assert.match(swift, /func externalCancel\(onlyAsk: Bool = false\) \{\n        guard Self\.cancels\(onlyAsk: onlyAsk, askTake: askTake\) else \{ return \}/);
  assert.match(swift, /"state": "listening", "mode": mode, "wave": cursor, "ask": askTake\]/);
  assert.match(swift, /if chord && !prevChord && !blocked \{ phase = \.holding; releasedAt = nil; askTake = false; return \}/, 'his keys take the ask\'s take over');
}

// ---- 7-11. Approve all: password managers shown or opened, delete chords, replace-all plans, more vault apps.
const noop = async () => {};
const run = async (mode, fn, { owner = () => null } = {}) => {
  fs.writeFileSync(stState, JSON.stringify({ mode })); fs.writeFileSync(stLog, ''); fs.writeFileSync(launched, '');
  const asks = [];
  const ask = async (o) => { const auto = approveAllSays(true, o); const q = String(o.placeholder).split('\n')[0]; asks.push({ auto, deletion: o.deletion, q }); return auto ? 'yes' : owner(q); };
  const t = createTools({ allowActions: () => true, ui: () => {}, openUrl: noop, onCommitments: noop, showList: noop, fmtWhen: String, commitmentsText: () => '', userName: 'Test', workdir: tmp, ask });
  t.nextTurn?.();
  const r = await fn((n) => t.tools.find((x) => x.name === n)).then(String, (e) => `ERR ${e.message}`);
  return { asks, r, calls: fs.readFileSync(stLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).a), opened: fs.readFileSync(launched, 'utf8') };
};
const tags = (x) => x.asks.map((a) => [a.auto, a.deletion]);
{
  // 7. manage_app switch / arrange on a password manager.
  for (const args of [{ do: 'switch', app: '1Password' }, { do: 'arrange', app: '1Password', layout: 'full' }]) {
    const x = await run('vault', (T) => T('manage_app').execute(args, {}));
    assert.deepEqual(tags(x), [[true, true]], `${args.do} 1Password runs under Approve all: ${JSON.stringify(x)}`);
    assert.ok(x.calls.some((c) => c[0] === 'manage'), `${args.do}: it ran`);
  }
  const plain = await run('notes', (T) => T('manage_app').execute({ do: 'switch', app: 'Notes' }, {}));
  assert.deepEqual(tags(plain), [[true, false]], 'Notes still runs under Approve all');
  // 8. open, read_window and act_in_app opening a password manager.
  for (const args of [{ target: '1Password' }, { target: 'https://example.com', app: '1Password' }, { target: '/Applications/1Password.app' }]) {
    const x = await run('gone', (T) => T('open').execute(args, {}));
    assert.deepEqual(tags(x), [[true, true]], `open ${JSON.stringify(args)} runs under Approve all`);
    assert.match(x.opened, /1Password/, 'it opened');
  }
  const rw = await run('gone', (T) => T('read_window').execute({ target: '1Password' }, {}));
  assert.deepEqual(tags(rw), [[true, true]], `read_window opening 1Password runs under Approve all: ${JSON.stringify(rw)}`);
  assert.match(rw.opened, /1Password/);
  const act = await run('gone', (T) => T('act_in_app').execute({ target: '1Password', steps: [{ do: 'key', key: 'tab' }] }, {}), { owner: (q) => (q.startsWith('In ') ? 'yes' : null) });
  assert.deepEqual(tags(act), [[true, true], [true, true]], `the plan and the launch both run under Approve all: ${JSON.stringify(act)}`);
  assert.match(act.opened, /1Password/, 'it launched');
  // 9, 10 (build4efix4: one safe-step whitelist, safety.mjs stepsLose). Delete keys and chords, selections, replace-all
  // plans, cut, copy, paste, fill and any key not in the safe set are deletions. Approve all runs them.
  for (const steps of [[{ do: 'key', key: 'cmd+a' }, { do: 'key', key: 'ctrl+h' }], [{ do: 'key', key: 'cmd+a' }, { do: 'type', text: 'x' }], [{ do: 'key', key: 'cmd+a' }, { do: 'key', key: 'cmd+x' }],
    [{ do: 'key', key: 'cmd+a' }, { do: 'key', key: 'x' }], [{ do: 'key', key: 'ctrl+d' }], [{ do: 'key', key: 'ctrl+k' }], [{ do: 'key', key: 'control+h' }]]) {
    assert.equal(stepsLose(steps), true, JSON.stringify(steps));
    const x = await run('notes', (T) => T('act_in_app').execute({ target: 'Notes', steps }, {}));
    assert.deepEqual(tags(x), [[true, true]], `ran: ${JSON.stringify(steps)} ${JSON.stringify(x)}`);
    assert.ok(x.calls.some((c) => c[0] === 'act'), 'it ran');
  }
  for (const steps of [[{ do: 'type', text: 'hello' }], [{ do: 'click_text', text: 'Next' }, { do: 'key', key: 'return' }, { do: 'key', key: 'tab' }, { do: 'key', key: 'shift+tab' },
    { do: 'key', key: 'escape' }, { do: 'key', key: 'down' }, { do: 'key', key: 'cmd+left' }, { do: 'scroll', direction: 'down' }, { do: 'wait', seconds: 1 }, { do: 'focus', id: 2 }, { do: 'hover', text: 'Menu' }, { do: 'click_at', x: 1, y: 2 }]]) {
    assert.equal(stepsLose(steps), false, JSON.stringify(steps));
  }
  const ok = await run('notes', (T) => T('act_in_app').execute({ target: 'Notes', steps: [{ do: 'type', text: 'hello' }] }, {}));
  assert.deepEqual(tags(ok), [[true, false]], 'typing alone runs under Approve all');
  const tools = fs.readFileSync(new URL('../tools.mjs', import.meta.url), 'utf8');
  assert.match(tools, /it replaces what's there\)\?\\n\$\{m\.text\}`, undefined, \{ deletion: true \}/, "draw's clipboard replace asks");
  assert.match(tools, /\{ deletion: planDeletion\(steps, \[where, app\.app\]\) \}/, "draw's typing takes the same rule");
  // 11. Password managers and 2FA apps, by the list and by a name or bundle id pattern.
  for (const a of ['MacPass', 'Secrets 4', '1Password Beta', 'Authy Desktop', 'Google Authenticator', 'KeePassXC', 'Bitwarden', 'Strongbox', 'Dashlane', 'Keeper', 'LastPass', 'Enpass', 'NordPass',
    'Proton Pass', 'RoboForm', 'Keychain Access', 'Apple Passwords', 'Passwords', 'Microsoft Authenticator', '2FAS', 'Raivo', 'Step Two', 'OTP Auth', 'com.agilebits.onepassword7', 'OTP Manager', 'Vault 7', 'Passwordless Demo']) {
    assert.equal(isPasswordApp(a), true, a);
    assert.equal(checkWindow({ app: a }, os.homedir()).secret, true, `${a}'s window is a secret read`);
  }
  for (const a of ['Notes', 'Safari', 'Secret Santa', 'Hotpot', 'Spotify', 'Photos']) assert.equal(isPasswordApp(a), false, a);
}

// ---- 12. Folding goes on when the first reply was plain and every later one asks; the kept part ends under the trigger.
{
  const big = (n, end) => `${'word '.repeat(n)}${end}`;
  const m = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'Hello.' }];
  for (let i = 0; i < 12; i++) m.push({ role: 'user', content: big(3000, 'do it') }, { role: 'assistant', content: big(3000, 'Want me to go on?') });
  m.push({ role: 'user', content: 'yes' });
  const p = S.planFold(m, { trigger: 90000 });
  assert.equal(p.ok, true, p.reason);
  const m2 = [];
  for (let i = 0; i < 14; i++) m2.push({ role: 'user', content: big(3000, 'do it') }, { role: 'assistant', content: big(3000, i === 1 ? 'Done.' : 'Want me to go on?') });
  m2.push({ role: 'user', content: 'yes' });
  const p2 = S.planFold(m2, { trigger: 90000 });
  assert.equal(p2.ok, true);
  assert.ok(S.approxTokens(m2.slice(p2.end)) < 90000, `kept under the trigger: ${S.approxTokens(m2.slice(p2.end))}`);
}

// ---- 13, 14. Every word added stays in the saved history, after what Claude Code had sent before it; a later run
// never sends it again.
{
  const SESSION = 's1', ev = (event) => ({ type: 'stream_event', event, parent_tool_use_id: null, session_id: SESSION });
  const scenario = async (mode, late) => {
    let agent; const ctl = new AbortController(); const uuids = [], firsts = [];
    let runs = 0;
    const query = ({ prompt }) => {
      const inputs = prompt[Symbol.asyncIterator]();
      const n = ++runs;
      async function* go() {
        const h = await inputs.next(); uuids.push(h.value.uuid); firsts.push(JSON.stringify(h.value));
        yield { type: 'system', subtype: 'init', session_id: SESSION };
        yield ev({ type: 'message_start', message: { id: `m${n}`, usage: { input_tokens: 5 } } });
        yield { type: 'assistant', parent_tool_use_id: null, message: { id: `m${n}`, model: 'claude-opus-5-5', content: [{ type: 'text', text: n === 1 ? 'Here are the orbs.' : 'Sure.' }] } };
        if (n === 1) {
          if (late) await new Promise((r) => setTimeout(r, 50)); // mapped before the addition (13), or not yet (14)
          agent.addInput('[added] and the volume one too');
          if (mode === 'stop') ctl.abort();
        }
        yield ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } });
        yield ev({ type: 'message_stop' });
        if (n === 1 && mode === 'error') { yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'], session_id: SESSION, user_message_uuids: uuids }; return; }
        yield { type: 'result', subtype: mode === 'stop' && n === 1 ? 'error_during_execution' : 'success', is_error: false, result: 'x', session_id: SESSION, user_message_uuids: uuids };
      }
      const q = go(); q.interrupt = async () => {}; q.close = () => {}; q.getContextUsage = async () => null; return q;
    };
    agent = new ClaudeCodeAgent({ model: 'claude-opus-5-5', system: 's', tools: [], executable: '/bin/claude', cwd: '/', env: {}, query, onRateLimit: () => {}, connectors: true, signal: ctl.signal });
    try { for await (const e of agentEvents(agent.prompt('show me the orbs'))) void e; } catch { /* error: below */ }
    const hist = agent.getMessages().filter((x) => x.role !== 'system').map((x) => [x.role, typeof x.content === 'string' ? x.content : x.content.map((p) => p.text ?? p.type).join('')]);
    assert.deepEqual(hist, [['user', 'show me the orbs'], ['assistant', 'Here are the orbs.'], ['user', '[added] and the volume one too']], `${mode}${late ? ' late' : ''}: kept, after the reply sent before it`);
    assert.deepEqual(agent.unanswered(), ['[added] and the volume one too'], 'and still named unanswered');
    if (mode === 'end' && late) {
      agent.setSignal(new AbortController().signal);
      for await (const e of agentEvents(agent.prompt('and now?'))) void e;
      assert.ok(firsts[1].includes('and now?'), 'the next run sends its own words');
      assert.ok(!firsts[1].includes('[added]'), 'never the addition again (the resumed session has it)');
    }
  };
  for (const mode of ['end', 'error', 'stop']) await scenario(mode, true);
  await scenario('end', false);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('build4efix3: all passed');
