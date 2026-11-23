// The relay end to end against a fake Hydra on this machine (no real network). The fake checks every body with the
// server's own zod schemas (relayschema.mjs is Hydra's src/lib/agent/relay-schema.ts, copied verbatim), so a shape
// the server would refuse fails here too. Covered (W3 contract and contract-fixes 1-7):
// - two slots: a routine waiting for the owner's answer never holds up a live turn;
// - claimId on every post, seq numbering (a retried post is stored once), a heartbeat while a turn is quiet;
// - snake_case usage, text split at 8000, a ui action the server would refuse dropped before it is sent;
// - a gated Hydra tool's confirm round-trip, and a Mac-side ask as a server approval (POST /relay/approval);
// - a 4xx on an event post stops the turn and posts mac_bad_event once; a 409 stops it with nothing more sent;
// - pairing, backoff, a revoked key, no key, the UI tool, and the key never logged. Run: npm test
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { BAD_EVENT, cleanEvent, connectorGroup, createRelay, snakeUsage, toolFilter } from '../relay.mjs';
import { createHydraTools, hydraApi, needsApproval, pairDevice, showTool, toUiAction, waitApproval } from '../hydramcp.mjs';
import { relayApprovalSchema, relayBatchSchema, slotSchema } from '../relayschema.mjs';

const KEY = 'hyd_dev_0123456789abcdef0123456789';
// A second device (the t4 relay below): only it is handed its turns, so a poll of the first relay still on its way when
// that one stopped can never claim them.
const KEY2 = 'hyd_dev_t4t4t4t4t4t4t4t4t4t4t4t4t4';
const queues2 = { live: [], routine: [] };
// Waits on events, never on the clock (relay.test.mjs was flaky under load): a promise and its resolve, failing
// loudly instead of hanging if the event never comes.
function event(what, ms = 60_000) {
  let done;
  const p = new Promise((res, rej) => { done = res; setTimeout(() => rej(new Error(`never happened: ${what}`)), ms).unref(); });
  return { p, done };
}
const ctx = { path: '/money', search: '', scope: 'all' };
const turn = (id, surface, extra = {}) => ({ id, claimId: randomUUID(), threadId: randomUUID(), input: { text: `turn ${id}` }, surface, context: ctx, ...extra });
const T = { live: randomUUID(), routine: randomUUID(), bad: randomUUID(), stale: randomUUID() };
const queues = {
  routine: [turn(T.routine, 'routine', { routineId: 'r1', allowedTools: ['hydra'] })],
  live: [turn(T.live, 'phone', { history: [{ role: 'user', text: 'show my last transaction' }, { role: 'assistant', text: 'Coffee, $4.' }] }), turn(T.bad, 'web'), turn(T.stale, 'web')],
};
// The server's side of each claimed turn: its claim, stored events, posts seen.
const turns = new Map();
for (const q of Object.values(queues)) for (const t of q) turns.set(t.id, { claimId: t.claimId, events: [], posts: [], closed: false, dropOnce: t.id === T.live });
const approvals = new Map(); // id -> { status, polls, answer(polls) }
const calls = []; // tools/call arguments the MCP server saw
const slotsSeen = new Set();
let exchanged = null;
const auth = (req) => req.headers.authorization === `Bearer ${KEY}` || req.headers.authorization === `Bearer ${KEY2}`;
const body = (req) => new Promise((res) => { let s = ''; req.on('data', (d) => { s += d; }); req.on('end', () => res(s ? JSON.parse(s) : null)); });
const json = (res, code, v) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
const newApproval = (answer) => { const id = randomUUID(); approvals.set(id, { status: 'pending', polls: 0, answer }); return id; };
let liveDone = 0;

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
    assert.equal(u.searchParams.get('wait'), '1');
    const slot = slotSchema.parse(u.searchParams.get('slot')); // the server's own check
    slotsSeen.add(slot);
    const t = (req.headers.authorization === `Bearer ${KEY2}` ? queues2 : queues)[slot].shift();
    if (t) return json(res, 200, { turn: t });
    return setTimeout(() => { res.writeHead(204); res.end(); }, 30);
  }
  if (u.pathname === '/api/agent/relay/events') {
    const raw = await body(req);
    const p = relayBatchSchema.safeParse(raw);
    const s = turns.get(raw?.turnId);
    s?.posts.push(raw);
    if (!p.success) return json(res, 400, { error: 'invalid_input', issues: p.error.issues.slice(0, 3) });
    const b = p.data;
    if (!s || s.closed || b.claimId !== s.claimId) return json(res, 409, { error: 'stale_claim' });
    // A confirm must name an approval this server made (as the real one checks).
    if (b.events.some((e) => e.type === 'confirm' && !approvals.has(e.id))) return json(res, 400, { error: 'unknown_approval' });
    if (b.seq !== undefined) {
      if (b.seq > s.events.length + 1) return json(res, 409, { error: 'seq_gap' });
      s.events.push(...b.events.slice(s.events.length - (b.seq - 1)));
    } else s.events.push(...b.events);
    if (b.events.at(-1)?.type === 'done' || b.events.at(-1)?.type === 'error') s.closed = true;
    // The re-queued turn: from now on its claim is someone else's.
    if (raw.turnId === T.stale && b.events.length) s.claimId = randomUUID();
    // A post whose answer is lost on the way back: stored, but the Mac sees a 502 and tries again.
    if (s.dropOnce && b.events.length && s.events.length > 3) { s.dropOnce = false; return json(res, 502, { error: 'bad_gateway' }); }
    return json(res, 200, { ok: true });
  }
  if (u.pathname === '/api/agent/relay/approval' && req.method === 'POST') {
    const p = relayApprovalSchema.safeParse(await body(req));
    if (!p.success) return json(res, 400, { error: 'invalid_input' });
    const s = turns.get(p.data.turnId);
    if (!s || s.claimId !== p.data.claimId) return json(res, 409, { error: 'stale_claim' });
    return json(res, 201, { id: newApproval((n) => (n >= 1 ? 'approved' : null)) });
  }
  if (u.pathname === '/api/agent/relay/approval') {
    const a = approvals.get(u.searchParams.get('id'));
    if (!a) return json(res, 404, { error: 'not_found' });
    a.polls++;
    a.status = a.answer(a.polls) ?? a.status; // the owner answers on another surface
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
        // The live turn's yes comes after 2 polls; the routine's no only a while after the live turn is done.
        const id = newApproval(rest.id === 'k1' ? (n) => (n >= 2 ? 'approved' : null) : () => (liveDone && Date.now() - liveDone > 150 ? 'declined' : null));
        const gate = { needsApproval: true, approvalId: id, summary: `Delete task ${rest.id}` };
        return json(res, 200, { jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(gate) }], structuredContent: gate } });
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
const fastWait = (id, signal) => waitApproval(api, id, { signal, every: 15 });

