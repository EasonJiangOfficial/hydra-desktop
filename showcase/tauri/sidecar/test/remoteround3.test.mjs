// The phone view's round-3 verifier findings (RV lane, Mac side), each as a test that failed before its fix: a card
// number anywhere in a paste is refused; a plain Confirm, Send, Continue or price button in a money app asks; a key or
// text right after a Tab reads the focus live; Take over's wait ends with the tool call's abort; a helper that never
// quits is killed; Mission Control over a vault is all black; the first shield message is capped at 64; Paste in other
// languages and the on-screen keyboard are refused under a secure field; a drag never drops onto one; notification
// banners and a capture of a vault are hidden. Run: npm test
import assert from 'node:assert/strict';
import { createRemoteView } from '../remoteview.mjs';
import { createViewGate } from '../viewgate.mjs';
import { checkInput, shieldsFor, payCtx } from '../remotepolicy.mjs';
import { macMessageSchema } from '../remoteschema.mjs';
import { fakeApi, fakeClock, fakeHelper, fakePeer, flush, SESSION } from './fakeremote.mjs';

function rig({ windows } = {}) {
  const clock = fakeClock(), helpers = [], peers = [];
  const gate = createViewGate({ clock });
  const api = fakeApi();
  const view = createRemoteView({
    api, clock, gate, home: '/Users/test', macName: 'Mac', enabled: () => true,
    probe: async () => ({ screen: true, ax: true }), peerOk: async () => true,
    spawnHelper: () => { const h = fakeHelper({ windows }); helpers.push(h); return h; },
    makePeer: async () => { const p = fakePeer(); peers.push(p); return p; },
    onStop: () => gate.stop(), agentBusy: () => false, log: () => {},
  });
  const r = {
    clock, gate, view, get helper() { return helpers.at(-1); }, get peer() { return peers.at(-1); },
    async live() { view.start(); await flush(); api.offer({ ...SESSION }); await flush(); r.peer.open(); r.peer.phone({ t: 'hello', v: 1, w: 390, h: 844, dpr: 3 }); await flush(); },
    inputs: () => r.helper.cmds.filter((c) => c.cmd === 'input'),
  };
  return r;
}
const display = { id: 1, x: 0, y: 0, w: 1000, h: 800 };
const base = { display, shields: [], locked: false, agent: { busy: false, owner: false }, focus: { role: 'AXTextArea', label: 'Message body', secure: false, secureInput: false }, frontSecret: false, tail: '' };
const click = { t: 'click', n: 1, x: 0.5, y: 0.5, b: 'l', c: 1 };

// ---- a card number anywhere in one text message ----
{
  assert.deepEqual(checkInput({ t: 'text', n: 1, s: '4111 1111 1111 1111 exp 12/29 cvc 123 thanks' }, base), { do: 'refuse', why: 'card' }, 'a pasted card with text after it');
  assert.deepEqual(checkInput({ t: 'text', n: 1, s: `4111111111111111${'x'.repeat(24)}` }, base), { do: 'refuse', why: 'card' }, '24 characters after the card');
  assert.deepEqual(checkInput({ t: 'text', n: 1, s: 'Card 4242424242424242, please charge it now ok' }, base), { do: 'refuse', why: 'card' });
  assert.deepEqual(checkInput({ t: 'text', n: 1, s: '1111 thanks' }, { ...base, tail: '4111 1111 1111 ' }), { do: 'refuse', why: 'card' }, 'the tail and the new text together');
  assert.deepEqual(checkInput({ t: 'text', n: 1, s: 'Order 12345 ships on 2026-12-01, thanks' }, base), { do: 'allow' }, 'plain numbers type');
  const r = rig();
  await r.live();
  r.peer.phone({ t: 'text', n: 9, s: '4111 1111 1111 1111 exp 12/29 cvc 123 thanks' }); await flush();
  assert.equal(r.inputs().length, 0, 'the paste never reaches the helper');
  assert.deepEqual(r.peer.of('refused').at(-1), { t: 'refused', n: 9, why: 'card' });
  r.view.stop();
}

