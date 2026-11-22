// The relay after the server-brain seam check, against a fake Hydra (the server's own schemas):
// - approve() refuses once the turn is closed: nothing is asked, the answer is 'expired';
// - createLocalSync on a 404 (the thread is gone) forgets it and sends once more without it;
// - a stopped turn is remembered on disk (stateFile), so a restarted relay never runs it twice;
// - a turn running when its process is killed (kill -9) is not run again after the restart; a clean end clears it.
// Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { MAC_FAILED, createLocalSync, createRelay } from '../relay.mjs';
import { hydraApi } from '../hydramcp.mjs';
import { localTurnSchema, relayBatchSchema } from '../relayschema.mjs';

const KEY = 'hyd_dev_0123456789abcdef0123456789';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (ok, ms = 5000) => { const end = Date.now() + ms; while (!ok() && Date.now() < end) await wait(5); assert.ok(ok(), 'timed out'); };
const body = (req) => new Promise((res) => { let s = ''; req.on('data', (d) => { s += d; }); req.on('end', () => res(s ? JSON.parse(s) : null)); });
const json = (res, code, v) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
const fastSleep = (ms, s) => new Promise((r, j) => { const t = setTimeout(r, 1); s?.addEventListener('abort', () => { clearTimeout(t); j(new Error('aborted')); }, { once: true }); });
let handle = null;
// A fake Hydra on its own port. Section 4 gets a fresh one (R11-5): a poll an earlier, stopped relay already sent can
// still reach the shared server after its handler changed, and take the turn section 4 offers its child.
const listen = async (route) => {
  const srv = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${KEY}`) return json(res, 401, {});
    const u = new URL(req.url, 'http://x');
    return route()(u, req.method === 'POST' ? await body(req) : null, res, req);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, base: `http://127.0.0.1:${srv.address().port}`, api: hydraApi({ base: `http://127.0.0.1:${srv.address().port}`, getKey: async () => KEY }) };
};
const { srv: server, api } = await listen(() => handle);
const turnOf = (id) => ({ id, claimId: randomUUID(), threadId: randomUUID(), surface: 'web', input: { text: 'hi' }, context: { path: '/', search: '', scope: 'all' } });
const idle = (res) => setTimeout(() => { res.writeHead(204); res.end(); }, 10);

// ---- 1. approve() after the turn closed: no approval is made, the answer is 'expired'.
{
  const t = turnOf(randomUUID());
  let given = false, approvalPosts = 0, answer = null;
  handle = (u, raw, res) => {
    if (u.pathname === '/api/agent/relay/next') { if (given) return idle(res); given = true; return json(res, 200, { turn: t }); }
    if (u.pathname === '/api/agent/relay/events') { relayBatchSchema.parse(raw); return json(res, 200, { ok: true }); }
    if (u.pathname === '/api/agent/relay/approval') { approvalPosts++; return json(res, 200, { id: randomUUID() }); }
    return json(res, 404, {});
  };
  const relay = createRelay({
    api, slots: ['live'], waitSecs: 1, minPollMs: 1, heartbeatMs: 60_000, waitFor: async () => 'approved',
    runTurn: async (turn, { emit, approve }) => { emit({ type: 'done' }); answer = await approve({ summary: 'Gmail: send message' }); },
  });
  relay.start();
  await until(() => answer !== null);
  await relay.stop();
  assert.equal(answer, 'expired', 'a closed turn asks nothing');
  assert.equal(approvalPosts, 0, 'no approval row is made for a turn that is over');
}

// ---- 2. createLocalSync: a 404 on the thread clears it and the turn is sent once more without it.
{
  const T1 = randomUUID(), T2 = randomUUID();
  const posts = [];
  let gone = false;
  handle = (u, raw, res) => {
    assert.equal(u.pathname, '/api/agent/relay/local');
    assert.ok(localTurnSchema.safeParse(raw).success, 'the server\'s own schema');
    posts.push(raw);
    if (raw.threadId && gone) return json(res, 404, { error: 'not_found' });
    return json(res, 200, { threadId: gone ? T2 : T1 });
  };
  const sync = createLocalSync({ api, sleep: fastSleep });
  await sync.record({ user: 'first', assistant: 'one' });
  assert.equal(sync.threadId, T1);
  gone = true; // the owner deleted the thread on the web
  await sync.record({ user: 'second', assistant: 'two' });
  assert.equal(posts.length, 3);
  assert.equal(posts[1].threadId, T1, 'tried the old thread first');
  assert.equal(posts[2].threadId, undefined, 'then once more without it');
  assert.equal(posts[2].user, 'second', 'the same turn, not lost');
  assert.equal(sync.threadId, T2, 'and keeps the thread Hydra picked');
  // A 404 without a thread is not retried.
  handle = (u, raw, res) => { posts.push(raw); return json(res, 404, {}); };
  const fresh = createLocalSync({ api, sleep: fastSleep });
  posts.length = 0;
  await fresh.record({ user: 'third' });
  assert.equal(posts.length, 1, 'dropped, once');
}

