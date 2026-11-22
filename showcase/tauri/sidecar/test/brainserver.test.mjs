// Hydra's server brain (brain-server.mjs, hydra-brain CLI), against a fake Hydra on this machine. Covered:
// - run refuses to start with any variable that would move Claude Code off the owner's claude.ai login;
// - Claude Code is launched with the exact allow list (our Hydra tools) and every built-in disallowed (the real SDK's
//   command line, seen through its spawn seam), no --strict-mcp-config or --bare, and no forbidden variable;
// - a connector write becomes a relay approval and never runs before "approved"; a read runs; a decline never runs;
// - pair stores the key with mode 600 (folder 700) and never prints it; status says what is there;
// - only Gmail and Calendar connectors run on the server; a read that can return a secret or fetch a URL asks;
// - pairing again while it runs takes effect without a restart;
// - the systemd unit's hardening (systemd-analyze verify where it exists), deploy-brain.sh (bash -n, shellcheck): one
//   bundled file that runs alone, no npm on the server, hydra@ only, sudo -n (ssh and rsync faked).
// Run: npm test (HOME is a temp folder).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { BUILTIN_TOOLS, brainGate, brainPaths, createBrainTurn, forbiddenEnv, main, writeKey } from '../brain-server.mjs';
import { connectorLevel, createRelay } from '../relay.mjs';
import { hydraApi, waitApproval } from '../hydramcp.mjs';
import { relayApprovalSchema, relayBatchSchema } from '../relayschema.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SIDECAR = path.dirname(HERE);
const REPO = path.resolve(SIDECAR, '..', '..', '..');
const BRAIN = path.join(SIDECAR, 'brain-server.mjs');
const KEY = 'hyd_dev_brain_0123456789abcdef0123';
const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-brain-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (ok, ms = 8000) => { const end = Date.now() + ms; while (!ok() && Date.now() < end) await wait(5); assert.ok(ok(), 'timed out'); };
const body = (req) => new Promise((res) => { let s = ''; req.on('data', (d) => { s += d; }); req.on('end', () => res(s ? JSON.parse(s) : null)); });
const json = (res, code, v) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
// A clean environment for the CLI: the temp HOME and a PATH, nothing of this machine's own.
const cleanEnv = (home, extra = {}) => ({ HOME: home, PATH: process.env.PATH, ...extra });

let handle = null;
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const raw = req.method === 'POST' ? await body(req) : null;
  return handle(u, raw, res, req);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

// ---- 1. run refuses any variable that is not the owner's claude.ai login (names only, never the value).
{
  const FORBIDDEN = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_PROFILE', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'AWS_BEARER_TOKEN_BEDROCK', 'ENABLE_CLAUDEAI_MCP_SERVERS', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'];
  const home = tmpHome();
  for (const k of FORBIDDEN) {
    assert.deepEqual(forbiddenEnv({ PATH: '/bin', [k]: 'x' }), [k], `${k} is forbidden`);
    const errs = [];
    const code = await main(['run'], { env: cleanEnv(home, { [k]: 'secret-value-123' }), out: () => {}, err: (s) => errs.push(s), setupWaitMs: 1 });
    assert.equal(code, 2, `${k}: refused`);
    assert.match(errs.join('\n'), new RegExp(k), 'the message names it');
    assert.doesNotMatch(errs.join('\n'), /secret-value-123/, 'never its value');
  }
  assert.deepEqual(forbiddenEnv({ PATH: '/bin', HOME: '/h', CLAUDE_CONFIG_DIR: '/c', DISABLE_AUTOUPDATER: '1' }), [], 'ordinary variables are fine');
  // The real process, as systemd starts it: exit 2 (RestartPreventExitStatus=2 in the unit).
  const r = spawnSync(process.execPath, [BRAIN, 'run'], { env: cleanEnv(home, { ANTHROPIC_API_KEY: 'sk-ant-xyz' }), encoding: 'utf8', timeout: 20_000 });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /Refusing to start: ANTHROPIC_API_KEY is set/);
  assert.doesNotMatch(r.stdout + r.stderr, /sk-ant-xyz/);
}

// A Hydra tool as createHydraTools makes them (the turn only needs tools()).
const fakeHydraTools = (ran = []) => ({
  count: 1, refresh: async () => 1,
  tools: () => [{ name: 'hydra_list_transactions', description: 'List transactions', parameters: z.looseObject({}), execute: async () => { ran.push('list'); return '[]'; } }],
});

