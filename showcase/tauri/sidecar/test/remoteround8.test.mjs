// The phone view's round-8 verifier findings (RV lane, Mac side), each as a test that failed before its fix: a
// password manager's fill chord is refused on every remote key, not only in a login field; the card rule reads the
// digits alone (a letter a mask drops, a letter then Delete, other dashes and digits) and edits anywhere in the
// field; keys and text never reach a hidden window or a password app that holds key focus while another app is front.
// Run: npm test
import assert from 'node:assert/strict';
import { createRemoteView } from '../remoteview.mjs';
import { createViewGate } from '../viewgate.mjs';
import { checkInput, shieldsFor, focusHidden, editTail } from '../remotepolicy.mjs';
import { fakeApi, fakeClock, fakeHelper, fakePeer, flush, SESSION } from './fakeremote.mjs';

const base = { display: { w: 1000, h: 800 }, shields: [], locked: false, agent: { busy: false, owner: false }, frontSecret: false, tail: '', pay: {} };

// ---- fill chords on every key ----
{
  for (const focus of [{ role: 'AXWebArea', label: 'GitHub' }, { role: 'AXLink', label: 'Forgot?' }, { role: 'AXTextArea', label: 'Notes' }]) {
    for (const k of ['cmd+\\', 'ctrl+\\', 'cmd+shift+l', 'ctrl+shift+l', 'cmd+shift+space', 'cmd+shift+x', 'ctrl+y']) {
      assert.deepEqual(checkInput({ t: 'key', n: 1, k }, { ...base, focus }), { do: 'refuse', why: 'credential' }, `${k} with focus on ${focus.label}`);
    }
    assert.equal(checkInput({ t: 'key', n: 1, k: 'down' }, { ...base, focus }).do, 'allow', `Down on ${focus.label} (only a login field picks a sign-in)`);
    assert.equal(checkInput({ t: 'key', n: 1, k: 'cmd+l' }, { ...base, focus }).do, 'allow', 'cmd+l is not a fill chord');
  }
}

// ---- the card rule: digits alone, edits anywhere ----
{
  const ctx = (tail) => ({ ...base, focus: { role: 'AXTextField', label: '1234 1234 1234 1234' }, tail });
  assert.deepEqual(checkInput({ t: 'text', n: 1, s: '4111a1111a1111a1111' }, ctx('')), { do: 'refuse', why: 'card' }, 'letters a card mask drops');
  assert.deepEqual(checkInput({ t: 'text', n: 1, s: '4111–1111–1111–1111' }, ctx('')), { do: 'refuse', why: 'card' }, 'en-dash separators');
  assert.deepEqual(checkInput({ t: 'text', n: 1, s: '4111·1111·1111·1111' }, ctx('')), { do: 'refuse', why: 'card' }, 'middle-dot separators');
  assert.deepEqual(checkInput({ t: 'text', n: 1, s: '٤١١١ ١١١١ ١١١١ ١١١١' }, ctx('')), { do: 'refuse', why: 'card' }, 'Arabic-Indic digits');
  assert.deepEqual(checkInput({ t: 'text', n: 1, s: '۴۱۱۱ ۱۱۱۱ ۱۱۱۱ ۱۱۱۱' }, ctx('')), { do: 'refuse', why: 'card' }, 'Persian digits');
  // A letter then Delete: the tail drops what Delete removes.
  assert.equal(editTail('4111 1111 1111 11x', 'delete'), '4111 1111 1111 11');
  assert.deepEqual(checkInput({ t: 'text', n: 1, s: '11' }, ctx(editTail('4111 1111 1111 11x', 'delete'))), { do: 'refuse', why: 'card' }, 'a letter then Delete');
  // A wrong digit then Delete.
  assert.deepEqual(checkInput({ t: 'key', n: 1, k: '1' }, ctx(editTail('4111 1111 1111 1119', 'delete'))), { do: 'refuse', why: 'card' }, 'a digit then Delete');
  // After a cursor move a digit may go anywhere: Home then the card's first digit.
  assert.deepEqual(checkInput({ t: 'key', n: 1, k: '4' }, ctx('111 1111 1111 1111')), { do: 'refuse', why: 'card' }, 'the first digit typed last');
  assert.deepEqual(checkInput({ t: 'text', n: 1, s: '1' }, ctx('4111 1111 111 1111')), { do: 'refuse', why: 'card' }, 'a digit put in the middle');
  // A Delete that would leave a card in the field (a cursor moved into it: release round 2, with the cursor still at
  // the end only what the Delete leaves is read).
  assert.deepEqual(checkInput({ t: 'key', n: 1, k: 'delete' }, { ...ctx('4111 1111 15111 1111'), moved: true }), { do: 'refuse', why: 'card' }, 'a Delete inside the number');
  // Ordinary typing still goes.
  assert.equal(checkInput({ t: 'text', n: 1, s: 'see you at 10:30 on 2026-11-27' }, ctx('')).do, 'allow');
  assert.equal(checkInput({ t: 'key', n: 1, k: 'delete' }, ctx('hello 1234')).do, 'allow');
  assert.equal(editTail('abc', 'alt+delete'), '');
  assert.equal(editTail('one two', 'alt+delete'), 'one ');
  assert.equal(editTail('abc', 'left'), 'abc', 'a cursor move keeps the tail (where the cursor is is not known)');
}

