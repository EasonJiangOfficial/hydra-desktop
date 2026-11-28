// The phone view's round-10 findings (RV lane, Mac side), each as a test that failed before its fix: after a click or
// a cursor key the helper decides the card rule from the field's own value (the 13-digit count only when it cannot
// read it), so ordinary digits in a note with a date or a phone number go; a password manager's bare name refuses a
// click only on a menu or a browser's toolbar, not in a link, a message or a file name; a frame acknowledged late is
// not a lost one, so a slow link is not sent a whole key frame almost every frame.
// Run: npm test
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRemoteView } from '../remoteview.mjs';
import { createViewGate } from '../viewgate.mjs';
import { checkInput, PM_FILL, PM_NAME } from '../remotepolicy.mjs';
import { fakeApi, fakeClock, fakeHelper, fakePeer, flush, SESSION } from './fakeremote.mjs';

const base = { display: { w: 1000, h: 800 }, shields: [], locked: false, agent: { busy: false, owner: false }, frontSecret: false, tail: '', pay: {} };
const notes = { role: 'AXTextField', label: 'Notes', secure: false, secureInput: false, buttons: [] };

async function session({ auto = true } = {}) {
  const clock = fakeClock(), gate = createViewGate({ clock }), api = fakeApi();
  let h, p;
  const view = createRemoteView({
    api, clock, gate, home: '/Users/test', enabled: () => true, probe: async () => ({ screen: true, ax: true }), peerOk: async () => true,
    spawnHelper: () => { h = fakeHelper({ auto }); h.focus = { ...notes, pid: 20, app: 'TextEdit', rect: [10, 40, 300, 30] }; return h; },
    makePeer: async () => (p = fakePeer()), onStop: () => gate.stop(), log: () => {},
  });
  view.start(); await flush(); api.offer({ ...SESSION }); await flush(); p.open(); p.phone({ t: 'hello', v: 1, w: 390, h: 844, dpr: 3 }); await flush();
  h.emit({ ev: 'focus', ...h.focus });
  let n = 0;
  const send = async (m) => { p.phone({ ...m, n: ++n }); await flush(); await clock.advance(50); await flush(); };
  return { clock, view, h: () => h, p: () => p, send };
}

// ---- ordinary digits after a click or a cursor key ----
for (const [text, move, digit] of [
  ['Meeting 2026-11-27 at 10:30', { t: 'click', x: 0.05, y: 0.06, b: 'l', c: 1 }, '5'],
  ['call +1 202 555 0115', { t: 'click', x: 0.05, y: 0.06, b: 'l', c: 1 }, ' 221B'],
  ['Invoice 2026-114 due 11/30, total 4,250', { t: 'key', k: 'left' }, '0'],
]) {
  const s = await session();
  const h = s.h(), p = s.p();
  h.hits.all = { role: 'AXTextField', label: 'Notes', app: 'TextEdit' };
  await s.send({ t: 'text', s: text });
  await s.send(move);
  await s.send({ t: 'text', s: digit });
  assert.deepEqual(p.of('refused').map((r) => r.why), [], `${text}, a move, then "${digit}" is not refused`);
  const last = h.last('input');
  assert.equal(last.s, digit, 'the digit reaches the helper');
  // The helper checks the field's own value; when it cannot read it, it counts the digits (remote/card.swift).
  assert.equal(last.moved, true, 'the helper hears the cursor moved');
  assert.ok(last.tail.endsWith(digit), 'with the tail, this input included');
  s.view.stop();
}
{
  // A digit still goes after 300 more letters.
  const s = await session();
  const p = s.p();
  await s.send({ t: 'text', s: 'call +1 202 555 0115' });
  await s.send({ t: 'key', k: 'left' });
  await s.send({ t: 'text', s: 'a'.repeat(300) });
  await s.send({ t: 'text', s: '7' });
  assert.deepEqual(p.of('refused').map((r) => r.why), []);
  s.view.stop();
}
{
  // Not moved: the sidecar's own rule still refuses a card typed at the end, and the helper is not told moved.
  const s = await session();
  const h = s.h(), p = s.p();
  await s.send({ t: 'text', s: '411111111111111' });
  await s.send({ t: 'text', s: '1' });
  assert.deepEqual(p.of('refused').map((r) => r.why), ['card']);
  assert.equal(h.last('input').moved, undefined);
  s.view.stop();
}
// The sidecar alone, moved: a card that the digits typed this session make is still refused there.
assert.deepEqual(checkInput({ t: 'text', n: 1, s: '1' }, { ...base, focus: notes, tail: 'ref 411111111111111', moved: true }), { do: 'refuse', why: 'card' });
assert.equal(checkInput({ t: 'text', n: 1, s: '5' }, { ...base, focus: notes, tail: 'Meeting 2026-11-27 at 10:30', moved: true }).do, 'allow');