// ---- 2. The exact Claude Code command line: our tools allowed, every built-in disallowed, nothing forbidden. Checked
// on the source here, and on the bundle the deploy ships (7).
async function checkCommandLine({ createBrainTurn, BUILTIN_TOOLS }) {
  const home = tmpHome();
  const exe = path.join(home, 'claude');
  fs.writeFileSync(exe, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  let seen = null;
  const fakeSpawn = (o) => {
    seen = o;
    // Stands in for Claude Code: exits at once, so the SDK gives up and the turn ends with an error.
    return spawn(process.execPath, ['-e', 'process.stdin.resume(); setTimeout(() => process.exit(0), 50)'], { stdio: ['pipe', 'pipe', 'pipe'] });
  };
  const run = createBrainTurn({
    hydraTools: fakeHydraTools(), executable: exe, cwd: home, spawn: fakeSpawn,
    env: { HOME: home, PATH: process.env.PATH, ANTHROPIC_API_KEY: 'sk-ant-leak', CLAUDE_CODE_OAUTH_TOKEN: 'tok-leak', ANTHROPIC_PROFILE: 'p' },
  });
  const ctl = new AbortController();
  const events = [];
  await Promise.race([
    run({ id: randomUUID(), surface: 'web', input: { text: 'hi' }, context: { path: '/', search: '', scope: 'all' } }, { emit: (e) => events.push(e), signal: ctl.signal, approve: async () => 'declined' }).catch(() => {}),
    wait(15_000),
  ]);
  ctl.abort();
  assert.ok(seen, 'Claude Code was spawned');
  assert.equal(seen.command, exe, 'the owner\'s own Claude Code');
  const flag = (name) => {
    const a = seen.args;
    for (let i = 0; i < a.length; i++) {
      if (a[i] === name) return a[i + 1];
      if (a[i].startsWith(`${name}=`)) return a[i].slice(name.length + 1);
    }
    return undefined;
  };
  assert.deepEqual(flag('--allowedTools').split(','), ['mcp__gg__hydra_list_transactions', 'mcp__gg__hydra_show'], 'exactly the Hydra tools are allowed');
  assert.deepEqual(flag('--disallowedTools').split(','), BUILTIN_TOOLS, 'every built-in disallowed');
  for (const t of ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'NotebookEdit', 'Task']) assert.ok(BUILTIN_TOOLS.includes(t), `${t} is disallowed`);
  assert.equal(flag('--tools'), '', 'no built-in tools at all');
  assert.ok(flag('--permission-prompt-tool') !== undefined, 'anything not allowed comes to canUseTool (the gate)');
  assert.ok(!seen.args.includes('--strict-mcp-config'), 'no strict MCP config: claude.ai connectors load');
  assert.ok(!seen.args.includes('--bare'), 'never --bare');
  assert.ok(!seen.args.some((a) => /disableClaudeAi|claudeai-mcp/i.test(a)), 'connectors never switched off');
  for (const k of Object.keys(seen.env)) assert.ok(!/^(ANTHROPIC_|CLAUDE_CODE_OAUTH|CLAUDE_CODE_USE_)/.test(k), `${k} is not passed to Claude Code`);
  assert.ok(!Object.values(seen.env).some((v) => /leak/.test(String(v))), 'no token reaches Claude Code');
  assert.equal(seen.env.ENABLE_CLAUDEAI_MCP_SERVERS, undefined);
}
await checkCommandLine({ createBrainTurn, BUILTIN_TOOLS });

