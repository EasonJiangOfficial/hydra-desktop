// The phone view's round-1 verifier findings (RV lane, Mac side), each as a test that failed before its fix: the poll
// re-begins a session the server still lists as requested (livelock); no peer library means no Phone View; Stop from
// the phone ends relay and brain turns; a phone or brain turn counts as busy and its end is published; a session
// that never goes live ends; unpaired, 403 and 404 beats close; displays read again; the money ask on Return, Space,
// a newline and a press-and-release; paste with any modifiers and the Paste menu into a secret field; card digits
// sent as keys; Take over says "Taking over" until the owner's hands really work. Run: npm test
import assert from 'node:assert/strict';
import { createRemoteView } from '../remoteview.mjs';
import { createViewGate } from '../viewgate.mjs';
import { checkInput, cardTail } from '../remotepolicy.mjs';
import { fakeApi, fakeClock, fakeHelper, fakePeer, flush, SESSION } from './fakeremote.mjs';

function rig({ api = fakeApi(), peerOk = async () => true, makePeer, busy = false } = {}) {
  const clock = fakeClock(), peer = fakePeer(), st = { helpers: 0, peers: 0, stops: 0, busy }, logs = [], helpers = [];
  const gate = createViewGate({ clock, onStop: () => { st.stops += 1; } });
  const view = createRemoteView({
    api, clock, gate, home: '/Users/test', macName: 'Mac mini', enabled: () => true,
    probe: async () => ({ screen: true, ax: true }), peerOk,
    spawnHelper: () => { st.helpers += 1; const h = fakeHelper(); helpers.push(h); return h; },
    makePeer: makePeer ?? (async () => { st.peers += 1; return peer; }),
    onStop: () => gate.stop(), agentBusy: () => st.busy, log: (k, d) => logs.push([k, d]),
  });
  const r = {
    clock, api, peer, st, logs, gate, view, helpers, get helper() { return helpers.at(-1); },
    async live() {
      view.start(); await flush();
      api.offer?.({ ...SESSION }); await flush();
      peer.open(); peer.phone({ t: 'hello', v: 1, w: 390, h: 844, dpr: 3 }); await flush();
    },
    inputs: () => r.helper.cmds.filter((c) => c.cmd === 'input'),
  };
  return r;
}

// ---- livelock: the real agent_remote_next keeps returning the requested row until the answer lands ----
{
  const clock0 = { t: null };
  let status = 'requested', answers = 0;
  const api = {
    async req(path, { method = 'GET', body, signal } = {}) {
      await new Promise((res) => clock0.t.setTimeout(res, 100)); // half of a 200 ms round trip
      if (method === 'GET') {
        if (signal?.aborted) throw new Error('aborted');
        if (status === 'requested') return { status: 200, ok: true, json: async () => ({ session: { ...SESSION } }) };
        await new Promise((res, rej) => { const t = clock0.t.setTimeout(res, 25_000); signal?.addEventListener('abort', () => { clock0.t.clearTimeout(t); rej(new Error('aborted')); }); });
        return { status: 204, ok: false, json: async () => null };
      }
      if (body.op === 'answer') { answers += 1; if (status !== 'requested') return { status: 409, ok: false, json: async () => ({}) }; status = 'answered'; return { status: 200, ok: true, json: async () => ({ ok: true }) }; }
      return { status: 200, ok: true, json: async () => ({ ok: true, status: 'live' }) };
    },
  };
  let peer = null;
  const r = rig({ api, makePeer: async () => { r.st.peers += 1; await new Promise((res) => r.clock.setTimeout(res, 500)); peer = fakePeer(); return peer; } });
  clock0.t = r.clock;
  r.view.start();
  for (let i = 0; i < 30; i++) await r.clock.advance(100);
  assert.equal(r.st.helpers, 1, `one helper for one session, not one per poll (${r.st.helpers})`);
  assert.equal(r.st.peers, 1, 'one peer');
  assert.equal(answers, 1, 'one answer');
  peer.open(); peer.phone({ t: 'hello', v: 1, w: 390, h: 844, dpr: 3 }); await flush();
  assert.equal(r.view.live(), true, 'and the view goes live');
  r.view.stop();
}
// A session that already failed here is not begun again on every poll (one helper per id).
{
  const api = fakeApi();
  const r = rig({ api, makePeer: async () => { r.st.peers += 1; throw new Error('no peer'); } });
  r.view.start(); await flush();
  api.offer({ ...SESSION }); await flush();
  api.offer({ ...SESSION }); await r.clock.advance(2_000);
  assert.equal(r.st.helpers, 1, 'the same failed session is not begun twice');
  r.view.stop();
}

