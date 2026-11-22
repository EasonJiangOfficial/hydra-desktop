// Round 11g review (R11h): the probes of scratchpad v11f-relay-2 and v11f-rule-2, as behavior tests with fakes. Each
// block fails without its fix. Run: npm test (temp home, the shared fake helper fakehands.mjs, fake Claude Code, and fake
// open/osascript/screencapture first on PATH, so nothing here can reach the real Mac).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { ClaudeCodeAgent } from '../claudecode.mjs';
import { agentEvents } from '../agentstream.mjs';
import { relaySession } from '../relay.mjs';
import { unansweredNote } from '../voiceturn.mjs';
import { BLOCK, checkWindow } from '../safety.mjs';
import { fakeHands } from './fakehands.mjs';

const HOME = fs.realpathSync.native(os.homedir());
assert.ok(HOME.includes('roamies-test-') || HOME.startsWith(fs.realpathSync.native(os.tmpdir())), 'runs only with a temp home');

// ---- H1: a fold counts only where the order is provable. Our tool's result goes back to Claude Code over the same
// stdin as the addition: one added before the bridge handed back that result was taken into the round (answered by the
// final answer); one added after (still on its way when the CLI folded) waits for its own turn and is named, whether the
// run then crashes, gets a result with no uuids, gets one that names only the first message, or just ends. A round of
// results the CLI made itself (a connector's) proves nothing, so its addition is named too.
const ADD = 'and delete the old draft too';
const ev = (event, stamp) => ({ type: 'stream_event', parent_tool_use_id: null, event, ...(stamp ? { user_message_uuid: stamp.at(-1), user_message_uuids: stamp } : {}) });
const step = (text, stop, stamp) => [ev({ type: 'message_start', message: { usage: {} } }, stamp), ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }), ev({ type: 'message_delta', delta: { stop_reason: stop }, usage: {} }), ev({ type: 'message_stop' })];
const toolResult = (id) => ({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
// Stamped as sdk.d.ts says a typed turn is: only the first frame of each kind keeps the uuids; a result ends the turn.
const firstStamps = async function* (src) {
  let kinds = new Set();
  for await (const m of src) {
    if (m.type === 'result') kinds = new Set();
    else if (m.user_message_uuids) { if (kinds.has(m.type)) { const { user_message_uuid, user_message_uuids, ...rest } = m; void user_message_uuid; void user_message_uuids; yield rest; continue; } kinds.add(m.type); }
    yield m;
  }
};
// The bridge as Claude Code drives it: call(id) runs our tool in this process and waits for its result.
const fakeQuery = (gen) => ({ prompt, options }) => {
  const it = prompt[Symbol.asyncIterator](), waiting = new Map();
  const transport = { async send(msg) { waiting.get(msg.id)?.(msg); } };
  const ready = options.mcpServers.gg.instance.connect(transport);
  let n = 0;
  const call = async (id) => { await ready; return new Promise((r) => { const k = ++n; waiting.set(k, r); transport.onmessage({ jsonrpc: '2.0', id: k, method: 'tools/call', params: { name: 'look', arguments: {}, _meta: { 'claudecode/toolUseId': id } } }); }); };
  return Object.assign(firstStamps(gen(it, call)), { interrupt: async () => {}, close: () => {} });
};
const look = { name: 'look', description: 'Look.', parameters: z.object({}), execute: async () => 'ok' };
const agentWith = (query) => new ClaudeCodeAgent({ model: 'm', system: 's', tools: [look], executable: '/bin/claude', cwd: '/', env: {}, query, onRateLimit: () => {} });
const later = () => new Promise((r) => setTimeout(r, 20));
const ends = {
  crash: () => { throw new Error('Claude Code process exited with code 1'); },
  zeroed: () => [{ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'], usage: {} }],
  names_first_only: (first) => [{ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'], usage: {}, user_message_uuid: first.uuid, user_message_uuids: [first.uuid] }],
  plain: () => [],
};
const round = (ref, mode, tail) => fakeQuery(async function* (it, call) {
  const first = (await it.next()).value;
  yield* step('Looking at the desktop.', 'tool_use', [first.uuid]);
  await later();
  if (mode === 'transit') await call('t1'); // handed back first: the addition comes after the result on stdin
  ref.a.addInput(ADD);
  await it.next();
  if (mode === 'folded') await call('t1');
  yield toolResult(mode === 'connector' ? 'c1' : 't1'); // c1: a connector's, the CLI ran it
  yield* step('Done: desktop tidied.', 'end_turn', [first.uuid]);
  yield* tail(first);
});
for (const [end, tail] of Object.entries(ends)) {
  for (const mode of ['folded', 'transit', 'connector']) {
    const ref = {};
    ref.a = agentWith(round(ref, mode, tail));
    try { for await (const e of agentEvents(ref.a.prompt('clean up my desktop'))) void e; } catch { /* the cut */ }
    const answered = mode === 'folded' && end !== 'names_first_only';
    assert.deepEqual(ref.a.unanswered(), answered ? [] : [ADD], `${end} ${mode}`);
    if (!answered) assert.match(unansweredNote(ref.a.unanswered()), /delete the old draft/, `${end} ${mode}: the voice note names it`);
  }
}
// A relay turn on the transit crash: the phone is told what was added went unanswered.
{
  const ref = {};
  ref.a = agentWith(round(ref, 'transit', ends.crash));
  let thrown = '';
  try { await relaySession({ agent: ref.a, text: 'clean up my desktop', h: { emit: () => {}, signal: new AbortController().signal, onInput: () => {}, done: async () => [] } }); } catch (e) { thrown = e.message; }
  assert.match(thrown, /What you added while I worked was not answered/, thrown);
}

// ---- H2: a key file's name in a title shaped "file (folder) - App" (gVim, MacVim, Sublime Text on Windows), with Vim's
// marks, or as a name in a key folder, blocks, on this Mac and in a relay turn. A plain file's doesn't.
const BLOCKED = ['id_rsa (~\\.ssh) - GVIM', '.env (~\\Documents\\shop) - GVIM', '.env + (~\\shop) - GVIM', 'C:\\Users\\me\\keys\\id_rsa (keys) - Sublime Text', 'C:\\Users\\me\\certs\\server.pem (certs) - Sublime Text', 'id_rsa (~/.ssh) - VIM', 'config (~/.ssh) - VIM', 'id_rsa [+] (~/.ssh) - VIM', 'id_rsa = (~/.ssh) - VIM'];
for (const title of BLOCKED) for (const viewers of [true, false]) assert.equal(checkWindow({ app: 'gvim', title }, HOME, { viewers }).level, BLOCK, `${title} ${viewers}`);
for (const title of ['notes.txt [+] - VIM', 'report (~/Documents) - VIM', 'Inbox (3) - Mail']) assert.notEqual(checkWindow({ app: 'gvim', title }, HOME).level, BLOCK, title);

// ---- H5: a title's words are never quoted in a block (an email's subject, a page's name, a command).
const subject = 'Re: Acme merger - rotate ~/.aws/credentials before the Friday announcement — Inbox';
const h5 = checkWindow({ app: 'Mail', title: subject }, HOME, { viewers: false });
assert.equal(h5.level, BLOCK);
assert.equal(h5.reason, "Mail's window title names a file that holds passwords or keys, so I won't read it or look at it.");

if (['darwin', 'win32'].includes(process.platform)) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-11h-'));
  const bin = path.join(dir, 'bin'), launched = path.join(dir, 'launched.log');
  fs.mkdirSync(bin);
  for (const c of ['open', 'osascript', 'screencapture']) fs.writeFileSync(path.join(bin, c), `#!/bin/sh\necho ${c} "$@" >> '${launched}'\nexit 1\n`, { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  const doc = path.join(HOME, 'Documents', 'n.txt'), env = path.join(HOME, 'Documents', 'shop', '.env');
  for (const f of [doc, env]) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'x'); }
  const fake = fakeHands(dir);
  const { createTools } = await import('../tools.mjs');
  const asks = [];
  let remote = false, answer = () => 'Allow';
  const t = createTools({ remote: () => remote, allowActions: () => true, ui: (msg) => { if (msg?.e?.type === 'draw') setTimeout(() => t.ink.started(msg.e.id, msg.e.seg), 5); }, ask: async (o) => { asks.push(o.placeholder); return answer(o.placeholder); }, openUrl: async () => {}, onCommitments: () => {}, showList: () => {}, fmtWhen: String, commitmentsText: () => '', userName: 'Test', workdir: HOME, skills: { changed: () => {} } });
  const T = (n) => t.tools.find((x) => x.name === n);
  const reset = (st, relay, ans = () => 'Allow') => { fake.clear(); asks.length = 0; answer = ans; remote = relay; fake.set(st); t.nextTurn(); };
  const said = (p) => p.then((x) => String(x), (e) => String(e?.message ?? e));
  const ring = (target, text) => said(T('draw').execute({ target, beats: [{ say: 'Here.', marks: [{ kind: 'ring', at: { text } }] }] }, { toolCallId: `h${Math.random()}` }));
  const shot = (target) => said(T('take_screenshot').execute({ target }, {}).then((r) => r?.content?.[0]?.text ?? r));
  const KEY = 'OPENAI_API_KEY=sk-live-abc123', PEM = '-----BEGIN OPENSSH PRIVATE KEY-----';
  const WHOLE = 'Look at your whole screen? Every app and window on it, with banners, pop-ups and alerts, is in it.';
  const TOO_MANY = 'Too many windows are open for me to check them all. Name the app.';

  // ---- H2 in draw: as hands-win sends a gVim or Sublime window (no file, title only), its key text never reaches the
  // model, by its words or by OCR alone (ax: false), on this Mac and in a relay turn.
  for (const relay of [false, true]) {
    for (const [app, title, text, find, ax] of [['gvim', 'id_rsa (~\\.ssh) - GVIM', PEM, 'BEGIN OPENSSH', true], ['Sublime Text', 'C:\\Users\\me\\keys\\id_rsa (keys) - Sublime Text', PEM, 'BEGIN OPENSSH', true], ['gvim', '.env (~\\Documents\\shop) - GVIM', KEY, 'OPENAI_API_KEY', false]]) {
      reset({ win: true, frontPid: 70, wins: [{ id: 21, pid: 70, app, exe: `${app.split(' ')[0].toLowerCase()}.exe`, title, text, ax }] }, relay);
      const h2 = await ring(app, find);
      assert.ok(!h2.includes('PRIVATE KEY') && !h2.includes('sk-live') && h2.includes(`Blocked for safety: ${app}'s window title names a file`), `${title} ${relay}: ${h2}`);
      assert.deepEqual(asks, []);
    }
  }

  // ---- H5 in draw: a relay turn on the whole screen with that Mail window: blocked, the subject unsaid, nothing asked.
  reset({ frontPid: 80, wins: [{ id: 31, pid: 80, app: 'Mail', title: subject, text: 'Hello' }, { id: 32, pid: 81, app: 'Preview', title: 'n.txt', doc, text: 'Hello', bounds: [0, 0, 400, 300] }] }, true);
  const h5d = await ring('screen', 'Hello');
  assert.ok(h5d.includes("Blocked for safety: Mail's window title names a file") && !/Friday|rotate|aws|Acme/.test(h5d), h5d);
  assert.deepEqual(asks, []);

  // ---- H3: draw on the whole screen checks every window the screen's pixels can show, not the first 30 'windows'
  // lists: a .env open in the 31st is blocked, on this Mac and in a relay turn. A helper that lists at most 30 and sent
  // 30 (hands-win) reads nothing. OCR's whole-line hits count only inside a window checked: a panel the helper doesn't
  // list (above layer 0, or tiny) is never read.
  const fill = Array.from({ length: 30 }, (_, i) => ({ id: 100 + i, pid: 200 + i, app: 'Preview', title: `p${i}.pdf`, doc, text: `page ${i}`, bounds: [i, i, 800, 600] }));
  const te = { id: 99, pid: 99, app: 'TextEdit', title: '.env', doc: env, text: KEY, bounds: [600, 300, 800, 600] };
  for (const relay of [false, true]) {
    reset({ frontPid: 200, wins: [...fill, te] }, relay);
    const h3 = await ring('screen', 'OPENAI_API_KEY');
    assert.ok(!h3.includes('sk-live') && h3.includes('Blocked for safety: TextEdit shows'), `${relay}: ${h3}`);
    assert.ok(!fake.calls().some((c) => c[0] === 'find-text' || c[0] === 'ocr-find'), 'nothing is read off the screen first');
    reset({ win: true, frontPid: 200, wins: [...fill, { ...te, title: 'notes - Notepad', app: 'Notepad', doc: undefined }] }, relay);
    assert.match(await ring('screen', 'OPENAI_API_KEY'), new RegExp(TOO_MANY.replace(/\./g, '\\.')));
    assert.deepEqual(asks, [], 'nothing is asked before it refuses');
    const panel = { id: 98, pid: 98, app: 'Terminal', title: '', text: KEY, bounds: [900, 700, 300, 120], listed: false };
    reset({ frontPid: 200, wins: [fill[0], panel] }, relay);
    const h3p = await ring('screen', 'OPENAI_API_KEY');
    assert.ok(!h3p.includes('sk-live') && /No button, label or heading reads "OPENAI_API_KEY"/.test(h3p), `${relay}: ${h3p}`);
    assert.deepEqual(asks, relay ? [WHOLE] : []);
  }

  // ---- H7: take_screenshot of the whole screen with a helper that sends no 'shown' list (hands-win): every window
  // 'windows' lists is checked, not just the front one. A .env open in a background Notepad blocks the picture; a list
  // that may be cut refuses it; a relay turn asks the whole screen once.
  const photos = { id: 41, pid: 41, app: 'Photos', exe: 'photos.exe', title: 'Holiday', text: 'x' };
  const pad = { id: 42, pid: 42, app: 'Notepad', exe: 'notepad.exe', title: '.env - Notepad', text: KEY };
  for (const relay of [false, true]) {
    reset({ win: true, frontPid: 41, wins: [photos, pad] }, relay);
    const h7 = await shot('screen');
    assert.match(h7, /^Blocked for safety: Notepad's window title names a file/, h7);
    reset({ win: true, frontPid: 41, wins: [photos, ...fill.slice(0, 29)] }, relay);
    assert.equal(await shot('screen'), TOO_MANY);
  }
  reset({ win: true, frontPid: 41, wins: [photos, { ...pad, title: 'notes.txt - Notepad' }] }, true);
  assert.match(await shot('screen'), /^Screenshot of the whole screen/);
  assert.deepEqual(asks, [WHOLE]);
  // main.swift lists at most 60 windows in the picture: a full list may have left the 61st (a .env) out.
  reset({ frontPid: 200, wins: [...fill, ...fill.map((w) => ({ ...w, id: w.id + 100 })), te] }, false);
  assert.equal(await shot('screen'), TOO_MANY);

  // ---- H4: a relay turn never brings a hidden app forward before the owner says yes: draw, read_window,
  // take_screenshot and act_in_app on it ask first, naming the app (draw and the reads ask once for both steps), and a
  // no stops before any helper call that can unhide it. A yes brings it forward with no second question about looking.
  const preview = { id: 1, pid: 10, app: 'Preview', title: 'n.txt', doc, text: 'x' };
  const msgs = { id: 2, pid: 20, app: 'Messages', title: 'Alex', text: 'Meet at 6' };
  const hiddenMsgs = { frontPid: 10, hidden: ['Messages'], wins: [preview, msgs] };
  const unhid = () => fake.calls().some((c) => c[0] === 'UNHIDE');
  const no = (q) => (q.startsWith('Bring ') ? "Don't allow" : 'Allow');
  for (const [name, run, q] of [
    ['draw', () => ring('Messages', 'Meet at 6'), 'Bring Messages forward and look at its window? It has no window on screen now.'],
    ['read_window', () => said(T('read_window').execute({ target: 'Messages' }, {})), 'Bring Messages forward and look at its window? It has no window on screen now.'],
    ['take_screenshot', () => shot('Messages'), 'Bring Messages forward and look at its window? It has no window on screen now.'],
    ['act_in_app', () => said(T('act_in_app').execute({ target: 'Messages', steps: [{ do: 'click_text', text: 'Alex' }] }, {})), 'Bring Messages forward? It has no window on screen now.'],
  ]) {
    reset(hiddenMsgs, true, no);
    const r = await run();
    assert.deepEqual(asks, [q], name);
    assert.match(r, /(^|: )Test said no, so I didn't bring Messages forward\.$/, name);
    assert.ok(!unhid(), `${name}: nothing was brought forward`);
  }
  // Every helper call that can bring an app forward goes through the same check (hands()), whoever makes it.
  for (const args of [['locate', 'app:Messages'], ['ui', 'app:Messages', 'controls'], ['ocr-find', 'app:Messages', 'Meet', 'all'], ['capture', path.join(dir, 'c.jpg'), 'app:Messages'], ['act', JSON.stringify({ steps: [], app: 'Messages' })]]) {
    reset(hiddenMsgs, true, no);
    assert.match(await said(t.hands(...args)), /^Test said no, so I didn't bring Messages forward\.$/, args[0]);
    assert.deepEqual(asks, ['Bring Messages forward? It has no window on screen now.'], args[0]);
    assert.ok(!unhid(), `${args[0]}: nothing was brought forward`);
  }
  reset(hiddenMsgs, true);
  const h4 = await ring('Messages', 'Meet at 6');
  assert.ok(h4.startsWith('Drew '), h4);
  assert.deepEqual(asks, ['Bring Messages forward and look at its window? It has no window on screen now.'], 'one question');
  assert.ok(unhid());
  // On this Mac too (B4: no app is brought forward without a yes naming it), the same one question.
  reset(hiddenMsgs, false);
  assert.ok((await ring('Messages', 'Meet at 6')).startsWith('Drew '));
  assert.deepEqual(asks, ['Bring Messages forward and look at its window? It has no window on screen now.'], 'on this Mac it asks too');

  // ---- H6: the shared fake sends what the helpers send: 'windows' 30 at most (main.swift: all with 'all', and says
  // so), frontApp, hands-win's exe; find-text a match kind, 80 characters at most, 12 windows; ocr-find whole lines
  // from every window on screen.
  const many = Array.from({ length: 40 }, (_, i) => ({ id: 300 + i, pid: 300 + i, app: 'TextEdit', title: `t${i}`, text: `${'word '.repeat(30)}needle ${i}` }));
  const { execFileSync } = await import('node:child_process');
  const helper = (...a) => JSON.parse(execFileSync(process.execPath, [process.env.ROAMIES_HANDS, ...a], { encoding: 'utf8' }));
  fake.set({ frontPid: 300, wins: many });
  assert.equal(helper('windows').windows.length, 30);
  assert.equal(helper('windows', 'all').windows.length, 40);
  assert.equal(helper('windows', 'all').all, true);
  assert.equal(helper('windows').windows[0].frontApp, true);
  const ft = helper('find-text', 'screen', 'needle').matches;
  assert.ok(ft.length <= 8 && ft.every((m) => m.text.length <= 80 && m.match === 'word' && m.window.id < 312), JSON.stringify(ft[0]));
  assert.equal(helper('ocr-find', 'screen', 'needle', 'all').matches.length, 40);
  fake.set({ win: true, frontPid: 300, wins: many });
  assert.equal(helper('windows', 'all').windows.length, 30);
  assert.equal(helper('windows', 'all').all, undefined);
  assert.equal(helper('windows').windows[0].exe, 'textedit');

  assert.ok(!fs.existsSync(launched), `nothing launched: ${fs.existsSync(launched) ? fs.readFileSync(launched, 'utf8') : ''}`);
}
console.log('eleventhh: ok');
