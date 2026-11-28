// The phone view's Mac side (RV plan D2 and D3, T-D2-3 to T-D2-9) against a fake helper, a fake peer, a fake Hydra
// and a clock the test moves: the poll only with Phone View on and both permissions; the pill before any frame; the
// pull chain (2 frames in flight at most, the send buffer, quality steps); pause when not viewed; idle and hidden
// auto-ends; beats; shields and their 500 ms linger; input rules with secure-field, card and money asks; agent
// captions and the cursor; take over, hand back, stop; End on the pill; the log never holds typed text. Run: npm test
import assert from 'node:assert/strict';
import { createRemoteView, frameReader } from '../remoteview.mjs';
import { createViewGate } from '../viewgate.mjs';
import { macMessageSchema, macPostSchema } from '../remoteschema.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fakeApi, fakeClock, fakeHelper, fakePeer, flush, SESSION } from './fakeremote.mjs';

function rig({ enabled = true, perms = { screen: true, ax: true }, busy = false, auto = true, displays, pairing } = {}) {
  const clock = fakeClock(), api = fakeApi(), peer = fakePeer(), st = { enabled, perms, busy, stops: 0, probes: 0, helpers: 0 }, logs = [];
  let helper = fakeHelper({ auto, ...(displays ? { displays } : {}) });
  const gate = createViewGate({ clock, onStop: () => { st.stops += 1; } });
  const view = createRemoteView({
    api, clock, gate, pairing, home: '/Users/test', macName: 'Mac mini',
    enabled: () => st.enabled,
    probe: async () => { st.probes += 1; return st.perms; },
    spawnHelper: () => { st.helpers += 1; return helper; },
    makePeer: async () => peer, peerOk: async () => true,
    onStop: () => gate.stop(),
    agentBusy: () => st.busy,
    log: (k, d) => logs.push([k, d]),
  });
  const r = {
    clock, api, peer, st, logs, gate, view,
    get helper() { return helper; }, set helper(h) { helper = h; },
    async live() {
      view.start();
      await flush();
      api.offer({ ...SESSION });
      await flush();
      peer.open();
      peer.phone({ t: 'hello', v: 1, w: 390, h: 844, dpr: 3 });
      await flush();
    },
    // Acks every frame sent so far, ms from now (the newest one's round trip is then ms).
    async ackAll(ms = 0) { await clock.advance(ms); const f = r.frameIds().at(-1); if (f == null || f <= r.acked) return; r.acked = f; peer.phone({ t: 'ack', f, ms }); await flush(); },
    frameIds: () => peer.scr.map((b) => b.readUInt32BE(4)),
    acked: 0,
    // Acks the oldest frame not acked yet, ms after it was sent (acks are cumulative: the channel is ordered).
    async ackNext(ms = 0) { await clock.advance(ms); const f = r.frameIds().find((x) => x > r.acked); if (f == null) return; r.acked = f; peer.phone({ t: 'ack', f, ms }); await flush(); },
  };
  return r;
}
// Every ctl message the Mac sent matches the contract (remoteschema.mjs).
const contract = (peer) => { for (const m of peer.sent) assert.ok(macMessageSchema.safeParse(m).success, `contract: ${JSON.stringify(m)}`); };

{
  const r = rig();
  await r.live();
  r.peer.phone({ t: 'takeover' });
  await flush();
  assert.equal(r.peer.of('agent').at(-1).control, true, 'the phone still receives notices during takeover');
  const h = r.helper;
  h.answer = false;
  r.peer.phone({ t: 'text', n: 1, s: 'fixture' });
  await flush();
  h.emit({ ev: 'done', n: 1, partial: true, postedChars: 3 });
  await flush();
  r.peer.phone({ t: 'text', n: 2, s: 'lost' });
  await flush();
  await r.clock.advance(1_501);
  h.emit({ ev: 'done', n: 2, partial: true, postedChars: 1 });
  await flush();
  r.peer.phone({ t: 'text', n: 3, s: 'ok' });
  await flush();
  h.emit({ ev: 'done', n: 3 });
  await flush();
  r.view.stop();
  await flush();
  assert.equal(r.api.op('end').at(-1).stats.chars, 2, 'only fully acknowledged characters enter Activity');
  assert.deepEqual(r.logs.filter(([, d]) => /^input_/.test(d.event)).map(([, d]) => d), [
    { event: 'input_partial', input: 'text', requestedChars: 7, postedChars: 3 },
    { event: 'input_unknown', input: 'text', requestedChars: 4, postedChars: null },
    { event: 'input_partial', input: 'text', requestedChars: 4, postedChars: 1 },
  ]);
  assert.deepEqual(h.cmds.filter((m) => m.cmd === 'input').map((m) => m.n), [1, 2, 3]);
  assert.deepEqual(r.peer.of('refused'), [{ t: 'refused', n: 1, why: 'partial' }, { t: 'refused', n: 2, why: 'unknown' }], 'one passive notice per operation even if the helper later responds');
  assert.equal(r.api.op('end').at(-1).stats.refused, 0, 'delivery notices are not full refusals in Activity');
  contract(r.peer);
}

{
  let pair = 'first-pairing';
  const r = rig({ pairing: () => pair });
  const calls = [], req = r.api.req;
  r.api.req = (p, opts) => { if (opts.body) calls.push([opts.body.op, opts.pairBinding]); return req(p, opts); };
  await r.live();
  r.view.stop();
  pair = 'second-pairing';
  await flush();
  assert.equal(r.peer.closed, true);
  assert.deepEqual(calls.at(-1), ['end', 'first-pairing']);
}

