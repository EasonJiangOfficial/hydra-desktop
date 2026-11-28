// The phone view's round-2 verifier findings (RV lane, Mac side), each as a test that failed before its fix: shields
// in the helper's real start order (windows before displays and ready); a drag's button always comes up; a replaced
// viewer is told so; a turn is busy on the phone from its start, and busy follows the input rule; Return after a Tab
// and Return in a web checkout field ask; Take over waits for a Mac tool begun before the view; a field keeps its
// card tail when focus comes back; screenshot chords are refused; a 'changed' refusal is checked again once; a live
// beat that failed is tried again and precedes the end; Stop kills a running hands plan. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRemoteView } from '../remoteview.mjs';
import { createViewGate } from '../viewgate.mjs';
import { checkInput } from '../remotepolicy.mjs';
import { macMessageSchema } from '../remoteschema.mjs';
import { fakeApi, fakeClock, fakeHelper, fakePeer, flush, SESSION } from './fakeremote.mjs';

const VAULT = { id: 77, pid: 9, bundle: 'com.google.Chrome', app: 'Google Chrome', title: 'Bitwarden Web Vault', bounds: [100, 100, 600, 400], layer: 0, front: true, url: 'https://vault.bitwarden.com/#/vault' };

function rig({ api = fakeApi(), windows, busy = false } = {}) {
  const clock = fakeClock(), st = { busy }, logs = [], helpers = [], peers = [];
  const gate = createViewGate({ clock });
  const view = createRemoteView({
    api, clock, gate, home: '/Users/test', macName: 'Mac mini', enabled: () => true,
    probe: async () => ({ screen: true, ax: true }), peerOk: async () => true,
    spawnHelper: () => { const h = fakeHelper({ windows }); helpers.push(h); return h; },
    makePeer: async () => { const p = fakePeer(); peers.push(p); return p; },
    onStop: () => gate.stop(), agentBusy: () => st.busy, log: (k, d) => logs.push([k, d]),
  });
  const r = {
    clock, api, st, logs, gate, view, helpers, peers,
    get helper() { return helpers.at(-1); }, get peer() { return peers.at(-1); },
    async live(session = SESSION, first = true) {
      if (first) { view.start(); await flush(); }
      api.offer({ ...session }); await flush();
      r.peer.open(); r.peer.phone({ t: 'hello', v: 1, w: 390, h: 844, dpr: 3 }); await flush();
    },
    inputs: () => r.helper.cmds.filter((c) => c.cmd === 'input'),
  };
  return r;
}
const contract = (peer) => { for (const m of peer.sent) assert.ok(macMessageSchema.safeParse(m).success, `contract: ${JSON.stringify(m)}`); };

// ---- shields in the real start order: pill, windows gen 1, displays, ready ----
{
  const r = rig({ windows: [VAULT] });
  await r.live();
  const h = r.helper, sh = h.cmds.filter((c) => c.cmd === 'shields');
  assert.ok(sh.length >= 1, 'shields go to the helper');
  assert.ok(sh.every((c) => c.rects.length === 1), `never an empty shield list for gen 1 (${JSON.stringify(sh)})`);
  assert.deepEqual(sh.at(-1), { cmd: 'shields', gen: 1, rects: [[100, 100, 600, 400]], exclude: [] }, 'the vault is shielded at gen 1');
  assert.ok(h.cmds.indexOf(sh.at(-1)) < h.cmds.findIndex((c) => c.cmd === 'next'), 'shields reach the helper before the first next');
  assert.deepEqual(r.peer.of('shield').at(-1), { t: 'shield', rects: [[100, 100, 600, 400]] }, 'the phone gets it too');
  h.hits.all = { role: 'AXStaticText', label: 'github.com password', app: 'Google Chrome' };
  r.peer.phone({ t: 'click', n: 1, x: 0.4, y: 0.4, b: 'l', c: 1 }); await flush();
  assert.equal(r.inputs().length, 0, 'a tap in the vault never reaches the helper');
  assert.deepEqual(r.peer.of('refused').at(-1), { t: 'refused', n: 1, why: 'secret' });
  // A display switch: the shields are cut again for the new display on geom.
  h.emit({ ev: 'displays', list: [{ id: 1, name: 'Built-in', x: 0, y: 0, w: 1000, h: 800, main: true }, { id: 2, name: 'Studio', x: 1000, y: 0, w: 1000, h: 800, main: false }] });
  r.peer.phone({ t: 'display', id: 2 });
  h.emit({ ev: 'geom', gen: 1, display: 2, w: 1000, h: 800 }); await r.clock.advance(600);
  assert.deepEqual(h.last('shields').rects, [], 'the vault is not on display 2 (after the 500 ms linger)');
  contract(r.peer);
  r.view.stop();
}

