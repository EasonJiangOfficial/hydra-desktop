// Build 4 lane E, final round 3: each block fails without its fix. Nothing here reaches the Mac: the hands helper is a
// stub written below; open, osascript, screencapture, sips, pbcopy and pbpaste are stubs on PATH; the Mac's voice
// renders nothing (render is stubbed) and the overlay's player runs in a vm on a fake clock; the model's provider fails
// before any network call (its fetch throws).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'b4fix5-'));
process.env.ROAMIES_DATA_DIR = path.join(tmp, 'data');
process.env.HOME = path.join(tmp, 'home'); fs.mkdirSync(process.env.HOME);
const bin = path.join(tmp, 'bin'), launched = path.join(tmp, 'launched.log');
fs.mkdirSync(bin);
for (const c of ['open', 'osascript', 'screencapture', 'sips', 'pbcopy', 'pbpaste', 'say', 'afconvert']) fs.writeFileSync(path.join(bin, c), `#!/bin/sh\necho ${c} "$@" >> '${launched}'\nexit 0\n`, { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;
// The hands helper: a stub; every act runs.
const stub = path.join(tmp, 'hands.mjs'), acts = path.join(tmp, 'acts');
fs.writeFileSync(stub, `import fs from 'node:fs';
const a = process.argv.slice(2);
const out = (o) => { console.log(JSON.stringify(o)); process.exit(0); };
const w = { id: 1, pid: 10, app: 'Notes', title: 'Notes', bounds: [0, 0, 800, 600] };
if (a[0] === 'resolve') out({ ok: true, window: w, running: 'Notes', runningPid: 10 });
if (a[0] === 'locate') out({ ok: true, window: w });
if (a[0] === 'front') out({ ok: true, app: w.app, pid: w.pid });
if (a[0] === 'act') { const n = +(fs.existsSync(${JSON.stringify(acts)}) ? fs.readFileSync(${JSON.stringify(acts)}, 'utf8') : 0); fs.writeFileSync(${JSON.stringify(acts)}, String(n + 1)); out({ ok: true, done: ['ran'], window: w }); }
if (a[0] === 'windows') out({ ok: true, windows: [w], all: true });
out({ ok: true });
`);
process.env.ROAMIES_HANDS = stub;

const { askForTake, trackAsk, retryText, runStart, tagRun } = await import('../voiceturn.mjs');
const { createSpeaker } = await import('../speaker.mjs');
const { HydraVoice } = await import('../hydravoice.mjs');
const { SystemVoice } = await import('../sysvoice.mjs');
const { approveAllSays, checkWindow, planDeletion, stepsLose } = await import('../safety.mjs');
const { createTools } = await import('../tools.mjs');
const { fitContext } = await import('../store.mjs');
const { Agent } = await import('@kenkaiiii/gg-agent');
const side = fs.readFileSync(new URL('../sidekick.mjs', import.meta.url), 'utf8');
const toolsSrc = fs.readFileSync(new URL('../tools.mjs', import.meta.url), 'utf8');
const voiceOutJs = fs.readFileSync(new URL('../../roamies/voice-out.js', new URL('../../src-tauri/', import.meta.url)), 'utf8');

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
function piece(from, to, names, st, Fn = Function) {
  const a = side.indexOf(from), b = side.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `sidekick.mjs has ${from}`);
  return new Fn('st', `with (st) { ${side.slice(a, b)}; return { ${names.join(', ')} }; }`)(st);
}
// The overlay's player (showcase/roamies/voice-out.js) on the fake clock: its audio clock is the clock's seconds.
function overlayPlayer(c) {
  const noop = () => {};
  class AudioContext {
    constructor() { this.state = 'running'; this.destination = {}; }
    get currentTime() { return c.now() / 1000; }
    resume() { return Promise.resolve(); }
    suspend() { return Promise.resolve(); }
    createGain() { return { gain: { value: 1, cancelScheduledValues: noop, setValueAtTime: noop, linearRampToValueAtTime: noop }, connect: noop }; }
    createAnalyser() { return { connect: noop, getFloatTimeDomainData: noop }; }
    createBuffer(_c, n, rate) { return { duration: n / rate, getChannelData: () => new Float32Array(n) }; }
    createBufferSource() { return { connect: noop, stop: noop, start() {} }; }
  }
  const window = { Roamie: {} };
  vm.runInNewContext(voiceOutJs, { window, AudioContext, Float32Array, Math, Set, setTimeout: (f, ms) => c.setTimer(f, ms), atob: (s) => Buffer.from(s, 'base64').toString('latin1') });
  return window.Roamie.voiceOut;
}
const unhandled = [];
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(setImmediate); };