// ---- 3. A connector write is a relay approval: it runs only after "approved"; a read runs; a decline never runs.
{
  // The gate alone: a read needs no approval, a send waits for it.
  const asked = [];
  let answer;
  const gate = brainGate({ approve: (a) => { asked.push(a); return new Promise((r) => { answer = r; }); } });
  assert.equal(await gate('mcp__claude_ai_Gmail__search_threads', { query: 'invoice' }), true, 'a read runs');
  assert.equal(asked.length, 0, 'a read asks nothing');
  let done = false;
  const p = gate('mcp__claude_ai_Gmail__send_message', { to: 'a@b.c', subject: 'Hi', body: 'Hello' }).then((v) => { done = true; return v; });
  await wait(20);
  assert.equal(done, false, 'the send waits for the owner');
  assert.equal(asked[0].summary, 'Gmail: send message; to: a@b.c; subject: Hi; body: Hello');
  assert.equal(asked[0].danger, true);
  answer('approved');
  assert.equal(await p, true);
  for (const [tool, a] of [['trash_thread', 'declined'], ['delete_event', 'expired'], ['create_event', 'declined'], ['update_event', 'declined']]) {
    const g = brainGate({ approve: async () => a });
    assert.equal(await g(`mcp__claude_ai_Google_Calendar__${tool}`, {}), false, `${tool} ${a}: not run`);
  }
  assert.equal(await brainGate({ approve: async () => 'approved', alive: async () => false })('mcp__claude_ai_Gmail__send_message', {}), false, 'approved, but the turn is over: not run');
  assert.equal(await brainGate({ approve: async () => 'approved' })('Bash', {}), false, 'a built-in is never a connector');

  // Only Gmail and Calendar run on the server: any other connector of the owner's account is refused, read or not,
  // without an ask (an email cannot get the server to read Railway variables or fetch a link).
  const other = [];
  const strict = brainGate({ approve: async (a) => { other.push(a); return 'approved'; } });
  for (const n of ['mcp__claude_ai_Railway__list-variables', 'mcp__claude_ai_Railway__get-bucket-credentials', 'mcp__claude_ai_Vercel__web_fetch_vercel_url',
    'mcp__claude_ai_Vercel__get_access_to_vercel_url', 'mcp__claude_ai_Vercel__get_project_env', 'mcp__claude_ai_Google_Drive__read_file_content', 'mcp__claude_ai_Google_Drive__search_files',
    'mcp__gg__hydra_list_transactions', 'mcp__Gmail__search_threads']) {
    assert.equal(await strict(n, {}), false, `${n}: not run on the server`);
  }
  assert.equal(other.length, 0, 'and nothing is asked for them');
  for (const n of ['mcp__claude_ai_Gmail__get_message', 'mcp__claude_ai_Gmail__download_gmail_attachment', 'mcp__claude_ai_Google_Calendar__list_events']) assert.equal(await strict(n, {}), true, `${n}: a Gmail or Calendar read runs`);
  // The shared gate (Mac too): a read that can return a secret or fetch a URL asks, and so does any name that is not
  // plainly a read (claude.ai sends no hints; none is assumed).
  for (const tool of ['get-bucket-credentials', 'list-variables', 'get_project_env', 'web_fetch_vercel_url', 'get_access_to_vercel_url', 'fetch_url', 'get_api_key', 'list_tokens', 'getSecret']) {
    assert.equal(connectorLevel({ server: 'claude_ai_X', tool }).level, 'ask', `${tool} asks`);
  }
  for (const tool of ['search_threads', 'get_thread', 'list_events', 'read_file_content', 'download_gmail_attachment']) assert.equal(connectorLevel({ server: 'claude_ai_X', tool }).level, 'safe', `${tool} is a read`);

  // End to end through the relay and a fake Hydra (the server's own schemas), with Claude Code stubbed.
  const T = [randomUUID(), randomUUID()];
  const queue = T.map((id) => ({ id, claimId: randomUUID(), threadId: randomUUID(), surface: 'phone', input: { text: 'email Ann' }, context: { path: '/', search: '', scope: 'all' } }));
  const claims = new Map(queue.map((t) => [t.id, t.claimId]));
  const posted = [], approvals = new Map(), order = [];
  // The owner approves the first turn's ask and declines the second's (by turn, so no timing decides it).
  handle = (u, raw, res, req) => {
    if (req.headers.authorization !== `Bearer ${KEY}`) return json(res, 401, {});
    if (u.pathname === '/api/agent/relay/next') {
      if (u.searchParams.get('slot') !== 'live' || !queue.length) return void setTimeout(() => { res.writeHead(204); res.end(); }, 20);
      return json(res, 200, { turn: queue.shift() });
    }
    if (u.pathname === '/api/agent/relay/events') {
      relayBatchSchema.parse(raw);
      if (raw.claimId !== claims.get(raw.turnId)) return json(res, 409, { error: 'stale_claim' });
      posted.push(...raw.events.map((e) => ({ turn: raw.turnId, ...e })));
      return json(res, 200, { ok: true });
    }
    if (u.pathname === '/api/agent/relay/approval' && req.method === 'POST') {
      relayApprovalSchema.parse(raw);
      const id = randomUUID();
      approvals.set(id, { status: 'pending', polls: 0, answer: raw.turnId === T[0] ? 'approved' : 'declined' });
      order.push(`asked ${raw.summary}`);
      return json(res, 200, { id });
    }
    if (u.pathname === '/api/agent/relay/approval') {
      const a = approvals.get(u.searchParams.get('id'));
      if (!a) return json(res, 404, {});
      if (++a.polls >= 3 && a.status === 'pending') { a.status = a.answer; order.push(`owner ${a.answer}`); }
      return json(res, 200, { status: a.status });
    }
    return json(res, 404, {});
  };
  const api = hydraApi({ base: BASE, getKey: async () => KEY });
  // Claude Code: reads a thread, then asks to send; "sends" only if canUseTool allowed it.
  const query = ({ options }) => Object.assign((async function* () {
    yield { type: 'system', subtype: 'init', session_id: 's1' };
    const read = await options.canUseTool('mcp__claude_ai_Gmail__search_threads', { query: 'Ann' }, { signal: new AbortController().signal });
    order.push(`read ${read.behavior}`);
    const send = await options.canUseTool('mcp__claude_ai_Gmail__send_message', { to: 'ann@example.com', subject: 'Lunch', body: 'Noon?' }, { signal: new AbortController().signal });
    if (send.behavior === 'allow') order.push('SENT');
    else order.push('not sent');
    yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's1' };
  })(), { interrupt: async () => {}, close: () => {} });
  const relay = createRelay({
    api, slots: ['live'], waitSecs: 1, minPollMs: 1, heartbeatMs: 60_000,
    waitFor: (id, signal) => waitApproval(api, id, { signal, every: 5 }),
    runTurn: createBrainTurn({ hydraTools: fakeHydraTools(), executable: '/x/claude', cwd: os.tmpdir(), query }),
  });
  relay.start();
  await until(() => posted.filter((e) => e.turn === T[0] && e.type === 'done').length === 1);
  await until(() => posted.filter((e) => e.turn === T[1] && e.type === 'done').length === 1);
  await relay.stop();
  assert.deepEqual(order, [
    'read allow', 'asked Gmail: send message; to: ann@example.com; subject: Lunch; body: Noon?', 'owner approved', 'SENT',
    'read allow', 'asked Gmail: send message; to: ann@example.com; subject: Lunch; body: Noon?', 'owner declined', 'not sent',
  ], 'sent only after the owner approved; never after a decline');
  const confirms = posted.filter((e) => e.type === 'confirm');
  assert.equal(confirms.length, 2, 'each ask showed as a confirm on the owner\'s surfaces');
  assert.ok(confirms.every((c) => approvals.has(c.id) && c.danger === true));
}

