// The relay end to end against a fake Hydra on this machine (no real network): the Mac claims a turn, streams its
// events, a gated Hydra tool goes through the confirm round-trip (confirm event, the owner's yes polled, the same call
// again with the approval id), and a routine turn's gated call waits as an approval (never an auto-yes; a no means it
// is not done). Also: pairing, backoff when Hydra is unreachable, and the UI action tool. Run: npm test
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRelay } from '../relay.mjs';
import { createHydraTools, hydraApi, needsApproval, pairDevice, showTool, toUiAction, waitApproval } from '../hydramcp.mjs';

const KEY = 'hyd_dev_0123456789abcdef0123456789';
const turns = [
  { id: 't1', threadId: 'th1', input: { text: 'Delete the coffee transaction' }, surface: 'phone', context: { path: '/money', search: '', scope: 'all' } },
  { id: 't2', threadId: 'th2', input: { text: 'Morning routine' }, surface: 'routine', context: { path: '/', search: '', scope: 'all' }, routineId: 'r1', allowedTools: ['hydra_delete_task'] },
];
const events = new Map(); // turnId -> events, in order
const calls = []; // tools/call arguments the MCP server saw
const approvals = new Map([['ap-1', { status: 'pending', polls: 0, answer: 'approved', after: 2 }], ['ap-2', { status: 'pending', polls: 0, answer: 'declined', after: 3 }]]);
let nextApproval = 0, polls = 0, beats = 0, exchanged = null;
const auth = (req) => req.headers.authorization === `Bearer ${KEY}`;
const body = (req) => new Promise((res) => { let s = ''; req.on('data', (d) => { s += d; }); req.on('end', () => res(s ? JSON.parse(s) : null)); });
const json = (res, code, v) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/agent/devices/exchange') {
    const b = await body(req);
    if (b.code !== 'AB12-CD34') return json(res, 400, { error: 'invalid_code' });
    exchanged = b;
    return json(res, 201, { deviceId: 'dev-1', key: KEY });
  }
  if (!auth(req)) return json(res, 401, { error: 'unauthorized' });
  if (u.pathname === '/api/agent/relay/next') {
    polls++;
    assert.equal(u.searchParams.get('wait'), '1');
    const t = turns.shift();
    if (t) return json(res, 200, { turn: t });
    return setTimeout(() => { res.writeHead(204); res.end(); }, 30);
  }
  if (u.pathname === '/api/agent/relay/events') {
    const b = await body(req);
    if (!b.events.length) beats++;
    events.set(b.turnId, [...(events.get(b.turnId) ?? []), ...b.events]);
    return json(res, 200, { ok: true });
  }
  if (u.pathname === '/api/agent/relay/approval') {
    const a = approvals.get(u.searchParams.get('id'));
    if (!a) return json(res, 404, { error: 'not_found' });
    if (++a.polls >= a.after) a.status = a.answer; // the owner answers on another surface after a few polls
    return json(res, 200, { status: a.status });
  }
  if (u.pathname === '/api/mcp/agent') {
    assert.match(req.headers.accept, /application\/json/);
    const m = await body(req);
    if (m.method === 'tools/list') {
      return json(res, 200, { jsonrpc: '2.0', id: m.id, result: { tools: [
        { name: 'delete_task', description: 'Delete a task.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, approvalId: { type: 'string' } }, required: ['id'] } },
        { name: 'list_tasks', description: 'List tasks.', inputSchema: { type: 'object', properties: {} } },
      ] } });
    }
    if (m.method === 'tools/call') {
      calls.push(m.params);
      const { approvalId, ...rest } = m.params.arguments;
      if (m.params.name === 'list_tasks') return json(res, 200, { jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: '[{"id":"k1"}]' }] } });
      if (!approvalId) {
        const id = `ap-${++nextApproval}`;
        return json(res, 200, { jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify({ needsApproval: true, approvalId: id, summary: `Delete task ${rest.id}` }) }], structuredContent: { needsApproval: true, approvalId: id, summary: `Delete task ${rest.id}` } } });
      }
      assert.equal(approvals.get(approvalId)?.status, 'approved', 'the call with an approval id only after the owner said yes');
      return json(res, 200, { jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `Deleted ${rest.id}.` }] } });
    }
  }
  json(res, 404, { error: 'no' });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// Pairing: the code for the key; a wrong code is an error with no key.
