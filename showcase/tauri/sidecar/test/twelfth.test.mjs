// Desktop build 4 (B4-1..B4-7): the carried findings as behavior tests with fakes. Each block fails without its fix.
// Run: npm test (temp home, the shared fake helper fakehands.mjs, fake Claude Code, and fake open/osascript/screencapture
// first on PATH, so nothing here can reach the real Mac).
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

// ---- B4-4..B4-7: every carried addition (missed at max turns, or held at done) is named once for each run that didn't
// answer it (max turns, a stream that just ends), and never for a run that did, whatever came before in the turn.
{
  const UNSAID = '\n(I could not answer what you added in this turn. Say it again.)\n';
  const ev = (event, stamp) => ({ type: 'stream_event', parent_tool_use_id: null, event, ...(stamp ? { user_message_uuid: stamp.at(-1), user_message_uuids: stamp } : {}) });
  const step = (text, stop, stamp) => [ev({ type: 'message_start', message: { usage: {} } }, stamp), ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }), ev({ type: 'message_delta', delta: { stop_reason: stop }, usage: {} }), ev({ type: 'message_stop' })];
  const result = (ok, uuids) => (ok ? { type: 'result', subtype: 'success', is_error: false, result: '', usage: {}, user_message_uuid: uuids.at(-1), user_message_uuids: uuids }
    : { type: 'result', subtype: 'error_max_turns', is_error: true, errors: [], usage: {}, user_message_uuid: uuids.at(-1), user_message_uuids: uuids });
  const later = () => new Promise((r) => setTimeout(r, 20));
  const look = { name: 'look', description: 'Look.', parameters: z.object({}), execute: async () => 'ok' };
  // A run's script: (it: Claude Code's input, first: its first message, ref) → what Claude Code streams.
  const ok = (text) => async function* (it, first) { yield* step(text, 'end_turn', [first.uuid]); yield result(true, [first.uuid]); };
  const maxed = async function* (it, first) { yield* step('Working on it.', 'tool_use', [first.uuid]); yield result(false, [first.uuid]); };
  const plainEnd = async function* () {}; // Claude Code exited 0 with no result (getProcessExitError: nothing for code 0)
  // Run 1 cut by max turns after the owner added A: A is missed and carried into run 2.
  const missA = async function* (it, first, ref) {
    yield* step('Looking.', 'tool_use', [first.uuid]);
    await later();
    ref.a.addInput(`${INPUT_PREFIX}and empty the trash`);
    const A = (await it.next()).value;
    yield* step('Emptying.', 'tool_use', [A.uuid]);
    yield result(false, [first.uuid, A.uuid]);
  };
  async function session(runs, holds) {
    let k = 0;
    const ref = {}, prompts = [];
    const query = ({ prompt }) => {
      const it = prompt[Symbol.asyncIterator](), n = k++;
      const gen = async function* () { const first = (await it.next()).value; prompts.push(first.message.content.map((p) => p.text).join('')); yield* runs[n](it, first, ref); };
      return Object.assign(gen(), { interrupt: async () => {}, close: () => {} });
    };
    ref.a = new ClaudeCodeAgent({ model: 'm', system: 's', tools: [look], executable: '/bin/claude', cwd: '/', env: {}, query, onRateLimit: () => {} });
    const events = [], queue = [...holds];
    const h = { emit: (e) => events.push(e), signal: new AbortController().signal, onInput: () => {}, done: async () => queue.shift() ?? [] };
    let thrown = null;
    try { await relaySession({ agent: ref.a, text: 'clean up my desktop', h }); } catch (e) { thrown = e.message; }
    return { runs: k, thrown, prompts, notes: events.filter((e) => e.type === 'text' && e.delta === UNSAID).length };
  }

  // B4-4: A and then B, each held at done, each run cut by max turns: both named, not only the first.
  let s = await session([ok('Cleaned the desktop.'), maxed, maxed], [['and empty the trash'], ['and delete the old draft too']]);
  assert.deepEqual([s.runs, s.thrown, s.notes], [3, null, 2], `B4-4: ${JSON.stringify(s)}`);
  // B4-6: the same with an answered run between the two cut ones (A cut, B answered, C cut): A and C both named.
  s = await session([ok('Desktop is clean.'), maxed, ok('It is 3 pm.'), maxed], [['and delete the old draft too'], ['what time is it'], ['also empty the trash']]);
  assert.deepEqual([s.runs, s.thrown, s.notes], [4, null, 2], `B4-6: ${JSON.stringify(s)}`);
  assert.ok(s.prompts[3].endsWith('also empty the trash'), s.prompts[3]);
  // B4-5: the carried run's stream just ends (no result, no error), held at done or missed at max turns: named.
  for (const [mode, runs, holds] of [['held', [ok('Done.'), plainEnd], [['and delete the old draft too']]], ['missed', [missA, plainEnd], []]]) {
    s = await session(runs, holds);
    assert.deepEqual([s.runs, s.thrown, s.notes], [2, null, 1], `B4-5 ${mode}: ${JSON.stringify(s)}`);
  }
  // ... but a stream that ends right after the carried words' final answer answered them: not named.
  s = await session([ok('Done.'), async function* (it, first) { yield* step('The draft is gone.', 'end_turn', [first.uuid]); }], [['and delete the old draft too']]);
  assert.deepEqual([s.runs, s.thrown, s.notes], [2, null, 0], `answered, then a plain end: ${JSON.stringify(s)}`);
  // B4-7: the carried words get a full answer (a success result naming them); a later addition B gets its own turn in
  // that run, which max turns cuts, and B is answered in run 3. Nothing is named: the owner isn't told to say again
  // what was done already.
  const answeredThenB = async function* (it, first, ref) {
    yield* step('The old draft is in the Trash now.', 'end_turn', [first.uuid]);
    await later();
    ref.a.addInput(`${INPUT_PREFIX}what time is it`);
    const B = (await it.next()).value;
    yield result(true, [first.uuid]);
    yield* step('Checking the clock.', 'tool_use', [B.uuid]);
    yield result(false, [B.uuid]);
  };
  s = await session([ok('Desktop is clean.'), answeredThenB, ok('It is 3 pm.')], [['and delete the old draft too']]);
  assert.deepEqual([s.runs, s.thrown, s.notes], [3, null, 0], `B4-7: ${JSON.stringify(s)}`);
  assert.ok(s.prompts[2].endsWith('what time is it'), 'B was carried into run 3 and answered there');
}

