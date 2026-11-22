// The desktop side of the W5 voice contract, against fakes (no real Hydra, no real Claude Code, a temp HOME):
// 1 shared settings (model, effort, wake phrase) from GET /api/agent/state, on the Mac and in the server brain per turn;
// 2 additions while a turn runs (relay inputs[] -> the running session, acknowledged with inputsSeen);
// 3 fillers (the web's lines, never twice in a row, never part of the answer) and the interrupted note;
// 6 one steady loudness, the fillers' audio kept;
// 7 reply text: only the final answer, emote tags removed.
// Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { MODELS, SETTINGS_DEFAULTS, brainFor, cleanSettings, cleanWakePhrase, createSettingsWatch } from '../agentsettings.mjs';
import { FinalText, stripEmotes } from '../reply.mjs';
import { INPUT_PREFIX, createRelay, newInputs } from '../relay.mjs';
import { relayBatchSchema, relayEventsAnswerSchema } from '../relayschema.mjs';
import { ClaudeCodeAgent } from '../claudecode.mjs';
import { createBrainTurn } from '../brain-server.mjs';
import { FILLERS, createSpeaker, pickFiller } from '../speaker.mjs';
import { levelPcm } from '../sysvoice.mjs';
import { HydraVoice } from '../hydravoice.mjs';

assert.ok(fs.realpathSync(os.homedir()).startsWith(fs.realpathSync(os.tmpdir())), 'runs with a temp HOME (test/run.mjs)');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (ok, ms = 5000) => { const end = Date.now() + ms; while (!ok() && Date.now() < end) await wait(2); assert.ok(ok(), 'timed out'); };
const res = (status, body) => ({ status, ok: status >= 200 && status < 300, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body ?? null) });