// ---- 4. pair: the key is stored mode 600 in a 700 folder and never printed.
{
  const home = tmpHome();
  let exchanged = null;
  handle = (u, raw, res) => {
    if (u.pathname !== '/api/agent/devices/exchange') return json(res, 404, {});
    exchanged = raw;
    return raw.code === 'GOOD-CODE1' ? json(res, 200, { key: KEY, deviceId: randomUUID() }) : json(res, 400, { error: 'invalid_code' });
  };
  const cli = (args, extra = {}) => new Promise((resolve) => {
    execFile(process.execPath, [BRAIN, ...args], { env: cleanEnv(home, { HYDRA_BRAIN_URL: BASE, ...extra }), timeout: 20_000 }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, out: stdout + stderr }));
  });
  const bad = await cli(['pair', 'no']);
  assert.equal(bad.code, 2, 'a malformed code is refused before any request');
  const wrong = await cli(['pair', 'BAD-CODE1']);
  assert.equal(wrong.code, 1);
  assert.match(wrong.out, /Pairing failed: invalid_code/);
  const p = brainPaths({ HOME: home });
  assert.equal(fs.existsSync(p.key), false, 'no key file after a failed pairing');
  const ok = await cli(['pair', 'GOOD-CODE1']);
  assert.equal(ok.code, 0, ok.out);
  assert.equal(exchanged.code, 'GOOD-CODE1');
  assert.match(ok.out, /Paired\./);
  assert.ok(!ok.out.includes(KEY), 'the key is never printed');
  assert.equal(fs.readFileSync(p.key, 'utf8').trim(), KEY);
  assert.equal(fs.statSync(p.key).mode & 0o777, 0o600, 'key file mode 600');
  assert.equal(fs.statSync(p.config).mode & 0o777, 0o700, 'its folder mode 700');
  assert.equal(p.key, path.join(home, '.config', 'hydra-brain', 'key'), '/home/hydra/.config/hydra-brain/key on the server');
  // Paired again (a new code): replaced, still 600.
  fs.chmodSync(p.key, 0o644);
  assert.equal((await cli(['pair', 'GOOD-CODE1'])).code, 0);
  assert.equal(fs.statSync(p.key).mode & 0o777, 0o600);

  // ---- 5. status: key, Claude login, Claude Code, last relay contact, version; and run waits for what is missing.
  const lines = [];
  await main(['status'], { env: cleanEnv(home), out: (s) => lines.push(s), err: (s) => lines.push(s) });
  assert.deepEqual(lines, ['key: present', 'claude login: missing', 'claude code: missing', 'last relay contact: never', 'version: dev']);
  const errs = [];
  assert.equal(await main(['run', '--once'], { env: cleanEnv(home), out: () => {}, err: (s) => errs.push(s) }), 1);
  assert.deepEqual(errs, ['Waiting: Claude Code was not found (HYDRA_CLAUDE_BIN or ~/.npm-global/bin/claude).']);
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(p.claudeCreds, JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat-secret', scopes: ['user:inference', 'user:mcp_servers'] } }));
  const bin = path.join(home, '.npm-global', 'bin', 'claude');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
  fs.mkdirSync(p.state, { recursive: true });
  fs.writeFileSync(p.status, JSON.stringify({ lastContact: new Date(Date.now() - 12_000).toISOString() }));
  lines.length = 0;
  await main(['status'], { env: cleanEnv(home), out: (s) => lines.push(s), err: (s) => lines.push(s) });
  assert.equal(lines[0], 'key: present');
  assert.equal(lines[1], 'claude login: present');
  assert.equal(lines[2], `claude code: ${bin}`);
  assert.match(lines[3], /^last relay contact: \d{4}-\d\d-\d\dT.* \(1[12] s ago\)$/);
  assert.ok(!lines.join('\n').includes('sk-ant-oat-secret') && !lines.join('\n').includes(KEY), 'status shows no secret');
  fs.writeFileSync(p.status, JSON.stringify({ lastContact: new Date().toISOString(), refused: 401 }));
  lines.length = 0;
  await main(['status'], { env: cleanEnv(home), out: (s) => lines.push(s) });
  assert.match(lines[3], /\(key refused: 401; pair again\)$/);
  fs.rmSync(home, { recursive: true, force: true });
}