// ---- no peer library (werift not installed): no poll, and the menu item stays hidden ----
{
  const api = fakeApi();
  const r = rig({ api, peerOk: async () => false });
  r.view.start();
  await r.clock.advance(120_000);
  assert.equal(api.polls, 0, 'no peer library: Phone View never polls');
  assert.equal(r.view.available(), false, 'and says it is not available (the menu hides it)');
  const ok = rig({ peerOk: async () => true });
  ok.view.start(); await flush();
  assert.equal(ok.view.available(), true);
  ok.view.stop(); r.view.stop();
}

// ---- Stop from the phone ends a relay or brain turn (its own signal), not only the Mac's local turn ----
{
  const r = rig();
  await r.live();
  const outer = new AbortController();
  const turn = r.gate.turn(outer.signal);
  assert.equal(turn.signal.aborted, false);
  r.peer.phone({ t: 'stop' }); await flush();
  assert.equal(turn.signal.aborted, true, 'the running relay turn is aborted');
  assert.equal(r.st.stops, 1, 'and the Mac\'s Stop path runs once');
  turn.done();
  // The relay's own abort still reaches the turn.
  const o2 = new AbortController(), t2 = r.gate.turn(o2.signal);
  o2.abort();
  assert.equal(t2.signal.aborted, true);
  t2.done();
  r.view.stop();
}

// ---- a phone or brain turn is busy all the way through, and its end is published ----
{
  const r = rig();
  await r.live();
  const turn = r.gate.turn();
  const act = r.gate.wrap({ name: 'act_in_app', execute: async () => 'did it' });
  for (let i = 0; i < 30; i++) { await act.execute({ app: 'Safari' }, {}); await r.clock.advance(15_000); }
  assert.equal(r.api.op('end').length, 0, 'no idle end at 5.5 min while a relay turn runs tools every 15 s');
  await r.clock.advance(5_000); // between tools: the model is thinking
  r.peer.phone({ t: 'click', n: 1, x: 0.1, y: 0.1, b: 'l', c: 1 }); await flush();
  assert.deepEqual(r.peer.of('refused').at(-1), { t: 'refused', n: 1, why: 'agent' }, 'the owner\'s tap between tools is refused (Take over first)');
  turn.done();
  await flush();
  assert.equal(r.peer.of('agent').at(-1).busy, false, 'the end of the turn is published (busy false)');
  r.peer.phone({ t: 'click', n: 2, x: 0.1, y: 0.1, b: 'l', c: 1 }); await flush();
  assert.equal(r.inputs().at(-1)?.n, 2, 'then the owner controls');
  r.view.stop();
}

// ---- a session that never goes live ends (the phone left during ICE) ----
{
  const r = rig();
  r.view.start(); await flush();
  r.api.offer({ ...SESSION }); await flush();
  assert.equal(r.helper.count('start'), 1);
  await r.clock.advance(31_000);
  assert.equal(r.helper.count('quit'), 1, 'the helper quits: pill, capture and the wake hold go');
  assert.equal(r.api.op('end')[0]?.reason, 'timeout', 'the end is posted');
  r.view.stop();
}
// A bad phone hello (never parsed) is the same.
{
  const r = rig();
  r.view.start(); await flush();
  r.api.offer({ ...SESSION }); await flush();
  r.peer.open(); r.peer.phone({ t: 'hello', v: 1, w: 390, h: 844, dpr: 0.1 }); await flush();
  await r.clock.advance(31_000);
  assert.equal(r.helper.count('quit'), 1);
  r.view.stop();
}