// ---- frame reader: [u32 BE length][u8 type][payload], split anywhere ----
{
  const got = [];
  const read = frameReader((type, payload) => got.push([type, type === 1 ? JSON.parse(payload) : payload.length]));
  const f = (type, buf) => { const h = Buffer.alloc(5); h.writeUInt32BE(buf.length, 0); h[4] = type; return Buffer.concat([h, buf]); };
  const all = Buffer.concat([f(1, Buffer.from('{"ev":"ready"}')), f(2, Buffer.alloc(70_000)), f(1, Buffer.from('{"ev":"done","n":3}'))]);
  for (let i = 0; i < all.length; i += 997) read(all.subarray(i, i + 997));
  assert.deepEqual(got, [[1, { ev: 'ready' }], [2, 70_000], [1, { ev: 'done', n: 3 }]]);
}

// ---- T-D2-7 no poll unless Phone View is on and both permissions hold ----
{
  const r = rig({ enabled: false });
  r.view.start();
  await r.clock.advance(120_000);
  assert.equal(r.api.polls, 0, 'Phone View off: no request to /remote/mac');
  r.st.enabled = true; r.st.perms = { screen: true, ax: false };
  r.view.refresh();
  await r.clock.advance(120_000);
  assert.equal(r.api.polls, 0, 'Accessibility missing: no request');
  r.st.perms = { screen: true, ax: true };
  await r.clock.advance(61_000);
  assert.equal(r.api.polls, 1, 'both granted: the poll starts (permissions read again each minute)');
  r.view.stop();
}

// ---- session start: the pill first, answer, live beat, hello ----
{
  const r = rig();
  await r.live();
  const h = r.helper;
  assert.equal(h.cmds[0].cmd, 'start', 'the helper starts (and shows the pill) before anything else');
  assert.equal(h.cmds[0].maxLong, 1920);
  assert.deepEqual(r.api.op('answer'), [{ op: 'answer', sessionId: SESSION.id, sdp: 'v=0 answer' }]);
  const live = r.api.op('beat');
  assert.equal(live.length, 1); assert.equal(live[0].live, true, 'the first beat after the phone says hello is live');
  for (const o of r.api.ops) assert.ok(macPostSchema.safeParse(o).success, `op contract: ${JSON.stringify(o)}`);
  const hello = r.peer.of('hello')[0];
  assert.equal(hello.mac.name, 'Mac mini'); assert.equal(hello.display, 1); assert.equal(hello.displays[0].w, 1000);
  assert.deepEqual(r.peer.of('geom')[0], { t: 'geom', gen: 0, display: 1, w: 1000, h: 800 });
  assert.ok(r.logs.some(([k, d]) => k === 'remote_view' && d.event === 'start'));
  // ---- T-D2-3 the pull chain ----
  assert.equal(h.count('next'), 2, 'two frames asked at once');
  assert.equal(h.cmds.find((c) => c.cmd === 'next').key, true, 'the first is a key frame');
  await r.clock.advance(2_000);
  assert.equal(h.count('next'), 2, 'no next while 2 frames wait for an acknowledge');
  await r.ackNext();
  assert.equal(h.count('next'), 3, 'an ack asks for one more');
  // The send buffer over 256 KB holds the next frame until it drains.
  r.peer.buffered = 300_000;
  await r.ackNext();
  assert.equal(h.count('next'), 3, 'a full send buffer holds next');
  r.peer.buffered = 0;
  await r.clock.advance(100);
  assert.equal(h.count('next'), 4, 'then it goes');
  // Slow round trips step down to 0.3 / 0.5.
  for (let i = 0; i < 8; i++) await r.ackAll(600);
  assert.deepEqual([h.last('next').q, h.last('next').scale], [0.3, 0.5], '600 ms round trips: quality 0.3, scale 0.5');
  // Fast ones for 2 s step up once.
  const before = h.count('next');
  for (let i = 0; i < 45; i++) await r.ackAll(80);
  assert.ok(h.count('next') > before);
  const qs = h.cmds.filter((c) => c.cmd === 'next').slice(before).map((c) => c.q);
  assert.ok(qs.includes(0.4), `80 ms round trips for 2 s step up (${qs})`);
  assert.equal(qs.filter((q, i) => i && q !== qs[i - 1]).length <= 2, true, 'one step per 2 s, not a jump');
  contract(r.peer);
  r.view.stop();
}

// ---- pause when not viewed; hidden 60 s ends; resume asks for a key frame ----
{
  const r = rig();
  await r.live();
  r.peer.phone({ t: 'pause' }); await flush();
  assert.equal(r.helper.last('pause')?.cmd, 'pause', 'pause stops capture on the Mac');
  const n = r.helper.count('next');
  await r.ackNext(); await r.ackNext();
  assert.equal(r.helper.count('next'), n, 'no next while paused');
  await r.clock.advance(30_000);
  r.peer.phone({ t: 'resume' }); await flush();
  assert.equal(r.helper.last('resume')?.cmd, 'resume');
  const after = r.helper.cmds.slice(r.helper.cmds.lastIndexOf(r.helper.last('resume')));
  assert.equal(after.find((c) => c.cmd === 'next')?.key, true, 'resume asks for a key frame');
  r.peer.phone({ t: 'pause' }); await flush();
  await r.clock.advance(60_000);
  assert.equal(r.api.op('end')[0]?.reason, 'hidden', 'hidden for 60 s ends the session');
  assert.equal(r.peer.of('bye')[0].reason, 'hidden');
  assert.equal(r.helper.count('quit'), 1); assert.equal(r.peer.closed, true);
}

