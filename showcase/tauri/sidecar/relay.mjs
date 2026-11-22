// The relay client (W3 contract: the Mac is the brain). While this Mac is paired, awake or asleep, it long-polls
// Hydra for turns sent from the website, the phone or a routine, runs each one with the desktop agent (runTurn) and
// streams its events back in the agent SSE contract's shapes: text{delta}, tool{name,status,summary}, ui{action},
// confirm{id,summary,danger}, done{usage?}, error{message,code?}. One turn at a time. Offline or refused: it backs off
// (1 s up to a minute), never a busy loop. Any event post renews the turn's 60 s lease; a quiet turn (a long tool, a
// wait for the owner's yes) posts an empty batch every heartbeatMs to keep it.
import { delay } from './hydramcp.mjs';

const BACKOFF = [1000, 2000, 5000, 10_000, 30_000, 60_000];

export function createRelay({ api, runTurn, log = () => {}, sleep = delay, waitSecs = 25, heartbeatMs = 20_000, flushMs = 150, backoff = BACKOFF, minPollMs = 1000 }) {
  let ctrl = null, loopP = null, current = null;

  async function loop(signal) {
    let fails = 0;
    while (!signal.aborted) {
      const t0 = Date.now();
      try {
        const r = await api.req(`/api/agent/relay/next?wait=${waitSecs}`, { signal, timeout: (waitSecs + 15) * 1000 });
        if (r.status === 204) {
          fails = 0;
          // A server that answers at once instead of holding the poll: wait a little anyway.
          if (Date.now() - t0 < minPollMs) await sleep(minPollMs, signal).catch(() => {});
          continue;
        }
        if (!r.ok) {
          // Not paired any more (revoked) or not allowed: wait long before asking again.
          if (r.status === 401 || r.status === 403) fails = backoff.length - 1;
          throw new Error(`relay ${r.status}`);
        }
        const j = await r.json().catch(() => null);
        fails = 0;
        if (j?.turn?.id) await serve(j.turn, signal);
      } catch (e) {
        if (signal.aborted) break;
        if (e?.code === 'unpaired') { log('relay', { stopped: 'unpaired' }); break; }
        const wait = backoff[Math.min(fails++, backoff.length - 1)];
        log('relay_wait', { error: String(e?.message ?? e).slice(0, 120), ms: wait });
        await sleep(wait, signal).catch(() => {});
      }
    }
  }

  async function serve(turn, outer) {
    const turnCtrl = new AbortController();
    const stopTurn = () => turnCtrl.abort();
    outer.addEventListener('abort', stopTurn, { once: true });
    current = { id: turn.id, abort: stopTurn };
    const queue = [];
    let closed = false, posting = Promise.resolve(), timer = null, lost = false;
    log('relay_turn', { id: turn.id, surface: turn.surface });
    // Posts in order; a turn the server no longer has (expired, taken back) stops the run.
    const post = async (events, tries = 4) => {
      for (let i = 0; i < tries && !lost; i++) {
        try {
          const r = await api.req('/api/agent/relay/events', { method: 'POST', body: { turnId: turn.id, events }, timeout: 20_000 });
          if (r.ok) return true;
          if (r.status === 404 || r.status === 409 || r.status === 410) { lost = true; log('relay_lost', { id: turn.id, status: r.status }); turnCtrl.abort(); return false; }
        } catch { /* offline: try again */ }
        if (i < tries - 1) await sleep(500 * 2 ** i).catch(() => {});
      }
      return false;
    };
    const flush = () => {
      clearTimeout(timer); timer = null;
      if (!queue.length) return posting;
      const batch = queue.splice(0);
      posting = posting.then(() => post(batch));
      return posting;
    };
    const emit = (ev) => {
      if (closed || !ev?.type) return;
      if (ev.type === 'done' || ev.type === 'error') closed = true;
      queue.push(ev);
      // The end, and a confirm (the owner answers it elsewhere), go at once; the rest in small batches.
      if (closed || ev.type === 'confirm') flush();
      else timer ??= setTimeout(flush, flushMs);
    };
    const beat = setInterval(() => { if (!queue.length) posting = posting.then(() => post([], 1)); }, heartbeatMs);
    try {
      await runTurn(turn, { emit, signal: turnCtrl.signal });
      if (!closed) emit({ type: 'done' });
    } catch (e) {
      if (!closed) emit({ type: 'error', message: String(e?.message ?? e).slice(0, 500) || 'The Mac could not finish.', ...(e?.code ? { code: String(e.code) } : {}) });
    } finally {
      clearInterval(beat);
      outer.removeEventListener('abort', stopTurn);
      await flush();
      current = null;
      log('relay_done', { id: turn.id, lost });
    }
  }

  return {
    get running() { return !!ctrl; },
    get turn() { return current?.id ?? null; },
    start() {
      if (ctrl) return;
      ctrl = new AbortController();
      const me = ctrl;
      loopP = loop(me.signal).finally(() => { if (ctrl === me) ctrl = null; });
    },
    /** Stops polling (unpaired); a turn under way ends with an error. */
    async stop() {
      const c = ctrl;
      ctrl = null;
      c?.abort();
      await loopP?.catch(() => {});
    },
  };
}
