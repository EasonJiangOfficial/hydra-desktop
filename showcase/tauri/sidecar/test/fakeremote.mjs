// Fakes for the phone view's tests (remoteview.mjs, viewgate.mjs): a clock the test moves, the remote helper as it
// speaks (remote/main.swift), a WebRTC peer, and Hydra's /api/agent/remote/mac. Nothing here reads the screen, moves
// the mouse, types, or opens a network socket.

/** setTimeout/setInterval on a clock that only moves when the test calls advance(ms). */
export function fakeClock(start = 1_000_000) {
  let t = start, seq = 0;
  const timers = new Map();
  const add = (fn, ms, every) => { const id = ++seq; timers.set(id, { at: t + Math.max(0, ms), fn, every }); return id; };
  const clock = {
    now: () => t,
    setTimeout: (fn, ms = 0) => add(fn, ms, 0),
    clearTimeout: (id) => timers.delete(id),
    setInterval: (fn, ms) => add(fn, ms, Math.max(1, ms)),
    clearInterval: (id) => timers.delete(id),
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        await flush();
        const due = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, v] = due;
        t = Math.max(t, v.at);
        if (v.every) v.at += v.every; else timers.delete(id);
        v.fn();
      }
      t = end;
      await flush();
    },
    pending: () => timers.size,
  };
  return clock;
}
export const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

/** The scr header (section 5): big-endian. */
export function scrMsg({ gen = 0, flags = 3, frame = 1, x = 0, y = 0, w = 10, h = 10, bytes = 100 } = {}) {
  const b = Buffer.alloc(16 + bytes);
  b[0] = 1; b[1] = gen; b.writeUInt16BE(flags, 2); b.writeUInt32BE(frame, 4);
  b.writeUInt16BE(x, 8); b.writeUInt16BE(y, 10); b.writeUInt16BE(w, 12); b.writeUInt16BE(h, 14);
  return b;
}

/** The remote helper: records every command; answers `next` with one frame when auto is on, `hit` from hits, and
 *  `focus` (a live read) with the last focus event emitted plus `buttons`. windows: a first window list, sent as the
 *  real helper does (main.swift start(): pill, windows gen 1, then displays and ready). */
