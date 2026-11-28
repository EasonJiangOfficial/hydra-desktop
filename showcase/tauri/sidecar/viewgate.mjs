// The agent's side of the phone view (RV plan section 8). Take over closes the gate: no Mac tool starts (reads and
// screenshots too), so the agent sees nothing the owner does. Hand back within 75 s opens it, and the waiting tool
// is told to look again; after 75 s the tool returns "still in control" and the turn ends cleanly. Stop rejects the
// wait. While a session is live (tap set), each Mac tool and each helper step sends a caption, never typed text.
import { describe } from './activity.mjs';

// Tools that look at or act on the screen. ponytail: named here; a new screen tool must be added to wait too.
export const MAC_TOOLS = new Set(['take_screenshot', 'list_windows', 'read_window', 'act_in_app', 'draw', 'open', 'manage_app']);
export const HANDBACK_LINE = (s) => `The owner took control for ${s} s and handed back. The screen may have changed. Look again before you go on.`;
export const STILL_LINE = 'The owner is still in control. Stop here.';
const LIMIT_MS = 75_000, AFTER_MS = 3_000;

const VERB = { click: 'Clicking', press: 'Clicking', fill: 'Typing in', type: 'Typing in', choose: 'Choosing', select: 'Choosing', pick: 'Choosing', key: 'Pressing', hover: 'Pointing at', scroll: 'Scrolling', drag: 'Dragging' };
/** "Clicking Search", "Typing in Subject", "Choosing Canada", "Pressing cmd+w", "Scrolling". The step's label is the
 *  element's name (or the key), never what is typed. */
export function stepCaption(ev) {
  const verb = VERB[String(ev?.do ?? '').toLowerCase()] ?? 'Working';
  const label = String(ev?.label ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!label || verb === 'Scrolling') return verb === 'Typing in' ? 'Typing' : verb;
  return `${verb} ${label}`;
}

const withLine = (res, line) => (typeof res === 'string' ? `${line}\n\n${res}`
  : res && Array.isArray(res.content) ? { ...res, content: [{ type: 'text', text: line }, ...res.content] } : res);

export function createViewGate({ clock = { now: Date.now, setTimeout, clearTimeout }, onStop = () => {} } = {}) {
  let owner = null, view = null, running = 0, lastEnd = -Infinity;
  const waiters = new Set();
  // The agent's turns now running here (a local prompt, a phone or web relay turn, a brain sub-turn): busy all the
  // way through, model thinking included; Stop from the phone aborts each one.
  const turns = new Set();
  let idle = [];
  const publish = (s) => { try { view?.agent(s); } catch { /* the view is gone */ } };
  const settle = (fn) => { for (const w of [...waiters]) { clock.clearTimeout(w.timer); waiters.delete(w); fn(w); } };

  /** signal: the tool call's. Its turn cancelled (Stop on the web, the relay's cap, the server ending it) ends the
   *  wait too, so the tool never runs once the owner hands back. */
  function wait(signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('Stopped.'));
      const off = () => { clock.clearTimeout(w.timer); waiters.delete(w); reject(new Error('Stopped.')); };
      const done = (fn) => (v) => { signal?.removeEventListener('abort', off); fn(v); };
      const w = { resolve: done(resolve), reject: done(reject) };
      w.timer = clock.setTimeout(() => { waiters.delete(w); w.resolve({ still: true }); }, LIMIT_MS);
      waiters.add(w);
      signal?.addEventListener('abort', off, { once: true });
    });
  }

  return {
    /** The live session's publisher ({ agent(state) }), or null when none is live. */
    tap(v) { view = v || null; },
    owner: () => !!owner,
    /** A Mac tool runs, or ran in the last 3 s (the agent is between steps). */
    active: () => running > 0 || clock.now() - lastEnd < AFTER_MS,
    /** Closes the gate at once; resolves when the running Mac tool call has ended (the owner's hands work then). */
    takeover() {
      const first = !owner;
      if (first) owner = { since: clock.now() };
      if (running === 0) {
        if (first) publish({ busy: turns.size > 0, paused: true, caption: 'You are in control' });
        return Promise.resolve();
      }
      // A helper call still runs (it ends first: 120 s at most before audit U1): the phone says so until it has.
      if (first) publish({ busy: true, paused: true, caption: 'Taking over' });
      return new Promise((r) => idle.push(() => { if (owner) publish({ busy: turns.size > 0, paused: true, caption: 'You are in control' }); r(); }));
    },
    /** A turn starts: { signal (aborts with `signal` or Stop from the phone), done() }. busy() until done. */
    turn(signal = null) {
      const c = new AbortController(), t = { c };
      const off = () => c.abort();
      if (signal?.aborted) c.abort(); else signal?.addEventListener('abort', off, { once: true });
      turns.add(t);
      // Busy from its first moment (model thinking included): the phone shows Take over and Stop while the Mac
      // refuses its input 'agent', not only once a Mac tool runs.
      if (turns.size === 1) publish({ busy: true, paused: !!owner });
      return {
        signal: c.signal,
        done() {
          if (!turns.delete(t)) return;
          signal?.removeEventListener('abort', off);
          if (!turns.size) publish({ busy: false, paused: !!owner });
        },
      };
    },
    busy: () => turns.size > 0,
    handback() {
      if (!owner) return;
      const secs = Math.max(0, Math.round((clock.now() - owner.since) / 1000));
      owner = null;
      settle((w) => w.resolve({ secs }));
      publish({ busy: running > 0, paused: false });
    },
    /** Stop, from the phone or the Mac: waiters get "stopped", the gate opens, every running turn ends (local, relay
     *  and brain ones: one Stop stops everything), and from the phone the Mac's Stop path runs once. quiet: this is
     *  that Stop path itself (the menu Stop, Esc). */
    stop({ quiet = false } = {}) {
      owner = null;
      settle((w) => w.reject(new Error('Stopped by the owner.')));
      for (const t of turns) t.c.abort();
      if (!quiet) onStop();
      // A helper call still running is killed by its signal (tools.mjs); until it ends the Mac still refuses 'agent'.
      publish({ busy: running > 0, paused: false });
    },
    wrap(tool) {
      if (!MAC_TOOLS.has(tool.name)) return tool;
      const run = tool.execute;
      return { ...tool, execute: async (args, ctx) => {
        // Counted live view or not: Take over waits for a call that began before the view went live.
        let line = null;
        if (owner) {
          const r = await wait(ctx?.signal);
          if (r.still) return STILL_LINE;
          if (ctx?.signal?.aborted) throw new Error('Stopped.');
          line = HANDBACK_LINE(r.secs);
        }
        const words = describe(tool.name, args ?? {});
        if (words) publish({ busy: true, paused: false, caption: words[0] });
        running += 1;
        try {
          const res = await run(args, ctx);
          return line ? withLine(res, line) : res;
        } finally {
          running -= 1; lastEnd = clock.now();
          if (running === 0) { for (const r of idle) r(); idle = []; }
          if (words) publish({ busy: turns.size > 0 || running > 0, paused: !!owner, caption: words[1] });
        }
      } };
    },
    /** A helper step event ({do, label, bounds}): the caption and where it lands. */
    step(ev) {
      if (!view) return;
      const s = { busy: true, caption: stepCaption(ev) };
      if (Array.isArray(ev?.bounds) && ev.bounds.length === 4 && ev.bounds.every(Number.isFinite)) s.step = { bounds: ev.bounds, kind: String(ev.do ?? '').slice(0, 20) };
      publish(s);
    },
  };
}