// ---- keys never reach a hidden window or a password app that holds key focus ----
{
  const display = { x: 0, y: 0, w: 1512, h: 982 };
  const windows = [
    { id: 9, pid: 90, app: '1Password', bundle: 'com.1password.1password', title: 'Quick Access', bounds: [456, 200, 600, 400], layer: 3 },
    { id: 2, pid: 20, app: 'Safari', bundle: 'com.apple.Safari', title: 'Sign in - Example Bank', bounds: [0, 25, 1512, 957], layer: 0, front: true, url: 'https://example.com/login' },
  ];
  const sh = shieldsFor(windows, { home: '/Users/test', display });
  assert.equal(sh.frontSecret, false);
  const panel = { role: 'AXTextField', label: 'Search', pid: 90, app: '1Password', rect: [470, 210, 500, 30] };
  assert.equal(focusHidden(panel, windows, sh.ids), true, 'focus in the password manager panel');
  assert.equal(focusHidden({ role: 'AXTextField', label: 'Search', app: 'Bitwarden', pid: 77 }, windows, sh.ids), true, 'a password app by name');
  assert.equal(focusHidden({ role: 'AXTextField', label: 'Search', app: 'Safari', pid: 20, rect: [10, 40, 300, 30] }, windows, sh.ids), false, 'the front page');
  const ctx = { ...base, display, shields: sh.rects, focus: panel, frontSecret: sh.frontSecret || focusHidden(panel, windows, sh.ids) };
  assert.deepEqual(checkInput({ t: 'text', n: 1, s: 'example bank' }, ctx), { do: 'refuse', why: 'secret' });
  assert.deepEqual(checkInput({ t: 'key', n: 2, k: 'return' }, ctx), { do: 'refuse', why: 'secret' });

  // Through the whole view: the live focus read carries the pid; text is refused, nothing reaches the helper.
  const clock = fakeClock(), gate = createViewGate({ clock }), api = fakeApi();
  let h, p;
  const view = createRemoteView({
    api, clock, gate, home: '/Users/test', enabled: () => true, probe: async () => ({ screen: true, ax: true }), peerOk: async () => true,
    spawnHelper: () => { h = fakeHelper({ windows: windows.map((w) => ({ ...w, bounds: [w.bounds[0] * 1000 / 1512, w.bounds[1] * 800 / 982, w.bounds[2] * 1000 / 1512, w.bounds[3] * 800 / 982] })) }); h.focus = { ...panel, rect: [320, 180, 300, 20], secure: false, secureInput: false }; return h; },
    makePeer: async () => (p = fakePeer()), onStop: () => gate.stop(), log: () => {},
  });
  view.start(); await flush(); api.offer({ ...SESSION }); await flush(); p.open(); p.phone({ t: 'hello', v: 1, w: 390, h: 844, dpr: 3 }); await flush();
  p.phone({ t: 'text', n: 1, s: 'example bank' }); await flush(); await clock.advance(50); await flush();
  assert.equal(h.cmds.filter((c) => c.cmd === 'input').length, 0, 'no input reached the helper');
  assert.deepEqual(p.of('refused').map((r) => r.why), ['secret']);
  // Through the whole view: Delete shortens the tail, so a letter then Delete is caught.
  h.focus = { role: 'AXTextArea', label: '', secure: false, secureInput: false, pid: 20, app: 'Safari', rect: [10, 40, 300, 30] };
  h.emit({ ev: 'focus', ...h.focus });
  let n = 10;
  for (const m of [{ t: 'text', s: '4111 1111 1111 11x' }, { t: 'key', k: 'delete' }, { t: 'text', s: '11' }]) { p.phone({ ...m, n: ++n }); await flush(); await clock.advance(50); await flush(); }
  assert.deepEqual(h.cmds.filter((c) => c.cmd === 'input').map((c) => c.t), ['text', 'key'], 'the last text is not sent');
  assert.deepEqual(p.of('refused').map((r) => r.why), ['secret', 'card']);
  view.stop();
}

console.log('remoteround8 ok');
