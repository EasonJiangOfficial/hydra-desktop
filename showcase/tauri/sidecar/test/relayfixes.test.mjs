// The relay after the cross-unit review (W3 round 2), against a fake Hydra that checks bodies with the server's own
// zod schemas (relayschema.mjs, copied verbatim from Hydra's src/lib/agent/relay-schema.ts):
// - 403 on /relay/next (a key without the relay scope): the pairing is stale, so setup() reports unpaired;
// - a turn this Mac stopped (unreachable) and that is claimed again is not run twice: one error mac_failed;
// - 429 waits its Retry-After and is never fatal (events, /relay/next, approvals);
// - near the 280 s live cap the heartbeat runs every 5 s, and a side-effecting tool checks the turn is live first;
// - the owner's own turns on the Mac go to /relay/local (localTurnSchema), keeping the thread for 30 quiet minutes;
// - a connector ask in words, never raw JSON; relayschema.mjs is the web's file byte for byte. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MAC_FAILED, askSummary, cleanEvent, authStale, createLocalSync, createRelay, retryAfterMs } from '../relay.mjs';
import { createHydraTools, hydraApi } from '../hydramcp.mjs';
import { localTurnSchema, relayApprovalSchema, relayBatchSchema, slotSchema } from '../relayschema.mjs';

const KEY = 'hyd_dev_0123456789abcdef0123456789';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const body = (req) => new Promise((res) => { let s = ''; req.on('data', (d) => { s += d; }); req.on('end', () => res(s ? JSON.parse(s) : null)); });
const json = (res, code, v, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(v)); };
let handle = null;
const server = http.createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${KEY}`) return json(res, 401, { error: 'unauthorized' });
  const u = new URL(req.url, 'http://x');
  const raw = req.method === 'POST' ? await body(req) : null;
  return handle(u, raw, res, req);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const api = hydraApi({ base: `http://127.0.0.1:${server.address().port}`, getKey: async () => KEY });
const until = async (ok, ms = 5000) => { const end = Date.now() + ms; while (!ok() && Date.now() < end) await wait(5); assert.ok(ok(), 'timed out'); };
const fastSleep = (log) => (ms, s) => { log?.push(ms); return new Promise((r, j) => { const t = setTimeout(r, 1); s?.addEventListener('abort', () => { clearTimeout(t); j(new Error('aborted')); }, { once: true }); }); };

// ---- MAJOR 1: 403 on /relay/next is a stale pairing.
{
  assert.equal(authStale(401), true); assert.equal(authStale(403), true); assert.equal(authStale(429), false); assert.equal(authStale(500), false);
  handle = (u, raw, res) => (u.pathname === '/api/agent/relay/next' ? json(res, 403, { error: 'forbidden', scope: 'relay' }) : json(res, 404, {}));
  const waits = [], auths = [];
  const relay = createRelay({ api, runTurn: async () => {}, waitSecs: 1, backoff: [5, 10, 999], slots: ['live'], sleep: fastSleep(waits), onAuth: (ok, status) => auths.push([ok, status]) });
  relay.start();
  await until(() => waits.length >= 2);
  await relay.stop();
  assert.deepEqual(auths[0], [false, 403], 'the sidecar is told: setup() then reports paired:false');
  assert.deepEqual(waits.slice(0, 2), [999, 999], 'straight to the longest wait, every time');
}

// ---- MINOR 5: 429 on /relay/next waits its Retry-After.
{
  let n = 0;
  handle = (u, raw, res) => { n++; return json(res, 429, { error: 'rate_limited' }, { 'retry-after': '7' }); };
  const waits = [];
  const relay = createRelay({ api, runTurn: async () => {}, waitSecs: 1, backoff: [5, 10, 999], slots: ['live'], sleep: fastSleep(waits) });
  relay.start();
  await until(() => waits.length >= 3);
  await relay.stop();
  assert.deepEqual(waits.slice(0, 3), [7000, 7000, 7000], 'Retry-After, not the backoff');
  assert.equal(retryAfterMs({ headers: new Headers({ 'retry-after': '999' }) }, 5), 60_000, 'at most a minute');
  assert.equal(retryAfterMs({ headers: new Headers({}) }, 5), 5);
  assert.ok(retryAfterMs({ headers: new Headers({ 'retry-after': new Date(Date.now() + 3000).toUTCString() }) }, 5) > 1000, 'an HTTP date');
}

