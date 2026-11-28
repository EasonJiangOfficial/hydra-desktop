// Drawings saved to the owner's Notes page (owner, 2026-11-26: "they should be stored on the notes page"): the note's
// doc and title, the queue on disk, pictures uploaded once, retries across a failed POST and a restart. Run: npm test
// Regression: 0 notes with source 'desktop' ever reached Hydra. The old sync sent only note, card, clip and list marks,
// and every drawing logged on this Mac was a photo, bars or table card, so nothing was ever sent.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLOSE_AFTER, HARD_CAP, createNoteSync, drawingDoc, drawingTitle, slimMark } from '../notesync.mjs';

// The contract fixture (N1 plan 5b): the web unit tests the same text.
const R0 = 'hydra-media://notes/drawn/0123456789abcdef0123456789abcdef.png', R1 = 'hydra-media://notes/drawn/fedcba9876543210fedcba9876543210.png';
const FIXTURE = [
  { type: 'paragraph', content: [{ type: 'text', text: 'Here is the monthly plan.', styles: {} }] },
  { type: 'image', props: { url: R0, name: 'table.png', caption: 'Monthly plan' } },
  { type: 'heading', props: { level: 3 }, content: [{ type: 'text', text: 'Next steps', styles: {} }] },
  { type: 'checkListItem', props: { checked: false }, content: [{ type: 'text', text: 'Call the bank', styles: {} }] },
  { type: 'image', props: { url: R1, name: 'marks.png', caption: 'Marks on screen' } },
];
const table = { kind: 'table', part: 'p1', title: 'Monthly plan', columns: ['Month', 'Plan'], rows: [['Dec', 'Save']] };
const list = { kind: 'list', part: 'p3', title: 'Next steps', items: ['Call the bank'] };
const ring = { kind: 'ring', part: 'p4', at: { text: 'Export', rect: [1, 2, 3, 4] } };
const card = { kind: 'card', part: 'p2', heading: 'Budget', text: 'Rent first.\nThen food.', items: ['Rent', 'Food'], sources: [{ name: 'Bank', url: 'https://bank.example' }] };
const beat = (caption, ...marks) => ({ caption, marks });
const rec = (segs, images = {}, extra = {}) => ({ segs: segs.map((s) => ({ id: s.id, beats: s.beats.map((b) => ({ caption: b.caption, marks: b.marks.map(slimMark) })) })), images, skipped: [], ...extra });

// 1. The doc: the fixture from its matching input, and a card with a heading, text, items and sources.
assert.deepEqual(drawingDoc(rec([{ id: 'd1', beats: [beat('Here is the monthly plan.', table, list, ring)] }], { p1: { ref: R0 }, 'd1:marks': { ref: R1 } })), FIXTURE, 'the contract fixture');
assert.deepEqual(drawingDoc(rec([{ id: 'd1', beats: [beat('Here is the monthly plan.', table, card, list, ring)] }], { p1: { ref: R0 }, 'd1:marks': { ref: R1 } })), [
  FIXTURE[0], FIXTURE[1],
  { type: 'heading', props: { level: 3 }, content: [{ type: 'text', text: 'Budget', styles: {} }] },
  { type: 'paragraph', content: [{ type: 'text', text: 'Rent first.', styles: {} }] },
  { type: 'paragraph', content: [{ type: 'text', text: 'Then food.', styles: {} }] },
  { type: 'bulletListItem', content: [{ type: 'text', text: 'Rent', styles: {} }] },
  { type: 'bulletListItem', content: [{ type: 'text', text: 'Food', styles: {} }] },
  { type: 'bulletListItem', content: [{ type: 'text', text: 'Bank (https://bank.example)', styles: {} }] },
  FIXTURE[2], FIXTURE[3], FIXTURE[4],
]);
// A picture that never came: its words instead, so the note still says it was there.
assert.deepEqual(drawingDoc(rec([{ id: 'd1', beats: [beat('', table, ring)] }]))[0], { type: 'paragraph', content: [{ type: 'text', text: '[table: Monthly plan]', styles: {} }] });
// Actions are not saved; a photo keeps none of its pixels.
assert.deepEqual(drawingDoc(rec([{ id: 'd1', beats: [beat('', { kind: 'copy', text: 'x' }, { kind: 'emote', name: 'hype' })] }])), []);
assert.equal(slimMark({ kind: 'photo', part: 'p9', query: 'Moon', data: 'data:image/png;base64,AAAA' }).data, undefined);

// 2. The title: the first card's title, heading or label; the first line said; their words; Drawing.
assert.equal(drawingTitle(rec([{ id: 'a', beats: [beat('Look.', ring, table)] }])), 'Monthly plan');
assert.equal(drawingTitle(rec([{ id: 'a', beats: [beat('Look here.', ring, { kind: 'note', text: 'no title' })] }])), 'Look here.');
assert.equal(drawingTitle(rec([{ id: 'a', beats: [beat('', ring)] }], {}, { words: 'show me my budget' })), 'show me my budget');
assert.equal(drawingTitle(rec([{ id: 'a', beats: [beat('', ring)] }])), 'Drawing');
assert.equal(drawingTitle(rec([{ id: 'a', beats: [beat('', { ...table, title: 'x'.repeat(300) })] }])).length, 120);

