// Drawings stay on screen until the owner closes them (owner, 2026-11-26: "and not go away automatically"): not the
// next request, a window or page change, a click, Stop, the end of a request or the number of cards. Only a card's ×,
// Esc and Clear take them away; pinned cards survive those. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A fake hands helper (as hands.test.mjs): the front window and page are what front.json says.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkstay-test-'));
const swap = path.join(dir, 'front.json'), fake = path.join(dir, 'hands.mjs');
fs.writeFileSync(fake, `import fs from 'node:fs'; const a = process.argv.slice(2);
const win = fs.existsSync(${JSON.stringify(swap)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(swap)}, 'utf8')) : { id: 7, app: 'TextEdit', title: 'notes.txt', bounds: [0, 0, 800, 600] };
let o = { ok: true, window: win };
if (a[0] === 'find-text') o = a[2] === 'Missing' ? { ok: true, matches: [] } : { ok: true, matches: [{ text: a[2], match: 'exact', role: 'button', bounds: [100, 100, 80, 24], window: win }] };
if (a[0] === 'front') o = { ok: true, app: win.app, title: win.title, ...(win.url ? { url: win.url } : {}) };
if (a[0] === 'ui') o = { ok: true, window: win, controls: [], texts: [] };
if (a[0] === 'act') o = { ok: true, done: JSON.parse(a[1]).steps.map((s) => s.do), window: win };
console.log(JSON.stringify(o));
`);
if (['darwin', 'win32'].includes(process.platform)) process.env.ROAMIES_HANDS = fake;
const { createTools } = await import('../tools.mjs');

const events = [], drawnSegs = [];
const made = createTools({
  allowActions: () => true, ask: async () => 'Allow', openUrl: async () => {}, onCommitments: async () => {}, showList: async () => {}, fmtWhen: String, commitmentsText: () => '', userName: 'Test',
  onDrawn: (seg) => drawnSegs.push(seg),
  ui: (m) => {
    if (m.kind !== 'agent') return;
    events.push(m.e);
    if (m.e.type === 'draw') setImmediate(() => made.ink.started(m.e.id, m.e.seg));
  },
});
const draw = made.tools.find((t) => t.name === 'draw');
const note = (text) => ({ kind: 'note', text });
const gone = () => events.filter((e) => ['ink_clear', 'ink_stale'].includes(e.type));
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

// 11. A later request adds to the drawing; nothing is cleared.
made.nextTurn();
await draw.execute({ beats: [{ say: 'First.', marks: [note('first')] }] }, { toolCallId: 'a1' });
made.nextTurn();
await draw.execute({ beats: [{ say: 'Second.', marks: [note('second')] }] }, { toolCallId: 'a2' });
assert.deepEqual(gone(), [], 'no ink_clear for the next request');
assert.match(made.ink.describe(), /note “first”.*note “second”/);

// 12. Nine cards: none closed, the model is told nothing closed, all nine are listed.
made.ink.cleared(); made.nextTurn();
const nine = await draw.execute({ beats: 'abcdefghi'.split('').map((t) => ({ say: `Card ${t}.`, marks: [note(t)] })) }, { toolCallId: 'a3' });
assert.doesNotMatch(nine, /closed/);
assert.equal(made.ink.describe().split(', ').length, 9);

// 13. A new front window, a new page, the agent's own click: nothing goes.
made.ink.cleared(); made.nextTurn();
await draw.execute({ beats: [{ say: 'Here.', marks: [{ kind: 'table', title: 'Plan', columns: ['a', 'b'], rows: [['1', '2']] }, { kind: 'ring', at: { text: 'Buy' } }] }] }, { toolCallId: 'a4' });
const before = made.ink.describe();
assert.match(before, /table “Plan”.*ring “Buy”/);
fs.writeFileSync(swap, JSON.stringify({ id: 9, app: 'Safari', title: 'Other', url: 'https://example.com/b', bounds: [0, 0, 900, 700] }));
await settle(2500); // past the old 1.5 s window watch and the 0.7 s and 1.6 s page checks after a click
assert.equal(made.ink.userClick, undefined, 'a click is not watched');
await made.tools.find((t) => t.name === 'act_in_app').execute({ target: 'TextEdit', steps: [{ do: 'click_text', text: 'Next page' }] }, { toolCallId: 'a5' });
fs.writeFileSync(swap, JSON.stringify({ id: 9, app: 'Safari', title: 'Third', url: 'https://example.com/c', bounds: [0, 0, 900, 700] }));
await settle(2500);
assert.deepEqual(gone(), [], 'never ink_stale or ink_clear');
assert.equal(made.ink.describe(), before, 'still listed');
fs.rmSync(swap);

