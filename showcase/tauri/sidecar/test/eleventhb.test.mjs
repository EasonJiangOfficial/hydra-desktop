// Round 11 review, second pass (R11b-A to R11b-H): the probes of scratchpad v11b, as behavior tests with fakes. Each
// block fails without its fix. Run: npm test (temp home, fake helper, fake clock, fake Claude Code).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkWindow } from '../safety.mjs';
import { MAC_UNSURE_TEXT, askMacTool } from '../brain-server.mjs';
import { ClaudeCodeAgent } from '../claudecode.mjs';
import { agentEvents } from '../agentstream.mjs';

const HOME = fs.realpathSync.native(os.homedir());
assert.ok(HOME.includes('roamies-test-') || HOME.startsWith(fs.realpathSync.native(os.tmpdir())), 'runs only with a temp home');
const doc = path.join(HOME, 'Documents', 'proj');
fs.mkdirSync(doc, { recursive: true });
const SECRET = 'export OPENAI_API_KEY=sk-live-abc123secret';

// ask_mac's fake clock. It honors each call's timeout as the real one does (AbortSignal.timeout): a call slower than it fails then.
const clocked = (cost) => {
  let clock = 0;
  const seen = [];
  const api = { req: async (url, o) => {
    const c = cost(o?.method === 'POST' ? 'post' : 'get');
    seen.push(o.timeout);
    if (c.ms > o.timeout) { clock += o.timeout; throw new Error('timeout'); }
    clock += c.ms;
    if (c.throws) throw new Error('timeout');
    return c.res;
  } };
  return { api, now: () => clock, set: (t) => { clock = t; }, sleep: async (ms) => { clock += ms; }, seen };
};
const ok = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
// A fake Claude Code (the SDK query seam), as relayup.test.mjs.
const sdk = (script) => ({ query: ({ prompt }) => {
  const it = prompt[Symbol.asyncIterator]();
  return Object.assign(script({ next: () => it.next() }), { interrupt: async () => {}, close: () => {} });
} });
const ev = (event) => ({ type: 'stream_event', parent_tool_use_id: null, event });
const step = (text, stop) => [ev({ type: 'message_start', message: { usage: {} } }), ev({ type: 'content_block_delta', delta: { type: 'text_delta', text } }), ev({ type: 'message_delta', delta: { stop_reason: stop }, usage: {} }), ev({ type: 'message_stop' })];
const agentWith = (query, o = {}) => new ClaudeCodeAgent({ model: 'm', system: 's', tools: [], executable: '/bin/claude', cwd: '/', env: {}, query, onRateLimit: () => {}, ...o });
const drain = async (agent) => { try { for await (const e of agentEvents(agent.prompt('what is on Thursday?'))) void e; return null; } catch (e) { return e; } };

// ---- R11b-B (rule): in a relay turn a file frees a window only in an app that just shows or edits it.
{
  const w = (app, extra = {}) => ({ id: 3, app, title: 'zsh', ...extra });
  assert.equal(checkWindow(w('Terminal', { document: doc }), HOME, { viewers: false }).level, 'ask', 'Terminal with a Documents folder asks');
  assert.ok(checkWindow(w('Terminal', { document: doc }), HOME, { viewers: false }).reason.includes('the Terminal window "zsh"'));
  assert.equal(checkWindow(w('Finder', { document: doc }), HOME, { viewers: false }).level, 'ask', 'Finder too');
  assert.equal(checkWindow(w('Safari', { url: `file://${doc}/a.html` }), HOME, { viewers: false }).level, 'ask', 'a browser too');
  assert.equal(checkWindow(w('TextEdit', { document: doc }), HOME, { viewers: false }).level, 'safe', 'a viewer showing it is free');
  assert.equal(checkWindow(w('Visual Studio Code', { document: doc }), HOME, { viewers: false }).level, 'safe', 'an editor too');
  assert.equal(checkWindow(w('Terminal', { document: doc }), HOME).level, 'safe', 'on this Mac: unchanged');
}