// A fake Hydra: every call recorded; answer(path, opts) says what it answers (an Error is a failed fetch).
const PNG0 = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, 1)]);
const PNG1 = Buffer.concat([PNG0.subarray(0, 8), Buffer.alloc(300, 2)]);
const NOTE = '6f1c2a40-1111-4222-8333-444455556666';
function fakeApi() {
  const f = { calls: [], answer: null };
  f.ok = (p) => (p.startsWith('/api/agent/notes/media') ? { status: 200, body: { ref: new URL(p, 'https://x').searchParams.get('n') === '0' ? R0 : R1 } } : { status: 201, body: { note: { id: NOTE }, created: true } });
  f.req = async (p, o) => {
    f.calls.push({ p, o });
    const a = (f.answer ?? f.ok)(p, o);
    if (a instanceof Error) throw a;
    return { status: a.status, headers: { get: (h) => a.headers?.[h.toLowerCase()] ?? null }, json: async () => a.body ?? {} };
  };
  f.notes = () => f.calls.filter((c) => c.p === '/api/agent/notes');
  f.media = () => f.calls.filter((c) => c.p.startsWith('/api/agent/notes/media'));
  return f;
}
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'notesync-test-'));
let clock = 1_000_000;
function make(dir, api, more = {}) {
  const logs = [], saved = [], pending = [];
  const sync = createNoteSync({ api, dir, pairing: () => 'a'.repeat(64), log: (d) => logs.push(d), now: () => clock, timer: () => {}, onSaved: (s) => saved.push(s), onPending: (s) => pending.push(s), ...more });
  return { sync, logs, saved, pending };
}
const records = (dir) => fs.readdirSync(dir).filter((f) => f !== 'failed');
// The drawing logged on 2026-11-25 (a table), and a list and a ring, in one request, with both pictures.
async function drawPlan(sync, turn = 1, id = 'd1') {
  sync.drawn({ id, turn, beats: [beat('Here is the monthly plan.', table, list, ring)], words: 'plan my month' });
  sync.image({ id, part: 'p1', data: PNG0.toString('base64') });
  sync.image({ id, part: 'marks', data: PNG1.toString('base64') });
  sync.imagesDone(id);
  sync.turnEnded(turn);
  await sync.flush();
}

// Private drawings cannot follow a device to a different pairing.
for (const initial of ['a'.repeat(64), null]) {
  const dir = path.join(home, initial ? 'switch' : 'unbound'), api = fakeApi();
  let pairing = initial;
  const { sync, saved } = make(dir, api, { pairing: () => pairing });
  api.answer = () => ({ status: 429, headers: { 'retry-after': '120' } });
  await drawPlan(sync);
  const calls = api.calls.length;
  pairing = 'b'.repeat(64);
  api.answer = null;
  await sync.flush();
  assert.equal(api.calls.length, calls, 'an old drawing is never sent on the new pairing');
  assert.equal(saved.length, 0);
  assert.equal(fs.readdirSync(path.join(dir, 'failed')).length, 1, 'the drawing stays private on disk');
  await drawPlan(sync, 2, 'new');
  assert.equal(api.notes().length, 1, 'a drawing from the new pairing still syncs');
}

// A pre-binding record stays on the Mac, including its pictures, when a newer app restarts.
{
  const dir = path.join(home, 'legacy'), api = fakeApi();
  api.answer = () => ({ status: 503 });
  await drawPlan(make(dir, api).sync);
  const [id] = records(dir), old = path.join(dir, id, 'note.json');
  const record = JSON.parse(fs.readFileSync(old, 'utf8'));
  delete record.pairBinding;
  fs.writeFileSync(old, JSON.stringify(record));
  const calls = api.calls.length;
  const restarted = make(dir, api);
  await restarted.sync.flush();
  assert.equal(api.calls.length, calls);
  const quarantined = path.join(dir, 'failed', id);
  assert.ok(fs.existsSync(path.join(quarantined, 'note.json')));
  assert.equal(fs.readdirSync(quarantined).filter((name) => name.endsWith('.png')).length, 2);
  assert.equal(restarted.logs.at(-1).dropped, 'pair_unbound');
}

// Switch after a flush has started, but before the device key for the upload is returned.
{
  const { hydraApi, pairingBinding } = await import('../hydramcp.mjs');
  let pairing = pairingBinding('first fixture device'), fetches = 0;
  let lookup, requested;
  const key = new Promise((resolve) => { lookup = resolve; });
  const started = new Promise((resolve) => { requested = resolve; });
  const api = hydraApi({ getKey: () => { requested(); return key; }, fetchImpl: async () => { fetches++; throw new Error('unexpected request'); } });
  const dir = path.join(home, 'switch-during-lookup');
  const queued = make(dir, api, { pairing: () => pairing });
  const pending = drawPlan(queued.sync);
  await started;
  pairing = pairingBinding('second fixture device');
  lookup('second fixture device');
  await pending;
  assert.equal(fetches, 0);
  assert.equal(queued.logs.at(-1).dropped, 'pair_changed');
  assert.equal(queued.saved.length, 0);
}