// 14. The end of a request that drew nothing leaves the screen marks (there is no end-of-request clear).
made.nextTurn();
assert.equal(made.ink.endRequest, undefined);
assert.match(made.ink.describe(), /ring “Buy”/);

// 15. Stop: one ink_stop, no clear; the overlay's ink_parts then says what's still up, and only that is kept.
events.length = 0;
made.ink.stop(true);
assert.deepEqual(events, [{ type: 'ink_stop' }]);
const [tableId] = made.ink.describe().match(/p\d+(?= table)/);
made.ink.alive([tableId]);
assert.equal(made.ink.describe(), `${tableId} table “Plan”`);

// 16. Esc (cleared) forgets all but pinned; a card's × (closed) forgets that one.
await draw.execute({ beats: [{ say: 'More.', marks: [note('pin me'), note('close me'), note('esc me')] }] }, { toolCallId: 'a7' });
const id = (t) => made.ink.describe().match(new RegExp(`(p\\d+) note “${t}”`))[1];
made.ink.pinned(id('pin me'), true);
made.ink.closed(id('close me'));
assert.doesNotMatch(made.ink.describe(), /close me/);
made.ink.cleared();
assert.match(made.ink.describe(), /^p\d+ note “pin me”$/, 'only the pinned card is left');

// 19. onDrawn hears every mark of every drawing the model makes, with its part; the app's own (fade) never.
// Regression: the old sync heard only note, card, clip and list, so the table, bars and photo drawn here were never saved.
drawnSegs.length = 0; made.nextTurn();
await draw.execute({ beats: [{ say: 'All three.', marks: [{ kind: 'table', title: 'T', columns: ['a', 'b'], rows: [['1', '2']] }, { kind: 'ring', at: { text: 'Buy' } }, note('n')] }] }, { toolCallId: 'a8' });
assert.equal(drawnSegs.length, 1);
assert.equal(drawnSegs[0].id, 'a8');
assert.deepEqual(drawnSegs[0].beats[0].marks.map((m) => [m.kind, /^p\d+$/.test(m.part)]), [['table', true], ['ring', true], ['note', true]]);
assert.equal(drawnSegs[0].beats[0].caption, 'All three.');
await made.ink.show([{ say: 'Tour.', marks: [note('tour')] }], 'tour-1', { fade: 5 });
assert.equal(drawnSegs.length, 1, 'the tour is not saved');