// ---- The tools against a fake helper (macOS and Windows have one).
if (['darwin', 'win32'].includes(process.platform)) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-11b-'));
  const log = path.join(dir, 'calls.jsonl'), fake = path.join(dir, 'hands.mjs'), next = path.join(dir, 'next.json');
  fs.writeFileSync(fake, `import fs from 'node:fs'; const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + '\\n');
const n = JSON.parse(fs.readFileSync(${JSON.stringify(next)}, 'utf8'));
const win = n.window ?? { id: 3, app: 'Terminal', title: 'zsh', bounds: [0, 0, 800, 600] };
let o = { ok: true, window: win, controls: [], texts: [], note: '' };
if (a[0] === 'find-text') o = { ok: true, matches: n.find ?? [] };
if (a[0] === 'ocr-find') o = { ok: true, matches: n.ocr ?? [] };
if (a[0] === 'windows') o = { ok: true, windows: n.windows ?? [] };
if (a[0] === 'capture') { fs.writeFileSync(a[1], 'x'); o = a[2] === 'screen' ? { ok: true, file: a[1], what: 'screen', bounds: [0, 0, 1440, 900], shown: n.shown ?? [], pixels: [1440, 900] } : { ok: true, file: a[1], window: win, pixels: [800, 600] }; }
console.log(JSON.stringify(o));
`);
  process.env.ROAMIES_HANDS = fake;
  const { createTools } = await import('../tools.mjs');
  const asks = [];
  let answer = null, remote = true;
  const { tools, nextTurn } = createTools({ remote: () => remote, allowActions: () => true, ui: () => {}, ask: async (o) => { asks.push(o.placeholder); return answer; }, openUrl: async () => {}, onCommitments: () => {}, showList: () => {}, fmtWhen: String, commitmentsText: () => '', userName: 'Test', workdir: HOME, skills: { changed: () => {} } });
  const T = (n) => tools.find((t) => t.name === n);
  const calls = () => fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const reads = () => calls().filter((c) => ['find-text', 'ocr-find', 'ui'].includes(c[0]));
  const reset = (n = {}) => { fs.writeFileSync(log, ''); asks.length = 0; answer = null; fs.writeFileSync(next, JSON.stringify(n)); nextTurn(); };
  const ring = (target, text) => T('draw').execute({ target, beats: [{ say: 'Here.', marks: [{ kind: 'ring', at: { text } }] }] }, { toolCallId: `d${Math.random()}` });

  // ---- R11b-A: draw in a relay turn checks the windows it searches before it reads a word off them.
  reset({ find: [{ text: SECRET, bounds: [10, 10, 100, 20] }] });
  await assert.rejects(ring('Terminal', 'OPENAI'), /said no/);
  assert.equal(asks.length, 1);
  assert.ok(asks[0].includes('the Terminal window "zsh"'), asks[0]);
  assert.deepEqual(reads(), [], 'no find-text, ocr-find or ui before the yes');
  // The front app's windows the helper lists are asked about too.
  reset({ windows: [{ id: 4, app: 'Terminal', title: 'ssh prod', bounds: [0, 0, 800, 600] }] });
  await assert.rejects(ring('front', 'OPENAI'), /said no/);
  assert.ok(asks[0].includes('"zsh"') && asks[0].includes('"ssh prod"'), asks[0]);
  // The whole screen always asks, naming it, even with no window listed.
  reset();
  await assert.rejects(ring('screen', 'OPENAI'), /said no/);
  assert.ok(asks[0].includes('whole screen'), asks[0]);
  assert.deepEqual(reads(), []);
  // With a yes: what it matched is never quoted to the model (nor to Hydra's tool summary, which is the error).
  reset({ find: [{ text: SECRET, bounds: [10, 10, 100, 20] }] });
  answer = 'Allow';
  const e1 = await ring('Terminal', 'OPENAI').then(() => null, (e) => e);
  assert.ok(e1 && /only appears inside longer text/.test(e1.message), e1?.message);
  assert.ok(!e1.message.includes('sk-live'), e1.message);
  assert.equal(asks.length, 1, 'asked once for the whole drawing');
  reset({ ocr: [{ text: SECRET, bounds: [1, 1, 5, 5] }, { text: 'password: hunter2', bounds: [1, 9, 5, 5] }] });
  answer = 'Allow';
  const e2 = await ring('Terminal', 'a').then(() => null, (e) => e);
  assert.ok(e2 && /"a" appears 2 times on screen\./.test(e2.message), e2?.message);
  assert.ok(!e2.message.includes('sk-live') && !e2.message.includes('hunter2'), e2.message);
  // On this Mac it doesn't ask (the owner is at it), and still never quotes.
  remote = false;
  reset({ find: [{ text: SECRET, bounds: [10, 10, 100, 20] }] });
  const e3 = await ring('Terminal', 'OPENAI').then(() => null, (e) => e);
  assert.equal(asks.length, 0);
  assert.ok(e3 && !e3.message.includes('sk-live'), e3?.message);
  remote = true;

  // ---- R11b-B: a relay turn's whole-screen picture always asks, naming the whole screen.
  for (const shown of [[], [{ id: 3, app: 'Terminal', title: 'zsh', document: doc }], [{ id: 5, app: 'TextEdit', title: 'n.txt', document: doc }]]) {
    reset({ shown });
    await assert.rejects(T('take_screenshot').execute({ target: 'screen' }, {}), /said no/, JSON.stringify(shown));
    assert.equal(asks.length, 1);
    assert.ok(asks[0].includes('whole screen'), asks[0]);
    for (const c of calls().filter((x) => x[0] === 'capture')) assert.ok(!fs.existsSync(c[1]), 'the picture is deleted');
  }
  // A Terminal window with a Documents folder is no plain read either.
  reset({ window: { id: 3, app: 'Terminal', title: 'zsh', bounds: [0, 0, 800, 600], document: doc } });
  await assert.rejects(T('take_screenshot').execute({ target: 'Terminal' }, {}), /said no/);
  // On this Mac the whole screen is checked window by window, as before.
  remote = false;
  reset({ shown: [{ id: 5, app: 'TextEdit', title: 'n.txt', document: doc }] });
  await T('take_screenshot').execute({ target: 'screen' }, {});
  assert.equal(asks.length, 0);
  remote = true;
}

