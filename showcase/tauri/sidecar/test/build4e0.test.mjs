// Desktop build 4, round 2 low findings (lane E unit E0) as behavior tests with fakes. Each block fails without its fix.
// Run: npm test (temp home, the shared fake helper fakehands.mjs, fake Claude Code, and fake open/osascript/screencapture
// /sips first on PATH, so nothing here can reach the real Mac).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { ClaudeCodeAgent } from '../claudecode.mjs';
import { INPUT_PREFIX, relaySession } from '../relay.mjs';
import { fakeHands } from './fakehands.mjs';

const HOME = fs.realpathSync.native(os.homedir());
assert.ok(HOME.includes('roamies-test-') || HOME.startsWith(fs.realpathSync.native(os.tmpdir())), 'runs only with a temp home');
delete process.env.ROAMIES_FORWARD;
const later = (ms = 15) => new Promise((r) => setTimeout(r, ms));
const ev = (event, stamp) => ({ type: 'stream_event', parent_tool_use_id: null, event, ...(stamp ? { user_message_uuid: stamp.at(-1), user_message_uuids: stamp } : {}) });
const look = { name: 'look', description: 'Look.', parameters: z.object({}), execute: async () => 'ok' };

// ---- E0-4: words added after a tool round's result went back, but before the next message started, then Stop. Claude
// Code had built that next request already, so the message that starts is the head's next step, not their answer:
// they're named. The fake calls our real in-process MCP bridge, so the hand-back clock runs as in the app.
{
  const WORDS = `${INPUT_PREFIX}and mute the sound`;
  async function run(when) {
    const ctl = new AbortController();
    let a = null;
    const query = ({ prompt, options }) => {
      const it = prompt[Symbol.asyncIterator]();
      const server = options.mcpServers.roamies ?? Object.values(options.mcpServers)[0];
      const pending = new Map();
      const transport = { send: async (m) => { pending.get(m.id)?.(m); }, start: async () => {} };
      server.instance.connect(transport);
      const call = (id, method, params) => new Promise((r) => { pending.set(id, r); transport.onmessage({ jsonrpc: '2.0', id, method, params }); });
      let stopped = false;
      const add = async () => { a.addInput(WORDS); await it.next(); };
      const gen = async function* () {
        const first = (await it.next()).value;
        yield { type: 'system', subtype: 'init', session_id: 's1' };
        yield ev({ type: 'message_start', message: { id: 'm1', usage: {} } }, [first.uuid]);
        yield { type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', model: 'c', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu1', name: 'mcp__roamies__look', input: {} }] } };
        yield ev({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: {} });
        yield ev({ type: 'message_stop' });
        if (when === 'round') await add();
        await call(1, 'tools/call', { name: 'look', arguments: {}, _meta: { 'claudecode/toolUseId': 'tu1' } });
        yield { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] } };
        if (when === 'handed') await add();
        await later();
        yield ev({ type: 'message_start', message: { id: 'm2', usage: {} } });
        yield ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Still looking' } });
        if (when === 'late') { await later(); await add(); }
        await later();
        ctl.abort();
        while (!stopped) await later(5);
        yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: [], usage: {} };
      };
      return Object.assign(gen(), { interrupt: async () => { stopped = true; }, close: () => { stopped = true; } });
    };
    a = new ClaudeCodeAgent({ model: 'm', system: 's', tools: [look], executable: '/bin/claude', cwd: '/', env: {}, signal: ctl.signal, query, onRateLimit: () => {} });
    let thrown = null;
    try { for await (const e of a.prompt('tidy my desktop')) void e; } catch (e) { thrown = e.message; }
    return { thrown, left: a.unanswered() };
  }
  // Folded into the round's next message: that message takes it in, so it isn't named.
  assert.deepEqual(await run('round'), { thrown: null, left: [] });
  // After the hand-back, before the next message: named.
  assert.deepEqual(await run('handed'), { thrown: null, left: [WORDS] }, 'words sent after the round went back are named on Stop');
  // After the next message started: named, as before.
  assert.deepEqual(await run('late'), { thrown: null, left: [WORDS] });
  // A turn that ended after the words, then one that started (their own turn), then Stop: not named.
  {
    const ctl = new AbortController();
    let a = null, stopped = false;
    const query = ({ prompt }) => {
      const it = prompt[Symbol.asyncIterator]();
      const gen = async function* () {
        const first = (await it.next()).value;
        yield ev({ type: 'message_start', message: { id: 'm1', usage: {} } });
        await later(); a.addInput(WORDS); await it.next();
        yield ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} });
        yield { type: 'result', subtype: 'success', is_error: false, result: '', usage: {} };
        await later();
        yield ev({ type: 'message_start', message: { id: 'm2', usage: {} } });
        yield ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Muting' } });
        await later(); ctl.abort();
        while (!stopped) await later(5);
        yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: [], usage: {} };
        void first;
      };
      return Object.assign(gen(), { interrupt: async () => { stopped = true; }, close: () => { stopped = true; } });
    };
    a = new ClaudeCodeAgent({ model: 'm', system: 's', tools: [look], executable: '/bin/claude', cwd: '/', env: {}, signal: ctl.signal, query, onRateLimit: () => {} });
    for await (const e of a.prompt('tidy my desktop')) void e;
    assert.deepEqual(a.unanswered(), [], 'its own turn had started');
  }
}

