// The phone view's rules (RV plan section 7, T-D2-1 and T-D2-2): what the stream hides and what remote input never
// does. Pure functions, no Mac. Run: npm test
import assert from 'node:assert/strict';
import os from 'node:os';
import { checkInput, shieldsFor, cardTail } from '../remotepolicy.mjs';

const home = os.homedir();
const display = { id: 1, x: 0, y: 0, w: 1000, h: 800 };
const win = (id, app, title = '', extra = {}) => ({ id, pid: id, app, bundle: '', title, bounds: [100, 100, 400, 300], ...extra });

// ---- T-D2-2 shieldsFor ----
{
  const list = [
    win(1, '1Password'),
    win(2, 'Passwords', 'Passwords'),
    win(3, 'Safari', 'Bitwarden Web Vault', { url: 'https://vault.bitwarden.com/#/vault', front: true }),
    win(4, 'TextEdit', 'notes.txt', { document: `${home}/Documents/notes.txt` }),
    win(5, 'Preview', 'id_rsa', { document: `${home}/.ssh/id_rsa` }),
    win(6, 'Safari', 'Hacker News', { url: 'https://news.ycombinator.com/' }),
  ];
  const s = shieldsFor(list, { home, display });
  assert.deepEqual(s.ids.sort(), [1, 2, 3, 5], '1Password, Passwords, a vault tab and a secret file are hidden; TextEdit and a news page are not');
  assert.deepEqual(s.exclude.sort(), [1, 2], 'password apps are left out of the capture by window id');
  assert.equal(s.frontSecret, true, 'the front window is a vault');
  assert.deepEqual(s.rects[0], [100, 100, 400, 300], 'rects are in display points');
  // A window on another display, or half off this one, is clipped to the viewed display.
  const off = shieldsFor([win(9, '1Password', '', { bounds: [900, 700, 400, 300] }), win(10, 'Bitwarden', '', { bounds: [1200, 0, 100, 100] })], { home, display });
  assert.deepEqual(off.rects, [[900, 700, 100, 100]], 'clipped to the display; one off it is not sent');
  assert.deepEqual(shieldsFor([win(4, 'TextEdit')], { home, display }).rects, [], 'TextEdit shows');
  // A display that is not at the origin: rects are relative to it.
  const d2 = { id: 2, x: 1000, y: -200, w: 800, h: 600 };
  assert.deepEqual(shieldsFor([win(11, '1Password', '', { bounds: [1100, -100, 200, 200] })], { home, display: d2 }).rects, [[100, 100, 200, 200]]);
}

