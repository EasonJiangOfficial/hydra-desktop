// Round 11e review (R11f): the probes of scratchpad v11e-relay and v11e-macaction, as behavior tests with fakes. Each
// block fails without its fix. Run: npm test (temp home, fake helper, fake Claude Code, and fake open/osascript/
// screencapture first on PATH, so nothing here can reach the real Mac).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeCodeAgent } from '../claudecode.mjs';
import { agentEvents } from '../agentstream.mjs';
import { fakeHands } from './fakehands.mjs';

const HOME = fs.realpathSync.native(os.homedir());
assert.ok(HOME.includes('roamies-test-') || HOME.startsWith(fs.realpathSync.native(os.tmpdir())), 'runs only with a temp home');

// ---- The tools against the shared fake helper (fakehands.mjs), which sends what hands/main.swift sends: 'windows' each
// window's file (no address), 'locate' and 'ui' its file and address, find-text each match's window without either.
if (['darwin', 'win32'].includes(process.platform)) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-11f-'));
  const bin = path.join(dir, 'bin'), launched = path.join(dir, 'launched.log');
  fs.mkdirSync(bin);
  for (const c of ['open', 'osascript', 'screencapture']) fs.writeFileSync(path.join(bin, c), `#!/bin/sh\necho ${c} "$@" >> '${launched}'\nexit 1\n`, { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  const doc = path.join(HOME, 'Documents', 'n.txt'), env = path.join(HOME, 'Documents', 'shop', '.env'), key = path.join(HOME, '.ssh', 'id_rsa');
  for (const f of [doc, env, key]) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'x'); }
  // The shared fake (fakehands.mjs): windows without a pid are all the front app's, the first one in front.
  const fake = fakeHands(dir);
  const { createTools } = await import('../tools.mjs');
  const asks = [];
  let remote = true, answer = () => 'Allow';
  const t = createTools({ remote: () => remote, allowActions: () => true, ui: (msg) => { if (msg?.e?.type === 'draw') setTimeout(() => t.ink.started(msg.e.id, msg.e.seg), 5); }, ask: async (o) => { asks.push(o.placeholder); return answer(o.placeholder); }, openUrl: async () => {}, onCommitments: () => {}, showList: () => {}, fmtWhen: String, commitmentsText: () => '', userName: 'Test', workdir: HOME, skills: { changed: () => {} } });
  const T = (n) => t.tools.find((x) => x.name === n);
  const calls = () => fake.calls();
  const reset = (st, { relay = true } = {}) => { fake.clear(); asks.length = 0; answer = () => 'Allow'; remote = relay; fake.set(st); t.nextTurn(); };
  const said = (p) => p.then((x) => String(x), (e) => String(e?.message ?? e));
  const ring = (target, text) => said(T('draw').execute({ target, beats: [{ say: 'Here.', marks: [{ kind: 'ring', at: { text } }] }] }, { toolCallId: `f${Math.random()}` }));
  const preview = { id: 3, app: 'Preview', title: 'n.txt', doc, text: 'Hello' };
  const msgs = { id: 5, app: 'Messages', title: 'Mom', text: 'Hi' };
  const term = { id: 7, app: 'Terminal', title: 'ssh prod', text: 'export TOKEN=sk-live-zzz' };
  const notes = { id: 8, app: 'Notes', title: 'n', text: '' };

  // ---- F2: draw's type mark in a relay turn. The helper's act error and its needsConfirm "why" quote the window:
  // the model gets the step number only (the same scrub as act_in_app's). On this Mac the words pass as before.
  const typeIn = async (act, relay = true) => {
    reset({ wins: [msgs, preview], act }, { relay });
    await T('take_screenshot').execute({ target: 'Preview' }, {});
    return said(T('draw').execute({ target: 'front', beats: [{ say: 'Typing here.', marks: [{ kind: 'type', at: { x: 400, y: 300 }, text: 'hi' }] }] }, { toolCallId: `f${Math.random()}` }));
  };
  const typedErr = { ok: false, error: 'Step 2: typed, but the text field still shows "Your bank PIN is 9921, do not share", so I stopped before the next step.', done: [] };
  const f2a = await typeIn(typedErr);
  assert.ok(asks.some((q) => q.startsWith('In Messages, every step')), JSON.stringify(asks));
  assert.ok(!f2a.includes('9921') && !f2a.includes('bank'), f2a);
  assert.match(f2a, /^Step 2 didn't work in Messages\./, f2a);
  const f2b = await typeIn({ ok: false, needsConfirm: true, step: 0, label: 'Send', why: 'That spot is "Send $500 to Alex Chen (rent)" in Messages: it could delete, pay, send, quit or sign out.', done: [] });
  assert.ok(!f2b.includes('Alex Chen') && !f2b.includes('$500'), f2b);
  assert.match(f2b, /didn't work in Messages\..*Nothing more was typed/, f2b);
  assert.ok((await typeIn(typedErr, false)).includes('9921'), 'on this Mac the helper\'s words pass as before');

  // ---- F4: the scrub masks only what can quote a window. The helper's fixed messages pass: "No matching window"
  // still offers to open the app, a hands-off app's block and a file panel's reason are said as they are. Anything
  // not on the list (fail closed) is the step number alone.
  reset({ wins: [], act: { ok: false, error: 'No matching window is open.' } });
  answer = (q) => (q.startsWith('Open Notes?') ? "Don't allow" : 'Allow');
  const f4a = await said(T('act_in_app').execute({ target: 'Notes', steps: [{ do: 'click_text', text: 'New Note' }] }, {}));
  assert.ok(asks.some((q) => q.startsWith('Open Notes? It isn\'t open')), JSON.stringify(asks));
  assert.equal(f4a, 'Test said no, so I didn\'t open Notes. Nothing ran.');
  const block = 'Blocked for safety: I can point at things in Terminal, but I never type or click in it. Show the user where to click instead.';
  reset({ wins: [term], act: { ok: false, error: block } });
  assert.equal(await said(T('act_in_app').execute({ target: 'Terminal', steps: [{ do: 'click_text', text: 'Clear' }] }, {})), block);
  reset({ wins: [notes], act: { ok: false, needsConfirm: true, step: 0, whole: 'panel', app: 'Notes', why: 'A Save or Open panel is up in Notes: in it any file in any folder can be picked, uploaded or made.', done: [] } });
  const f4c = await said(T('act_in_app').execute({ target: 'Notes', steps: [{ do: 'hover' }] }, {}));
  assert.ok(f4c.startsWith('Blocked for safety: A Save or Open panel is up in Notes: in it any file'), f4c);
  reset({ wins: [notes], act: { ok: false, error: 'Stopped before clicking "Pay $500 to Alex": it could delete, pay, send or sign out.', done: [] } });
  const f4d = await said(T('act_in_app').execute({ target: 'Notes', steps: [{ do: 'click_text', text: 'Pay' }] }, {}));
  assert.ok(!f4d.includes('Alex') && f4d.startsWith("A step didn't work in Notes."), f4d);

  // ---- F3: draw checks the windows it reads by their files (the helper now sends them on 'windows' and 'locate'). A
  // relay turn: a key file open in an editor is blocked, not asked about as "no file I can check", and a plain
  // Documents read in a viewer asks nothing. On this Mac: the key file is blocked too, as read_window blocks it.
  reset({ wins: [{ id: 4, app: 'TextEdit', title: '.env', doc: env, text: 'OPENAI_API_KEY=sk-live-abc123' }, preview] });
  const f3a = await ring('TextEdit', 'OPENAI_API_KEY');
  assert.ok(f3a.includes('Blocked for safety: TextEdit shows') && !f3a.includes('sk-live'), f3a);
  assert.deepEqual(asks, []);
  reset({ wins: [preview] });
  const f3b = await ring('Preview', 'Hello');
  assert.ok(f3b.startsWith('Drew '), f3b);
  // hands-win says no file, so there a relay read asks.
  if (process.platform !== 'win32') assert.deepEqual(asks, [], 'a plain read of Documents in Preview asks nothing');
  reset({ wins: [{ id: 4, app: 'TextEdit', title: 'id_rsa', doc: key, text: '-----BEGIN OPENSSH PRIVATE KEY-----' }, preview] }, { relay: false });
  const f3c = await ring('TextEdit', 'BEGIN');
  assert.ok(f3c.includes('Blocked for safety: TextEdit shows') && !f3c.includes('PRIVATE KEY'), f3c);
  assert.ok(!calls().some((c) => c[0] === 'find-text' || c[0] === 'ocr-find'), 'nothing is read off a key file\'s window');
  reset({ wins: [term] }, { relay: false });
  const f3d = await ring('Terminal', 'TOKEN');
  assert.ok(f3d.startsWith('Drew '), f3d);
  assert.deepEqual(asks, [], 'on this Mac draw still asks nothing');
  // A key file in the app's window behind the one located (find-text 'app:X' searches it too): known from 'windows'.
  for (const relay of [true, false]) {
    reset({ wins: [{ ...preview, app: 'TextEdit' }, { id: 4, app: 'TextEdit', title: '.env', doc: env, text: 'OPENAI_API_KEY=sk-live-abc123' }] }, { relay });
    const f3e = await ring('TextEdit', 'OPENAI_API_KEY');
    assert.ok(f3e.includes('Blocked for safety: TextEdit shows') && !f3e.includes('sk-live'), f3e);
    assert.deepEqual(asks, []);
  }

  assert.ok(!fs.existsSync(launched), `nothing launched: ${fs.existsSync(launched) ? fs.readFileSync(launched, 'utf8') : ''}`);
}

// ---- F1: an addition sent during the final answer's first token, and the turn then ends in an error result or a
// crash: Claude Code's uuids (on the error result, or on the stream's stamps) say it never took it, so it is named.
const ev = (event, stamp) => ({ type: 'stream_event', parent_tool_use_id: null, event, ...(stamp ? { user_message_uuid: stamp.at(-1), user_message_uuids: stamp } : {}) });
const step = (text, stop, stamp) => [ev({ type: 'message_start', message: { usage: {} } }, stamp), ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }), ev({ type: 'message_delta', delta: { stop_reason: stop }, usage: {} }), ev({ type: 'message_stop' })];
// Stamped as sdk.d.ts says a typed turn is (R11g-5): only the turn's first frame of each kind keeps the uuids; a result
// ends the turn.
const firstStamps = async function* (src) {
  let kinds = new Set();
  for await (const m of src) {
    if (m.type === 'result') kinds = new Set();
    else if (m.user_message_uuids) { if (kinds.has(m.type)) { const { user_message_uuid, user_message_uuids, ...rest } = m; void user_message_uuid; void user_message_uuids; yield rest; continue; } kinds.add(m.type); }
    yield m;
  }
};
const fakeQuery = (gen) => ({ prompt }) => { const it = prompt[Symbol.asyncIterator](); return Object.assign(firstStamps(gen(it)), { interrupt: async () => {}, close: () => {} }); };
const agentWith = (query) => new ClaudeCodeAgent({ model: 'm', system: 's', tools: [], executable: '/bin/claude', cwd: '/', env: {}, query, onRateLimit: () => {} });
const runIt = async (agent) => { try { for await (const e of agentEvents(agent.prompt('what is on Thursday?'))) void e; return null; } catch (e) { return e.message; } };
for (const kind of ['error_result', 'crash']) {
  let agent;
  agent = agentWith(fakeQuery(async function* (it) {
    const first = (await it.next()).value;
    assert.equal(agent.addInput('and Friday?'), true);
    yield* step('Thursday: dentist.', 'end_turn', [first.uuid]);
    if (kind === 'error_result') yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'], usage: {}, user_message_uuids: [first.uuid], queued_turn_count: 1 };
    throw new Error('Claude Code process exited with code 1');
  }));
  assert.ok(await runIt(agent), kind);
  assert.deepEqual(agent.unanswered(), ['and Friday?'], kind);
}
// Not over-named: an addition the turn took before its final answer, then an error after it, was answered; one it took
// but was cut before answering (max turns) is named.
{
  let agent;
  agent = agentWith(fakeQuery(async function* (it) {
    const first = (await it.next()).value;
    agent.addInput('and Friday?');
    const second = (await it.next()).value;
    yield* step('Thursday: dentist. Friday: free.', 'end_turn', [first.uuid, second.uuid]);
    yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'], usage: {}, user_message_uuids: [first.uuid, second.uuid] };
  }));
  assert.equal(await runIt(agent), 'boom');
  assert.deepEqual(agent.unanswered(), []);
  agent = agentWith(fakeQuery(async function* (it) {
    const first = (await it.next()).value;
    yield* step('Checking.', 'tool_use', [first.uuid]);
    agent.addInput('and Friday?');
    const second = (await it.next()).value;
    yield* step('Still checking.', 'tool_use', [first.uuid, second.uuid]);
    yield { type: 'result', subtype: 'error_max_turns', is_error: true, errors: [], usage: {}, user_message_uuids: [first.uuid, second.uuid] };
  }));
  assert.equal(await runIt(agent), null);
  assert.deepEqual(agent.unanswered(), ['and Friday?']);
}
console.log('eleventhf: ok');
