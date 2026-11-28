// The phone's live view of this Mac (RV plan D2, section 5 and 7): the /api/agent/remote/mac poll (only while Phone
// View is on and Screen Recording and Accessibility are granted), one WebRTC peer per session, the pull chain (the
// phone's ack asks the helper for the next frame: 2 in flight at most), quality steps, shields, the input rules
// (remotepolicy.mjs), money asks, agent captions, take over and hand back (viewgate.mjs), auto ends and beats.
// The helper (src-tauri/remote, roamies-remote) holds the pixels and the hands; frames never touch Hydra's servers.
// Never logged or posted: typed text, pixels. The peer, the helper, the clock and Hydra's API are parameters.
import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { phoneMessageSchema, macSessionSchema, ASK_MS, BEAT_S, ICE_WAIT_MS, SWEEP_S } from './remoteschema.mjs';
import { checkInput, movesCursor, shieldsFor, cardTail, editTail, focusHidden, keyChar, payCtx } from './remotepolicy.mjs';

const POLL = '/api/agent/remote/mac';
const STEPS = [[0.6, 1], [0.4, 0.75], [0.3, 0.5]]; // [quality, scale]
const WINDOW = 2, SEND_MAX = 256 * 1024, MAX_LONG = 1920;
const BEAT_MS = BEAT_S * 1_000, LEASE_MS = SWEEP_S * 1_000, LINGER_MS = 500, HIDDEN_MS = 60_000, LOST_MS = 15_000;
// A frame the phone never acknowledged (it dropped it: its hello or geom came after the frame on another stream).
const FRAME_LOST_MS = 2_000;
const QUIT_MS = 2_000, CONNECT_MS = 30_000, IDLE_MS = 330_000, GRACE_MS = 30_000, BEAT_RETRY_MS = 2_000, BUSY_IDLE_MS = 30 * 60_000, LIMIT_MS = 2 * 3600_000, PERMS_MS = 60_000, HIT_MS = 1_000, INPUT_MS = 1_500;
const PILL = 'Being viewed from your phone', CONTROL = 'Your phone is in control';
const INPUT = new Set(['click', 'down', 'move', 'up', 'scroll', 'key', 'text']);
const POINT_TARGET = new Set(['click', 'down', 'up', 'scroll']);

/** stdout of the helper: [u32 big-endian length][u8 type][payload], split anywhere. cb(type, payload Buffer). */
export function frameReader(cb) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : Buffer.from(chunk);
    while (buf.length >= 5) {
      const n = buf.readUInt32BE(0);
      if (buf.length < 5 + n) break;
      const type = buf[4], payload = buf.subarray(5, 5 + n);
      buf = buf.subarray(5 + n);
      cb(type, payload);
    }
  };
}

/** The real helper process (ROAMIES_REMOTE). */
export function spawnRemoteHelper(bin = process.env.ROAMIES_REMOTE) {
  const p = spawn(bin, [], { stdio: ['pipe', 'pipe', 'ignore'] });
  let ev = () => {}, scr = () => {}, exit = () => {};
  p.stdout.on('data', frameReader((type, payload) => {
    if (type === 2) return scr(Buffer.from(payload));
    try { ev(JSON.parse(payload.toString('utf8'))); } catch { /* a broken line */ }
  }));
  p.on('exit', (code) => exit(code));
  p.on('error', () => exit(-1));
  p.stdin.on('error', () => {});
  return {
    send: (o) => { if (p.exitCode === null) p.stdin.write(`${JSON.stringify(o)}\n`); },
    onEvent: (f) => { ev = f; }, onScr: (f) => { scr = f; }, onExit: (f) => { exit = f; },
    kill: () => p.kill(),
  };
}

/** Screen Recording and Accessibility, as the helper sees them. */
export const probeRemote = (bin = process.env.ROAMIES_REMOTE) => new Promise((resolve) => {
  if (!bin) return resolve({ screen: false, ax: false });
  execFile(bin, ['--probe'], { timeout: 5_000 }, (err, out) => {
    try { const j = JSON.parse(String(out).trim()); resolve({ screen: j.screen === true, ax: j.ax === true }); } catch { resolve({ screen: false, ax: false }); }
  });
});

const PEER_LIB = 'werift'; // pinned in package.json; a variable keeps it out of the bundle (bundle.sh copies it)
/** Whether the peer library loads here. Without werift (a build that did not ship it) Phone View stays off and out
 *  of the menu, so a session never starts the pill and the capture only to end in 'error'. */
export const peerAvailable = () => import(PEER_LIB).then(() => true, () => false);