// ---- money surfaces: a plain Confirm, Send, Continue or a price button asks there ----
{
  for (const [label, app] of [['Send', 'Cash App'], ['Confirm', 'Robinhood'], ['$4.99', 'App Store'], ['Continue', 'Coinbase'], ['Pay now', 'Safari']]) {
    assert.equal(checkInput(click, { ...base, hit: { role: 'AXButton', label, app }, pay: payCtx({ app }) }).do, 'ask', `${label} in ${app}`);
  }
  assert.equal(checkInput(click, { ...base, hit: { role: 'AXButton', label: 'Send', app: 'Mail' }, pay: payCtx({ app: 'Mail' }) }).do, 'allow', 'Send in Mail does not ask');
  assert.equal(checkInput(click, { ...base, hit: { role: 'AXButton', label: 'Continue', app: 'Safari' }, pay: payCtx({ app: 'Safari', title: 'Checkout', url: 'https://shop.example.com/checkout' }) }).do, 'ask', 'Continue on a checkout page');
  assert.equal(checkInput(click, { ...base, hit: { role: 'AXButton', label: 'Continue', app: 'Safari' }, pay: payCtx({ app: 'Safari', title: 'Docs', url: 'https://docs.stripe.com/checkout' }) }).do, 'allow', 'not on a docs page');
  assert.equal(checkInput({ t: 'key', n: 1, k: 'return' }, { ...base, focus: { role: 'AXButton', label: 'Confirm' }, pay: payCtx({ app: 'Robinhood' }) }).do, 'ask', 'Return on Confirm in a broker');
  // In the view: the window under the tap gives the context (its app, its address).
  const r = rig({ windows: [{ id: 5, pid: 5, bundle: '', app: 'Google Chrome', title: 'Review order', bounds: [0, 0, 1000, 800], layer: 0, front: true, url: 'https://shop.example.com/checkout/review' }] });
  await r.live();
  r.helper.hits.all = { role: 'AXButton', label: 'Continue', app: 'Google Chrome' };
  r.peer.phone({ ...click, n: 3 }); await flush();
  assert.equal(r.peer.of('ask').at(-1)?.label, 'Continue', 'Continue in a web checkout asks');
  assert.equal(r.inputs().length, 0);
  r.view.stop();
}

// ---- a key or text reads the focus live (the 200 ms poll may be behind a Tab or a click) ----
{
  const r = rig();
  await r.live();
  const h = r.helper;
  h.emit({ ev: 'focus', role: 'AXTextField', label: 'Name on card', secure: false, secureInput: false, rect: [10, 10, 200, 20] }); await flush();
  r.peer.phone({ t: 'key', n: 1, k: 'tab' }); await flush();
  h.focus = { role: 'AXButton', label: 'Place order', secure: false, secureInput: false };
  r.peer.phone({ t: 'text', n: 2, s: ' ' }); await flush();
  assert.equal(r.peer.of('ask').at(-1)?.label, 'Place order', 'a typed space right after a Tab asks');
  assert.deepEqual(r.inputs().map((c) => c.n), [1]);
  h.focus = { role: 'AXTextField', label: 'CVC', secure: false, secureInput: false };
  r.peer.phone({ t: 'text', n: 3, s: '123' }); await flush();
  assert.deepEqual(r.peer.of('refused').at(-1), { t: 'refused', n: 3, why: 'credential' }, 'a CVC right after a Tab is refused');
  assert.deepEqual(r.inputs().map((c) => c.n), [1]);
  assert.ok(h.cmds.filter((c) => c.cmd === 'focus').every((c) => c.buttons === false || c.buttons === true), 'each live read says whether it walks the buttons');
  assert.equal(h.cmds.find((c) => c.cmd === 'focus' && c.id && c.buttons === false) != null, true, 'a plain key skips the button walk');
  for (const m of r.peer.sent) assert.ok(macMessageSchema.safeParse(m).success, `contract: ${JSON.stringify(m)}`);
  r.view.stop();
}

