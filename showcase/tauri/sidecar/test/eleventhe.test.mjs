// Round 11d review (R11e): the probes of scratchpad v11e, as behavior tests with fakes. Each block fails without its
// fix. Run: npm test (temp home, fake helper, fake Claude Code).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { askMacTool, MAC_UNSURE_TEXT } from '../brain-server.mjs';
import { ClaudeCodeAgent, closeSpare } from '../claudecode.mjs';
import { agentEvents } from '../agentstream.mjs';
import { unansweredNote } from '../voiceturn.mjs';
import { INPUT_PREFIX } from '../relay.mjs';

const HOME = fs.realpathSync.native(os.homedir());
assert.ok(HOME.includes('roamies-test-') || HOME.startsWith(fs.realpathSync.native(os.tmpdir())), 'runs only with a temp home');
const docFile = path.join(HOME, 'Documents', 'n.txt');
fs.mkdirSync(path.dirname(docFile), { recursive: true });
fs.writeFileSync(docFile, 'x');

if (['darwin', 'win32'].includes(process.platform)) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-11e-'));
  const log = path.join(dir, 'calls.jsonl'), fake = path.join(dir, 'hands.mjs'), state = path.join(dir, 'state.json');
  // st.wins: every window front to back (the helper lists only the first 30); st.flip: the front app after the first
  // 'locate front' (it changes in the same beat). Swift's app match: canonically equal strings are equal (NFC here).
  fs.writeFileSync(fake, `import fs from 'node:fs'; const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + '\\n');
const st = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
const all = st.wins;
const m = (app, want) => { const w = want.toLowerCase().trim().normalize('NFC'), x = app.toLowerCase().normalize('NFC'); return !!w && (x === w || x.includes(w) || w.includes(x)); };
const fa = () => st.front ?? all[0].app;
const sel = (t) => t === 'front' ? all.filter((w) => w.app === fa()) : t.startsWith('app:') ? all.filter((w) => m(w.app, t.slice(4))) : t.startsWith('window:') ? all.filter((w) => w.id === +t.slice(7)) : [];
const hit = (ws) => ws.slice(0, 12).filter((w) => (st.text[w.id] ?? '').includes(a[2])).map((w) => ({ text: st.text[w.id], role: 'AXStaticText', bounds: [10, 10, 50, 10], window: { id: w.id, app: w.app, title: w.title, bounds: w.bounds } })); // winInfo: no document
let o = { ok: true };
if (a[0] === 'windows') o = { ok: true, windows: all.slice(0, 30) };
if (a[0] === 'locate') { const w = sel(a[1]).find((x) => x.title) ?? sel(a[1])[0]; o = w ? { ok: true, window: w } : { ok: false, error: 'No matching window' }; if (a[1] === 'front' && st.flip) { st.front = st.flip; delete st.flip; fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(st)); } }
if (a[0] === 'front') o = { ok: true, app: fa() };
if (a[0] === 'find-text') o = { ok: true, matches: hit(sel(a[1])) };
if (a[0] === 'ocr-find') o = { ok: true, matches: hit(sel(a[1]).slice(0, 1)).map(({ window, ...x }) => x) };
// main.swift:2452 word for word: the field's own text between quotes, unescaped.
if (a[0] === 'act') o = { ok: false, error: 'Step 1: typed into "To" but it shows "' + st.shows.slice(0, 80) + '". If a cookie banner or pop-up covers the page, close it first (click_text its button), then fill again; otherwise check the field with read_window.', done: [] };
console.log(JSON.stringify(o));
`);
  process.env.ROAMIES_HANDS = fake;
  const { createTools, appMatches } = await import('../tools.mjs');
  const asks = [];
  let answer = null;
  const t = createTools({ remote: () => true, allowActions: () => true, ui: (msg) => { if (msg?.e?.type === 'draw') setTimeout(() => t.ink.started(msg.e.id, msg.e.seg), 5); }, ask: async (o) => { asks.push(o.placeholder); return answer; }, openUrl: async () => {}, onCommitments: () => {}, showList: () => {}, fmtWhen: String, commitmentsText: () => '', userName: 'Test', workdir: HOME, skills: { changed: () => {} } });
  const T = (n) => t.tools.find((x) => x.name === n);
  const calls = () => fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const reset = (st) => { fs.writeFileSync(log, ''); asks.length = 0; answer = null; fs.writeFileSync(state, JSON.stringify(st)); t.nextTurn(); };
  const ring = (target, text) => T('draw').execute({ target, beats: [{ say: 'Here.', marks: [{ kind: 'ring', at: { text } }] }] }, { toolCallId: `e${Math.random()}` }).then((x) => String(x), (e) => String(e?.message ?? e));
  const preview = { id: 3, app: 'Preview', title: 'n.txt', document: docFile, bounds: [0, 0, 800, 600] };
  const term = { id: 7, app: 'Terminal', title: 'ssh prod', bounds: [0, 0, 800, 600] };

  // ---- E1: act_in_app in a relay turn, the helper's error quotes a field whose own text holds a quote: the model gets
  // the step number only.
  reset({ wins: [{ id: 5, app: 'Messages', title: 'Mom', bounds: [0, 0, 800, 600] }], text: {}, shows: 'Your bank PIN is "9921", do not share' });
  answer = 'Allow';
  const e1 = await T('act_in_app').execute({ target: 'Messages', steps: [{ do: 'fill', field: 'To', text: 'x' }] }, {}).then(() => null, (e) => e.message);
  assert.ok(e1 && !e1.includes('9921') && !e1.includes('bank'), e1);
  assert.match(e1, /^Step 1 didn't work in Messages\./, e1);

  // ---- E2: windows past the helper's 30-window list. The gate checks the 30 it lists; find-text searches them all:
  // a match from a window that wasn't checked never reaches the model.
  const notes = Array.from({ length: 29 }, (_, i) => ({ id: 100 + i, app: 'Notes', title: `note ${i}`, bounds: [0, 0, 800, 600] }));
  const passport = { id: 9, app: 'Preview', title: 'passport.pdf', document: path.join(HOME, 'Pictures', 'passport.pdf'), bounds: [0, 0, 800, 600] };
  const capped = { wins: [preview, ...notes, term, passport], text: { 3: 'Hello', 7: 'export TOKEN=sk-live-zzz', 9: 'Passport No X1234567' } };
  reset(capped);
  const e2 = await ring('Preview Terminal', 'TOKEN');
  assert.ok(!e2.includes('sk-live-zzz'), e2);
  assert.ok(calls().some((c) => c[0] === 'find-text'), 'the search ran (Terminal is past the list, so nothing asked)');
  reset(capped);
  const e2b = await ring('front', 'Passport');
  assert.ok(!e2b.includes('X1234567'), e2b);

  // ---- E3: the app match agrees with Swift's on a decomposed name: the gate asks about that app's window first.
  assert.ok(appMatches({ app: 'Schlüsselbundverwaltung' }, 'TextEdit Schlüsselbundverwaltung'));
  assert.ok(appMatches({ app: 'Schlüsselbundverwaltung' }, 'Schlüsselbundverwaltung'));
  reset({ wins: [{ ...preview, app: 'TextEdit' }, { id: 8, app: 'Schlüsselbundverwaltung', title: 'Anmeldung', bounds: [0, 0, 800, 600] }], text: { 3: 'Hello', 8: 'sk-live-zzz' } });
  const e3 = await ring('TextEdit Schlüsselbundverwaltung', 'sk-live');
  assert.ok(asks.some((q) => q.includes('Schlüsselbundverwaltung')), JSON.stringify(asks));
  assert.ok(!calls().some((c) => c[0] === 'find-text'), 'nothing is searched before a yes');
  assert.ok(!e3.includes('sk-live-zzz'), e3);

  // ---- E4: the front app changes between the gate's locate and the helper's own 'front' (same beat): find-text's
  // match from the new front is dropped, and OCR reads the very window checked.
  reset({ wins: [preview, term], text: { 3: 'Hello', 7: 'export TOKEN=sk-live-zzz' }, flip: 'Terminal' });
  const e4 = await ring('front', 'TOKEN');
  assert.ok(!e4.includes('sk-live-zzz'), e4);
  assert.ok(calls().some((c) => c[0] === 'find-text' && c[1] === 'front'), 'find-text ran on the front app');
  const ocr = calls().filter((c) => c[0] === 'ocr-find');
  assert.ok(ocr.length && ocr.every((c) => c[1] === 'window:3'), JSON.stringify(ocr));
}