// ---- E0-6: a carried run's words named and forgotten, then said again word for word: a fresh Claude Code session (the
// one forgotten may hold them), as with any other words.
{
  const step = function* (text, stamp) {
    yield ev({ type: 'message_start', message: { id: `m${text.length}`, usage: {} } }, stamp);
    yield ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
    yield { type: 'assistant', parent_tool_use_id: null, message: { id: `m${text.length}`, model: 'c', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] } };
    yield ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} });
  };
  const ok = (text) => async function* (it, first, sid) { yield { type: 'system', subtype: 'init', session_id: sid }; yield* step(text, [first.uuid]); yield { type: 'result', subtype: 'success', is_error: false, result: '', usage: {}, user_message_uuid: first.uuid, user_message_uuids: [first.uuid] }; };
  const initOnly = async function* (it, first, sid) { yield { type: 'system', subtype: 'init', session_id: sid }; };
  async function session(holds) {
    const runs = [ok('Desktop is clean.'), initOnly, ok('Trash emptied.')];
    let k = 0;
    const resumes = [], saved = [];
    const query = ({ prompt, options }) => {
      const it = prompt[Symbol.asyncIterator](), n = k++;
      resumes.push(options?.resume ?? null);
      const sid = options?.resume ?? `sess-${n + 1}`;
      const gen = async function* () { const first = (await it.next()).value; yield* runs[n](it, first, sid); };
      return Object.assign(gen(), { interrupt: async () => {}, close: () => {} });
    };
    const agent = new ClaudeCodeAgent({ model: 'm', system: 's', tools: [look], executable: '/bin/claude', cwd: '/', env: {}, query, onRateLimit: () => {}, onResume: (s) => saved.push(s) });
    const queue = [...holds];
    await relaySession({ agent, text: 'clean up my desktop', h: { emit: () => {}, signal: new AbortController().signal, onInput: () => {}, done: async () => queue.shift() ?? [] } });
    return { runs: k, resumes, saved: saved.map((s) => s?.sessionId ?? null) };
  }
  const same = await session([['and empty the trash'], ['and empty the trash']]);
  assert.deepEqual(same.resumes, [null, 'sess-1', null], `said again word for word: not resumed ${JSON.stringify(same)}`);
  // The saved state forgets it too (a rebuilt agent would otherwise resume it).
  assert.deepEqual(same.saved, ['sess-1', 'sess-1', null, 'sess-3']);
  assert.deepEqual((await session([['and empty the trash'], ['empty the trash please']])).resumes, [null, 'sess-1', null]);
}