// ---- R11b-C: ask_mac returns by its end (the deadline less the margin), even when each call is slow.
{
  // The probe: the POST takes 15 s, each GET 19 s and says "running".
  const c = clocked((k) => (k === 'post' ? { ms: 15_000, res: ok(201, { subTurnId: 's1' }) } : { ms: 19_000, res: ok(200, { status: 'claimed', text: '' }) }));
  const t = askMacTool({ api: c.api, turn: { id: 't', claimId: 'c' }, now: c.now, sleep: c.sleep, deadline: 280_000, pollMs: 1000 });
  const out = await t.execute({ instruction: 'look' });
  assert.ok(c.now() <= 250_000, `returned at ${c.now()}, after 250000`);
  assert.match(out, /may still be doing this/);
}
{
  // 80 s left (end at 250 s): the POST takes 19 s, then every GET hangs.
  const c = clocked((k) => (k === 'post' ? { ms: 19_000, res: ok(201, { subTurnId: 's1' }) } : { ms: 60_000 }));
  c.set(200_000);
  const t = askMacTool({ api: c.api, turn: { id: 't', claimId: 'c' }, now: c.now, sleep: c.sleep, deadline: 280_000, beatMs: 1e9 });
  await t.execute({ instruction: 'x' });
  assert.ok(c.now() <= 250_000, `returned at ${c.now()}, after 250000`);
  assert.ok(c.seen.every((ms) => ms <= 20_000));
}