// ---- A display transition drops old frames and input queued against the previous geometry. ----
{
  const displays = [{ id: 1, name: 'Built-in', x: 0, y: 0, w: 1000, h: 800, main: true }, { id: 2, name: 'Second', x: 1000, y: 0, w: 1000, h: 800, main: false }];
  const r = rig({ auto: false, displays });
  await r.live();
  const h = r.helper;
  h.answer = false;
  r.peer.phone({ t: 'click', n: 1, x: 0.1, y: 0.1, b: 'l', c: 1 });
  await flush();
  assert.equal(h.count('input'), 1);
  r.peer.phone({ t: 'move', n: 2, x: 0.2, y: 0.2 });
  r.peer.phone({ t: 'display', id: 2 });
  h.frame();
  assert.equal(r.peer.scr.length, 0, 'a late frame must not leave during a switch');
  h.emit({ ev: 'geom', gen: 1, display: 2, w: 1000, h: 800 });
  h.frame(3, 0);
  assert.equal(r.peer.scr.length, 0, 'the old generation must not leave after the switch');
  h.emit({ ev: 'done', n: 1 });
  await flush();
  assert.equal(h.count('input'), 1, 'queued input cannot be remapped to the new display');
  assert.deepEqual(r.peer.of('refused').at(-1), { t: 'refused', n: 2, why: 'changed' });
  h.frame();
  assert.equal(r.peer.scr.length, 1, 'a frame on the requested display can leave');
  r.view.stop();
}
{
  const displays = [{ id: 1, name: 'Built-in', x: 0, y: 0, w: 1000, h: 800, main: true }, { id: 2, name: 'Second', x: 1000, y: 0, w: 1000, h: 800, main: false }];
  const r = rig({ auto: false, displays });
  await r.live();
  r.peer.phone({ t: 'display', id: 2 });
  r.helper.emit({ ev: 'geom', gen: 1, display: 1, w: 1000, h: 800 });
  r.helper.frame();
  assert.equal(r.peer.scr.length, 0, 'the helper must confirm the exact display requested');
  assert.equal(r.view.live(), false);
  r.view.stop();
}
{
  const r = rig({ auto: false });
  await r.live();
  const h = r.helper;
  h.resumeGeometry = false;
  r.peer.phone({ t: 'pause' });
  r.peer.phone({ t: 'resume' });
  const requested = h.last('resume').id;
  h.emit({ ev: 'geom', gen: 1, display: 1, w: 1000, h: 800 });
  h.frame();
  r.peer.phone({ t: 'move', n: 1, x: 0.2, y: 0.2 });
  await flush();
  assert.equal(r.peer.scr.length, 0, 'older geometry cannot clear the resume gate');
  assert.equal(h.count('input'), 0);
  h.emit({ ev: 'geom', gen: 2, display: 1, w: 1000, h: 800, resume: requested });
  h.frame();
  assert.equal(r.peer.scr.length, 1);
  r.view.stop();
}

