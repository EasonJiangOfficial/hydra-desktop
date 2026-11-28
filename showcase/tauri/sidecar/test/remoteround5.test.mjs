// The phone view's round-5 verifier findings (RV lane, Mac side), each as a test that failed before its fix: a helper
// 'changed' refusal drops the rest of a refused press and preserves the order of later keys; password-manager fill
// chords, Up and Down in a login form and an autofill click from the username
// field are refused; A3's reveal and copy buttons are refused; A3's credential labels are credential fields here and
// in the Swift backstop; card numbers with any separator, full-width digits or zero-width characters are refused.
// Run: npm test
import assert from 'node:assert/strict';
import { createRemoteView } from '../remoteview.mjs';
import { createViewGate } from '../viewgate.mjs';
import { checkInput } from '../remotepolicy.mjs';
import * as safety from '../safety.mjs';
import { revealLabel } from '../hardlimits-core.mjs';
import { swiftHas, swiftPatterns } from './swiftsync.mjs';
import { fakeApi, fakeClock, fakeHelper, fakePeer, flush, SESSION } from './fakeremote.mjs';

// ---- stale target-bound input is refused without replay ----
async function burst(msgs) {
  const clock = fakeClock(), gate = createViewGate({ clock }), api = fakeApi();
  let h, p, refuseNext = 0;
  const view = createRemoteView({
    api, clock, gate, home: '/Users/test', enabled: () => true, probe: async () => ({ screen: true, ax: true }), peerOk: async () => true,
    // As main.swift input(): the first input after a window-list change is refused 'changed'; an up while no button
    // is held releases nothing.
    spawnHelper: () => {
      h = fakeHelper(); h.answer = false; h.posted = []; let held = false;
      const send = h.send;
      h.send = (o) => {
        send(o);
        if (o.cmd !== 'input') return;
        if (refuseNext > 0) { refuseNext -= 1; queueMicrotask(() => h.emit({ ev: 'refused', n: o.n, why: 'changed' })); return; }
        if (o.t === 'down') held = true;
        if (o.t !== 'up' || held) h.posted.push(o.t + (o.s ? `:${o.s}` : o.k ? `:${o.k}` : ''));
        if (o.t === 'up') held = false;
        queueMicrotask(() => h.emit({ ev: 'done', n: o.n }));
      };
      return h;
    },
    makePeer: async () => (p = fakePeer()), onStop: () => gate.stop(), log: () => {},
  });
  view.start(); await flush(); api.offer({ ...SESSION }); await flush(); p.open(); p.phone({ t: 'hello', v: 1, w: 390, h: 844, dpr: 3 }); await flush();
  h.focus = { role: 'AXTextArea', label: 'Body', secure: false, secureInput: false };
  refuseNext = 1;
  for (const m of msgs) p.phone(m);
  await flush(30); await clock.advance(50); await flush(30);
  const out = { posted: h.posted, refused: p.of('refused') };
  view.stop();
  return out;
}
{
  const drag = await burst([{ t: 'down', n: 1, x: 0.3, y: 0.3 }, { t: 'move', n: 2, x: 0.5, y: 0.5 }, { t: 'up', n: 3, x: 0.6, y: 0.6 }]);
  assert.deepEqual(drag.posted, [], 'the stale down and the rest of its gesture never post');
  assert.deepEqual(drag.refused, [{ t: 'refused', n: 1, why: 'changed' }]);
  const typed = await burst([{ t: 'key', n: 1, k: 'delete' }, { t: 'key', n: 2, k: 'delete' }, { t: 'key', n: 3, k: 'delete' }, { t: 'text', n: 4, s: 'the' }]);
  assert.deepEqual(typed.posted, ['key:delete', 'key:delete', 'text:the'], 'later keys stay in order after the stale key is dropped');
  assert.deepEqual(typed.refused, [{ t: 'refused', n: 1, why: 'changed' }]);
}

// ---- password autofill by keyboard, and autofill clicks from the username field ----
{
  const base = { display: { w: 1000, h: 800 }, shields: [], locked: false, agent: { busy: false, owner: false }, frontSecret: false, tail: '' };
  const pw = { ...base, focus: { role: 'AXSecureTextField', label: 'Password', secure: true, secureInput: true } };
  const user = { ...base, focus: { role: 'AXTextField', label: 'Email or username', secure: false, secureInput: false } };
  const notes = { ...base, focus: { role: 'AXTextArea', label: 'Notes', secure: false, secureInput: false } };
  for (const k of ['cmd+\\', 'cmd+shift+l', 'ctrl+shift+l', 'ctrl+y', 'cmd+shift+space', 'down', 'up']) {
    assert.deepEqual(checkInput({ t: 'key', n: 1, k }, pw), { do: 'refuse', why: 'credential' }, `${k} in a password field`);
    assert.deepEqual(checkInput({ t: 'key', n: 1, k }, user), { do: 'refuse', why: 'credential' }, `${k} in the username field`);
  }
  for (const k of ['return', 'tab']) assert.equal(checkInput({ t: 'key', n: 1, k }, pw).do, 'allow', `${k} still submits or moves on`);
  assert.equal(checkInput({ t: 'key', n: 1, k: 'down' }, notes).do, 'allow', 'Down outside a login form');
  // Round 8: a fill chord fills the page's login wherever focus is, so it is refused outside a login form too.
  for (const k of ['cmd+\\', 'ctrl+y']) assert.deepEqual(checkInput({ t: 'key', n: 1, k }, notes), { do: 'refuse', why: 'credential' }, `${k} outside a login form`);
  const click = { t: 'click', n: 2, x: 0.5, y: 0.5, b: 'l', c: 1 };
  assert.deepEqual(checkInput(click, { ...user, hit: { role: 'AXMenuItem', label: 'Use password for me@example.com', app: 'Safari' } }), { do: 'refuse', why: 'credential' }, 'an autofill item from the username field');
  assert.deepEqual(checkInput(click, { ...user, hit: { role: 'AXButton', label: 'Fill with 1Password', app: 'Google Chrome' } }), { do: 'refuse', why: 'credential' });
  assert.equal(checkInput(click, { ...notes, hit: { role: 'AXMenuItem', label: 'Bold', app: 'TextEdit' } }).do, 'allow', 'a menu item outside a login form');
}