// ---- 1. Shared settings.
{
  // clapSensitivity (W6): null until Hydra sends one, so the Mac keeps its own (an older server sends none).
  assert.deepEqual(SETTINGS_DEFAULTS, { wakePhrase: 'Hey Hydra', sleepWord: null, clapSensitivity: null, model: 'claude-opus-5-5', effortLive: 'low', effortRoutine: 'medium' }, 'the contract\'s defaults');
  assert.deepEqual(MODELS, ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
  const snake = cleanSettings({ settings: { wake_phrase: '  Okay   Computer ', sleep_word: 'Goodnight Hydra', model: 'claude-sonnet-5-5', effort_live: 'high', effort_routine: 'low' } });
  assert.deepEqual(snake, { wakePhrase: 'Okay Computer', sleepWord: 'Goodnight Hydra', clapSensitivity: null, model: 'claude-sonnet-5-5', effortLive: 'high', effortRoutine: 'low' });
  assert.deepEqual(cleanSettings({ settings: { wakePhrase: 'Hey Jarvis', model: 'claude-haiku-5-5', effortLive: 'medium' } }).model, 'claude-haiku-5-5', 'camelCase too');
  const bad = cleanSettings({ settings: { wake_phrase: 'x', model: 'gpt-9', effort_live: 'ultra', effort_routine: 3 } }, snake);
  assert.deepEqual(bad, snake, 'values out of range keep what was there');
  assert.equal(cleanWakePhrase('a'.repeat(41)), null, 'at most 40');
  assert.equal(cleanWakePhrase('42'), null, 'it has letters');
  assert.deepEqual(brainFor(snake, 'routine'), { model: 'claude-sonnet-5-5', thinking: 'low' }, 'a routine thinks at effort_routine');
  assert.deepEqual(brainFor(snake, 'web'), { model: 'claude-sonnet-5-5', thinking: 'high' }, 'live turns at effort_live');
  assert.deepEqual(brainFor(SETTINGS_DEFAULTS, 'phone'), { model: 'claude-opus-5-5', thinking: 'low' });

  // The watch: at start, on refresh (a change push), every 60 s; a failure keeps the last good ones.
  let answer = res(200, { settings: { model: 'claude-sonnet-5-5', effort_live: 'medium', wake_phrase: 'Hey Hydra' } });
  const asked = [], changes = [], timers = [];
  const api = { req: async (p, o) => { asked.push([p, o?.method ?? 'GET']); if (answer instanceof Error) throw answer; return answer; } };
  const w = createSettingsWatch({ api, onChange: (n, b) => changes.push([b.model, n.model]), setTimer: (f, ms) => { timers.push({ f, ms }); return timers.length; }, clearTimer: () => {} });
  assert.equal(w.current.model, 'claude-opus-5-5', 'the default until Hydra answers');
  await w.start();
  assert.deepEqual(asked[0], ['/api/agent/state', 'GET']);
  assert.equal(w.current.model, 'claude-sonnet-5-5');
  assert.deepEqual(changes, [['claude-opus-5-5', 'claude-sonnet-5-5']]);
  assert.equal(timers.at(-1).ms, 60_000, 'read again every 60 s');
  await w.refresh();
  assert.equal(changes.length, 1, 'nothing changed: no onChange');
  answer = res(503, {});
  await w.refresh();
  answer = new Error('offline');
  await w.refresh();
  assert.equal(w.current.model, 'claude-sonnet-5-5', 'a failed read keeps the last good settings');
  answer = res(200, { settings: { model: 'claude-haiku-5-5', effort_live: 'medium' } });
  const n = asked.length;
  timers.at(-1).f();
  await until(() => w.current.model === 'claude-haiku-5-5');
  assert.equal(asked.length, n + 1, 'the 60 s timer reads them');
  w.stop();
}

// ---- 7. Reply text: only the final answer, without emote tags.
{
  assert.equal(stripEmotes('[wave] Goodnight, sir.'), 'Goodnight, sir.');
  assert.equal(stripEmotes('Done. [hype] Nice one.'), 'Done. Nice one.');
  assert.equal(stripEmotes('[HYPE]Won'), 'Won');
  assert.equal(stripEmotes('A [link](x) and [note]'), 'A [link](x) and [note]', 'only the five body tags');
  const out = [];
  const f = new FinalText((t) => out.push(t));
  f.push('Let me check your '); f.push('calendar.'); f.tool(); f.turnEnd('tool_use');
  f.push('[wave] You have '); f.push('two meetings.'); f.turnEnd('end_turn');
  f.flush();
  assert.deepEqual(out, ['You have two meetings.'], 'the narration before the tool is not reply text');
}

// ---- 2. Additions while a turn runs: newInputs, then the relay against a fake Hydra.
{
  assert.deepEqual(newInputs({ inputs: [{ seq: 3, text: ' c ' }, { seq: 1, text: 'a' }, { seq: 2, text: '' }, { seq: 'x', text: 'b' }, { seq: 3, text: 'dup' }] }, 1), [{ seq: 3, text: 'c' }]);
  assert.deepEqual(newInputs(null), []);
  assert.ok(relayEventsAnswerSchema.safeParse({ inputs: [{ seq: 1, text: 'and Friday too' }] }).success);
  assert.ok(relayBatchSchema.safeParse({ turnId: randomUUID(), claimId: randomUUID(), events: [], inputsSeen: 2 }).success, 'inputsSeen is part of the batch');
  const turnId = randomUUID(), claimId = randomUUID();
  const posts = [];
  let served = false, pending = [{ seq: 1, text: 'also check Friday' }];
  const api = {
    req: async (p, o = {}) => {
      if (p.startsWith('/api/agent/relay/next')) {
        if (served) { await wait(20); return res(204); }
        served = true;
        return res(200, { turn: { id: turnId, claimId, surface: 'phone', input: { text: 'what is on Thursday?' }, context: { path: '/' } } });
      }
      if (p === '/api/agent/relay/events') {
        relayBatchSchema.parse(o.body);
        posts.push(o.body);
        if (o.body.inputsSeen) pending = pending.filter((i) => i.seq > o.body.inputsSeen);
        return res(200, { inputs: pending });
      }
      return res(404, {});
    },
  };
  const got = [];
  let finish;
  const relay = createRelay({
    api, slots: ['live'], waitSecs: 1, minPollMs: 1, flushMs: 1, heartbeatMs: 60_000, inputBeatMs: 15,
    runTurn: async (turn, h) => {
      h.onInput((text) => got.push(text));
      h.emit({ type: 'text', delta: 'Thursday: dentist.' });
      await new Promise((r) => { finish = r; });
    },
  });
  relay.start();
  await until(() => got.length === 1);
  assert.deepEqual(got, ['also check Friday'], 'the addition reached the running turn once');
  await until(() => posts.some((b) => b.inputsSeen === 1));
  pending.push({ seq: 2, text: 'and Saturday' });
  await until(() => got.length === 2);
  assert.deepEqual(got, ['also check Friday', 'and Saturday'], 'the next one too, never the first again');
  await until(() => posts.some((b) => b.inputsSeen === 2));
  finish();
  await until(() => posts.some((b) => b.events.some((e) => e.type === 'done')));
  await relay.stop();
  assert.ok(posts.filter((b) => !b.events.length).length >= 1, 'a live turn beats often, so additions come quickly');
}

// ---- 2b. ClaudeCodeAgent.addInput: one more user message on the streaming input, answered before the run ends.
const sdk = (script) => {
  const calls = { inputs: [], options: null };
  const query = ({ prompt, options }) => {
    calls.options = options;
    const it = prompt[Symbol.asyncIterator]();
    const ctx = { async next() { const x = await it.next(); if (!x.done) calls.inputs.push(x.value); return x.value; } };
    return Object.assign(script(ctx), { interrupt: async () => {}, close: () => {} });
  };
  return { query, calls };
};
const ev = (event) => ({ type: 'stream_event', parent_tool_use_id: null, event });
const says = (text, stop = 'end_turn') => [ev({ type: 'message_start', message: { usage: {} } }), ev({ type: 'content_block_delta', delta: { type: 'text_delta', text } }), ev({ type: 'message_delta', delta: { stop_reason: stop }, usage: {} }), ev({ type: 'message_stop' })];
const done = { type: 'result', subtype: 'success', is_error: false, result: 'ok' };
{
  let gate;
  const { query, calls } = sdk(async function* (ctx) {
    await ctx.next();
    yield* says('Thursday: dentist.');
    await new Promise((r) => { gate = r; }); // the addition comes in now, after the answer started
    yield done;
    await ctx.next();
    yield* says('Friday: free.');
    yield done;
  });
  const a = new ClaudeCodeAgent({ model: 'claude-opus-5-5', system: 's', tools: [], executable: '/bin/claude', cwd: '/', env: {}, query, onRateLimit: () => {} });
  assert.equal(a.addInput('x'), false, 'nothing runs yet');
  const text = [];
  const run = (async () => { for await (const e of a.prompt('what is on Thursday?')) if (e.type === 'text_delta') text.push(e.text); })();
  await until(() => !!gate);
  assert.equal(a.addInput(`${INPUT_PREFIX}and Friday?`), true);
  gate();
  await run;
  assert.deepEqual(text, ['Thursday: dentist.', 'Friday: free.'], 'the run waited for the addition\'s answer');
  assert.equal(calls.inputs.length, 2);
  assert.equal(calls.inputs[1].message.content[0].text, '(added while you were working) and Friday?');
  assert.equal(a.addInput('late'), false, 'the run is over');
}
{
  // Taken into the turn under way: an answer starts after it, so the first result is the end.
  let gate;
  const { query, calls } = sdk(async function* (ctx) {
    await ctx.next();
    await new Promise((r) => { gate = r; });
    await ctx.next();
    yield* says('Thursday and Friday: dentist, then free.');
    yield done;
  });
  const a = new ClaudeCodeAgent({ model: 'm', system: 's', tools: [], executable: '/bin/claude', cwd: '/', env: {}, query, onRateLimit: () => {} });
  const run = (async () => { for await (const _ of a.prompt('Thursday?')) { /* drain */ } })();
  await until(() => !!gate);
  a.addInput('and Friday?');
  gate();
  await Promise.race([run, wait(3000).then(() => { throw new Error('the run never ended'); })]);
  assert.equal(calls.inputs.length, 2);
}
{
  // Added before Claude Code has even started: it waits, then follows the first message.
  const { query, calls } = sdk(async function* (ctx) {
    await ctx.next(); await ctx.next();
    yield* says('Both.');
    yield done;
  });
  const a = new ClaudeCodeAgent({ model: 'm', system: 's', tools: [], executable: '/bin/claude', cwd: '/', env: {}, query, onRateLimit: () => {} });
  const stream = a.prompt('Thursday?');
  assert.equal(a.addInput('and Friday?'), true, 'taken while the run starts');
  for await (const _ of stream) { /* drain */ }
  assert.deepEqual(calls.inputs.map((i) => i.message.content.at(-1).text), ['Thursday?', 'and Friday?'], 'in order');
}

// ---- 1b + 7 + 2 in the server brain: settings per turn, only the final answer, additions into the session.
{
  let settings = { ...SETTINGS_DEFAULTS, model: 'claude-sonnet-5-5', effortLive: 'high', effortRoutine: 'low' };
  let reads = 0;
  const hydraTools = { tools: () => [] };
  let gate = null;
  const { query, calls } = sdk(async function* (ctx) {
    await ctx.next();
    yield* says('[wave] Let me check. ', 'tool_use');
    yield* says('[wave] You have $5.');
    if (gate) { await new Promise((r) => { gate.go = r; gate.ready = true; }); }
    yield done;
    if (gate?.added) { await ctx.next(); yield* says('And $3 in savings.'); yield done; }
  });
  const turn = createBrainTurn({ hydraTools, executable: '/x/claude', cwd: os.tmpdir(), query, settings: async () => { reads++; return settings; } });
  const run = async (surface, extra = {}) => {
    const events = [];
    await turn({ id: randomUUID(), surface, input: { text: 'balance?' }, context: { path: '/' } }, { emit: (e) => events.push(e), signal: new AbortController().signal, approve: async () => 'declined', ...extra });
    return events;
  };
  const e1 = await run('web');
  assert.equal(calls.options.model, 'claude-sonnet-5-5', 'the model is Hydra\'s setting');
  assert.equal(calls.options.effort, 'high', 'live turns think at effort_live');
  assert.deepEqual(e1.filter((e) => e.type === 'text').map((e) => e.delta), ['You have $5.'], 'only the final answer, no tags');
  await run('routine');
  assert.equal(calls.options.effort, 'low', 'a routine thinks at effort_routine');
  settings = { ...settings, model: 'claude-haiku-5-5' };
  await run('phone');
  assert.equal(calls.options.model, 'claude-haiku-5-5', 'read again for every turn');
  assert.equal(reads, 3);
  // An addition while it runs goes into the same session.
  gate = {};
  let take;
  const e4p = run('phone', { onInput: (fn) => { take = fn; } });
  await until(() => gate.ready);
  gate.added = take('also savings');
  gate.go();
  const e4 = await e4p;
  assert.equal(gate.added, true);
  assert.equal(calls.inputs.at(-1).message.content[0].text, `${INPUT_PREFIX}also savings`);
  assert.deepEqual(e4.filter((e) => e.type === 'text').map((e) => e.delta), ['You have $5.', ' And $3 in savings.']);
  gate = null;
  // Hydra unreachable: the contract's defaults.
  const t2 = createBrainTurn({ hydraTools, executable: '/x/claude', cwd: os.tmpdir(), query, settings: async () => { throw new Error('offline'); } });
  await t2({ id: randomUUID(), surface: 'web', input: { text: 'hi' }, context: {} }, { emit: () => {}, signal: new AbortController().signal, approve: async () => 'declined' });
  assert.equal(calls.options.model, 'claude-opus-5-5');
  assert.equal(calls.options.effort, 'low');
}

// ---- 3. Fillers: the web's lines, never the same twice in a row, said in Hydra's voice, never part of the answer.
{
  assert.deepEqual(FILLERS, ['Let me check.', 'One sec.', 'Let me see.', 'Checking that now.', 'Give me a second.', 'Let me look.', 'Hang on.', 'Just a moment.', 'Let me pull that up.']);
  let last = null;
  for (let i = 0; i < 300; i++) { const f = pickFiller(last); assert.ok(FILLERS.includes(f)); assert.notEqual(f, last, 'never twice in a row'); last = f; }
  assert.equal(pickFiller('One sec.', FILLERS, () => 0.999), 'Let me pull that up.');
  const made = [], out = [];
  class Fake {
    constructor(o) { Object.assign(this, o); this.said = []; made.push(this); }
    open() { return this; }
    say(t) { this.said.push(t); queueMicrotask(() => this.onAudio(new Int16Array([1, 2]), 44100)); }
    end() { queueMicrotask(() => this.onEnd()); }
    abort() {}
  }
  const sp = createSpeaker({ emit: (m) => out.push(m), LocalVoiceImpl: Fake, localStatus: async () => ({ ok: true }), bundled: () => null, fillers: FILLERS, keepWarmMs: 1e9 });
  sp.setProvider('voicestudio');
  const r = sp.start();
  assert.equal(r.beat(), true, 'a filler when nothing was said yet');
  assert.equal(r.beat(), false, 'once per reply');
  r.say('Your balance is five dollars.');
  r.end();
  await until(() => out.some((m) => m.end));
  const v = made.at(-1);
  assert.ok(FILLERS.includes(v.said[0]), 'the filler first, in the same voice');
  const chunks = out.filter((m) => m.pcm);
  assert.deepEqual(chunks.map((c) => !!c.filler), [true, false], 'the filler\'s audio is marked (not part of the answer)');
  assert.equal(out.find((m) => m.end).chars, 'Your balance is five dollars.'.length, 'the answer\'s length leaves the filler out');
  const r2 = sp.start(); r2.say('Already talking.');
  assert.equal(r2.beat(), false, 'not once the answer is streaming');
  r2.abort();
  const plain = createSpeaker({ emit: () => {}, LocalVoiceImpl: Fake, localStatus: async () => ({ ok: true }), bundled: () => null, keepWarmMs: 1e9 });
  plain.setProvider('voicestudio');
  assert.equal(plain.start().beat(), false, 'no fillers given (VoiceStudio): none');
}

// ---- 6. One steady loudness; the fillers' audio is kept.
{
  const tone = (amp, n = 22050) => { const b = Buffer.alloc(n * 2); for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(amp * 32767 * Math.sin(i / 7)), 2 * i); return b; };
  const rms = (b) => { let s = 0; const n = b.length / 2; for (let i = 0; i < n; i++) s += (b.readInt16LE(2 * i) / 32768) ** 2; return Math.sqrt(s / n); };
  const db = (x) => 20 * Math.log10(x);
  const quiet = levelPcm(tone(0.03)), loud = levelPcm(tone(0.6));
  assert.ok(Math.abs(db(rms(quiet)) - db(rms(loud))) < 1, `two sentences at one loudness (${db(rms(quiet)).toFixed(1)} vs ${db(rms(loud)).toFixed(1)} dB)`);
  assert.ok(Math.abs(db(rms(loud)) - db(0.125)) < 1.5, 'about -18 dBFS');
  const silent = Buffer.alloc(2000);
  assert.equal(levelPcm(silent), silent, 'silence stays silent');
  const spike = Buffer.alloc(4410 * 2); spike.writeInt16LE(30000, 200);
  const sp = levelPcm(spike);
  let top = 0; for (let i = 0; i < sp.length / 2; i++) top = Math.max(top, Math.abs(sp.readInt16LE(2 * i)));
  assert.ok(top <= 0.9 * 32768, 'never past the peak');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'filler-'));
  const wav = () => { const data = Buffer.alloc(400, 3), h = Buffer.alloc(44); h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(44100, 24); h.writeUInt32LE(88200, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40); return Buffer.concat([h, data]); };
  const reqs = [];
  HydraVoice.resetForTests();
  HydraVoice.server = { api: { req: async (p, o) => { reqs.push(o.body.text); return { status: 200, ok: true, arrayBuffer: async () => new Uint8Array([0xff, 0xfb]).buffer }; } }, paired: () => true };
  const speak = (text) => new Promise((resolve) => {
    const v = new HydraVoice({ run: () => { throw new Error('no Mac voice here'); }, tmp, onAudio: () => {}, onEnd: resolve, onError: (e) => { throw new Error(e.message); } });
    v.convert = async (_from, to) => fs.writeFileSync(to, wav());
    v.say(text); v.end();
  });
  await speak('One sec.'); await speak('One sec.'); await speak('Your total is five.'); await speak('Your total is five.');
  assert.deepEqual(reqs, ['One sec.', 'Your total is five.', 'Your total is five.'], 'a filler is fetched once a session; answers every time');
  HydraVoice.server = null;
  HydraVoice.resetForTests();
}

