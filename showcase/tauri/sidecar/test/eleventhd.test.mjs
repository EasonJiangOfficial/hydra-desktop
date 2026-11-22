// Round 11c review, fourth pass (R11d): the probes of scratchpad v11c, as behavior tests with fakes. Each block fails
// without its fix. Run: npm test (temp home, fake helper, fake Claude Code).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { askMacTool } from '../brain-server.mjs';
import { delay } from '../hydramcp.mjs';
import { ClaudeCodeAgent } from '../claudecode.mjs';
import { agentEvents } from '../agentstream.mjs';

const HOME = fs.realpathSync.native(os.homedir());
assert.ok(HOME.includes('roamies-test-') || HOME.startsWith(fs.realpathSync.native(os.tmpdir())), 'runs only with a temp home');
const docFile = path.join(HOME, 'Documents', 'n.txt');
fs.mkdirSync(path.dirname(docFile), { recursive: true });
fs.writeFileSync(docFile, 'x');

if (['darwin', 'win32'].includes(process.platform)) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-11d-'));
  const log = path.join(dir, 'calls.jsonl'), fake = path.join(dir, 'hands.mjs'), state = path.join(dir, 'state.json');
  // The real helpers' find-text 'app:X': every window whose app fuzzily matches X (hands/main.swift appMatches).
  fs.writeFileSync(fake, `import fs from 'node:fs'; const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + '\\n');
const st = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
const wins = [{ id: 3, app: 'Preview', title: 'n.txt', document: ${JSON.stringify(docFile)}, bounds: [0, 0, 800, 600] }, { id: 7, app: 'Terminal', title: 'ssh prod', bounds: [0, 0, 800, 600] }, { id: 5, app: 'Messages', title: 'Mom', bounds: [0, 0, 800, 600] }];
const m = (app, want) => { const w = want.toLowerCase().trim(), x = app.toLowerCase(); return x === w || x.includes(w) || w.includes(x); };
const text = { 3: 'Hello', 7: 'export TOKEN=sk-live-zzz', 5: 'Hi' };
const sel = (t) => t === 'front' ? [wins[0]] : t.startsWith('app:') ? wins.filter((w) => m(w.app, t.slice(4))) : t.startsWith('window:') ? wins.filter((w) => w.id === +t.slice(7)) : [];
let o = { ok: true };
if (a[0] === 'windows') o = { ok: true, windows: wins };
if (a[0] === 'locate') { const w = sel(a[1])[0]; o = w ? { ok: true, window: w } : { ok: false, error: 'No matching window' }; }
if (a[0] === 'front') o = { ok: true, ...wins[0] };
if (a[0] === 'find-text') o = { ok: true, matches: sel(a[1]).filter((w) => text[w.id].includes(a[2])).map((w) => ({ text: text[w.id], role: 'AXStaticText', bounds: [10, 10, 50, 10], window: w })) };
if (a[0] === 'ocr-find') o = { ok: true, matches: [] };
// As the helper words them: hover's newly shown labels, click_text's whole text (main.swift:2649, :2368), and a fill
// that didn't take (:2393).
if (a[0] === 'act') o = st.actFails ? { ok: false, error: 'The text field still shows "Your bank PIN is 9921"' } : { ok: true, window: wins[2], controls: [], texts: [], done: ['hovered "Mom" (now showing: Your code is 418-223, Reply)', 'clicked "Your bank PIN is 9921, do not share"'] };
console.log(JSON.stringify(o));
`);
  process.env.ROAMIES_HANDS = fake;
  const { createTools, appMatches } = await import('../tools.mjs');
  const asks = [];
  let answer = null;
  const t = createTools({ remote: () => true, allowActions: () => true, ui: (m) => { if (m?.e?.type === 'draw') setTimeout(() => t.ink.started(m.e.id, m.e.seg), 5); }, ask: async (o) => { asks.push(o.placeholder); return typeof answer === 'function' ? answer(o.placeholder) : answer; }, openUrl: async () => {}, onCommitments: () => {}, showList: () => {}, fmtWhen: String, commitmentsText: () => '', userName: 'Test', workdir: HOME, skills: { changed: () => {} } });
  const T = (n) => t.tools.find((x) => x.name === n);
  const calls = () => fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const reset = (st = {}) => { fs.writeFileSync(log, ''); asks.length = 0; answer = null; fs.writeFileSync(state, JSON.stringify(st)); t.nextTurn(); };

  // ---- F1: a fuzzy app name ("Preview Terminal") is gated as the helper searches it: Terminal too, before any read.
  assert.ok(appMatches({ app: 'Terminal' }, 'Preview Terminal') && appMatches({ app: 'Microsoft Edge', exe: 'msedge' }, 'msedge.exe') && appMatches({ app: 'Safari' }, 'browser'));
  assert.ok(!appMatches({ app: 'Notes' }, 'Terminal'));
  reset();
  const r1 = await T('draw').execute({ target: 'Preview Terminal', beats: [{ say: 'Here.', marks: [{ kind: 'ring', at: { text: 'sk-live' } }] }] }, { toolCallId: 'f1' }).then((x) => x, (e) => e);
  assert.ok(asks.some((q) => q.includes('Terminal')), `Terminal is asked about: ${JSON.stringify(asks)}`);
  assert.ok(!calls().some((c) => c[0] === 'find-text'), 'nothing is searched before a yes');
  assert.ok(!String(r1?.message ?? r1).includes('sk-live-zzz'), String(r1?.message ?? r1));

  // ---- F4: a no to the window after act_in_app returns only the approved steps' words, none of the helper's.
  reset();
  answer = (q) => (/every step/.test(q) ? 'Allow' : null);
  const r4 = String(await T('act_in_app').execute({ target: 'Messages', steps: [{ do: 'hover', text: 'Mom' }, { do: 'click_text', text: 'PIN' }] }, {}).then((x) => x, (e) => e.message));
  assert.ok(!/418-223|9921/.test(r4), r4);
  assert.match(r4, /point at "Mom", click "PIN"/, r4);
  assert.match(r4, /said no to reading the window/, r4);
  // The helper's error quotes the field: in a relay turn the quoted words are taken out.
  reset({ actFails: true });
  answer = 'Allow';
  const e4 = await T('act_in_app').execute({ target: 'Messages', steps: [{ do: 'fill', field: 'To', text: 'x' }] }, {}).then(() => null, (e) => e.message);
  assert.ok(e4 && !e4.includes('9921') && /didn't work in Messages/.test(e4), e4);
}