// ---- a drag's button always comes up: agent busy, or locked, mid-drag ----
for (const why of ['agent', 'locked']) {
  const r = rig();
  await r.live();
  r.peer.phone({ t: 'down', n: 1, x: 0.1, y: 0.1 }); await flush();
  r.peer.phone({ t: 'move', n: 2, x: 0.2, y: 0.2 }); await flush();
  if (why === 'agent') r.st.busy = true; else r.helper.emit({ ev: 'locked', locked: true });
  r.peer.phone({ t: 'move', n: 3, x: 0.3, y: 0.3 }); await flush();
  r.peer.phone({ t: 'up', n: 4, x: 0.3, y: 0.3 }); await flush();
  assert.deepEqual(r.inputs().map((c) => c.t), ['down', 'move', 'up'], `${why}: the up still goes (the move does not)`);
  r.view.stop();
}
assert.deepEqual(checkInput({ t: 'up', n: 1, x: 0.5, y: 0.5 }, { display: { w: 100, h: 100 }, shields: [], locked: true, agent: { busy: true, owner: false } }), { do: 'allow' }, 'an up is never refused');

// ---- a replaced viewer is told why, and gets no more ----
{
  const r = rig();
  await r.live();
  const first = r.peer;
  await r.live({ ...SESSION, id: '7c5f0a52-6a3b-4b5e-9f2e-1d1d1d1d1d1d' }, false);
  assert.deepEqual(first.of('bye'), [{ t: 'bye', reason: 'replaced' }], 'the old viewer gets bye replaced');
  assert.equal(first.closed, true);
  contract(first);
  r.view.stop();
}

// ---- busy on the phone from a turn's start, and as long as the Mac refuses 'agent' ----
{
  const r = rig();
  await r.live();
  const t = r.gate.turn();
  await flush();
  assert.equal(r.peer.of('agent').at(-1)?.busy, true, 'a turn with no Mac tool yet is busy on the phone');
  t.done(); await flush();
  assert.equal(r.peer.of('agent').at(-1)?.busy, false);
  // A Mac tool's 3 s after: the Mac refuses 'agent', so the phone says busy until they pass.
  const tool = r.gate.wrap({ name: 'open', execute: async () => 'ok' });
  await tool.execute({ target: 'Safari' }, {}); await flush();
  assert.equal(r.peer.of('agent').at(-1).busy, true, 'busy right after a Mac tool (the 3 s the input rule waits)');
  r.peer.phone({ t: 'scroll', n: 1, x: 0.5, y: 0.5, dx: 0, dy: 5 }); await flush();
  assert.deepEqual(r.peer.of('refused').at(-1), { t: 'refused', n: 1, why: 'agent' });
  await r.clock.advance(4_000);
  assert.equal(r.peer.of('agent').at(-1).busy, false, 'then not busy, once the Mac takes input again');
  contract(r.peer);
  r.view.stop();
}

// ---- Return reads the focus live: after a Tab onto Place order, and in a web checkout field ----
{
  const r = rig();
  await r.live();
  const h = r.helper;
  h.emit({ ev: 'focus', role: 'AXTextField', label: 'Name on card', secure: false, secureInput: false, rect: [10, 10, 200, 20] }); await flush();
  r.peer.phone({ t: 'key', n: 1, k: 'tab' }); await flush();
  h.focus = { role: 'AXButton', label: 'Place order', secure: false, secureInput: false }; // moved; the 200 ms poll has not seen it
  r.peer.phone({ t: 'key', n: 2, k: 'return' }); await flush();
  assert.equal(r.peer.of('ask').at(-1)?.label, 'Place order', 'Return right after a Tab asks');
  assert.deepEqual(r.inputs().map((c) => c.k), ['tab'], 'the Return waits for the yes');
  h.focus = { role: 'AXTextField', label: 'ZIP', secure: false, secureInput: false }; h.buttons = ['Back', 'Place your order'];
  r.peer.phone({ t: 'text', n: 3, s: '94103\n' }); await flush();
  assert.equal(r.peer.of('ask').at(-1)?.label, 'Place your order', 'a newline in a web form with a pay button asks');
  r.peer.phone({ t: 'key', n: 4, k: 'return' }); await flush();
  assert.equal(r.peer.of('ask').length, 3, 'and so does Return');
  h.buttons = ['Search'];
  r.peer.phone({ t: 'key', n: 5, k: 'return' }); await flush();
  assert.equal(r.inputs().at(-1).n, 5, 'Return in a form with no pay button goes');
  assert.ok(h.cmds.some((c) => c.cmd === 'focus'), 'the focus is read live');
  contract(r.peer);
  r.view.stop();
}

