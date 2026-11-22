// Round 11h review (R11i): the probes of scratchpad v11h-rule-1 and v11h-relay-1, as behavior tests with fakes. Each
// block fails without its fix. Run: npm test (temp home, the shared fake helper fakehands.mjs, fake Claude Code, and fake
// open/osascript/screencapture first on PATH, so nothing here can reach the real Mac).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { ClaudeCodeAgent } from '../claudecode.mjs';
import { relaySession } from '../relay.mjs';
import { BLOCK, checkWindow } from '../safety.mjs';
import { fakeHands } from './fakehands.mjs';

const HOME = fs.realpathSync.native(os.homedir());
assert.ok(HOME.includes('roamies-test-') || HOME.startsWith(fs.realpathSync.native(os.tmpdir())), 'runs only with a temp home');

// ---- I2: Vim's file list counter after the folder ("(1 of 2)", "((2) of 3)") doesn't hide a key file's name: blocked,
// on this Mac and in a relay turn. A plain file's isn't.
const BLOCKED = ['config (~/.ssh) (1 of 2) - VIM', 'config + (~\\.kube) ((2) of 3) - GVIM', 'config (~\\.kube) (1 of 2) - GVIM', 'known_hosts (~/.ssh) (2 of 2) - VIM', 'config.json (~/.docker) (1 of 2) - VIM', 'id_rsa [+] (~/.ssh) (1 of 3) - NVIM'];
for (const title of BLOCKED) for (const viewers of [true, false]) assert.equal(checkWindow({ app: 'gvim', title }, HOME, { viewers }).level, BLOCK, `${title} ${viewers}`);
for (const title of ['notes.txt (~/Documents) (1 of 2) - VIM', 'Inbox (3 of 10) - Mail']) assert.notEqual(checkWindow({ app: 'gvim', title }, HOME).level, BLOCK, title);