// ---- F2: ask_mac stopped while it sleeps between polls (the real delay rejects) or while its POST is out: the
// sub-turn may exist, so the next ask_mac in this turn sends nothing.
{
  let posts = 0;
  const json = (status, body) => ({ status, ok: status < 300, json: async () => body });
  const api = { req: async (p, o) => { if (o.method === 'POST') { posts++; return json(201, { subTurnId: `s${posts}` }); } return json(200, { status: 'running', text: '' }); } };
  const tool = askMacTool({ api, turn: { id: 't', claimId: 'c' }, pollMs: 200, sleep: delay });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 50);
  await assert.rejects(tool.execute({ instruction: 'open Notes' }, { signal: ac.signal }), /Stopped/);
  assert.match(await tool.execute({ instruction: 'open Notes' }, {}), /may already be doing this/);
  assert.equal(posts, 1);
}
{
  let posts = 0;
  const ac = new AbortController();
  // The POST is cut off in flight (the fetch rejects on the abort): it may have reached Hydra.
  const api = { req: async (p, o) => { if (o.method === 'POST') { posts++; ac.abort(); throw new Error('aborted'); } throw new Error('no GET expected'); } };
  const tool = askMacTool({ api, turn: { id: 't', claimId: 'c' } });
  await assert.rejects(tool.execute({ instruction: 'open Notes' }, { signal: ac.signal }), /Stopped/);
  assert.match(await tool.execute({ instruction: 'open Notes' }, {}), /may already be doing this/);
  assert.equal(posts, 1);
}

// ---- F3: an addition sent during the final answer's first token, not taken by that turn (Claude Code's uuids), and
// the run errors or hits max turns before its own turn: it is still named unanswered.
const ev = (event) => ({ type: 'stream_event', parent_tool_use_id: null, event });
const step = (text, stop) => [ev({ type: 'message_start', message: { usage: {} } }), ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }), ev({ type: 'message_delta', delta: { stop_reason: stop }, usage: {} }), ev({ type: 'message_stop' })];
for (const end of ['error', 'max_turns']) {
  let agent;
  const query = ({ prompt }) => {
    const it = prompt[Symbol.asyncIterator]();
    async function* g() {
      const first = (await it.next()).value;
      agent.addInput('and Friday?');
      yield* step('Thursday: dentist.', 'end_turn');
      yield { type: 'result', subtype: 'success', is_error: false, result: 'Thursday: dentist.', usage: {}, user_message_uuids: [first.uuid] };
      await it.next();
      if (end === 'error') throw new Error('API Error: 529 overloaded');
      yield { type: 'result', subtype: 'error_max_turns', is_error: true, usage: {} };
    }
    return Object.assign(g(), { interrupt: async () => {}, close: () => {} });
  };
  agent = new ClaudeCodeAgent({ model: 'm', system: 's', tools: [], executable: '/bin/claude', cwd: '/', env: {}, query, onRateLimit: () => {} });
  await (async () => { for await (const e of agentEvents(agent.prompt('what is on Thursday?'))) void e; })().catch(() => {});
  assert.deepEqual(agent.unanswered(), ['and Friday?'], end);
}
console.log('eleventhd: ok');