// ---- beats: unpaired (no key), 403 and 404 close the session ----
for (const kind of ['unpaired', 403, 404]) {
  const api = fakeApi();
  const r = rig({ api });
  await r.live();
  if (kind === 'unpaired') { const req = api.req; api.req = async (p, o = {}) => { if (o.body?.op) throw Object.assign(new Error('This Mac is not paired with Hydra.'), { code: 'unpaired' }); return req(p, o); }; }
  else api.beatStatus = kind;
  await r.clock.advance(20_000);
  assert.equal(r.view.live(), false, `a beat answered ${kind} ends the view`);
  assert.equal(r.helper.count('quit'), 1);
  r.peer.phone({ t: 'click', n: 1, x: 0.1, y: 0.1, b: 'l', c: 1 }); await flush();
  assert.equal(r.inputs().length, 0, 'and no phone click reaches the helper');
  r.view.stop();
}
// A 429 or a 5xx beat does not.
{
  const r = rig();
  await r.live();
  r.api.beatStatus = 503; await r.clock.advance(20_000);
  r.api.beatStatus = 429; await r.clock.advance(20_000);
  assert.equal(r.view.live(), true);
  r.view.stop();
}

// ---- the display list is read again: shields follow a moved display ----
{
  const r = rig();
  await r.live();
  r.helper.emit({ ev: 'displays', list: [{ id: 1, name: 'Built-in', x: 200, y: 0, w: 1000, h: 800, main: true }] });
  r.helper.emit({ ev: 'windows', gen: 5, list: [{ id: 7, pid: 70, app: '1Password', title: '1Password', bounds: [300, 100, 200, 100] }] });
  await flush();
  assert.deepEqual(r.helper.last('shields').rects, [[100, 100, 200, 100]], 'shields use the display\'s new origin');
  r.view.stop();
}

// ---- money: Return, Space, a newline and a press-and-release on a pay button ask ----
{
  const display = { id: 1, x: 0, y: 0, w: 1000, h: 800 };
  const base = { display, shields: [], locked: false, agent: { busy: false, owner: false }, hit: { role: 'AXButton', label: 'Reply', app: 'Mail' }, focus: { role: 'AXTextField', label: 'Subject', secure: false, secureInput: false }, frontSecret: false, tail: '' };
  const payBtn = { ...base, focus: { role: 'AXButton', label: 'Place order', secure: false, secureInput: false, defaultButton: '' } };
  assert.equal(checkInput({ t: 'key', n: 1, k: 'return' }, payBtn).do, 'ask', 'Return on a focused Place order asks');
  assert.equal(checkInput({ t: 'key', n: 1, k: 'space' }, payBtn).do, 'ask', 'Space on it asks');
  assert.equal(checkInput({ t: 'text', n: 1, s: '\r' }, payBtn).do, 'ask', 'a typed return on it asks');
  assert.equal(checkInput({ t: 'text', n: 1, s: ' ' }, payBtn).do, 'ask', 'a typed space on it asks');
  assert.equal(checkInput({ t: 'text', n: 1, s: 'ok\n' }, { ...base, focus: { ...base.focus, defaultButton: 'Buy Now' } }).do, 'ask', 'a newline with a Buy Now default button asks');
  assert.equal(checkInput({ t: 'key', n: 1, k: 'space' }, { ...base, focus: { role: 'AXTextField', label: 'Payment reference', secure: false } }).do, 'allow', 'a space in a text field about payments types');
  assert.equal(checkInput({ t: 'text', n: 1, s: 'hello there' }, base).do, 'allow');
  const down = checkInput({ t: 'down', n: 1, x: 0.1, y: 0.1 }, { ...base, hit: { role: 'AXButton', label: 'Place order', app: 'Safari' } });
  assert.deepEqual(down, { do: 'ask', why: 'money', label: 'Place order', app: 'Safari' }, 'a press on Place order asks, as a click does');
  // Paste with any modifiers, and the Paste menu item, into a secret field.
  const secret = { ...base, focus: { role: 'AXSecureTextField', label: 'Password', secure: true, secureInput: true } };
  for (const k of ['cmd+v', 'cmd+shift+v', 'shift+cmd+v', 'cmd+opt+shift+v', 'ctrl+cmd+v']) assert.deepEqual(checkInput({ t: 'key', n: 2, k }, secret), { do: 'refuse', why: 'credential' }, `${k} into a password field`);
  assert.equal(checkInput({ t: 'key', n: 2, k: 'shift+cmd+v' }, base).do, 'allow', 'a paste into a plain field');
  assert.deepEqual(checkInput({ t: 'click', n: 3, x: 0.1, y: 0.1, b: 'l', c: 1 }, { ...secret, hit: { role: 'AXMenuItem', label: 'Paste', app: 'Safari' } }), { do: 'refuse', why: 'credential' }, 'the Paste menu into a password field');
  assert.deepEqual(checkInput({ t: 'click', n: 3, x: 0.1, y: 0.1, b: 'l', c: 1 }, { ...secret, hit: { role: 'AXMenuItem', label: 'Paste and Match Style', app: 'Safari' } }), { do: 'refuse', why: 'credential' });
  assert.equal(checkInput({ t: 'click', n: 3, x: 0.1, y: 0.1, b: 'l', c: 1 }, { ...base, hit: { role: 'AXMenuItem', label: 'Paste', app: 'TextEdit' } }).do, 'allow', 'Paste into a plain field');
  // Card digits sent as keys.
  assert.deepEqual(checkInput({ t: 'key', n: 4, k: '1' }, { ...base, tail: cardTail('', '4111 1111 1111 111') }), { do: 'refuse', why: 'card' }, 'the key that completes a card number');
}