// 17. The overlay (ink.js): nothing fades by itself, no card cap, a card body click drags, pictures go to the note,
// and none of it can capture the screen.
const ink = fs.readFileSync(new URL('../../../roamies/ink.js', import.meta.url), 'utf8');
assert.doesNotMatch(ink, /stale\(\)/, 'no stale fade');
assert.doesNotMatch(ink, /clearDrawing\(\)/, 'a card body click never clears the drawing');
assert.doesNotMatch(ink, /MAX_CARDS/, 'no card cap');
for (const s of ['draw_image', 'draw_images_done', 'ink_saved', 'open_note', 'Saved to Notes', 'Will save to Notes']) assert.ok(ink.includes(s), s);
assert.doesNotMatch(ink, /getDisplayMedia|captureStream/, 'pictures are drawn from its own marks only');
assert.match(ink, /else if \(h\.kind === 'drag' \|\| h\.kind === 'card'\) \{ drag = /, 'the body drags');
assert.match(ink, /if \(e\.last\) \{ R\.ink\.send\?\.\(\{ type: 'draw_done', id: e\.id \}\); pictures\(e\.id\); \}/, 'pictures when a drawing finishes');
assert.match(ink, /for \(const id of \[\.\.\.drawings\.keys\(\)\]\) pictures\(id\);/, 'and when it is stopped');
assert.match(ink, /get busy\(\) \{ return G\.playing \|\| marks\.some\(\(m\) => m\.alive && !m\.pinned && !m\.chip\); \}/, 'pinned cards never count');
// The global Esc is held only while a drawing plays and a short while after (review r1): a card left on screen for
// hours never takes Esc from other apps; it has its × and the Clear chip.
assert.match(ink, /const ESC_REST = \d+;/);
assert.match(ink, /get holding\(\) \{ return G\.playing \|\| \(now\(\) < restUntil && this\.busy\); \}/);
assert.match(ink, /finally \{ G\.playing = false; G\.cur = null; restUntil = now\(\) \+ ESC_REST;/, 'the rest starts when playing ends');
// A deep explanation pages only through its own cards, never a card left from an earlier request (review r1).
assert.match(ink, /const before = \[\.\.\.new Set\(marks\.filter\(\(q\) => q\.alive && q\.card && q\.deep && deepParts\.get\(q\.part\) === deepParts\.get\(m\.part\) && /);
assert.match(ink, /const deepParts = new Map\(\);/);
// A text card's words are its note: no picture is made of it.
assert.match(ink, /if \(!d \|\| d\.done \|\| d\.sent\.has\(part\) \|\| !c \|\| TEXT_CARDS\.has\(c\.kind\)\) return;/);
// The model's clear spares pinned cards, as Esc and Clear do.
assert.match(ink, /if \(e\.do === 'clear'\) \{ sfx\('dematerialize'\); const live = marks\.filter\(\(m\) => m\.alive && !m\.pinned && /);

// 18. The host (host.js): Stop and Saved pass through; Esc reaches the overlay while a drawing is up; no stale fade.
const host = fs.readFileSync(new URL('../../../roamies/host.js', import.meta.url), 'utf8');
const pass = host.match(/const PASS = new Set\(\[([^\]]*)\]\)/)[1];
assert.ok(pass.includes("'ink_saved'") && pass.includes("'ink_stop'"), 'in the pass list');
assert.match(host, /case 'ink_stop': Roamie\.ink\?\.halt\?\.\(\); break;/);
assert.match(host, /case 'ink_saved': Roamie\.ink\?\.saved\?\.\(e\); break;/);
assert.match(host, /const up = \(\) => [^\n]*Roamie\.ink\?\.holding/, 'Esc is held while a drawing plays, and a moment after');
assert.doesNotMatch(host.match(/const up = \(\) => [^\n]*/)[0], /ink\?\.busy/, 'never for as long as a drawing is up');
assert.doesNotMatch(host, /ink_stale/);

// 20. A walkthrough that stops early (a step not found, or no click in time) still ends its drawing on the overlay, so
// its pictures are made for the note (review r1): a last, empty segment.
made.ink.cleared(); made.nextTurn(); events.length = 0;
const early = await draw.execute({ beats: [{ say: 'Here.', marks: [note('step one')] }, { say: 'Then.', marks: [{ kind: 'ring', at: { text: 'Missing' } }] }] }, { toolCallId: 'w1' });
assert.match(early, /Stopped before beat 2/);
const segsSent = events.filter((e) => e.type === 'draw' && e.id === 'w1');
assert.deepEqual(segsSent.map((e) => [e.seg, e.last, e.beats.length]), [[0, false, 1], [1, true, 0]], 'the end is sent');

// 21. The model's clear (asked by the owner) keeps pinned cards, as Esc and Clear do.
made.ink.cleared(); made.nextTurn();
await draw.execute({ beats: [{ say: 'Two.', marks: [note('keep'), note('drop')] }] }, { toolCallId: 'c1' });
made.ink.pinned(id('keep'), true);
await draw.execute({ beats: [], edit: [{ do: 'clear' }] }, { toolCallId: 'c2' });
assert.match(made.ink.describe(), /note “keep”/, 'the pinned card stays');
assert.doesNotMatch(made.ink.describe(), /drop/);

// 22. What is on screen, in every prompt: the newest parts and a count of the rest, not a list that grows all day.
made.ink.cleared(); made.nextTurn();
for (let k = 0; k < 5; k++) await draw.execute({ beats: Array.from({ length: 9 }, (_, i) => ({ say: '', marks: [note(`n${k * 9 + i}`)] })) }, { toolCallId: `m${k}` });
const listed = made.ink.describe();
assert.match(listed, /note “n44”/);
assert.doesNotMatch(listed, /note “n0”/);
assert.match(listed, / and 17 older$/, '45 drawn and the 2 pinned cards from before: 30 listed');
assert.equal(listed.split(', ').length, 30);

// 23. Stop while a draw is on its way (review r2): the overlay's ink_parts names the newest draw event it had (ev); a
// part sent after it is kept, one it had and dropped is forgotten.
made.ink.cleared(); made.nextTurn(); events.length = 0;
await draw.execute({ beats: [{ say: 'Old.', marks: [note('dropped')] }] }, { toolCallId: 'r1' });
const evHad = events.find((e) => e.type === 'draw' && e.id === 'r1').ev;
assert.ok(Number.isInteger(evHad), 'each draw event has its number');
await draw.execute({ beats: [{ say: 'New.', marks: [note('in flight')] }] }, { toolCallId: 'r2' });
assert.ok(events.find((e) => e.id === 'r2').ev > evHad);
made.ink.alive([], evHad); // the overlay had r1 (dropped it at the stop), r2 not yet
assert.match(made.ink.describe(), /note “in flight”/, 'the part on its way stays');
assert.doesNotMatch(made.ink.describe(), /dropped/);

// 24. The setup showcase clears only its own drawing (review r2): the owner's stays, and the showcase's watch asks
// about its own parts only.
made.ink.cleared(); made.nextTurn(); events.length = 0;
await draw.execute({ beats: [{ say: 'Mine.', marks: [note('owner card')] }] }, { toolCallId: 'o1' });
const isShowcase = (id) => String(id).startsWith('showcase-');
await made.ink.show([{ say: 'Look.', marks: [note('showcase card')] }], 'showcase-1', { fade: 2.5 });
assert.equal(made.ink.up(isShowcase), true);
made.ink.clear(isShowcase);
assert.deepEqual(events.filter((e) => e.type === 'ink_clear'), [{ type: 'ink_clear', ids: ['showcase-1'] }], 'only the showcase\'s drawing is cleared');
assert.match(made.ink.describe(), /^p\d+ note “owner card”$/);
assert.equal(made.ink.up(isShowcase), false, 'its watch sees it gone with the owner\'s card still up');
const side = fs.readFileSync(new URL('../sidekick.mjs', import.meta.url), 'utf8');
assert.doesNotMatch(side, /ink\.clear\(\)/, 'the app never clears the owner\'s drawings');
assert.match(side, /ink\.clear\(isShowcase\); \/\/ a replay starts clean/);
assert.match(side, /function stopShowcase\(\) \{ if \(!showcase\) return; endShowcase\('gone'\); ink\.clear\(isShowcase\); \}/);
assert.match(side, /if \(!ink\.up\(isShowcase\)\) endShowcase\('gone'\)/);
assert.match(side, /m\.type === 'ink_parts'\) ink\.alive\(m\.parts, m\.ev\)/);

// 25. The overlay side of review r2: ink_parts carries ev; a showcase clear (ids) takes only its drawing; a walkthrough
// step's marks are kept for the note's picture before they fade; moving marks stop LIVE_IDLE s after the last change;
// the Clear chip beside one card takes the screen marks only.
assert.match(ink, /if \(Number\.isInteger\(e\.ev\)\) lastEv = e\.ev;/);
assert.match(ink, /type: 'ink_parts', ev: lastEv, parts:/);
assert.match(ink, /if \(Array\.isArray\(e\.ids\)\) \{[\s\S]{0,500}fadeOut\(marks\.filter\(\(m\) => m\.alive && !m\.pinned && ids\.has\(drawnBy\.get\(m\.part\)\)\)\);\s*return;/);
assert.match(ink, /drawings\.get\(e\.id\)\?\.gone\.push\(\.\.\.gone\);[^\n]*\n\s*fadeOut\(gone, 0\.3\);/, 'step marks kept before they fade');
assert.match(ink, /const loose = \[\.\.\.d\.gone, \.\.\.marks\.filter/, 'and drawn in the marks picture');
assert.match(ink, /const LIVE_IDLE = \d+;/);
assert.match(ink, /live = full \|\| \(!G\.playing && t - until > LIVE_IDLE\) \? \[\] :/, 'no 30 fps repaint all day');
assert.match(ink, /bottomChip\(clearAll, 'clearscreen', loose && !G\.playing \? 'Clear' : null\)/);
assert.match(ink, /else if \(h\.kind === 'clearscreen'\) clearScreenMarks\(\);/);
const csm = ink.slice(ink.indexOf('function clearScreenMarks()'), ink.indexOf('function clearEverything()'));
assert.match(csm, /floats\(m\) && m\.part && !m\.pinned/, 'screen marks (and next-step buttons) only');
assert.doesNotMatch(csm, /ink_cleared/, 'never tells the sidecar everything is gone');

// 26. Two drawings with the same tool call id (Claude Code's gg_call_N, counted per MCP server; review r3): each gets an
// id of its own on the overlay and in its note, so one's pictures never go in the other's.
made.ink.cleared(); made.nextTurn(); events.length = 0; drawnSegs.length = 0;
await draw.execute({ beats: [{ say: 'A.', marks: [note('a')] }] }, { toolCallId: 'gg_call_1' });
made.nextTurn();
await draw.execute({ beats: [{ say: 'B.', marks: [note('b')] }] }, { toolCallId: 'gg_call_1' });
const ids26 = events.filter((e) => e.type === 'draw').map((e) => e.id);
assert.equal(ids26.length, 2);
assert.notEqual(ids26[0], ids26[1], 'two ids on the overlay');
assert.deepEqual(drawnSegs.map((s) => s.id), ids26, 'the same ids in the notes');

// 27. The overlay rebuilt (a screen plugged in or out, review r3): nothing is described as still up, pinned cards too.
await draw.execute({ beats: [{ say: 'Pin.', marks: [note('pinned one')] }] }, { toolCallId: 'z1' });
made.ink.pinned(made.ink.describe().match(/(p\d+) note “pinned one”/)[1], true);
made.ink.reset();
assert.equal(made.ink.describe(), '', 'every part forgotten');
const side27 = fs.readFileSync(new URL('../sidekick.mjs', import.meta.url), 'utf8');
assert.match(side27, /m\.type === 'ui_ready'\) \{[\s\S]{0,600}ink\.reset\(\); noteSync\.lost\(\);/, 'on a fresh overlay');
assert.match(side27, /onDropped: \(\{ parts \}\) => ui\(\{ kind: 'agent', e: \{ type: 'ink_saved', parts, note: null, failed: true \} \}\)/);

// 28. The overlay side of review r3.
// A next-step button with no place has no ×: the Clear chip counts it and takes it.
assert.match(ink, /const floats = \(m\) => m\.screen \|\| m\.kind === 'button';/);
assert.match(ink, /loose = up\.some\(\(m\) => floats\(m\) && !m\.pinned\)/);
// The typing mark (act_in_app) is gone after it shows: the sidecar hears it closed; it is not in the marks picture.
const typ = ink.slice(ink.indexOf('async type(m) {'), ink.indexOf('async copy(m)'));
assert.match(typ, /setTimeout\(\(\) => \{ if \(tm\.alive && !tm\.leaving\) \{ if \(m\.part\) R\.ink\.send\?\.\(\{ type: 'ink_closed', part: m\.part \}\); fadeOut\(\[tm\], 0\.1\); \} \}, 3300\);/);
assert.match(ink, /m\.screen && !m\.act && d\.parts\.has\(m\.part\)/);
// Drawings stay with the screen they were drawn on when the overlay follows the cursor to another one.
assert.match(ink, /function moved\(\) \{[\s\S]{0,700}parked\.set\(was,[\s\S]{0,200}if \(back\) marks\.push\(\.\.\.back\);/);
assert.match(ink, /\n    moved,\n/);
assert.match(ink, /parts: \[\.\.\.new Set\(\[\.\.\.marks, \.\.\.parkedMarks\(\)\]\.filter/, 'a stop still names the put-away parts as up');
assert.match(ink.slice(ink.indexOf('function clearEverything()'), ink.indexOf('function clearEverything()') + 600), /unparkAll\(\);/, 'Clear all takes them too');
assert.match(host, /window\.__roamieMoved = \(\) => \{[\s\S]{0,300}Roamie\.ink\?\.moved\?\.\(\);/);
// Esc clears drawings only while one plays or was just drawn, not because the docked agent is visible.
assert.match(host, /if \(Roamie\.ink\?\.holding\) \{ Roamie\.ink\.clear\(\{ all: true \}\); send\(\{ type: 'ink_cleared' \}\); return; \}/);
assert.doesNotMatch(host, /if \(Roamie\.ink\?\.busy\) \{ Roamie\.ink\.clear/);
// The app's own drawings (the tour, the showcase) show no Notes glyph; a note Hydra refused lets go of its chip.
assert.match(ink, /const noted = !drawnBy\.has\(m\.part\);/);
assert.match(ink, /if \(noted\) \{ const nx = x \+ w - 120/);
assert.match(ink, /\.\.\.\(noted \? \[\{ rect: \[x \+ w - 131, y \+ 2, 22, 22\], kind: 'note', part: m\.part \}\] : \[\]\)/);
assert.match(ink, /if \(e\.failed\) saved\.delete\(p\);/);

fs.rmSync(dir, { recursive: true, force: true });
console.log('ink stays tests: passed');
process.exit(0);