// ---- Take over: an aborted tool call never runs after the hand back ----
{
  const clock = fakeClock();
  const gate = createViewGate({ clock });
  let ran = 0;
  const open = gate.wrap({ name: 'open', execute: async () => { ran += 1; return 'opened'; } });
  await gate.takeover();
  const call = new AbortController();
  const p = open.execute({ target: 'https://example.test' }, { signal: call.signal }).then((x) => x, (e) => `threw: ${e.message}`);
  await flush();
  call.abort();
  await clock.advance(10_000);
  gate.handback();
  assert.equal(await p, 'threw: Stopped.');
  assert.equal(ran, 0, 'the tool did not run');
  // Already aborted before the wait: never waits.
  await gate.takeover();
  const r2 = await open.execute({}, { signal: AbortSignal.abort() }).then((x) => x, (e) => e.message);
  assert.equal(r2, 'Stopped.');
  gate.handback();
  assert.equal(await open.execute({}, {}), 'opened', 'with no owner it runs');
}

// ---- a helper that never reads its quit is killed 2 s after ----
{
  const r = rig();
  await r.live();
  const h = r.helper;
  h.send = ((orig) => (o) => { if (o.cmd !== 'quit') orig(o); else h.cmds.push(o); })(h.send.bind(h)); // wedged: no exit
  r.peer.phone({ t: 'bye' }); await flush();
  assert.equal(h.killed, false);
  await r.clock.advance(2_100);
  assert.equal(h.killed, true, 'killed after 2 s');
  const r2 = rig();
  await r2.live();
  r2.peer.phone({ t: 'bye' }); await flush();
  await r2.clock.advance(2_100);
  assert.equal(r2.helper.killed, false, 'one that quit is not killed');
}

// ---- shields: Mission Control, notifications, captures, the 64 cap ----
{
  const home = '/Users/test';
  const vault = { id: 1, pid: 1, app: 'Google Chrome', title: 'Bitwarden Web Vault', url: 'https://vault.bitwarden.com/#/vault', bounds: [100, 100, 300, 200] };
  const mc = { id: 2, pid: 2, app: 'Dock', overlay: true, bounds: [0, 0, 1000, 800], layer: 20 };
  assert.deepEqual(shieldsFor([mc, vault], { home, display }).rects, [[0, 0, 1000, 800]], 'Mission Control over a vault: all black');
  // RV r4: the Dock bar's own window is layer 20 and display-sized (measured), so the seen-before case needs a Dock
  // window that is not the bar's (Mission Control's layer is not measured: 18 stands for "not 20").
  assert.deepEqual(shieldsFor([{ ...mc, layer: 18 }], { home, display, secretSeen: true }).rects, [[0, 0, 1000, 800]], 'and when the vault was seen before');
  assert.deepEqual(shieldsFor([mc, { id: 3, pid: 3, app: 'Notes', title: 'x', bounds: [0, 0, 10, 10] }], { home, display }).rects, [], 'no secret: Mission Control shows');
  assert.deepEqual(shieldsFor([{ ...mc, bounds: [0, 740, 1000, 60] }, vault], { home, display }).rects, [[100, 100, 300, 200]], 'the Dock bar is no overlay');
  const nc = { id: 4, pid: 4, app: 'NotificationCenter', title: '', bounds: [700, 0, 300, 100] };
  assert.deepEqual(shieldsFor([nc], { home, display }).rects, [[700, 0, 300, 100]], 'a notification banner is hidden');
  assert.equal(shieldsFor([nc], { home, display }).secret, false, 'but is no vault');
  const shot = { id: 5, pid: 5, app: 'Preview', title: 'a.png', bounds: [0, 0, 200, 200] };
  assert.deepEqual(shieldsFor([shot], { home, display }).rects, [], 'an image with no vault seen shows');
  assert.deepEqual(shieldsFor([shot, vault], { home, display }).rects.length, 2, 'an image while a vault is on screen is hidden');
  assert.deepEqual(shieldsFor([shot], { home, display, secretSeen: true }).rects, [[0, 0, 200, 200]], 'and after one was seen');
  assert.equal(shieldsFor([{ id: 6, pid: 6, app: 'Screenshot', title: '', bounds: [0, 0, 50, 50] }], { home, display, secretSeen: true }).rects.length, 1, 'the Screenshot app too');
  // The first shield message after live: 64 rects at most (the contract's cap).
  const many = Array.from({ length: 70 }, (_, i) => ({ id: 100 + i, pid: 9, bundle: '', app: '1Password', title: '', bounds: [i * 10, 0, 5, 5], layer: 0 }));
  const r = rig({ windows: many });
  await r.live();
  const first = r.peer.of('shield')[0];
  assert.ok(first && first.rects.length === 64, `capped at 64 (${first?.rects.length})`);
  for (const m of r.peer.sent) assert.ok(macMessageSchema.safeParse(m).success, `contract: ${JSON.stringify(m).slice(0, 80)}`);
  r.view.stop();
}