// A fake relay server for turns: queue per slot; each turn's claim, stored events and posts; a per-turn post rule.
function relayServer(queue) {
  const turns = new Map();
  for (const t of queue) turns.set(t.id, { claimId: t.claimId, events: [], posts: [], rule: t.rule });
  const approvals = [];
  handle = async (u, raw, res) => {
    if (u.pathname === '/api/agent/relay/next') {
      slotSchema.parse(u.searchParams.get('slot'));
      const t = queue.shift();
      if (!t) return setTimeout(() => { res.writeHead(204); res.end(); }, 20);
      const { rule, ...turn } = t;
      turns.get(t.id).claimId = turn.claimId;
      return json(res, 200, { turn });
    }
    if (u.pathname === '/api/agent/relay/events') {
      const s = turns.get(raw?.turnId);
      s?.posts.push(raw);
      const p = relayBatchSchema.safeParse(raw);
      if (!p.success) return json(res, 400, { error: 'invalid_input' });
      if (!s || s.closed || p.data.claimId !== s.claimId) return json(res, 409, { error: 'stale_claim' });
      const r = s.rule?.(p.data, s);
      if (r) return json(res, r.status, { error: 'x' }, r.headers);
      s.events.push(...p.data.events);
      if (['done', 'error'].includes(p.data.events.at(-1)?.type)) s.closed = true;
      return json(res, 200, { ok: true });
    }
    if (u.pathname === '/api/agent/relay/approval' && raw) {
      assert.ok(relayApprovalSchema.safeParse(raw).success);
      approvals.push(raw);
      if (approvals.length === 1) return json(res, 429, { error: 'rate_limited' }, { 'retry-after': '2' });
      return json(res, 201, { id: randomUUID() });
    }
    if (u.pathname === '/api/agent/relay/approval') return json(res, 200, { status: 'approved' });
    return json(res, 404, {});
  };
  return { turns, approvals };
}

// ---- MINOR 4: unreachable, then claimed again: not run twice, one error mac_failed with the new claim.
// ---- MINOR 5: a 429 on an events post waits its Retry-After and carries on; on an approval, asked again.
{
  const stuck = randomUUID(), busy = randomUUID();
  const first = randomUUID(); // the stuck turn's first claim: Hydra unreachable for it
  const t1 = { id: stuck, claimId: first, threadId: randomUUID(), surface: 'web', input: { text: 'a' }, context: {}, rule: (b) => (b.events.length && b.claimId === first ? { status: 503 } : null) };
  const t2 = { id: busy, claimId: randomUUID(), threadId: randomUUID(), surface: 'phone', input: { text: 'b' }, context: {}, rule: (b, s) => (b.events.length && !s.limited ? (s.limited = true, { status: 429, headers: { 'retry-after': '3' } }) : null) };
  const again = { ...t1, claimId: randomUUID() }; // the same turn, re-queued and claimed again
  const fake = relayServer([t1, t2, again]);
  const ran = [], sleeps = [], logs = [];
  let answer = null;
  const relay = createRelay({
    api, waitSecs: 1, flushMs: 1, heartbeatMs: 10_000, backoff: [5], retry: [10, 20], slots: ['live'], sleep: fastSleep(sleeps), log: (k, d) => logs.push([k, d]),
    runTurn: async (t, { emit, approve }) => {
      ran.push(t.id);
      emit({ type: 'text', delta: 'hi' });
      if (t.id === busy) answer = await approve({ summary: 'Gmail: send message; to: a@b.c', danger: true });
      await wait(30);
      emit({ type: 'done' });
    },
  });
  relay.start();
  await until(() => fake.turns.get(stuck).events.length && fake.turns.get(busy).closed);
  await relay.stop();
  assert.deepEqual(ran, [stuck, busy], 'the re-claimed turn never ran a second time');
  assert.ok(logs.some(([k, d]) => k === 'relay_lost' && d.id === stuck && d.why === 'unreachable'));
  const s = fake.turns.get(stuck);
  assert.deepEqual(s.events, [MAC_FAILED], 'one error, mac_failed');
  const last = s.posts.at(-1);
  assert.equal(last.claimId, again.claimId, 'with the new claim');
  assert.equal(last.seq, 1);
  assert.equal(s.posts.filter((p) => p.claimId === again.claimId).length, 1, 'once, then it moves on');
  // 429: waited its Retry-After (3 s, 2 s), never fatal.
  assert.ok(sleeps.includes(3000), `events 429 waited Retry-After: ${sleeps}`);
  assert.ok(sleeps.includes(2000), 'approval 429 waited Retry-After');
  assert.equal(answer, 'approved');
  assert.equal(fake.approvals.length, 2, 'the approval was asked again after the 429');
  const b = fake.turns.get(busy).events;
  assert.equal(b.at(-1).type, 'done', 'the turn finished');
  assert.ok(!b.some((e) => e.type === 'error'), 'no mac_bad_event for a 429');
}