if (process.platform === 'darwin') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-e0-'));
  const bin = path.join(dir, 'bin'), launched = path.join(dir, 'launched.log');
  fs.mkdirSync(bin);
  for (const c of ['open', 'osascript', 'screencapture', 'sips']) fs.writeFileSync(path.join(bin, c), `#!/bin/sh\necho ${c} "$@" >> '${launched}'\nexit 1\n`, { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  const fake = fakeHands(dir);
  const { createTools } = await import('../tools.mjs');
  const asks = [];
  let remote = false, answer = () => 'Allow';
  const t = createTools({ remote: () => remote, allowActions: () => true, ui: () => {}, ask: async (o) => { asks.push(o.placeholder); return answer(o.placeholder); }, openUrl: async () => {}, onCommitments: () => {}, showList: () => {}, fmtWhen: String, commitmentsText: () => '', userName: 'Test', workdir: HOME, skills: { changed: () => {} } });
  const T = (n) => t.tools.find((x) => x.name === n);
  const reset = (st, relay, ans = () => 'Allow') => { fake.clear(); asks.length = 0; answer = ans; remote = relay; fake.set(st); t.nextTurn(); };
  const said = (p) => p.then((x) => String(x?.content?.[0]?.text ?? x), (e) => String(e?.message ?? e));
  const unhid = () => fake.calls().filter((c) => c[0] === 'UNHIDE').map((c) => c[1]);
  const managed = () => fake.calls().filter((c) => c[0] === 'MANAGE').map((c) => c.slice(1));
  const specs = () => fake.calls().filter((c) => c[0] === 'manage').map((c) => JSON.parse(c[1]));
  const helper = (...a) => JSON.parse(execFileSync(process.execPath, [process.env.ROAMIES_HANDS, ...a], { encoding: 'utf8' }));

  // ---- E0-1 / E0-5: two running apps share a name (Xcode and Xcode-beta), the second in front. manage_app with no app
  // asks about the one in front and sends its pid, so the helper acts on that very process, even when the other one
  // comes to the front while the question is up; with an app, resolve's pick by its pid.
  const old = { id: 1, pid: 10, app: 'Xcode', title: 'Old project', text: 'x' }, beta = { id: 2, pid: 20, app: 'Xcode', title: 'Beta project', text: 'x' };
  const twins = { frontPid: 20, running: [{ app: 'Xcode', pid: 10 }, { app: 'Xcode', pid: 20 }], wins: [beta, old] };
  for (const relay of [false, true]) {
    reset(twins, relay, () => { fake.set({ ...twins, frontPid: 10, wins: [old, beta] }); return 'Allow'; });
    const r = await said(T('manage_app').execute({ do: 'force_quit' }, {}));
    assert.deepEqual(asks, ['Force quit Xcode?', 'Force quitting Xcode loses anything unsaved. Force quit anyway?'], `${relay}: ${r}`);
    assert.deepEqual(specs().map((s) => s.pid), [20, 20], `the process in front when it asked: ${JSON.stringify(specs())}`);
    assert.equal(r, 'Done: force quit Xcode.');
    reset(twins, relay);
    await said(T('manage_app').execute({ do: 'quit', app: 'Xcode' }, {}));
    assert.deepEqual(specs().map((s) => [s.app, s.pid, s.exact]), [['Xcode', 10, true]], 'resolve\'s pick, by its pid');
  }
  // The helper acts on that pid only while it has that name; gone or another app now, nothing.
  fake.set(twins); fake.clear();
  assert.deepEqual(helper('front'), { ok: true, app: 'Xcode', pid: 20, title: 'Beta project' });
  assert.deepEqual(helper('resolve', 'app:Xcode'), { ok: true, window: { id: 2, app: 'Xcode', title: 'Beta project', bounds: [0, 0, 800, 600] }, running: 'Xcode', runningPid: 10 });
  assert.equal(helper('manage', JSON.stringify({ do: 'hide', app: 'Xcode', exact: true, pid: 20 })).ok, true);
  assert.equal(helper('manage', JSON.stringify({ do: 'hide', app: 'Xcode', exact: true, pid: 30 })).error, "Xcode isn't open.");
  assert.equal(helper('manage', JSON.stringify({ do: 'hide', app: 'Safari', exact: true, pid: 20 })).error, "Safari isn't open.");
  assert.deepEqual(managed(), [['hide', 'Xcode']]);

  // ---- E0-3: the fake's 'front' is main.swift's: the front app even with no window on screen (Finder often), the first
  // window's app only when none is known in front. So manage_app with no app names Finder, as the Mac would.
  const fin = { id: 1, pid: 10, app: 'Finder', title: '', text: 'x', listed: false }, saf = { id: 2, pid: 20, app: 'Safari', title: 'Bank', text: 'x' };
  fake.set({ frontPid: 10, running: ['Finder', 'Safari'], wins: [fin, saf] });
  assert.deepEqual(helper('front'), { ok: true, app: 'Finder', pid: 10 });
  fake.set({ running: ['Finder', 'Safari'], wins: [fin, saf] });
  assert.deepEqual(helper('front'), { ok: true, app: 'Safari', pid: 20, title: 'Bank' });
  reset({ frontPid: 10, running: ['Finder', 'Safari'], wins: [fin, saf] }, false, () => "Don't allow");
  await said(T('manage_app').execute({ do: 'hide' }, {}));
  assert.deepEqual(asks, ['Hide Finder?']);
  // JSONSerialization drops one leading U+FEFF from a spec's strings (main.swift); serde keeps it (hands-win).
  fake.set({ running: ['Notes'], wins: [] }); fake.clear();
  assert.equal(helper('manage', JSON.stringify({ do: 'hide', app: '\uFEFFNotes', exact: true })).ok, true);
  assert.equal(helper('manage', JSON.stringify({ do: 'hide', app: '\uFEFF\uFEFFNotes', exact: true })).ok, false);
  const pad = { id: 5, pid: 50, app: 'Notepad', exe: 'notepad', title: 'Doc', text: 'x' };
  fake.set({ win: true, wins: [pad] });
  assert.equal(helper('manage', JSON.stringify({ do: 'hide', app: '\uFEFFNotepad', exact: true })).ok, false, 'serde keeps U+FEFF');
  // hands-win trims as Rust's str::trim: U+0085 off, U+FEFF kept.
  assert.equal(helper('resolve', 'app:\u0085Note').window?.app, 'Notepad');
  assert.equal(helper('resolve', 'app:\uFEFFNote').window, undefined);

  // ---- E0-2: a bring-forward yes act_in_app asked for and never used (it stopped before its first helper call) ends
  // with that call: after a hide said yes to, a screenshot of that app asks again before it comes forward.
  const LOOK = 'Bring Notes forward and look at its window? It has no window on screen now.';
  for (const relay of [false, true]) {
    reset({ frontPid: 10, hidden: ['Notes'], wins: [{ ...fin, listed: true, title: 'Downloads' }, { id: 3, pid: 30, app: 'Notes', title: 'Doc', text: 'x' }] }, relay, (q) => (q === LOOK ? "Don't allow" : 'Allow'));
    const a = await said(T('act_in_app').execute({ target: 'Notes', steps: [{ do: 'click_at', x: 10, y: 10 }] }, {}));
    assert.match(a, /screenshot first/i);
    assert.match(await said(T('manage_app').execute({ do: 'hide', app: 'Notes' }, {})), /^Done: hid Notes/);
    const s = await said(T('take_screenshot').execute({ target: 'Notes' }, {}));
    assert.deepEqual([asks, unhid()], [['Bring Notes forward? It has no window on screen now.', 'Hide Notes?', LOOK], []], `${relay}: ${s}`);
    // No hide in between: the unused yes still ended with its call, so the screenshot asks before anything comes forward.
    reset({ frontPid: 10, hidden: ['Notes'], wins: [{ ...fin, listed: true, title: 'Downloads' }, { id: 3, pid: 30, app: 'Notes', title: 'Doc', text: 'x' }] }, relay, (q) => (q === LOOK ? "Don't allow" : 'Allow'));
    await said(T('act_in_app').execute({ target: 'Notes', steps: [{ do: 'click_at', x: 10, y: 10 }] }, {}));
    const s2 = await said(T('take_screenshot').execute({ target: 'Notes' }, {}));
    assert.deepEqual([asks, unhid()], [['Bring Notes forward? It has no window on screen now.', LOOK], []], `${relay}: ${s2}`);
  }
  assert.ok(!fs.existsSync(launched), `nothing launched: ${fs.existsSync(launched) ? fs.readFileSync(launched, 'utf8') : ''}`);
}
console.log('build4 e0: ok');
