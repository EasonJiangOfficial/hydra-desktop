// The phone view's round-9 verifier findings (RV lane, Mac side), each as a test that failed before its fix: the card
// rule stops trusting its append-only tail once a click or a cursor key moved the cursor (and a forward delete or a
// word delete is checked too); a password manager's fill item is refused on every click, not only in a login field;
// a paste is never typed blind (the helper checks the clipboard and tells what went in); a frame the phone never
// acknowledged expires, so the view cannot freeze for good.
// Run: npm test
import assert from 'node:assert/strict';
import { createRemoteView } from '../remoteview.mjs';
import { createViewGate } from '../viewgate.mjs';
import { readFileSync } from 'node:fs';
import { checkInput, editTail, movesCursor, PM_FILL } from '../remotepolicy.mjs';
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

// ---- the card rule after a cursor move ----
{
  // The last digits first, a tap at the start of the field, then the rest. Round 10: the sidecar cannot tell where the
  // tap put the cursor, so each digit after it goes to the helper marked moved, with the tail: the helper refuses it
  // from the field's own value, or by the 13-digit count when it cannot read that (remote/card.swift, its self-test).
  const s = await session();
  const h = s.h(), p = s.p();
  h.hits.all = { role: 'AXTextField', label: 'Notes', app: 'TextEdit' };
  for (const c of '1111') await s.send({ t: 'text', s: c });
  await s.send({ t: 'click', x: 0.05, y: 0.06, b: 'l', c: 1 });
  for (const c of '411111111111') await s.send({ t: 'text', s: c });
  const after = h.cmds.filter((c) => c.cmd === 'input' && c.t === 'text').slice(4);
  assert.equal(after.length, 12);
  assert.ok(after.every((c) => c.moved === true), 'every digit after the tap reaches the helper marked moved');
  assert.equal(after.at(-1).tail.replace(/\D/g, ''), '1111411111111111', 'with every digit typed in the field');
  assert.ok(h.cmds.filter((c) => c.cmd === 'input' && c.t === 'text').slice(0, 4).every((c) => c.moved === undefined), 'not before it');
  assert.deepEqual(p.of('refused').map((r) => r.why), []);
  s.view.stop();
}
{
  const moved = (tail) => ({ ...base, focus: notes, tail, moved: true });
  // After a move the helper has the 13-digit count (round 10); the sidecar still refuses a card in the last 40 typed.
  assert.deepEqual(checkInput({ t: 'key', n: 1, k: '1' }, moved('4111 1111 1111 111')), { do: 'refuse', why: 'card' });
  assert.deepEqual(checkInput({ t: 'text', n: 1, s: '1' }, moved('411111111111111')), { do: 'refuse', why: 'card' });
  assert.equal(checkInput({ t: 'text', n: 1, s: '4' }, moved('111111111111')).do, 'allow', 'twelve digits and one more: the helper decides');
  assert.equal(checkInput({ t: 'text', n: 1, s: '4' }, moved('call 202 555 0116')).do, 'allow', 'a phone number and a digit');
  assert.equal(checkInput({ t: 'text', n: 1, s: 'hello' }, moved('1111 1111 1111 1111')).do, 'allow', 'letters still go');
  // Forward delete, ctrl+d and a word or line delete can join two parts of a card too.
  for (const k of ['fwddelete', 'forwarddelete', 'ctrl+d', 'alt+delete', 'cmd+delete', 'alt+fwddelete']) {
    assert.deepEqual(checkInput({ t: 'key', n: 1, k }, moved('42111111111111111')), { do: 'refuse', why: 'card' }, k);
  }
  assert.equal(checkInput({ t: 'key', n: 1, k: 'fwddelete' }, moved('hello 1234')).do, 'allow');
  // A cursor key, a click and a delete that is not at the end leave the tail where it was: it only refuses more.
  assert.equal(editTail('1111', 'cmd+delete', true), '1111', 'cmd+delete away from the end clears nothing known');
  assert.equal(editTail('1111', 'alt+delete', true), '1111');
  assert.equal(editTail('1111', 'delete', true), '1111');
  assert.equal(editTail('1111', 'cmd+delete'), '', 'at the end it still clears the line');
  for (const k of ['left', 'right', 'up', 'home', 'end', 'cmd+left', 'alt+right', 'cmd+a', 'cmd+z', 'fwddelete', 'ctrl+a', 'cmd+v']) assert.equal(movesCursor(k), true, k);
  for (const k of ['a', '4', 'shift+4', 'delete', 'tab', 'return', 'space']) assert.equal(movesCursor(k), false, k);
  // Through the whole view: Left then Delete in the middle is refused when it leaves a card.
  const s = await session();
  const h = s.h(), p = s.p();
  await s.send({ t: 'text', s: '42111111111111111' });
  await s.send({ t: 'key', k: 'left' });
  await s.send({ t: 'key', k: 'fwddelete' });
  assert.deepEqual(h.cmds.filter((c) => c.cmd === 'input').map((c) => c.k ?? c.s), ['42111111111111111', 'left'], 'the forward delete is not sent');
  assert.deepEqual(p.of('refused').map((r) => r.why), ['card']);
  s.view.stop();
}