// ---- T-D2-1 checkInput ----
const base = { display, shields: [[100, 100, 400, 300]], locked: false, agent: { busy: false, owner: false }, hit: { role: 'AXButton', label: 'Reply', app: 'Mail' }, focus: { role: 'AXTextField', label: 'Subject', secure: false, secureInput: false }, frontSecret: false, tail: '' };
const at = (px, py) => ({ x: px / 1000, y: py / 800 });
{
  assert.deepEqual(checkInput({ t: 'click', n: 1, ...at(200, 200), b: 'l', c: 1 }, base), { do: 'refuse', why: 'secret' }, 'a click inside a shield');
  assert.deepEqual(checkInput({ t: 'scroll', n: 1, ...at(200, 200), dx: 0, dy: 10 }, base), { do: 'refuse', why: 'secret' }, 'a scroll inside a shield');
  assert.deepEqual(checkInput({ t: 'down', n: 1, ...at(450, 350), }, base), { do: 'refuse', why: 'secret' }, 'a drag that starts in a shield');
  assert.equal(checkInput({ t: 'up', n: 1, ...at(200, 200) }, base).do, 'allow', 'a button always goes up');
  assert.equal(checkInput({ t: 'up', n: 1, ...at(200, 200) }, base).clamp, true, 'but not inside the shield');
  assert.deepEqual(checkInput({ t: 'click', n: 1, ...at(50, 50), b: 'l', c: 1 }, base), { do: 'allow' }, 'a click on Reply outside the shield does not ask');
  const order = checkInput({ t: 'click', n: 2, ...at(50, 50), b: 'l', c: 1 }, { ...base, hit: { role: 'AXButton', label: 'Place order', app: 'Safari' } });
  assert.deepEqual(order, { do: 'ask', why: 'money', label: 'Place order', app: 'Safari' }, 'Place order asks');
  assert.equal(checkInput({ t: 'click', n: 2, ...at(50, 50), b: 'l', c: 1 }, { ...base, hit: { role: 'AXButton', label: '', labels: ['', 'Buy now'], app: 'Safari' } }).do, 'ask', 'a pay label on a parent asks');
  assert.equal(checkInput({ t: 'click', n: 2, ...at(50, 50), b: 'r', c: 1 }, { ...base, hit: { role: 'AXButton', label: 'Place order', app: 'Safari' } }).do, 'allow', 'a right click opens a menu and pays nothing');
  // Return on a default button that pays asks; Return in a text field with no paying default does not.
  assert.equal(checkInput({ t: 'key', n: 3, k: 'return' }, { ...base, focus: { ...base.focus, defaultButton: 'Pay $40.00' } }).do, 'ask', 'Return on a Pay default button asks');
  assert.equal(checkInput({ t: 'key', n: 3, k: 'return' }, base).do, 'allow');
  // Text and keys.
  assert.deepEqual(checkInput({ t: 'text', n: 4, s: 'hunter2' }, { ...base, focus: { role: 'AXTextField', label: 'Password', secure: true } }), { do: 'refuse', why: 'credential' }, 'text into a secure field');
  assert.deepEqual(checkInput({ t: 'text', n: 4, s: 'x' }, { ...base, focus: { ...base.focus, secureInput: true } }), { do: 'refuse', why: 'credential' }, 'text under macOS secure input');
  assert.deepEqual(checkInput({ t: 'text', n: 4, s: '123456' }, { ...base, focus: { role: 'AXTextField', label: 'Verification code', secure: false } }), { do: 'refuse', why: 'credential' }, 'a code field is a credential');
  assert.deepEqual(checkInput({ t: 'key', n: 4, k: 'cmd+v' }, { ...base, focus: { role: 'AXTextField', label: 'Password', secure: true } }), { do: 'refuse', why: 'credential' }, 'a paste into a password field');
  assert.deepEqual(checkInput({ t: 'key', n: 4, k: 'a' }, { ...base, focus: { role: 'AXTextField', label: 'Password', secure: true } }), { do: 'refuse', why: 'credential' }, 'a typed key into a password field');
  assert.equal(checkInput({ t: 'key', n: 4, k: 'tab' }, { ...base, focus: { role: 'AXTextField', label: 'Password', secure: true } }).do, 'allow', 'Tab moves out of a password field');
  assert.deepEqual(checkInput({ t: 'text', n: 5, s: 'hi' }, { ...base, frontSecret: true }), { do: 'refuse', why: 'secret' }, 'keys while the front window is shielded');
  assert.deepEqual(checkInput({ t: 'key', n: 5, k: 'cmd+c' }, { ...base, frontSecret: true }), { do: 'refuse', why: 'secret' }, 'a copy from a vault');
  // A card number: the digits before stay; the chunk that completes it is refused.
  const first = checkInput({ t: 'text', n: 6, s: '4111 1111 1111 111' }, base);
  assert.deepEqual(first, { do: 'allow' }, 'fifteen digits are not yet a card');
  const tail = cardTail('', '4111 1111 1111 111');
  assert.deepEqual(checkInput({ t: 'text', n: 7, s: '1' }, { ...base, tail }), { do: 'refuse', why: 'card' }, 'the digit that completes a card number');
  assert.equal(cardTail('x'.repeat(50), 'abc').length, 40, 'the tail keeps 40 characters (room for the letters a card mask drops, round 8)');
  assert.deepEqual(checkInput({ t: 'text', n: 8, s: 'Hello there' }, base), { do: 'allow' }, 'plain text');
  // Locked and the agent.
  for (const m of [{ t: 'click', n: 9, ...at(50, 50), b: 'l', c: 1 }, { t: 'text', n: 9, s: 'a' }, { t: 'key', n: 9, k: 'esc' }, { t: 'scroll', n: 9, ...at(50, 50), dx: 0, dy: 1 }]) {
    assert.deepEqual(checkInput(m, { ...base, locked: true }), { do: 'refuse', why: 'locked' }, `${m.t} while locked`);
    assert.deepEqual(checkInput(m, { ...base, agent: { busy: true, owner: false } }), { do: 'refuse', why: 'agent' }, `${m.t} while the agent works`);
    assert.notEqual(checkInput(m, { ...base, agent: { busy: true, owner: true } }).why, 'agent', `${m.t} after Take over`);
  }
  assert.deepEqual(checkInput({ t: 'nope', n: 1 }, base), { do: 'refuse', why: 'changed' }, 'an unknown input');
}
console.log('remotepolicy ok');

