// Build 4 lane E, review round 2 (laneE-round2-findings.json): each block fails without its fix. Nothing here reaches
// the Mac: the hands helper is a stub written below, and open, osascript, screencapture and sips are stubs on PATH.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'b4fix2-'));
process.env.ROAMIES_DATA_DIR = path.join(tmp, 'data');
// Its own home, run alone too: the sign-in files below are made there, never in a real one.
process.env.HOME = path.join(tmp, 'home'); fs.mkdirSync(process.env.HOME);
const bin = path.join(tmp, 'bin'), launched = path.join(tmp, 'launched.log');
fs.mkdirSync(bin);
for (const c of ['open', 'osascript', 'screencapture', 'sips']) fs.writeFileSync(path.join(bin, c), `#!/bin/sh\necho ${c} "$@" >> '${launched}'\nexit 0\n`, { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;
// The hands helper: a stub. Scenario in STUB_STATE: 'replan' (the first act says another app, Mail, came forward) or
// 'vault' (1Password runs hidden).
const stub = path.join(tmp, 'hands.mjs'), stState = path.join(tmp, 'st.json'), stLog = path.join(tmp, 'log.jsonl');
fs.writeFileSync(stub, `import fs from 'node:fs';
const a = process.argv.slice(2), s = JSON.parse(fs.readFileSync(${JSON.stringify(stState)}, 'utf8'));
fs.appendFileSync(${JSON.stringify(stLog)}, JSON.stringify({ a, fwd: process.env.ROAMIES_FORWARD || '' }) + '\\n');
const out = (o) => { console.log(JSON.stringify(o)); process.exit(0); };
const w = s.mode === 'vault' ? { id: 7, pid: 70, app: '1Password', title: '1Password', bounds: [0, 0, 800, 600] } : { id: 1, pid: 10, app: 'TextEdit', title: 'Untitled', bounds: [0, 0, 800, 600] };
if (a[0] === 'locate') out({ ok: true, window: w });
if (a[0] === 'resolve') out(s.mode === 'vault' ? { ok: true, window: null, running: '1Password' } : { ok: true, window: w });
if (a[0] === 'act') {
  s.acts = (s.acts ?? 0) + 1; fs.writeFileSync(${JSON.stringify(stState)}, JSON.stringify(s));
  const plan = JSON.parse(a[1]);
  if (s.acts === 1) out({ ok: false, needsConfirm: true, step: 0, whole: 'plan', app: 'Mail', label: 'plan', why: 'x', done: [] });
  out({ ok: true, done: ['pressed delete'], ranIn: plan.planApp, window: { ...w, app: plan.planApp } });
}
if (a[0] === 'capture') { fs.writeFileSync(a[1], 'x'); out({ ok: true, window: w, pixels: [800, 600], bounds: w.bounds }); }
if (a[0] === 'windows') out({ ok: true, windows: [w], all: true });
out({ ok: true });
`);
process.env.ROAMIES_HANDS = stub;

const { askForTake, spokenAnswer, trackAsk, ownTurn, pendingWanted, startProgress } = await import('../voiceturn.mjs');
const { approveAllSays, checkMcpCall, checkOpen, isPasswordApp, isYes } = await import('../safety.mjs');
const { createTools } = await import('../tools.mjs');
const { createMcpTools } = await import('../mcp.mjs');
const S = await import('../store.mjs');
const { parseBrain } = await import('../brain.mjs');
const { ClaudeCodeAgent } = await import('../claudecode.mjs');
const { agentEvents } = await import('../agentstream.mjs');
const side = fs.readFileSync(new URL('../sidekick.mjs', import.meta.url), 'utf8');

function fakeClock() {
  let t = 0, timers = [];
  return {
    now: () => t,
    setTimer: (f, ms) => { const h = { f, at: t + ms, unref() {} }; timers.push(h); return h; },
    clearTimer: (h) => { timers = timers.filter((x) => x !== h); },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const next = timers.filter((h) => h.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        t = next.at; timers = timers.filter((h) => h !== next); next.f();
      }
      t = end;
    },
  };
}
// A piece of sidekick.mjs run on its own, its outer names given by st (with): from `from` up to `to`.
function piece(from, to, names, st) {
  const a = side.indexOf(from), b = side.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `sidekick.mjs has ${from}`);
  return new Function('st', `with (st) { ${side.slice(a, b)}; return { ${names.join(', ')} }; }`)(st);
}