// ---- RV r4: "Still there?" at 5 min, "here" answers it; a watched task's end restarts the clock and never ends
// the view without the prompt; a Mac Stop during Take over tells the phone and the pill ----
{
  const r = rig();
  await r.live();
  await r.clock.advance(5 * 60_000 + 1_000);
  assert.equal(r.peer.of('idle').length, 1, 'the prompt goes out at 5 min');
  assert.equal(r.peer.of('idle')[0].ms, 30_000);
  r.peer.phone({ t: 'here' }); await flush();
  await r.clock.advance(31_000);
  assert.equal(r.api.op('end').length, 0, '"here" keeps the view');
  await r.clock.advance(4 * 60_000 + 30_000);
  assert.equal(r.peer.of('idle').length, 2, 'the prompt again 5 min after "here"');
  await r.clock.advance(31_000);
  assert.equal(r.api.op('end')[0]?.reason, 'idle', 'unanswered: the view ends');
  contract(r.peer);
}
{
  const r = rig();
  await r.live();
  const turn = r.gate.turn();
  await r.clock.advance(6 * 60_000);
  assert.equal(r.api.op('end').length, 0, 'no end while the agent works');
  turn.done();
  await r.clock.advance(5_000);
  assert.equal(r.api.op('end').length, 0, 'the task the owner watched ended: the view stays');
  assert.equal(r.peer.of('idle').length, 0, 'and no prompt yet');
  await r.clock.advance(5 * 60_000);
  assert.equal(r.peer.of('idle').length, 1, 'the prompt 5 min after the task ended');
  assert.equal(r.api.op('end').length, 0);
  await r.clock.advance(31_000);
  assert.equal(r.api.op('end')[0]?.reason, 'idle');
}
{
  const r = rig();
  await r.live();
  r.peer.phone({ t: 'takeover' }); await flush();
  assert.equal(r.gate.owner(), true);
  r.gate.stop({ quiet: true }); await flush();
  const last = r.peer.of('agent').at(-1);
  assert.equal(last.control, false, 'the phone hears it is no longer in control');
  assert.deepEqual(r.helper.last('state'), { cmd: 'state', text: 'Being viewed from your phone' }, 'the pill words go back');
  r.peer.phone({ t: 'key', n: 9, k: 'escape' }); await flush();
  assert.equal(r.view.phoneEsc(), true, 'an Esc from the phone is known for 1 s');
  await r.clock.advance(1_500);
  assert.equal(r.view.phoneEsc(), false);
  contract(r.peer);
  r.view.stop();
}
// ---- T-D2-4 idle: the end at 5 min 30 s (the prompt at 5 min); a touch resets;
// 30 min while the agent works; channel loss ----
{
  const r = rig();
  await r.live();
  await r.clock.advance(4 * 60_000);
  r.peer.phone({ t: 'scroll', n: 1, x: 0.05, y: 0.05, dx: 0, dy: 5 }); await flush();
  await r.clock.advance(5 * 60_000 + 29_000);
  assert.equal(r.api.op('end').length, 0, 'a touch at 4 min resets the 5 min 30 s');
  await r.clock.advance(2_000);
  assert.equal(r.peer.of('bye')[0]?.reason, 'idle'); assert.equal(r.api.op('end')[0]?.reason, 'idle');
  const stats = r.api.op('end')[0].stats;
  assert.ok(macPostSchema.safeParse(r.api.op('end')[0]).success, `end op contract: ${JSON.stringify(r.api.op('end')[0])}`);
  assert.ok(stats.frames >= 2 && stats.scrolls === 1, `stats: ${JSON.stringify(stats)}`);
  assert.ok(r.logs.some(([k, d]) => k === 'remote_view' && d.event === 'end' && d.reason === 'idle' && d.secs > 500));
}
{
  const r = rig({ busy: true });
  await r.live();
  await r.clock.advance(29 * 60_000);
  assert.equal(r.api.op('end').length, 0, 'no idle end at 5 min while an agent turn runs');
  await r.clock.advance(61_000);
  assert.equal(r.api.op('end')[0]?.reason, 'idle', '30 min with no touch while the agent works');
}
{
  const r = rig();
  await r.live();
  r.peer.drop();
  await r.clock.advance(14_000);
  assert.equal(r.api.op('end').length, 0);
  await r.clock.advance(1_500);
  assert.equal(r.api.op('end')[0]?.reason, 'error', 'a closed channel ends in 15 s');
}
{
  const r = rig({ busy: true });
  await r.live();
  for (let i = 0; i < 25; i++) { await r.clock.advance(5 * 60_000); r.peer.phone({ t: 'scroll', n: i, x: 0.05, y: 0.05, dx: 0, dy: 1 }); await flush(); }
  assert.equal(r.api.op('end')[0]?.reason, 'limit', 'two hours is the limit');
}

// ---- T-D2-5 beats: every 20 s; ended or 401 closes the peer and quits the helper ----
{
  const r = rig();
  await r.live();
  await r.clock.advance(20_000);
  assert.equal(r.api.op('beat').length, 2, 'a beat every 20 s');
  r.api.beatAnswer = 'ended';
  await r.clock.advance(20_000);
  assert.equal(r.peer.closed, true); assert.equal(r.helper.count('quit'), 1);
  assert.equal(r.api.op('end').length, 0, 'the server ended it: nothing more is posted');
}
{
  const r = rig();
  await r.live();
  r.api.beatStatus = 401;
  await r.clock.advance(20_000);
  assert.equal(r.peer.closed, true); assert.equal(r.helper.count('quit'), 1);
  assert.ok(r.logs.some(([k, d]) => k === 'remote_view' && d.event === 'end' && d.reason === 'revoked'));
}
{
  const r = rig();
  await r.live();
  const req = r.api.req;
  let pending;
  r.api.req = (path, options) => {
    if (options.body?.op !== 'beat') return req(path, options);
    return new Promise((resolve) => { pending = { resolve, signal: options.signal }; });
  };
  r.peer.phone({ t: 'takeover' }); await flush();
  await r.clock.advance(59_999);
  assert.equal(r.view.live(), true);
  await r.clock.advance(1);
  assert.equal(r.peer.closed, true, 'a hung heartbeat cannot keep Phone View open at 60 seconds');
  assert.equal(r.helper.count('quit'), 1);
  assert.equal(r.gate.owner(), false);
  assert.equal(pending.signal.aborted, true);
  const frames = r.peer.scr.length, inputs = r.helper.count('input');
  pending.resolve({ ok: true, status: 200, json: async () => ({ ok: true, status: 'live' }) });
  r.helper.frame();
  r.peer.phone({ t: 'click', n: 1, x: 0.2, y: 0.2, b: 'l', c: 1 });
  await flush();
  assert.equal(r.helper.count('input'), inputs);
  assert.equal(r.peer.scr.length, frames);
  assert.equal(r.api.op('end')[0]?.reason, 'timeout');
  r.view.stop();
}
{
  const r = rig();
  await r.live();
  const req = r.api.req;
  r.api.req = (path, options) => options.body?.op === 'beat'
    ? Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) }) : req(path, options);
  await r.clock.advance(60_000);
  assert.equal(r.view.live(), false, 'a response without live status cannot renew the lease');
  r.view.stop();
}
{
  const r = rig();
  await r.live();
  await r.clock.advance(20_000);
  const now = r.clock.now, lease = r.helper.last('lease');
  assert.equal(lease.until, now() + 60_000);
  const req = r.api.req;
  r.api.req = (path, options) => options.body?.op === 'beat' ? Promise.reject(new Error('offline')) : req(path, options);
  await r.clock.advance(40_000);
  assert.equal(r.view.live(), true, 'a valid later beat renews the lease');
  r.clock.now = () => now() + 20_001; // resume before any queued timer has fired
  const captured = r.peer.scr.length;
  r.helper.frame();
  r.peer.phone({ t: 'scroll', n: 1, x: 0.2, y: 0.2, dx: 0, dy: 1 });
  await flush();
  assert.equal(r.peer.scr.length, captured, 'no frame is forwarded after resuming beyond the lease');
  assert.equal(r.helper.count('input'), 0, 'no input is forwarded after resuming beyond the lease');
  assert.equal(r.peer.closed, true);
  r.view.stop();
}
// A lease that expires during a live focus request still stops the session before dispatch.
{
  const r = rig();
  await r.live();
  const h = r.helper, send = h.send;
  let read;
  h.send = (m) => { if (m.cmd === 'focus') read = m; else send(m); };
  r.peer.phone({ t: 'key', n: 1, k: 'tab' });
  await flush();
  assert.ok(read, 'the key is waiting on a live focus read');
  const now = r.clock.now;
  r.clock.now = () => now() + 60_001;
  h.emit({ ev: 'hit', id: read.id, role: 'AXTextField', label: 'Notes', proved: true });
  await flush();
  assert.equal(h.count('input'), 0, 'a focus reply cannot dispatch after the lease expires');
  assert.equal(r.api.op('end').at(-1).reason, 'timeout');
  assert.deepEqual(r.peer.of('refused'), [], 'nothing is sent back after the expired session closes');
  r.view.stop();
}
// A 409 on the answer: the session was replaced or ended; the peer is dropped.
{
  const r = rig();
  r.api.answerStatus = 409;
  await r.live();
  assert.equal(r.peer.closed, true); assert.equal(r.helper.count('quit'), 1); assert.equal(r.api.op('beat').length, 0);
}