// ---- 5b. Paired again while it runs (a revoked key, a new code): the running service uses the new key at once.
{
  const home = tmpHome();
  const p = brainPaths({ HOME: home });
  writeKey(p, KEY);
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(p.claudeCreds, JSON.stringify({ claudeAiOauth: { accessToken: 'x' } }));
  const bin = path.join(home, '.npm-global', 'bin', 'claude');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
  const NEW = 'hyd_dev_brain_fedcba9876543210fedc';
  const keys = [];
  handle = (u, raw, res, req) => {
    keys.push(req.headers.authorization);
    return void setTimeout(() => { res.writeHead(204); res.end(); }, 20);
  };
  const running = main(['run'], { env: cleanEnv(home, { HYDRA_BRAIN_URL: BASE }), out: () => {}, err: () => {} });
  await until(() => keys.length > 0);
  assert.equal(keys[0], `Bearer ${KEY}`, 'the old key first');
  writeKey(p, NEW); // hydra-brain pair <new code>, with the service still running
  await until(() => keys.includes(`Bearer ${NEW}`));
  process.emit('SIGTERM');
  assert.equal(await running, 0);
  fs.rmSync(home, { recursive: true, force: true });
}

// ---- 6. The systemd unit: hardened, journald, never an API key.
{
  const unitPath = path.join(REPO, 'scripts', 'hydra-brain.service');
  const unit = fs.readFileSync(unitPath, 'utf8');
  const kv = {};
  for (const line of unit.split('\n')) {
    const m = /^([A-Za-z]+)=(.*)$/.exec(line.trim());
    if (m) (kv[m[1]] ??= []).push(m[2]);
  }
  const one = (k) => { assert.equal(kv[k]?.length, 1, `${k} set once`); return kv[k][0]; };
  assert.equal(one('User'), 'hydra');
  assert.equal(one('Restart'), 'always');
  assert.equal(one('RestartPreventExitStatus'), '2');
  assert.equal(one('NoNewPrivileges'), 'yes');
  assert.equal(one('ProtectSystem'), 'strict');
  assert.equal(one('ProtectHome'), 'read-only');
  assert.equal(one('PrivateTmp'), 'yes');
  assert.equal(one('StandardOutput'), 'journal');
  assert.equal(one('StandardError'), 'journal');
  assert.equal(one('ExecStart'), '/usr/bin/node /home/hydra/hydra-brain/brain-server.mjs run');
  const rw = one('ReadWritePaths').split(/\s+/);
  for (const d of ['/home/hydra/.config/hydra-brain', '/home/hydra/.local/state/hydra-brain', '/home/hydra/.claude']) assert.ok(rw.includes(d), `${d} is writable`);
  assert.ok(rw.every((d) => d.replace(/^-/, '').startsWith('/home/hydra/')), 'nothing outside the hydra user\'s files is writable');
  assert.ok(!(kv.Environment ?? []).some((e) => forbiddenEnv({ [e.split('=')[0]]: '1' }).length), 'no forbidden variable in the unit');
  assert.ok(kv.Environment.includes('HYDRA_CLAUDE_BIN=/home/hydra/.npm-global/bin/claude'));
  // Claude Code's .claude.json lives in ~/.claude (writable even when it is made after the service started), never
  // in /home/hydra itself, which is read-only to the service.
  assert.ok(kv.Environment.includes('CLAUDE_CONFIG_DIR=/home/hydra/.claude'));
  assert.ok(!rw.some((d) => /\.claude\.json$/.test(d)), 'no single file in read-only /home/hydra is relied on');
  // Defense in depth beyond the read-only file system.
  for (const [k, v] of [['CapabilityBoundingSet', ''], ['RestrictNamespaces', 'yes'], ['SystemCallArchitectures', 'native'], ['ProtectProc', 'invisible'],
    ['ProtectClock', 'yes'], ['ProtectHostname', 'yes'], ['ProtectKernelLogs', 'yes'], ['RestrictRealtime', 'yes'], ['RestrictAddressFamilies', 'AF_UNIX AF_INET AF_INET6 AF_NETLINK']]) {
    assert.equal(one(k), v, `${k}=${v}`);
  }
  const ro = one('ReadOnlyPaths').split(/\s+/);
  for (const f of ['settings.json', 'settings.local.json', 'hooks', 'CLAUDE.md']) assert.ok(ro.includes(`-/home/hydra/.claude/${f}`), `~/.claude/${f} stays read-only to the service`);
  assert.ok(!/^(?:\s*)(EnvironmentFile|AmbientCapabilities|CapabilityBoundingSet=.*CAP_)/m.test(unit), 'no capabilities, no env file');
  const sa = spawnSync('systemd-analyze', ['verify', unitPath], { encoding: 'utf8' });
  if (sa.error?.code === 'ENOENT') console.log('brainserver: systemd-analyze not installed here; the unit was checked statically');
  else assert.equal(sa.status, 0, sa.stderr);
}