// ---- in the session: a press on a pay button asks; the yes clicks; its drag is dropped ----
{
  const r = rig();
  await r.live();
  const h = r.helper;
  h.hits.all = { role: 'AXButton', label: 'Place order', app: 'Safari' };
  r.peer.phone({ t: 'down', n: 1, x: 0.3, y: 0.3 }); await flush();
  r.peer.phone({ t: 'move', n: 2, x: 0.31, y: 0.3 }); r.peer.phone({ t: 'up', n: 3, x: 0.31, y: 0.3 }); await flush();
  assert.equal(r.inputs().length, 0, 'no down, move or up reaches the Mac before the yes');
  const ask = r.peer.of('ask').at(-1);
  assert.equal(ask?.label, 'Place order');
  r.peer.phone({ t: 'answer', id: ask.id, yes: true }); await flush();
  assert.deepEqual(r.inputs().map((c) => [c.t, c.c]), [['click', 1]], 'the yes is one click');
  // Return on a focused pay button: ask, then the key.
  h.emit({ ev: 'focus', role: 'AXButton', label: 'Buy now', secure: false, secureInput: false, defaultButton: '', rect: [10, 10, 80, 20] }); await flush();
  r.peer.phone({ t: 'key', n: 4, k: 'return' }); await flush();
  const k = r.peer.of('ask').at(-1);
  assert.equal(k.label, 'Buy now');
  assert.equal(r.inputs().length, 1);
  r.peer.phone({ t: 'answer', id: k.id, yes: true }); await flush();
  assert.equal(r.inputs().at(-1).k, 'return', 'a yes presses it');
  // Card digits typed as keys; the tail survives the field scrolling (its rect moves).
  h.emit({ ev: 'focus', role: 'AXTextField', label: 'Notes', secure: false, secureInput: false, rect: [10, 70, 200, 20] }); await flush();
  r.peer.phone({ t: 'text', n: 5, s: '4111 1111 1111 11' }); await flush();
  h.emit({ ev: 'focus', role: 'AXTextField', label: 'Notes', secure: false, secureInput: false, rect: [10, 40, 200, 20] }); await flush();
  r.peer.phone({ t: 'key', n: 6, k: '1' }); await flush();
  r.peer.phone({ t: 'key', n: 7, k: '1' }); await flush();
  assert.deepEqual(r.peer.of('refused').at(-1), { t: 'refused', n: 7, why: 'card' }, 'the key that completes the card is refused');
  assert.equal(r.inputs().at(-1).n, 6);
  r.view.stop();
}