// ---- A3's reveal and copy buttons ----
{
  const ctx = { display: { w: 1000, h: 800 }, shields: [], locked: false, agent: { busy: false, owner: false }, focus: { role: 'AXWebArea', label: '' }, frontSecret: false, tail: '' };
  const click = (label) => checkInput({ t: 'click', n: 1, x: 0.5, y: 0.5, b: 'l', c: 1 }, { ...ctx, hit: { role: 'AXButton', label, app: 'Safari' } });
  for (const l of ['Show password', 'Copy password', 'Reveal recovery phrase', 'Show seed phrase', 'Show API key', 'Reveal secret key', 'Copy verification code', 'Show card number', 'Show CVV', 'Copy username and password', 'Copy 2FA'])
    assert.deepEqual(click(l), { do: 'refuse', why: 'credential' }, l);
  for (const l of ['Copy code', 'Copy link', 'Show more', 'Reply']) assert.equal(click(l).do, 'allow', l);
  // One classifier: the phone's reveal rule is A3's revealLabel (its other languages too), no copy of it.
  for (const l of ['Copy password', 'Show CVV', 'Copy username and password', 'Passwort kopieren', 'パスワードをコピー']) {
    assert.equal(revealLabel(l), true, `A3: ${l}`);
    assert.deepEqual(click(l), { do: 'refuse', why: 'credential' }, `refused from the phone: ${l}`);
  }
}

// ---- A3's credential labels: here, in the Swift backstop, and in A3 once it is here ----
{
  const yes = ['Password', 'Passkey', 'Recovery code', 'Backup code', 'Seed phrase', 'Recovery phrase', 'Security answer', 'Enter the 6-digit code', 'Social Security number', 'MM / YY', 'CVC', 'One-time code', 'Sign-in code', 'Contraseña'];
  const no = ['Name on card', 'Email', 'Subject', 'Notes', 'Search'];
  // The Swift backstop reads A3's words (CRED_FIELD_CARD, generated by test/swiftsync.mjs), on the label lower-cased.
  const swift = swiftHas().CRED_FIELD_CARD;
  assert.equal(swift, swiftPatterns().CRED_FIELD_CARD, 'hit.swift CRED_FIELD_CARD is generated from hardlimits-core.mjs');
  const swiftRx = new RegExp(swift, 'i'), low = (l) => l.normalize('NFKC').toLowerCase();
  for (const l of [...yes, 'Expiry date', 'Expiration']) {
    assert.ok(swiftRx.test(low(l)), `credential in hit.swift: ${l}`);
    assert.ok(safety.credentialField({ label: l, role: 'AXTextField' }, { cardForm: true }), `credential in A3: ${l}`);
    assert.deepEqual(checkInput({ t: 'text', n: 1, s: 'x' }, { display: { w: 1, h: 1 }, shields: [], focus: { role: 'AXTextField', label: l }, tail: '' }), { do: 'refuse', why: 'credential' }, `typing into ${l}`);
  }
  for (const l of no) { assert.ok(!safety.credentialField({ label: l, role: 'AXTextField' }, { cardForm: true }), `not credential: ${l}`); assert.ok(!swiftRx.test(low(l)), `not credential in hit.swift: ${l}`); }
}

// ---- card numbers with any separator, full-width digits or zero-width characters ----
{
  const ctx = { display: { w: 1, h: 1 }, shields: [], locked: false, agent: { busy: false, owner: false }, focus: { role: 'AXTextField', label: 'Notes' }, frontSecret: false, tail: '' };
  for (const s of ['4111.1111.1111.1111', '4111/1111/1111/1111', '4111_1111_1111_1111', '4111,1111,1111,1111', '４１１１１１１１１１１１１１１１', '4111​1111​1111​1111', '4111⁠ 1111‍1111­1111'])
    assert.deepEqual(checkInput({ t: 'text', n: 1, s }, ctx), { do: 'refuse', why: 'card' }, JSON.stringify(s));
  // Typed one key at a time with dots: the tail carries them.
  let tail = '';
  for (const c of '4111.1111.1111.111') tail += c;
  assert.deepEqual(checkInput({ t: 'key', n: 2, k: '1' }, { ...ctx, tail }), { do: 'refuse', why: 'card' }, 'keys one by one with dots');
  assert.equal(checkInput({ t: 'text', n: 3, s: 'Call 415.555.0100 at 10.30' }, ctx).do, 'allow', 'a phone number and a time are not a card');
}

console.log('remoteround5 ok');