// ---- 1 (high, principle 1). With the Mac's own voice (HydraVoice, what a paired Mac speaks with), an ask's mark is
// sent after its sentence's audio, so the player reports it played, its take opens and a spoken yes answers it.
{
  // The voice itself: say(text, done) calls done once that sentence's audio went out, before the next one's.
  const got = [];
  class Quiet extends SystemVoice { async render(t) { return { pcm: Buffer.alloc(4410 * 2), rate: 22050, t }; } }
  const v = new Quiet({ onAudio: () => got.push('pcm'), onEnd: () => got.push('end') });
  v.say('One.'); v.say('Two?', () => got.push('two done')); v.say('Three.'); v.end();
  await settle();
  assert.deepEqual(got, ['pcm', 'pcm', 'two done', 'pcm', 'end']);
}
{
  const c = fakeClock(), player = overlayPlayer(c), sent = [], out = [];
  const st = { power: { asleep: false }, yesNoOpen: new Map(), turnVoice: null, voiceBusy: false, askTake: null, send: (m) => sent.push(m),
    Date: { now: c.now }, setTimeout: (f, ms) => c.setTimer(f, ms), clearTimeout: (h) => h && c.clearTimer(h) };
  Object.assign(st, piece('function askPlayed(mark) {', 'function showAsk(', ['askPlayed', 'askArm', 'askTakeEnd'], st));
  player.onPlayed = (_id, mark) => st.askPlayed(mark);
  // HydraVoice as sidekick builds the speaker (LocalVoiceImpl), its server/Mac render stubbed: 1 s of audio a sentence.
  class Mac extends HydraVoice { async renderNow() { return { pcm: Buffer.alloc(44100 * 2), rate: 44100 }; } }
  const sp = createSpeaker({ emit: (m) => { out.push(m); player.handle(m); }, LocalVoiceImpl: Mac, localStatus: async () => ({ ok: true, voices: [] }), keepWarmMs: 1e9, beatPhrases: [], bundled: () => null });
  sp.setProvider('voicestudio');
  const voice = sp.start();
  st.turnVoice = voice;
  voice.say('Sure.');
  const w = { voice };
  w.a = trackAsk({ id: 'a1', route: 'overlay', question: 'Can I quit Safari?', choices: true, voice, resolve: () => {}, ...c });
  st.yesNoOpen.set('a1', w);
  assert.ok(w.a.voiced && w.a.mark, 'said aloud, with its mark');
  voice.say('After that.'); voice.end();
  await settle();
  const seq = out.map((m) => (m.pcm ? 'pcm' : m.mark ? `mark ${m.mark}` : m.end ? 'end' : m.stop ? 'stop' : 'other'));
  assert.deepEqual(seq, ['stop', 'pcm', 'pcm', `mark ${w.a.mark}`, 'pcm', 'end'], `the mark after the question's audio: ${seq}`);
  c.advance(1500);
  assert.equal(w.a.heardAt, null, 'the question still playing: not heard');
  c.advance(1000);
  assert.ok(Number.isFinite(w.a.heardAt), 'played to its end: heard');
  assert.equal(askForTake(st.yesNoOpen, { text: 'yes', takeAt: w.a.heardAt })?.said, 'yes', 'a spoken yes answers it');
  c.advance(400);
  assert.deepEqual(sent, [{ type: 'listen', via: 'ask', wait: 8 }], 'and its own take opens');
  w.a.cancel();
}