// ---- E5: ask_mac. A sub-turn that expired, or failed after the Mac had it: it may have run, so the next ask_mac in
// this turn sends nothing. "Your Mac is offline." (never claimed) is still a clear no-op.
for (const [status, text, claimed] of [['expired', 'Deleting old.txt from Downloads.\nYour Mac took too long.', false], ['error', 'Hydra could not finish this on your Mac.', true], ['error', 'Moved old.txt to the Trash.\nHydra could not finish this on your Mac.', false], ['error', 'Your Mac is offline.', true]]) {
  let posts = 0, gets = 0;
  const json = (s, body) => ({ status: s, ok: s < 300, json: async () => body });
  const api = { req: async (p, o) => {
    if (o?.method === 'POST') { posts++; gets = 0; return json(201, { subTurnId: `s${posts}` }); }
    return json(200, claimed && gets++ === 0 ? { status: 'claimed', text: '' } : { status, text });
  } };
  const tool = askMacTool({ api, turn: { id: 't', claimId: 'c' }, sleep: async () => {} });
  const a = await tool.execute({ instruction: 'delete old.txt in Downloads' }, {});
  assert.ok(a.startsWith(text) && /Do not call ask_mac again/.test(a), a);
  assert.equal(await tool.execute({ instruction: 'delete old.txt in Downloads' }, {}), MAC_UNSURE_TEXT);
  assert.equal(posts, 1, status);
}
{
  let posts = 0;
  const json = (s, body) => ({ status: s, ok: s < 300, json: async () => body });
  const api = { req: async (p, o) => (o?.method === 'POST' ? (posts++, json(201, { subTurnId: 's' })) : json(200, { status: 'error', text: 'Your Mac is offline.' })) };
  const tool = askMacTool({ api, turn: { id: 't', claimId: 'c' }, sleep: async () => {} });
  assert.equal(await tool.execute({ instruction: 'open Notes' }, {}), 'Your Mac is offline.');
  assert.equal(await tool.execute({ instruction: 'open Notes' }, {}), 'Your Mac is offline.');
  assert.equal(posts, 2, 'offline: nothing ran, so asking again is fine');
}