// The fake brain: what the desktop agent does with a turn, through the real Hydra tools.
const seen = [], signals = {};
let liveDoneWhileRoutineWaiting = null, macAnswer = null;
async function runTurn(t, { emit, signal, approve }) {
  seen.push(t.id); signals[t.id] = signal;
  const may = toolFilter(t.allowedTools);
  const tools = hydra.tools({ onConfirm: (c) => emit({ type: 'confirm', ...c }), waitFor: fastWait, confirm: async () => true }).filter((x) => may('hydra', x.name));
  assert.equal(tools[0].rawInputSchema.properties.approvalId, undefined, 'the model never sends the approval id itself');
  assert.deepEqual(tools[0].rawInputSchema.required, ['id']);
  const del = tools.find((x) => x.name === 'hydra_delete_task');
  if (t.id === T.bad) {
    emit({ type: 'text', delta: 'Sending. ' });
    emit({ type: 'confirm', id: randomUUID(), summary: 'An approval the server never made', danger: true });
    await new Promise((r) => setTimeout(r, 300));
    emit({ type: 'text', delta: 'never sent' });
    return;
  }
  if (t.id === T.stale) {
    emit({ type: 'text', delta: 'Working on it. ' });
    await new Promise((r) => { signal.addEventListener('abort', r, { once: true }); setTimeout(r, 2000); });
    emit({ type: 'text', delta: 'never sent' });
    return;
  }
  emit({ type: 'text', delta: 'On it. ' });
  emit({ type: 'tool', name: 'hydra_delete_task', status: 'start', summary: 'Deleting a task' });
  try {
    const out = await del.execute({ id: t.id === T.live ? 'k1' : 'k2', approvalId: 'forged' }, { signal });
    emit({ type: 'tool', name: 'hydra_delete_task', status: 'done', summary: out });
  } catch (e) {
    emit({ type: 'tool', name: 'hydra_delete_task', status: 'error', summary: e.message });
    emit({ type: 'text', delta: e.message });
  }
  if (t.id === T.live) {
    // A Mac-side ask (a connector send): a server approval, answered on another surface.
    macAnswer = await approve({ summary: 'gmail: send message {"to":"a@b.c"}', danger: true });
    emit({ type: 'ui', action: { kind: 'openPanel', param: 'tx', value: 'not an id' } }); // the server would refuse it
    emit({ type: 'ui', action: { kind: 'navigate', href: '/planning' } });
    emit({ type: 'text', delta: 'x'.repeat(17_000) });
    emit({ type: 'done', usage: { inputTokens: 1200, outputTokens: 80, cacheRead: 7 } });
    liveDone = Date.now();
    liveDoneWhileRoutineWaiting = !turns.get(T.routine).closed;
    return;
  }
  emit({ type: 'done' });
}