// ---- 7. deploy-brain.sh: valid bash, shellcheck-clean; it ships one bundled file (no npm, no install script, nothing
// fetched on the server), that bundle runs on its own; it deploys only to hydra@ and asks sudo for no password.
{
  const script = path.join(REPO, 'scripts', 'deploy-brain.sh');
  const text = fs.readFileSync(script, 'utf8');
  assert.equal(spawnSync('bash', ['-n', script]).status, 0, 'bash -n');
  const sc = spawnSync('shellcheck', [script], { encoding: 'utf8' });
  if (sc.error?.code === 'ENOENT') console.log('brainserver: shellcheck not installed here; skipped');
  else assert.equal(sc.status, 0, sc.stdout);
  const code = text.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  assert.ok(!/github|git clone|git pull|curl |wget |\bnpm\b|\bnpx\b|\byarn\b|\bpnpm\b/i.test(code), 'the server never installs or pulls code from anywhere');
  // Fake ssh and rsync: nothing here can reach a real server.
  const bin = tmpHome(), calls = path.join(bin, 'calls.log');
  for (const t of ['ssh', 'rsync']) fs.writeFileSync(path.join(bin, t), `#!/bin/sh\necho "${t} $*" >> "${calls}"\n[ "${t}" = ssh ] && cat > "${bin}/remote.sh"\nexit 0\n`, { mode: 0o755 });
  const env = { HOME: bin, PATH: `${bin}:${process.env.PATH}` };
  for (const target of ['root@203.0.113.7', 'ubuntu@203.0.113.7', '203.0.113.7', 'hydra@']) {
    const r = spawnSync('bash', [script, target], { env, encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 2, `${target}: refused`);
    assert.match(r.stderr, /must be hydra@<host>/);
  }
  assert.equal(fs.existsSync(calls), false, 'a refused target is never contacted');
  // The stage: exactly the bundle, its package.json, the unit and VERSION.
  const stageDir = path.join(tmpHome(), 'stage');
  const st = spawnSync('bash', [script, '--stage', stageDir], { env, encoding: 'utf8', timeout: 120_000 });
  assert.equal(st.status, 0, st.stderr);
  assert.deepEqual(fs.readdirSync(stageDir).sort(), ['VERSION', 'brain-server.mjs', 'hydra-brain.service', 'package.json']);
  assert.equal(fs.existsSync(calls), false, '--stage contacts nothing');
  // The bundle alone, in a folder with no node_modules anywhere above it: it runs, refuses an API key, and launches
  // Claude Code with the same locked-down command line as the source.
  const alone = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-brain-alone-'));
  for (const f of fs.readdirSync(stageDir)) fs.copyFileSync(path.join(stageDir, f), path.join(alone, f));
  const aloneHome = tmpHome();
  const s1 = spawnSync(process.execPath, [path.join(alone, 'brain-server.mjs'), 'status'], { cwd: alone, env: cleanEnv(aloneHome), encoding: 'utf8', timeout: 30_000 });
  assert.equal(s1.status, 0, s1.stderr);
  assert.match(s1.stdout, /^key: missing$/m);
  const s2 = spawnSync(process.execPath, [path.join(alone, 'brain-server.mjs'), 'run'], { cwd: alone, env: cleanEnv(aloneHome, { ANTHROPIC_API_KEY: 'sk-ant-xyz' }), encoding: 'utf8', timeout: 30_000 });
  assert.equal(s2.status, 2, s2.stderr);
  await checkCommandLine(await import(pathToFileURL(path.join(alone, 'brain-server.mjs')).href));
  // A real deploy run against the fakes: rsync of the stage only, then the remote script.
  fs.rmSync(calls, { force: true });
  const d = spawnSync('bash', [script, 'hydra@203.0.113.7'], { env, encoding: 'utf8', timeout: 120_000 });
  assert.equal(d.status, 0, d.stderr);
  const log = fs.readFileSync(calls, 'utf8').trim().split('\n');
  assert.equal(log.length, 2, log.join('\n'));
  assert.match(log[0], /^rsync -az --delete -e ssh \S+\/ hydra@203\.0\.113\.7:hydra-brain\/$/);
  assert.equal(log[1], 'ssh hydra@203.0.113.7 bash -s');
  const remote = fs.readFileSync(path.join(bin, 'remote.sh'), 'utf8');
  assert.equal(spawnSync('bash', ['-n', path.join(bin, 'remote.sh')]).status, 0, 'the remote script is valid bash');
  const remoteCode = remote.split('\n').filter((l) => !l.trim().startsWith('#'));
  assert.ok(!remoteCode.some((l) => /\bnpm\b|\bnpx\b|github|curl |wget /.test(l)), 'nothing is installed or fetched on the server');
  const sudo = remoteCode.filter((l) => /\bsudo\b/.test(l) && !l.startsWith('nosudo() { echo'));
  assert.equal(sudo.length, 4);
  assert.ok(sudo.every((l) => /^sudo -n (install -m 644 -o root -g root "\$HOME\/hydra-brain\/hydra-brain\.service" \/etc\/systemd\/system\/hydra-brain\.service|systemctl (daemon-reload|enable hydra-brain\.service|restart hydra-brain\.service)) \|\| nosudo$/.test(l)), 'sudo -n, only for the unit file and systemctl');
  assert.match(remote, /\[ "\$\(id -un\)" = hydra \]/, 'the server side checks it runs as hydra too');
  assert.match(remote, /export CLAUDE_CONFIG_DIR="\$HOME\/\.claude"/, "the owner's login shell keeps Claude Code's files in ~/.claude");
  fs.rmSync(alone, { recursive: true, force: true });
}

server.close();
console.log('brainserver: ok');
