// The phone view's round-6 verifier findings (RV lane, Mac side), each as a test that failed before its fix: Phone
// View can be switched on (the menu item shows while it is off); a Stop on the Mac while the phone says "Taking over"
// ends it; a hit or focus read that failed (no role) is refused, and an unlabeled control in a money app asks; keys
// and hotkeys in a money app ask; a browser's untitled popup is hidden whatever has focus; the Swift backstop refuses
// a paste of a concealed (password manager) clipboard.
// Run: npm test
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createRemoteView } from '../remoteview.mjs';
import { createViewGate } from '../viewgate.mjs';
import { checkInput, shieldsFor, payCtx } from '../remotepolicy.mjs';
import { fakeApi, fakeClock, fakeHelper, fakePeer, flush, SESSION } from './fakeremote.mjs';

const here = (p) => new URL(p, import.meta.url);

async function setup({ focus } = {}) {
  const clock = fakeClock(), gate = createViewGate({ clock }), api = fakeApi();
  let h, p;
  const view = createRemoteView({
    api, clock, gate, home: '/Users/test', enabled: () => true, probe: async () => ({ screen: true, ax: true }), peerOk: async () => true,
    spawnHelper: () => { h = fakeHelper(); if (focus) h.focus = focus; return h; }, makePeer: async () => (p = fakePeer()), onStop: () => gate.stop(), log: () => {},
  });
  view.start(); await flush(); api.offer({ ...SESSION }); await flush(); p.open(); p.phone({ t: 'hello', v: 1, w: 390, h: 844, dpr: 3 }); await flush();
  return { clock, gate, api, view, h: () => h, p: () => p };
}

// ---- Phone View can be switched on: a fresh install (phoneView false) still shows the menu item ----
{
  const clock = fakeClock(), gate = createViewGate({ clock }), api = fakeApi();
  const config = { phoneView: false };
  let peerChecks = 0;
  const view = createRemoteView({
    api, clock, gate, home: '/Users/test', enabled: () => !!config.phoneView, probe: async () => ({ screen: true, ax: true }),
    peerOk: async () => { peerChecks += 1; return true; }, spawnHelper: () => fakeHelper(), makePeer: async () => fakePeer(), log: () => {},
  });
  view.start(); await flush(); await clock.advance(5 * 60_000);
  assert.equal(view.available(), true, 'werift is checked while Phone View is off: the menu shows "Phone View"');
  assert.equal(peerChecks, 1, 'checked once');
  assert.equal(api.polls, 0, 'no poll while it is off');
  config.phoneView = true; view.refresh(); await flush();
  assert.ok(api.polls >= 1, 'switched on from the menu: the poll starts');
  view.stop();
}

// ---- a Stop on the Mac while the phone still says "Taking over" ----
{
  const { clock, gate, view, h, p } = await setup();
  const tool = gate.wrap({ name: 'act_in_app', execute: (a, ctx) => new Promise((r, no) => { ctx?.signal?.addEventListener('abort', () => no(new Error('Stopped.'))); }) });
  const t = gate.turn();
  const ac = new AbortController();
  t.signal.addEventListener('abort', () => ac.abort());
  const run = tool.execute({ target: 'Safari', steps: [] }, { signal: ac.signal }).catch((e) => e.message);
  await flush();
  p().phone({ t: 'takeover' }); await flush();
  const before = p().of('agent').length;
  gate.stop({ quiet: true }); // the Mac's menu Stop, Esc
  await run; t.done(); await flush(); await clock.advance(5_000);
  const after = p().of('agent').slice(before);
  assert.ok(after.some((m) => m.control === false), 'the phone hears control: false and leaves "Taking over"');
  assert.equal(h().last('state').text, 'Being viewed from your phone', 'the pill says viewed again');
  view.stop();
}