const logs = [];
// Done when the last turn's relay_done comes (after its last post) with every turn over.
const finished = () => turns.get(T.routine).closed && turns.get(T.bad).closed && seen.includes(T.stale) && !relay.turns.live && !relay.turns.routine;
const allDone = event('the four turns ending');
const relay = createRelay({ api, runTurn, waitSecs: 1, heartbeatMs: 40, flushMs: 5, backoff: [10, 20], retry: [10, 20, 40], waitFor: fastWait,
  log: (k, d) => { logs.push([k, d]); if (k === 'relay_done' && finished()) allDone.done(); } });
relay.start();
await allDone.p;
await relay.stop();
assert.equal(relay.running, false);

// Two slots: the routine and the live turns ran side by side.
assert.deepEqual(slotsSeen, new Set(['live', 'routine']));
assert.equal(liveDoneWhileRoutineWaiting, true, 'the live turn finished while the routine still waited for the owner');
assert.deepEqual([...seen].sort(), [T.live, T.routine, T.bad, T.stale].sort());

// Every post carried its claim; non-empty ones a seq.
for (const [id, s] of turns) for (const p of s.posts) {
  if (id !== T.stale) assert.ok(typeof p.claimId === 'string' && p.claimId.length === 36, 'every post names its claim');
  if (p.events.length) assert.ok(Number.isInteger(p.seq) && p.seq >= 1, 'a batch carries its seq');
}

// The live turn, as the server stored it.
const live = turns.get(T.live).events;
const types = live.map((e) => e.type);
assert.deepEqual(types.filter((x) => x !== 'text'), ['tool', 'confirm', 'tool', 'confirm', 'ui', 'done'], 'in order; the refused ui never sent');
assert.equal(live.filter((e) => e.type === 'confirm')[0].summary, 'Delete task k1');
assert.equal(live.filter((e) => e.type === 'confirm')[1].summary, 'gmail: send message {"to":"a@b.c"}');
assert.equal(macAnswer, 'approved', 'the Mac ask was answered as a server approval');
assert.deepEqual(live.find((e) => e.type === 'ui'), { type: 'ui', action: { kind: 'navigate', href: '/planning' } });
const text = live.filter((e) => e.type === 'text').map((e) => e.delta);
assert.ok(text.every((d) => d.length <= 8000), 'text split to the server\'s limit');
assert.equal(text.join(''), `On it. ${'x'.repeat(17_000)}`, 'every character once: a retried post is not stored twice');
assert.deepEqual(live.at(-1), { type: 'done', usage: { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 7 } }, 'usage in snake_case');
assert.ok(logs.some(([k, d]) => k === 'relay_drop' && d.kind === 'openPanel'), 'a dropped ui action is logged');
assert.ok(turns.get(T.routine).posts.some((p) => p.events.length === 0), 'a waiting turn keeps its lease with empty posts');
// The routine: its gated call waited and was declined; nothing retried after the no.
const routine = turns.get(T.routine).events;
assert.equal(routine.find((e) => e.type === 'tool' && e.status === 'error')?.summary, 'The owner said no, so it was not done.');
assert.equal(routine.at(-1).type, 'done');
const withId = calls.filter((c) => c.arguments.approvalId);
assert.deepEqual(calls.map((c) => c.arguments.id).sort(), ['k1', 'k1', 'k2'], 'k2 (declined) is never called again');
assert.equal(withId.length, 1); assert.equal(withId[0].arguments.id, 'k1');
assert.equal(approvals.get(withId[0].arguments.approvalId).status, 'approved', 'never the forged id; the retry only after yes');
assert.equal(turns.get(T.live).dropOnce, false, 'a post whose answer was lost was sent again');