// ---- shields: sent to the helper and the phone; a gone window stays hidden 500 ms ----
{
  const r = rig();
  await r.live();
  const h = r.helper;
  h.emit({ ev: 'windows', gen: 1, list: [{ id: 7, pid: 70, app: '1Password', bundle: 'com.1password.1password', title: '1Password', bounds: [100, 100, 300, 200] }, { id: 8, pid: 80, app: 'TextEdit', title: 'a.txt', bounds: [0, 0, 50, 50] }] });
  await flush();
  assert.deepEqual(h.last('shields'), { cmd: 'shields', gen: 1, rects: [[100, 100, 300, 200]], exclude: [7] });
  assert.deepEqual(r.peer.of('shield').at(-1), { t: 'shield', rects: [[100, 100, 300, 200]] }, 'frame pixels (1:1 here)');
  h.emit({ ev: 'windows', gen: 2, list: [] }); await flush();
  assert.deepEqual(h.last('shields').rects, [[100, 100, 300, 200]], 'a window just gone stays hidden');
  assert.equal(h.last('shields').gen, 2);
  await r.clock.advance(600);
  assert.deepEqual(h.last('shields').rects, [], 'then the shield lifts after 500 ms');
  contract(r.peer);
  r.view.stop();
}

// ---- inputs: the helper gets them with shieldsGen; the rules refuse; the log never holds typed text (T-D2-9) ----
{
  const r = rig();
  await r.live();
  const h = r.helper, n0 = () => h.cmds.filter((c) => c.cmd === 'input');
  h.emit({ ev: 'windows', gen: 3, list: [{ id: 7, pid: 70, app: 'Bitwarden', title: 'Vault', bounds: [500, 400, 300, 200] }] });
  h.emit({ ev: 'focus', role: 'AXTextField', label: 'Subject', secure: false, secureInput: false, rect: [10, 10, 200, 20] });
  await flush();
  r.peer.phone({ t: 'click', n: 1, x: 0.1, y: 0.1, b: 'l', c: 1 }); await flush();
  assert.equal(h.last('hit')?.x, 0.1, 'a click is hit-tested first');
  assert.deepEqual(n0().at(-1), { cmd: 'input', t: 'click', n: 1, x: 0.1, y: 0.1, b: 'l', c: 1, shieldsGen: 3, proof: h.last('hit').id }, 'a tap uses the target proof and current shields generation');
  r.peer.phone({ t: 'click', n: 2, x: 0.6, y: 0.6, b: 'l', c: 1 }); await flush();
  assert.deepEqual(r.peer.of('refused').at(-1), { t: 'refused', n: 2, why: 'secret' }, 'a tap on the vault is refused');
  assert.equal(n0().length, 1);
  r.peer.phone({ t: 'text', n: 3, s: 'hunter2' }); await flush();
  assert.equal(n0().at(-1).s, 'hunter2', 'text into a plain field goes');
  r.peer.phone({ t: 'drag', n: 3 }); await flush(); // not in the contract: ignored
  h.emit({ ev: 'focus', role: 'AXTextField', label: 'Password', secure: true, secureInput: true, rect: [10, 40, 200, 20] }); await flush();
  r.peer.phone({ t: 'text', n: 4, s: 'hunter2' }); await flush();
  assert.deepEqual(r.peer.of('refused').at(-1), { t: 'refused', n: 4, why: 'credential' }, 'text into a password field is refused');
  r.peer.phone({ t: 'key', n: 5, k: 'cmd+v' }); await flush();
  assert.deepEqual(r.peer.of('refused').at(-1), { t: 'refused', n: 5, why: 'credential' }, 'and so is a paste');
  assert.deepEqual(r.peer.of('focus').at(-1), { t: 'focus', rect: [10, 40, 200, 20], secure: true });
  // A card number: the digits that complete it are refused; a focus change starts a new tail.
  h.emit({ ev: 'focus', role: 'AXTextField', label: 'Notes', secure: false, secureInput: false, rect: [10, 70, 200, 20] }); await flush();
  r.peer.phone({ t: 'text', n: 6, s: '4111 1111 1111 111' }); await flush();
  r.peer.phone({ t: 'text', n: 7, s: '1' }); await flush();
  assert.deepEqual(r.peer.of('refused').at(-1), { t: 'refused', n: 7, why: 'card' });
  h.emit({ ev: 'focus', role: 'AXTextField', label: 'Other', secure: false, secureInput: false, rect: [10, 100, 200, 20] }); await flush();
  r.peer.phone({ t: 'text', n: 8, s: '1' }); await flush();
  assert.equal(n0().at(-1).n, 8, 'a new field, a new tail');
  // The helper's own refusal is passed on.
  h.emit({ ev: 'refused', n: 8, why: 'credential' }); await flush();
  assert.deepEqual(r.peer.of('refused').at(-1), { t: 'refused', n: 8, why: 'credential' });
  // Locked.
  h.emit({ ev: 'locked', locked: true }); await flush();
  r.peer.phone({ t: 'click', n: 9, x: 0.1, y: 0.1, b: 'l', c: 1 }); await flush();
  assert.deepEqual(r.peer.of('refused').at(-1), { t: 'refused', n: 9, why: 'locked' });
  h.emit({ ev: 'locked', locked: false }); await flush();
  // A drag whose button comes up on the vault goes up where the drag last was.
  r.peer.phone({ t: 'down', n: 10, x: 0.1, y: 0.1 }); r.peer.phone({ t: 'move', n: 11, x: 0.2, y: 0.2 }); r.peer.phone({ t: 'up', n: 12, x: 0.6, y: 0.6 }); await flush();
  assert.deepEqual([n0().at(-1).t, n0().at(-1).x, n0().at(-1).y], ['up', 0.2, 0.2]);
  r.view.stop();
  await flush();
  const end = r.api.op('end')[0];
  assert.equal(end.reason, 'mac');
  assert.equal(end.stats.chars, 26, 'characters typed are counted');
  assert.ok(!JSON.stringify(r.logs).includes('hunter2') && !JSON.stringify(r.api.ops).includes('hunter2'), 'never the typed text in the log or the stats');
  assert.ok(r.logs.some(([k, d]) => k === 'remote_view' && d.event === 'refused' && d.why === 'credential'));
  contract(r.peer);
}