// ---- Take over waits for a Mac tool that began before the view went live ----
{
  const r = rig();
  let finish;
  const act = r.gate.wrap({ name: 'act_in_app', execute: () => new Promise((res) => { finish = res; }) });
  const p = act.execute({ app: 'Safari' }, {});
  await r.live();
  let resolved = false;
  r.gate.takeover().then(() => { resolved = true; });
  await flush();
  assert.equal(resolved, false, 'not in control while the agent tool still runs');
  assert.equal(r.gate.active(), true);
  finish('ok'); await p; await flush();
  assert.equal(resolved, true, 'then in control');
  r.view.stop();
}

// ---- a field keeps its card tail when focus leaves and comes back ----
{
  const r = rig();
  await r.live();
  const h = r.helper;
  const notes = { ev: 'focus', role: 'AXTextField', label: 'Card', secure: false, secureInput: false, rect: [10, 10, 200, 20] };
  h.emit(notes); await flush();
  r.peer.phone({ t: 'text', n: 1, s: '4111 1111' }); await flush();
  h.emit({ ...notes, label: 'Notes', rect: [10, 40, 200, 20] }); await flush();
  h.emit(notes); await flush();
  r.peer.phone({ t: 'text', n: 2, s: ' 1111 1111' }); await flush();
  assert.deepEqual(r.peer.of('refused').at(-1), { t: 'refused', n: 2, why: 'card' }, 'the rest of the number after a round trip is refused');
  r.view.stop();
}

// ---- the owner's screenshot chords from the phone are refused ----
{
  const ctx = { display: { w: 100, h: 100 }, shields: [], locked: false, agent: { busy: false, owner: false }, focus: { role: 'AXTextField', label: 'Subject' }, frontSecret: false, tail: '' };
  for (const k of ['cmd+shift+3', 'cmd+shift+4', 'shift+cmd+5', 'ctrl+cmd+shift+4', 'cmd+shift+6']) assert.deepEqual(checkInput({ t: 'key', n: 1, k }, ctx), { do: 'refuse', why: 'secret' }, k);
  assert.equal(checkInput({ t: 'key', n: 1, k: 'cmd+3' }, ctx).do, 'allow');
}

// ---- target-bound input is never replayed after the helper reports a change ----
{
  const r = rig();
  await r.live();
  const h = r.helper;
  h.answer = false; // this test answers each input itself
  r.peer.phone({ t: 'scroll', n: 1, x: 0.5, y: 0.5, dx: 0, dy: 5 }); await flush();
  h.emit({ ev: 'windows', gen: 4, list: [] });
  h.emit({ ev: 'refused', n: 1, why: 'changed' }); await flush();
  assert.deepEqual(r.inputs().map((c) => [c.n, c.shieldsGen]), [[1, 0]], 'the first scroll is not dispatched again');
  assert.deepEqual(r.peer.of('refused'), [{ t: 'refused', n: 1, why: 'changed' }]);
  // The next explicit scroll checks the new shields.
  h.emit({ ev: 'windows', gen: 5, list: [VAULT] });
  r.peer.phone({ t: 'scroll', n: 2, x: 0.4, y: 0.4, dx: 0, dy: 5 }); await flush();
  assert.deepEqual(r.peer.of('refused').at(-1), { t: 'refused', n: 2, why: 'secret' });
  r.peer.phone({ t: 'scroll', n: 3, x: 0.05, y: 0.05, dx: 0, dy: 5 }); await flush();
  assert.deepEqual(r.inputs().map((c) => [c.n, c.shieldsGen]), [[1, 0], [3, 5]]);
  h.emit({ ev: 'done', n: 3 }); await flush();
  assert.equal(r.api.op('end').length, 0);
  r.view.stop(); await flush();
  assert.equal(r.api.op('end')[0].stats.scrolls, 2, 'each dispatched scroll is counted once');
}