// ---- Take over while a helper call runs: "Taking over" until the owner's hands work ----
{
  const r = rig();
  await r.live();
  let finish;
  const act = r.gate.wrap({ name: 'act_in_app', execute: () => new Promise((res) => { finish = res; }) });
  const p = act.execute({ app: 'Safari' }, {});
  await flush();
  r.peer.phone({ t: 'takeover' }); await flush();
  assert.equal(r.peer.of('agent').at(-1).caption, 'Taking over', 'not "in control" while the call still runs');
  finish('ok'); await p; await flush();
  assert.ok(r.peer.of('agent').some((m) => m.caption === 'You are in control' && m.paused === true), 'then in control');
  r.view.stop();
}

// ---- round 2: control:true goes to the phone once Take over is done, never before (remote-schema.ts `control`) ----
{
  const { macMessageSchema } = await import('../remoteschema.mjs');
  const r = rig();
  await r.live();
  let finish;
  const act = r.gate.wrap({ name: 'act_in_app', execute: () => new Promise((res) => { finish = res; }) });
  const p = act.execute({ app: 'Safari' }, {});
  await flush();
  r.peer.phone({ t: 'takeover' }); await flush();
  assert.ok(!r.peer.of('agent').some((m) => m.control === true), 'no control:true while the running call still runs');
  finish('ok'); await p; await flush();
  const done = r.peer.of('agent').filter((m) => m.control === true);
  assert.equal(done.length, 1, 'one control:true once Take over is done');
  assert.equal(done[0].paused, true);
  assert.ok(macMessageSchema.safeParse(done[0]).success, 'it matches the contract');
  r.peer.phone({ t: 'handback' }); await flush();
  // No helper call running: Take over is done at once.
  r.peer.phone({ t: 'takeover' }); await flush();
  assert.equal(r.peer.of('agent').filter((m) => m.control === true).length, 2, 'Take over with nothing running: control:true at once');
  r.view.stop();
}

// ---- round 2 livelock belt: the API REPEATS the request until its answer lands; the answer is slow ----
{
  let answered = false, gets = 0, answers = 0;
  const clockRef = { c: null };
  const api = {
    async req(path, { method = 'GET', body, signal } = {}) {
      if (method === 'GET') {
        gets += 1;
        await new Promise((res) => clockRef.c.setTimeout(res, 50));
        if (signal?.aborted) throw new Error('aborted');
        if (!answered) return { status: 200, ok: true, json: async () => ({ session: { ...SESSION } }) };
        await new Promise((res, rej) => { const t = clockRef.c.setTimeout(res, 25_000); signal?.addEventListener('abort', () => { clockRef.c.clearTimeout(t); rej(new Error('aborted')); }); });
        return { status: 204, ok: false, json: async () => null };
      }
      if (body.op === 'answer') { answers += 1; await new Promise((res) => clockRef.c.setTimeout(res, 3_000)); answered = true; return { status: 200, ok: true, json: async () => ({ ok: true }) }; }
      return { status: 200, ok: true, json: async () => ({ ok: true, status: 'live' }) };
    },
  };
  const r = rig({ api });
  clockRef.c = r.clock;
  r.view.start();
  for (let i = 0; i < 40; i++) await r.clock.advance(100);
  assert.equal(answers, 1, `one answer for one request (${answers})`);
  assert.equal(r.st.helpers, 1, `one helper (${r.st.helpers})`);
  assert.equal(r.st.peers, 1, 'one peer');
  assert.ok(gets <= 3, `no poll while begin() runs, and the current session is not begun again (${gets} polls)`);
  r.peer.open(); r.peer.phone({ t: 'hello', v: 1, w: 390, h: 844, dpr: 3 }); await flush();
  assert.equal(r.view.live(), true);
  // The server hands the live session out again (a stale replica): it is the current one, so it is ignored.
  answered = false;
  for (let i = 0; i < 30; i++) await r.clock.advance(100);
  assert.equal(r.st.helpers, 1, 'the current session is never begun again');
  assert.equal(r.view.live(), true, 'and stays live');
  r.view.stop();
}
console.log('remotefixes ok');