// ---- 2-4 (principle 3). The safe-step whitelist: typed delete characters, Tab then typing and a blind click then
// typing are deletion-class; everything else in the safe set stays safe.
const noop = async () => {};
const run = async (steps, { owner = () => null, on = true } = {}) => {
  fs.writeFileSync(launched, ''); fs.rmSync(acts, { force: true });
  const asks = [];
  const ask = async (o) => { const auto = approveAllSays(on, o); asks.push({ auto, deletion: o.deletion, q: String(o.placeholder).split('\n')[0] }); return auto ? 'yes' : owner(o); };
  const t = createTools({ allowActions: () => true, ui: () => {}, openUrl: noop, onCommitments: noop, showList: noop, fmtWhen: String, commitmentsText: () => '', userName: 'Test', workdir: tmp, ask });
  t.nextTurn?.();
  const r = await t.tools.find((x) => x.name === 'act_in_app').execute({ target: 'Notes', steps }, {}).then(String, (e) => `ERR ${e.message}`);
  const n = fs.existsSync(acts) ? +fs.readFileSync(acts, 'utf8') : 0;
  return { r, acts: n, tags: asks.filter((a) => a.q.startsWith('In ')).map((a) => [a.auto, a.deletion]) };
};
{
  // 2 (medium). Typed text that is a delete key: DEL, backspace, the Mac's forward delete, ctrl+k's kill line, a tab.
  for (const text of ['\x7f'.repeat(30), '\b'.repeat(30), ''.repeat(5), 'x\x0b', 'a\tb', '\x04', '']) {
    assert.equal(stepsLose([{ do: 'type', text }]), true, JSON.stringify(text));
    const x = await run([{ do: 'type', text }]);
    assert.deepEqual(x.tags, [[true, true]], `Approve all runs a deletion: ${JSON.stringify(text)} ${JSON.stringify(x)}`);
    assert.equal(x.acts, 1, 'it ran');
  }
  for (const text of ['hello', 'line one\nline two', 'a\r\nb', 'café ✓ 日本']) assert.equal(stepsLose([{ do: 'type', text }]), false, JSON.stringify(text));
  assert.equal(planDeletion([{ do: 'click', id: 3, shown: 'Body' }, { do: 'type', text: '\x7f' }]), true, "draw's typing: the same rule");
}
{
  // 3 (medium). Tab or shift+Tab moves focus into a field and selects its text: typing after it replaces that.
  for (const k of ['tab', 'shift+tab', 'Tab']) {
    assert.equal(stepsLose([{ do: 'key', key: k }, { do: 'type', text: 'hello' }]), true, k);
    assert.equal(stepsLose([{ do: 'key', key: k }, { do: 'click_text', text: 'Compose' }, { do: 'type', text: 'x' }]), true, `${k}: a later click doesn't undo it`);
  }
  const x = await run([{ do: 'key', key: 'tab' }, { do: 'type', text: 'hello' }]);
  assert.deepEqual(x.tags, [[true, true]], JSON.stringify(x));
  assert.equal(x.acts, 1, 'Approve all runs it');
  const off = await run([{ do: 'key', key: 'tab' }, { do: 'type', text: 'hello' }], { on: false });
  assert.deepEqual(off.tags, [[false, true]], 'Approve all off: it asks');
  assert.equal(off.acts, 0, 'a no stops it');
  assert.equal(stepsLose([{ do: 'type', text: 'hello' }, { do: 'key', key: 'tab' }, { do: 'key', key: 'return' }]), false, 'tab after the typing: safe');
  const ok = await run([{ do: 'click_text', text: 'Compose' }, { do: 'type', text: 'hello' }, { do: 'key', key: 'tab' }, { do: 'key', key: 'return' }]);
  assert.deepEqual(ok.tags, [[true, false]], 'still runs unasked');
  assert.equal(ok.acts, 1);
}
{
  // 4 (low). A click at a spot or on a control with no name may be Edit > Select All: typing after it is a deletion.
  assert.equal(stepsLose([{ do: 'click_text', text: 'Edit' }, { do: 'click_at', x: 1, y: 2 }, { do: 'type', text: 'x' }]), true);
  assert.equal(stepsLose([{ do: 'click_at', x: 1, y: 2, global: true }, { do: 'type', text: 'x' }]), true);
  assert.equal(stepsLose([{ do: 'click', id: 3 }, { do: 'type', text: 'x' }]), true, 'a control with no name');
  assert.equal(stepsLose([{ do: 'focus', id: 3 }, { do: 'type', text: 'x' }]), true, 'a focus is a click to the helper');
  assert.equal(stepsLose([{ do: 'focus', id: 3, shown: 'Select All' }]), true, 'a focus on an Edit menu item');
  assert.equal(stepsLose([{ do: 'click', id: 3, shown: 'Message body' }, { do: 'type', text: 'x' }]), false, 'a named field');
  assert.equal(stepsLose([{ do: 'focus', id: 3, shown: 'To' }, { do: 'type', text: 'x' }]), false);
  assert.equal(stepsLose([{ do: 'click_at', x: 1, y: 2 }]), false, 'a click at a spot alone');
  // act_in_app names a focus (from read_window) as it names a click, and draw's typing names its field.
  assert.match(toolsSrc, /if \(label && \['click', 'focus'\]\.includes\(s\.do\)\) s\.shown = label;/);
  assert.match(toolsSrc, /\['click', 'focus'\]\.includes\(s\.do\) \? s\.label/);
  assert.match(toolsSrc, /\[\{ do: 'click', id: m\.at\.live, \.\.\.\(m\.at\.name \? \{ shown: m\.at\.name \} : \{\}\) \}, \{ do: 'type', text: m\.text \}\]/);
}