// A 4xx: the turn stopped, the refused batch was not tried again, and mac_bad_event went once.
const bad = turns.get(T.bad);
assert.equal(signals[T.bad].aborted, true, 'the turn was stopped');
const badPosts = bad.posts.filter((p) => p.events.length);
assert.equal(badPosts.filter((p) => p.events.some((e) => e.type === 'confirm')).length, 1, 'never a retry after a 4xx');
assert.deepEqual(bad.events.at(-1), BAD_EVENT);
assert.ok(!bad.events.some((e) => e.type === 'text' && e.delta === 'never sent'));
// A 409: the turn stopped and nothing more was sent.
const stale = turns.get(T.stale);
assert.equal(signals[T.stale].aborted, true, 'a stale claim stops the turn');
assert.equal(stale.posts.length, 2, 'the post that got 409, and nothing after it');
assert.equal(stale.posts[1].events.length, 0, 'the 409 came on the heartbeat');
assert.ok(!stale.posts.some((p) => p.events.some((e) => e.type === 'error')), 'no error batch on a stale claim');

// A turn whose brain fails ends with an error event, and the loop carries on.
// Its own device's queue (KEY2), so only this relay can claim it; waited for by its own end (relay_done, after its last
// post), never a fixed time.
const t4 = turn(randomUUID(), 'web'); queues2.live.push(t4); turns.set(t4.id, { claimId: t4.claimId, events: [], posts: [] });
// The race that made this flaky: a poll of the first device reaching the server after its relay stopped took t4, and
// t4 never ran. Such a poll now finds nothing.
const stray = await api.req('/api/agent/relay/next?wait=1&slot=live', { timeout: 5000 });
assert.equal(stray.status, 204, "the first device's late poll can't claim the second device's turn");
const t4Ended = event('t4 ending');
const relay2 = createRelay({ api: hydraApi({ base, getKey: async () => KEY2 }), runTurn: async () => { throw Object.assign(new Error('Sign in with Claude on the Mac.'), { code: 'mac_signed_out' }); }, waitSecs: 1, flushMs: 5, retry: [10, 20, 40], slots: ['live'],
  log: (k, d) => { if (k === 'relay_done' && d.id === t4.id) t4Ended.done(); } });
relay2.start();
await t4Ended.p;
await relay2.stop();
assert.deepEqual(turns.get(t4.id).events, [{ type: 'error', message: 'Sign in with Claude on the Mac.', code: 'mac_signed_out' }]);

// Hydra unreachable: it backs off (the sleeps grow, to the last one) instead of spinning.
// The injected sleep: it notes each wait, says when n have been asked for, and yields without the clock.
const fakeSleep = (log, n, reached) => (ms, s) => {
  log.push(ms);
  if (log.length === n) reached();
  return new Promise((r, j) => { const t = setImmediate(r); s?.addEventListener('abort', () => { clearImmediate(t); j(new Error('aborted')); }, { once: true }); });
};
const waits = [], five = event('five backoff waits');
const relay3 = createRelay({ api: hydraApi({ base: 'http://127.0.0.1:1', getKey: async () => KEY }), runTurn: async () => {}, waitSecs: 1, backoff: [5, 10, 20], slots: ['live'], sleep: fakeSleep(waits, 5, five.done) });
relay3.start();
await five.p;
await relay3.stop();
assert.deepEqual(waits.slice(0, 5), [5, 10, 20, 20, 20]);
// Revoked (401): straight to the longest wait, and the sidecar is told (setup then says unpaired).
key = 'hyd_dev_revokedrevokedrevoked00';
const waits4 = [], auths = [], one = event('a wait after the 401');
const relay4 = createRelay({ api, runTurn: async () => {}, waitSecs: 1, backoff: [5, 10, 999], slots: ['live'], sleep: fakeSleep(waits4, 1, one.done), onAuth: (ok, status) => auths.push([ok, status]) });
relay4.start();
await one.p;
await relay4.stop();
assert.equal(waits4[0], 999);
assert.deepEqual(auths[0], [false, 401]);
// Unpaired (no key): the loop stops by itself.
key = null;
let unpaired = 0;
const bothStopped = event('both slots stopping unpaired');
const relay5 = createRelay({ api, runTurn: async () => {}, waitSecs: 1, log: (k, d) => { if (k === 'relay' && d.stopped === 'unpaired' && ++unpaired === 2) bothStopped.done(); } });
relay5.start();
await bothStopped.p;
await new Promise(setImmediate); // the loops' promises settle (microtasks) before this runs
assert.equal(relay5.running, false, 'no key: the relay stops');
key = KEY;