assert.deepEqual(await pairDevice({ base, code: 'WRONG-123' }), { ok: false, error: 'invalid_code' });
const paired = await pairDevice({ base, code: 'AB12-CD34' });
assert.equal(paired.ok, true); assert.equal(paired.key, KEY);
assert.deepEqual(exchanged, { code: 'AB12-CD34', name: 'Hydra Desktop' });

let key = KEY;
const api = hydraApi({ base, getKey: async () => key });
const hydra = createHydraTools({ api });
assert.equal(await hydra.refresh(), 2);

// The fake brain: what the desktop agent does with a turn, through the real Hydra tools.
const seen = [];
async function runTurn(turn, { emit, signal }) {
  seen.push(turn.id);
  const tools = hydra.tools({ onConfirm: (c) => emit({ type: 'confirm', ...c }) });
  const allowed = turn.allowedTools ? new Set(turn.allowedTools) : null;
  const usable = allowed ? tools.filter((t) => allowed.has(t.name)) : tools;
  if (turn.surface === 'routine') assert.deepEqual(usable.map((t) => t.name), ['hydra_delete_task'], 'a routine gets only its tools');
  else assert.deepEqual(tools.map((t) => t.name), ['hydra_delete_task', 'hydra_list_tasks']);
  assert.equal(tools[0].rawInputSchema.properties.approvalId, undefined, 'the model never sends the approval id itself');
  assert.deepEqual(tools[0].rawInputSchema.required, ['id']);
  emit({ type: 'text', delta: 'On it. ' });
  emit({ type: 'tool', name: 'hydra_delete_task', status: 'start', summary: 'Deleting a task' });
  const del = usable.find((t) => t.name === 'hydra_delete_task');
  try {
    const out = await del.execute({ id: 'k1', approvalId: 'forged' }, { signal });
    emit({ type: 'tool', name: 'hydra_delete_task', status: 'done', summary: out });
    emit({ type: 'text', delta: 'Done.' });
  } catch (e) {
    emit({ type: 'tool', name: 'hydra_delete_task', status: 'error', summary: e.message });
    emit({ type: 'text', delta: e.message });
  }
  emit({ type: 'ui', action: { kind: 'navigate', href: '/planning' } });
  emit({ type: 'done', usage: { inputTokens: 1 } });
}

