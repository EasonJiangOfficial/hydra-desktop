// Round 11 review, third pass (R11c): the probes of scratchpad v11c, as behavior tests with fakes. Each block fails
// without its fix. Run: npm test (temp home, fake helper, fake Claude Code). Windows' screenshot: eleventhcwin.test.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkWindow } from '../safety.mjs';
import { askMacTool } from '../brain-server.mjs';
import { ClaudeCodeAgent } from '../claudecode.mjs';
import { agentEvents } from '../agentstream.mjs';

const HOME = fs.realpathSync.native(os.homedir());
assert.ok(HOME.includes('roamies-test-') || HOME.startsWith(fs.realpathSync.native(os.tmpdir())), 'runs only with a temp home');
const docFile = path.join(HOME, 'Documents', 'n.txt');
fs.mkdirSync(path.dirname(docFile), { recursive: true });

// ---- R11c-1 (source): every relay turn and sub-turn is its own request, before any tool runs.
{
  const src = fs.readFileSync(new URL('../sidekick.mjs', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('async function relayTurn('), src.indexOf('const agentRun = new ClaudeCodeAgent', src.indexOf('async function relayTurn(')));
  assert.match(body, /\n\s*nextTurn\(\);/, 'relayTurn calls nextTurn()');
}

// ---- R11c-6: a code editor's window is no plain read in a relay turn; a single-document app still is.
for (const app of ['Visual Studio Code', 'Cursor', 'Xcode', 'Zed', 'Windsurf', 'Antigravity']) {
  assert.equal(checkWindow({ id: 1, app, title: 'n.txt', document: docFile }, HOME, { viewers: false }).level, 'ask', app);
}
assert.equal(checkWindow({ id: 1, app: 'TextEdit', title: 'n.txt', document: docFile }, HOME, { viewers: false }).level, 'safe');

// ---- The tools against a fake helper (macOS and Windows have one).
if (['darwin', 'win32'].includes(process.platform)) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-11c-'));
  const log = path.join(dir, 'calls.jsonl'), fake = path.join(dir, 'hands.mjs'), state = path.join(dir, 'state.json');
  // state: { front: 'te' | 'term', ocr9 }: the front app (read on every call), what OCR finds in Safari's window 9.
  fs.writeFileSync(fake, `import fs from 'node:fs'; const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + '\\n');
const st = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
const safari = { id: 9, app: 'Safari', title: 'Mail - inbox', url: 'https://mail.example.com', bounds: [0, 0, 800, 600] };
const te = { id: 3, app: 'TextEdit', title: 'n.txt', document: ${JSON.stringify(docFile)}, bounds: [0, 0, 800, 600] };
const term = { id: 7, app: 'Terminal', title: 'ssh prod', bounds: [0, 0, 800, 600] };
const front = st.front === 'term' ? term : te;
let o = { ok: true, window: front, controls: [], texts: [], note: '' };
if (a[0] === 'find-text') o = { ok: true, matches: [{ text: st.front === 'term' ? 'export TOKEN=sk-live-zzz' : 'Hello', role: 'AXStaticText', bounds: [10, 10, 50, 10] }].filter((m) => m.text.includes(a[2])) };
if (a[0] === 'ocr-find') o = { ok: true, matches: a[1] === 'window:9' ? [{ text: 'reset code 418-223', bounds: [10, 10, 50, 10] }] : [] };
if (a[0] === 'windows') o = { ok: true, windows: st.windows ?? [front] };
if (a[0] === 'locate') o = a[1] === 'window:9' ? { ok: true, window: safari } : a[1] === 'window:7' ? { ok: true, window: term } : a[1] === 'window:404' ? { ok: false, error: 'No matching window' } : { ok: true, window: front };
if (a[0] === 'front') o = { ok: true, ...front };
if (a[0] === 'capture') { fs.writeFileSync(a[1], 'x'); o = a[2] === 'screen' ? { ok: true, file: a[1], what: 'screen', bounds: [0, 0, 1440, 900], shown: st.windows ?? [], pixels: [1440, 900] } : { ok: true, file: a[1], window: a[2] === 'app:Safari' ? safari : front, pixels: [800, 600] }; }
if (a[0] === 'manage') o = { ok: true, done: 'quit' };
if (a[0] === 'act') o = { ok: true, window: front, controls: [{ role: 'AXStaticText', label: 'export TOKEN=sk-live-zzz', bounds: [1, 1, 5, 5] }], texts: [], done: ['pressed return'] };
console.log(JSON.stringify(o));
`);
  process.env.ROAMIES_HANDS = fake;
  const { createTools } = await import('../tools.mjs');
  const asks = [];
  let answer = null, remote = false, onDraw = () => {};
  const t = createTools({ remote: () => remote, allowActions: () => true, ui: (m) => { if (m?.e?.type === 'draw') { onDraw(m.e.seg); setTimeout(() => t.ink.started(m.e.id, m.e.seg), 5); } }, ask: async (o) => { asks.push(o.placeholder); return typeof answer === 'function' ? answer(o.placeholder) : answer; }, openUrl: async () => {}, onCommitments: () => {}, showList: () => {}, fmtWhen: String, commitmentsText: () => '', userName: 'Test', workdir: HOME, skills: { changed: () => {} } });
  const T = (n) => t.tools.find((x) => x.name === n);
  const calls = () => fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const reset = (st = {}) => { fs.writeFileSync(log, ''); asks.length = 0; answer = null; onDraw = () => {}; fs.writeFileSync(state, JSON.stringify({ front: 'te', ...st })); };

  // ---- R11c-1: a draw reads the window of the latest screenshot; in a relay turn that window is the one checked.
  reset();
  t.nextTurn(); remote = false;
  await T('take_screenshot').execute({ target: 'Safari' }, {}); // a local request: Safari, free here
  remote = true; fs.writeFileSync(log, '');
  const r1 = await T('draw').execute({ target: 'front', beats: [{ say: 'Here.', marks: [{ kind: 'ring', at: { text: '418' } }] }] }, { toolCallId: 'c1' }).then((x) => x, (e) => e);
  assert.ok(asks.some((q) => q.includes("Safari")), `Safari is asked about: ${JSON.stringify(asks)}`);
  assert.ok(!calls().some((c) => c[0] === 'ocr-find' && c[1] === 'window:9'), 'Safari is not read before a yes');
  assert.ok(!String(r1?.message ?? r1).includes('418-223'), String(r1?.message ?? r1));

  // ---- R11c-2: each beat checks the window it reads again; the front app changing between beats asks.
  reset();
  t.nextTurn();
  onDraw = (seg) => { if (seg === 0) fs.writeFileSync(state, JSON.stringify({ front: 'term' })); };
  const r2 = await T('draw').execute({ target: 'front', beats: [{ say: 'One.', marks: [{ kind: 'ring', at: { text: 'Hello' } }] }, { say: 'Two.', marks: [{ kind: 'ring', at: { text: 'export' } }] }] }, { toolCallId: 'c2' });
  assert.equal(asks.length, 1, JSON.stringify(asks));
  assert.ok(asks[0].includes('Terminal'), asks[0]);
  assert.equal(calls().filter((c) => c[0] === 'find-text').length, 1, 'Terminal is never searched without a yes');
  assert.ok(!r2.includes('sk-live'), r2);
  // The same window over several beats: asked once.
  reset({ front: 'term' });
  t.nextTurn();
  answer = 'Allow';
  await T('draw').execute({ target: 'front', beats: [{ say: 'One.', marks: [{ kind: 'ring', at: { text: 'export' } }] }, { say: 'Two.', marks: [{ kind: 'ring', at: { text: 'export' } }] }, { say: 'Three.', marks: [{ kind: 'ring', at: { text: 'zzz' } }] }] }, { toolCallId: 'c3' }).catch(() => {});
  assert.equal(asks.length, 1, JSON.stringify(asks));

  // ---- R11c-7: a relay turn's whole-screen ask fits the relay's 500 characters, however many windows are up.
  reset({ windows: Array.from({ length: 8 }, (_, i) => ({ id: 20 + i, app: `App${i}`, title: `Window title number ${i}` })) });
  await assert.rejects(T('take_screenshot').execute({ target: 'screen' }, {}), /said no/);
  assert.equal(asks.length, 1);
  assert.ok(asks[0].length <= 500 && asks[0].includes('whole screen'), `${asks[0].length}: ${asks[0]}`);

  // ---- R11c-5: in a relay turn, the window after act_in_app's steps is asked about before its text comes back.
  reset({ front: 'term' });
  t.nextTurn();
  answer = (q) => (/^In Terminal|every step/i.test(q) ? 'Allow' : null);
  const r5 = await T('act_in_app').execute({ target: 'Terminal', steps: [{ do: 'key', key: 'return' }] }, {}).then((x) => x, (e) => e);
  const out5 = String(r5?.message ?? r5);
  assert.ok(!out5.includes('sk-live'), out5);
  assert.ok(asks.some((q) => q.includes('the Terminal window')), JSON.stringify(asks));
  assert.match(out5, /: press return\. /, 'it still says what ran, in the approved step\'s own words (R11d F4)');

  if (process.platform === 'darwin') {
    // ---- R11c-4: manage_app with a window names that window's own app, not the app given.
    reset();
    await assert.rejects(T('manage_app').execute({ do: 'quit', app: 'TextEdit', window: 7 }, {}), /said no/);
    assert.ok(asks[0].includes('Terminal') && !asks[0].includes('TextEdit'), asks[0]);
    reset();
    await assert.rejects(T('manage_app').execute({ do: 'close', window: 404 }, {}), /no window 404/);
    assert.equal(asks.length, 0);
    assert.ok(!calls().some((c) => c[0] === 'manage'));
  }
  remote = false;
}