// ---- secure field: Paste in other languages, the on-screen keyboard, a drop ----
{
  const pw = { ...base, focus: { role: 'AXSecureTextField', label: 'Password', secure: true, secureInput: true } };
  for (const label of ['Einsetzen', 'Coller', 'Pegar', 'Incolla', '粘贴', 'Paste']) {
    assert.deepEqual(checkInput(click, { ...pw, hit: { role: 'AXMenuItem', label, app: 'Safari' } }), { do: 'refuse', why: 'credential' }, label);
  }
  assert.deepEqual(checkInput(click, { ...pw, hit: { role: 'AXMenuItem', label: 'Whatever', paste: true, app: 'Safari' } }), { do: 'refuse', why: 'credential' }, 'cmd+V by its shortcut');
  assert.deepEqual(checkInput(click, { ...pw, hit: { role: 'AXButton', label: 'a', app: 'AssistiveControl' } }), { do: 'refuse', why: 'credential' }, 'the Accessibility Keyboard');
  assert.equal(checkInput(click, { ...base, hit: { role: 'AXMenuItem', label: 'Einsetzen', app: 'Safari' } }).do, 'allow', 'Paste elsewhere is fine');
  const up = { t: 'up', n: 2, x: 0.5, y: 0.5 };
  assert.deepEqual(checkInput(up, { ...base, dragged: true, hit: { role: 'AXSecureTextField', label: 'Password', secure: true } }), { do: 'allow', clamp: 'start' }, 'a drop onto a password field goes back');
  assert.deepEqual(checkInput(up, { ...base, dragged: true, hit: { role: 'AXTextArea', label: 'Notes' } }), { do: 'allow' }, 'a drop onto notes');
  assert.deepEqual(checkInput(up, { ...base, dragged: false }), { do: 'allow' }, 'a plain press comes up');
  // In the view: the up lands where the drag began.
  const r = rig();
  await r.live();
  const h = r.helper;
  r.peer.phone({ t: 'down', n: 1, x: 0.1, y: 0.1 }); await flush();
  r.peer.phone({ t: 'move', n: 2, x: 0.5, y: 0.5 }); await flush();
  h.hits.next = { role: 'AXSecureTextField', label: 'Password', secure: true, app: 'Safari' };
  r.peer.phone({ t: 'up', n: 3, x: 0.5, y: 0.5 }); await flush();
  const u = r.inputs().find((c) => c.t === 'up');
  assert.ok(u && u.x === 0.1 && u.y === 0.1, `the button goes up where the drag began (${JSON.stringify(u)})`);
  r.view.stop();
}
console.log('remoteround3 ok');