// ---- R11b-D: a 2xx without a readable subTurnId may have made the sub-turn: unsure, never sent twice.
for (const made of [{ status: 201, json: async () => { throw new Error('body read aborted'); } }, { status: 200, json: async () => ({}) }]) {
  let posts = 0;
  const api = { req: async (url, o) => { if (o?.method === 'POST') { posts++; return { ...made, ok: true }; } return ok(200, { status: 'done', text: 'ok' }); } };
  const t = askMacTool({ api, turn: { id: 't', claimId: 'c' }, sleep: async () => {} });
  assert.equal(await t.execute({ instruction: 'open Safari' }), MAC_UNSURE_TEXT);
  assert.equal(await t.execute({ instruction: 'open Safari' }), MAC_UNSURE_TEXT);
  assert.equal(posts, 1);
}

// ---- R11b-E: "took too long" says the Mac may still be doing it, and no second sub-turn is made.
{
  let posts = 0;
  const c = clocked((k) => (k === 'post' ? (posts++, { ms: 10, res: ok(201, { subTurnId: 's1' }) }) : { ms: 10, res: ok(200, { status: 'claimed', text: 'Opening' }) }));
  const t = askMacTool({ api: c.api, turn: { id: 't', claimId: 'c' }, now: c.now, sleep: c.sleep, waitMs: 5000, pollMs: 1000 });
  const out = await t.execute({ instruction: 'open Safari' });
  assert.match(out, /may still be doing this/);
  assert.match(out, /What it said so far: Opening/);
  assert.equal(await t.execute({ instruction: 'open Safari' }), MAC_UNSURE_TEXT);
  assert.equal(posts, 1);
}

// ---- R11b-F: nothing sent (no key here) is not unsure: it says so, and the next ask_mac is sent.
{
  let key = null, posts = 0;
  const api = { req: async (url, o) => {
    if (!key) throw Object.assign(new Error('This Mac is not paired with Hydra.'), { code: 'unpaired' });
    if (o?.method === 'POST') { posts++; return ok(201, { subTurnId: 's1' }); }
    return ok(200, { status: 'done', text: 'Safari is open.' });
  } };
  const t = askMacTool({ api, turn: { id: 't', claimId: 'c' }, sleep: async () => {} });
  const out = await t.execute({ instruction: 'is Safari open?' });
  assert.match(out, /not paired/);
  assert.notEqual(out, MAC_UNSURE_TEXT);
  key = 'k';
  assert.equal(await t.execute({ instruction: 'is Safari open?' }), 'Safari is open.');
  assert.equal(posts, 1);
}

// ---- R11b-G and R11b-H: additions a run took but ended before answering are named.
for (const [end, then, left] of [
  [{ type: 'result', subtype: 'error_max_turns' }, 'tool_use', ['and Friday?']],
  [{ type: 'result', subtype: 'error_during_execution', errors: ['boom'] }, 'tool_use', ['and Friday?']],
  [{ type: 'result', subtype: 'error_max_turns' }, 'end_turn', []], // a final answer after it took it: answered
]) {
  let agent;
  const { query } = sdk(async function* (ctx) {
    await ctx.next();
    yield* step('Checking Thursday.', 'tool_use');
    assert.equal(agent.addInput('and Friday?'), true);
    await ctx.next(); // taken (so Hydra counts it seen)
    yield* step('Still on Thursday.', then); // a tool step of the first task starts after it: not its answer
    yield end;
  });
  agent = agentWith(query);
  await drain(agent);
  assert.deepEqual(agent.unanswered(), left, `${end.subtype} after a ${then} step`);
}
{
  // H: the run throws before Claude Code takes what was added; and after it, nothing is acknowledged.
  const agent = agentWith(() => { throw new Error('not reached'); }, { transformContext: async () => { throw new Error('context failed'); } });
  const stream = agent.prompt('what is on Thursday?');
  assert.equal(agent.addInput('and Friday?'), true);
  await assert.rejects((async () => { for await (const e of agentEvents(stream)) void e; })(), /context failed/);
  assert.deepEqual(agent.unanswered(), ['and Friday?']);
  assert.equal(agent.addInput('and Saturday?'), false, 'nothing runs: not taken');
}
console.log('eleventhb: ok');