// ---- a password manager's bare name: only on a menu or a browser's toolbar ----
{
  const web = { role: 'AXWebArea', label: '' };
  const click = (hit) => checkInput({ t: 'click', n: 1, x: 0.5, y: 0.5, b: 'l', c: 1 }, { ...base, focus: web, hit: { app: 'Google Chrome', secure: false, paste: false, ...hit } });
  for (const [what, hit] of [
    ['a search result link', { role: 'AXLink', label: 'Bitwarden review 2026', labels: ['Bitwarden review 2026', '', '', ''], roles: ['AXLink', 'AXGroup', 'AXGroup', 'AXWebArea'] }],
    ['static text in a Slack message', { role: 'AXStaticText', label: 'can you share the 1Password vault link?', labels: ['can you share the 1Password vault link?', '', '', ''], roles: ['AXStaticText', 'AXGroup', 'AXGroup', 'AXGroup'], app: 'Slack' }],
    ['a Finder file', { role: 'AXTextField', label: 'Keychain notes.txt', labels: ['Keychain notes.txt', '', '', ''], roles: ['AXTextField', 'AXCell', 'AXRow', 'AXOutline'], app: 'Finder' }],
    ['a button in a group titled LastPass setup', { role: 'AXButton', label: 'Next', labels: ['Next', 'LastPass setup', '', ''], roles: ['AXButton', 'AXGroup', 'AXWebArea', 'AXScrollArea'] }],
    ['no roles from the helper', { role: 'AXLink', label: 'Bitwarden review 2026', labels: ['Bitwarden review 2026', '', ''] }],
  ]) assert.equal(click(hit).do, 'allow', what);
  for (const [what, hit] of [
    ['a context menu item under the Bitwarden submenu', { role: 'AXMenuItem', label: 'github.com', labels: ['github.com', 'Bitwarden', '', ''], roles: ['AXMenuItem', 'AXMenu', 'AXMenuItem', 'AXMenu'] }],
    ['the Bitwarden menu item itself', { role: 'AXMenuItem', label: 'Bitwarden', labels: ['Bitwarden', '', '', ''], roles: ['AXMenuItem', 'AXMenu', 'AXMenu', 'AXApplication'] }],
    ['an extension button in the browser toolbar', { role: 'AXPopUpButton', label: '1Password', labels: ['1Password', '', '', ''], roles: ['AXPopUpButton', 'AXGroup', 'AXToolbar', 'AXWindow'] }],
    ['a fill phrase anywhere', { role: 'AXButton', label: 'Autofill', labels: ['Autofill', '', '', ''], roles: ['AXButton', 'AXGroup', 'AXWebArea', 'AXScrollArea'] }],
  ]) assert.deepEqual(click(hit), { do: 'refuse', why: 'credential' }, what);
  // hit.swift has the same two rules (the helper's click backstop).
  const swift = readFileSync(new URL('../../src-tauri/remote/hit.swift', import.meta.url), 'utf8');
  const rx = (name) => swift.match(new RegExp(`${name} = try! NSRegularExpression\\(pattern: "((?:[^"\\\\]|\\\\.)*)"`))?.[1]?.replace(/\\\\/g, '\\');
  assert.equal(rx('pmFillRx'), PM_FILL.source, 'pmFillRx is PM_FILL');
  assert.equal(rx('pmNameRx'), PM_NAME.source, 'pmNameRx is PM_NAME');
  assert.ok(!PM_FILL.test('Bitwarden review 2026') && PM_NAME.test('Bitwarden review 2026'));
}

// ---- a slow link: a late ack is not a lost frame ----
for (const [delay, most] of [[1500, 1], [2600, 2]]) {
  const s = await session({ auto: false });
  const h = s.h(), p = s.p();
  for (let i = 0; i < 12; i++) {
    const f = h.frame();
    await s.clock.advance(delay);
    p.phone({ t: 'ack', f, ms: delay }); await s.clock.advance(10);
  }
  const keys = h.cmds.filter((c) => c.cmd === 'next' && c.key).length;
  assert.ok(keys <= most, `acks ${delay} ms late: ${keys} key frames asked in 12 frames (at most ${most})`);
  const last = h.cmds.filter((c) => c.cmd === 'next').at(-1);
  assert.deepEqual([last.q, last.scale], [0.3, 0.5], 'the quality still steps down');
  s.view.stop();
}

console.log('remoteround10 ok');
