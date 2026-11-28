// The hands tools (macOS and Windows) against a fake hands helper: act_in_app drops read-only steps, screenshots use the helper's own
// resize, and an app that isn't installed gives a plain answer. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (!['darwin', 'win32'].includes(process.platform)) { console.log('hands tests: skipped (macOS and Windows only)'); process.exit(0); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-hands-test-'));
// A .mjs helper runs on this Node (tools.mjs), so the same fake works on Windows.
const log = path.join(dir, 'calls.jsonl'), fake = path.join(dir, 'hands.mjs');
fs.writeFileSync(fake, `import fs from 'node:fs'; const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + '\\n');
const swap = ${JSON.stringify(path.join(dir, 'front.json'))};
const win = fs.existsSync(swap) ? JSON.parse(fs.readFileSync(swap, 'utf8')) : { id: 7, app: 'TextEdit', title: 'notes.txt', bounds: [0, 0, 800, 600] };
let o = { ok: true, window: win };
if (a[0] === 'act') { const p = JSON.parse(a[1]); o = p.app === 'NoSuchAppRoamiesTest' ? { ok: false, error: 'No matching window is open.' } : { ok: true, done: p.steps.map((s) => s.do), window: win }; }
// Live progress on stderr, as the real helpers write it: where each step lands, what it types, when it takes the cursor.
if (a[0] === 'act' && JSON.parse(a[1]).app === 'HopTest') {
  for (const d of [{ ev: 'start', window: win, steps: 3 }, { ev: 'step', i: 0, do: 'click', label: 'Save', bounds: [100, 200, 80, 24] }, { ev: 'step', i: 1, do: 'key', label: 'cmd+a' },
    { ev: 'borrow' }, { ev: 'step', i: 2, do: 'type', label: '', text: 'my secret words', bounds: [300, 400, 200, 30] }, { ev: 'return' }]) console.error('@' + JSON.stringify(d));
  console.error('not progress');
}
if (a[0] === 'act' && JSON.parse(a[1]).app === 'HoverTest') console.error('@' + JSON.stringify({ ev: 'step', i: 0, do: 'hover', label: 'Q3 report', bounds: [100, 200, 80, 24] }));
if (a[0] === 'find-text') o = { ok: true, matches: [{ text: a[2], match: 'exact', role: 'button', bounds: [100, 100, 80, 24], window: win }] };
if (a[0] === 'ui') o = { ok: true, window: win, controls: [], texts: [], note: 'Nothing to list.' };
if (a[0] === 'front') { if (win.slowFront) { const t = Date.now(); while (Date.now() - t < 2000); } o = { ok: true, app: win.app, title: win.title, ...(win.url ? { url: win.url } : {}) }; }
if (a[0] === 'capture') { fs.writeFileSync(a[1], 'x'); o = { ok: true, file: a[1], window: win, pixels: [800, 600] }; }
console.log(JSON.stringify(o));
`);
process.env.ROAMIES_HANDS = fake;
// macOS's open, as it answers: an app that isn't installed exits 1 with "Unable to find application"; anything else
// opens nothing here (the test never reaches the real Mac, and runs the same under a stub PATH).
if (process.platform === 'darwin') {
  fs.writeFileSync(path.join(dir, 'open'), '#!/bin/sh\nfor a in "$@"; do case "$a" in *NoSuchAppRoamiesTest*) echo "Unable to find application named \'$a\'" >&2; exit 1;; esac; done\nexit 0\n', { mode: 0o755 });
  process.env.PATH = `${dir}:${process.env.PATH}`;
}
const { createTools } = await import('../tools.mjs');
const noop = async () => {};
// The owner says yes to every plan here (owner's rule: each one asks); what the questions say is tested elsewhere.
const { tools } = createTools({ allowActions: () => true, ui: () => {}, ask: async () => 'Allow', openUrl: noop, onCommitments: noop, showList: noop, fmtWhen: String, commitmentsText: () => '', userName: 'Test' });
const tool = (n) => tools.find((t) => t.name === n);
const calls = () => fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const ctx = { toolCallId: 't1' };

// read_window / take_screenshot inside act_in_app steps are dropped, not a failed call.
fs.writeFileSync(log, '');
const r = await tool('act_in_app').execute({ target: 'TextEdit', steps: [{ do: 'key', key: 'cmd+end' }, { do: 'read_window' }, { do: 'type', text: 'hi' }] }, ctx);
assert.match(r, /key, type/);
const act = calls().find((c) => c[0] === 'act');
assert.deepEqual(JSON.parse(act[1]).steps.map((s) => s.do), ['key', 'type']);
assert.ok(!calls().some((c) => c[0] === 'capture'), 'no window pictures taken while it works in an app');
// Regression: only a read_window step failed the call; it reads the window instead.
assert.match(await tool('act_in_app').execute({ target: 'TextEdit', steps: [{ do: 'read_window' }] }, ctx), /^TextEdit — notes\.txt/);
assert.ok(!calls().some((c) => c[0] === 'act' && JSON.parse(c[1]).steps.length === 0), 'no empty act sent');