// ---- a password manager's fill item on every click ----
{
  const web = { role: 'AXWebArea', label: '' }, search = { role: 'AXTextField', label: 'Search' };
  const click = (hit, focus) => checkInput({ t: 'click', n: 1, x: 0.5, y: 0.5, b: 'l', c: 1 }, { ...base, focus, hit: { role: 'AXMenuItem', app: 'Google Chrome', secure: false, paste: false, ...hit } });
  for (const [label, labels] of [['Autofill', ['1Password']], ['Fill', ['Bitwarden']], ['Auto-fill login', ['Bitwarden']], ['Passwords…', []], ['Use Strong Password', []],
    ['Fill Username and Password', []], ['Select a password', ['Passwords']], ['github.com', ['Fill login', 'Bitwarden']]]) {
    for (const focus of [web, search]) assert.deepEqual(click({ label, labels }, focus), { do: 'refuse', why: 'credential' }, `${label} with focus on ${focus.role}`);
  }
  // Not a fill: a paint bucket, an ordinary menu item, a "Fill" with no password manager around it outside a login.
  assert.equal(click({ role: 'AXButton', label: 'Fill', labels: ['Tools'], app: 'Pixelmator Pro' }, web).do, 'allow');
  assert.equal(click({ label: 'Copy', labels: ['Edit'] }, search).do, 'allow');
  assert.equal(click({ label: 'Forgot password?', labels: [], role: 'AXLink' }, web).do, 'allow');
  // hit.swift's pmFillRx is the same rule (the helper's click backstop).
  const swift = readFileSync(new URL('../../src-tauri/remote/hit.swift', import.meta.url), 'utf8').match(/pmFillRx = try! NSRegularExpression\(pattern: "((?:[^"\\]|\\.)*)"/)?.[1];
  assert.ok(swift, 'hit.swift has pmFillRx');
  assert.equal(swift.replace(/\\\\/g, '\\'), PM_FILL.source, 'pmFillRx is PM_FILL');
  // Any menu item in a login field stays refused.
  assert.deepEqual(click({ label: 'Copy', labels: ['Edit'] }, { role: 'AXTextField', label: 'Email' }), { do: 'refuse', why: 'credential' });
}

// ---- a paste: the helper checks it, the tail learns what went in ----
{
  const s = await session();
  const h = s.h(), p = s.p();
  h.answer = false;
  const answer = async (extra = {}) => { const c = h.last('input'); h.emit({ ev: 'done', n: c.n, ...extra }); await flush(); await s.clock.advance(10); await flush(); };
  await s.send({ t: 'text', s: 'ref ' }); await answer();
  await s.send({ t: 'key', k: 'cmd+v' });
  assert.equal(h.last('input').tail, 'ref ', 'the helper hears the tail with the paste');
  await answer({ pasted: '411111111111' });
  await s.send({ t: 'text', s: '1111' });
  assert.deepEqual(p.of('refused').map((r) => r.why), ['card'], 'twelve pasted digits then four typed');
  assert.equal(h.cmds.filter((c) => c.cmd === 'input').length, 2, 'the last text is not sent');
  s.view.stop();
}

// ---- a frame the phone never acknowledged expires ----
{
  const s = await session({ auto: false });
  const h = s.h();
  const asked = h.count('next');
  assert.equal(asked, 2, 'two frames asked');
  h.frame(); h.frame(); // both reach the phone, which drops them (its geom came late): no ack ever
  await s.clock.advance(1_000);
  assert.equal(h.count('next'), asked, 'nothing new while they may still be acknowledged');
  await s.clock.advance(2_100);
  assert.ok(h.count('next') > asked, 'after 2 s they count as lost and more are asked');
  assert.equal(h.cmds.filter((c) => c.cmd === 'next').at(asked).key, true, 'the first one after is a key frame');
  s.view.stop();
}

console.log('remoteround9 ok');