// ---- T-D2-6 money asks: yes within 30 s with the same label; late, twice or changed does nothing ----
{
  const r = rig();
  await r.live();
  const h = r.helper, inputs = () => h.cmds.filter((c) => c.cmd === 'input');
  h.hits.all = { role: 'AXButton', label: 'Place order', labels: ['Place order', 'Checkout'], app: 'Safari' };
  r.peer.phone({ t: 'click', n: 1, x: 0.3, y: 0.3, b: 'l', c: 1 }); await flush();
  const ask = r.peer.of('ask').at(-1);
  assert.deepEqual({ ...ask, id: 'x' }, { t: 'ask', id: 'x', label: 'Place order', app: 'Safari', why: 'money' });
  assert.equal(inputs().length, 0, 'nothing is clicked before the yes');
  await r.clock.advance(5_000);
  r.peer.phone({ t: 'answer', id: ask.id, yes: true }); await flush();
  assert.equal(inputs().length, 1, 'a yes with the same label clicks');
  assert.equal(inputs()[0].proof, h.cmds.find((c) => c.cmd === 'hit').id, 'the original proof travels with the input');
  assert.equal(h.count('hit'), 2, 'the point is tested again at the yes');
  r.peer.phone({ t: 'answer', id: ask.id, yes: true }); await flush();
  assert.equal(inputs().length, 1, 'an answer is used once');
  r.peer.phone({ t: 'click', n: 2, x: 0.3, y: 0.3, b: 'l', c: 1 }); await flush();
  const late = r.peer.of('ask').at(-1);
  await r.clock.advance(31_000);
  r.peer.phone({ t: 'answer', id: late.id, yes: true }); await flush();
  assert.equal(inputs().length, 1, 'a yes after 30 s does nothing');
  r.peer.phone({ t: 'click', n: 3, x: 0.3, y: 0.3, b: 'l', c: 1 }); await flush();
  const moved = r.peer.of('ask').at(-1);
  h.hits.all = { role: 'AXButton', label: 'Cancel', app: 'Safari' };
  r.peer.phone({ t: 'answer', id: moved.id, yes: true }); await flush();
  assert.equal(inputs().length, 1);
  assert.deepEqual(r.peer.of('refused').at(-1), { t: 'refused', n: 3, why: 'changed' }, 'a changed label refuses');
  r.peer.phone({ t: 'click', n: 4, x: 0.3, y: 0.3, b: 'l', c: 1 }); await flush();
  assert.equal(r.peer.of('ask').length, 3, 'Cancel does not ask');
  assert.ok(r.logs.some(([k, d]) => k === 'remote_view' && d.event === 'ask'));
  assert.ok(!JSON.stringify(r.logs).includes('Place order') && !JSON.stringify(r.logs).includes('Safari'));
  contract(r.peer);
  r.view.stop();
}
{
  const r = rig({ displays: [{ id: 1, x: 0, y: 0, w: 1000, h: 800 }, { id: 2, x: 1000, y: 0, w: 1000, h: 800 }] });
  await r.live();
  const h = r.helper, identity = { app: 7, window: 8, control: 9 }, hit = { role: 'AXButton', label: 'Pay now', app: 'Safari', identity };
  const click = (n) => r.peer.phone({ t: 'click', n, x: 0.3, y: 0.3, b: 'l', c: 1 });
  const yes = () => r.peer.phone({ t: 'answer', id: r.peer.of('ask').at(-1).id, yes: true });
  for (const [i, key] of ['app', 'window', 'control'].entries()) {
    h.hits.all = hit;
    click(i); await flush();
    h.hits.all = { ...hit, identity: { ...identity, [key]: 10 } };
    yes(); await flush();
    assert.deepEqual(r.peer.of('refused').at(-1), { t: 'refused', n: i, why: 'changed' }, `same label on a different ${key}`);
  }
  h.hits.all = { ...hit, identity: null };
  click(3); await flush();
  assert.equal(r.peer.of('ask').length, 3, 'money input with no original proof cannot ask');
  assert.deepEqual(r.peer.of('refused').at(-1), { t: 'refused', n: 3, why: 'changed' });
  h.hits.all = hit;
  click(4); await flush();
  r.peer.phone({ t: 'display', id: 2 });
  yes(); await flush();
  assert.deepEqual(r.peer.of('refused').at(-1), { t: 'refused', n: 4, why: 'changed' }, 'a display request invalidates the ask immediately');
  assert.equal(h.count('input'), 0);
  r.peer.phone({ t: 'display', id: 1 });
  h.emit({ ev: 'geom', gen: 1, display: 2, w: 1000, h: 800 });
  assert.equal(h.last('display').id, 1, 'the last display request goes after the first switch finishes');
  h.emit({ ev: 'error', why: 'display' });
  await flush();
  assert.equal(r.view.live(), false, 'an unconfirmed capture display cannot accept new input');
  r.view.stop();
}
{
  const r = rig();
  await r.live();
  const h = r.helper, focus = { role: 'AXButton', label: 'Pay now', app: 'Safari', identity: { app: 7, window: 8, control: 9 } };
  for (const [n, m] of [{ t: 'key', k: 'return' }, { t: 'key', k: 'space' }, { t: 'text', s: '\n' }].entries()) {
    h.focus = focus;
    r.peer.phone({ ...m, n }); await flush();
    h.focus = { ...focus, identity: { ...focus.identity, control: 10 } };
    r.peer.phone({ t: 'answer', id: r.peer.of('ask').at(-1).id, yes: true }); await flush();
    assert.deepEqual(r.peer.of('refused').at(-1), { t: 'refused', n, why: 'changed' });
  }
  assert.equal(h.count('input'), 0, 'an approved keyboard action never goes to an unverified control');
  r.view.stop();
}
{
  const r = rig();
  await r.live();
  const h = r.helper, hit = { role: 'AXButton', label: 'Pay now', app: 'Safari', identity: { app: 7, window: 8, control: 9 } };
  h.hits.all = hit;
  const send = h.send;
  h.send = (command) => {
    if (command.cmd === 'input') h.hits.all = { ...hit, identity: { ...hit.identity, control: 10 } };
    send(command);
  };
  r.peer.phone({ t: 'click', n: 1, x: 0.3, y: 0.3, b: 'l', c: 1 }); await flush();
  r.peer.phone({ t: 'answer', id: r.peer.of('ask').at(-1).id, yes: true }); await flush();
  assert.equal(h.count('input'), 1, 'the helper receives one checked attempt with the original proof');
  assert.deepEqual(r.peer.of('refused').at(-1), { t: 'refused', n: 1, why: 'changed' }, 'target change at dispatch refuses without replay');
  r.view.stop();
}