// ---- Fake Claude Code (the SDK query seam), as eleventhb.test.mjs.
const ev = (event) => ({ type: 'stream_event', parent_tool_use_id: null, event });
const step = (text, stop) => [ev({ type: 'message_start', message: { usage: {} } }), ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }), ev({ type: 'message_delta', delta: { stop_reason: stop }, usage: {} }), ev({ type: 'message_stop' })];
const agentWith = (query) => new ClaudeCodeAgent({ model: 'm', system: 's', tools: [], executable: '/bin/claude', cwd: '/', env: {}, query, onRateLimit: () => {} });

// ---- R11c-B1: an addition sent while the final request was out is not counted answered by that answer: Claude Code's
// result names the messages its turn took, and the addition's own turn is waited for.
{
  let agent, second = false;
  const texts = [];
  const query = ({ prompt }) => {
    const it = prompt[Symbol.asyncIterator]();
    async function* g() {
      const first = (await it.next()).value;
      assert.equal(typeof first.uuid, 'string', 'each user message has a uuid');
      assert.equal(agent.addInput('and Friday?'), true); // lands during the final answer's time to first token
      yield* step('Thursday: dentist.', 'end_turn');
      yield { type: 'result', subtype: 'success', is_error: false, result: 'Thursday: dentist.', usage: {}, user_message_uuid: first.uuid, user_message_uuids: [first.uuid] };
      const add = (await it.next()).value;
      second = true;
      yield* step(' Friday: nothing.', 'end_turn');
      yield { type: 'result', subtype: 'success', is_error: false, result: 'Friday: nothing.', usage: {}, user_message_uuid: add.uuid, user_message_uuids: [add.uuid] };
    }
    return Object.assign(g(), { interrupt: async () => {}, close: () => {} });
  };
  agent = agentWith(query);
  for await (const e of agentEvents(agent.prompt('what is on Thursday?'))) if (e.type === 'text_delta') texts.push(e.text);
  assert.ok(second, 'the addition got its own turn');
  assert.deepEqual(texts, ['Thursday: dentist.', ' Friday: nothing.']);
  assert.deepEqual(agent.unanswered(), []);
}
{
  // Folded into the running turn (Claude Code lists it): answered by that turn, nothing waited for.
  let agent;
  const query = ({ prompt }) => {
    const it = prompt[Symbol.asyncIterator]();
    async function* g() {
      const first = (await it.next()).value;
      yield* step('Checking.', 'tool_use');
      agent.addInput('and Friday?');
      const add = (await it.next()).value;
      yield* step('Thursday and Friday: free.', 'end_turn');
      yield { type: 'result', subtype: 'success', is_error: false, result: 'x', usage: {}, user_message_uuids: [first.uuid, add.uuid] };
      await new Promise(() => {}); // nothing more ever comes
    }
    return Object.assign(g(), { interrupt: async () => {}, close: () => {} });
  };
  agent = agentWith(query);
  for await (const e of agentEvents(agent.prompt('what is on Thursday?'))) void e;
  assert.deepEqual(agent.unanswered(), []);
}