// 3. Happy path: each picture once (raw PNG bytes), then one note with the same client_id; the folder goes.
{
  const dir = path.join(home, 'q3'), api = fakeApi(), { sync, logs, saved, pending } = make(dir, api);
  await drawPlan(sync);
  const media = api.media(), [note] = api.notes();
  assert.equal(media.length, 2, 'each picture is sent once');
  const cid = note.o.body.client_id;
  assert.match(cid, /^desktop:[0-9a-f-]{36}$/);
  assert.deepEqual(media.map((c) => c.p), [0, 1].map((n) => `/api/agent/notes/media?client_id=${encodeURIComponent(cid)}&n=${n}`));
  assert.deepEqual(media.map((c) => [c.o.method, c.o.contentType, c.o.body]), [['POST', 'image/png', undefined], ['POST', 'image/png', undefined]]);
  assert.ok(media[0].o.raw.equals(PNG0) && media[1].o.raw.equals(PNG1), 'the bytes the overlay made');
  assert.deepEqual(note.o.body, { title: 'Monthly plan', doc: FIXTURE, source: 'desktop', client_id: cid }, 'the table reaches Hydra (it never did)');
  assert.equal(api.notes().length, 1);
  assert.deepEqual(records(dir), [], 'the folder is gone');
  assert.deepEqual(saved, [{ parts: ['p1', 'p3', 'p4'], noteId: NOTE }]);
  assert.deepEqual(pending, [{ parts: ['p1', 'p3', 'p4'] }], 'the overlay heard it will be saved');
  assert.deepEqual(logs.at(-1), { ok: true, created: true });
}
// The old failure exactly: one request that drew only a table (no picture came). A note still goes, with its words.
{
  const dir = path.join(home, 'only-table'), api = fakeApi(), { sync } = make(dir, api);
  sync.drawn({ id: 't', turn: 1, beats: [beat('', table)] });
  sync.imagesDone('t'); sync.turnEnded(1); await sync.flush();
  assert.equal(api.notes().length, 1, 'a table makes a note');
  assert.equal(api.notes()[0].o.body.doc[0].content[0].text, '[table: Monthly plan]');
}

// 4. Offline, 500 and 429 on the note: kept on disk and logged; the next flush sends the SAME client_id and doesn't
// upload a picture that already has its ref.
for (const fail of [new Error('fetch failed'), { status: 500 }, { status: 429 }]) {
  const dir = path.join(home, `q4-${fail.status ?? 'offline'}`), api = fakeApi(), { sync, logs } = make(dir, api);
  api.answer = (p) => (p === '/api/agent/notes' ? fail : api.ok(p));
  await drawPlan(sync);
  assert.equal(records(dir).length, 1, 'kept on disk');
  assert.deepEqual(logs.at(-1), { retry: fail.status ?? 'offline', id: api.notes()[0].o.body.client_id });
  api.answer = null;
  await sync.flush();
  const [a, b] = api.notes();
  assert.equal(b.o.body.client_id, a.o.body.client_id, 'the same client_id');
  assert.equal(api.media().length, 2, 'no picture uploaded twice');
  assert.deepEqual(records(dir), []);
}
// A picture refused (400, 413): its words go in its place, and the note still goes.
{
  const dir = path.join(home, 'q4-img'), api = fakeApi(), { sync, logs } = make(dir, api);
  api.answer = (p) => (p.includes('n=0') ? { status: 413 } : api.ok(p));
  await drawPlan(sync);
  assert.ok(logs.some((l) => l.image === 413));
  assert.equal(api.notes()[0].o.body.doc[1].content[0].text, '[table: Monthly plan]');
}

// 5. 400 and 409 on the note: moved to failed/ and logged. 401, 403 and unpaired: kept, logged as auth.
for (const status of [400, 409]) {
  const dir = path.join(home, `q5-${status}`), api = fakeApi(), { sync, logs } = make(dir, api);
  api.answer = (p) => (p === '/api/agent/notes' ? { status } : api.ok(p));
  await drawPlan(sync);
  assert.deepEqual(records(dir), []);
  assert.equal(fs.readdirSync(path.join(dir, 'failed')).length, 1, 'kept in failed/');
  assert.equal(logs.at(-1).dropped, status);
}
for (const fail of [{ status: 401 }, { status: 403 }, Object.assign(new Error('not paired'), { code: 'unpaired' })]) {
  const dir = path.join(home, `q5-${fail.status ?? 'unpaired'}`), api = fakeApi(), { sync, logs } = make(dir, api);
  api.answer = () => fail;
  await drawPlan(sync);
  assert.equal(records(dir).length, 1, 'kept for when it is paired');
  assert.deepEqual(logs.at(-1), { auth: fail.status ?? 'unpaired' });
  assert.equal(api.notes().length, 0, 'it stops at the first picture');
}

// 6. Restart: a new queue on the same folder sends what was left, with the same client_id; one left open is closed.
{
  const dir = path.join(home, 'q6'), api = fakeApi(), first = make(dir, api);
  api.answer = (p) => (p === '/api/agent/notes' ? { status: 503 } : api.ok(p));
  await drawPlan(first.sync);
  const cid = api.notes()[0].o.body.client_id;
  first.sync.drawn({ id: 'open1', turn: 2, beats: [beat('Still drawing.', { kind: 'note', part: 'p9', text: 'left open' })] }); // the app quit mid-request
  api.answer = null;
  const before = api.notes().length, again = make(dir, api);
  await again.sync.flush();
  const sent = api.notes().slice(before).map((c) => c.o.body);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].client_id, cid, 'the same note, not a new one');
  assert.equal(sent[1].title, 'Still drawing.', 'the open one was closed and sent');
  assert.equal(api.media().length, 2, 'the uploaded pictures were not sent again');
  assert.deepEqual(records(dir), []);
}