// ---- RV r4: the card rule before the money ask; autofill and show-password clicks; a shown password field and a
// browser's popups are hidden while focus is a credential; the Dock bar is not Mission Control ----
{
  const payForm = { ...base, shields: [], focus: { role: 'AXTextField', label: '1234 1234 1234 1234', secure: false, buttons: ['Pay $20.00'] }, pay: { surface: true, amount: false } };
  assert.deepEqual(checkInput({ t: 'text', n: 1, s: '4111111111111111\n' }, payForm), { do: 'refuse', why: 'card' }, 'a card number and a newline in a pay form: refused, never asked');
  assert.deepEqual(checkInput({ t: 'text', n: 1, s: '1\n' }, { ...payForm, tail: '411111111111111' }), { do: 'refuse', why: 'card' }, 'the digit that completes a card, with a newline');
  assert.equal(checkInput({ t: 'text', n: 1, s: 'hi\n' }, payForm).do, 'ask', 'a plain newline in a pay form still asks');
  const pw = { ...base, shields: [], focus: { role: 'AXSecureTextField', label: 'Password', secure: true } };
  const click = (hit, ctx = pw) => checkInput({ t: 'click', n: 2, ...at(50, 50), b: 'l', c: 1 }, { ...ctx, hit });
  assert.deepEqual(click({ role: 'AXMenuItem', label: 'fixtureuser@example.com', app: 'Safari' }), { do: 'refuse', why: 'credential' }, 'an autofill list item while in a password field');
  assert.deepEqual(click({ role: 'AXButton', label: 'Fill', app: '1Password' }), { do: 'refuse', why: 'credential' }, 'a password manager Fill');
  assert.deepEqual(click({ role: 'AXButton', label: 'From Messages 123456', app: 'Safari' }, { ...pw, focus: { role: 'AXTextField', label: 'Verification code' } }), { do: 'refuse', why: 'credential' }, 'a texted code fill');
  assert.deepEqual(click({ role: 'AXButton', label: 'Show password', app: 'Safari' }, base), { do: 'refuse', why: 'credential' }, 'a show-password toggle, anywhere');
  assert.equal(click({ role: 'AXButton', label: 'Sign in', app: 'Safari' }).do, 'allow', 'Sign in from a password field');
  assert.equal(click({ role: 'AXMenuItem', label: 'Copy', app: 'Mail' }, base).do, 'allow', 'a menu item outside a credential field');
  // A password field in plain text (shown) is hidden; a secure one is not (its dots show nothing).
  const shown = shieldsFor([win(4, 'Safari', 'Sign in', { front: true, bounds: [0, 0, 1000, 800] })], { home, display, focus: { role: 'AXTextField', label: 'Password', secure: false, rect: [200, 300, 240, 30] } });
  assert.deepEqual(shown.rects, [[200, 300, 240, 30]], 'a shown password field is a shield');
  assert.deepEqual(shieldsFor([win(4, 'Safari', 'Sign in')], { home, display, focus: { role: 'AXSecureTextField', label: 'Password', secure: true, rect: [200, 300, 240, 30] } }).rects, [], 'a secure one is not');
  // A browser's untitled popup (autofill list, an extension): hidden whatever has focus (round 6: an extension popup
  // opened from the toolbar has its own search field); its menus (layer 101) show unless focus is a credential.
  const pop = [win(4, 'Google Chrome', 'Sign in', { front: true, bounds: [0, 0, 1000, 800] }), win(5, 'Google Chrome', '', { bounds: [600, 40, 360, 500] })];
  assert.deepEqual(shieldsFor(pop, { home, display, focus: { role: 'AXSecureTextField', label: 'Password', secure: true } }).ids, [5], 'the popup is hidden while in a password field');
  assert.deepEqual(shieldsFor(pop, { home, display, focus: { role: 'AXTextField', label: 'Search', secure: false } }).ids, [5], 'and otherwise');
  const menu = [pop[0], win(6, 'Google Chrome', '', { bounds: [600, 40, 200, 300], layer: 101 })];
  assert.deepEqual(shieldsFor(menu, { home, display, focus: { role: 'AXTextField', label: 'Search', secure: false } }).ids, [], 'a context menu shows');
  assert.deepEqual(shieldsFor(menu, { home, display, focus: { role: 'AXSecureTextField', label: 'Password', secure: true } }).ids, [6], 'not from a password field');
  // The Dock bar's own full-screen layer-20 window is not Mission Control.
  const dock = { id: 50, pid: 50, app: 'Dock', overlay: true, bounds: [0, 0, 1000, 800], layer: 20 };
  const mail = win(6, 'Mail', 'Inbox');
  assert.deepEqual(shieldsFor([dock, mail], { home, display, secretSeen: true }).rects, [], 'the Dock showing after a vault: Mail still shows');
  assert.deepEqual(shieldsFor([{ ...dock, layer: 18 }, mail], { home, display, secretSeen: true }).rects, [[0, 0, 1000, 800]], 'a full-display Dock window at another layer is still one shield');
  const vaultWin = win(7, 'Google Chrome', 'Bitwarden Web Vault', { url: 'https://vault.bitwarden.com/#/vault' });
  assert.deepEqual(shieldsFor([dock, vaultWin], { home, display }).rects, [[0, 0, 1000, 800]], 'a layer-20 Dock window while a vault is on screen now: still all black');
}
console.log('remotepolicy r4 ok');
