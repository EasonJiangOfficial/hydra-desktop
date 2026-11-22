// Desktop build 4, second review: the findings as behavior tests with fakes. Each block fails without its fix.
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

// ---- Words named unanswered are never sent again. A carried run that ends with no output at all (Claude Code exits 0
// with nothing) left its words with no reply in the history, so the next run's first message took them again and
// answered them after the owner was told to say them again. Claude Code here sends init, stream events and the full
// assistant messages, as the SDK does.
{
  const UNSAID = '\n(I could not answer what you added in this turn. Say it again.)\n';
  const A = 'and empty the trash', B = 'and lock the screen';
  const ev = (event, stamp) => ({ type: 'stream_event', parent_tool_use_id: null, event, ...(stamp ? { user_message_uuid: stamp.at(-1), user_message_uuids: stamp } : {}) });
  let mid = 0;
  const step = function* (text, stop, stamp) {
    const id = `msg_${++mid}`;
    yield ev({ type: 'message_start', message: { id, usage: {} } }, stamp);
    yield ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
    yield { type: 'assistant', parent_tool_use_id: null, message: { id, model: 'claude', role: 'assistant', stop_reason: stop, content: [{ type: 'text', text }] } };
    yield ev({ type: 'message_delta', delta: { stop_reason: stop }, usage: {} });
    yield ev({ type: 'message_stop' });
  };
  const init = { type: 'system', subtype: 'init', session_id: 'sess-1' };
  const ok = (text) => async function* (it, first) { yield init; yield* step(text, 'end_turn', [first.uuid]); yield { type: 'result', subtype: 'success', is_error: false, result: '', usage: {}, user_message_uuid: first.uuid, user_message_uuids: [first.uuid] }; };
  const look = { name: 'look', description: 'Look.', parameters: z.object({}), execute: async () => 'ok' };
  async function session(runs, holds) {
    let k = 0;
    const ref = {}, prompts = [], resumes = [];
    const query = ({ prompt, options }) => {
      const it = prompt[Symbol.asyncIterator](), n = k++;
      resumes.push(options?.resume ?? null);
      const gen = async function* () { const first = (await it.next()).value; prompts.push(first.message.content.map((p) => p.text).join('\n')); yield* runs[n](it, first, ref); };
      return Object.assign(gen(), { interrupt: async () => {}, close: () => {} });
    };
    ref.a = new ClaudeCodeAgent({ model: 'm', system: 's', tools: [look], executable: '/bin/claude', cwd: '/', env: {}, query, onRateLimit: () => {} });
    const events = [], queue = [...holds];
    const h = { emit: (e) => events.push(e), signal: new AbortController().signal, onInput: () => {}, done: async () => queue.shift() ?? [] };
    let thrown = null;
    try { await relaySession({ agent: ref.a, text: 'clean up my desktop', h }); } catch (e) { thrown = e.message; }
    return { runs: k, thrown, prompts, resumes, notes: events.filter((e) => e.type === 'text' && e.delta === UNSAID).length };
  }
  // Run 2 takes A (held at done); the owner adds B while it works, and Claude Code then ends with no output: A is
  // named, B is carried into run 3, which answers it. Run 3 is sent B alone, never A again.
  const addB = async function* (it, first, ref) { await new Promise((r) => setTimeout(r, 10)); ref.a.addInput(`${INPUT_PREFIX}${B}`); await it.next(); };
  let s = await session([ok('Desktop is clean.'), addB, ok('Screen locked.')], [[A]]);
  assert.deepEqual([s.runs, s.thrown, s.notes], [3, null, 1], JSON.stringify(s));
  assert.ok(s.prompts[1].includes(A) && s.prompts[2].includes(B), JSON.stringify(s.prompts));
  assert.ok(!s.prompts[2].includes(A), `A was named unanswered, so it is never sent again: ${JSON.stringify(s.prompts)}`);
  // Its Claude Code session isn't resumed either: it may hold A.
  assert.deepEqual(s.resumes, [null, 'sess-1', null]);
  // The same with B held at done after a run 2 that just ends.
  s = await session([ok('Desktop is clean.'), async function* () {}, ok('Screen locked.')], [[A], [B]]);
  assert.deepEqual([s.runs, s.thrown, s.notes], [3, null, 1], JSON.stringify(s));
  assert.ok(s.prompts[2].includes(B) && !s.prompts[2].includes(A), JSON.stringify(s.prompts));
  // An answered carried run keeps its words (they have their reply): nothing named, B sent alone.
  s = await session([ok('Desktop is clean.'), ok('Trash emptied.'), ok('Screen locked.')], [[A], [B]]);
  assert.deepEqual([s.runs, s.thrown, s.notes, s.resumes], [3, null, 0, [null, 'sess-1', 'sess-1']], JSON.stringify(s));
  assert.ok(s.prompts[2].endsWith(B) && !s.prompts[2].includes(A), JSON.stringify(s.prompts));
}