// ---- I6: an addition relaySession makes the next prompt of (missed at max turns, or held at done) is named when that
// run fails or is cut by max turns, never dropped.
{
  const ev = (event, stamp) => ({ type: 'stream_event', parent_tool_use_id: null, event, ...(stamp ? { user_message_uuid: stamp.at(-1), user_message_uuids: stamp } : {}) });
  const step = (text, stop, stamp) => [ev({ type: 'message_start', message: { usage: {} } }, stamp), ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }), ev({ type: 'message_delta', delta: { stop_reason: stop }, usage: {} }), ev({ type: 'message_stop' })];
  const toolResult = (id) => ({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
  const look = { name: 'look', description: 'Look.', parameters: z.object({}), execute: async () => 'ok' };
  const later = () => new Promise((r) => setTimeout(r, 20));
  const ADD = 'and delete the old draft too';
  const UNSAID = '\n(I could not answer what you added in this turn. Say it again.)\n';
  for (const second of ['crash', 'maxturns']) {
    for (const mode of ['maxturns', 'held']) {
      let runs = 0;
      const ref = {};
      const query = ({ prompt, options }) => {
        const it = prompt[Symbol.asyncIterator](), waiting = new Map();
        const transport = { async send(msg) { waiting.get(msg.id)?.(msg); } };
        const ready = options.mcpServers.gg.instance.connect(transport);
        let n = 0;
        const call = async (id) => { await ready; return new Promise((r) => { const k = ++n; waiting.set(k, r); transport.onmessage({ jsonrpc: '2.0', id: k, method: 'tools/call', params: { name: 'look', arguments: {}, _meta: { 'claudecode/toolUseId': id } } }); }); };
        const k = ++runs;
        const gen = async function* () {
          const first = (await it.next()).value;
          if (k === 1) {
            yield* step('Looking.', 'tool_use', [first.uuid]);
            await later();
            if (mode === 'maxturns') {
              ref.a.addInput(`[added] ${ADD}`);
              const A = (await it.next()).value;
              await call('t1'); yield toolResult('t1'); yield* step('Deleting.', 'tool_use');
              yield { type: 'result', subtype: 'error_max_turns', is_error: true, errors: [], usage: {}, user_message_uuid: A.uuid, user_message_uuids: [first.uuid, A.uuid] };
              return;
            }
            await call('t1'); yield toolResult('t1'); yield* step('Done.', 'end_turn');
            yield { type: 'result', subtype: 'success', is_error: false, result: 'Done.', usage: {}, user_message_uuid: first.uuid, user_message_uuids: [first.uuid] };
            return;
          }
          // The run for the carried words: it fails at once, or is cut by max turns.
          if (second === 'maxturns') { yield* step('Working on it.', 'tool_use', [first.uuid]); yield { type: 'result', subtype: 'error_max_turns', is_error: true, errors: [], usage: {}, user_message_uuid: first.uuid, user_message_uuids: [first.uuid] }; return; }
          throw new Error('Claude Code process exited with code 1');
        };
        return Object.assign(gen(), { interrupt: async () => {}, close: () => {} });
      };
      ref.a = new ClaudeCodeAgent({ model: 'm', system: 's', tools: [look], executable: '/bin/claude', cwd: '/', env: {}, query, onRateLimit: () => {} });
      let held = mode === 'held';
      const events = [];
      const h = { emit: (e) => events.push(e), signal: new AbortController().signal, onInput: () => {}, done: async () => (held ? (held = false, [ADD]) : []) };
      let thrown = null;
      try { await relaySession({ agent: ref.a, text: 'clean up my desktop', h }); } catch (e) { thrown = e.message; }
      assert.equal(runs, 2, `${second} ${mode}: the addition was carried into a second run`);
      if (second === 'crash') assert.match(String(thrown), /What you added while I worked was not answered\. Say it again\./, `${second} ${mode}: ${thrown}`);
      else {
        assert.equal(thrown, null);
        assert.deepEqual(events.filter((e) => e.type === 'text').map((e) => e.delta), [UNSAID], `${second} ${mode}`);
      }
    }
  }
}

if (['darwin', 'win32'].includes(process.platform)) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-11i-'));
  const bin = path.join(dir, 'bin'), launched = path.join(dir, 'launched.log');
  fs.mkdirSync(bin);
  for (const c of ['open', 'osascript', 'screencapture', 'sips']) fs.writeFileSync(path.join(bin, c), `#!/bin/sh\necho ${c} "$@" >> '${launched}'\nexit 1\n`, { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  const fake = fakeHands(dir);
  const { createTools, appMatches, helperFinds } = await import('../tools.mjs');
  const asks = [];
  let remote = true, answer = () => 'Allow';
  const t = createTools({ remote: () => remote, allowActions: () => true, ui: (msg) => { if (msg?.e?.type === 'draw') setTimeout(() => t.ink.started(msg.e.id, msg.e.seg), 5); }, ask: async (o) => { asks.push(o.placeholder); return answer(o.placeholder); }, openUrl: async () => {}, onCommitments: () => {}, showList: () => {}, fmtWhen: String, commitmentsText: () => '', userName: 'Test', workdir: HOME, skills: { changed: () => {} } });
  const T = (n) => t.tools.find((x) => x.name === n);
  const reset = (st, relay, ans = () => 'Allow') => { fake.clear(); asks.length = 0; answer = ans; remote = relay; fake.set(st); t.nextTurn(); };
  const said = (p) => p.then((x) => String(x?.content?.[0]?.text ?? x), (e) => String(e?.message ?? e));
  const ring = (target, text) => said(T('draw').execute({ target, beats: [{ say: 'Here.', marks: [{ kind: 'ring', at: { text } }] }] }, { toolCallId: `i${Math.random()}` }));
  const shot = (target) => said(T('take_screenshot').execute({ target }, {}));
  const read = (target) => said(T('read_window').execute({ target }, {}));
  const unhid = () => fake.calls().filter((c) => c[0] === 'UNHIDE').map((c) => c[1]);

  // ---- I1: a yes to "Bring Photos forward and look at its window?" covers only a window of Photos itself. The helper
  // brought Adobe Photoshop 2025 forward instead (its fuzzy match): its window is asked about by name before any of its
  // text or picture reaches the model, and a no keeps it out. With Photos running too, Photos is the one brought forward
  // (main.swift pickRunning), and its window needs no second question.
  const ph = { id: 5, pid: 50, app: 'Adobe Photoshop 2025', title: 'Acme contract mockup', text: 'CONFIDENTIAL Acme pricing 4.2M' };
  const photos = { id: 6, pid: 60, app: 'Photos', title: 'Library', text: 'Holiday' };
  const finder = { id: 7, pid: 70, app: 'Finder', title: 'Downloads', text: 'x' };
  const BRING_PHOTOS = 'Bring Photos forward and look at its window? It has no window on screen now.';
  const onlyBring = (q) => (q.startsWith('Bring Photos forward') ? 'Allow' : "Don't allow");
  for (const [name, run] of [['read_window', () => read('Photos')], ['draw', () => ring('Photos', 'CONFIDENTIAL')], ['take_screenshot', () => shot('Photos')]]) {
    reset({ frontPid: 70, hidden: ['Adobe Photoshop 2025'], wins: [ph, finder] }, true, onlyBring);
    const r = await run();
    assert.ok(!/Acme pricing|4\.2M|^Screenshot of|^Drew /.test(r), `${name}: ${r}`);
    assert.deepEqual(asks.slice(0, 2), [BRING_PHOTOS, 'Look at the Adobe Photoshop 2025 window "Acme contract mockup"? It has no file I can check, so it could show anything (a password, a message, a terminal).'], name);
    reset({ frontPid: 70, hidden: ['Adobe Photoshop 2025', 'Photos'], wins: [ph, photos, finder] }, true, onlyBring);
    const r2 = await run();
    assert.deepEqual(unhid(), ['Photos'], name);
    assert.deepEqual(asks, [BRING_PHOTOS], name);
    assert.ok(!/Acme pricing|4\.2M/.test(r2) && (name === 'draw' ? /No button, label or heading reads/.test(r2) : /^Photos — Library|^Screenshot of the Photos window/.test(r2)), `${name}: ${r2}`);
  }

  // ---- I5: that yes covers the one read it was asked for, never a later one in the request: the window act_in_app's
  // steps leave (R11c-5) and a later screenshot are asked about by name, as for an app that was on screen.
  const after = { ok: true, done: ['clicked "Bank statement"'], window: { id: 42, app: 'Mail', title: 'Bank statement', bounds: [0, 0, 800, 600] }, controls: [], texts: ['Balance: 12,345.67 on account 4417'] };
  for (const hidden of [false, true]) {
    reset({ frontPid: 9, hidden: hidden ? ['Mail'] : [], act: after, wins: [{ id: 41, pid: 50, app: 'Mail', title: 'Inbox', text: 'Inbox\nBank statement' }, { id: 1, pid: 9, app: 'Finder', title: 'Desktop', text: '' }] }, true, (q) => (/^Look at the Mail window "Bank statement"/.test(q) ? "Don't allow" : 'Allow'));
    assert.match(await read('Mail'), /^Mail — Inbox/);
    const r = await said(T('act_in_app').execute({ target: 'Mail', steps: [{ do: 'click_text', text: 'Bank statement' }] }, {}));
    assert.ok(!r.includes('12,345.67') && /Test said no to reading the window after/.test(r), `${hidden}: ${r}`);
    assert.match(asks.at(-1), /^Look at the Mail window "Bank statement"\?/, `${hidden}`);
    asks.length = 0;
    assert.match(await shot('Mail'), /^Screenshot of the Mail window/);
    assert.match(asks[0] ?? '', /^Look at the Mail window "Inbox"\?/, `${hidden}: a later screenshot asks`);
  }

  // ---- I3: a relay turn on 'browser' with a LibreWolf window on screen (main.swift's browsers don't include it) and
  // Safari hidden: the helper would bring Safari forward, so it's asked first, and a no stops it. read_window,
  // take_screenshot, draw and act_in_app alike.
  const wolf = { id: 11, pid: 110, app: 'LibreWolf', title: 'Bank', text: 'Balance' };
  const safari = { id: 12, pid: 120, app: 'Safari', title: 'Mail', text: 'Balance' };
  for (const [name, run, q] of [
    ['read_window', () => read('browser'), 'Bring browser forward and look at its window? It has no window on screen now.'],
    ['take_screenshot', () => shot('browser'), 'Bring browser forward and look at its window? It has no window on screen now.'],
    ['draw', () => ring('browser', 'Balance'), 'Bring browser forward and look at its window? It has no window on screen now.'],
    ['act_in_app', () => said(T('act_in_app').execute({ target: 'browser', steps: [{ do: 'click_text', text: 'Balance' }] }, {})), 'Bring browser forward? It has no window on screen now.'],
  ]) {
    reset({ frontPid: 110, hidden: ['Safari'], wins: [wolf, safari] }, true, () => "Don't allow");
    const r = await run();
    assert.equal(asks[0], q, `${name}: ${r}`);
    assert.deepEqual(unhid(), [], `${name}: nothing was brought forward`);
  }
  // What each helper itself finds, no more (appMatches finds more, to check more).
  assert.ok(!helperFinds({ app: 'LibreWolf' }, 'browser', false) && appMatches({ app: 'LibreWolf' }, 'browser'));
  assert.ok(helperFinds({ app: 'Safari' }, 'browser', false) && helperFinds({ app: 'LibreWolf', exe: 'librewolf' }, 'browser', true));
  assert.ok(!helperFinds({ app: 'Opera', exe: 'launcher' }, 'browser', true) && !helperFinds({ app: 'Photoshop' }, 'photo.exe', false));
  assert.ok(helperFinds({ app: 'Notepad', exe: 'notepad' }, 'notepad.exe', true) && helperFinds({ app: 'Adobe Photoshop 2025' }, ' Photoshop ', false));

  // ---- I4: the shared fake sends what hands-win sends: the program's file name without .exe, and 'browser' by it.
  const helper = (...a) => JSON.parse(execFileSync(process.execPath, [process.env.ROAMIES_HANDS, ...a], { encoding: 'utf8' }));
  fake.set({ win: true, frontPid: 1, wins: [{ id: 1, pid: 1, app: 'Notepad', title: 'a.txt - Notepad', text: 'x' }, { id: 2, pid: 2, app: 'Notepad', exe: 'Notepad.exe', title: 'b.txt', text: 'x' }, { id: 3, pid: 3, app: 'LibreWolf', exe: 'librewolf', title: 'Page', text: 'needle' }] });
  assert.deepEqual(helper('windows').windows.map((w) => w.exe), ['notepad', 'Notepad', 'librewolf']);
  assert.equal(helper('front').exe, 'notepad');
  assert.equal(helper('find-text', 'app:browser', 'needle').matches[0]?.window?.id, 3);
  fake.set({ frontPid: 1, wins: [{ id: 3, pid: 3, app: 'LibreWolf', title: 'Page', text: 'needle' }] });
  assert.equal(helper('find-text', 'app:browser', 'needle').ok, false, "main.swift's browsers don't include LibreWolf");

  // ---- I2 in draw: a hands-win gVim window with two files open, a ~/.kube/config token in it: blocked, on this Mac and
  // in a relay turn, nothing asked.
  for (const relay of [false, true]) {
    reset({ win: true, frontPid: 70, wins: [{ id: 21, pid: 70, app: 'gvim', exe: 'gvim', title: 'config (~\\.kube) (1 of 2) - GVIM', text: ' token: eyJhbGciOiJSUzI1NiJ9.SECRET-BEARER' }] }, relay);
    const r = await ring('gvim', 'token');
    assert.ok(!r.includes('SECRET') && r.includes("Blocked for safety: gvim's window title names a file"), `${relay}: ${r}`);
    assert.deepEqual(asks, []);
  }

  assert.ok(!fs.existsSync(launched), `nothing launched: ${fs.existsSync(launched) ? fs.readFileSync(launched, 'utf8') : ''}`);
}
console.log('eleventhi: ok');