// waitApproval gives up as expired when the turn is stopped.
const ac = new AbortController(); ac.abort();
assert.equal(await waitApproval(api, randomUUID(), { signal: ac.signal }), 'expired');
assert.equal(needsApproval({ content: [{ type: 'text', text: 'plain' }] }), null);

// Event cleaning on its own: what the server takes, or nothing.
assert.deepEqual(snakeUsage({ inputTokens: 3, outputTokens: 2, cacheWrite: 4 }), { input_tokens: 3, output_tokens: 2, cache_creation_input_tokens: 4 });
assert.equal(snakeUsage(null), undefined);
assert.deepEqual(cleanEvent({ type: 'confirm', id: randomUUID(), summary: 's'.repeat(900), danger: 1 })[0].summary.length, 500);
assert.deepEqual(cleanEvent({ type: 'confirm', id: 'not-a-uuid', summary: 'x', danger: true }), []);
assert.deepEqual(cleanEvent({ type: 'ui', action: { kind: 'highlight', selector: 'x'.repeat(201) } }), []);
assert.deepEqual(cleanEvent({ type: 'ui', action: { kind: 'navigate', href: '/a\\b' } }), []);
assert.deepEqual(cleanEvent({ type: 'thread', threadId: 'x' }), [], 'the server owns threads');
assert.equal(cleanEvent({ type: 'error', message: 'e'.repeat(2000), code: 'c'.repeat(100) })[0].message.length, 1000);

// A routine's tool groups (the server's routine.tools): hydra, mac, gmail, calendar.
const may = toolFilter(['hydra', 'gmail']);
assert.ok(may('hydra', 'hydra_delete_task') && may(connectorGroup('claude_ai_Gmail'), 'mcp__claude_ai_Gmail__send_message'));
assert.ok(!may('mac', 'click') && !may(connectorGroup('claude_ai_Google_Calendar'), 'mcp__claude_ai_Google_Calendar__create_event'));
assert.ok(toolFilter(undefined)('mac', 'click'), 'a live turn has every tool');

// The UI tool: same-origin paths and the server's panels only.
const shown = [];
const ui = showTool({ onUi: (a) => shown.push(a) });
await ui.execute({ kind: 'navigate', href: '/money?tx=1' });
await assert.rejects(ui.execute({ kind: 'navigate', href: '//evil.com' }));
await assert.rejects(ui.execute({ kind: 'navigate', href: 'https://evil.com' }));
await assert.rejects(ui.execute({ kind: 'openPanel', param: 'tx', value: 'a b' }));
assert.deepEqual(shown, [{ kind: 'navigate', href: '/money?tx=1' }]);
assert.deepEqual(toUiAction({ kind: 'setScope', scope: 'ugc' }), { kind: 'setScope', scope: 'ugc' });
// W6: the scope is all or any entity slug (businesses the owner adds); anything else is refused.
assert.deepEqual(toUiAction({ kind: 'setScope', scope: 'work' }), { kind: 'setScope', scope: 'work' });
for (const bad of ['Work Co', '-x', 'a'.repeat(41), '', 'ugc/../x']) assert.equal(toUiAction({ kind: 'setScope', scope: bad }), null, bad);
assert.equal(toUiAction({ kind: 'openPanel', param: 'wallet', value: 'a' }), null);

// The key is never logged.
assert.ok(!JSON.stringify(logs).includes(KEY), 'the device key never reaches the log');
server.close();
console.log('relay: ok');
