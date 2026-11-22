// Round 11f review (R11g): the probes of scratchpad v11f-rule-1 and v11f-relay-1, as behavior tests with fakes. Each
// block fails without its fix. Run: npm test (temp home, fake helper, fake Claude Code, and fake open/osascript/
// screencapture first on PATH, so nothing here can reach the real Mac).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeCodeAgent } from '../claudecode.mjs';
import { agentEvents } from '../agentstream.mjs';
import { BLOCK, checkWindow } from '../safety.mjs';
import { fakeHands } from './fakehands.mjs';
import { z } from 'zod';

const HOME = fs.realpathSync.native(os.homedir());
assert.ok(HOME.includes('roamies-test-') || HOME.startsWith(fs.realpathSync.native(os.tmpdir())), 'runs only with a temp home');

// ---- G3: a window that says no file (hands-win never does; some Mac editors set no document): a key file's name in its
// title blocks it. A title naming no key file, or a browser page whose address was read, does not.
for (const title of ['.env - Notepad', '*id_rsa - Notepad', 'id_rsa — Edited', '● .env.local — shop — Visual Studio Code', 'credentials - Notepad', '~/.ssh/config', 'cat ~/.aws/credentials'])
  assert.equal(checkWindow({ app: 'Notepad', title }, HOME).level, BLOCK, title);
for (const w of [{ app: 'Notepad', title: 'notes.txt - Notepad' }, { app: 'TextEdit', title: 'my-env - draft' }, { app: 'Google Chrome', title: 'Token', url: 'https://example.com/' }])
  assert.notEqual(checkWindow(w, HOME).level, BLOCK, w.title);