// ---- The sidecar's wiring (sidekick.mjs is the app itself, so its seams are checked in its source).
{
  const side = fs.readFileSync(new URL('../sidekick.mjs', import.meta.url), 'utf8');
  const brain = fs.readFileSync(new URL('../brain-server.mjs', import.meta.url), 'utf8');
  for (const [name, src] of [['sidekick.mjs', side], ['brain-server.mjs', brain]]) {
    assert.doesNotMatch(src, /'claude-(?:opus|sonnet|haiku)-5-5'/, `${name} hard-codes no model (agentsettings.mjs holds the contract's default)`);
  }
  assert.match(side, /const FAST = \{ openai: 'gpt-6-luna', gemini: 'gemini-3\.8-flash' \};/, 'no stale Haiku default for Claude');
  assert.match(side, /const want = agentSettings\.current\.model;\n  if \(!routed && canRun\('anthropic', want\)\)/, 'the local agent runs Hydra\'s model');
  assert.match(side, /const setting = hydra \? agentSettings\.current\.effortLive : config\.efforts\?\.\[slot\]/, 'and its live effort');
  assert.match(side, /const \{ model, thinking \} = brainFor\(agentSettings\.current, turn\.surface\);/, 'relay turns too');
  assert.match(side, /agentSettings\.start\(\);/, 'read when paired');
  assert.match(side, /m\.type === 'hydra_settings_changed'\) agentSettings\.refresh\(\);/, 'and on a change push from the window');
  assert.match(side, /wake: phraseOn\(\), wakeName: config\.wakeName \|\| '', wakePhrase: wakePhraseNow\(\),/, 'the wake phrase reaches the helper; it listens asleep too');
  assert.match(side, /const wakePhraseNow = \(\) => \(servedNow\('wakePhrase'\) \? agentSettings\.current\.wakePhrase : config\.wakePhrase \|\|/, 'Hydra\'s phrase when the server sends one');
  assert.match(side, /if \(!asleep && why !== 'talk' && why !== 'phrase'\)/, 'a phrase wake keeps its own take (no greeting over the owner)');
  assert.match(side, /state === 'listening' && busy && m\.mode === 'wake'\) \{ addOnTake = true;/, 'the phrase while thinking adds on');
  assert.match(side, /if \(addOnTake\) \{ addOnTake = false; if \(addOn\(text\)\) return; \}/);
  assert.match(side, /agent\?\.addInput\?\.\(`\$\{INPUT_PREFIX\}\$\{text\}`\)/);
  assert.match(side, /onInput\(\(text\) => agentRun\.addInput\(`\$\{INPUT_PREFIX\}\$\{text\}`\)\);/, 'relay additions into the session');
  assert.match(side, /if \(m\.via === 'barge'\) noteInterrupted\(\);/, 'barge-in notes what was heard');
  assert.match(side, /the owner heard only: "\$\{cut\}"/, 'and the next turn carries it');
  assert.match(side, /setTimeout\(\(\) => \{ if \(busy && turnVoice === voice && !voiceMuted\) voice\.beat\(\); \}, FILLER_MS\)/, 'a filler after 1.1 s, never muted');
  assert.match(side, /const FILLER_MS = 1100;/);
  assert.match(side, /if \(!voiceMuted\) voice\?\.beat\(\); \/\/ a tool starts/, 'or when a tool starts');
  assert.match(side, /listensAfter\(lastReply, true\)/, 'a follow-up window after every answer');
  assert.match(side, /const tts = \(\) => \(MAC && hydraKey && !hydraRevoked \? TTS\.voicestudio :/, 'paired: every sentence from /api/voice/tts');
  assert.match(side, /function nativeSpeech\(m\) \{ if \(nativeVoice\(\)\) send\(\{ type: 'voice_play', msg: m \}\); \}/, 'played by the voice helper');
  assert.match(side, /pushWeb\(\{ reply: \{ id: replyNow\.id, text: stripEmotes\(replyNow\.text\), final \} \}\);/, 'no emote tags in the window');
  assert.match(side, /e\.type === 'tool' && replyNow\) \{\n    replyNow\.text = '';/, 'narration before a tool is not reply text');
  assert.match(side, /assistant: stripEmotes\(/, 'nor in the shared thread');
  assert.match(brain, /settings: \(\) => agentSettings\.refresh\(\)/, 'the server brain reads the settings per turn');
  const host = fs.readFileSync(new URL('../../../roamies/host.js', import.meta.url), 'utf8');
  assert.match(host, /m\.kind === 'voice_native'\) \{ Roamie\.voiceOut\?\.setNative\?\.\(m\.on\);/);
  const vo = fs.readFileSync(new URL('../../../roamies/voice-out.js', import.meta.url), 'utf8');
  assert.match(vo, /setNative\(on\) \{ native = !!on; if \(vol\) vol\.gain\.value = native \? 0 : volume; \}/, 'the overlay keeps time silently');
  const shell = fs.readFileSync(new URL('../../src-tauri/src/main.rs', import.meta.url), 'utf8');
  assert.match(shell, /Some\("voice_play"\) => \{\n\s+if let Some\(cmd\) = msg\.get\("msg"\)\.and_then\(voice::play_cmd\)/);
  assert.match(shell, /"cmd": "wake_phrase", "phrase": p/);
}
console.log('voice contract tests: passed');