// ---- a failed hit test or focus read (no role) is refused; an unlabeled control in a money app asks ----
const base = { display: { w: 1000, h: 800 }, shields: [], locked: false, agent: { busy: false, owner: false }, frontSecret: false, tail: '' };
const click = { t: 'click', n: 1, x: 0.5, y: 0.5, b: 'l', c: 1 };
{
  for (const app of ['thinkorswim', 'Robinhood']) {
    const pay = payCtx({ app });
    assert.deepEqual(checkInput(click, { ...base, pay, hit: { role: '' }, focus: {} }), { do: 'refuse', why: 'changed' }, `${app}: an AX hit that failed is refused`);
    assert.deepEqual(checkInput({ t: 'down', n: 1, x: 0.5, y: 0.5 }, { ...base, pay, hit: { role: '' }, focus: {} }), { do: 'refuse', why: 'changed' }, `${app}: a press too`);
  }
  const chrome = payCtx({ app: 'Google Chrome', url: 'https://shop.example.com/checkout', title: 'Checkout' });
  assert.equal(chrome.surface, true);
  assert.deepEqual(checkInput(click, { ...base, pay: chrome, hit: { role: '' }, focus: {} }), { do: 'refuse', why: 'changed' }, 'a checkout page: refused');
  assert.equal(checkInput(click, { ...base, pay: {}, hit: { role: '' }, focus: {} }).do, 'refuse', 'and anywhere else');
  const rh = payCtx({ app: 'Robinhood' });
  assert.equal(checkInput(click, { ...base, pay: rh, hit: { role: 'AXButton', label: '', labels: ['', '', '', ''], app: 'Robinhood' }, focus: {} }).do, 'ask', 'an unlabeled button in Robinhood asks');
  assert.equal(checkInput(click, { ...base, pay: rh, hit: { role: 'AXGroup', label: '', labels: ['', 'Order', '', ''], app: 'Robinhood' }, focus: {} }).do, 'ask', 'an unlabeled group (a canvas button) asks');
  assert.equal(checkInput(click, { ...base, pay: rh, hit: { role: 'AXTextField', label: '', app: 'Robinhood' }, focus: {} }).do, 'allow', 'a click into a field does not');
  assert.equal(checkInput(click, { ...base, pay: rh, hit: { role: 'AXScrollArea', label: '', app: 'Robinhood' }, focus: {} }).do, 'allow', 'nor on a scroll area');
  assert.equal(checkInput(click, { ...base, pay: {}, hit: { role: 'AXButton', label: '', app: 'Mail' }, focus: {} }).do, 'allow', 'an unlabeled button outside a money app does not ask');
  // The drop target of a drag could not be read: the button goes up where the drag began.
  assert.equal(checkInput({ t: 'up', n: 2, x: 0.5, y: 0.5 }, { ...base, dragged: true, hit: { role: '' }, focus: {} }).clamp, 'start');
}
{
  // Live: a key whose focus read came back with no role is refused 'changed', nothing is typed.
  const { view, h, p } = await setup({ focus: { role: '', label: '', secure: false, secureInput: false } });
  p().phone({ t: 'text', n: 1, s: '123' }); await flush(20);
  p().phone({ t: 'key', n: 2, k: 'return' }); await flush(20);
  assert.deepEqual(p().of('refused').map((r) => r.why), ['changed', 'changed'], 'a focus read that failed: refused');
  assert.equal(h().count('input'), 0, 'nothing reached the helper');
  // A click whose hit test failed.
  h().hits.all = { role: '' };
  p().phone({ ...click, n: 3 }); await flush(20);
  assert.equal(p().of('refused').at(-1).why, 'changed');
  assert.equal(h().count('input'), 0);
  view.stop();
}

// ---- keys and hotkeys in a money app ask ----
{
  const tv = payCtx({ app: 'TradingView', title: 'AAPL' });
  assert.equal(tv.surface, true);
  const chart = { ...base, pay: tv, focus: { role: 'AXGroup', label: 'Chart', secure: false, secureInput: false } };
  assert.equal(checkInput({ t: 'key', n: 1, k: 'shift+b' }, chart).do, 'ask', 'Shift+B on the chart asks');
  assert.equal(checkInput({ t: 'key', n: 1, k: 'b' }, chart).do, 'ask', 'a one-key order shortcut asks');
  assert.equal(checkInput({ t: 'key', n: 1, k: 'ctrl+b' }, chart).do, 'ask', 'a chord asks');
  assert.equal(checkInput({ t: 'text', n: 2, s: 'B' }, chart).do, 'ask', 'text B on the chart asks');
  assert.equal(checkInput({ t: 'key', n: 1, k: 'tab' }, chart).do, 'allow', 'Tab moves focus');
  assert.equal(checkInput({ t: 'key', n: 1, k: 'escape' }, chart).do, 'allow', 'Esc cancels');
  const qty = { ...base, pay: tv, focus: { role: 'AXTextField', label: 'Quantity', secure: false, secureInput: false } };
  assert.equal(checkInput({ t: 'text', n: 3, s: '10' }, qty).do, 'allow', 'typing into a field does not ask');
  assert.equal(checkInput({ t: 'key', n: 3, k: '5' }, qty).do, 'allow');
  assert.equal(checkInput({ t: 'key', n: 3, k: 'return' }, qty).do, 'ask', 'Return submits the order form: asks');
  assert.equal(checkInput({ t: 'text', n: 3, s: '10\n' }, qty).do, 'ask', 'a newline too');
  // The yes is checked again with the same label.
  const a = checkInput({ t: 'key', n: 1, k: 'shift+b' }, chart), b = checkInput({ t: 'key', n: 1, k: 'shift+b' }, chart);
  assert.equal(a.label, b.label);
  assert.ok(!/b/i.test(a.label.replace(/keyboard/i, '')), 'the ask label never carries the typed key');
  // Outside a money app nothing changes.
  assert.equal(checkInput({ t: 'key', n: 1, k: 'shift+b' }, { ...chart, pay: {} }).do, 'allow');
}