// ---- R11c-B2: an error that merely says "abort" (nobody pressed Stop) is an error, and the addition is named.
{
  let agent;
  const query = ({ prompt }) => {
    const it = prompt[Symbol.asyncIterator]();
    async function* g() {
      await it.next();
      yield* step('Checking Thursday.', 'tool_use');
      agent.addInput('and Friday?');
      await it.next();
      yield* step('Still on Thursday.', 'tool_use');
      throw new Error('Request was aborted.');
    }
    return Object.assign(g(), { interrupt: async () => {}, close: () => {} });
  };
  agent = agentWith(query);
  await assert.rejects((async () => { for await (const e of agentEvents(agent.prompt('what is on Thursday?'))) void e; })(), /aborted/);
  assert.deepEqual(agent.unanswered(), ['and Friday?']);
}

// ---- R11c-B3: ask_mac stops when its own call is cancelled (Claude Code's cancel, the bridge closing, the timeout).
{
  let gets = 0;
  const api = { req: async (url, o) => {
    if (o?.method === 'POST') return { status: 201, ok: true, json: async () => ({ subTurnId: 's1' }) };
    gets++;
    return { status: 200, ok: true, json: async () => ({ status: 'claimed', text: '' }) };
  } };
  const call = new AbortController();
  const tool = askMacTool({ api, turn: { id: 't', claimId: 'c' }, waitMs: 3000, sleep: async () => { if (gets >= 2) call.abort(); } });
  await assert.rejects(tool.execute({ instruction: 'look' }, { signal: call.signal }), /Stopped/);
  assert.ok(gets <= 3, `stopped after ${gets} polls`);
  assert.match(await tool.execute({ instruction: 'look' }, {}), /may already be doing this/, 'the sub-turn was made: unsure after');
}
console.log('eleventhc: ok');