// ---- 1. "I don't mind" is a yes, never a no; "never mind" alone is no answer.
{
  const q = 'Open ui.elevenlabs.io';
  for (const t of ["I don't mind", "don't mind", 'I do not mind', 'never mind, do it', 'sure', 'go ahead']) assert.equal(spokenAnswer(t, q), 'yes', t);
  for (const t of ['nah I don\'t mind', 'never mind', 'okay thanks', 'alright thank you hydra']) assert.notEqual(spokenAnswer(t, q), 'no', t);
  for (const t of ['no', "no don't open it", 'nope']) assert.equal(spokenAnswer(t, q), 'no', t);
}

// ---- 2. Shown is not heard: only a take that started after the question's audio played answers it.
{
  const c = fakeClock();
  const a = trackAsk({ id: 'a1', route: 'overlay', question: 'Can I quit Safari?', choices: true, voice: { progress: () => true }, resolve: () => {}, ...c });
  const open = new Map([['a1', { a }]]);
  assert.equal(askForTake(open, { text: 'okay thanks', takeAt: 300 }), null, '300 ms after it showed, before it played: no');
  a.audio(0.4, 700);
  assert.equal(a.heardAt, null, 'a little audio (narration before it) is not the question');
  a.audio(2, 2700);
  assert.equal(a.heardAt, 2700);
  a.held(1000, 3000); // the owner talked over it: what was left plays 2 s later
  assert.equal(a.heardAt, 4700);
  assert.equal(askForTake(open, { text: 'yes', takeAt: 4000 }), null, 'a take while it was still to play: no');
  assert.equal(askForTake(open, { text: 'yes', takeAt: 4700 })?.said, 'yes', 'after it played: yes');
}