// ---- a browser's untitled small popup (a password manager extension) is hidden whatever has focus ----
{
  const display = { x: 0, y: 0, w: 1512, h: 982 };
  // Marked the way Windows.list marks it: the front app's FIRST layer-0 window (front to back) is front, so the popup
  // above the Gmail window carries front (and the address), not the Gmail window.
  const wins = [
    { id: 11, app: 'Google Chrome', title: '', bounds: [1100, 40, 360, 600], layer: 0, front: true, url: 'https://mail.google.com/' },
    { id: 12, app: 'Google Chrome', title: 'Inbox - Gmail', bounds: [0, 0, 1512, 982], layer: 0 },
  ];
  const sh = shieldsFor(wins, { home: '/Users/test', display, focus: { role: 'AXTextField', label: 'Search vault', secure: false, secureInput: false, rect: [1120, 60, 300, 30] } });
  assert.deepEqual(sh.ids, [11], 'the popup is hidden; the Gmail window is not');
  assert.deepEqual(shieldsFor(wins, { home: '/Users/test', display, focus: null }).ids, [11], 'with no focus read too');
  assert.equal(sh.frontSecret, true, 'a front popup takes no keys (Return fills the picked item)');
  assert.deepEqual(checkInput({ t: 'key', n: 2, k: 'return' }, { ...base, display, shields: sh.rects, frontSecret: sh.frontSecret, focus: { role: 'AXTextField', label: 'Search vault' } }), { do: 'refuse', why: 'secret' });
  // Not front (the old marking, a popup left open behind focus elsewhere): hidden all the same.
  assert.deepEqual(shieldsFor(wins.map(({ front, ...w }) => w), { home: '/Users/test', display, focus: null }).ids, [11]);
  // A click in it is dead (inside a shield).
  assert.deepEqual(checkInput({ t: 'click', n: 1, x: 1200 / 1512, y: 100 / 982, b: 'l', c: 1 }, { ...base, display, shields: sh.rects, hit: { role: 'AXButton', label: 'Fill' }, focus: {} }), { do: 'refuse', why: 'secret' });
}

// ---- the Swift backstop: no paste while the clipboard holds a concealed (password manager) item ----
{
  const main = readFileSync(here('../../src-tauri/remote/main.swift'), 'utf8'), hit = readFileSync(here('../../src-tauri/remote/hit.swift'), 'utf8');
  assert.match(hit, /org\.nspasteboard\.ConcealedType/, 'hit.swift knows the concealed type');
  assert.match(hit, /org\.nspasteboard\.TransientType/, 'and the transient one');
  assert.match(main, /Hit\.clipboardSecret\(\)/, 'input() checks the clipboard before a paste');
  assert.match(main, /Hit\.concealed\(/, 'the self-test runs the pure check');
}
// ---- O1: the TURN relay's config (scripts/deploy-turn.sh --render writes it, nothing is deployed) ----
{
  const dir = mkdtempSync(path.join(os.tmpdir(), 'turn-'));
  execFileSync('bash', [new URL('../../../../scripts/deploy-turn.sh', import.meta.url).pathname, '--render', dir], { env: { ...process.env, TURN_SECRET: 'abc123', TURN_IP: '203.0.113.7' } });
  const conf = readFileSync(path.join(dir, 'turnserver.conf'), 'utf8');
  rmSync(dir, { recursive: true, force: true });
  for (const line of ['use-auth-secret', 'static-auth-secret=abc123', 'external-ip=203.0.113.7', 'listening-port=3478', 'min-port=49160', 'max-port=49200', 'total-quota=24', 'user-quota=24', 'max-allocate-lifetime=120', 'default-allocate-lifetime=120', 'no-tls',
    'denied-peer-ip=10.0.0.0-10.255.255.255', 'denied-peer-ip=172.16.0.0-172.31.255.255', 'denied-peer-ip=192.168.0.0-192.168.255.255', 'denied-peer-ip=127.0.0.0-127.255.255.255']) {
    assert.ok(conf.split('\n').includes(line), `turnserver.conf has ${line}`);
  }
  assert.ok(!/@[A-Z_]+@/.test(conf), 'every placeholder is filled');
}
console.log('remoteround7 ok');