// ---- The tools against the shared fake helper (fakehands.mjs), modeled on hands/main.swift (and, with win: true,
// hands-win): 'windows' sends each window's file but no address (win: neither, plus exe), 'locate' and 'ui' its file and
// address (win: neither), find-text 'screen' every window, 'front' the front app's, 'app:X' every match; each match's
// window bare.
if (['darwin', 'win32'].includes(process.platform)) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-11g-'));
  const bin = path.join(dir, 'bin'), launched = path.join(dir, 'launched.log');
  fs.mkdirSync(bin);
  for (const c of ['open', 'osascript', 'screencapture']) fs.writeFileSync(path.join(bin, c), `#!/bin/sh\necho ${c} "$@" >> '${launched}'\nexit 1\n`, { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  const doc = path.join(HOME, 'Documents', 'n.txt'), env = path.join(HOME, 'Documents', 'shop', '.env');
  for (const f of [doc, env]) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'x'); }
  const fake = fakeHands(dir);
  const { createTools } = await import('../tools.mjs');
  const asks = [], opened = [];
  let remote = true, onDraw = null;
  const t = createTools({ remote: () => remote, allowActions: () => true, ui: (msg) => { if (msg?.e?.type === 'draw') { setTimeout(() => t.ink.started(msg.e.id, msg.e.seg), 5); onDraw?.(msg.e); } }, ask: async (o) => { asks.push(o.placeholder); return 'Allow'; }, openUrl: async (u) => { opened.push(u); }, onCommitments: () => {}, showList: () => {}, fmtWhen: String, commitmentsText: () => '', userName: 'Test', workdir: HOME, skills: { changed: () => {} } });
  const T = (n) => t.tools.find((x) => x.name === n);
  const calls = () => fake.calls();
  const set = (st) => fake.set(st);
  const reset = (st, relay) => { fake.clear(); asks.length = 0; opened.length = 0; onDraw = null; remote = relay; set(st); t.nextTurn(); };
  const said = (p) => p.then((x) => String(x), (e) => String(e?.message ?? e));
  const ring = (target, text) => said(T('draw').execute({ target, beats: [{ say: 'Here.', marks: [{ kind: 'ring', at: { text } }] }] }, { toolCallId: `g${Math.random()}` }));
  const KEY = 'OPENAI_API_KEY=sk-live-abc123';
  const preview = { id: 3, pid: 30, app: 'Preview', title: 'n.txt', doc, text: 'Hello' };
  const te = { id: 4, pid: 40, app: 'TextEdit', title: 'shop', doc: env, text: KEY };
  const WHOLE = 'Look at your whole screen? Every app and window on it, with banners, pop-ups and alerts, is in it.';

  // ---- G1: draw on the whole screen checks its windows for a key file at every beat: one that opens after beat 1's
  // click is blocked at beat 2, on this Mac and in a relay turn. The whole-screen question is still asked once.
  for (const relay of [false, true]) {
    reset({ frontPid: 30, wins: [preview] }, relay);
    onDraw = (e) => { if (e.seg === 0) setTimeout(() => { set({ frontPid: 40, wins: [te, preview] }); t.ink.waitDone(e.id, 1, 'clicked'); }, 50); };
    const g1 = await said(T('draw').execute({ target: 'screen', beats: [{ say: 'Click the file.', marks: [{ kind: 'ring', at: { text: 'Hello' } }], wait: 'click' }, { say: 'The key line.', marks: [{ kind: 'ring', at: { text: 'OPENAI_API_KEY' } }] }] }, { toolCallId: `g1${relay}` }));
    assert.ok(!g1.includes('sk-live'), g1);
    assert.match(g1, /Stopped before beat 2: .*Blocked for safety: TextEdit shows/, g1);
    assert.deepEqual(asks, relay ? [WHOLE] : [], 'the whole screen is asked once a drawing');
  }

  // ---- G2: a key file open as a file:// page in a browser window 'windows' gives no address for (one behind the
  // located one, or any for the whole screen) is blocked, on this Mac and in a relay turn: each browser window's address
  // is read first. Not on Windows, whose helper reads none (G3's title check covers it there).
  if (process.platform !== 'win32') {
    const safA = { id: 10, pid: 50, app: 'Safari', title: 'Example', url: 'https://example.com/', text: 'Example Domain' };
    const safB = { id: 11, pid: 50, app: 'Safari', title: 'shop', url: `file://${env}`, text: KEY };
    for (const relay of [false, true]) {
      for (const [target, wins, front] of [['Safari', [safA, safB, preview], 50], ['screen', [preview, safA, safB], 30]]) {
        reset({ frontPid: front, wins }, relay);
        const g2 = await ring(target, 'OPENAI_API_KEY');
        assert.ok(!g2.includes('sk-live') && g2.includes('Blocked for safety: Safari shows'), `${target} ${relay}: ${g2}`);
        assert.ok(!calls().some((c) => c[0] === 'find-text'), 'nothing is read off the screen first');
      }
    }
    // A relay turn: a browser window whose address couldn't be read isn't said to have "no file I can check".
    reset({ frontPid: 50, wins: [{ id: 12, pid: 50, app: 'Safari', title: 'Start Page', text: 'Favorites' }] }, true);
    await ring('Safari', 'Favorites');
    assert.equal(asks.length, 1, JSON.stringify(asks));
    assert.ok(asks[0].includes("couldn't read which page or file it shows") && !asks[0].includes('no file I can check'), asks[0]);
  }

  // ---- G3: as hands-win sends windows (no file, no address): a .env open in Notepad is blocked by its title, on this
  // Mac and in a relay turn, before any of its words are read.
  for (const relay of [false, true]) {
    reset({ win: true, frontPid: 70, wins: [{ id: 21, pid: 70, app: 'Notepad', exe: 'notepad.exe', title: '.env - Notepad', text: KEY }] }, relay);
    const g3 = await ring('Notepad', 'OPENAI_API_KEY');
    assert.ok(!g3.includes('sk-live') && !g3.includes('.env') && g3.includes("Blocked for safety: Notepad's window title names a file"), g3);
    assert.deepEqual(asks, []);
    assert.ok(!calls().some((c) => c[0] === 'find-text'), 'nothing is read off a key file\'s window');
  }

  // ---- G4: only the helper's own "Hydra needs Accessibility permission" opens System Settings, and never in a relay
  // turn. A step error that quotes the word (a link called "Accessibility statement") is an ordinary error.
  if (process.platform === 'darwin') {
    const help = { id: 9, pid: 60, app: 'Safari', title: 'Help', url: 'https://example.com/help', text: 'Help' };
    const quoted = { ok: false, error: 'Step 1: no visible text "Accessibility statement" in Safari. Check the exact words with a screenshot or read_window.', done: [] };
    const act = () => said(T('act_in_app').execute({ target: 'Safari', steps: [{ do: 'click_text', text: 'Accessibility statement' }] }, {}));
    for (const relay of [true, false]) {
      reset({ frontPid: 60, wins: [help], act: quoted }, relay);
      const g4 = await act();
      assert.deepEqual(opened, [], `${relay}: ${g4}`);
      assert.ok(!g4.includes('Accessibility is off'), g4);
    }
    const off = { ok: false, error: 'Hydra needs Accessibility permission to control other apps.' };
    reset({ frontPid: 60, wins: [help], act: off }, true);
    const g4r = await act();
    assert.deepEqual(opened, [], 'a relay turn opens nothing on the Mac');
    assert.match(g4r, /^Accessibility is off for Hydra on the Mac/, g4r);
    reset({ frontPid: 60, wins: [help], act: off }, false);
    const g4l = await act();
    assert.deepEqual(opened, ['x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'], g4l);
    assert.match(g4l, /^Accessibility is off for Hydra, so I can't read or control other apps yet\./, g4l);
  }

  assert.ok(!fs.existsSync(launched), `nothing launched: ${fs.existsSync(launched) ? fs.readFileSync(launched, 'utf8') : ''}`);
}

