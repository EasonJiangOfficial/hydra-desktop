// Hydra's shared agent settings (W5 voice contract section 1): the server is the source of truth. GET /api/agent/state
// (device key) returns agent_settings: wake_phrase, sleep_word, model, effort_live, effort_routine. Every brain reads
// its model and effort from here (the Mac at start, on a change push and every 60 s; the server brain per turn), so
// nothing hard-codes a model. Defaults (the contract's, used until the server answers): Opus 5.5, live low, routine medium.
export const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
export const EFFORTS = ['low', 'medium', 'high'];
export const SETTINGS_DEFAULTS = Object.freeze({ wakePhrase: 'Hey Hydra', sleepWord: null, model: 'claude-opus-5-5', effortLive: 'low', effortRoutine: 'medium' });
export const SETTINGS_EVERY_MS = 60_000;

const pick = (o, ...keys) => { for (const k of keys) if (o && o[k] !== undefined) return o[k]; return undefined; };
/** A wake phrase as the server keeps it: 2 to 40 characters, spaces squeezed; anything else is null. */
export function cleanWakePhrase(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim().replace(/\s+/g, ' ');
  return t.length >= 2 && t.length <= 40 && /\p{L}/u.test(t) ? t : null;
}
/**
 * The settings in an /api/agent/state answer (its `settings` object, camelCase or snake_case), each one checked: a
 * value that is missing or out of range keeps the one before (else the default). Returns a new object.
 */
export function cleanSettings(raw, before = SETTINGS_DEFAULTS) {
  const s = raw && typeof raw === 'object' ? (raw.settings && typeof raw.settings === 'object' ? raw.settings : raw) : {};
  const model = pick(s, 'model'), live = pick(s, 'effortLive', 'effort_live'), routine = pick(s, 'effortRoutine', 'effort_routine');
  const sleep = pick(s, 'sleepWord', 'sleep_word');
  return {
    wakePhrase: cleanWakePhrase(pick(s, 'wakePhrase', 'wake_phrase')) ?? before.wakePhrase,
    sleepWord: typeof sleep === 'string' ? sleep.trim().replace(/\s+/g, ' ').slice(0, 40) : before.sleepWord,
    model: MODELS.includes(model) ? model : before.model,
    effortLive: EFFORTS.includes(live) ? live : before.effortLive,
    effortRoutine: EFFORTS.includes(routine) ? routine : before.effortRoutine,
  };
}
/** The model and thinking level for one turn: a routine thinks at effort_routine, everything else at effort_live. */
export const brainFor = (settings, surface) => ({ model: settings.model, thinking: surface === 'routine' ? settings.effortRoutine : settings.effortLive });

/**
 * Reads the settings now, on refresh() (a change push) and every everyMs. onChange(next, before) runs when any value
 * changed. A failed read (offline, 5xx, unpaired) keeps what it had. current: the last good settings.
 */
export function createSettingsWatch({ api, onChange = () => {}, log = () => {}, everyMs = SETTINGS_EVERY_MS, setTimer = (f, ms) => setTimeout(f, ms), clearTimer = (h) => clearTimeout(h) }) {
  let current = { ...SETTINGS_DEFAULTS }, timer = null, running = false, inflight = null;
  const arm = () => { if (!running) return; if (timer) clearTimer(timer); timer = setTimer(() => { timer = null; refresh(); }, everyMs); timer?.unref?.(); };
  async function read() {
    try {
      const r = await api.req('/api/agent/state', { timeout: 20_000 });
      if (!r.ok) { log('agent_settings', { status: r.status }); return current; }
      const next = cleanSettings(await r.json(), current);
      const changed = Object.keys(next).filter((k) => next[k] !== current[k]);
      const before = current;
      current = next;
      if (changed.length) { log('agent_settings', { changed }); onChange(next, before); }
    } catch (e) { if (e?.code !== 'unpaired') log('agent_settings', { error: String(e?.message ?? e).slice(0, 120) }); }
    return current;
  }
  function refresh() {
    arm();
    inflight ??= read().finally(() => { inflight = null; });
    return inflight;
  }
  return {
    get current() { return current; },
    refresh,
    start() { running = true; return refresh(); },
    stop() { running = false; if (timer) clearTimer(timer); timer = null; },
  };
}