// ---- MINOR 7: near the live cap the heartbeat runs every capBeatMs; a side-effecting tool checks the turn first.
{
  const id = randomUUID(), rid = randomUUID();
  const live = { id, claimId: randomUUID(), threadId: randomUUID(), surface: 'web', input: { text: 'x' }, context: {} };
  const routine = { id: rid, claimId: randomUUID(), threadId: randomUUID(), surface: 'routine', input: { text: 'y' }, context: {} };
  const fake = relayServer([live, routine]);
  let alive1 = null, alive2 = null;
  const relay = createRelay({
    api, waitSecs: 1, flushMs: 1, heartbeatMs: 300, liveCapMs: 500, capWindowMs: 200, capBeatMs: 20, slots: ['live'], backoff: [5],
    runTurn: async (t, { emit, alive }) => {
      if (t.id === id) {
        await wait(480); // past 300 ms: the last 200 ms before the cap
        alive1 = await alive();
        fake.turns.get(id).closed = true; // the server's 280 s cap: expired
        alive2 = await alive();
        return;
      }
      await wait(480);
      emit({ type: 'done' });
    },
  });
  relay.start();
  await until(() => alive2 !== null && fake.turns.get(rid).closed);
  await relay.stop();
  const beats = fake.turns.get(id).posts.filter((p) => !p.events.length).length;
  assert.ok(beats >= 6, `fast heartbeats near the cap: ${beats}`);
  assert.ok(fake.turns.get(rid).posts.filter((p) => !p.events.length).length <= 2, 'a routine has no cap: the normal heartbeat');
  assert.equal(alive1, true, 'a heartbeat answered 200: live');
  assert.equal(alive2, false, 'expired: not live');
  // A Hydra tool that writes asks first; one that only reads doesn't. Over: never called.
  const mcp = [];
  handle = (u, raw, res) => {
    if (u.pathname !== '/api/mcp/agent') return json(res, 404, {});
    if (raw.method === 'tools/list') return json(res, 200, { jsonrpc: '2.0', id: raw.id, result: { tools: [{ name: 'add_task', inputSchema: { type: 'object' } }, { name: 'list_tasks', annotations: { readOnlyHint: true }, inputSchema: { type: 'object' } }] } });
    mcp.push(raw.params.name);
    return json(res, 200, { jsonrpc: '2.0', id: raw.id, result: { content: [{ type: 'text', text: 'ok' }] } });
  };
  const ht = createHydraTools({ api });
  await ht.refresh();
  const checked = [];
  let ok = true;
  const [add, list] = ht.tools({ beforeRun: async (n) => { checked.push(n); return ok; } });
  assert.equal(await add.execute({}), 'ok');
  ok = false;
  await assert.rejects(add.execute({}), /This turn is over/);
  assert.equal(await list.execute({}), 'ok', 'a read runs without the check');
  assert.deepEqual(checked, ['add_task', 'add_task']);
  assert.deepEqual(mcp, ['add_task', 'list_tasks'], 'the write after the turn ended never reached Hydra');
}