export function fakeHelper({ auto = true, displays = [{ id: 1, name: 'Built-in', x: 0, y: 0, w: 1000, h: 800, main: true }], windows } = {}) {
  let ev = () => {}, scr = () => {}, exit = () => {}, frame = 0, gen = 0, display = 1;
  const proofs = new Map();
  const identityOf = (target) => target.identity === null ? null : JSON.stringify(target.identity ?? [target.app, target.role, target.label, target.defaultButton]);
  const hit = () => h.hits.next ?? h.hits.all ?? { role: 'AXButton', label: 'Reply', app: 'Mail' };
  const read = (o, target) => {
    const identity = identityOf(target);
    const proved = identity != null && (o.verify == null || proofs.get(o.verify) === identity);
    if (o.verify == null && proved) proofs.set(o.id, identity);
    ev({ ...target, ev: 'hit', id: o.id, proved });
  };
  const h = {
    cmds: [], hits: {}, auto, answer: true, alive: true, killed: false, // A real read has a role (a failed one has none: refused 'changed', test/remoteround7.test.mjs).
    focus: { role: 'AXTextArea', label: '', secure: false, secureInput: false }, buttons: undefined,
    send(o) {
      h.cmds.push(o);
      if (o.cmd === 'start') queueMicrotask(() => { ev({ ev: 'pill', at: 1 }); if (windows) ev({ ev: 'windows', gen: 1, list: windows }); ev({ ev: 'displays', list: displays }); ev({ ev: 'ready', display: 1, w: 1000, h: 800, gen: 0 }); });
      if (o.cmd === 'focus') queueMicrotask(() => read(o, { ...h.focus, ...(h.buttons ? { buttons: h.buttons } : {}) }));
      if (o.cmd === 'next' && h.auto) queueMicrotask(() => h.frame());
      if (o.cmd === 'hit') queueMicrotask(() => read(o, hit()));
      // Every input is answered, as main.swift input() does: done (or refused, which a test emits itself).
      if (o.cmd === 'input' && h.answer) queueMicrotask(() => {
        if (o.proof != null) {
          const identity = proofs.get(o.proof);
          proofs.delete(o.proof);
          if (identity !== identityOf(o.t === 'key' || o.t === 'text' ? h.focus : hit())) return ev({ ev: 'refused', n: o.n, why: 'changed' });
        }
        ev({ ev: 'done', n: o.n });
      });
      if (o.cmd === 'display') display = o.id;
      if (o.cmd === 'resume' && h.resumeGeometry !== false) queueMicrotask(() => h.emit({ ev: 'geom', gen: (gen + 1) & 255, display, w: 1000, h: 800, resume: o.id }));
      if (o.cmd === 'quit') queueMicrotask(() => { h.alive = false; exit(0); });
    },
    onEvent: (f) => { ev = f; }, onScr: (f) => { scr = f; }, onExit: (f) => { exit = f; },
    kill() { h.killed = true; h.alive = false; },
    emit: (e) => { if (e?.ev === 'focus') { const { ev: _, ...f } = e; h.focus = f; } if (e?.ev === 'geom') gen = e.gen; ev(e); },
    frame(flags = 3, generation = gen) { frame += 1; scr(scrMsg({ frame, flags, gen: generation })); return frame; },
    count: (cmd) => h.cmds.filter((c) => c.cmd === cmd).length,
    last: (cmd) => h.cmds.filter((c) => c.cmd === cmd).at(-1),
  };
  return h;
}

/** A peer: the phone side is the test. sent: the ctl messages the Mac sent (parsed); scr: the binary ones. */
export function fakePeer() {
  let msg = () => {}, state = () => {};
  const p = {
    answer: 'v=0 answer', sent: [], scr: [], closed: false, buffered: 0,
    send: (s) => { p.sent.push(JSON.parse(s)); },
    sendScr: (b) => { p.scr.push(b); },
    bufferedAmount: () => p.buffered,
    onMessage: (f) => { msg = f; }, onState: (f) => { state = f; },
    close() { p.closed = true; },
    phone: (o) => msg(JSON.stringify(o)),
    open: () => state('open'), drop: () => state('closed'),
    of: (t) => p.sent.filter((m) => m.t === t),
  };
  return p;
}

/** Hydra's /api/agent/remote/mac: the poll waits until offer() or the abort; ops are recorded. */
export function fakeApi() {
  const waiting = [];
  const a = {
    polls: 0, ops: [], beatStatus: 200, beatAnswer: 'live', answerStatus: 200,
    offer(session) { const w = waiting.shift(); if (w) w(session); else a.queued.push(session); },
    queued: [],
    async req(path, { method = 'GET', body, signal } = {}) {
      if (path.startsWith('/api/agent/remote/mac') && method === 'GET') {
        a.polls += 1;
        const s = a.queued.shift() ?? await new Promise((res, rej) => { waiting.push(res); signal?.addEventListener('abort', () => rej(new Error('aborted'))); });
        return { status: 200, ok: true, json: async () => ({ session: s }) };
      }
      a.ops.push(body);
      const status = body.op === 'beat' ? a.beatStatus : body.op === 'answer' ? a.answerStatus : 200;
      return { status, ok: status < 300, json: async () => (body.op === 'beat' ? { ok: true, status: a.beatAnswer } : { ok: true }) };
    },
    op: (op) => a.ops.filter((o) => o.op === op),
  };
  return a;
}

export const SESSION = { id: '6c5f0a52-6a3b-4b5e-9f2e-1d1d1d1d1d1d', sdp: 'v=0 offer', iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