// Screenshots ask the helper to shrink to 1568 px and use the size it reports.
fs.writeFileSync(log, '');
const shot = await tool('take_screenshot').execute({ target: 'TextEdit' }, ctx);
assert.match(shot.content[0].text, /800×600 px/);
assert.ok(calls().some((c) => c[0] === 'capture' && c[3] === '1568'));
// Shot at once with nothing shown on screen: no window lookup first, no preview copy for an animation.
assert.ok(!calls().some((c) => c[0] === 'locate'), 'no locate round trip before the shot');
assert.equal(calls().find((c) => c[0] === 'capture').length, 4, 'no preview thumbnail requested');

// While it acts, the overlay hears where each step lands (in order) and when the real cursor is taken, between
// "on" and "off". Never what is typed.
{
  const seen = [];
  const made = createTools({ allowActions: () => true, ui: (m) => { if (m.kind === 'hands') seen.push(m); }, ask: async () => false, openUrl: noop, onCommitments: noop, showList: noop, fmtWhen: String, commitmentsText: () => '', userName: 'Test' });
  await made.hands('act', JSON.stringify({ app: 'HopTest', steps: [{ do: 'click', id: 1 }, { do: 'key', key: 'cmd+a' }, { do: 'type', text: 'my secret words' }] }));
  assert.deepEqual(seen, [{ kind: 'hands', on: true }, { kind: 'hands', step: { bounds: [100, 200, 80, 24] } }, { kind: 'hands', borrow: true },
    { kind: 'hands', step: { bounds: [300, 400, 200, 30] } }, { kind: 'hands', on: false }]);
  assert.ok(!JSON.stringify(seen).includes('secret'), 'typed text never reaches the overlay');
  // Reading a window is not acting: nothing is sent.
  seen.length = 0;
  await made.hands('ui', 'front');
  assert.deepEqual(seen, []);
}

// Hover: rests the pointer on a card so its hover-only ⋯ menu shows; the overlay's hand hops there without a tap.
{
  const seen = [];
  const made = createTools({ allowActions: () => true, ui: (m) => { if (m.kind === 'hands') seen.push(m); }, ask: async () => false, openUrl: noop, onCommitments: noop, showList: noop, fmtWhen: String, commitmentsText: () => '', userName: 'Test' });
  await made.hands('act', JSON.stringify({ app: 'HoverTest', steps: [{ do: 'hover', text: 'Q3 report' }] }));
  assert.deepEqual(seen.find((m) => m.step), { kind: 'hands', step: { bounds: [100, 200, 80, 24], hover: true } });
  // A hover step reaches the helper as given, before the click on what it revealed.
  fs.writeFileSync(log, '');
  await tool('act_in_app').execute({ target: 'TextEdit', steps: [{ do: 'hover', text: 'Q3 report', near: 'Reports' }, { do: 'click_text', text: 'More options', near: 'Q3 report' }] }, ctx);
  assert.deepEqual(JSON.parse(calls().find((c) => c[0] === 'act')[1]).steps[0], { do: 'hover', text: 'Q3 report', near: 'Reports' });
  // x, y are screenshot pixels, mapped to screen points like click_at.
  await tool('take_screenshot').execute({ target: 'TextEdit' }, ctx);
  fs.writeFileSync(log, '');
  await tool('act_in_app').execute({ target: 'TextEdit', steps: [{ do: 'hover', x: 400, y: 300 }] }, ctx);
  assert.deepEqual(JSON.parse(calls().find((c) => c[0] === 'act')[1]).steps[0], { do: 'hover', x: 400, y: 300, global: true });
}

// An app that isn't installed: one clear answer instead of "No matching window".
await assert.rejects(tool('act_in_app').execute({ target: 'NoSuchAppRoamiesTest', steps: [{ do: 'key', key: 'return' }] }, ctx), /no app called "NoSuchAppRoamiesTest"/);
await assert.rejects(tool('open').execute({ target: 'NoSuchAppRoamiesTest' }, ctx), /no app called "NoSuchAppRoamiesTest"/);