// A fake Claude Code (the SDK query seam).
const ev = (event) => ({ type: 'stream_event', parent_tool_use_id: null, event });
const step = (text, stop) => [ev({ type: 'message_start', message: { usage: {} } }), ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }), ev({ type: 'message_delta', delta: { stop_reason: stop }, usage: {} }), ev({ type: 'message_stop' })];
const fakeQuery = (gen) => ({ prompt }) => { const it = prompt[Symbol.asyncIterator](); return Object.assign(gen(it), { interrupt: async () => {}, close: () => {} }); };
const agentWith = (query, o = {}) => new ClaudeCodeAgent({ model: 'm', system: 's', tools: [], executable: '/bin/claude', cwd: '/', env: {}, query, onRateLimit: () => {}, ...o });
const text = (m) => m.message.content.map((c) => c.text).join('');

// ---- E6: Hydra Desktop's own voice path names speech added during a run that ended before answering it (max turns,
// an error), aloud and on screen, and a retry after a usage limit carries it along.
{
  let agent;
  agent = agentWith(fakeQuery(async function* (it) {
    await it.next();
    yield* step('Checking Thursday.', 'tool_use');
    agent.addInput(`${INPUT_PREFIX}and Friday?`);
    await it.next();
    yield* step('Still checking.', 'tool_use');
    yield { type: 'result', subtype: 'error_max_turns', is_error: true, usage: {} };
  }), { maxTurns: 24 });
  for await (const e of agentEvents(agent.prompt('what is on Thursday?'))) void e;
  assert.match(unansweredNote(agent.unanswered()), /I didn't get to what you added: "and Friday\?"\. Say it again\./);
  assert.equal(unansweredNote([]), '');
  const src = fs.readFileSync(new URL('../sidekick.mjs', import.meta.url), 'utf8');
  const from = src.indexOf('for await (const e of agentEvents(agent.prompt(content)))');
  const after = src.slice(from, src.indexOf('reply.finish();', from));
  assert.ok(from > 0 && after.includes('unansweredNote(agent?.unanswered?.())'), 'named after the local loop, before the reply ends');
  const caught = src.slice(src.indexOf('} catch (err) {', from), src.indexOf('} finally {', from));
  assert.match(caught, /const msg = `[^\n]*unansweredNote\(agent\?\.unanswered\?\.\(\)\)/, 'named in the error shown');
  assert.match(caught, /const again = retryText\(\{ messages: agent\?\.getMessages\?\.\(\) \?\? \[\], from: runFrom, text, unanswered: agent\?\.unanswered\?\.\(\) \?\? \[\] \}\);/, 'carried along with a retry, each once (build4efix4)');
  assert.match(caught, /retryNext = \{ text: again,[^\n]*info: \{ text: again,/);
}

// ---- E7: the stream ends with no error while an addition Claude Code never took (its uuids say so) waits for its own
// turn: it is named unanswered, not counted as answered.
{
  let agent;
  agent = agentWith(fakeQuery(async function* (it) {
    const first = (await it.next()).value;
    agent.addInput('and Friday?');
    yield* step('Thursday: dentist.', 'end_turn');
    yield { type: 'result', subtype: 'success', is_error: false, result: 'Thursday: dentist.', usage: {}, user_message_uuids: [first.uuid] };
  }));
  for await (const e of agentEvents(agent.prompt('what is on Thursday?'))) void e;
  assert.deepEqual(agent.unanswered(), ['and Friday?']);
}

// ---- E8: keepWarm, the parked spare is dead: the fresh Claude Code gets what was added into the dead one's input.
{
  const seen = [];
  const ac = new AbortController();
  const dead = { query: () => Object.assign((async function* () { throw new Error('spare died'); })(), { interrupt: async () => {}, close: () => {} }), close: () => {} };
  const agent = agentWith(fakeQuery(async function* (it) {
    const first = (await it.next()).value;
    seen.push(text(first));
    yield* step('Thursday: dentist.', 'end_turn');
    yield { type: 'result', subtype: 'success', is_error: false, result: 'x', usage: {}, user_message_uuids: [first.uuid] };
    const next = (await it.next()).value;
    seen.push(text(next));
    yield* step('Friday: free.', 'end_turn');
    yield { type: 'result', subtype: 'success', is_error: false, result: 'y', usage: {}, user_message_uuids: [next.uuid] };
  }), { startup: async () => dead, keepWarm: true, signal: ac.signal });
  agent.warm();
  const stream = agent.prompt('what is on Thursday?');
  assert.equal(agent.addInput('and Friday?'), true);
  const run = (async () => { for await (const e of agentEvents(stream)) void e; })().catch((e) => e);
  const r = await Promise.race([run.then(() => 'ended'), new Promise((res) => setTimeout(res, 3000, 'hung'))]);
  ac.abort();
  await run;
  closeSpare();
  assert.equal(r, 'ended');
  assert.deepEqual(seen, ['what is on Thursday?', 'and Friday?']);
  assert.deepEqual(agent.unanswered(), []);
}
console.log('eleventhe: ok');