// 7. Grouping: two draw calls in one request are one note; two requests are two. Only actions: no note.
{
  const dir = path.join(home, 'q7'), api = fakeApi(), { sync, logs } = make(dir, api);
  sync.drawn({ id: 'a', turn: 5, beats: [beat('One.', { kind: 'note', part: 'p1', text: 'one' })] });
  sync.drawn({ id: 'b', turn: 5, beats: [beat('Two.', { kind: 'note', part: 'p2', text: 'two' })] });
  sync.imagesDone('a'); sync.imagesDone('b'); sync.turnEnded(5); await sync.flush();
  assert.equal(api.notes().length, 1, 'one note for the request');
  assert.deepEqual(api.notes()[0].o.body.doc.map((b) => b.content[0].text), ['One.', 'one', 'Two.', 'two']);
  sync.drawn({ id: 'c', turn: 6, beats: [beat('Three.', { kind: 'note', part: 'p3', text: 'three' })] });
  sync.imagesDone('c'); sync.turnEnded(6); await sync.flush();
  assert.equal(api.notes().length, 2, 'another request, another note');
  sync.drawn({ id: 'd', turn: 7, beats: [beat('Copied.', { kind: 'copy', text: 'x' }, { kind: 'emote', name: 'hype' })] });
  sync.imagesDone('d'); sync.turnEnded(7); await sync.flush();
  assert.equal(api.notes().length, 2, 'nothing drawn to keep: no note');
  assert.deepEqual(logs.at(-1), { skipped: 'empty' });
  // A stop before a card was drawn: that card is left out of the note.
  sync.drawn({ id: 'e', turn: 8, beats: [beat('', { kind: 'note', part: 'p5', text: 'drawn' }, { kind: 'note', part: 'p6', text: 'never drawn' })] });
  sync.imagesDone('e', ['p6']); sync.turnEnded(8); await sync.flush();
  assert.deepEqual(api.notes()[2].o.body.doc.map((b) => b.content[0].text), ['drawn']);
}
// The app's own drawings (the tour, the showcase) never reach the queue: draw() doesn't call onDrawn for them.
{
  const { createTools } = await import('../tools.mjs');
  const dir = path.join(home, 'q7-fade'), api = fakeApi(), { sync } = make(dir, api);
  const made = createTools({ allowActions: () => false, ui: (m) => { if (m.e?.type === 'draw') setTimeout(() => made.ink.started(m.e.id, m.e.seg), 1); }, ask: async () => false, openUrl: async () => {}, onCommitments: async () => {}, showList: async () => {}, fmtWhen: String, commitmentsText: () => '', userName: 'Test', onDrawn: (seg) => sync.drawn(seg) });
  await made.ink.show([{ say: 'Welcome.', marks: [{ kind: 'note', text: 'tour card' }] }], 'tour-1', { fade: 5 });
  assert.deepEqual(records(dir), [], 'no record for a drawing that goes by itself');
  await made.tools.find((t) => t.name === 'draw').execute({ beats: [{ say: 'A table.', marks: [{ kind: 'table', title: 'Plan', columns: ['a', 'b'], rows: [['1', '2']] }] }] }, { toolCallId: 'real-1' });
  assert.equal(records(dir).length, 1, 'a drawing the model made is queued');
}

// 8. Pictures never arrive: the note goes CLOSE_AFTER after the request ended, with words in their place.
{
  const dir = path.join(home, 'q8'), api = fakeApi(), { sync } = make(dir, api);
  sync.drawn({ id: 'x', turn: 1, beats: [beat('', table)] });
  sync.turnEnded(1); await sync.flush();
  assert.equal(api.notes().length, 0, 'waits for its pictures');
  clock += CLOSE_AFTER;
  await sync.flush();
  assert.equal(api.notes().length, 1);
  assert.equal(api.notes()[0].o.body.doc[0].content[0].text, '[table: Monthly plan]');
}

// 9. The queue is the owner's alone: folders 0700, files 0600.
if (process.platform !== 'win32') {
  const dir = path.join(home, 'q9'), api = fakeApi(), { sync } = make(dir, api);
  api.answer = () => ({ status: 503 });
  await drawPlan(sync);
  const [r] = records(dir);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dir, r)).mode & 0o777, 0o700);
  for (const f of fs.readdirSync(path.join(dir, r))) assert.equal(fs.statSync(path.join(dir, r, f)).mode & 0o777, 0o600, f);
}