// ---- the agent: input refused while it works; captions, steps and the cursor; take over, hand back, stop ----
{
  const r = rig({ busy: true, displays: [{ id: 1, name: 'Built-in', x: 0, y: 0, w: 1000, h: 800, main: true }, { id: 2, name: 'Studio', x: 1000, y: 0, w: 1600, h: 900, main: false }] });
  await r.live();
  const h = r.helper;
  r.peer.phone({ t: 'click', n: 1, x: 0.1, y: 0.1, b: 'l', c: 1 }); await flush();
  assert.deepEqual(r.peer.of('refused').at(-1), { t: 'refused', n: 1, why: 'agent' }, 'input while the agent works');
  assert.deepEqual(r.peer.of('hello')[0].agent, { busy: true, paused: false });
  const open = r.gate.wrap({ name: 'open', execute: async () => 'Opened Safari.' });
  await open.execute({ target: 'Safari' }, {});
  assert.ok(r.peer.of('agent').some((m) => m.busy && m.caption === 'Opening Safari'), 'the tool caption reaches the phone');
  r.gate.step({ ev: 'step', do: 'click', label: 'Search', bounds: [100, 200, 50, 20] });
  r.gate.step({ ev: 'step', do: 'click', label: 'Far', bounds: [1500, 10, 50, 20] });
  r.gate.step({ ev: 'step', do: 'click', label: 'Nowhere', bounds: [9000, 9000, 5, 5] });
  await flush();
  const steps = r.peer.of('agent').filter((m) => m.step);
  assert.deepEqual(steps[0], { t: 'agent', busy: true, paused: false, caption: 'Clicking Search', step: { rect: [100, 200, 50, 20], kind: 'click', display: 1 } }, 'the cursor and highlight, in frame pixels');
  assert.deepEqual(steps[1].step, { rect: [500, 10, 50, 20], kind: 'click', display: 2 }, 'a step on another display names it (S17), in its points');
  assert.equal(steps.length, 2, 'a step on no display sends no rect');
  assert.equal(r.peer.of('agent').at(-1).caption, 'Clicking Nowhere');
  // Take over: the gate closes, the pill says so, the owner's input goes.
  r.peer.phone({ t: 'takeover' }); await flush();
  assert.equal(r.gate.owner(), true);
  assert.deepEqual(h.last('state'), { cmd: 'state', text: 'Your phone is in control' });
  r.peer.phone({ t: 'click', n: 2, x: 0.1, y: 0.1, b: 'l', c: 1 }); await flush();
  assert.equal(h.last('input')?.n, 2, 'after Take over the owner controls');
  assert.ok(r.peer.of('agent').some((m) => m.paused === true));
  r.peer.phone({ t: 'handback' }); await flush();
  assert.equal(r.gate.owner(), false);
  assert.deepEqual(h.last('state'), { cmd: 'state', text: 'Being viewed from your phone' });
  r.peer.phone({ t: 'stop' }); await flush();
  assert.equal(r.st.stops, 1, 'Stop from the phone runs the Mac\'s Stop path');
  // Ping and pong.
  r.peer.phone({ t: 'ping', id: 4 }); await flush();
  assert.equal(r.peer.of('pong')[0].id, 4);
  contract(r.peer);
  r.view.stop();
}
// Take over, then the session ends: the gate opens (the owner is gone).
{
  const r = rig();
  await r.live();
  r.peer.phone({ t: 'takeover' }); await flush();
  r.peer.phone({ t: 'bye' }); await flush();
  assert.equal(r.gate.owner(), false);
  assert.equal(r.api.op('end')[0].reason, 'phone');
}