// A bare web address opens as a link (in the app asked for), not as an app called "example.com".
const opened = await tool('open').execute({ target: 'example.invalid-tld-roamies.test', app: 'NoSuchAppRoamiesTest' }, ctx).catch((e) => String(e.message));
assert.match(opened, /no app called "NoSuchAppRoamiesTest"/, 'treated as a link opened in the named app');

// draw: a walkthrough waits for each click, and each next step is looked up only after it (the screen has changed).
{
  fs.writeFileSync(log, '');
  const sent = [], spoken = [], other = [];
  let clicks = 0, hold = false;
  const drawAsks = [];
  const made = createTools({
    allowActions: () => true, ask: async (o) => { drawAsks.push(o.placeholder); return 'Allow'; }, openUrl: noop, onCommitments: noop, showList: noop, fmtWhen: String, commitmentsText: () => '', userName: 'Test',
    speak: (t) => { spoken.push(t); return true; },
    ui: (m) => {
      if (m.e?.type?.startsWith('ink_')) other.push(m.e);
      if (m.e?.type !== 'draw') return;
      sent.push({ ...m.e, lookups: calls().filter((c) => c[0] === 'find-text').map((c) => c[2]) });
      setImmediate(() => {
        made.ink.started(m.e.id, m.e.seg);
        const last = m.e.beats.at(-1);
        if (last?.wait && !hold) setTimeout(() => { clicks++; made.ink.waitDone(m.e.id, last.n, 'clicked'); }, 5);
      });
    },
  });
  const draw = made.tools.find((t) => t.name === 'draw');
  const step = (say, text) => ({ say, marks: [{ kind: 'target', at: { text }, label: text }], wait: 'click' });
  const res = await draw.execute({ beats: [step('[warm] Open Format first.', 'Format'), step('Then pick High.', 'High')] }, { toolCallId: 'd1' });
  assert.equal(clicks, 2);
  assert.deepEqual(sent.map((e) => [e.seg, e.beats.map((b) => b.n), e.last]), [[0, [1], false], [1, [2], true]], 'one segment per waiting step');
  assert.deepEqual(sent[0].lookups, ['Format'], 'step 2 is not looked up before step 1 is clicked');
  assert.deepEqual(sent[1].lookups, ['Format', 'High']);
  assert.deepEqual(sent[0].beats[0].at, undefined);
  assert.deepEqual(sent[0].beats[0].marks[0].at.rect, [100, 100, 80, 24], 'exact bounds from the helper');
  assert.equal(sent[0].beats[0].caption, 'Open Format first.', 'the caption drops voice cues');
  assert.equal(sent[0].beats[0].voiced, true);
  assert.deepEqual(spoken, ['[warm] Open Format first.', 'Then pick High.'], 'each line is spoken when its step starts');
  assert.match(res, /Drew p1 target “Format”, p2 target “High”\..*Beat 1: Test clicked\..*Beat 2: Test clicked\./);
  // Regression: after a walkthrough the reply said each step again. The result quotes what was already said, last.
  assert.match(res, /Already said out loud as it drew: "Open Format first\." "Then pick High\." Don't repeat or rephrase any of that in your reply/);
  // An explanation without waits: each beat goes out as soon as its own places are found (the first marks draw while
  // the rest are looked up), all spoken in order, and the same words are looked up once.
  sent.length = 0; spoken.length = 0; fs.writeFileSync(log, '');
  const ring = (text) => ({ kind: 'ring', at: { text } });
  await draw.execute({ beats: [{ say: 'One.', marks: [ring('A'), { kind: 'connect', at: { text: 'A' }, to: { text: 'B' } }] }, { say: 'Two.', marks: [ring('C')] }, { say: 'Three.', marks: [ring('D')] }] }, { toolCallId: 'd5' });
  assert.deepEqual(sent.map((e) => [e.seg, e.last]), [[0, false], [1, false], [2, true]]);
  assert.deepEqual(sent[0].lookups, ['A', 'B'], 'beat 1 is sent before beats 2 and 3 are looked up, and "A" is looked up once');
  assert.deepEqual(spoken, ['One.', 'Two.', 'Three.']);
  // Edits name what's there; unknown parts are refused with the list.
  await assert.rejects(draw.execute({ edit: [{ do: 'recolor', part: 'p9', tone: 'red' }] }, { toolCallId: 'd2' }), /no p9 on screen now \(there is: p1 target “Format”, p2 target “High”, p3 ring “A”/);
  assert.match(await draw.execute({ edit: [{ do: 'recolor', part: 'p1', tone: 'red' }] }, { toolCallId: 'd3' }), /Edited the drawing/);
  // Owner, 2026-11-26: "and not go away automatically". A drawing in a later request adds to what's there; an edit
  // keeps it too. Nothing is cleared.
  made.nextTurn();
  await draw.execute({ edit: [{ do: 'recolor', part: 'p1', tone: 'amber' }] }, { toolCallId: 'd6' });
  made.nextTurn();
  await draw.execute({ beats: [{ say: 'A card.', marks: [{ kind: 'note', text: 'hi' }] }] }, { toolCallId: 'd7' });
  assert.ok(!other.some((e) => e.type === 'ink_clear'), 'nothing cleared by the next request');
  assert.match(await draw.execute({ beats: [{ say: 'Another.', marks: [{ kind: 'note', text: 'two' }] }] }, { toolCallId: 'd8' }), /On screen now: p1 target “Format”, .*p\d+ note “hi”, p\d+ note “two”\./, 'cards add up, the old marks stay');
  // Another window comes to the front: the drawing stays (no ink_stale), and the model still knows it's there.
  fs.writeFileSync(path.join(dir, 'front.json'), JSON.stringify({ id: 9, app: 'Safari', title: 'x', bounds: [0, 0, 900, 700] }));
  await new Promise((r) => setTimeout(r, 1800));
  assert.ok(!other.some((e) => e.type === 'ink_stale' || e.type === 'ink_clear'), 'a window change takes nothing away');
  assert.match(await draw.execute({ edit: [{ do: 'erase', part: 'p1' }] }, { toolCallId: 'd9' }), /Edited the drawing/);
  fs.rmSync(path.join(dir, 'front.json'));
  // Typing goes through the helper's fill (the same path as act_in_app), and asks first with the app and the text
  // (owner's rule); the helper gets the yes for that plan in that app.
  fs.writeFileSync(log, ''); drawAsks.length = 0;
  await draw.execute({ beats: [{ say: 'Your email goes here.', marks: [{ kind: 'type', at: { text: 'Email' }, text: 'a@b.com' }] }] }, { toolCallId: 'd4' });
  const typedPlan = JSON.parse(calls().find((c) => c[0] === 'act')[1]);
  assert.deepEqual(typedPlan.steps, [{ do: 'fill', field: 'Email', text: 'a@b.com' }]);
  assert.deepEqual([typedPlan.wholeOk, typedPlan.planApp], [['plan'], 'TextEdit']);
  assert.deepEqual(drawAsks, ['In TextEdit, every step I\'d take:\n1. fill "Email" with "a@b.com"']);
  // Regression: talking over a walkthrough that waits for a click left its caption up, still waiting.
  made.nextTurn(); hold = true;
  const talk = new AbortController();
  const cut = draw.execute({ beats: [step('Click the Scale box.', 'Scale'), step('Then type 130.', 'Scale')] }, { toolCallId: 'd9', signal: talk.signal });
  while (!sent.some((e) => e.id === 'd9')) await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => setTimeout(r, 20));
  talk.abort();
  assert.equal(await cut, 'Stopped.');
  assert.deepEqual(other.at(-1), { type: 'ink_stop' }, 'the overlay stops playing; what it drew stays');
  hold = false;
  // Cut off before it got to waiting: it stops at once instead of waiting out the timeout.
  const early = new AbortController(); early.abort();
  const t0 = Date.now();
  assert.equal(await draw.execute({ beats: [step('Click Scale.', 'Scale')] }, { toolCallId: 'd10', signal: early.signal }), 'Stopped.');
  assert.ok(Date.now() - t0 < 5000, 'no wait for the timeout');
  // Stop while it was drawing diagrams: the overlay stops playing them (ink_stop); what was drawn stays up.
  made.nextTurn();
  await draw.execute({ beats: [{ say: 'A diagram.', marks: [{ kind: 'note', text: 'diagram' }] }] }, { toolCallId: 'd11' });
  other.length = 0;
  made.ink.stop(true);
  assert.deepEqual(other, [{ type: 'ink_stop' }], 'only playing stops');
  assert.match(made.ink.describe(), /note “diagram”/, 'the diagram stays');
  made.ink.cleared();
  await draw.execute({ beats: [{ say: 'Another.', marks: [{ kind: 'note', text: 'kept' }] }] }, { toolCallId: 'd12' });
  other.length = 0;
  made.ink.stop();
  assert.deepEqual(other, [{ type: 'ink_stop' }]);
  assert.match(made.ink.describe(), /note “kept”/);
  // Regression: a pinned card stays on screen through Esc, a window change and the next drawing, but the sidecar forgot
  // it, so the model didn't know it was there. It's remembered until its × (or an explicit clear edit).
  {
    const kept = made.ink.describe().match(/(p\d+) note “kept”/)[1];
    made.ink.pinned(kept, true);
    made.ink.cleared();
    assert.match(made.ink.describe(), /note “kept”/, 'Esc keeps a pinned card');
    made.nextTurn();
    await draw.execute({ beats: [{ say: 'New.', marks: [{ kind: 'note', text: 'new' }] }] }, { toolCallId: 'd12b' });
    assert.match(made.ink.describe(), /note “kept”.*note “new”/, 'a new drawing adds to it');
    made.ink.cleared();
    assert.match(made.ink.describe(), /^p\d+ note “kept”$/, 'Esc takes the rest, not the pinned card');
    made.ink.pinned(kept, false);
    made.ink.cleared();
    assert.equal(made.ink.describe(), '', 'unpinned, it goes with the rest');
  }
  // Ten cards at once: all ten stay (no cap closes the oldest; owner, 2026-11-26).
  made.nextTurn();
  const many = await draw.execute({ beats: 'abcdefghij'.split('').map((text) => ({ say: `Card ${text}.`, marks: [{ kind: 'note', text }] })) }, { toolCallId: 'd13' });
  assert.match(many, /Drew p\d+ note “a”, .*p\d+ note “j”\./, 'all ten are named as drawn');
  assert.doesNotMatch(many, /closed/);
  assert.match(many, /On screen now: p\d+ note “a”, (p\d+ note “[b-i]”, ){8}p\d+ note “j”\./);
  // Talking over a drawing that waits for a click: it stops playing (ink_stop); the cards from before stay.
  made.nextTurn(); hold = true; other.length = 0;
  const over = new AbortController();
  const half = draw.execute({ beats: [step('Click Scale.', 'Scale')] }, { toolCallId: 'k3', signal: over.signal });
  while (!sent.some((e) => e.id === 'k3')) await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => setTimeout(r, 20));
  over.abort();
  assert.equal(await half, 'Stopped.');
  hold = false;
  assert.deepEqual(other, [{ type: 'ink_stop' }]);
  assert.match(made.ink.describe(), /note “a”.*note “j”/, 'the cards stay');
  console.log('draw tool tests: passed');
}