// 10. Privacy: the sync can't take a picture of the screen; it only gets what the overlay drew.
assert.doesNotMatch(fs.readFileSync(new URL('../notesync.mjs', import.meta.url), 'utf8'), /screenshot|screencapture|hands/);
// The wiring: every drawing goes in, pictures and stops reach it, Saved to Notes reaches the overlay, the queue is sent
// when the Mac comes online or is paired.
{
  const side = fs.readFileSync(new URL('../sidekick.mjs', import.meta.url), 'utf8');
  // A relay turn's drawing is titled with that turn's own words, never the last thing said at the Mac.
  // Filed under the request's own number (review r2 case C): a relay turn's from its own store, one at the Mac its own.
  assert.match(side, /onDrawn: \(seg\) => \{ const r = relayAsk\.getStore\(\); noteSync\.drawn\(\{ \.\.\.seg, turn: r \? r\.turn \?\? seg\.turn : requestNo, words: r \? r\.words \?\? '' : turnWords, pairBinding: r \? r\.pairBinding : requestPair \}\); \}/);
  assert.match(side, /const asking = \{ live: true, turn: drawTurn, words: isSubturn\(turn\) \? '' : said\.said,/);
  assert.match(side, /const drawTurn = nextTurn\(\);\s+const drawPair = notePairing\(\);[\s\S]{0,1600}const asking = \{ live: true, turn: drawTurn,[^\n]+pairBinding: drawPair,/, 'the relay turn owns its number and pairing');
  assert.match(side, /requestNo = turn;/);
  // A drawing still playing keeps its note open (review r2): each beat the overlay starts is heard.
  assert.match(side, /m\.type === 'draw_started'\) \{ ink\.started\(String\(m\.id\), m\.seg \| 0\); noteSync\.playing\(String\(m\.id\)\);/);
  assert.match(side, /m\.type === 'draw_image'\) noteSync\.image\(/);
  assert.match(side, /m\.type === 'draw_images_done'\) noteSync\.imagesDone\(/);
  assert.match(side, /onSaved: \(\{ parts, noteId \}\) => ui\(\{ kind: 'agent', e: \{ type: 'ink_saved', parts, note: noteId \} \}\)/);
  // A request that throws (an error, a stall, a usage-limit retry, Stop) still ends its note (review r1 case C): the
  // call is in prompt()'s finally, as relayTurn's is.
  const promptSrc = side.slice(side.indexOf('async function prompt('), side.indexOf('\n}\n', side.indexOf('async function prompt(')));
  const fin = promptSrc.lastIndexOf('} finally {');
  assert.ok(fin > 0 && promptSrc.indexOf('noteSync.turnEnded(drawTurn)', fin) > fin, 'turnEnded runs in the finally');
  assert.equal(promptSrc.slice(0, fin).includes('noteSync.turnEnded('), false, 'and only there');
  assert.match(side, /\} finally \{ asking\.live = false; noteSync\.turnEnded\(drawTurn\); \}/);
  assert.match(side, /noteSync\.flush\(\); \/\/ drawings queued for this pairing while offline/);
  assert.match(side, /m\.type === 'open_note' && \/\^\[0-9a-f\]\{8\}/, 'only a note id opens a page');
  assert.match(side, /href: `\/notes\?note=\$\{m\.note\}`/);
  assert.doesNotMatch(side, /postDrawnNotes|onNotes/);
}
// The raw body for pictures (hydramcp req): sent as given, with its own content type.
{
  const { hydraApi } = await import('../hydramcp.mjs');
  let seen;
  const api = hydraApi({ base: 'https://h.test', getKey: async () => 'k'.repeat(20), fetchImpl: async (u, o) => { seen = { u, o }; return { status: 200 }; } });
  await api.req('/x', { method: 'POST', raw: PNG0, contentType: 'image/png' });
  assert.equal(seen.o.body, PNG0);
  assert.equal(seen.o.headers['Content-Type'], 'image/png');
  await api.req('/y', { method: 'POST', body: { a: 1 } });
  assert.equal(seen.o.body, '{"a":1}');
  assert.equal(seen.o.headers['Content-Type'], 'application/json');
}
// 11. One record that keeps failing never holds up the rest (head-of-line, review r1 case A), and its picture is never
// given up on (review r2: a short 404, 503 or 429 used to delete the drawing for good after 8 tries and send words).
for (const status of [404, 502, 503]) {
  const dir = path.join(home, `q11-${status}`), api = fakeApi(), { sync, logs } = make(dir, api);
  api.answer = (p) => (p.startsWith('/api/agent/notes/media') ? { status, body: { error: 'x' } } : api.ok(p));
  sync.drawn({ id: 'd1', turn: 1, beats: [beat('a', table)] }); sync.image({ id: 'd1', part: 'p1', data: PNG0.toString('base64') }); sync.imagesDone('d1'); sync.turnEnded(1);
  sync.drawn({ id: 'd2', turn: 2, beats: [beat('b', { kind: 'note', part: 'p2', text: 'hello' })] }); sync.imagesDone('d2'); sync.turnEnded(2);
  await sync.flush();
  assert.deepEqual(api.notes().map((c) => c.o.body.title), ['b'], 'the text note is not stuck behind the failing picture');
  for (let i = 0; i < 20; i++) await sync.flush();
  assert.equal(api.notes().length, 1, `${status}: the drawing is not sent without its picture`);
  assert.equal(records(dir).length, 1, 'it stays queued');
  const [r] = records(dir);
  assert.ok(fs.readdirSync(path.join(dir, r)).some((f) => f.endsWith('.png')), 'with its PNG');
  assert.ok(!logs.some((l) => l.image), 'never given up');
  api.answer = null;
  await sync.flush();
  assert.equal(api.notes()[1].o.body.doc[1].type, 'image', 'once Hydra takes it, the note has the picture');
  assert.deepEqual(records(dir), []);
}
// 429 (and Retry-After): the flush stops there, nothing after it is tried, and nothing is sent until the wait is over,
// even when a new drawing or coming online asks for a flush.
{
  const dir = path.join(home, 'q11-429'), api = fakeApi(), { sync } = make(dir, api);
  api.answer = () => ({ status: 429, headers: { 'retry-after': '120' } });
  sync.drawn({ id: 'd1', turn: 1, beats: [beat('a', { kind: 'note', part: 'p1', text: 'one' })] }); sync.imagesDone('d1'); sync.turnEnded(1);
  sync.drawn({ id: 'd2', turn: 2, beats: [beat('b', { kind: 'note', part: 'p2', text: 'two' })] }); sync.imagesDone('d2'); sync.turnEnded(2);
  await sync.flush();
  assert.equal(api.calls.length, 1, 'busy: the second record is not tried');
  clock += 60_000; await sync.flush();
  assert.equal(api.calls.length, 1, 'Retry-After is honoured');
  api.answer = null; clock += 61_000; await sync.flush();
  assert.deepEqual(api.notes().slice(1).map((c) => c.o.body.title), ['a', 'b']);
  assert.deepEqual(records(dir), []);
}
// Offline: one try for the whole queue, nothing given up (an offline try is not counted).
{
  const dir = path.join(home, 'q11-off'), api = fakeApi(), { sync } = make(dir, api);
  api.answer = () => new Error('fetch failed');
  sync.drawn({ id: 'd1', turn: 1, beats: [beat('a', table)] }); sync.image({ id: 'd1', part: 'p1', data: PNG0.toString('base64') }); sync.imagesDone('d1'); sync.turnEnded(1);
  sync.drawn({ id: 'd2', turn: 2, beats: [beat('b', { kind: 'note', part: 'p2', text: 'hello' })] }); sync.imagesDone('d2'); sync.turnEnded(2);
  await sync.flush();
  const c0 = api.calls.length;
  for (let i = 0; i < 10; i++) await sync.flush();
  assert.equal(api.calls.length - c0, 10, 'offline: one call a flush');
  api.answer = null;
  await sync.flush();
  assert.equal(api.notes()[0].o.body.doc[1].type, 'image', 'the picture still went');
  assert.deepEqual(records(dir), []);
}

// 12. A draw id used again while an older note is queued (gg_call_1 after a restart, review r1 case B): the new
// drawing's picture goes to the new note; the old note keeps its own.
{
  const dir = path.join(home, 'q12'), api = fakeApi(), first = make(dir, api);
  api.answer = () => new Error('fetch failed');
  first.sync.drawn({ id: 'gg_call_1', turn: 1, beats: [beat('', { ...table, title: 'old' })] });
  first.sync.image({ id: 'gg_call_1', part: 'p1', data: PNG0.toString('base64') }); first.sync.imagesDone('gg_call_1'); first.sync.turnEnded(1);
  await first.sync.flush();
  const { sync } = make(dir, api); // restart: ids and parts start again
  sync.drawn({ id: 'gg_call_1', turn: 1, beats: [beat('', { ...table, title: 'new' })] });
  sync.image({ id: 'gg_call_1', part: 'p1', data: PNG1.toString('base64') }); sync.imagesDone('gg_call_1'); sync.turnEnded(1);
  api.answer = null;
  const c0 = api.calls.length;
  await sync.flush();
  const sent = Object.fromEntries(api.notes().map((c) => [c.o.body.title, c.o.body.doc]));
  const media = api.calls.slice(c0).filter((c) => c.p.startsWith('/api/agent/notes/media'));
  assert.equal(media.length, 2);
  const byNote = Object.fromEntries(media.map((c) => [decodeURIComponent(new URL(c.p, 'https://x').searchParams.get('client_id')), c.o.raw[8]]));
  const cid = (t) => api.notes().find((c) => c.o.body.title === t).o.body.client_id;
  assert.equal(byNote[cid('old')], 1, 'the old note keeps the old picture');
  assert.equal(byNote[cid('new')], 2, 'the new note gets the new picture');
  assert.equal(sent.new[0].type, 'image', 'the new note has its picture (no placeholder)');
}

// 13. A text card's picture is never kept (its words are the note): no file, nothing uploaded.
{
  const dir = path.join(home, 'q13'), api = fakeApi(), { sync } = make(dir, api);
  sync.drawn({ id: 'd1', turn: 1, beats: [beat('', { kind: 'note', part: 'p1', text: 'words' })] });
  sync.image({ id: 'd1', part: 'p1', data: PNG0.toString('base64') });
  const [r] = records(dir);
  assert.deepEqual(fs.readdirSync(path.join(dir, r)), ['note.json'], 'no PNG for a text card');
  sync.imagesDone('d1'); sync.turnEnded(1); await sync.flush();
  assert.equal(api.media().length, 0);
}

// 14. Each picture keeps the upload number it was first given, so two can never share one path: p2 is sent as n=0, p3
// fails; a late stop then says p1 was never drawn, and p3 is still sent as n=1 (not n=0, p2's path).
{
  const dir = path.join(home, 'q14'), api = fakeApi(), { sync } = make(dir, api);
  const t = (part) => ({ ...table, part, title: part });
  sync.drawn({ id: 'd1', turn: 1, beats: [beat('', t('p1'), t('p2'), t('p3'))] });
  sync.image({ id: 'd1', part: 'p2', data: PNG0.toString('base64') });
  sync.image({ id: 'd1', part: 'p3', data: PNG1.toString('base64') });
  sync.turnEnded(1);
  clock += CLOSE_AFTER; // p1's picture never came: the note is closed
  api.answer = (p) => (p.includes('n=1') ? { status: 503 } : api.ok(p));
  await sync.flush();
  api.answer = null;
  await sync.flush();
  assert.deepEqual(api.media().map((c) => [c.o.raw[8], new URL(c.p, 'https://x').searchParams.get('n')]), [[1, '0'], [2, '1'], [2, '1']]);
}
// A picture sent again after REF_DAYS goes to a new path (Hydra's sweep counts from when a path was first written).
{
  const dir = path.join(home, 'q14-old'), api = fakeApi(), { sync } = make(dir, api);
  api.answer = (p) => (p === '/api/agent/notes' ? { status: 503 } : api.ok(p));
  sync.drawn({ id: 'd1', turn: 1, beats: [beat('', table)] });
  sync.image({ id: 'd1', part: 'p1', data: PNG0.toString('base64') }); sync.imagesDone('d1'); sync.turnEnded(1);
  await sync.flush();
  clock += 8 * 24 * 60 * 60_000;
  await sync.flush();
  assert.deepEqual(api.media().map((c) => new URL(c.p, 'https://x').searchParams.get('n')), ['0', '1']);
}

// 15. Two requests at once (a relay turn and one at the Mac, review r2 case C): the second one's drawing never closes
// the first's note, and the first's picture still goes in it.
{
  const dir = path.join(home, 'q15'), api = fakeApi(), { sync } = make(dir, api);
  sync.drawn({ id: 'relayDraw', turn: 5, beats: [beat('', table)] });
  sync.drawn({ id: 'localDraw', turn: 6, beats: [beat('', { kind: 'note', part: 'p2', text: 'hi' })] });
  sync.imagesDone('localDraw'); sync.turnEnded(6); await sync.flush();
  assert.deepEqual(api.notes().map((c) => c.o.body.doc.map((b) => b.type)), [['paragraph']], 'only the request that ended is sent');
  sync.image({ id: 'relayDraw', part: 'p1', data: PNG0.toString('base64') }); sync.imagesDone('relayDraw');
  sync.drawn({ id: 'relayDraw2', turn: 5, beats: [beat('', { kind: 'note', part: 'p3', text: 'more' })] }); sync.imagesDone('relayDraw2');
  sync.turnEnded(5); await sync.flush();
  assert.equal(api.media().length, 1, 'the relay turn\'s picture is uploaded');
  assert.deepEqual(api.notes()[1].o.body.doc.map((b) => b.type), ['image', 'paragraph'], 'one note for the relay turn, picture and all');
}
// 16. After a restart, a note queued in an earlier run never marks a card on screen now (review r2 case B): part ids
// start again at p1 each run.
{
  const dir = path.join(home, 'q16'), api = fakeApi(), first = make(dir, api);
  api.answer = () => new Error('fetch failed');
  first.sync.drawn({ id: 'd1', turn: 1, beats: [beat('x', { kind: 'note', part: 'p1', text: 'hello' })] }); first.sync.imagesDone('d1'); first.sync.turnEnded(1);
  await first.sync.flush();
  api.answer = null;
  const before = api.notes().length, again = make(dir, api);
  await again.sync.flush();
  assert.equal(api.notes().length - before, 1, 'the old note is sent');
  assert.deepEqual(records(dir), []);
  assert.deepEqual(again.saved, [], 'but no card of this run is marked saved');
  assert.deepEqual(again.pending, []);
}
// 17. Pictures that come long after the request ended (a deep explanation's pages, review r2): each picture or beat
// heard keeps the note open; it is sent with them all once the overlay says it is done.
{
  const dir = path.join(home, 'q17'), api = fakeApi(), { sync } = make(dir, api);
  const t = (part) => ({ ...table, part, title: part });
  sync.drawn({ id: 'deep', turn: 1, beats: [beat('', t('p1')), beat('', t('p2')), beat('', t('p3'))] });
  sync.turnEnded(1);
  clock += 4 * 60_000; sync.image({ id: 'deep', part: 'p1', data: PNG0.toString('base64') });
  clock += 4 * 60_000; sync.playing('deep');
  clock += 4 * 60_000; sync.image({ id: 'deep', part: 'p2', data: PNG0.toString('base64') });
  clock += 4 * 60_000; await sync.flush();
  assert.equal(api.notes().length, 0, '16 minutes after the request ended, still open');
  sync.image({ id: 'deep', part: 'p3', data: PNG1.toString('base64') }); sync.imagesDone('deep'); await sync.flush();
  assert.deepEqual(api.notes()[0].o.body.doc.map((b) => b.type), ['image', 'image', 'image'], 'every page is a picture');
}
// The hard cap: kept open by beats, it is still sent HARD_CAP after the request ended; one whose end was never heard,
// HARD_CAP after the last thing heard.
{
  const dir = path.join(home, 'q17-cap'), api = fakeApi(), { sync } = make(dir, api);
  sync.drawn({ id: 'long', turn: 1, beats: [beat('', table)] }); sync.turnEnded(1);
  for (let m = 0; m < HARD_CAP; m += 4 * 60_000) { clock += 4 * 60_000; sync.playing('long'); }
  await sync.flush();
  assert.equal(api.notes().length, 1, 'sent at the hard cap');
  sync.drawn({ id: 'lost', turn: 2, beats: [beat('', { kind: 'note', part: 'p9', text: 'end never heard' })] });
  clock += HARD_CAP - 1000; await sync.flush();
  assert.equal(api.notes().length, 1);
  clock += 1000; await sync.flush();
  assert.equal(api.notes().length, 2, 'an end never heard: sent HARD_CAP after its last drawing');
}
// 18. A small whole PNG (67 bytes: signature, IHDR, IDAT, IEND) is a picture, not a placeholder.
{
  const tiny = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex');
  assert.equal(tiny.length, 67);
  const dir = path.join(home, 'q18'), api = fakeApi(), { sync } = make(dir, api);
  sync.drawn({ id: 'd1', turn: 1, beats: [beat('', table)] }); sync.image({ id: 'd1', part: 'p1', data: tiny.toString('base64') }); sync.imagesDone('d1'); sync.turnEnded(1);
  await sync.flush();
  assert.ok(api.media()[0]?.o.raw.equals(tiny), 'uploaded');
}

// 19. Head of line (review r3): one note Hydra keeps failing with a 500 no longer holds up the newer ones after a few
// tries; it is still tried, and still kept.
{
  const dir = path.join(home, 'q19'), api = fakeApi(), { sync } = make(dir, api);
  api.answer = (p, o) => (p === '/api/agent/notes' && o.body.title === 'Old' ? { status: 500 } : api.ok(p));
  sync.drawn({ id: 'o', turn: 1, beats: [beat('', { kind: 'note', part: 'p1', title: 'Old', text: 'old' })] }); sync.imagesDone('o'); sync.turnEnded(1);
  sync.drawn({ id: 'n', turn: 2, beats: [beat('', { kind: 'note', part: 'p2', title: 'New', text: 'new' })] }); sync.imagesDone('n'); sync.turnEnded(2);
  for (let k = 0; k < 3; k++) { clock += 10 * 60_000; await sync.flush(); }
  const titles = api.notes().map((c) => c.o.body.title);
  assert.deepEqual(titles.slice(0, titles.indexOf('New') + 1), ['Old', 'Old', 'Old', 'New'], 'the newer note goes after 3 failures of the old one');
  assert.equal(titles.filter((t) => t === 'New').length, 1);
  assert.equal(sync.pending, 1, 'the old one is kept');
  await sync.flush();
  assert.equal(api.notes().at(-1).o.body.title, 'Old', 'and still tried');
}
// 20. A first 401 (the owner session behind Hydra's bridge renewing, review r3) is tried again soon, once; a second
// one waits for pairing.
{
  const dir = path.join(home, 'q20'), api = fakeApi(), timers = [];
  const { sync, logs } = make(dir, api, { timer: (f, ms) => timers.push({ f, ms }) });
  api.answer = (p) => (p === '/api/agent/notes' ? { status: 401 } : api.ok(p));
  await drawPlan(sync);
  assert.ok(logs.some((l) => l.auth === 401));
  const again = timers.filter((t) => t.ms <= 60_000);
  assert.equal(again.length, 1, 'one short retry is armed');
  api.answer = null;
  again[0].f(); await sync.flush();
  assert.deepEqual(records(dir), [], 'saved on the retry');
  // Twice in a row: parked (no second short retry).
  const dir2 = path.join(home, 'q20b'), api2 = fakeApi(), timers2 = [];
  const b = make(dir2, api2, { timer: (f, ms) => timers2.push({ f, ms }) });
  api2.answer = (p) => (p === '/api/agent/notes' ? { status: 401 } : api2.ok(p));
  await drawPlan(b.sync);
  timers2.filter((t) => t.ms <= 60_000)[0].f(); await b.sync.flush();
  assert.equal(timers2.filter((t) => t.ms <= 60_000).length, 1, 'no endless short retries');
  assert.equal(records(dir2).length, 1, 'kept for when it is paired');
}
// 21. Refused for good (400): the overlay hears it will never be saved, so no "Will save to Notes" stays up (review r3).
{
  const dir = path.join(home, 'q21'), api = fakeApi(), dropped = [];
  const { sync } = make(dir, api, { onDropped: (d) => dropped.push(d) });
  api.answer = (p) => (p === '/api/agent/notes' ? { status: 400 } : api.ok(p));
  await drawPlan(sync);
  assert.deepEqual(dropped, [{ parts: ['p1', 'p3', 'p4'] }]);
}
// 22. The overlay rebuilt (a screen plugged in or out, review r3): pictures it owed never come, so the note goes now
// with words for them, not CLOSE_AFTER later.
{
  const dir = path.join(home, 'q22'), api = fakeApi(), { sync } = make(dir, api);
  sync.drawn({ id: 'd1', turn: 1, beats: [beat('', table)] }); sync.turnEnded(1); await sync.flush();
  assert.equal(api.notes().length, 0, 'waits for its picture');
  sync.lost(); await sync.flush();
  assert.equal(api.notes().length, 1, 'sent once the overlay is gone');
  assert.equal(api.notes()[0].o.body.doc[0].content[0].text, '[table: Monthly plan]');
}

fs.rmSync(home, { recursive: true, force: true });
console.log('note sync tests: passed');
process.exit(0);
