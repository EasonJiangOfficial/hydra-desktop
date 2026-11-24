// Build 4 lane E, final round 2 (B4-final-round2-findings.json): each block fails without its fix. Nothing here
// reaches the Mac: the hands helper is a stub written below; open, osascript, screencapture, sips, pbcopy and pbpaste
// are stubs on PATH; the voice is a fake socket and the overlay's player runs in a vm on a fake clock.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'b4fix4-'));
process.env.ROAMIES_DATA_DIR = path.join(tmp, 'data');
process.env.HOME = path.join(tmp, 'home'); fs.mkdirSync(process.env.HOME);
const bin = path.join(tmp, 'bin'), launched = path.join(tmp, 'launched.log');
fs.mkdirSync(bin);
for (const c of ['open', 'osascript', 'screencapture', 'sips', 'pbcopy', 'pbpaste']) fs.writeFileSync(path.join(bin, c), `#!/bin/sh\necho ${c} "$@" >> '${launched}'\nexit 0\n`, { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;
// The hands helper: a stub. mode 'reask': its first act stops at step 1 asking for a yes for the whole plan in
// TextEdit (the app changed); every other act runs.
const stub = path.join(tmp, 'hands.mjs'), stState = path.join(tmp, 'st.json'), stLog = path.join(tmp, 'log.jsonl'), acts = path.join(tmp, 'acts');
fs.writeFileSync(stub, `import fs from 'node:fs';
const a = process.argv.slice(2), s = JSON.parse(fs.readFileSync(${JSON.stringify(stState)}, 'utf8'));
fs.appendFileSync(${JSON.stringify(stLog)}, JSON.stringify({ a }) + '\\n');
const out = (o) => { console.log(JSON.stringify(o)); process.exit(0); };
const w = { id: 1, pid: 10, app: 'Notes', title: 'Notes', bounds: [0, 0, 800, 600] };
if (a[0] === 'resolve') out({ ok: true, window: w, running: 'Notes', runningPid: 10 });
if (a[0] === 'locate') out({ ok: true, window: w });
if (a[0] === 'front') out({ ok: true, app: w.app, pid: w.pid });
if (a[0] === 'act') {
  const n = +(fs.existsSync(${JSON.stringify(acts)}) ? fs.readFileSync(${JSON.stringify(acts)}, 'utf8') : 0);
  fs.writeFileSync(${JSON.stringify(acts)}, String(n + 1));
  if (s.mode === 'reask' && n === 0) out({ ok: false, needsConfirm: true, whole: 'plan', step: 1, app: 'TextEdit', done: ['pressed cmd+a'] });
  out({ ok: true, done: ['ran'], window: w });
}
if (a[0] === 'windows') out({ ok: true, windows: [w], all: true });
out({ ok: true });
`);
process.env.ROAMIES_HANDS = stub;

const { askForTake, spokenAnswer, trackAsk, retryText } = await import('../voiceturn.mjs');
const { createSpeaker } = await import('../speaker.mjs');
const { approveAllSays, isPasswordApp, planDeletion, stepsLose } = await import('../safety.mjs');
const { createTools } = await import('../tools.mjs');
const { ClaudeCodeAgent } = await import('../claudecode.mjs');
const { agentEvents } = await import('../agentstream.mjs');
const { relaySession } = await import('../relay.mjs');
const { parseBrain, parseLesson, parseSkill } = await import('../brain.mjs');
const side = fs.readFileSync(new URL('../sidekick.mjs', import.meta.url), 'utf8');
const tauri = new URL('../../src-tauri/', import.meta.url);
const voiceRs = fs.readFileSync(new URL('src/voice.rs', tauri), 'utf8');
const mainSwift = fs.readFileSync(new URL('voice/main.swift', tauri), 'utf8');
const hostJs = fs.readFileSync(new URL('../../roamies/host.js', tauri), 'utf8');
const voiceOutJs = fs.readFileSync(new URL('../../roamies/voice-out.js', tauri), 'utf8');

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
// The overlay's player (showcase/roamies/voice-out.js) on the fake clock: its audio clock is the clock's seconds.
function overlayPlayer(c) {
  const noop = () => {};
  let suspended = false, frozenAt = 0;
  class AudioContext {
    constructor() { this.state = 'running'; this.destination = {}; }
    get currentTime() { return suspended ? frozenAt : c.now() / 1000; }
    resume() { if (suspended) { suspended = false; } return Promise.resolve(); }
    suspend() { suspended = true; frozenAt = c.now() / 1000; return Promise.resolve(); }
    createGain() { return { gain: { value: 1, cancelScheduledValues: noop, setValueAtTime: noop, linearRampToValueAtTime: noop }, connect: noop }; }
    createAnalyser() { return { connect: noop, getFloatTimeDomainData: noop }; }
    createBuffer(_c, n, rate) { return { duration: n / rate, getChannelData: () => new Float32Array(n) }; }
    createBufferSource() { return { connect: noop, stop: noop, start() {} }; }
  }
  const window = { Roamie: {} };
  vm.runInNewContext(voiceOutJs, { window, AudioContext, Float32Array, Math, Set, setTimeout: (f, ms) => c.setTimer(f, ms), atob: (s) => Buffer.from(s, 'base64').toString('latin1') });
  return window.Roamie.voiceOut;
}
const pcmOf = (secs, rate = 44100) => Buffer.alloc(Math.round(secs * rate) * 2).toString('base64');

// ---- 1. (medium, principle 1) A yes/no is answered only by a take that started after its question really finished
// playing: the player's report of the question's mark, never a characters-a-second guess. The finding's case: 120
// characters of narration handed to a voice slower than 14 characters a second (11.5), its 10.4 s of audio played,
// the question's own audio still to come.
{
  const c = fakeClock(), player = overlayPlayer(c), sent = [];
  const st = { power: { asleep: false }, yesNoOpen: new Map(), turnVoice: null, voiceBusy: false, askTake: null, send: (m) => sent.push(m),
    Date: { now: c.now }, setTimeout: (f, ms) => c.setTimer(f, ms), clearTimeout: (h) => h && c.clearTimer(h) };
  Object.assign(st, piece('function askPlayed(mark) {', 'function showAsk(', ['askPlayed', 'askArm', 'askTakeEnd'], st));
  player.onPlayed = (_id, mark) => st.askPlayed(mark);
  // The turn's voice: Fish sockets as fakes; what it emits goes to the overlay's player, as sidekick's ui() sends it.
  const socks = [];
  class Fish {
    constructor(o) { Object.assign(this, o); this.said = []; socks.push(this); }
    open() { return this; }
    say(t) { this.said.push(t); }
    end() { this.ended = true; }
    abort() {}
    rebind(cbs) { Object.assign(this, cbs); return true; }
  }
  const sp = createSpeaker({ emit: (m) => player.handle(m), FishVoiceImpl: Fish, account: async () => ({ ok: true, credit: 4 }), beatPhrases: [], bundled: () => null });
  sp.setKey('k'); await new Promise((res) => setTimeout(res, 0));
  const voice = sp.start();
  st.turnVoice = voice;
  voice.say('x'.repeat(119));
  const w = { voice };
  w.a = trackAsk({ id: 'a1', route: 'overlay', question: 'Can I quit Safari?', choices: true, voice, resolve: () => {}, ...c });
  st.yesNoOpen.set('a1', w);
  assert.equal(w.a.voiced, true, 'said aloud');
  for (let i = 0; i < 10; i++) socks[0].onAudio(new Uint8Array(Buffer.from(pcmOf(1.04), 'base64'))); // the narration, 10.4 s
  c.advance(11_000);
  assert.deepEqual(sent, [], 'its narration played: no take opens');
  assert.equal(w.a.heardAt, null, 'and the question is not heard');
  assert.equal(askForTake(st.yesNoOpen, { text: 'yes', takeAt: c.now() }), null, 'so a yes then answers nothing');
  socks[0].onAudio(new Uint8Array(Buffer.from(pcmOf(2), 'base64'))); socks[0].onEnd(); // the question's audio, then the sealed socket's end
  c.advance(1500);
  assert.deepEqual(sent, [], 'still playing: no take');
  c.advance(1000);
  assert.ok(Number.isFinite(w.a.heardAt), 'played to its end: heard');
  assert.equal(askForTake(st.yesNoOpen, { text: 'yes', takeAt: w.a.heardAt - 1 }), null, 'a take that began before it ended: no');
  assert.equal(askForTake(st.yesNoOpen, { text: 'yes', takeAt: w.a.heardAt })?.said, 'yes');
  c.advance(400);
  assert.deepEqual(sent, [{ type: 'listen', via: 'ask', wait: 8 }], 'its own take opens after it, once');
}
{
  // The overlay's player reports a mark only once its audio clock passed all that was queued before it; not while
  // paused, not when the Mac's voice helper plays it (native: the helper reports), never for a stopped reply.
  const c = fakeClock(), p = overlayPlayer(c), got = [];
  p.onPlayed = (id, mark) => got.push([id, mark, c.now()]);
  p.handle({ id: 's1', rate: 44100, pcm: pcmOf(1) }); p.handle({ id: 's1', mark: 'q1' });
  c.advance(1000);
  assert.deepEqual(got, [], 'a cushion and its second still to play');
  c.advance(200);
  assert.deepEqual(got.map((g) => g[1]), ['q1'], 'reported once played');
  p.handle({ id: 's1', rate: 44100, pcm: pcmOf(1) }); p.handle({ id: 's1', mark: 'q2' }); p.pause(true);
  c.advance(5000);
  assert.equal(got.length, 1, 'paused: nothing');
  p.pause(false); c.advance(1200);
  assert.deepEqual(got.map((g) => g[1]), ['q1', 'q2'], 'after the pause');
  p.handle({ id: 's2', rate: 44100, pcm: pcmOf(1) }); p.handle({ id: 's2', mark: 'q3' }); p.stop(); c.advance(5000);
  assert.equal(got.length, 2, 'a stopped reply never reports');
  p.setNative(true); p.handle({ id: 's3', rate: 44100, pcm: pcmOf(1) }); p.handle({ id: 's3', mark: 'q4' }); c.advance(5000);
  assert.equal(got.length, 2, 'native: the helper reports, not the overlay');
  // The bridge: the mark to the helper, its played back to the sidecar; the overlay's report to the sidecar.
  assert.match(voiceRs, /return Some\(json!\(\{ "cmd": "play_mark", "id": id, "mark": mark \}\)\);/);
  assert.match(voiceRs, /Some\("played"\) => to_sidecar\(app, &json!\(\{ "type": "voice_played"/);
  assert.match(mainSwift, /case "play_mark": if let id = msg\["id"\] as\? String, let m = msg\["mark"\] as\? String \{ DispatchQueue\.main\.async \{ voice\.out\.mark\(id: id, mark: m\) \} \}/);
  assert.match(mainSwift, /voice\.out\.onPlayed = \{ emit\(\["type": "played", "id": \$0, "mark": \$1\]\) \}/);
  assert.match(hostJs, /Roamie\.voiceOut\.onPlayed = \(id, mark\) => send\(\{ type: 'voice_played', id, mark \}\);/);
  assert.match(side, /else if \(m\.type === 'voice_played'\) askPlayed\(String\(m\.mark \?\? ''\)\);/);
}

// ---- 2. (low, principle 1) Clear yes words win over acknowledgement words; a bare acknowledgement is no answer.
{
  const q = 'Can I quit Safari?';
  for (const t of ["I don't mind, thanks", "I don't mind thank you", 'okay thanks, do it', 'okay, thank you, go for it', 'alright thanks, quit it', 'quit safari', 'sure thanks']) assert.equal(spokenAnswer(t, q), 'yes', t);
  for (const t of ['okay thanks', 'thanks', 'ok, thank you hydra', 'alright thank you', 'never mind']) assert.equal(spokenAnswer(t, q), null, t);
  for (const t of ["don't quit it", 'no thanks', 'no']) assert.equal(spokenAnswer(t, q), 'no', t);
  assert.equal(spokenAnswer('thanks, quit it later', q), null, 'other words are for the turn');
}

// ---- 3-6. Approve all is a safe-step whitelist (principle 3): a plan runs unasked only when every step is safe; a
// re-ask keeps the strongest tag; a fill, any selection, copy and cut are deletion-class.
const noop = async () => {};
const run = async (mode, steps, { owner = () => 'yes', on = true } = {}) => {
  fs.writeFileSync(stState, JSON.stringify({ mode })); fs.writeFileSync(stLog, ''); fs.writeFileSync(launched, ''); fs.rmSync(acts, { force: true });
  const asks = [];
  const ask = async (o) => { const auto = approveAllSays(on, o); asks.push({ auto, deletion: o.deletion, q: String(o.placeholder).split('\n')[0] }); return auto ? 'yes' : owner(o); };
  const t = createTools({ allowActions: () => true, ui: () => {}, openUrl: noop, onCommitments: noop, showList: noop, fmtWhen: String, commitmentsText: () => '', userName: 'Test', workdir: tmp, ask });
  t.nextTurn?.();
  const r = await t.tools.find((x) => x.name === 'act_in_app').execute({ target: 'Notes', steps }, {}).then(String, (e) => `ERR ${e.message}`);
  const n = fs.existsSync(acts) ? +fs.readFileSync(acts, 'utf8') : 0;
  // tags: the plan's asks (the look at the window after it is its own read, judged as one).
  return { asks, r, acts: n, tags: asks.filter((a) => a.q.startsWith('In ')).map((a) => [a.auto, a.deletion]) };
};
{
  // 3 (high). The helper re-asks after the app changed (TextEdit came forward): the re-ask carries the first ask's
  // deletion tag, though the select-all is before the steps left.
  const re = await run('reask', [{ do: 'key', key: 'cmd+a' }, { do: 'type', text: 'x' }]);
  assert.deepEqual(re.tags, [[true, true], [true, true]], `both run under Approve all: ${JSON.stringify(re)}`);
  assert.equal(re.asks[1].q, "In TextEdit, every step I'd take:");
  const no = await run('reask', [{ do: 'key', key: 'cmd+a' }, { do: 'type', text: 'x' }], { on: false, owner: (o) => (/TextEdit/.test(o.placeholder) ? null : 'yes') });
  assert.equal(no.acts, 1, 'Approve all off: a no to the re-ask stops it');
  const still = await run('reask', [{ do: 'key', key: 'tab' }, { do: 'key', key: 'delete' }]);
  assert.deepEqual(still.tags, [[true, true], [true, true]], 'a delete key in the steps left still runs under Approve all');
  const safe = await run('reask', [{ do: 'click_text', text: 'Compose' }, { do: 'type', text: 'hi' }]);
  assert.deepEqual(safe.tags, [[true, false], [true, false]], 'a safe plan stays safe when re-asked');
}
{
  // 4 (medium). act_in_app's fill (the helper presses cmd+a, then types) asks, as draw's does: one rule for both.
  const f = await run('plain', [{ do: 'fill', field: 'Body', text: 'x' }]);
  assert.deepEqual(f.tags, [[true, true]], JSON.stringify(f));
  assert.equal(f.acts, 1, 'Approve all runs the fill');
  const fno = await run('plain', [{ do: 'fill', field: 'Body', text: 'x' }], { on: false, owner: () => null });
  assert.deepEqual(fno.tags, [[false, true]], 'Approve all off: the fill asks');
  assert.equal(fno.acts, 0, 'a no stops it');
  assert.equal(planDeletion([{ do: 'fill', field: 'Body', text: 'x' }]), true, "draw's fill");
  // build4efix5: draw's click names its field; a click on a control with no name before typing is a deletion.
  assert.equal(planDeletion([{ do: 'click', id: 3, shown: 'Body' }, { do: 'type', text: 'x' }]), false, "draw's click and type");
  assert.equal(planDeletion([{ do: 'click', id: 3 }, { do: 'type', text: 'x' }]), true, 'no name: it may be Select All');
  assert.equal(planDeletion([{ do: 'type', text: 'x' }], ['TextEdit', '1Password']), true, 'in a password manager');
  for (const s of [{ do: 'set', field: 'f', text: 'x' }, { do: 'choose', field: 'f', option: 'x' }]) assert.equal(stepsLose([s]), true, s.do);
}
{
  // 5 (low). Any selection makes the plan deletion-class, not only cmd+a; so does any key outside the safe set.
  for (const steps of [[{ do: 'key', key: 'cmd+shift+up' }, { do: 'type', text: 'x' }], [{ do: 'key', key: 'cmd+shift+down' }, { do: 'key', key: 'cmd+v' }],
    [{ do: 'key', key: 'shift+down' }, { do: 'key', key: 'shift+down' }, { do: 'type', text: 'x' }], [{ do: 'click_text', text: 'Select All' }, { do: 'type', text: 'x' }],
    [{ do: 'key', key: 'cmd+a' }, { do: 'key', key: 'ctrl+y' }], [{ do: 'key', key: 'opt+shift+left' }], [{ do: 'key', key: 'shift+home' }], [{ do: 'key', key: 'x' }], [{ do: 'key', key: 'space' }]]) {
    assert.equal(stepsLose(steps), true, JSON.stringify(steps));
  }
  const x = await run('plain', [{ do: 'key', key: 'cmd+shift+down' }, { do: 'type', text: 'x' }]);
  assert.deepEqual(x.tags, [[true, true]], JSON.stringify(x));
  assert.equal(x.acts, 1, 'Approve all runs it');
}
{
  // 6 (low). Replacing the clipboard is one rule on both paths: act_in_app's copy and cut ask, as draw's copy mark does.
  for (const steps of [[{ do: 'key', key: 'cmd+c' }], [{ do: 'key', key: 'cmd+x' }], [{ do: 'key', key: 'cmd+a' }, { do: 'key', key: 'cmd+c' }], [{ do: 'click_text', text: 'Copy' }], [{ do: 'click_text', text: 'Paste' }]]) {
    const x = await run('plain', steps);
    assert.deepEqual(x.tags, [[true, true]], JSON.stringify(steps));
    assert.equal(x.acts, 1, JSON.stringify(steps));
  }
  {
    const off = await run('plain', [{ do: 'key', key: 'cmd+c' }], { on: false, owner: () => null });
    assert.deepEqual(off.tags, [[false, true]], 'Approve all off: a copy asks');
    assert.equal(off.acts, 0);
  }
  const ok = await run('plain', [{ do: 'click_text', text: 'Compose' }, { do: 'type', text: 'hello' }, { do: 'key', key: 'tab' }, { do: 'key', key: 'return' }, { do: 'key', key: 'escape' }, { do: 'key', key: 'down' }]);
  assert.deepEqual(ok.tags, [[true, false]], 'a plan of safe steps runs unasked');
  assert.equal(ok.acts, 1);
  for (const a of ['Apple Passwords', 'com.agilebits.onepassword7', 'OTP Manager', 'Proton Pass']) assert.equal(isPasswordApp(a), true, a);
}

// ---- 7, 8 (medium, principle 4). Words the owner said are in the saved history exactly once, in order.
const SESSION = 's1';
const sev = (event) => ({ type: 'stream_event', event, parent_tool_use_id: null, session_id: SESSION });
const count = (msgs, words) => msgs.filter((m) => m.role === 'user').map((m) => (typeof m.content === 'string' ? m.content : m.content.map((p) => p.text ?? '').join(''))).join('\n').split(words).length - 1;
const agentWith = (query, o = {}) => new ClaudeCodeAgent({ model: 'claude-opus-5-5', system: 's', tools: [], executable: '/bin/claude', cwd: '/', env: {}, query, onRateLimit: () => {}, connectors: true, signal: new AbortController().signal, ...o });
{
  // 7. Relay hold-carry: an addition sent after the reply (not taken) is carried into the next run as its prompt; its
  // copy kept at the run's end goes, so the history and the next run's first message hold it once.
  let agent, runs = 0;
  const firsts = [];
  const query = ({ prompt }) => {
    const inputs = prompt[Symbol.asyncIterator](), n = ++runs, uuids = [];
    async function* go() {
      const h = await inputs.next(); uuids.push(h.value.uuid); firsts.push(JSON.stringify(h.value.message?.content ?? h.value));
      yield { type: 'system', subtype: 'init', session_id: SESSION };
      yield sev({ type: 'message_start', message: { id: `m${n}`, usage: { input_tokens: 5 } } });
      yield { type: 'assistant', parent_tool_use_id: null, message: { id: `m${n}`, model: 'claude-opus-5-5', content: [{ type: 'text', text: `reply${n}` }] } };
      if (n === 1) agent.addInput('[added] and the volume one');
      yield sev({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }); yield sev({ type: 'message_stop' });
      yield { type: 'result', subtype: 'success', is_error: false, result: 'x', session_id: SESSION, user_message_uuids: uuids };
    }
    const q = go(); q.interrupt = async () => {}; q.close = () => {}; q.getContextUsage = async () => null; return q;
  };
  agent = agentWith(query);
  await relaySession({ agent, text: 'show me the orbs', h: { emit: () => {}, signal: new AbortController().signal } });
  const h = agent.getMessages();
  assert.equal(runs, 2, 'carried into a second run');
  assert.equal(count(h, '[added] and the volume one'), 1, `the addition once: ${JSON.stringify(h.map((m) => [m.role, m.content]))}`);
  assert.equal(count(h, 'show me the orbs'), 1);
  assert.equal(firsts[1].split('and the volume one').length - 1, 1, 'and once in what the next run reads');
  assert.ok(h.findIndex((m) => m.content === 'show me the orbs') < h.findIndex((m) => String(m.content).includes('volume one')), 'in order');
}
{
  // 8. A usage-limit retry: the run's own messages (the request, what was added into it) are left out of the saved
  // conversation and its words go along with the retry, each once; the retried run then saves each once.
  const session = { messages: [], id: 'x' };
  for (const partial of [false, true]) {
    let agent;
    const limited = ({ prompt }) => {
      const inputs = prompt[Symbol.asyncIterator](), uuids = [];
      async function* go() {
        const h = await inputs.next(); uuids.push(h.value.uuid);
        yield { type: 'system', subtype: 'init', session_id: SESSION };
        if (partial) {
          yield sev({ type: 'message_start', message: { id: 'm1', usage: {} } });
          yield { type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Opening it.' }] } };
          yield sev({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: {} });
        }
        agent.addInput('[added] also the volume');
        yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['You have hit your usage limit'], session_id: SESSION, user_message_uuids: uuids };
      }
      const q = go(); q.interrupt = async () => {}; q.close = () => {}; q.getContextUsage = async () => null; return q;
    };
    agent = agentWith(limited, { priorMessages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: [{ type: 'text', text: 'Hello.' }] }] });
    const st = { session, agent, forDisk: (m) => m, withoutLive: (m) => m, pendingFold: null, applyPendingFold: () => {}, saveSession: () => {} };
    const { syncSession } = piece('const syncSession = (upTo) => {', '// ---------- folding old turns', ['syncSession'], st);
    const runFrom = agent.getMessages().length; // as prompt() notes it
    await assert.rejects(async () => { for await (const e of agentEvents(agent.prompt('open the page'))) void e; }, /usage limit/);
    const again = retryText({ messages: agent.getMessages(), from: runFrom, text: 'open the page', unanswered: agent.unanswered() });
    syncSession(runFrom); // the retry's save (sidekick's finally)
    assert.equal(count(session.messages, 'open the page'), 0, `saved without the failed run (partial ${partial})`);
    assert.equal(count(session.messages, 'also the volume'), 0);
    assert.equal(again.split('open the page').length - 1, 1, 'the request once in the retry');
    assert.equal(again.split('[added] also the volume').length - 1, 1, 'the addition once, never dropped');
    // The retry, on the next model: a fresh agent from the saved conversation.
    const ok = () => ({ prompt }) => {
      const inputs = prompt[Symbol.asyncIterator](), uuids = [];
      async function* go() {
        const h = await inputs.next(); uuids.push(h.value.uuid);
        yield { type: 'system', subtype: 'init', session_id: SESSION };
        yield sev({ type: 'message_start', message: { id: 'r', usage: {} } });
        yield { type: 'assistant', parent_tool_use_id: null, message: { id: 'r', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Done.' }] } };
        yield sev({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} });
        yield { type: 'result', subtype: 'success', is_error: false, result: 'Done.', session_id: SESSION, user_message_uuids: uuids };
      }
      const q = go(); q.interrupt = async () => {}; q.close = () => {}; q.getContextUsage = async () => null; return q;
    };
    const next = agentWith(ok(), { priorMessages: session.messages });
    for await (const e of agentEvents(next.prompt(again))) void e;
    const h = next.getMessages();
    assert.equal(count(h, 'open the page'), 1, `the request once after the retry (partial ${partial})`);
    assert.equal(count(h, '[added] also the volume'), 1, 'the addition once');
    session.messages = [];
  }
  assert.doesNotMatch(side, /session\.messages\.pop\(\)/, 'never a blind pop of the last message');
  // build4efix5: the cut is found by the run's tag (runStart), never an index taken before the run.
  assert.match(side, /syncSession\(retryNext \? runStart\(agent\?\.getMessages\?\.\(\) \?\? \[\], runTag, runFrom\) : undefined\);\n    \/\/ Its history is saved without the run the retry repeats: no later sync may write that run back\.\n    if \(retryNext\) agent = null;/);
}

// ---- 10 (low, principle 5). jsonOf takes the first balanced object that is the answer (has its keys), not the first
// that parses.
{
  const J = '{"summary":"They talked about the orbs page and its screenshot settings.","facts":[{"text":"Ken likes the orbs page a lot"}]}';
  for (const t of [`Facts were {} this time. ${J}`, `Known facts: {"facts":[]} Now: ${J}`, `Output format {facts, summary}:\n${J}`, `${J}\n{"note": 1}`, `\`\`\`json\n${J}\n\`\`\``]) {
    const out = parseBrain(t, { wantSummary: true });
    assert.match(out.summary, /orbs/, t);
    assert.equal(out.facts.length, 1, t);
  }
  assert.throws(() => parseBrain('{}', { wantSummary: true }), /no summary/, 'no answer object: as before');
  assert.equal(parseBrain('Nothing new {} {"facts":[{"text":"Ken drinks green tea daily"}]}').facts.length, 1, 'the memory pass too');
  const skill = { name: 'Export a Figma frame', description: 'When exporting a frame from Figma as PNG', steps: '1. Select the frame.\n2. Export as PNG at 2x.' };
  assert.equal(parseSkill(`I'll answer with {} or a skill: ${JSON.stringify({ skill })}`)?.name, 'Export a Figma frame', 'the skill pass');
  assert.equal(parseLesson(`Format {"x": 1}. ${JSON.stringify({ fact: null, skill })}`).skill?.name, 'Export a Figma frame', 'the lesson pass');
}

console.log('build4efix4: all passed');
