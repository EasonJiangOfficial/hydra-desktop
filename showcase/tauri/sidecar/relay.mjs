// The relay client (W3 contract: the Mac is the brain; W3 contract-fixes). While this Mac is paired, awake or asleep,
// it long-polls Hydra for turns sent from the website, the phone or a routine, runs each one with the desktop agent
// (runTurn) and streams its events back in the agent SSE contract's shapes: text{delta}, tool{name,status,summary},
// ui{action}, confirm{id,summary,danger}, done{usage?}, error{message,code?}.
// - Two slots (fixes 7): one live turn (web, phone) and one routine turn at a time, each its own poll (?slot=), so a
//   routine waiting for the owner's yes never holds up the phone.
// - Every event is checked against the server's limits before it is queued (fixes 2): text is split to 8000
//   characters, summaries are cut to size, a ui action the server would refuse is dropped with a log line.
// - Every post carries the turn's claimId (fixes 4). 409: the turn is no longer ours (re-queued, expired, closed), so
//   it stops. Any other 4xx is fatal for the turn (fixes 3): it stops and posts error mac_bad_event once, never a
//   retry. Offline or 5xx: tried again for about 30 s, then the turn stops (its lease runs out on the server).
// - A quiet turn posts an empty batch every heartbeatMs (20 s; the lease is 60 s) while it runs or waits (fixes 5).
// - approve() turns a Mac-side ask into a server approval the owner answers on any surface (fixes 6).
// Offline or refused between turns: it backs off (1 s up to a minute), never a busy loop.
import { delay, waitApproval } from './hydramcp.mjs';
// The server's shapes and limits (src/lib/agent/relay-schema.ts, copied verbatim).
import { LIMITS, relayEventSchema } from './relayschema.mjs';

const BACKOFF = [1000, 2000, 5000, 10_000, 30_000, 60_000];
const RETRY = [500, 1000, 2000, 4000, 8000, 16_000];
export const SLOTS = ['live', 'routine'];
export const TEXT_MAX = LIMITS.textDelta;
export const BAD_EVENT = { type: 'error', code: 'mac_bad_event', message: 'Hydra hit a problem on your Mac.' };

const str = (v, max) => String(v ?? '').slice(0, max);
export { relayEventSchema };
/** The agent's usage ({inputTokens, outputTokens, cacheRead, cacheWrite} or already snake_case) as the server takes it. */
export function snakeUsage(u) {
  if (!u || typeof u !== 'object') return undefined;
  const n = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : undefined);
  const out = {
    input_tokens: n(u.input_tokens ?? u.inputTokens), output_tokens: n(u.output_tokens ?? u.outputTokens),
    cache_read_input_tokens: n(u.cache_read_input_tokens ?? u.cacheRead), cache_creation_input_tokens: n(u.cache_creation_input_tokens ?? u.cacheWrite),
  };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return Object.keys(out).length ? out : undefined;
}
/** One event as the server takes it: a list (text is split), or [] when it can't be sent. */
export function cleanEvent(ev) {
  let e;
  switch (ev?.type) {
    case 'text': {
      const t = String(ev.delta ?? ''), out = [];
      for (let i = 0; i < t.length;) {
        let j = Math.min(i + TEXT_MAX, t.length);
        if (j < t.length && /[\ud800-\udbff]/.test(t[j - 1])) j--; // never split a surrogate pair
        out.push({ type: 'text', delta: t.slice(i, j) }); i = j;
      }
      return out;
    }
    case 'tool': e = { type: 'tool', name: str(ev.name, LIMITS.toolName) || 'tool', status: ev.status, summary: str(ev.summary, LIMITS.toolSummary) }; break;
    case 'ui': e = { type: 'ui', action: ev.action }; break;
    case 'confirm': e = { type: 'confirm', id: ev.id, summary: str(ev.summary, LIMITS.confirmSummary).trim() || 'Needs your yes.', danger: ev.danger === true }; break;
    case 'done': { const usage = snakeUsage(ev.usage); e = usage ? { type: 'done', usage } : { type: 'done' }; break; }
    case 'error': e = { type: 'error', message: str(ev.message, LIMITS.errorMessage) || 'The Mac could not finish.', ...(ev.code ? { code: str(ev.code, LIMITS.errorCode) } : {}) }; break;
    default: return [];
  }
  return relayEventSchema.safeParse(e).success ? [e] : [];
}