// ---- End on the Mac pill; the helper dying; Phone View switched off; a replaced session ----
{
  const r = rig();
  await r.live();
  r.helper.emit({ ev: 'end', by: 'pill' }); await flush();
  assert.equal(r.api.op('end')[0].reason, 'mac', 'End on the pill ends the session');
  assert.equal(r.peer.of('bye')[0].reason, 'mac');
  assert.ok(r.logs.some(([k, d]) => k === 'remote_view' && d.event === 'end' && d.by === 'pill'));
}
{
  const r = rig();
  await r.live();
  r.st.enabled = false; r.view.refresh(); await flush();
  assert.equal(r.api.op('end')[0].reason, 'mac', 'Phone View switched off ends the live session first');
  const polls = r.api.polls;
  await r.clock.advance(120_000);
  assert.equal(r.api.polls, polls, 'and the poll stops');
}
{
  const r = rig();
  await r.live();
  const first = r.helper;
  r.helper = fakeHelper();
  r.api.offer({ ...SESSION, id: '7c5f0a52-6a3b-4b5e-9f2e-1d1d1d1d1d1d' }); await flush();
  assert.equal(first.count('quit'), 1, 'a new session replaces the old one');
  assert.equal(r.api.op('end').length, 0, 'the server already ended the old one');
  assert.equal(r.helper.count('start'), 1);
  r.view.stop();
}
// ---- T-D2-8 remoteschema.mjs is the web's src/lib/agent/remote-schema.ts (feat/rv-remote-view-web, unit W1),
// byte for byte (including `idle`, `here`, and partial/unknown input outcomes). The hash was taken from the WEB file with shasum -a 256
// (never from this copy). When the web repo sits next to this one (RV_WEB_SCHEMA), the copy is compared with it too.
{
  const WEB_SHA256 = 'fa68e065ba5e611771d7a7f18031ae028c28522b78868df05c2d8d93a28b9f78';
  if (process.env.RV_WEB_SCHEMA && fs.existsSync(process.env.RV_WEB_SCHEMA)) {
    assert.ok(fs.readFileSync(process.env.RV_WEB_SCHEMA).equals(fs.readFileSync(new URL('../remoteschema.mjs', import.meta.url))), 'remoteschema.mjs differs from the web head\'s remote-schema.ts');
  }
  const mine = fs.readFileSync(new URL('../remoteschema.mjs', import.meta.url));
  assert.equal(crypto.createHash('sha256').update(mine).digest('hex'), WEB_SHA256, 'remoteschema.mjs differs from the web\'s remote-schema.ts: copy it again and update the hash');
}
console.log('remoteview ok');