// ---- 5, 6, 22. The ask's own take: opens only once its question has played (never in a gap before it), closes the
// moment the ask is answered another way, more of it plays, or Stop; one take per ask.
{
  const c = fakeClock();
  const sent = [];
  const V = { id: 's1', progress: () => true };
  const st = { yesNoOpen: new Map(), turnVoice: V, voiceBusy: false, voiceEndsAt: 0, askTake: null, send: (m) => sent.push(m.type),
    Date: { now: c.now }, setTimeout: (f, ms) => c.setTimer(f, ms), clearTimeout: (h) => h && c.clearTimer(h) };
  const { askAudio, askArm, askTakeEnd } = piece('function askAudio(secs) {', 'function showAsk(', ['askAudio', 'askArm', 'askTakeEnd'], st);
  const ask = (id) => { const a = trackAsk({ id, route: 'overlay', question: 'Can I open ui.elevenlabs.io?', choices: true, voice: V, resolve: () => {}, ...c }); st.yesNoOpen.set(id, { a, voice: V }); return a; };
  ask('a1');
  c.advance(5000);
  assert.deepEqual(sent, [], 'no take before any of its audio (the quiet gap after narration)');
  askAudio(0.4); c.advance(2000);
  assert.deepEqual(sent, [], 'nor after only the narration before it');
  askAudio(2.5); c.advance(2000);
  assert.deepEqual(sent, [], 'nor while it plays');
  c.advance(2000);
  assert.deepEqual(sent, ['listen'], 'once it played: one take');
  assert.equal(st.askTake.id, 'a1');
  askAudio(0.5);
  assert.deepEqual(sent, ['listen', 'listen_cancel'], 'more of it came: that take closes');
  c.advance(2000);
  assert.deepEqual(sent, ['listen', 'listen_cancel', 'listen'], 'and opens again once it has played');
  askTakeEnd('a1');
  assert.deepEqual(sent.at(-1), 'listen_cancel', 'answered by a click: its take closes');
  st.yesNoOpen.get('a1').took = true;
  askArm('a1', st.yesNoOpen.get('a1')); c.advance(5000);
  assert.equal(sent.filter((x) => x === 'listen').length, 2, 'one take per ask: never again by itself');
  // Answered any way before it played: its take never opens.
  sent.length = 0; st.yesNoOpen.clear(); st.askTake = null;
  ask('a2'); askAudio(3);
  askTakeEnd('a2'); c.advance(10_000);
  assert.deepEqual(sent, [], 'answered before its take opened: none opens');
  // The owner's own take is open when it's due: it waits, and opens when that one ends (sidekick's voice_state idle).
  st.yesNoOpen.clear();
  ask('a3'); st.voiceBusy = true; askAudio(3); c.advance(10_000);
  assert.deepEqual(sent, [], 'not over his own take');
  st.voiceBusy = false; askArm('a3', st.yesNoOpen.get('a3')); c.advance(400);
  assert.deepEqual(sent, ['listen']);
  // Wiring.
  assert.match(side, /resolve: \(v, by\) => \{ if \(by === 'voice' && askTake\?\.id === id\) askTake = null; askTakeEnd\(id\);/, 'answered any way closes it');
  assert.match(side, /foldWait\?\.abort\(\); for \(const \[k, w\] of yesNoOpen\) \{ w\.took = true; askTakeEnd\(k\); \}/, 'Stop closes it');
  assert.match(side, /if \(w\.voice && w\.voice === voice\) \{ w\.took = true; askTakeEnd\(id\); \}/, 'the turn ending closes it');
  assert.match(side, /if \(msg\.id === turnVoice\?\.id\) askAudio\(pcmSecs\(msg\)\);/, 'fed by the turn voice chunks');
  assert.match(side, /m\.state === 'idle'\) \{ addOnTake = false; hush\(false\); askTake = null; for \(const \[id, w\] of yesNoOpen\) if \(w\.a\.voiced && !w\.took\) askArm\(id, w\);/);
  assert.doesNotMatch(side, /afterVoice: true/, 'no take on a plain quiet gap');
  assert.match(side, /for \(const \[id, w\] of yesNoOpen\) \{ w\.a\.held\(hushedAt, t\);/, 'held time counts');
}

// ---- 7, 17, 21. The pending sound during a fold wait: only for the owner's own request, never over a yes/no or asleep.
{
  const sent = [];
  const st = { foldWait: null, foldWaitOwn: false, voiceBusy: false, VOICE_ON: () => true, pendingVoice: null, turnVoice: null, busy: false, answerSaid: false,
    yesNoOpen: new Map(), pendingSent: false, power: { asleep: false }, pendingWanted, send: (m) => sent.push(m), ui: () => {} };
  const { pendingNow } = piece('function pendingNow() {', 'let interruptedAfter', ['pendingNow'], st);
  st.foldWait = new AbortController(); st.foldWaitOwn = ownTurn({ text: '(System, not Ken: these commitments are due now.)' });
  pendingNow();
  assert.deepEqual(sent, [], 'a reminder waiting for the fold: no sound');
  st.foldWaitOwn = ownTurn({ text: 'open Safari' }); pendingNow();
  assert.deepEqual(sent, [{ type: 'pending', on: true }], 'his own request: the sound');
  st.yesNoOpen.set('a', {}); pendingNow();
  assert.deepEqual(sent.at(-1), { type: 'pending', on: false }, 'not over a yes/no');
  st.yesNoOpen.clear(); pendingNow(); st.power.asleep = true; pendingNow();
  assert.deepEqual(sent.at(-1), { type: 'pending', on: false }, 'not asleep');
  assert.match(side, /const wait = foldWait = new AbortController\(\);\n    foldWaitOwn = ownTurn\(\{ text, news, intro: !!intro \}\);/);
}

// ---- 4, 16, 18. A request stopped during the fold wait goes to the thread with its line; why is the abort's reason.
{
  const block = side.slice(side.indexOf('const wait = foldWait = new AbortController();'), side.indexOf('const notReady = await readyAgent();'));
  assert.match(block, /const line = endNote\(\{ how: wait\.signal\.reason === 'sleep' \? 'sleep' : 'stop' \}\)\.line;/, 'never the stale quiet flag');
  assert.doesNotMatch(block, /quiet/);
  assert.match(block, /toThread\(turnWords, line\);\n      return;/, 'written to the thread');
  assert.match(side, /function toThread\(user, assistant\) \{ if \(hydraKey && !hydraRevoked && user\) localSync\.record\(\{ user, assistant \}\); \}/);
  assert.match(side, /else if \(foldWait\) \{ logLine\('stopped', \{ by, waiting: 'fold' \}\); foldWait\.abort\('sleep'\); \}/, 'sleep says so by its reason');
  const ac = new AbortController(); ac.abort(); assert.notEqual(ac.signal.reason, 'sleep', 'a plain Stop is a stop');
}

// ---- 8. Progress lines come back while an addition is worked on after the first answer; the pending sound with them.
{
  assert.match(side, /if \(into === 'turn'\) turnProgress\?\.resume\(\);/, 'an addition taken into the run resumes them');
  assert.match(side, /onLine: \(line\) => \{\n      ui\([^\n]*\n[^\n]*\n      if \(answerSaid\) \{ answerSaid = false; pendingNow\(\); \}/, 'a progress line after the answer brings the sound back');
  const c = fakeClock(), said = [];
  const p = startProgress({ voice: { beat() {}, progress: (l) => { said.push(l); return true; } }, live: () => true, ...c, setTimer: c.setTimer, clearTimer: c.clearTimer, random: () => 0 });
  c.advance(1200); p.pause(); c.advance(20_000);
  const n = said.length; p.resume(); c.advance(6000);
  assert.ok(said.length > n, 'resumed: lines again');
}

// ---- 9. A connected server's read of a sign-in file asks under Approve all.
{
  const H = os.homedir(); fs.mkdirSync(path.join(H, '.config'), { recursive: true }); fs.writeFileSync(path.join(H, '.config/hub'), 'oauth_token: FAKE');
  assert.equal(checkMcpCall({ name: 'read_text_file', annotations: { readOnlyHint: true }, args: { path: path.join(H, '.config/hub') }, home: H }).secret, true);
  let ran = 0;
  const mcp = { tool: async () => ({ annotations: { readOnlyHint: true }, execute: async () => { ran++; return 'oauth_token: FAKE'; } }), list: () => [] };
  const asks = [];
  const ask = async (o) => { asks.push(o.deletion); return approveAllSays(true, o) ? 'yes' : null; };
  const t = createMcpTools({ mcp, ask, isYes, userName: 'Test', checkCall: (x) => checkMcpCall({ ...x, home: H }), openUrl: async () => {}, allowActions: () => true, keyStore: 'Keychain' }).find((x) => x.name === 'use_connection');
  await assert.rejects(t.execute({ server: 'files', tool: 'read_text_file', args: JSON.stringify({ path: path.join(H, '.config/hub') }) }, {}), /said no/);
  assert.deepEqual(asks, [true]); assert.equal(ran, 0, 'approve-all never read it');
}

// ---- 10, 11, 12. Under Approve all: a plan re-asked in another app keeps its deletion tag; opening a hidden sign-in file
// asks; bringing a hidden password manager forward asks.
{
  const noop = async () => {};
  const run = async (mode, fn) => {
    fs.writeFileSync(stState, JSON.stringify({ mode })); fs.writeFileSync(stLog, '');
    const asks = [];
    const ask = async (o) => { const auto = approveAllSays(true, o); asks.push({ auto, deletion: o.deletion, q: String(o.placeholder).split('\n')[0] }); return auto || mode === 'replan' ? 'yes' : null; };
    const t = createTools({ allowActions: () => true, ui: () => {}, openUrl: noop, onCommitments: noop, showList: noop, fmtWhen: String, commitmentsText: () => '', userName: 'Test', workdir: tmp, ask });
    t.nextTurn?.();
    const r = await fn((n) => t.tools.find((x) => x.name === n)).then(String, (e) => `ERR ${e.message}`);
    return { asks, r, calls: fs.readFileSync(stLog, 'utf8').split('\n').filter(Boolean).map(JSON.parse) };
  };
  const re = await run('replan', (T) => T('act_in_app').execute({ target: 'front', steps: [{ do: 'key', key: 'delete' }] }, {}));
  const mail = re.asks.find((a) => a.q === "In Mail, every step I'd take:");
  assert.ok(mail, JSON.stringify(re));
  assert.deepEqual([mail.auto, mail.deletion], [false, true], 'the re-ask in Mail is a deletion: asked');
  fs.mkdirSync(path.join(os.homedir(), '.config'), { recursive: true });
  const hidden = path.join(os.homedir(), '.config', 'b4fix2-hub');
  fs.writeFileSync(hidden, 'oauth_token: FAKE');
  assert.equal(checkOpen(hidden, os.homedir(), { app: 'TextEdit' }).secret, true);
  try {
    const op = await run('plain', (T) => T('open').execute({ target: hidden, app: 'TextEdit' }, {}));
    assert.deepEqual(op.asks.map((a) => [a.auto, a.deletion]), [[false, true]], 'opening a sign-in file asks');
  } finally { fs.rmSync(hidden, { force: true }); }
  assert.equal(isPasswordApp('1Password'), true); assert.equal(isPasswordApp('Safari'), false);
  const vault = await run('vault', (T) => T('take_screenshot').execute({ target: '1Password' }, {}));
  assert.deepEqual(vault.asks.map((a) => [a.auto, a.deletion]), [[false, true]], 'bringing 1Password forward asks');
  assert.ok(!vault.calls.some((c) => c.fwd), 'and nothing was brought forward on a no');
  assert.ok(!fs.existsSync(launched) || !fs.readFileSync(launched, 'utf8').includes('-a TextEdit'), 'nothing opened on a no');
}

// ---- 13, 19. Folding goes on when replies end with a '?' that is no question, or when every reply asks; a question is
// kept with its answer across a system turn.
{
  let n = 0;
  const req = (end, big = 30000, u = 'r') => { const i = ++n; return [{ role: 'user', content: `${u}${i} ${'u'.repeat(300)}` }, { role: 'assistant', content: [{ type: 'tool_call', id: `c${i}`, name: 'web_fetch', args: {} }] }, { role: 'tool', content: [{ type: 'tool_result', toolCallId: `c${i}`, content: 'w'.repeat(big) }] }, { role: 'assistant', content: [{ type: 'text', text: end }] }]; };
  for (const end of ['Here are the results: https://www.google.com/search?q=orbs', 'Opened it. Anything else? Just say.', 'Done.\n\nWhy? Because you asked.', 'Want me to open it?']) {
    n = 0;
    const p = S.planFold(Array.from({ length: 14 }, () => req(end)).flat(), { trigger: 90000, scale: 1, foldCap: 40000 });
    assert.equal(p.ok, true, `${JSON.stringify(end)}: ${p.reason}`);
  }
  // Real questions still move the cut.
  for (const end of ['Should I open it in Safari or Chrome? (Say yes or no.)', 'Which one?\n1. Safari\n2. Chrome', 'Want me to open it? 🙂']) {
    n = 0;
    const C = Array.from({ length: 12 }, () => req('Done.', 6000)).flat();
    const plain = S.planFold(C, { trigger: 90_000, scale: 120_000 / S.approxTokens(C) });
    const Q = C.map((m) => ({ ...m })); Q[plain.end - 1] = { role: 'assistant', content: [{ type: 'text', text: end }] };
    assert.notEqual(S.planFold(Q, { trigger: 90_000, scale: 120_000 / S.approxTokens(C) }).end, plain.end, JSON.stringify(end));
  }
  // A '?' that is no question never moves it.
  for (const end of ['Here are the results: https://www.google.com/search?q=orbs', 'Opened it. Anything else? Just say.', 'Done.\n\nWhy? Because you asked.']) {
    n = 0;
    const C = Array.from({ length: 12 }, () => req('Done.', 6000)).flat();
    const plain = S.planFold(C, { trigger: 90_000, scale: 120_000 / S.approxTokens(C) });
    const Q = C.map((m) => ({ ...m })); Q[plain.end - 1] = { role: 'assistant', content: [{ type: 'text', text: end }] };
    assert.equal(S.planFold(Q, { trigger: 90_000, scale: 120_000 / S.approxTokens(C) }).end, plain.end, JSON.stringify(end));
  }
  n = 0;
  const A = [...Array.from({ length: 10 }, () => req('Done.', 20000, 'do a thing')).flat(), ...req('Found ui.elevenlabs.io. Want me to open it and take a screenshot of the orbs?', 20000, 'find the orbs page'),
    ...req('Your agent finished the report.', 200, '[Mon 9:00] (System, not Ken: news from your background agents.)'), ...req('Opened it.', 40000, 'yes'), ...req('Here.', 40000, 'and the volume one')];
  const p = S.planFold(A, { trigger: 90000, scale: 1, foldCap: 400000 });
  assert.equal(p.ok, true);
  assert.ok(JSON.stringify(A.slice(p.end)).includes('Want me to open it'), 'the question stays with its "yes"');
}

// ---- 14. Words added mid-run go into the saved history, in order, before the answer to them.
{
  const SESSION = 's1', ev = (event) => ({ type: 'stream_event', event, parent_tool_use_id: null, session_id: SESSION });
  let agent; const uuids = [];
  const query = ({ prompt }) => {
    const inputs = prompt[Symbol.asyncIterator]();
    async function* run() {
      const h = await inputs.next(); uuids.push(h.value.uuid);
      yield { type: 'system', subtype: 'init', session_id: SESSION };
      agent.addInput('[added] and the volume one too');
      const a = await inputs.next(); uuids.push(a.value.uuid);
      yield ev({ type: 'message_start', message: { id: 'm1', usage: { input_tokens: 5 } } });
      yield { type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Here are both orbs, and the volume one.' }] } };
      yield ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } });
      yield ev({ type: 'message_stop' });
      yield { type: 'result', subtype: 'success', is_error: false, result: 'x', session_id: SESSION, user_message_uuids: uuids };
    }
    const q = run(); q.interrupt = async () => {}; q.close = () => {}; q.getContextUsage = async () => null; return q;
  };
  agent = new ClaudeCodeAgent({ model: 'claude-opus-5-5', system: 's', tools: [], executable: '/bin/claude', cwd: '/', env: {}, query, onRateLimit: () => {}, connectors: true });
  for await (const e of agentEvents(agent.prompt('show me the orbs'))) void e;
  const hist = agent.getMessages().filter((m) => m.role !== 'system').map((m) => [m.role, typeof m.content === 'string' ? m.content : m.content.map((p) => p.text).join('')]);
  assert.deepEqual(hist, [['user', 'show me the orbs'], ['user', '[added] and the volume one too'], ['assistant', 'Here are both orbs, and the volume one.']]);
  assert.deepEqual(agent.unanswered(), []);
}

// ---- 15. A new conversation drops the fold's kept screenshots.
assert.match(side, /function freshSession\(why\) \{\n[^\n]*\n[^\n]*\n  foldImages = null;/);

// ---- 20. A brace in the model's preamble doesn't fail the fold.
{
  const J = '{"facts":[],"summary":"The owner asked to open ui.elevenlabs.io and see the orbs."}';
  assert.match(parseBrain(`Output format {facts, summary}:\n${J}`, { wantSummary: true }).summary, /orbs/);
  assert.throws(() => parseBrain('Output format {facts, summary}: none', { wantSummary: true }));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('build4efix2: all passed');