// Regression: a borrowed real click landed on the Sidekick's bubble instead of the app (and its Cmd+A selected the
// overlay). The overlay goes click-through before the helper acts, and back after, even when acting fails.
{
  fs.writeFileSync(log, '');
  const seen = [];
  const t = createTools({ allowActions: () => true, ui: (m) => { if (m.kind === 'hands') seen.push({ on: m.on, acted: fs.readFileSync(log, 'utf8').includes('["act"') }); }, ask: async () => 'Allow', openUrl: noop, onCommitments: noop, showList: noop, fmtWhen: String, commitmentsText: () => '', userName: 'Test' }).tools;
  await t.find((x) => x.name === 'act_in_app').execute({ target: 'TextEdit', steps: [{ do: 'key', key: 'return' }] }, ctx);
  assert.deepEqual(seen, [{ on: true, acted: false }, { on: false, acted: true }], 'click-through on before acting, off after');
  seen.length = 0;
  await t.find((x) => x.name === 'act_in_app').execute({ target: 'NoSuchAppRoamiesTest', steps: [{ do: 'key', key: 'return' }] }, ctx).catch(() => {});
  assert.equal(seen.at(-1)?.on, false, 'click-through released after a failed act');
}

fs.rmSync(dir, { recursive: true, force: true });
console.log('hands tests: passed');

// Live "where am I" line: app, window title and page, without query strings; '' when nothing is known.
{
  const { frontLine } = await import('../tools.mjs');
  const l = frontLine({ app: 'Google Chrome', title: 'Inbox (3) - me@example.com - Gmail', url: 'https://mail.google.com/mail/u/0/?tab=rm&token=SECRET#inbox' }, 'Ken');
  assert.match(l, /Right now Ken is in Google Chrome — "Inbox \(3\) - me@example.com - Gmail" \(mail\.google\.com\/mail\/u\/0\)/);
  assert.match(l, /overrides any app or page from earlier/);
  assert.ok(!/SECRET|tab=/.test(l), 'query string dropped');
  assert.equal(frontLine({ app: 'Notes', url: 'file:///Users/x/secret.txt' }), '- Right now The user is in Notes. This was just checked and overrides any app or page from earlier messages; they can still ask about something elsewhere.');
  assert.equal(frontLine({}), '');
  assert.equal(frontLine(null), '');
  console.log('front line tests: passed');
}