if (['darwin', 'win32'].includes(process.platform)) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-12b-'));
  const bin = path.join(dir, 'bin'), launched = path.join(dir, 'launched.log');
  fs.mkdirSync(bin);
  for (const c of ['open', 'osascript', 'screencapture', 'sips']) fs.writeFileSync(path.join(bin, c), `#!/bin/sh\necho ${c} "$@" >> '${launched}'\nexit 1\n`, { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  const fake = fakeHands(dir);
  const { createTools } = await import('../tools.mjs');
  const asks = [];
  let remote = true, answer = () => 'Allow';
  const t = createTools({ remote: () => remote, allowActions: () => true, ui: (msg) => { if (msg?.e?.type === 'draw') setTimeout(() => t.ink.started(msg.e.id, msg.e.seg), 5); }, ask: async (o) => { asks.push(o.placeholder); return answer(o.placeholder); }, openUrl: async () => {}, onCommitments: () => {}, showList: () => {}, fmtWhen: String, commitmentsText: () => '', userName: 'Test', workdir: HOME, skills: { changed: () => {} } });
  const T = (n) => t.tools.find((x) => x.name === n);
  const reset = (st, relay, ans = () => 'Allow') => { fake.clear(); asks.length = 0; answer = ans; remote = relay; fake.set(st); t.nextTurn(); };
  const said = (p) => p.then((x) => String(x?.content?.[0]?.text ?? x), (e) => String(e?.message ?? e));
  const unhid = () => fake.calls().filter((c) => c[0] === 'UNHIDE').map((c) => c[1]);
  const managed = () => fake.calls().filter((c) => c[0] === 'MANAGE').map((c) => c.slice(1));
  const helper = (env, ...a) => JSON.parse(execFileSync(process.execPath, [process.env.ROAMIES_HANDS, ...a], { encoding: 'utf8', env: { ...process.env, ...env } }));
  const fin = { id: 1, pid: 10, app: 'Finder', title: 'Downloads', text: 'x' };
  const saf = { id: 2, pid: 20, app: 'Safari', title: 'Bank', text: 'x' };
  const notes = { id: 3, pid: 30, app: 'Notes', title: 'Groceries', text: 'milk' };

  // ---- manage_app with no app and no window acts on the app its question named, the one in front when it asked,
  // never on the app that came to the front while the question was up (a relay approval on the phone takes a while).
  if (process.platform === 'darwin') {
    for (const relay of [true, false]) {
      for (const [what, q, did] of [
        ['hide', 'Hide Safari?', 'hide'], ['minimize', 'Minimize the window of Safari?', 'minimize'], ['close', 'Close the window of Safari?', 'close'],
        ['quit', 'Quit Safari?', 'quit'], ['switch', 'Bring forward Safari?', 'activate'], ['arrange', 'Arrange (left) the window of Safari?', 'arrange'],
      ]) {
        reset({ frontPid: 20, wins: [saf, fin] }, relay, () => { fake.set({ frontPid: 10, wins: [saf, fin] }); return 'Allow'; });
        const r = await said(T('manage_app').execute({ do: what, ...(what === 'arrange' ? { layout: 'left' } : {}) }, {}));
        assert.deepEqual([asks, managed()], [[q], [[did, 'Safari']]], `${relay} ${what}: ${r}`);
      }
      // Safari quit while the question was up: nothing is acted on (not Finder, now in front).
      reset({ frontPid: 20, wins: [saf, fin] }, relay, () => { fake.set({ frontPid: 10, running: ['Finder'], wins: [fin] }); return 'Allow'; });
      const r = await said(T('manage_app').execute({ do: 'hide' }, {}));
      assert.deepEqual([asks, managed()], [['Hide Safari?'], []], `${relay}: ${r}`);
      assert.match(r, /Safari isn't open/);
      // No app in front: said so, nothing asked or acted on.
      reset({ wins: [], running: [] }, relay);
      assert.match(await said(T('manage_app').execute({ do: 'quit' }, {})), /No app is in front/);
      assert.deepEqual([asks, managed()], [[], []]);
    }
  }

  // ---- One bring-forward yes brings the app forward once. Brought forward after a yes, hidden (or minimised) again,
  // then needed again in the same request: asked again, and a no leaves it hidden. The helper itself brings it forward
  // at most once a run, even when it looks for the window again (act does).
  for (const win of [false, true]) {
    const st = { win, frontPid: 10, hidden: ['Notes'], wins: [fin, notes] };
    fake.clear(); fake.set(st);
    const plan = JSON.stringify({ app: 'Notes', steps: [] });
    assert.equal(helper({ ROAMIES_FORWARD: 'Notes' }, 'act', plan).window.app, 'Notes', `${win}`);
    assert.deepEqual(unhid(), ['Notes'], `${win}: one run, one bring-forward`);
    const LOOK = 'Bring Notes forward and look at its window? It has no window on screen now.';
    for (const relay of [true, false]) {
      for (const second of ['Allow', "Don't allow"]) {
        let n = 0;
        reset(st, relay, (q) => (q === LOOK ? (++n === 1 ? 'Allow' : second) : 'Allow'));
        await said(T('read_window').execute({ target: 'Notes' }, {}));
        assert.deepEqual([asks, unhid()], [[LOOK], ['Notes']], `${win} ${relay}`);
        fake.set({ ...fake.get(), hidden: ['Notes'] }); // hidden again (a hide said yes to, or the owner)
        const r = await said(T('take_screenshot').execute({ target: 'Notes' }, {}));
        assert.deepEqual(asks, [LOOK, LOOK], `${win} ${relay} ${second}: asked again before it comes forward again: ${r}`);
        if (second === 'Allow') assert.deepEqual(unhid(), ['Notes', 'Notes'], `${win} ${relay}: ${r}`);
        else {
          assert.deepEqual(unhid(), ['Notes'], `${win} ${relay}: a no leaves it hidden: ${r}`);
          assert.match(r, /Test said no, so I didn't bring Notes forward\.$/);
        }
      }
    }
  }
  // Running with no window at all, as Notes often is on a Mac: each time it's brought forward has its own yes.
  if (process.platform === 'darwin') {
    const BRING = /^Bring Notes forward( and look at its window)?\? It has no window on screen now\.$/;
    for (const relay of [true, false]) {
      for (const [name, run] of [
        ['act_in_app', () => said(T('act_in_app').execute({ target: 'Notes', steps: [{ do: 'type', text: 'hi' }] }, {}))],
        ['draw', () => said(T('draw').execute({ target: 'Notes', beats: [{ say: 'Here.', marks: [{ kind: 'ring', at: { text: 'x' } }] }] }, { toolCallId: 'd1' }))],
      ]) {
        let n = 0;
        reset({ frontPid: 10, running: ['Finder', 'Notes'], wins: [fin] }, relay, (q) => (BRING.test(q) ? (++n === 1 ? 'Allow' : "Don't allow") : q.startsWith('Open ') ? "Don't allow" : 'Allow'));
        const r = await run();
        assert.deepEqual(unhid(), ['Notes'], `${relay} ${name}: brought forward once, for its one yes: ${JSON.stringify(asks)} ${r}`);
        assert.equal(asks.filter((q) => BRING.test(q)).length, 2, `${relay} ${name}: the second need asked: ${JSON.stringify(asks)}`);
      }
    }
  }

  // ---- The fake trims names as main.swift does (.whitespaces holds U+200B; its self-test checks it), so the app a
  // test's question names is the helper's own pick.
  fake.clear(); fake.set({ frontPid: 20, running: ['Safari', 'Notes'], wins: [saf] });
  assert.equal(helper({}, 'resolve', 'app:Note​').running, 'Notes');
  assert.equal(helper({}, 'resolve', 'app:Browser​').running, 'Safari');
  for (const relay of [true, false]) {
    reset({ frontPid: 10, hidden: ['Notes'], wins: [fin, notes] }, relay, () => "Don't allow");
    const r = await said(T('read_window').execute({ target: 'Note​' }, {}));
    assert.deepEqual([asks, unhid()], [['Bring Notes forward and look at its window? It has no window on screen now.'], []], `${relay}: ${r}`);
  }

  assert.ok(!fs.existsSync(launched), `nothing launched: ${fs.existsSync(launched) ? fs.readFileSync(launched, 'utf8') : ''}`);
}
console.log('twelfthb: ok');