/** A routine's tool groups (routine.tools on the server: hydra, mac, gmail, calendar): may(group, name). No list: all. */
export function toolFilter(allowedTools) {
  const g = Array.isArray(allowedTools) ? new Set(allowedTools.map(String)) : null;
  return (group, name) => !g || g.has(group) || g.has(name);
}
/** The group a claude.ai connector's tools belong to. */
export const connectorGroup = (server) => (/gmail/i.test(server) ? 'gmail' : /calendar/i.test(server) ? 'calendar' : String(server));

export function createRelay({ api, runTurn, log = () => {}, sleep = delay, waitSecs = 25, heartbeatMs = 20_000, flushMs = 150, backoff = BACKOFF, retry = RETRY, minPollMs = 1000, slots = SLOTS, onAuth = () => {}, waitFor = (id, signal) => waitApproval(api, id, { signal }) }) {
  let ctrl = null, loopP = null;
  const current = new Map(); // slot -> turn id

  async function loop(signal, slot) {
    let fails = 0;
    while (!signal.aborted) {
      const t0 = Date.now();
      try {
        const r = await api.req(`/api/agent/relay/next?wait=${waitSecs}&slot=${slot}`, { signal, timeout: (waitSecs + 15) * 1000 });
        if (r.status === 204) {
          fails = 0; onAuth(true);
          // A server that answers at once instead of holding the poll: wait a little anyway.
          if (Date.now() - t0 < minPollMs) await sleep(minPollMs, signal).catch(() => {});
          continue;
        }
        if (!r.ok) {
          // Not paired any more (revoked) or not allowed: wait long before asking again.
          if (r.status === 401 || r.status === 403) { fails = backoff.length - 1; onAuth(false, r.status); }
          throw new Error(`relay ${r.status}`);
        }
        const j = await r.json().catch(() => null);
        fails = 0; onAuth(true);
        if (j?.turn?.id) await serve(j.turn, signal, slot);
      } catch (e) {
        if (signal.aborted) break;
        if (e?.code === 'unpaired') { log('relay', { stopped: 'unpaired', slot }); break; }
        const wait = backoff[Math.min(fails++, backoff.length - 1)];
        log('relay_wait', { slot, error: String(e?.message ?? e).slice(0, 120), ms: wait });
        await sleep(wait, signal).catch(() => {});
      }
    }
  }

  async function serve(turn, outer, slot) {
    const turnCtrl = new AbortController();
    const stopTurn = () => turnCtrl.abort();
    outer.addEventListener('abort', stopTurn, { once: true });
    current.set(slot, turn.id);
    const claimId = typeof turn.claimId === 'string' ? turn.claimId : undefined;
    const queue = [];
    // sent: events this claim stored, so each batch carries its first event's number (seq) and a retried post is
    // stored once (the server skips what it has).
    let closed = false, posting = Promise.resolve(), timer = null, lost = null, sent = 0;
    log('relay_turn', { id: turn.id, surface: turn.surface, slot });
    const send = (events) => api.req('/api/agent/relay/events', {
      method: 'POST', body: { turnId: turn.id, ...(claimId ? { claimId } : {}), ...(events.length ? { seq: sent + 1 } : {}), events }, timeout: 20_000,
    });
    const stop = (why, status) => {
      if (lost) return;
      lost = why; closed = true; queue.length = 0;
      log('relay_lost', { id: turn.id, why, status });
      turnCtrl.abort();
    };
    // Posts in order. 409: not ours any more. Another 4xx: fatal, one error batch. Offline or 5xx: a few tries.
    const post = async (events) => {
      for (let i = 0; !lost; i++) {
        let r = null;
        try { r = await send(events); } catch { /* offline: below */ }
        if (r?.ok) { sent += events.length; return true; }
        if (r?.status === 409) { stop('stale_claim', 409); return false; }
        if (r && r.status >= 400 && r.status < 500) {
          stop('bad_event', r.status);
          await send([BAD_EVENT]).catch(() => {});
          return false;
        }
        if (i >= retry.length) { stop('unreachable', r?.status); return false; }
        await sleep(retry[i]).catch(() => {});
      }
      return false;
    };
    const flush = () => {
      clearTimeout(timer); timer = null;
      if (!queue.length || lost) return posting;
      const batch = queue.splice(0);
      posting = posting.then(() => post(batch));
      return posting;
    };
    const emit = (ev) => {
      if (closed || !ev?.type) return;
      const clean = cleanEvent(ev);
      if (!clean.length) { if (ev.type !== 'text') log('relay_drop', { id: turn.id, type: ev.type, kind: ev.action?.kind }); return; }
      if (ev.type === 'done' || ev.type === 'error') closed = true;
      queue.push(...clean);
      // The end, and a confirm (the owner answers it elsewhere), go at once; the rest in small batches.
      if (closed || ev.type === 'confirm') flush();
      else timer ??= setTimeout(flush, flushMs);
    };
    // A Mac-side ask (a connector send, a Mac tool, a risky click) as a server approval: 'approved', 'declined' or
    // 'expired'. Anything that goes wrong is not a yes.
    const approve = async ({ summary, danger = true } = {}) => {
      if (lost || turnCtrl.signal.aborted) return 'expired';
      const s = str(summary, LIMITS.confirmSummary).trim() || 'Needs your yes.';
      let r;
      try {
        r = await api.req('/api/agent/relay/approval', { method: 'POST', body: { turnId: turn.id, ...(claimId ? { claimId } : {}), summary: s, danger: !!danger }, signal: turnCtrl.signal, timeout: 20_000 });
      } catch { return 'expired'; }
      if (r.status === 409) { stop('stale_claim', 409); return 'expired'; }
      const id = r.ok ? (await r.json().catch(() => null))?.id : null;
      if (typeof id !== 'string') { log('relay_approval', { id: turn.id, status: r.status }); return 'expired'; }
      emit({ type: 'confirm', id, summary: s, danger: !!danger });
      const answer = await waitFor(id, turnCtrl.signal);
      log('relay_approval', { id: turn.id, answer });
      return answer;
    };
    const beat = setInterval(() => { if (!queue.length && !lost && !closed) posting = posting.then(() => post([])); }, heartbeatMs);
    try {
      await runTurn(turn, { emit, signal: turnCtrl.signal, approve });
      if (!closed) emit({ type: 'done' });
    } catch (e) {
      if (!closed) emit({ type: 'error', message: String(e?.message ?? e).slice(0, 500) || 'The Mac could not finish.', ...(e?.code ? { code: String(e.code) } : {}) });
    } finally {
      clearInterval(beat);
      outer.removeEventListener('abort', stopTurn);
      await flush();
      await posting;
      current.delete(slot);
      log('relay_done', { id: turn.id, lost });
    }
  }

  return {
    get running() { return !!ctrl; },
    /** The turn each slot is serving: { live, routine } (null when idle). */
    get turns() { return Object.fromEntries(slots.map((s) => [s, current.get(s) ?? null])); },
    start() {
      if (ctrl) return;
      ctrl = new AbortController();
      const me = ctrl;
      loopP = Promise.all(slots.map((s) => loop(me.signal, s))).finally(() => { if (ctrl === me) ctrl = null; });
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