if (['darwin', 'win32'].includes(process.platform)) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-12-'));
  const bin = path.join(dir, 'bin'), launched = path.join(dir, 'launched.log');
  fs.mkdirSync(bin);
  for (const c of ['open', 'osascript', 'screencapture', 'sips']) fs.writeFileSync(path.join(bin, c), `#!/bin/sh\necho ${c} "$@" >> '${launched}'\nexit 1\n`, { mode: 0o755 });
  // A fake 'open' for one case: it only puts the state in opens.json in the fake helper's place (an app that started,
  // with no window yet), and says what it was asked. Nothing real is opened.
  const opens = path.join(dir, 'opens.json'), opened = path.join(dir, 'opened.log');
  fs.writeFileSync(path.join(bin, 'open'), `#!/bin/sh\nif [ -f '${opens}' ]; then echo "$@" >> '${opened}'; cp '${opens}' "$FAKEHANDS_STATE"; exit 0; fi\necho open "$@" >> '${launched}'\nexit 1\n`, { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  const fake = fakeHands(dir);
  const { createTools } = await import('../tools.mjs');
  const asks = [];
  let remote = true, answer = () => 'Allow';
  const t = createTools({ remote: () => remote, allowActions: () => true, ui: () => {}, ask: async (o) => { asks.push(o.placeholder); return answer(o.placeholder); }, openUrl: async () => {}, onCommitments: () => {}, showList: () => {}, fmtWhen: String, commitmentsText: () => '', userName: 'Test', workdir: HOME, skills: { changed: () => {} } });
  const T = (n) => t.tools.find((x) => x.name === n);
  const reset = (st, relay, ans = () => 'Allow') => { fake.clear(); asks.length = 0; answer = ans; remote = relay; fake.set(st); t.nextTurn(); };
  const said = (p) => p.then((x) => String(x?.content?.[0]?.text ?? x), (e) => String(e?.message ?? e));
  const unhid = () => fake.calls().filter((c) => c[0] === 'UNHIDE').map((c) => c[1]);
  const managed = () => fake.calls().filter((c) => c[0] === 'MANAGE').map((c) => c.slice(1));
  const helper = (env, ...a) => JSON.parse(execFileSync(process.execPath, [process.env.ROAMIES_HANDS, ...a], { encoding: 'utf8', env: { ...process.env, ...env } }));
  const no = () => "Don't allow";

  // ---- B4-1: Finder on screen, Mail running hidden, the app asked for "Finder‍ Mail". main.swift compares by
  // grapheme cluster: Finder's window isn't one it finds, and Mail is the app it would bring forward. The question
  // names Mail (the helper's own pick, resolve) before anything is brought forward; a no leaves Mail hidden; a yes
  // brings Mail forward once, with no second question about looking. On this Mac and in a relay turn alike.
  const JOINED = 'Finder‍ Mail';
  const finder = { id: 1, pid: 10, app: 'Finder', title: 'Downloads', text: 'x' };
  const mail = { id: 2, pid: 20, app: 'Mail', title: 'Inbox', text: 'Inbox\nBank statement' };
  const mailHidden = { frontPid: 10, hidden: ['Mail'], wins: [finder, mail] };
  // The shared fake as main.swift: its own match (its self-test checks the same names), and nothing brought forward
  // unless it's the app in ROAMIES_FORWARD.
  fake.set(mailHidden);
  assert.deepEqual(helper({}, 'resolve', `app:${JOINED}`), { ok: true, running: 'Mail', runningPid: 20 });
  assert.equal(helper({}, 'locate', `app:${JOINED}`).ok, false);
  assert.equal(helper({ ROAMIES_FORWARD: 'Finder' }, 'locate', `app:${JOINED}`).ok, false);
  assert.deepEqual(unhid(), []);
  assert.equal(helper({ ROAMIES_FORWARD: 'Mail' }, 'locate', `app:${JOINED}`).window.app, 'Mail');
  assert.deepEqual(unhid(), ['Mail']);
  // ü is one Character, however it's written: "Müsic" is "Müsic", and has no "u" in it.
  fake.set({ frontPid: 1, running: ['Müsic'], wins: [] });
  assert.equal(helper({}, 'resolve', 'app:Müsic').running, 'Müsic');
  assert.equal(helper({}, 'resolve', 'app:u').running, undefined);
  const look = 'Bring Mail forward and look at its window? It has no window on screen now.';
  for (const relay of [true, false]) {
    for (const [name, run, q] of [
      ['read_window', () => said(T('read_window').execute({ target: JOINED }, {})), look],
      ['take_screenshot', () => said(T('take_screenshot').execute({ target: JOINED }, {})), look],
      ['act_in_app', () => said(T('act_in_app').execute({ target: JOINED, steps: [{ do: 'click_text', text: 'Inbox' }] }, {})), 'Bring Mail forward? It has no window on screen now.'],
      ['a helper call', () => said(t.hands('ui', `app:${JOINED}`, 'controls')), 'Bring Mail forward? It has no window on screen now.'],
    ]) {
      reset(mailHidden, relay, no);
      const r = await run();
      assert.deepEqual(asks, [q], `${relay} ${name}: ${r}`);
      assert.match(r, /Test said no, so I didn't bring Mail forward\.$/, `${relay} ${name}`);
      assert.deepEqual(unhid(), [], `${relay} ${name}: Mail stays hidden`);
      reset(mailHidden, relay);
      const y = await run();
      assert.equal(asks[0], q, `${relay} ${name}: ${y}`);
      assert.deepEqual(unhid(), ['Mail'], `${relay} ${name}: Mail brought forward once, after the yes: ${y}`);
      // The window after act_in_app's steps is another read, asked about in a relay turn (R11i-5).
      if (name !== 'act_in_app') assert.ok(!asks.some((x) => x.startsWith('Look at the Mail window "Inbox"')), `${relay} ${name}: ${JSON.stringify(asks)}`);
      else assert.match(asks[1], /^In Mail, every step I'd take:\n1\. click "Inbox"/, `${relay}`);
    }
  }

  // While an app opened after "Open X?" starts (running, no window yet), waiting for its window brings nothing forward
  // and asks nothing more: the wait looks with resolve.
  {
    const notes = { id: 9, pid: 90, app: 'Notes', title: 'Notes', text: 'x' };
    fs.writeFileSync(opens, JSON.stringify({ frontPid: 10, hidden: ['Notes'], wins: [finder, notes] }));
    reset({ frontPid: 10, wins: [finder] }, false);
    const r = await said(T('read_window').execute({ target: 'Notes' }, {}));
    fs.unlinkSync(opens);
    assert.deepEqual(asks, ["Open Notes to read its window? It isn't open now."], r);
    assert.deepEqual([unhid(), fs.readFileSync(opened, 'utf8').trim()], [[], '-g -a Notes']);
  }

  // ---- B4-2: Photos isn't running, Adobe Photoshop 2025 is, hidden (or minimised, hands-win). A yes to "Bring Photos
  // forward" is never asked for and never brings Photoshop forward: the question names Photoshop, and only a yes to that
  // does. The helper itself refuses a forward for any app but its own pick.
  const ph = { id: 5, pid: 50, app: 'Adobe Photoshop 2025', title: 'Acme contract mockup', text: 'CONFIDENTIAL Acme pricing 4.2M' };
  const fin = { id: 7, pid: 70, app: 'Finder', title: 'Downloads', text: 'x' };
  const PH = 'Bring Adobe Photoshop 2025 forward and look at its window? It has no window on screen now.';
  for (const win of [false, true]) {
    const st = { win, frontPid: 70, hidden: ['Adobe Photoshop 2025'], wins: [ph, fin] };
    fake.clear(); fake.set(st);
    assert.equal(helper({}, 'resolve', 'app:Photos').running, 'Adobe Photoshop 2025', `${win}`);
    assert.equal(helper({ ROAMIES_FORWARD: 'Photos' }, 'locate', 'app:Photos').ok, false, `${win}: a forward for Photos never brings Photoshop`);
    assert.deepEqual(unhid(), [], `${win}`);
    for (const relay of [true, false]) {
      for (const [name, run] of [['read_window', () => said(T('read_window').execute({ target: 'Photos' }, {}))], ['take_screenshot', () => said(T('take_screenshot').execute({ target: 'Photos' }, {}))]]) {
        reset(st, relay, (q) => (q.startsWith('Bring Photos forward') ? 'Allow' : "Don't allow"));
        const r = await run();
        assert.deepEqual(asks, [PH], `${win} ${relay} ${name}: ${r}`);
        assert.ok(!/Acme pricing|4\.2M|^Screenshot of/.test(r), r);
        assert.deepEqual(unhid(), [], `${win} ${relay} ${name}`);
        reset(st, relay);
        await run();
        assert.deepEqual([asks[0], unhid()], [PH, ['Adobe Photoshop 2025']], `${win} ${relay} ${name}: brought forward only after the yes naming it`);
      }
    }
  }

  // ---- B4-3: manage_app asks with the app the helper really acts on (main.swift manage: its name first, else a part of
  // one), and the helper then acts on exactly that app or on nothing (exact), never on another it fuzzy-matches.
  if (process.platform === 'darwin') {
    for (const relay of [true, false]) {
      for (const [what, app, running, q, did] of [
        ['close', 'Code', ['Finder', 'Xcode'], 'Close the window of Xcode?', ['close', 'Xcode']],
        ['minimize', 'Mail', ['Airmail 5'], 'Minimize the window of Airmail 5?', ['minimize', 'Airmail 5']],
        ['switch', 'Arc', ['Archive Utility'], 'Bring forward Archive Utility?', ['activate', 'Archive Utility']],
        ['hide', 'mail', ['Mail', 'Airmail 5'], 'Hide Mail?', ['hide', 'Mail']],
      ]) {
        const st = { frontPid: 70, running, wins: [fin] };
        reset(st, relay, no);
        assert.match(await said(T('manage_app').execute({ do: what, app }, {})), /said no/);
        assert.deepEqual([asks, managed()], [[q], []], `${relay} ${what} ${app}`);
        reset(st, relay);
        const r = await said(T('manage_app').execute({ do: what, app }, {}));
        assert.deepEqual([asks, managed()], [[q], [did]], `${relay} ${what} ${app}: ${r}`);
        assert.ok(r.startsWith('Done: ') && r.includes(did[1]), r);
      }
      // The app said yes to quit before the helper acted, and another one matches its name now (Airmail 5 for Mail):
      // nothing is acted on.
      reset({ frontPid: 70, running: ['Mail', 'Airmail 5'], wins: [fin] }, relay, () => { fake.set({ frontPid: 70, running: ['Airmail 5'], wins: [fin] }); return 'Allow'; });
      const r = await said(T('manage_app').execute({ do: 'hide', app: 'Mail' }, {}));
      assert.deepEqual([asks, managed()], [['Hide Mail?'], []], `${relay}: ${r}`);
      assert.match(r, /Mail isn't open/);
      // Not running at all: said so, nothing asked or acted on.
      reset({ frontPid: 70, running: ['Finder'], wins: [fin] }, relay);
      assert.match(await said(T('manage_app').execute({ do: 'quit', app: 'Pages' }, {})), /Pages isn't open/);
      assert.deepEqual([asks, managed()], [[], []]);
    }
  }

  assert.ok(!fs.existsSync(launched), `nothing launched: ${fs.existsSync(launched) ? fs.readFileSync(launched, 'utf8') : ''}`);
}
console.log('twelfth: ok');