// ---- MAJOR 2: the owner's turns on the Mac in his shared thread.
{
  const posts = [], threads = [randomUUID(), randomUUID()];
  let plan = [];
  handle = (u, raw, res) => {
    if (u.pathname !== '/api/agent/relay/local') return json(res, 404, {});
    const p = localTurnSchema.safeParse(raw);
    posts.push(raw);
    if (!p.success) return json(res, 400, { error: 'invalid_input' });
    const step = plan.shift();
    if (step) return json(res, step.status, { error: 'x' }, step.headers);
    return json(res, 200, { threadId: p.data.threadId ?? threads[posts.filter((x) => !x.threadId).length - 1] });
  };
  let t = Date.parse('2026-11-22T10:00:00Z');
  const sleeps = [], logs = [];
  const sync = createLocalSync({ api, now: () => t, sleep: fastSleep(sleeps), retry: [10, 20, 40], log: (k, d) => logs.push([k, d]) });
  // Never in the voice's way: record() returns at once, before anything reaches Hydra.
  const p1 = sync.record({ user: 'what is on today', assistant: 'Two meetings.' });
  assert.equal(posts.length, 0);
  await p1;
  assert.equal(posts[0].threadId, undefined, 'the first turn: Hydra picks the thread');
  assert.equal(posts[0].at, '2026-11-22T10:00:00.000Z');
  assert.equal(sync.threadId, threads[0], 'the answer is the current thread');
  // A busy server: 503, then 429 with Retry-After, then stored. Same thread.
  t += 10 * 60_000;
  plan = [{ status: 503 }, { status: 429, headers: { 'retry-after': '4' } }];
  await sync.record({ user: 'and tomorrow', assistant: '' });
  assert.equal(posts.length, 4);
  assert.deepEqual(sleeps, [10, 4000], 'backoff, then the Retry-After');
  assert.ok(posts.slice(1).every((p) => p.threadId === threads[0]), 'kept for 30 quiet minutes');
  // 30 quiet minutes: a new thread from Hydra.
  t += 30 * 60_000 + 1;
  assert.equal(sync.threadId, null);
  await sync.record({ user: 'new topic', assistant: 'Sure.' });
  assert.equal(posts.at(-1).threadId, undefined);
  assert.equal(sync.threadId, threads[1]);
  // In order, one at a time, even when fired back to back.
  const a = sync.record({ user: 'one', assistant: '1' }), b = sync.record({ user: 'two', assistant: '2' });
  await Promise.all([a, b]);
  assert.deepEqual(posts.slice(-2).map((p) => p.user), ['one', 'two']);
  // A refused one (4xx) is dropped, not retried; an empty one never sent; long text cut to the schema.
  plan = [{ status: 400 }];
  const before = posts.length;
  await sync.record({ user: 'refused', assistant: '' });
  assert.equal(posts.length, before + 1);
  await sync.record({ user: '   ', assistant: 'x' });
  assert.equal(posts.length, before + 1);
  await sync.record({ user: 'u'.repeat(9000), assistant: 'a'.repeat(40_000) });
  assert.equal(posts.at(-1).user.length, 8000); assert.equal(posts.at(-1).assistant.length, 32_000);
  // Offline for good: gives up after the retries, never throws.
  const off = createLocalSync({ api: hydraApi({ base: 'http://127.0.0.1:1', getKey: async () => KEY }), sleep: fastSleep(), retry: [1, 1] });
  await off.record({ user: 'hi', assistant: '' });
  // No key: dropped quietly.
  const nokey = createLocalSync({ api: hydraApi({ base: 'http://127.0.0.1:1', getKey: async () => null }) });
  await nokey.record({ user: 'hi', assistant: '' });
  assert.ok(!JSON.stringify(logs).includes(KEY));
}

// ---- NIT 10: a connector ask in words, never raw JSON.
{
  const s = askSummary('Gmail', 'send_message', { to: ['a@b.c', 'd@e.f'], subject: 'Lunch', body: 'See you at noon.', isHtml: false });
  assert.equal(s, 'Gmail: send message; to: a@b.c, d@e.f; subject: Lunch; body: See you at noon.');
  assert.ok(!/[{}"]/.test(s));
  const c = askSummary('Google Calendar', 'create_event', { summary: 'Dentist', start: { dateTime: '2026-11-23T09:00:00' }, attendees: [{ email: 'x@y.z' }] });
  assert.equal(c, 'Google Calendar: create event; summary: Dentist; start: 2026-11-23T09:00:00; attendees: x@y.z');
  assert.equal(askSummary('Gmail', 'trash_message', { messageId: '18c2' }), 'Gmail: trash message; message id: 18c2');
  const long = askSummary('Gmail', 'send_message', { to: 'a@b.c', subject: 'Report', body: 'word '.repeat(400) });
  assert.ok(long.length <= 500 && long.startsWith('Gmail: send message; to: a@b.c; subject: Report; body: word'), 'the key fields whole, a long body shortened at a word');
  assert.ok(long.endsWith('word…'));
}

// ---- NIT 9: relayschema.mjs is the web's relay-schema.ts byte for byte (HYDRA_RELAY_SCHEMA: a copy of the web file).
{
  const mine = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../relayschema.mjs'), 'utf8');
  const theirs = process.env.HYDRA_RELAY_SCHEMA;
  if (theirs) assert.equal(mine, fs.readFileSync(theirs, 'utf8'), 'relayschema.mjs differs from the web\'s relay-schema.ts: copy it again');
  else console.log('relayfixes: HYDRA_RELAY_SCHEMA not set, schema diff skipped');
  assert.ok(mine.includes('export const localTurnSchema'));
  // The one navigate rule: never an API, auth or login route, even after dot segments.
  assert.deepEqual(cleanEvent({ type: 'ui', action: { kind: 'navigate', href: '/api/agent/devices' } }), []);
  assert.deepEqual(cleanEvent({ type: 'ui', action: { kind: 'navigate', href: '/money/../auth/x' } }), []);
  assert.equal(cleanEvent({ type: 'ui', action: { kind: 'navigate', href: '/money?tx=1' } }).length, 1);
}

server.close();
console.log('relayfixes: ok');