// ---- 3. The stopped-turn memory survives a restart: claimed again by a new relay, the turn is not run twice.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-state-'));
  const stateFile = path.join(dir, 'relay-stopped.json');
  const t = turnOf(randomUUID());
  let offline = true, offer = true;
  const posted = [];
  handle = (u, raw, res) => {
    if (u.pathname === '/api/agent/relay/next') { if (!offer) return idle(res); offer = false; return json(res, 200, { turn: t }); }
    if (u.pathname === '/api/agent/relay/events') {
      if (offline) return json(res, 503, {}); // Hydra unreachable for this turn: the Mac stops it
      relayBatchSchema.parse(raw);
      posted.push(...raw.events);
      return json(res, 200, { ok: true });
    }
    return json(res, 404, {});
  };
  let runs = 0;
  const make = () => createRelay({
    api, slots: ['live'], waitSecs: 1, minPollMs: 1, heartbeatMs: 60_000, retry: [1, 1], sleep: fastSleep, stateFile,
    runTurn: async (turn, { emit, signal }) => { runs++; emit({ type: 'text', delta: 'working' }); await new Promise((r) => signal.addEventListener('abort', r, { once: true })); },
  });
  const a = make();
  a.start();
  await until(() => fs.existsSync(stateFile));
  await a.stop();
  assert.equal(runs, 1);
  assert.ok(Number.isFinite(JSON.parse(fs.readFileSync(stateFile, 'utf8'))[t.id]), 'the stopped turn is on disk');
  assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);
  // "Restart": a new relay, Hydra reachable again, the same turn re-queued and claimed (a new claim).
  offline = false; offer = true; t.claimId = randomUUID();
  const b = make();
  b.start();
  await until(() => posted.length > 0);
  await b.stop();
  assert.equal(runs, 1, 'not run a second time after the restart');
  assert.deepEqual(posted, [MAC_FAILED], 'one mac_failed, nothing else');
  // An unreadable file is no memory, never a crash.
  fs.writeFileSync(stateFile, 'not json');
  const c = make();
  c.start(); await c.stop();
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- 4. Killed mid-turn (kill -9, a crash): nothing was recorded as stopped, yet after the restart the re-claimed turn
// is refused (mac_failed), never run a second time. A turn that ends cleanly leaves no mark.
{
  let handle = null;
  const { srv, base, api } = await listen(() => handle);
  server.close(); // nothing from sections 1 to 3 can reach this section
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-crash-'));
  const stateFile = path.join(dir, 'relay-stopped.json');
  const t = turnOf(randomUUID()), ok = turnOf(randomUUID());
  const offers = [t];
  const posted = [];
  let runningMarker = false;
  handle = (u, raw, res) => {
    if (u.pathname === '/api/agent/relay/next') { const n = offers.shift(); return n ? json(res, 200, { turn: n }) : idle(res); }
    if (u.pathname === '/api/agent/relay/events') {
      relayBatchSchema.parse(raw);
      posted.push(...raw.events.map((e) => ({ turn: raw.turnId, ...e })));
      if (raw.events.some((e) => e.type === 'text' && e.delta === 'sending')) runningMarker = true;
      return json(res, 200, { ok: true });
    }
    return json(res, 404, {});
  };
  // The first process: claims the turn, says it is sending, then hangs until it is killed.
  const child = path.join(dir, 'child.mjs');
  const relayUrl = pathToFileURL(path.resolve(import.meta.dirname, '..', 'relay.mjs')).href;
  const apiUrl = pathToFileURL(path.resolve(import.meta.dirname, '..', 'hydramcp.mjs')).href;
  fs.writeFileSync(child, `import { createRelay } from ${JSON.stringify(relayUrl)};
import { hydraApi } from ${JSON.stringify(apiUrl)};
const api = hydraApi({ base: ${JSON.stringify(base)}, getKey: async () => ${JSON.stringify(KEY)} });
createRelay({ api, slots: ['live'], waitSecs: 1, minPollMs: 1, flushMs: 1, heartbeatMs: 60_000, stateFile: ${JSON.stringify(stateFile)},
  runTurn: async (turn, { emit }) => { emit({ type: 'text', delta: 'sending' }); await new Promise(() => {}); } }).start();
`);
  const proc = spawn(process.execPath, [child], { stdio: 'ignore', env: { PATH: process.env.PATH, HOME: dir } });
  await until(() => runningMarker, 15_000);
  proc.kill('SIGKILL');
  await new Promise((r) => proc.once('exit', r));
  // The restart: the same turn re-queued (its lease ran out) and claimed again, then an ordinary turn.
  t.claimId = randomUUID();
  offers.push(t, ok);
  let runs = 0;
  const b = createRelay({
    api, slots: ['live'], waitSecs: 1, minPollMs: 1, flushMs: 1, heartbeatMs: 60_000, stateFile,
    runTurn: async (turn, { emit }) => { runs++; emit({ type: 'text', delta: `ran ${turn.id}` }); emit({ type: 'done' }); },
  });
  b.start();
  await until(() => posted.some((e) => e.turn === ok.id && e.type === 'done'));
  await b.stop();
  assert.deepEqual(posted.filter((e) => e.turn === t.id).map(({ turn: _t, ...e }) => e), [{ type: 'text', delta: 'sending' }, MAC_FAILED], 'the killed turn: one mac_failed after the restart, never run again');
  assert.equal(runs, 1, 'only the ordinary turn ran');
  const left = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.ok(Number.isFinite(left[t.id]), 'the killed turn stays marked');
  assert.equal(left[ok.id], undefined, 'a turn that ended cleanly leaves no mark');
  fs.rmSync(dir, { recursive: true, force: true });
  srv.close();
}

console.log('relaystate: ok');