async function abortable(work, signal) {
  if (!signal) return work;
  let abort;
  const cancelled = new Promise((_, reject) => {
    abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([work, cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}

/** The Mac's peer, with werift (pure TypeScript WebRTC). The phone makes both channels: `ctl` (JSON) and `scr`
 *  (binary). No trickle: the answer goes once ICE gathering is done or after 2 s.
 *  GUESS (plan D0, not proved): werift and iPhone Safari data channels work together; the fallback is node-datachannel. */
export async function weriftPeer({ offer, iceServers, signal }, clock = { setTimeout, clearTimeout }) {
  const { RTCPeerConnection, SessionDescription, candidateFromSdp, candidateToSdp } = await abortable(import(PEER_LIB), signal);
  const ice = [];
  for (const s of iceServers ?? []) for (const urls of [].concat(s.urls)) ice.push({ urls, ...(s.username ? { username: s.username, credential: s.credential } : {}) });
  const pc = new RTCPeerConnection({ iceServers: ice });
  let msg = () => {}, state = () => {}, ctl = null, scr = null, open = false, closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try { Promise.resolve(pc.close()).catch(() => {}); } catch { /* gone */ }
  };
  const check = () => {
    const both = ctl?.readyState === 'open' && scr?.readyState === 'open';
    if (both && !open) { open = true; state('open'); } else if (open && !both) { open = false; state('closed'); }
  };
  pc.onDataChannel.subscribe((ch) => {
    if (ch.label === 'ctl') { ctl = ch; ch.onMessage.subscribe((d) => msg(typeof d === 'string' ? d : Buffer.from(d).toString('utf8'))); }
    else if (ch.label === 'scr') scr = ch;
    else return;
    ch.stateChanged.subscribe(check);
    check();
  });
  pc.connectionStateChange.subscribe((s) => { if (s === 'failed' || s === 'closed' || s === 'disconnected') { open = false; state('closed'); } });
  let answer, timer, unsubscribe, gathering;
  try {
    await abortable(pc.setRemoteDescription({ type: 'offer', sdp: offer }), signal);
    const local = await abortable(pc.createAnswer(), signal);
    const candidates = [];
    unsubscribe = pc.onIceCandidate.subscribe((candidate) => { if (candidate) candidates.push(candidate); }).unSubscribe;
    const deadline = new Promise((resolve) => { timer = clock.setTimeout(() => resolve(false), ICE_WAIT_MS); });
    // Werift applies the local description before waiting for its STUN/TURN lookups. Its SDP may not yet contain
    // the candidates already emitted for that description until the lookup finishes.
    gathering = pc.setLocalDescription(local);
    const complete = await abortable(Promise.race([gathering.then(() => true), deadline]), signal);
    answer = pc.localDescription?.sdp;
    if (!answer) throw new Error('Local WebRTC answer was not applied');
    if (!complete) {
      const partial = SessionDescription.parse(answer);
      for (const event of candidates) {
        const media = event.sdpMid == null ? partial.media[event.sdpMLineIndex] : partial.media.find((m) => m.rtp.muxId === event.sdpMid);
        const candidate = candidateFromSdp(event.candidate.replace(/^candidate:/, ''));
        if (media && candidate && !media.iceCandidates.some((c) => candidateToSdp(c) === candidateToSdp(candidate))) media.iceCandidates.push(candidate);
      }
      answer = partial.toSdp().sdp;
      gathering.catch(close);
    }
    signal?.throwIfAborted();
  } catch (error) {
    close();
    throw error;
  } finally {
    clock.clearTimeout(timer);
    unsubscribe?.();
  }
  return {
    answer,
    send: (s) => { if (ctl?.readyState === 'open') ctl.send(s); },
    sendScr: (b) => { if (scr?.readyState === 'open') scr.send(b); },
    bufferedAmount: () => scr?.bufferedAmount ?? 0,
    onMessage: (f) => { msg = f; }, onState: (f) => { state = f; if (closed) f('closed'); else if (open) f('open'); },
    close,
  };
}

export function createRemoteView({
  api, gate, home, macName = 'Mac', enabled, pairing = () => undefined, probe = () => probeRemote(), spawnHelper = () => spawnRemoteHelper(),
  makePeer = weriftPeer, peerOk = peerAvailable, onStop = () => {}, agentBusy = () => false, log = () => {},
  clock = { now: Date.now, monotonic: () => performance.now(), setTimeout, clearTimeout, setInterval, clearInterval },
}) {
  let running = false, polling = null, permsTimer = null, granted = false, s = null, peerLib = null, pending = null;
  // Sessions begun here (by id): the server lists a request until its answer lands, and a failed one is not retried
  // on every poll. ponytail: the last 50 ids.
  const tried = [];

  // ---------- the poll ----------
  async function pollLoop(ctl) {
    const pairBinding = pairing();
    while (!ctl.signal.aborted) {
      let wait = 0;
      try {
        const r = await api.req(`${POLL}?wait=25`, { signal: ctl.signal, timeout: 40_000, pairBinding });
        if (r.status === 200) {
          const p = macSessionSchema.safeParse(await r.json());
          const id = p.success ? p.data.session.id : null;
          // The current or pending session handed out again, or one already tried: never a second helper and peer.
          if (id && (id === s?.id || id === pending || tried.includes(id))) wait = 1_000;
          else if (id && !ctl.signal.aborted) {
            tried.push(id); if (tried.length > 50) tried.shift();
            // Polled again only once this one is answered (or failed): never a second helper and peer for it.
            pending = id;
            await begin(p.data.session, pairBinding).catch((e) => log('remote_view', { event: 'error', why: String(e?.message ?? e).slice(0, 160) }));
            pending = null;
          }
        } else if (r.status !== 204) wait = r.status === 401 || r.status === 403 ? 60_000 : 5_000;
      } catch (e) {
        if (ctl.signal.aborted) return;
        wait = e?.code === 'unpaired' ? 60_000 : 5_000;
      }
      if (wait) {
        let timer;
        try { await abortable(new Promise((r) => { timer = clock.setTimeout(r, wait); }), ctl.signal); }
        catch { return; }
        finally { clock.clearTimeout(timer); }
      }
    }
  }
  function setPolling(on) {
    if (on && !polling) { polling = new AbortController(); pollLoop(polling); }
    if (!on && polling) { polling.abort(); polling = null; }
  }
  async function check() {
    if (!running) return;
    // werift first, Phone View on or off: the menu shows "Phone View" (the only way to switch it on) once it loads.
    if (peerLib == null) { peerLib = await peerOk().catch(() => false); log('remote_view', { event: 'peer', ok: peerLib }); }
    if (!enabled() || !peerLib) { granted = false; setPolling(false); return; }
    const p = await probe().catch(() => ({}));
    granted = p?.screen === true && p?.ax === true;
    if (running && enabled()) setPolling(granted);
  }

  // ---------- a session ----------
  async function begin(sess, pairBinding) {
    // The old viewer is told why, so it shows "Opened elsewhere" and does not reconnect (and replace this one).
    if (s) { ctl(s, { t: 'bye', reason: 'replaced' }); close(s, { post: false, reason: 'replaced' }); }
    const helper = spawnHelper();
    const me = s = {
      id: sess.id, pairBinding, helper, peer: null, cancel: new AbortController(), live: false, answered: false, ended: false, open: false, phoneHello: false, ready: false,
      display: null, displays: [], frame: { w: 0, h: 0 }, gen: 0, displayRevision: 0, switchingDisplay: null, locked: false,
      step: 0, asked: 0, inflight: new Map(), lost: new Map(), ewma: null, lowSince: null, paused: false, resuming: null, holdTimer: null,
      winGen: 0, winList: [], ids: [], shieldsCur: [], exclude: [], frontSecret: false, secretSeen: false, focusSent: null, dragFrom: null, dragged: false, linger: [], lingerTimer: null, shieldsDisplay: [], focus: {}, tail: '', moved: false, tails: new Map(),
      sent: new Map(), busySent: null, beatOk: false, beating: false, warned: false,
      asks: new Map(), hits: new Map(), hitSeq: 0, queue: Promise.resolve(), lastPoint: null, control: false, taking: false,
      start: clock.now(), touch: clock.now(), timers: [],
      stats: { clicks: 0, chars: 0, keys: 0, scrolls: 0, refused: 0, asks: 0, frames: 0, bytes: 0 },
    };
    helper.onEvent((e) => { if (s === me && leaseActive(me)) onHelper(me, e); });
    helper.onScr((b) => { if (s === me) onScr(me, b); });
    helper.onExit(() => {
      me.exited = true;
      clock.clearTimeout(me.quitTimer);
      if (s === me && leaseActive(me)) end(me, 'error', { by: 'helper' });
    });
    // Not live in 30 s (the phone left during ICE, a hello that never parsed): the pill, capture and wake hold go.
    later(me, () => { if (!me.live) end(me, 'timeout', { by: 'connect' }); }, CONNECT_MS);
    // The pill shows first: before the peer, before any pixel.
    renewLease(me);
    helper.send({ cmd: 'start', maxLong: MAX_LONG, until: me.leaseUntil, leaseMs: LEASE_MS, approvalMs: ASK_MS });
    let peer, setupTimer;
    try {
      // Bounded: the poll waits for this, and a peer that never answers must not hold it.
      const made = Promise.resolve(makePeer({ offer: sess.sdp, iceServers: sess.iceServers, signal: me.cancel.signal }));
      made.then((p) => { if (me.ended && me.peer !== p) p?.close?.(); }, () => {});
      const deadline = new Promise((_, reject) => { setupTimer = clock.setTimeout(() => reject(new Error('no answer in 15 s')), 15_000); });
      peer = await abortable(Promise.race([made, deadline]), me.cancel.signal);
    } catch (e) {
      if (me.ended) return;
      log('remote_view', { event: 'error', why: `peer: ${String(e?.message ?? e).slice(0, 120)}` });
      return end(me, 'error');
    } finally {
      clock.clearTimeout(setupTimer);
    }
    if (me.ended) return peer.close();
    me.peer = peer;
    peer.onMessage((t) => { if (s === me) onPhone(me, t); });
    peer.onState((st) => { if (s === me) onPeerState(me, st); });
    const r = await abortable(post(me, { op: 'answer', sessionId: me.id, sdp: peer.answer }, me.cancel.signal), me.cancel.signal).catch(() => null);
    if (!leaseActive(me)) return;
    if (!r?.ok) { log('remote_view', { event: 'end', reason: 'stale', status: r?.status ?? 0 }); return close(me, { post: false, reason: 'stale' }); }
    me.answered = true;
    log('remote_view', { event: 'start' });
    tryLive(me);
  }

  const post = (me, body, signal) => api.req(POLL, { method: 'POST', body, timeout: 15_000, signal, pairBinding: me.pairBinding });
  const ctl = (me, m) => { try { me.peer?.send(JSON.stringify(m)); } catch { /* gone */ } };
  const later = (me, fn, ms) => { const t = clock.setTimeout(fn, ms); me.timers.push(t); return t; };
  const disp = (me) => me.displays.find((d) => d.id === me.display) ?? { id: me.display ?? 0, x: 0, y: 0, w: me.frame.w || 1, h: me.frame.h || 1 };
  const hasDisplay = (me, id) => {
    const matches = me.displays.filter((d) => d?.id === id);
    if (matches.length !== 1) return false;
    const { x, y, w, h } = matches[0];
    return [x, y, w, h].every(Number.isFinite) && w > 0 && h > 0;
  };
  const displayReady = (me) => me.ready && !me.paused && me.resuming === null && me.switchingDisplay === null && hasDisplay(me, me.display);
  const validGeometry = (me, e, gen) => e.gen === gen && hasDisplay(me, e.display) &&
    [e.w, e.h].every((side) => Number.isInteger(side) && side > 0 && side <= 65535);
  const k = (me) => (me.frame.w || 1) / (disp(me).w || 1);
  const px = (v) => Math.max(0, Math.min(65535, Math.round(v)));
  /** A rect in display points to frame pixels. */
  const toFrame = (me, r) => r.map((v) => px(v * k(me)));
  /** A rect in global points: clipped to display d, relative to it. */
  const clipTo = (b, d) => {
    const x0 = Math.max(b[0], d.x), y0 = Math.max(b[1], d.y), x1 = Math.min(b[0] + b[2], d.x + d.w), y1 = Math.min(b[1] + b[3], d.y + d.h);
    return x1 > x0 && y1 > y0 ? [x0 - d.x, y0 - d.y, x1 - x0, y1 - y0] : null;
  };
  const statsNow = (me) => {
    const secs = Math.max(1, (clock.now() - me.start) / 1000);
    return { ...me.stats, fps: Math.min(240, Math.round((me.stats.frames / secs) * 10) / 10), ...(me.ewma != null ? { rttMs: Math.min(60_000, Math.round(me.ewma)) } : {}), ...(me.peer?.path ? { path: me.peer.path } : {}) };
  };

  function tryLive(me) {
    if (me.live || !leaseActive(me) || !me.answered || !me.open || !me.phoneHello || !me.ready || !me.peer) return;
    me.live = true;
    log('remote_view', { event: 'live' });
    const d = disp(me);
    const displays = (me.displays.length ? me.displays : [d]).map((x) => ({ id: x.id, name: String(x.name ?? 'Display').slice(0, 120), w: px(x.w), h: px(x.h), main: !!x.main }));
    const agent = agentNow();
    me.busySent = agent.busy;
    ctl(me, { t: 'hello', v: 1, mac: { name: String(macName).slice(0, 120) }, displays, display: d.id, locked: me.locked, agent });
    ctl(me, { t: 'geom', gen: me.gen, display: d.id, w: px(me.frame.w), h: px(me.frame.h) });
    if (me.shieldsDisplay.length) ctl(me, { t: 'shield', rects: me.shieldsDisplay.slice(0, 64).map((r) => toFrame(me, r)) });
    gate.tap({ agent: (st) => { if (s === me) agentOut(me, st); } });
    const beat = clock.setInterval(() => { if (!me.ended) beatNow(me); }, BEAT_MS);
    const tick = clock.setInterval(() => {
      if (!leaseActive(me)) return;
      const now = clock.now(), busy = agentNow().busy;
      // Frames unacknowledged for over 2 s (or 3 round trips on a slow link, 10 s at most) are lost: without this the
      // window stays full and no frame is asked again. A lost frame's ack that still comes counts for the round trip
      // (onAck), so a slow link stretches the wait instead of asking a whole key frame almost every frame.
      let lost = false;
      const lostMs = Math.min(10_000, Math.max(FRAME_LOST_MS, 3 * (me.ewma ?? 0)));
      for (const [id, at] of me.inflight) if (now - at > lostMs) { me.inflight.delete(id); me.lost.set(id, at); lost = true; }
      while (me.lost.size > 64) me.lost.delete(me.lost.keys().next().value);
      if (lost) pump(me, true);
      // The phone's busy follows what the input rule uses (a Mac tool's 3 s after, a turn with no Mac tool yet).
      if (busy !== me.busySent) agentMsg(me, { t: 'agent', busy, paused: gate.owner(), ...(me.control ? { control: true } : {}) });
      // A task the owner watched has just ended: the idle clock starts again from here, not from his last touch.
      if (me.wasBusy && !busy) me.touch = now;
      me.wasBusy = busy;
      // Never an idle end without "Still there?" first: the prompt 30 s before (5 min quiet, or 29.5 min while the
      // agent works), the end only once it went unanswered. A touch, "here" or a new agent turn takes it back.
      const quiet = now - me.touch, warnAt = (busy ? BUSY_IDLE_MS : IDLE_MS) - GRACE_MS;
      if (me.warned && quiet < warnAt) me.warned = false;
      if (now - me.start >= LIMIT_MS) end(me, 'limit');
      else if (me.warned) { if (now - me.warnedAt >= GRACE_MS) end(me, 'idle'); }
      else if (quiet >= warnAt) { me.warned = true; me.warnedAt = now; idleWarn(me, GRACE_MS); }
    }, 1_000);
    me.intervals = [beat, tick];
    beatNow(me);
    pump(me, true);
  }

  // Until one live beat lands (the server's answered -> live, which makes the Activity row), a failed one is tried
  // again in 2 s, not 20.
  const monotonic = () => clock.monotonic?.() ?? clock.now();
  const leaseRemaining = (me) => Math.min(me.leaseUntil - clock.now(), me.leaseMonoUntil - monotonic());
  function leaseActive(me) {
    if (me.ended) return false;
    if (leaseRemaining(me) > 0) return true;
    end(me, 'timeout', { by: 'heartbeat' });
    return false;
  }
  function renewLease(me) {
    me.leaseUntil = clock.now() + LEASE_MS;
    me.leaseMonoUntil = monotonic() + LEASE_MS;
    clock.clearTimeout(me.leaseTimer);
    const expire = () => {
      if (leaseActive(me)) me.leaseTimer = clock.setTimeout(expire, leaseRemaining(me));
    };
    me.leaseTimer = clock.setTimeout(expire, LEASE_MS);
  }
  async function beatNow(me) {
    if (!leaseActive(me) || me.beating) return;
    me.beating = true;
    try {
      const r = await post(me, { op: 'beat', sessionId: me.id, live: true, stats: statsNow(me) }, me.cancel.signal);
      if (!leaseActive(me)) return;
      // 401 or 403: revoked. 404, 409, 410: the row is gone or not this Mac's. 408 and 429 are only slow.
      if (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) return close(me, { reason: r.status === 401 || r.status === 403 ? 'revoked' : 'server' });
      if (r.status !== 200 || !r.ok) return;
      const j = await r.json();
      if (!leaseActive(me) || j?.ok !== true) return;
      if (j.status === 'ended') return close(me, { reason: 'server' });
      if (j.status !== 'live') return;
      me.beatOk = true;
      renewLease(me);
      me.helper.send({ cmd: 'lease', until: me.leaseUntil });
    } catch (e) {
      if (e?.code === 'unpaired' && !me.ended) close(me, { reason: 'revoked' });
    } finally {
      me.beating = false;
      if (!me.beatOk && !me.ended) later(me, () => { if (!me.beatOk) beatNow(me); }, BEAT_RETRY_MS);
    }
  }

  /** "Still there?" 30 s before the idle end (remote-schema.ts `idle`; the phone answers `here`). */
  const idleWarn = (me, ms) => ctl(me, { t: 'idle', ms: Math.max(0, Math.round(ms)) });
  /** An agent message: what the phone was last told, for the tick to correct. */
  const agentMsg = (me, o) => { me.busySent = !!o.busy; ctl(me, o); };

  // ---------- the pull chain ----------
  function pump(me, key = false) {
    if (!me.live || !leaseActive(me) || !displayReady(me)) return;
    clock.clearTimeout(me.holdTimer); me.holdTimer = null;
    while (me.asked + me.inflight.size < WINDOW) {
      if ((me.peer.bufferedAmount?.() ?? 0) > SEND_MAX) { me.holdTimer = later(me, () => pump(me), 50); return; }
      const [q, scale] = STEPS[me.step];
      me.asked += 1;
      me.helper.send({ cmd: 'next', q, scale, ...(key ? { key: true } : {}) });
      key = false;
    }
  }
  function onScr(me, b) {
    if (!me.live || !leaseActive(me) || !displayReady(me) || b.length < 16 || b[1] !== me.gen) return;
    me.peer.sendScr(b);
    me.stats.bytes += b.length;
    const flags = b.readUInt16BE(2);
    if ((flags & 3) === 3) { // last chunk of the last patch: a whole frame
      me.asked = Math.max(0, me.asked - 1);
      me.inflight.set(b.readUInt32BE(4), clock.now());
      me.stats.frames += 1;
    }
  }
  function onAck(me, f) {
    const sent = me.inflight.get(f) ?? me.lost.get(f);
    for (const id of [...me.inflight.keys()]) if (id <= f) me.inflight.delete(id);
    for (const id of [...me.lost.keys()]) if (id <= f) me.lost.delete(id);
    if (sent != null) {
      const now = clock.now(), rtt = now - sent;
      me.ewma = me.ewma == null ? rtt : me.ewma * 0.7 + rtt * 0.3;
      const down = me.ewma > 500 ? 2 : me.ewma > 250 ? 1 : 0;
      if (down > me.step) { me.step = down; me.lowSince = null; }
      else if (me.ewma < 120) {
        if (me.lowSince == null) me.lowSince = now;
        else if (now - me.lowSince >= 2_000 && me.step > 0) { me.step -= 1; me.lowSince = now; }
      } else me.lowSince = null;
    }
    pump(me);
  }

  // ---------- the helper's events ----------
  function onHelper(me, e) {
    switch (e?.ev) {
      case 'pill': log('remote_view', { event: 'pill' }); break;
      // The shields follow the display and frame as well as the windows: the helper sends its first window list
      // before the displays and ready, and shields clipped to a display not known yet would be empty (the vault shown).
      case 'displays': {
        me.displayRevision += 1;
        me.displays = Array.isArray(e.list) ? e.list : [];
        if (me.ready) shields(me, me.winList);
        break;
      }
      case 'ready':
        if (me.ready || !validGeometry(me, e, me.gen)) return end(me, 'error', { by: 'display' });
        me.display = e.display; me.frame = { w: e.w, h: e.h }; me.gen = e.gen ?? 0; me.ready = true;
        shields(me, me.winList); // before any `next`: the helper reads stdin in order
        tryLive(me); break;
      case 'geom':
        if (!me.ready || e.display !== (me.switchingDisplay ?? me.display) || !validGeometry(me, e, (me.gen + 1) & 255)) {
          return end(me, 'error', { by: 'display' });
        }
        me.displayRevision += 1; me.switchingDisplay = null;
        if (e.resume === me.resuming) me.resuming = null;
        me.display = e.display; me.frame = { w: e.w, h: e.h }; me.gen = e.gen;
        me.inflight.clear(); me.lost.clear(); me.asked = 0;
        me.dragFrom = null; me.lastPoint = null; me.dragged = false;
        if (me.live) ctl(me, { t: 'geom', gen: me.gen, display: e.display, w: px(e.w), h: px(e.h) });
        shields(me, me.winList);
        if (me.resuming !== null) break;
        const queued = me.queuedDisplay; me.queuedDisplay = null;
        if (queued != null) {
          if (!hasDisplay(me, queued)) return end(me, 'error', { by: 'display' });
          switchDisplay(me, queued);
        }
        if (me.live) pump(me, true);
        break;
      case 'windows':
        me.winGen = e.gen ?? me.winGen; me.winList = Array.isArray(e.list) ? e.list : [];
        if (me.ready) shields(me, me.winList); // before ready the helper holds every pixel (no shields for its gen)
        break;
      case 'focus': setFocus(me, e); break;
      case 'locked':
        me.locked = e.locked === true;
        if (me.locked) { me.displayRevision += 1; me.asks.clear(); }
        if (me.live) ctl(me, { t: 'locked', locked: me.locked });
        break;
      case 'hit': { const w = me.hits.get(e.id); if (w) { me.hits.delete(e.id); w(e); } break; }
      case 'done': {
        const was = me.sent.get(e.n); me.sent.delete(e.n);
        if (was && e.partial === true) inputReceipt(me, was, 'partial', e.postedChars);
        else if (was && e.dropped !== true) {
          if (was.m.t === 'text') me.stats.chars += [...was.m.s].length;
          if (was.m.t === 'key') me.stats.keys += 1;
        }
        // A paste: the helper tells its digits (never the clipboard's words), and the card rule counts them from now on.
        if (typeof e.pasted === 'string') { me.tail = cardTail(me.tail, e.pasted.slice(-400), true); me.moved = true; }
        was?.done(e.partial === true ? 'partial' : 'done'); break;
      }
      case 'refused': {
        // Refused 'changed' (the window list moved after the check): the queue waits for this answer, so the one
        // retry runs before any later input (a down retried after its up would hold the Mac's button down).
        const was = me.sent.get(e.n);
        me.sent.delete(e.n);
        if (e.why === 'changed' && was && !was.proof && !was.retried && !was.late) { was.done('retry'); break; }
        // A press the helper refused: its drag and its up are dropped, as for one the sidecar refused.
        if (was?.m.t === 'down' && !was.late) me.deadPress = true;
        was?.done('refused');
        if (!was?.reported) refused(me, e.n, e.why);
        break;
      }
      case 'end': end(me, e.by === 'heartbeat' ? 'timeout' : 'mac', { by: e.by ?? 'helper' }); break;
      case 'error':
        if (e.why === 'display') return end(me, 'error', { by: 'display' });
        log('remote_view', { event: 'error', why: String(e.why ?? '').slice(0, 160) }); break;
      default: break;
    }
  }
  function inputReceipt(me, was, why, postedChars) {
    const { m } = was;
    if (m.t !== 'text' && m.t !== 'key') return;
    const requestedChars = m.t === 'text' ? [...m.s].length : null;
    const posted = Number.isInteger(postedChars) && postedChars >= 0 && requestedChars !== null && postedChars <= requestedChars ? postedChars : null;
    log('remote_view', { event: `input_${why}`, input: m.t, requestedChars, postedChars: posted });
    // Send one passive outcome to the phone that submitted the input, without treating it as a complete refusal.
    if (!was.reported && me.live && !me.ended && leaseActive(me)) {
      was.reported = true;
      ctl(me, { t: 'refused', n: m.n, why });
    }
  }

  /** The focused field, from the helper's 200 ms poll or a live read. Each field (role and label) keeps its own card
   *  tail: moving away and back to a field does not start it again. ponytail: the last 20 fields. */
  function setFocus(me, e) {
    const key = (f) => `${f.role}\u0000${f.label}`;
    const same = me.focus.role != null && key(me.focus) === key({ role: e.role ?? '', label: e.label ?? '' });
    if (me.focus.role != null) { me.tails.delete(key(me.focus)); me.tails.set(key(me.focus), { tail: me.tail, moved: me.moved }); if (me.tails.size > 20) me.tails.delete(me.tails.keys().next().value); }
    me.focus = { role: e.role ?? '', label: e.label ?? '', secure: e.secure === true, secureInput: e.secureInput === true, defaultButton: e.defaultButton ?? '', rect: Array.isArray(e.rect) ? e.rect : null,
      // Whose element has key focus (a password manager's panel can hold it while another app is front).
      pid: Number.isInteger(e.pid) ? e.pid : null, app: String(e.app ?? '').slice(0, 80),
      // A terminal's last line (the helper reads it for a terminal's text area): A3's passwordPrompt judges it.
      ...(typeof e.lastLine === 'string' ? { lastLine: e.lastLine.slice(0, 160) } : {}),
      ...(Array.isArray(e.buttons) ? { buttons: e.buttons.slice(0, 60).map((b) => String(b).slice(0, 120)) } : {}) };
    // Back in a field typed in before: where its cursor is now is not known (a click or Tab put it there).
    const t = me.tails.get(key(me.focus));
    me.tail = t?.tail ?? ''; me.moved = !!t && (t.moved || (!same && t.tail !== ''));
    // A credential field's state (secure or shown in plain text, where it is) moves the shields: they follow it.
    const credKey = JSON.stringify([me.focus.secure, me.focus.secureInput, me.focus.rect, me.focus.label, me.focus.role]);
    if (me.ready && credKey !== me.credKey) { me.credKey = credKey; shields(me, me.winList); }
    const r = me.focus.rect && clipTo(me.focus.rect, disp(me));
    const o = { t: 'focus', rect: r ? toFrame(me, r) : null, secure: me.focus.secure || me.focus.secureInput };
    // A live read before each key finds the same field again: the phone hears only a change.
    if (me.live && JSON.stringify(o) !== me.focusSent) { me.focusSent = JSON.stringify(o); ctl(me, o); }
  }

  /** The hidden windows: to the helper (display points, plus the capture exclusions) and the phone (frame pixels).
   *  A shield stays LINGER_MS after its window is gone or moved. */
  function shields(me, list) {
    const d = disp(me), now = clock.now();
    const sh = shieldsFor(list, { home, display: d, secretSeen: me.secretSeen, focus: me.focus });
    if (sh.secret) me.secretSeen = true;
    const key = (r) => r.join(',');
    const fresh = new Set(sh.rects.map(key));
    for (const r of me.shieldsCur ?? []) if (!fresh.has(key(r))) me.linger.push({ r, until: now + LINGER_MS });
    me.linger = me.linger.filter((l) => l.until > now && !fresh.has(key(l.r)));
    me.shieldsCur = sh.rects; me.exclude = sh.exclude; me.ids = sh.ids; me.frontSecret = sh.frontSecret;
    sendShields(me);
    if (me.linger.length) {
      clock.clearTimeout(me.lingerTimer);
      me.lingerTimer = later(me, () => { if (me.ended) return; const t = clock.now(); me.linger = me.linger.filter((l) => l.until > t); sendShields(me); }, Math.min(...me.linger.map((l) => l.until)) - now);
    }
  }
  function sendShields(me) {
    const rects = [...me.shieldsCur, ...me.linger.map((l) => l.r)];
    me.shieldsDisplay = rects;
    me.helper.send({ cmd: 'shields', gen: me.winGen, rects, exclude: me.exclude ?? [] });
    if (me.live) ctl(me, { t: 'shield', rects: rects.slice(0, 64).map((r) => toFrame(me, r)) });
  }

  // ---------- the phone ----------
  function switchDisplay(me, id) {
    if (me.switchingDisplay !== null || me.resuming !== null) { me.queuedDisplay = id; return; }
    if (id === me.display) return;
    me.displayRevision += 1; me.switchingDisplay = id;
    me.helper.send({ cmd: 'display', id });
  }
  function onPhone(me, text) {
    if (!leaseActive(me) || typeof text !== 'string' || text.length > 16384) return;
    let raw;
    try { raw = JSON.parse(text); } catch { return; }
    const p = phoneMessageSchema.safeParse(raw);
    if (!p.success) return;
    const m = p.data;
    switch (m.t) {
      case 'hello': me.phoneHello = true; tryLive(me); break;
      case 'ack': onAck(me, m.f); break;
      case 'pause':
        if (me.paused) break;
        me.paused = true; me.resuming = null; me.displayRevision += 1; me.asks.clear(); me.helper.send({ cmd: 'pause' });
        me.dragFrom = null; me.lastPoint = null; me.dragged = false;
        me.hiddenTimer = later(me, () => end(me, 'hidden'), HIDDEN_MS);
        break;
      case 'resume':
        if (!me.paused) break;
        me.paused = false; me.resuming = ++me.displayRevision; clock.clearTimeout(me.hiddenTimer);
        me.inflight.clear(); me.asked = 0;
        me.helper.send({ cmd: 'resume', id: me.resuming });
        break;
      case 'display':
        if (hasDisplay(me, m.id)) switchDisplay(me, m.id);
        break;
      case 'answer': me.queue = me.queue.then(() => answer(me, m)).catch(() => {}); break;
      case 'takeover':
        if (gate.owner()) break;
        me.helper.send({ cmd: 'state', text: CONTROL });
        // Asked: until it resolves the phone says "Taking over" (a Stop on the Mac before then must end that too).
        me.taking = true;
        gate.takeover().then(() => {
          me.taking = false;
          if (!gate.owner() || s !== me || !leaseActive(me)) return;
          // Take over is done (the running helper call ended): the phone stops saying "Taking over".
          me.control = true;
          agentMsg(me, { t: 'agent', busy: agentNow().busy, paused: true, control: true });
        });
        log('remote_view', { event: 'takeover' });
        break;
      case 'handback':
        me.control = false; me.taking = false; gate.handback();
        me.helper.send({ cmd: 'state', text: PILL });
        log('remote_view', { event: 'handback' });
        break;
      case 'stop':
        me.control = false; me.taking = false; onStop();
        me.helper.send({ cmd: 'state', text: PILL });
        log('remote_view', { event: 'stop' });
        break;
      case 'ping': ctl(me, { t: 'pong', id: m.id, at: clock.now() }); break;
      // "I'm here" to "Still there?": a touch for the idle clock, nothing on the screen.
      case 'here': me.touch = clock.now(); me.warned = false; break;
      case 'bye': end(me, 'phone'); break;
      default:
        if (INPUT.has(m.t)) {
          me.touch = clock.now();
          if (!me.live) break;
          if (!displayReady(me)) return refused(me, m.n, 'changed');
          const displayRevision = me.displayRevision;
          me.queue = me.queue.then(() => input(me, m, displayRevision)).catch(() => {});
        }
    }
  }
  function onPeerState(me, st) {
    if (!leaseActive(me)) return;
    if (st === 'open') { me.open = true; clock.clearTimeout(me.lostTimer); tryLive(me); }
    else if (st === 'closed') { me.open = false; clock.clearTimeout(me.lostTimer); me.lostTimer = later(me, () => end(me, 'error', { by: 'channel' }), LOST_MS); }
  }

  // Busy: a turn runs (model thinking included: gate.busy), or a Mac tool ran in the last 3 s.
  const agentNow = () => ({ busy: !!(agentBusy() || gate.busy?.() || gate.active()), paused: gate.owner() });
  function agentOut(me, st) {
    if (!me.live || !leaseActive(me)) return;
    // Busy as the input rule sees it: never "not busy" to the phone while its input is refused 'agent'.
    const o = { t: 'agent', busy: !!st.busy || agentNow().busy, paused: st.paused ?? gate.owner() };
    // The gate opened while the phone held control or was still taking it (Stop in the Mac's menu, Esc, a hand back
    // from anywhere): the phone and the pill stop saying "in control" or "Taking over".
    if ((me.control || me.taking) && !gate.owner()) { me.control = false; me.taking = false; o.control = false; me.helper.send({ cmd: 'state', text: PILL }); }
    if (st.caption) o.caption = String(st.caption).slice(0, 200);
    const b = st.step?.bounds;
    if (Array.isArray(b)) {
      const d = disp(me), r = clipTo(b, d);
      if (r) o.step = { rect: toFrame(me, r), kind: String(st.step.kind ?? '').slice(0, 32), display: d.id };
      else {
        // On another display: the phone says where Hydra is (S17). Its rect is in that display's points.
        const other = me.displays.find((x) => x.id !== d.id && clipTo(b, x));
        if (other) o.step = { rect: clipTo(b, other).map(px), kind: String(st.step.kind ?? '').slice(0, 32), display: other.id };
      }
    }
    agentMsg(me, o);
  }

  /** cmd 'hit' (what is under the point) or 'focus' (the focused field and its window's buttons, read now). */
  const ask = (me, cmd, extra = {}) => new Promise((resolve) => {
    const id = ++me.hitSeq;
    const t = later(me, () => { if (me.hits.delete(id)) resolve(null); }, HIT_MS);
    me.hits.set(id, (e) => { clock.clearTimeout(t); resolve(e); });
    me.helper.send({ cmd, id, ...extra });
  });
  const hitTest = (me, m, verify) => ask(me, 'hit', { x: m.x, y: m.y, ...(verify == null ? {} : { verify }) });
  /** Return, Space or a newline submits or presses what has focus now, not what the 200 ms poll last saw (a Tab just
   *  before moves it): the focus is read live first. false: no answer. */
  const submits = (m) => (m.t === 'key' && ['return', 'enter', 'space'].includes(String(m.k).toLowerCase().split('+').at(-1))) || (m.t === 'text' && /[\r\n]/.test(m.s));
  /** buttons: the window's button labels too (a 600-element walk: only for Return, Space and a newline). */
  /** A read with no role (an AX call that failed or timed out, an app with no AX) is no answer either: the key could
   *  go into a credential or pay field the rules cannot see. */
  const focusNow = async (me, buttons, verify) => {
    const e = await ask(me, 'focus', { buttons, ...(verify == null ? {} : { verify }) });
    if (!e || me.ended) return null;
    setFocus(me, e);
    return me.focus.role ? e : null;
  };
  /** The money context (payCtx) of the window under a point (hit's app, topmost first) or, for a key, the front one. */
  const payFor = (me, hit, m) => {
    const list = (me.winList ?? []).filter((w) => w && !w.overlay);
    if (!hit) return payCtx(list.find((w) => w.front) ?? null);
    const d = disp(me), gx = d.x + (m?.x ?? 0) * d.w, gy = d.y + (m?.y ?? 0) * d.h;
    const w = list.find((x) => x.app === hit.app && Array.isArray(x.bounds) && gx >= x.bounds[0] && gy >= x.bounds[1] && gx < x.bounds[0] + x.bounds[2] && gy < x.bounds[1] + x.bounds[3]);
    return payCtx(w ?? { app: hit.app });
  };
  const ctxFor = (me, hit, m) => ({
    display: disp(me), shields: me.shieldsDisplay, locked: me.locked, agent: { busy: agentNow().busy, owner: gate.owner() && me.control },
    hit, focus: me.focus, frontSecret: me.frontSecret || focusHidden(me.focus, me.winList, me.ids), tail: me.tail, moved: me.moved, pay: payFor(me, hit, m), dragged: m?.t === 'up' && me.dragged,
  });
  function refused(me, n, why) {
    me.stats.refused += 1;
    ctl(me, { t: 'refused', n: Number.isInteger(n) && n >= 0 ? n : 0, why });
    log('remote_view', { event: 'refused', why });
  }
  async function input(me, m, displayRevision, retried = false) {
    if (!me.live || !leaseActive(me)) return;
    const unchangedDisplay = () => displayReady(me) && me.displayRevision === displayRevision;
    if (!unchangedDisplay()) return refused(me, m.n, 'changed');
    // The rest of a press that was refused or is waiting for a yes: never a drag or a button up on its own.
    if (me.deadPress && (m.t === 'move' || m.t === 'up')) { if (m.t === 'up') me.deadPress = false; return; }
    if (m.t === 'down') me.deadPress = true;
    // A key or text goes where focus is now, not where the 200 ms poll last saw it (a Tab or a click just before
    // moves it): read live first, the window's buttons too when it submits.
    let target;
    if (m.t === 'key' || m.t === 'text') {
      target = await focusNow(me, submits(m));
      if (!leaseActive(me)) return;
      if (!target) return refused(me, m.n, 'changed');
    }
    // The up of a drag: what it would drop onto.
    const under = m.t === 'up' && me.dragged ? await hitTest(me, m) : null;
    if (!leaseActive(me)) return;
    let v = checkInput(m, ctxFor(me, under, m));
    if (v.do === 'refuse') return refused(me, m.n, v.why);
    if (POINT_TARGET.has(m.t) && m.t !== 'up') {
      const hit = await hitTest(me, m);
      if (!leaseActive(me)) return;
      if (!hit) return refused(me, m.n, 'changed');
      target = hit;
      v = checkInput(m, ctxFor(me, hit, m));
      if (v.do === 'refuse') return refused(me, m.n, v.why);
    }
    if (v.do === 'ask') {
      if (target?.proved !== true || !unchangedDisplay()) return refused(me, m.n, 'changed');
      const id = randomUUID().slice(0, 12);
      for (const [key, entry] of me.asks) if (clock.now() - entry.at >= ASK_MS) me.asks.delete(key);
      if (me.asks.size >= 64) me.asks.delete(me.asks.keys().next().value);
      me.asks.set(id, { m, label: v.label, app: v.app, at: clock.now(), proof: target.id, displayRevision });
      me.stats.asks += 1;
      ctl(me, { t: 'ask', id, label: v.label, app: v.app, why: 'money' });
      log('remote_view', { event: 'ask' });
      return;
    }
    if (m.t === 'down') me.deadPress = false;
    const to = v.clamp === 'start' ? me.dragFrom : v.clamp ? me.lastPoint : null;
    const sent = to ? { ...m, ...to } : m;
    if (m.t === 'up') target = !to && under ? under : await hitTest(me, sent);
    const needsTarget = POINT_TARGET.has(m.t) || m.t === 'key' || m.t === 'text';
    const otherCommit = m.t === 'up' || m.t === 'scroll';
    const commitRefusal = otherCommit && target && checkInput({ ...sent, t: 'click', b: 'l' }, ctxFor(me, target, sent));
    if (!unchangedDisplay()) return refused(me, m.n, 'changed');
    if (needsTarget && (target?.proved !== true || (commitRefusal && commitRefusal.do !== 'allow'))) {
      if (m.t === 'down') me.deadPress = true;
      if (m.t === 'up') await act(me, sent, true); // without proof this only cancels an already-held drag
      else if (leaseActive(me)) refused(me, m.n, 'changed');
      return;
    }
    if (await act(me, sent, retried, target?.id) === 'retry' && !me.ended) return input(me, sent, displayRevision, true);
  }
  async function answer(me, m) {
    const a = me.asks.get(m.id);
    if (!a) return;
    me.asks.delete(m.id); // used once
    if (!m.yes || !leaseActive(me) || clock.now() - a.at >= ASK_MS) return;
    const unchangedDisplay = () => displayReady(me) && me.displayRevision === a.displayRevision;
    if (!unchangedDisplay()) return refused(me, a.m.n, 'changed');
    // Tested again at the yes: the point (a click or a press), or the focused control (a key or text).
    const point = a.m.t === 'click' || a.m.t === 'down';
    const target = point ? await hitTest(me, a.m, a.proof) : await focusNow(me, submits(a.m), a.proof);
    if (!leaseActive(me)) return;
    if (!unchangedDisplay() || target?.proved !== true || clock.now() - a.at >= ASK_MS) return refused(me, a.m.n, 'changed');
    const v = checkInput(a.m, ctxFor(me, point ? target : null, a.m));
    if (v.do === 'ask' && v.label === a.label && v.app === a.app) {
      log('remote_view', { event: 'ask_yes' });
      // A press that asked is one click: its drag was dropped while it waited.
      // A yes is never replayed: refused 'changed' by the helper, the phone hears it and taps again.
      await act(me, a.m.t === 'down' ? { t: 'click', n: a.m.n, x: a.m.x, y: a.m.y, b: 'l', c: 1 } : a.m, false, a.proof, true);
      return;
    }
    refused(me, a.m.n, v.do === 'refuse' && v.why !== 'changed' ? v.why : 'changed');
  }
  /** retried: the second try of one the helper refused 'changed' (in the tail once already).
   *  Resolves with the helper's answer ('done', 'partial', 'refused', 'retry'), or 'late' after INPUT_MS: the input queue waits
   *  for it, so no later input reaches the helper before this one is done or retried. */
  function act(me, m, retried = false, proof, approved = false) {
    if (!leaseActive(me)) return;
    const st = me.stats;
    if (!retried) {
      // The tail is append-only while the cursor stays at the end: a click (in the field or on a Paste item), a press
      // or a cursor key leaves it anywhere (moved), and the card rule then counts the field's digits.
      if (m.t === 'click') st.clicks += 1; else if (m.t === 'scroll') st.scrolls += 1;
      else if (m.t === 'key') { const c = keyChar(m.k); me.tail = c ? cardTail(me.tail, c, me.moved) : editTail(me.tail, m.k, me.moved); if (movesCursor(m.k)) me.moved = true; }
      else if (m.t === 'text') me.tail = cardTail(me.tail, m.s, me.moved);
      if (m.t === 'click' || m.t === 'down') me.moved = true;
    }
    // Esc from the phone also reaches the Mac's global Esc (Stop): sidekick ignores that one (phoneEsc).
    if (m.t === 'key' && /^(escape|esc)$/.test(String(m.k).toLowerCase().split('+').at(-1))) me.escAt = clock.now();
    if (m.t === 'down') { me.dragFrom = { x: m.x, y: m.y }; me.dragged = false; }
    if (m.t === 'move' && me.dragFrom) me.dragged = true;
    if (m.t === 'down' || m.t === 'move') me.lastPoint = { x: m.x, y: m.y };
    if (m.t === 'up') { me.lastPoint = null; me.dragFrom = null; me.dragged = false; }
    if (me.sent.size > 64) me.sent.delete(me.sent.keys().next().value);
    return new Promise((resolve) => {
      const was = { m, retried, proof, late: false, done: (r) => { clock.clearTimeout(t); resolve(r); } };
      // No answer in time (a helper stuck in an AX call): the queue goes on; a late 'changed' is not retried then.
      const t = later(me, () => { was.late = true; inputReceipt(me, was, 'unknown'); resolve('late'); }, INPUT_MS);
      me.sent.set(m.n, was);
      // The tail rides along (this input in it): the helper checks a paste's clipboard with it when the field's value
      // cannot be read, and, once the cursor moved, counts its digits then (remote/card.swift).
      me.helper.send({ cmd: 'input', ...m, shieldsGen: me.winGen, ...(proof == null ? {} : { proof }), ...(approved ? { approved: true } : {}), ...(me.tail ? { tail: me.tail } : {}), ...(me.moved && (m.t === 'text' || m.t === 'key') ? { moved: true } : {}) });
    });
  }

  // ---------- the end ----------
  function end(me, reason, extra = {}) {
    if (!me || me.ended) return;
    ctl(me, { t: 'bye', reason });
    const stats = statsNow(me);
    // A live session whose live beat never landed has no Activity row yet: that beat goes first.
    close(me, { post: false, reason, extra });
    const first = me.live && !me.beatOk && extra.by !== 'heartbeat'
      ? Promise.resolve().then(() => post(me, { op: 'beat', sessionId: me.id, live: true, stats })).catch(() => null) : null;
    Promise.resolve(first).then(() => post(me, { op: 'end', sessionId: me.id, reason, stats })).catch(() => {});
  }
  function close(me, { reason, extra = {} } = {}) {
    if (me.ended) return;
    me.ended = true;
    me.cancel.abort();
    clock.clearTimeout(me.leaseTimer);
    for (const t of me.timers) clock.clearTimeout(t);
    for (const t of me.intervals ?? []) clock.clearInterval(t);
    for (const w of me.hits.values()) w(null);
    for (const w of me.sent.values()) { if (!w.late) inputReceipt(me, w, 'unknown'); w.done('ended'); }
    me.hits.clear(); me.asks.clear(); me.sent.clear();
    try { me.helper.send({ cmd: 'quit' }); } catch { /* gone */ }
    // A helper stuck in an AX call never reads its quit: it goes in 2 s anyway (its pill, capture and wake hold too).
    if (!me.exited) me.quitTimer = clock.setTimeout(() => { if (!me.exited) me.helper.kill?.(); }, QUIT_MS);
    try { me.peer?.close(); } catch { /* gone */ }
    if (s === me) {
      s = null;
      gate.tap(null);
      if (gate.owner()) gate.handback(); // the owner is gone: the agent may look again
    }
    const { clicks, chars, keys, scrolls, refused: r, asks, frames } = me.stats;
    log('remote_view', { event: 'end', reason, ...extra, secs: Math.round((clock.now() - me.start) / 1000), clicks, chars, keys, scrolls, refused: r, asks, frames });
  }

  return {
    start() {
      if (running) return;
      running = true;
      permsTimer = clock.setInterval(() => { check(); }, PERMS_MS);
      check();
    },
    stop() {
      running = false;
      clock.clearInterval(permsTimer); permsTimer = null;
      setPolling(false);
      if (s) end(s, 'mac');
    },
    /** Phone View or a permission changed: a session ends first when Phone View is off (race 19). */
    refresh() {
      if (!enabled() && s) end(s, 'mac');
      check();
    },
    /** "End Phone View" in the menu. */
    endNow() { if (s) end(s, 'mac'); },
    live: () => !!s?.live && leaseActive(s),
    /** The phone sent Esc in the last second: the global Esc hotkey that fired is the phone's key, not a Stop. */
    phoneEsc: () => !!s?.escAt && clock.now() - s.escAt < 1_000,
    /** The peer library loads here (false until it was checked or when werift is missing): the menu shows Phone View. */
    available: () => peerLib === true,
  };
}