// ---- G5: stamped as sdk.d.ts says a typed turn is (only its first frame of each kind names the uuids; folded messages
// appear on the result alone). An addition folded in between tool rounds and answered by the final answer is not named
// when the run then crashes, gets a zeroed error result or just ends; one sent after the round's tool results came
// back (it waits for its own turn) still is. The tool runs through the bridge (R11h-1): only there is the order provable.
const ev = (event, stamp) => ({ type: 'stream_event', parent_tool_use_id: null, event, ...(stamp ? { user_message_uuid: stamp.at(-1), user_message_uuids: stamp } : {}) });
const step = (text, stop, stamp) => [ev({ type: 'message_start', message: { usage: {} } }, stamp), ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }), ev({ type: 'message_delta', delta: { stop_reason: stop }, usage: {} }), ev({ type: 'message_stop' })];
const toolResult = { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } };
const firstStamps = async function* (src) {
  let kinds = new Set();
  for await (const m of src) {
    if (m.type === 'result') kinds = new Set();
    else if (m.user_message_uuids) { if (kinds.has(m.type)) { const { user_message_uuid, user_message_uuids, ...rest } = m; void user_message_uuid; void user_message_uuids; yield rest; continue; } kinds.add(m.type); }
    yield m;
  }
};
// The bridge as Claude Code drives it: call(id) runs our tool and waits for its result to be handed back.
const fakeQuery = (gen) => ({ prompt, options }) => {
  const it = prompt[Symbol.asyncIterator](), waiting = new Map();
  const transport = { async send(msg) { waiting.get(msg.id)?.(msg); } };
  const ready = options.mcpServers.gg.instance.connect(transport);
  let n = 0;
  const call = async (id) => { await ready; return new Promise((r) => { const k = ++n; waiting.set(k, r); transport.onmessage({ jsonrpc: '2.0', id: k, method: 'tools/call', params: { name: 'look', arguments: {}, _meta: { 'claudecode/toolUseId': id } } }); }); };
  return Object.assign(firstStamps(gen(it, call)), { interrupt: async () => {}, close: () => {} });
};
const look = { name: 'look', description: 'Look.', parameters: z.object({}), execute: async () => 'ok' };
const agentWith = (query) => new ClaudeCodeAgent({ model: 'm', system: 's', tools: [look], executable: '/bin/claude', cwd: '/', env: {}, query, onRateLimit: () => {} });
// The owner speaks after what came before has reached the loop (the fake would otherwise run ahead of it).
const later = () => new Promise((r) => setTimeout(r, 20));
const runIt = async (agent, text = 'clean up my desktop') => { try { for await (const e of agentEvents(agent.prompt(text))) void e; return 'ended'; } catch (e) { return e.message; } };
const ends = { crash: () => { throw new Error('Claude Code process exited with code 1'); }, zeroed: () => [{ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'], usage: {} }], plain: () => [] };
for (const [end, tail] of Object.entries(ends)) {
  for (const late of [false, true]) {
    let agent;
    agent = agentWith(fakeQuery(async function* (it, call) {
      const first = (await it.next()).value;
      yield* step('Looking at the desktop.', 'tool_use', [first.uuid]);
      if (late) { await call('t1'); yield toolResult; }
      await later();
      assert.equal(agent.addInput('and delete the old draft too'), true);
      await it.next();
      if (!late) { await call('t1'); yield toolResult; }
      yield* step('Done: desktop tidied and the old draft deleted.', 'end_turn', [first.uuid]);
      yield* tail();
    }));
    await runIt(agent);
    assert.deepEqual(agent.unanswered(), late ? ['and delete the old draft too'] : [], `${end} late=${late}`);
  }
}
// The same in a run's second turn (after a result that named its uuids): only this turn's folds count.
{
  let agent;
  agent = agentWith(fakeQuery(async function* (it, call) {
    const first = (await it.next()).value;
    agent.addInput('and Friday?');
    yield* step('Thursday: dentist.', 'end_turn', [first.uuid]);
    yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: {}, user_message_uuids: [first.uuid] };
    const a = (await it.next()).value;
    yield* step('Checking Friday.', 'tool_use', [a.uuid]);
    await later();
    agent.addInput('and delete the old draft too');
    await it.next();
    await call('t1');
    yield toolResult;
    yield* step('Friday: free. Old draft deleted.', 'end_turn', [a.uuid]);
    throw new Error('Claude Code process exited with code 1');
  }));
  await runIt(agent, 'what is on Thursday?');
  assert.deepEqual(agent.unanswered(), []);
}
console.log('eleventhg: ok');
