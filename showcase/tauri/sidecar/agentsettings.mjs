// Hydra's shared agent settings (W5 voice contract section 1, W6 settings contract): the server is the source of truth.
// GET /api/agent/state (device key) returns agent_settings: wake_phrase, sleep_word, clap_sensitivity, model,
// effort_live, effort_routine. Every brain reads its model and effort from here (the Mac at start, on a change push and
// every 60 s; the server brain per turn), so nothing hard-codes a model. Defaults (the contract's, used until the server
// answers): Opus 5.5, live low, routine medium. An older server may not send the voice fields: `served` says which
// ones it did, and the Mac keeps its own values for the rest. PATCH /api/agent/state saves a change made on the Mac.
export const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
export const EFFORTS = ['low', 'medium', 'high'];
/** The clap sensitivity as the server keeps it, and as the voice helper takes it (0 only loud claps ... 1 soft ones). */
export const CLAP_LEVELS = Object.freeze({ low: 0.2, medium: 0.5, high: 0.8 });
export const SETTINGS_DEFAULTS = Object.freeze({ wakePhrase: 'Hey Hydra', sleepWord: null, clapSensitivity: null, model: 'claude-opus-5-5', effortLive: 'low', effortRoutine: 'medium' });
const VOICE_FIELDS = [['wakePhrase', 'wake_phrase'], ['sleepWord', 'sleep_word'], ['clapSensitivity', 'clap_sensitivity']];
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
const settingsOf = (raw) => (raw && typeof raw === 'object' ? (raw.settings && typeof raw.settings === 'object' ? raw.settings : raw) : {});
export function cleanSettings(raw, before = SETTINGS_DEFAULTS) {
  const s = settingsOf(raw);
  const model = pick(s, 'model'), live = pick(s, 'effortLive', 'effort_live'), routine = pick(s, 'effortRoutine', 'effort_routine');
  const sleep = pick(s, 'sleepWord', 'sleep_word'), clap = pick(s, 'clapSensitivity', 'clap_sensitivity');
  return {
    wakePhrase: cleanWakePhrase(pick(s, 'wakePhrase', 'wake_phrase')) ?? before.wakePhrase,
    sleepWord: typeof sleep === 'string' ? sleep.trim().replace(/\s+/g, ' ').slice(0, 40) : before.sleepWord,
    clapSensitivity: Object.hasOwn(CLAP_LEVELS, clap) ? clap : before.clapSensitivity ?? null,
    model: MODELS.includes(model) ? model : before.model,
    effortLive: EFFORTS.includes(live) ? live : before.effortLive,
    effortRoutine: EFFORTS.includes(routine) ? routine : before.effortRoutine,
  };
}
/** The voice fields an answer really had (valid ones), by their camelCase names. */
export function servedFields(raw) {
  const s = settingsOf(raw), clean = cleanSettings(raw, {});
  return new Set(VOICE_FIELDS.filter(([c, snake]) => pick(s, c, snake) !== undefined && clean[c] != null).map(([c]) => c));
}
/** The model and thinking level for one turn: a routine thinks at effort_routine, everything else at effort_live. */
export const brainFor = (settings, surface) => ({ model: settings.model, thinking: surface === 'routine' ? settings.effortRoutine : settings.effortLive });

/**
 * Reads the settings now, on refresh() (a change push) and every everyMs. onChange(next, before) runs when any value
 * changed. A failed read (offline, 5xx, unpaired) keeps what it had. current: the last good settings.
 */
export function createSettingsWatch({ api, onChange = () => {}, log = () => {}, everyMs = SETTINGS_EVERY_MS, setTimer = (f, ms) => setTimeout(f, ms), clearTimer = (h) => clearTimeout(h) }) {
  let current = { ...SETTINGS_DEFAULTS }, served = new Set(), timer = null, running = false, inflight = null;
  const arm = () => { if (!running) return; if (timer) clearTimer(timer); timer = setTimer(() => { timer = null; refresh(); }, everyMs); timer?.unref?.(); };
  async function read() {
    try {
      const r = await api.req('/api/agent/state', { timeout: 20_000 });
      if (!r.ok) { log('agent_settings', { status: r.status }); return current; }
      take(await r.json());
    } catch (e) { if (e?.code !== 'unpaired') log('agent_settings', { error: String(e?.message ?? e).slice(0, 120) }); }
    return current;
  }
  function take(body) {
    const next = cleanSettings(body, current);
    const changed = Object.keys(next).filter((k) => next[k] !== current[k]);
    const before = current;
    current = next;
    served = servedFields(body);
    if (changed.length) { log('agent_settings', { changed }); onChange(next, before); }
  }
  /** Saves a change made on the Mac (any subset of the contract's fields). { ok, status } */
  async function patch(fields) {
    try {
      const r = await api.req('/api/agent/state', { method: 'PATCH', body: fields, timeout: 20_000 });
      if (!r.ok) { log('agent_settings', { patch: r.status }); return { ok: false, status: r.status }; }
      take(await r.json());
      return { ok: true, status: r.status };
    } catch (e) { log('agent_settings', { patch: String(e?.message ?? e).slice(0, 120) }); return { ok: false, status: 0 }; }
  }
  function refresh() {
    arm();
    inflight ??= read().finally(() => { inflight = null; });
    return inflight;
  }
  return {
    get current() { return current; },
    /** The voice fields the server sent in its last answer (an older server may send none). */
    get served() { return served; },
    refresh,
    patch,
    start() { running = true; return refresh(); },
    stop() { running = false; if (timer) clearTimer(timer); timer = null; },
  };
}