// ---- 5 (low, principle 3). A browser window showing a web vault or a password page asks, and Approve all never
// answers it (secret).
{
  const H = process.env.HOME;
  for (const win of [{ app: 'Google Chrome', title: 'passwords.google.com - Google Password Manager' }, { app: 'Safari', title: 'Bitwarden Web Vault - Bitwarden' },
    { app: 'Safari', title: '1Password – Sign In' }, { app: 'Arc', title: 'Dashlane' }, { app: 'Firefox', title: 'Home', url: 'https://vault.bitwarden.com/#/vault' },
    { app: 'Safari', title: 'LastPass', url: 'https://lastpass.com/vault/' }]) {
    const v = checkWindow(win, H);
    assert.equal(v.level, 'ask', JSON.stringify(win));
    assert.equal(v.secret, true, JSON.stringify(win));
    assert.equal(checkWindow(win, H, { viewers: false }).secret, true, `relay turn too: ${JSON.stringify(win)}`);
  }
  assert.equal(checkWindow({ app: 'Safari', title: 'Apple' }, H).level, 'safe', 'any other page as before');
  assert.equal(checkWindow({ app: '1Password', title: 'All Items' }, H).secret, true, 'the native apps as before');
}

// ---- 6 (medium, principle 4). The API route's usage-limit retry after a hard trim: the run is found by its tag, not
// by an index taken before the run, so the saved history has none of it and the retry has the request once.
{
  const prior = [];
  for (let i = 0; i < 6; i++) { prior.push({ role: 'user', content: `old request ${i} ${'x '.repeat(3000)}` }); prior.push({ role: 'assistant', content: [{ type: 'text', text: `old reply ${i}` }] }); }
  const agent = new Agent({ provider: 'anthropic', model: 'claude-opus-5-5', system: 's', priorMessages: prior, tools: [], maxTurns: 3,
    transformContext: (msgs, o) => fitContext(msgs, { budgetTokens: 4000, force: o?.force }),
    // The transport itself fails, so nothing can go out (a key in the environment included).
    apiKey: 'test', fetch: async () => { throw Object.assign(new Error('You have hit your usage limit'), { status: 429 }); },
    signal: new AbortController().signal });
  // gg's stream pump rejects once more after the run threw; sidekick logs such a rejection (its unhandledRejection
  // handler), so here it is kept and checked to be that one alone.
  process.on('unhandledRejection', (e) => unhandled.push(e));
  const session = { messages: [], id: 'x' };
  const st = { session, agent, forDisk: (m) => m.filter((x) => x.role !== 'system'), withoutLive: (m) => m, pendingFold: null, applyPendingFold: () => {}, saveSession: () => {} };
  const { syncSession } = piece('const syncSession = (upTo) => {', '// ---------- folding old turns', ['syncSession'], st);
  // As sidekick's prompt() does it.
  const runFrom = agent.getMessages().length;
  const stream = agent.prompt('OPEN THE PAGE');
  const runTag = tagRun(agent.getMessages()[runFrom]);
  await assert.rejects(async () => { for await (const e of stream) void e; });
  const msgs = agent.getMessages();
  assert.ok(msgs.length < runFrom, `the run trimmed the history: ${runFrom} -> ${msgs.length}`);
  const again = retryText({ messages: msgs, from: runStart(msgs, runTag, runFrom), text: 'OPEN THE PAGE', unanswered: [] });
  syncSession(runStart(agent.getMessages(), runTag, runFrom));
  const n = (x) => JSON.stringify(x).split('OPEN THE PAGE').length - 1;
  assert.equal(n(session.messages), 0, 'saved without the failed run');
  assert.ok(session.messages.length > 0 && session.messages.every((m) => /old/.test(JSON.stringify(m))), 'what was before it kept');
  assert.equal(again.split('OPEN THE PAGE').length - 1, 1, 'the request once in the retry');
  assert.equal(JSON.stringify(agent.getMessages()).includes('OPEN'), true);
  assert.equal(runStart(msgs, null, 7), 7, 'no tag: the index as before');
  assert.equal(runStart(msgs, {}, 7), 7, 'not found: the index as before, never a cut-short history');
  // sidekick takes the cut from the tag on both paths.
  assert.match(side, /const run = agent\.prompt\(content\);\n    runTag = tagRun\(agent\.getMessages\(\)\[runFrom\]\);/);
  assert.match(side, /retryText\(\{ messages: msgs, from: runStart\(msgs, runTag, runFrom\), text,/);
  assert.match(side, /syncSession\(retryNext \? runStart\(agent\?\.getMessages\?\.\(\) \?\? \[\], runTag, runFrom\) : undefined\);/);
  assert.doesNotMatch(side, /from: runFrom,/, 'never the stale index');
}

// ---- 7 (low, principle 4). The owner said the same words twice: both go with the retry; words both placed and
// unanswered are there once.
{
  const messages = [{ role: 'user', content: 'book it' }, { role: 'user', content: '[added] the red one', added: true }, { role: 'assistant', content: 'ok' }, { role: 'user', content: '[added] the red one', added: true }];
  const said = (t) => t.split('[added] the red one').length - 1;
  assert.equal(said(retryText({ messages, from: 0, text: 'book it', unanswered: ['[added] the red one'] })), 2, 'said twice: twice');
  assert.equal(said(retryText({ messages, from: 0, text: 'book it', unanswered: ['[added] the red one', '[added] the red one'] })), 2, 'both placed and unanswered: each once');
  assert.equal(said(retryText({ messages: messages.slice(0, 2), from: 0, text: 'book it', unanswered: ['[added] the red one', '[added] the red one'] })), 2, 'one placed, one never taken');
  assert.equal(retryText({ messages, from: 0, text: 'book it', unanswered: ['[added] blue'] }), 'book it\n\n[added] the red one\n\n[added] the red one\n\n[added] blue', 'in order');
}

// ---- 8 (low, principle 4). A retry that ends before its run (not ready): its words go to the thread with why.
{
  const AsyncFunction = (async () => {}).constructor;
  for (const retrying of [{ count: 1 }, null]) {
    const thread = [], said = [];
    const st = { readyAgent: async () => 'Pick another model on the Model page.', desk: { started() {} }, news: null, retrying, turnWords: 'open the page\n\n[added] also the volume',
      toThread: (u, a) => thread.push([u, a]), say: (t) => { said.push(t); return 'said'; } };
    assert.equal(await piece('  const notReady = await readyAgent();', '  busy = true; quiet = false; autoTurn = null;', [], st, AsyncFunction), 'said', 'the prompt ends there');
    assert.deepEqual(said, ['Pick another model on the Model page.'], 'said why');
    assert.deepEqual(thread, retrying ? [['open the page\n\n[added] also the volume', 'Pick another model on the Model page.']] : [], retrying ? 'a retry: its words to the thread' : 'a first try: as before');
  }
}

// ---- 9 (low, principle 6). relay.test.mjs's fake brain waits for its turn's stop, never a wall-clock sleep.
{
  const relayTest = fs.readFileSync(new URL('./relay.test.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(relayTest, /setTimeout\(r, \d+\)/, 'no sleep in the fake brain');
  assert.doesNotMatch(relayTest, /Date\.now\(\) - liveDone/, "the routine's no waits on events, not a time");
  assert.match(relayTest, /await stopped\(signal\); \/\/ the 400 stops it/);
  assert.match(relayTest, /await stopped\(signal\); \/\/ the 409 on its heartbeat stops it/);
}

await settle();
const usageLimit = (e) => { for (let x = e; x; x = x.cause) if (/usage limit/.test(x.message)) return true; return false; };
assert.ok(unhandled.every(usageLimit), `no other rejection: ${unhandled.map((e) => e.message)}`);
console.log('build4efix5: all passed');