const logs = [];
const relay = createRelay({ api, runTurn, waitSecs: 1, heartbeatMs: 50, flushMs: 5, backoff: [10, 20], log: (k, d) => logs.push([k, d]) });
relay.start();
const until = Date.now() + 15_000;
while ((!events.get('t2')?.some((e) => e.type === 'done')) && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
await relay.stop();
assert.equal(relay.running, false);

assert.deepEqual(seen, ['t1', 't2'], 'both turns claimed, in order');
const t1 = events.get('t1');
assert.deepEqual(t1.map((e) => e.type), ['text', 'tool', 'confirm', 'tool', 'text', 'ui', 'done'], 'turn 1 streams in order');
assert.deepEqual(t1[2], { type: 'confirm', id: 'ap-1', summary: 'Delete task k1', danger: true }, 'confirm carries the gate\'s approval id');
assert.equal(t1[3].status, 'done'); assert.equal(t1[3].summary, 'Deleted k1.');
assert.deepEqual(t1[5], { type: 'ui', action: { kind: 'navigate', href: '/planning' } });
const t2 = events.get('t2');
assert.deepEqual(t2.map((e) => e.type), ['text', 'tool', 'confirm', 'tool', 'text', 'ui', 'done']);
assert.equal(t2[2].id, 'ap-2');
assert.equal(t2[3].status, 'error'); assert.match(t2[3].summary, /said no/);
// The MCP calls: never the forged id; the retry only after "approved"; nothing after "declined".
assert.deepEqual(calls.map((c) => c.arguments.approvalId ?? null), [null, 'ap-1', null]);
assert.ok(approvals.get('ap-1').polls >= 2 && approvals.get('ap-2').polls >= 3, 'the routine waited for the owner\'s answer');
assert.ok(beats >= 1, 'a quiet turn keeps its lease with empty posts');
assert.ok(polls >= 3, 'it kept polling between turns');

// A turn whose brain fails ends with an error event, and the loop carries on.
turns.push({ id: 't3', threadId: 'th3', input: { audioTranscript: 'hello' }, surface: 'web', context: { path: '/', search: '', scope: 'all' } });
const relay2 = createRelay({ api, runTurn: async () => { throw Object.assign(new Error('Sign in with Claude on the Mac.'), { code: 'mac_signed_out' }); }, waitSecs: 1, flushMs: 5 });
relay2.start();
const until2 = Date.now() + 5000;
while (!events.get('t3') && Date.now() < until2) await new Promise((r) => setTimeout(r, 20));
await relay2.stop();
assert.deepEqual(events.get('t3'), [{ type: 'error', message: 'Sign in with Claude on the Mac.', code: 'mac_signed_out' }]);

// Hydra unreachable: it backs off (the sleeps grow, to the last one) instead of spinning.
const waits = [];
const down = hydraApi({ base: 'http://127.0.0.1:1', getKey: async () => KEY });
const relay3 = createRelay({ api: down, runTurn: async () => {}, waitSecs: 1, backoff: [5, 10, 20], sleep: (ms, s) => { waits.push(ms); return new Promise((r, j) => { const t = setTimeout(r, 1); s?.addEventListener('abort', () => { clearTimeout(t); j(new Error('aborted')); }, { once: true }); }); } });
relay3.start();
while (waits.length < 5) await new Promise((r) => setTimeout(r, 5));
await relay3.stop();
assert.deepEqual(waits.slice(0, 5), [5, 10, 20, 20, 20]);
// Revoked (401): straight to the longest wait.
key = 'hyd_dev_revokedrevokedrevoked00';
const waits4 = [];
const relay4 = createRelay({ api, runTurn: async () => {}, waitSecs: 1, backoff: [5, 10, 999], sleep: (ms, s) => { waits4.push(ms); return new Promise((r, j) => { const t = setTimeout(r, 1); s?.addEventListener('abort', () => { clearTimeout(t); j(new Error('aborted')); }, { once: true }); }); } });
relay4.start();
while (waits4.length < 1) await new Promise((r) => setTimeout(r, 5));
await relay4.stop();
assert.equal(waits4[0], 999);
// Unpaired (no key): the loop stops by itself.
key = null;
const relay5 = createRelay({ api, runTurn: async () => {}, waitSecs: 1 });
relay5.start();
const until5 = Date.now() + 2000;
while (relay5.running && Date.now() < until5) await new Promise((r) => setTimeout(r, 5));
assert.equal(relay5.running, false, 'no key: the relay stops');
key = KEY;

// waitApproval gives up as expired when the turn is stopped.
const ac = new AbortController(); ac.abort();
assert.equal(await waitApproval(api, 'ap-9', { signal: ac.signal }), 'expired');
assert.equal(needsApproval({ content: [{ type: 'text', text: 'plain' }] }), null);

// The UI tool: same-origin paths only.
const shown = [];
const ui = showTool({ onUi: (a) => shown.push(a) });
await ui.execute({ kind: 'navigate', href: '/money?tx=1' });
await assert.rejects(ui.execute({ kind: 'navigate', href: '//evil.com' }));
await assert.rejects(ui.execute({ kind: 'navigate', href: 'https://evil.com' }));
assert.deepEqual(shown, [{ kind: 'navigate', href: '/money?tx=1' }]);
assert.deepEqual(toUiAction({ kind: 'setScope', scope: 'ugc' }), { kind: 'setScope', scope: 'ugc' });
assert.equal(toUiAction({ kind: 'setScope', scope: 'work' }), null);

// The key is never logged.
assert.ok(!JSON.stringify(logs).includes(KEY), 'the device key never reaches the log');
server.close();
console.log('relay: ok');