// ---- the live beat: a failed one is tried again in 2 s; one that never landed goes before the end ----
{
  const api = fakeApi();
  api.beatStatus = 503;
  const r = rig({ api });
  await r.live();
  assert.equal(api.op('beat').length, 1);
  await r.clock.advance(2_100);
  assert.equal(api.op('beat').length, 2, 'tried again in 2 s');
  r.peer.phone({ t: 'scroll', n: 1, x: 0.5, y: 0.5, dx: 0, dy: 5 }); await flush();
  r.peer.phone({ t: 'bye' }); await flush();
  const ops = api.ops.map((o) => o.op);
  assert.deepEqual(ops.slice(-2), ['beat', 'end'], `a live beat goes just before the end (${ops})`);
  assert.equal(api.ops.at(-2).stats.scrolls, 1);
}
{
  const r = rig();
  await r.live();
  r.peer.phone({ t: 'bye' }); await flush();
  assert.deepEqual(r.api.ops.map((o) => o.op), ['answer', 'beat', 'end'], 'no second beat when the first landed');
}

// ---- idle: nothing off the contract at 5 min; the end at 5 min 30 s ----
{
  const r = rig();
  await r.live();
  await r.clock.advance(5 * 60_000 + 1_000);
  assert.equal(r.api.op('end').length, 0);
  contract(r.peer);
  await r.clock.advance(30_000);
  assert.equal(r.api.op('end')[0]?.reason, 'idle');
}

// ---- Stop kills a running hands plan (act_in_app), not only the turn ----
if (process.platform === 'darwin') {
  const HOME = fs.realpathSync.native(os.homedir());
  assert.ok(HOME.includes('roamies-test-') || HOME.startsWith(fs.realpathSync.native(os.tmpdir())), 'runs only with a temp home');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-rv2-'));
  const fake = path.join(dir, 'hands.mjs'), pidFile = path.join(dir, 'pid'), doneFile = path.join(dir, 'done');
  fs.writeFileSync(fake, `import fs from 'node:fs'; const a = process.argv.slice(2);
const win = { id: 7, app: 'TextEdit', title: 'x', bounds: [0, 0, 800, 600] };
if (a[0] === 'act') { fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => { fs.writeFileSync(${JSON.stringify(doneFile)}, 'x'); console.log(JSON.stringify({ ok: true, done: [], window: win })); }, 8000); }
else console.log(JSON.stringify(a[0] === 'front' ? { ok: true, app: 'TextEdit' } : { ok: true, window: win, controls: [], texts: [], note: '' }));
`);
  process.env.ROAMIES_HANDS = fake;
  const { createTools } = await import('../tools.mjs');
  const { tools } = createTools({ allowActions: () => true, ui: () => {}, ask: async () => 'Allow', openUrl: async () => {}, onCommitments: () => {}, showList: () => {}, fmtWhen: String, commitmentsText: () => '', userName: 'Test', workdir: HOME });
  const ac = new AbortController();
  const t0 = Date.now();
  const run = tools.find((t) => t.name === 'act_in_app').execute({ target: 'TextEdit', steps: [{ do: 'type', text: 'hello' }] }, { signal: ac.signal });
  run.catch(() => {});
  while (!fs.existsSync(pidFile) && Date.now() - t0 < 5_000) await new Promise((res) => setTimeout(res, 20));
  assert.ok(fs.existsSync(pidFile), 'the plan started');
  const pid = +fs.readFileSync(pidFile, 'utf8');
  ac.abort();
  await assert.rejects(run, 'a stopped plan does not report success');
  assert.ok(Date.now() - t0 < 4_000, `the call ends at Stop, not when the plan does (${Date.now() - t0} ms)`);
  await new Promise((res) => setTimeout(res, 200));
  assert.throws(() => process.kill(pid, 0), /ESRCH/, 'the hands helper process is gone');
  assert.equal(fs.existsSync(doneFile), false, 'and never ran its remaining steps');
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log('remoteround2 ok');
