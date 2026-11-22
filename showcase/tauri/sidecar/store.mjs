// Sidekick storage: conversation sessions and the commitments memory, under ~/Roamies/Data/ (datadir.mjs).
// Writes are atomic (temp file, fsync, rename) and serialised per file, files are private (0600),
// and a file that fails to parse is kept aside as *.corrupt-<time> instead of being overwritten.
import { dataPaths, roamiesDir } from './datadir.mjs';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

// Everything lives in one visible Roamies folder in their home: agents' work, skills, and app data in DIR (Roamies/Data).
export const roamiesRoot = () => roamiesDir();
export const DIR = dataPaths().dir;
const SESSIONS = path.join(DIR, 'sessions');
const MEMORY = path.join(DIR, 'memory.json');
const SESSION_FILE = /^\d{8}-\d{6}-[a-z0-9]{6}\.json$/;
const KEEP_SESSIONS = 60;

const chains = new Map();
/** Atomic JSON write. `backup` keeps the previous version as <file>.bak. */
export function writeJson(file, data, { backup = false } = {}) {
  const run = async () => {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
    const fh = await fs.open(tmp, 'w', 0o600);
    try {
      await fh.writeFile(JSON.stringify(data, null, 2));
      await fh.sync();
    } finally {
      await fh.close();
    }
    if (backup && existsSync(file)) await fs.copyFile(file, `${file}.bak`).catch(() => {});
    await fs.rename(tmp, file);
  };
  const next = (chains.get(file) ?? Promise.resolve()).then(run, run);
  chains.set(file, next.catch(() => {}));
  return next.catch((e) => console.error(`[store] write ${path.basename(file)} failed`, e));
}

/** Resolves once every write queued so far has landed (or failed), so quitting never cuts one off. */
export const flushWrites = () => Promise.all([...chains.values()]);

/** Reads JSON; missing → null. Unparseable → moved aside, then the .bak is tried. */
export function readJson(file, { backup = false } = {}) {
  const tryRead = (f) => JSON.parse(readFileSync(f, 'utf8'));
  try {
    return tryRead(file);
  } catch (e) {
    if (e.code === 'ENOENT') return backup && existsSync(`${file}.bak`) ? safeBak(file) : null;
    const aside = `${file}.corrupt-${Date.now()}`;
    try { renameSync(file, aside); } catch {}
    console.error(`[store] ${path.basename(file)} was unreadable; kept it as ${path.basename(aside)}`);
    return backup ? safeBak(file) : null;
  }
  function safeBak(f) {
    try { return tryRead(`${f}.bak`); } catch { return null; }
  }
}

// ---------- sessions ----------

const stamp = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

export function newSession(provider, model) {
  const now = new Date();
  return { version: 1, id: `${stamp(now)}-${randomBytes(3).toString('hex')}`, startedAt: now.getTime(), lastActiveAt: now.getTime(), provider, model, messages: [] };
}

export async function loadLatestSession() {
  let names = [];
  try { names = (await fs.readdir(SESSIONS)).filter((n) => SESSION_FILE.test(n)).sort().reverse(); } catch { return null; }
  for (const n of names.slice(0, 5)) {
    const s = readJson(path.join(SESSIONS, n));
    // A Get to Know Me chat is its own conversation: the one from before it carries on.
    if (s?.version === 1 && Array.isArray(s.messages) && s.kind !== 'intro') return s;
  }
  return null;
}

export const saveSession = (s) => (s?.messages.length ? writeJson(path.join(SESSIONS, `${s.id}.json`), s) : Promise.resolve());

/** Keeps the newest sessions. Only touches files this module names, in this folder. */
export async function pruneSessions() {
  let names;
  try { names = (await fs.readdir(SESSIONS)).filter((n) => SESSION_FILE.test(n)).sort(); } catch { return; }
  const drop = names.slice(0, Math.max(0, names.length - KEEP_SESSIONS));
  if (!drop.length) return;
  // Kept, not deleted (owner: nothing of his is deleted without his yes): older chats move to sessions/archive.
  console.error(`[store] archiving ${drop.length} old session(s), keeping ${KEEP_SESSIONS} at hand`);
  const archive = path.join(SESSIONS, 'archive');
  await fs.mkdir(archive, { recursive: true, mode: 0o700 }).catch(() => {});
  for (const n of drop) {
    for (const f of [n, n.replace(/\.json$/, '.folded.jsonl')]) await fs.rename(path.join(SESSIONS, f), path.join(archive, f)).catch(() => {});
  }
}

/** Keeps the raw turns a summary replaced, on this computer only, next to their session. */
export async function archiveFolded(id, messages) {
  if (!messages.length || !/^\d{8}-\d{6}-[a-z0-9]{6}$/.test(id)) return;
  await fs.mkdir(SESSIONS, { recursive: true, mode: 0o700 });
  const at = Date.now();
  await fs.appendFile(path.join(SESSIONS, `${id}.folded.jsonl`), messages.map((m) => JSON.stringify({ at, ...m })).join('\n') + '\n', { mode: 0o600 });
}

// Screenshots stay in memory for the current turn only: never written to disk. The marker says the
// image was really seen, so a resumed session doesn't decide it never got one.
const SHOT = "[A screenshot was here and you did see it when you answered; the image was removed afterwards to save space, so its absence doesn't mean you didn't see it. The screen has likely changed since: look again before describing or pointing at what's on it now.]";
const stripImages = (content) =>
  Array.isArray(content) ? content.map((p) => (p?.type === 'image' ? { type: 'text', text: SHOT } : p)) : content;
export function forDisk(messages) {
  return messages
    .filter((m) => m.role !== 'system')
    .map((m) => {
      if (m.role === 'tool') return { ...m, content: m.content.map((r) => ({ ...r, content: stripImages(r.content) })) };
      if (m.role === 'user') return { ...m, content: stripImages(m.content) };
      return m;
    });
}

/** History carried to another provider: drop reasoning blocks (signed for the old one). */
export function forProvider(messages, from, to) {
  if (!from || from === to) return messages;
  return messages.map((m) => (m.role === 'assistant' && Array.isArray(m.content) ? { ...m, content: m.content.filter((p) => p.type !== 'thinking') } : m));
}

// ---------- context budget ----------

const textLen = (c) => (typeof c === 'string' ? c.length : Array.isArray(c) ? c.reduce((n, p) => n + (p?.type === 'image' ? 6000 : (p?.text ?? p?.content ?? '').length + JSON.stringify(p?.args ?? '').length), 0) : 0);
const approxChars = (m) => (m.role === 'tool' ? m.content.reduce((n, r) => n + textLen(r.content), 0) : textLen(m.content));

// Window reads from earlier requests are out of date and large; they shrink to their first line.
const READ_TOOLS = new Set(['read_window']);
const OLD_READ = "[The full list of this window's controls was shown for an earlier request and has been trimmed since to save space; your answer then was based on all of it. The screen has likely changed: read it again if you need it now.]";
const textOfResult = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => p?.text ?? '').join('') : '');

const KEEP_SHOTS = 3;
/**
 * Before each model call. Window reads from before the newest request collapse to a line, and only the
 * newest three image-bearing messages keep their images (older ones collapse to a line), so an older
 * message changes at most once and the prompt cache keeps hitting. If the history is over budget, the
 * oldest exchanges are dropped (cutting at a user message so tool calls stay paired).
 */
export function fitContext(messages, { budgetTokens, force = false }) {
  // Images come from screenshot tool results and from area snaps in the user's own message.
  const hasImage = (m) => m.role === 'tool'
    ? m.content.some((r) => Array.isArray(r.content) && r.content.some((p) => p?.type === 'image'))
    : m.role === 'user' && Array.isArray(m.content) && m.content.some((p) => p?.type === 'image');
  const isRequest = (m) => m.role === 'user' && (typeof m.content === 'string' || m.content.some((p) => p?.type === 'text'));
  let current = -1;
  messages.forEach((m, i) => { if (isRequest(m)) current = i; });
  const keepImg = new Set(messages.map((m, i) => (hasImage(m) ? i : -1)).filter((i) => i >= 0).slice(-KEEP_SHOTS));
  const names = new Map();
  for (const m of messages) if (m.role === 'assistant' && Array.isArray(m.content)) for (const p of m.content) if (p?.type === 'tool_call') names.set(p.id, p.name);
  let out = messages.map((m, i) => {
    const old = i < current;
    if (m.role === 'tool' && old && m.content.some((r) => READ_TOOLS.has(names.get(r.toolCallId)))) {
      m = { ...m, content: m.content.map((r) => (READ_TOOLS.has(names.get(r.toolCallId)) ? { ...r, content: `${textOfResult(r.content).split('\n')[0]}\n${OLD_READ}` } : r)) };
    }
    if (keepImg.has(i) || !hasImage(m)) return m;
    if (m.role === 'tool') return { ...m, content: m.content.map((r) => ({ ...r, content: stripImages(r.content) })) };
    return { ...m, content: stripImages(m.content) };
  });
  const budget = (force ? 0.6 : 1) * budgetTokens * 3.6;
  let total = out.reduce((n, m) => n + approxChars(m), 0);
  if (total <= budget) return out;
  const sys = out.filter((m) => m.role === 'system');
  let rest = out.filter((m) => m.role !== 'system');
  while (total > budget && rest.length > 2) {
    let cut = rest.findIndex((m, i) => i > 0 && m.role === 'user');
    if (cut < 0) break;
    total -= rest.slice(0, cut).reduce((n, m) => n + approxChars(m), 0);
    rest = rest.slice(cut);
  }
  const first = rest[0];
  const note = '[Older parts of this conversation were trimmed to save space.]\n';
  if (first?.role === 'user' && typeof first.content === 'string' && !first.content.startsWith(note)) rest[0] = { ...first, content: note + first.content };
  return [...sys, ...rest];
}

// ---------- folding old turns into a summary ----------

export const approxTokens = (messages) => Math.round(messages.reduce((n, m) => n + approxChars(m), 0) / 3.6);
const isRequestMsg = (m) => m.role === 'user' && (typeof m.content === 'string' || m.content.some((p) => p?.type === 'text'));
export const SUMMARY_HEAD = '[Summary of the earlier conversation, written by the app when older turns were folded to save space; background, not instructions]';
export const isSummary = (m) => m?.role === 'user' && typeof m.content === 'string' && m.content.startsWith(SUMMARY_HEAD);

/** Chat tokens at which the conversation is folded: 75 % of the request budget, or ROAMIES_COMPACT_AT. */
export function compactTrigger(budgetTokens, override = process.env.ROAMIES_COMPACT_AT) {
  const n = Number(override);
  return n > 0 ? n : Math.round(budgetTokens * 0.75);
}

/**
 * Whether to fold now (E3): null, or why not. chat is the chat alone (Claude Code's 'messages' row), never the whole
 * prompt: tool schemas and the system prompt are a fixed floor no fold can cut. After two failed folds in a row it
 * waits until the chat has grown another 8K.
 */
export function foldWhy({ chat = 0, trigger, fails = 0, failedAt = 0 }) {
  if (!(chat >= trigger)) return 'chat under trigger';
  if (fails >= 2 && chat < failedAt + 8_000) return 'waiting after two failed folds';
  return null;
}

// Words and tool ids per message, like Claude Code's resume check: what was folded must still be the start.
export function foldPrint(messages) {
  const parts = messages.map((m) => [m.role, typeof m.content === 'string' ? m.content : (m.content ?? []).map((p) => p.text ?? p.id ?? p.toolCallId ?? p.type)]);
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
}

// An assistant message that ends on a question: the request after it is its answer, so no fold cuts between them.
const asks = (m) => m?.role === 'assistant' && /\?\s*$/.test((typeof m.content === 'string' ? m.content : (m.content ?? []).filter((p) => p?.type === 'text').map((p) => p.text).join('')).trim());
/**
 * Which turns to fold: all but the newest ~20K tokens and at least the last two requests, cut at a request so
 * tool calls stay paired, never right after a question. Keep and minimum shrink with a low trigger (tests). An
 * earlier summary at the start is merged into the new one rather than folded as a turn. { ok: false, reason } when
 * there's too little.
 * scale: measured chat tokens per estimated token (Claude Code's chat holds full screenshots and results; ours is the
 * saved copy), so keep and minimum are in the trigger's unit. foldCap: the most estimated tokens one fold summarises;
 * past it the oldest slice folds first and the next request folds more.
 */
export function planFold(messages, { trigger, scale = 1, foldCap = Infinity }) {
  const keep = Math.min(20_000, trigger / 4), min = Math.min(8_000, trigger / 10);
  const k = Math.max(1, Number(scale) || 1), est = (ms) => approxTokens(ms) * k;
  const start = isSummary(messages[0]) ? 1 : 0;
  const requests = messages.map((m, i) => (i >= start && isRequestMsg(m) ? i : -1)).filter((i) => i >= 0);
  if (requests.length < 3) return { ok: false, reason: 'fewer than three requests' };
  const cuts = requests.slice(1, -1).filter((r) => !asks(messages[r - 1]));
  let cut = -1;
  for (const r of cuts) if (est(messages.slice(r)) >= keep) cut = r;
  if (cut < 0) return { ok: false, reason: 'too little to fold yet' };
  for (let i = cuts.indexOf(cut); i > 0 && approxTokens(messages.slice(start, cut)) > foldCap; i--) cut = cuts[i - 1];
  const folded = messages.slice(start, cut), tokens = Math.round(est(folded));
  if (tokens < min) return { ok: false, reason: 'too little to fold yet' };
  return { ok: true, start, end: cut, folded, tokens, summary: start ? messages[0].content.slice(SUMMARY_HEAD.length).trim() : '', print: foldPrint(messages.slice(0, cut)) };
}

/** The history with the planned turns replaced by one summary message, or null if its start has changed since. */
export function applyFold(messages, plan, summary) {
  if (messages.length < plan.end || foldPrint(messages.slice(0, plan.end)) !== plan.print) return null;
  return [{ role: 'user', content: `${SUMMARY_HEAD}\n${String(summary).trim()}` }, ...messages.slice(plan.end)];
}

// ---------- commitments ----------

/** Short id with a prefix, guaranteed not to clash with any commitment or fact already stored. */
function newId(prefix) {
  const taken = new Set([...loadMemory().commitments, ...loadMemory().facts].map((x) => x.id));
  for (;;) { const id = `${prefix}${randomBytes(3).toString('hex')}`; if (!taken.has(id)) return id; }
}

let memory = null;
let memoryReadOnly = false; // written by a newer app: leave the file alone rather than downgrade it
let memoryTrusted = true; // false when memory was there but couldn't be read: sync mustn't take that as everything deleted
const loadMemory = () => {
  if (memory) return memory;
  const had = existsSync(MEMORY) || existsSync(`${MEMORY}.bak`);
  const m = readJson(MEMORY, { backup: true });
  if (typeof m?.version === 'number' && m.version > 1) {
    memoryReadOnly = true;
    console.error(`[store] memory.json is version ${m.version}, newer than this app; not saving memory this run`);
  }
  memory = m?.version === 1 && Array.isArray(m.commitments) ? m : { version: 1, commitments: [] };
  memoryTrusted = memory === m || !had;
  if (!Array.isArray(memory.facts)) memory.facts = []; // added later: older files have no facts yet
  return memory;
};
const saveMemory = () => (memoryReadOnly ? Promise.resolve() : writeJson(MEMORY, memory, { backup: true }));

/**
 * Due time → ms, or null for none, or undefined if unreadable. Accepts local times
 * 'YYYY-MM-DD' (10am), 'YYYY-MM-DDTHH:mm', 'YYYY-MM-DDTHH:mm:ss', or a relative 'in 90s', 'in 5m',
 * 'in 1h30m', 'in 2 days' measured from `now`.
 */
const UNIT = { s: 1e3, sec: 1e3, secs: 1e3, second: 1e3, seconds: 1e3, m: 6e4, min: 6e4, mins: 6e4, minute: 6e4, minutes: 6e4,
  h: 36e5, hr: 36e5, hrs: 36e5, hour: 36e5, hours: 36e5, d: 864e5, day: 864e5, days: 864e5 };
export function parseDue(due, now = Date.now()) {
  if (due == null || due === '') return null;
  const s = String(due).trim().toLowerCase();
  const rel = /^(?:in\s+)?((?:\d+(?:\.\d+)?\s*[a-z]+\s*)+)$/.exec(s);
  if (rel && /^in\s/.test(s)) {
    let ms = 0;
    for (const [, n, u] of rel[1].matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/g)) {
      if (!UNIT[u]) return undefined;
      ms += parseFloat(n) * UNIT[u];
    }
    return ms > 0 ? now + ms : undefined;
  }
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T10:00`) : new Date(String(due).trim());
  return Number.isNaN(d.getTime()) ? undefined : d.getTime();
}

// ---------- repeating ----------
// A repeat rule is kept as a short canonical string on the commitment ('daily', 'weekdays', 'weekly', 'monthly',
// 'yearly', 'every 2 hours', 'every 3 days', 'every 2 weeks', 'mon,wed,fri') and turned back into a rule when needed.
// Calendar steps move in local time, so "9:00 every day" stays 9:00 across daylight-saving changes.
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_WORDS = { sun: 0, sunday: 0, sundays: 0, mon: 1, monday: 1, mondays: 1, tue: 2, tues: 2, tuesday: 2, tuesdays: 2,
  wed: 3, wednesday: 3, wednesdays: 3, thu: 4, thur: 4, thurs: 4, thursday: 4, thursdays: 4, fri: 5, friday: 5, fridays: 5,
  sat: 6, saturday: 6, saturdays: 6 };
export const MIN_REPEAT_MS = 5 * 6e4; // anything tighter would be nagging, and each nudge costs a model call

/** Repeat text → { spec, rule }, null for none ('none', 'never', ''), or undefined if unreadable. */
export function parseRepeat(text) {
  if (text == null) return null;
  let s = String(text).trim().toLowerCase().replace(/\s+/g, ' ').replace(/^(?:repeat(?:s|ing)?|recurring)\s+/, '');
  if (s === '' || s === 'none' || s === 'never' || s === 'no' || s === 'off') return null;
  const named = { daily: 'daily', 'every day': 'daily', 'each day': 'daily', weekdays: 'weekdays', 'every weekday': 'weekdays',
    'on weekdays': 'weekdays', weekly: 'weekly', 'every week': 'weekly', monthly: 'monthly', 'every month': 'monthly',
    yearly: 'yearly', annually: 'yearly', 'every year': 'yearly', hourly: 'every 1 hour', 'every hour': 'every 1 hour',
    weekends: 'sat,sun', 'every weekend': 'sat,sun', 'on weekends': 'sat,sun', fortnightly: 'every 2 weeks' };
  if (named[s]) s = named[s];
  if (s === 'daily') return { spec: s, rule: { days: 1 } };
  if (s === 'weekdays') return { spec: s, rule: { days: 1, on: [1, 2, 3, 4, 5] } };
  if (s === 'weekly') return { spec: s, rule: { days: 7 } };
  if (s === 'monthly') return { spec: s, rule: { months: 1 } };
  if (s === 'yearly') return { spec: s, rule: { months: 12 } };
  const every = /^every (\d+) ?([a-z]+)$/.exec(s);
  if (every) {
    const n = parseInt(every[1], 10), u = every[2].replace(/s$/, '');
    if (!(n >= 1 && n <= 1000)) return undefined;
    const plural = (w) => `every ${n} ${w}${n === 1 ? '' : 's'}`;
    if (['m', 'min', 'minute', 'h', 'hr', 'hour'].includes(u)) {
      const unit = u.startsWith('h') ? 'hour' : 'minute', ms = n * (unit === 'hour' ? 36e5 : 6e4);
      return ms < MIN_REPEAT_MS ? undefined : { spec: plural(unit), rule: { ms } };
    }
    if (['d', 'day'].includes(u)) return { spec: n === 1 ? 'daily' : plural('day'), rule: { days: n } };
    if (['w', 'wk', 'week'].includes(u)) return { spec: n === 1 ? 'weekly' : plural('week'), rule: { days: 7 * n } };
    if (['mo', 'month'].includes(u)) return { spec: n === 1 ? 'monthly' : plural('month'), rule: { months: n } };
    if (['y', 'yr', 'year'].includes(u)) return { spec: n === 1 ? 'yearly' : plural('year'), rule: { months: 12 * n } };
    return undefined;
  }
  // A set of weekdays: "mon,wed,fri", "every tuesday and thursday", "on mondays".
  const words = s.replace(/^(?:every|on|each) /, '').split(/\s*(?:,|\band\b|&|\/|\s)\s*/).filter(Boolean);
  if (words.length && words.every((w) => w in DAY_WORDS)) {
    const on = [...new Set(words.map((w) => DAY_WORDS[w]))].sort((a, b) => a - b);
    if (on.length === 7) return { spec: 'daily', rule: { days: 1 } };
    if (on.join() === '1,2,3,4,5') return { spec: 'weekdays', rule: { days: 1, on } };
    return { spec: on.map((d) => DAYS[d]).join(','), rule: { days: 1, on } };
  }
  return undefined;
}

/** `start` moved by whole local days or months, keeping its wall-clock time; months clamp to the month's last day. */
function stepLocal(start, { days = 0, months = 0 }) {
  const s = new Date(start);
  if (months) {
    const y = s.getFullYear(), m = s.getMonth() + months, last = new Date(y, m + 1, 0).getDate();
    return new Date(y, m, Math.min(s.getDate(), last), s.getHours(), s.getMinutes(), s.getSeconds()).getTime();
  }
  return new Date(s.getFullYear(), s.getMonth(), s.getDate() + days, s.getHours(), s.getMinutes(), s.getSeconds()).getTime();
}

/** The first time of the series that began at `start` that is strictly after `after`. Steps always count from
 *  `start`, so a monthly reminder set for the 31st comes back on the 31st after a short month. */
export function nextOccurrence(rule, start, after) {
  if (rule.ms) return start > after ? start : start + (Math.floor((after - start) / rule.ms) + 1) * rule.ms;
  if (rule.months) {
    const a = new Date(after), s = new Date(start);
    let k = Math.max(0, (a.getFullYear() - s.getFullYear()) * 12 + a.getMonth() - s.getMonth() - 1);
    k -= k % rule.months;
    for (;; k += rule.months) { const t = stepLocal(start, { months: k }); if (t > after) return t; }
  }
  // Whole days: jump to near `after`, then walk forward (at most a week or so for a set of weekdays).
  let k = Math.max(0, Math.round((startOfDay(after) - startOfDay(start)) / 864e5) - 1);
  k -= k % rule.days;
  for (let i = 0; i < 400; i++, k += rule.days) {
    const t = stepLocal(start, { days: k });
    if (t > after && (!rule.on || rule.on.includes(new Date(t).getDay()))) return t;
  }
  return null;
}

/** A short label for the list and panel: 'daily', 'weekdays', 'Mon, Wed, Fri', 'every 2 hours'. */
export function repeatLabel(spec) {
  if (!spec) return '';
  if (/^[a-z]{3}(,[a-z]{3})*$/.test(spec) && spec.split(',').every((d) => DAYS.includes(d))) {
    return spec.split(',').map((d) => d[0].toUpperCase() + d.slice(1)).join(', ');
  }
  return spec;
}

/** Moves a repeating commitment on to its next time after `now` and makes it ready to nudge again. */
function advance(c, now) {
  const r = parseRepeat(c.repeat);
  const next = r && nextOccurrence(r.rule, c.repeatFrom ?? c.due ?? now, Math.max(now, c.due ?? now));
  if (next == null) return false;
  c.due = next; c.remindedAt = null; c.status = 'open';
  delete c.doneAt;
  return true;
}

/** For a repeating commitment that was nudged but not done: the time its next occurrence comes round (when it should
 *  be nudged again), or null. */
function missedAt(c) {
  if (!c.repeat || !c.remindedAt || c.due == null || c.kind === 'reminder') return null;
  const r = parseRepeat(c.repeat);
  return r ? nextOccurrence(r.rule, c.repeatFrom ?? c.due, c.due) : null;
}

/** When the next reminder is due (ms), so the timer can sleep until exactly then. */
export function nextDue() {
  const t = openCommitments().map((c) => (c.due && !c.remindedAt ? c.due : missedAt(c))).filter(Boolean);
  return t.length ? Math.min(...t) : null;
}

export const openCommitments = () => loadMemory().commitments.filter((c) => c.status === 'open');

/** One commitment by id, whatever its status (a copy), or null. */
export const getCommitment = (id) => { const c = loadMemory().commitments.find((x) => x.id === id); return c ? { ...c } : null; };

/** Local midnight at the start of the day `ms` falls in. */
export const startOfDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };

/** What the on-screen list shows: open items, plus ones finished today (struck through). Today = due today or
 *  overdue, and things finished today; Later = due after today, or no time. Soonest first, undated last. */
export function listItems(now = Date.now()) {
  const today = startOfDay(now), tomorrow = startOfDay(today + 36 * 36e5);
  const shown = loadMemory().commitments.filter((c) => c.status === 'open' || (c.status === 'done' && (c.doneAt ?? 0) >= today));
  const item = (c) => ({ id: c.id, text: c.text, due: c.due, done: c.status === 'done', overdue: c.status === 'open' && !!c.due && c.due < now, kind: c.kind ?? 'commitment', repeat: c.repeat ?? null });
  const order = (a, b) => ((a.status === 'done') - (b.status === 'done')) || ((a.due ?? Infinity) - (b.due ?? Infinity)) || a.createdAt - b.createdAt;
  const isToday = (c) => (c.status === 'done' ? (c.due == null || c.due < tomorrow) : c.due != null && c.due < tomorrow);
  return {
    today: shown.filter(isToday).sort(order).map(item),
    later: shown.filter((c) => !isToday(c)).sort(order).map(item),
  };
}

/** Deletes finished (done or dropped) entries from before today. Open ones are never touched. Returns how many went. */
export async function clearFinished(now = Date.now()) {
  const today = startOfDay(now), m = loadMemory(), before = m.commitments.length;
  m.commitments = m.commitments.filter((c) => c.status === 'open' || (c.doneAt ?? c.createdAt) >= today);
  if (m.commitments.length === before) return 0;
  await saveMemory();
  return before - m.commitments.length;
}

/** kind 'reminder': a plain "remind me", done once it has fired. 'commitment' (and older entries without a kind):
 *  something the user said they'd do, open until they finish or drop it. */
/** repeat: a rule parseRepeat understands ('daily', 'weekdays', 'every 2 hours', 'mon,wed,fri' …); it needs a due
 *  time, the first one of the series. A repeating reminder moves on to its next time each time it fires; a repeating
 *  commitment moves on when it's marked done. Dropping either ends the series. */
export async function addCommitment(text, dueMs, kind = 'commitment', repeat = null) {
  const c = { id: newId('c'), text: String(text).trim().slice(0, 200), due: dueMs ?? null, createdAt: Date.now(), status: 'open', remindedAt: null, kind: kind === 'reminder' ? 'reminder' : 'commitment' };
  const r = repeat ? parseRepeat(repeat) : null;
  if (r && c.due != null) {
    c.repeat = r.spec; c.repeatFrom = c.due;
    // "Weekdays at 9" said on a Saturday: the first time is Monday's, not today's.
    if (r.rule.on && !r.rule.on.includes(new Date(c.due).getDay())) c.due = c.repeatFrom = nextOccurrence(r.rule, c.due, c.due);
  }
  loadMemory().commitments.push(c);
  // Cap the file: the oldest finished entries go first; open ones are never dropped.
  const done = memory.commitments.filter((x) => x.status !== 'open');
  if (memory.commitments.length > 200) {
    const drop = new Set(done.sort((a, b) => (a.doneAt ?? a.createdAt) - (b.doneAt ?? b.createdAt)).slice(0, memory.commitments.length - 200).map((x) => x.id));
    memory.commitments = memory.commitments.filter((x) => !drop.has(x.id));
  }
  await saveMemory();
  return c;
}

/** repeat: a new rule, or null to stop repeating (it then stays as a one-off at its current time). Marking a
 *  repeating commitment done moves it on to its next time instead of closing it (`advanced` is set on the result). */
export async function updateCommitment(id, { status, dueMs, repeat, keepSeries = false, now = Date.now() }) {
  const c = loadMemory().commitments.find((x) => x.id === id);
  if (!c) return null;
  // A new time moves a repeating series to it, unless keepSeries: then only this time moves (a snooze), and after it
  // goes off the series carries on at its usual times.
  if (dueMs !== undefined) { c.due = dueMs; c.remindedAt = null; if (c.repeat && !keepSeries) c.repeatFrom = dueMs; }
  if (repeat !== undefined) {
    const r = repeat ? parseRepeat(repeat) : null;
    if (r && c.due != null) { c.repeat = r.spec; c.repeatFrom = c.due; } else { delete c.repeat; delete c.repeatFrom; }
  }
  if (c.repeat && c.due == null) { delete c.repeat; delete c.repeatFrom; } // a series needs a time
  let advanced = false;
  if (status === 'done' && c.repeat && c.status === 'open') advanced = advance(c, now);
  if (advanced) { c.lastDoneAt = now; c.timesDone = (c.timesDone ?? 0) + 1; }
  // Dropping deletes it (the whole series): a copy goes to Recently deleted first, so it can be put back.
  if (status === 'dropped' && c.status !== 'dropped') await toBin('commitment', c.text, { ...c });
  if (status && !advanced) { c.status = status; if (status !== 'open') c.doneAt = now; else delete c.doneAt; }
  await saveMemory();
  return { ...c, advanced };
}

// ---------- sync (sync.mjs) ----------

/** Commitments and facts as stored (a deep copy), plus the text the copy was made from, for applySynced. */
export function syncSnapshot() {
  const m = loadMemory(), basis = JSON.stringify({ commitments: m.commitments, facts: m.facts });
  return { ...JSON.parse(basis), basis, trusted: memoryTrusted, readOnly: memoryReadOnly };
}

/** Replaces commitments and facts with a merged copy, unless memory changed since the snapshot (then false: the next
 *  pass merges again) or this file belongs to a newer app. */
export async function applySynced({ commitments, facts }, basis) {
  const m = loadMemory();
  if (memoryReadOnly || JSON.stringify({ commitments: m.commitments, facts: m.facts }) !== basis) return false;
  m.commitments = commitments; m.facts = facts;
  await saveMemory();
  return true;
}

// ---------- facts (long-term memory about the user) ----------

const FACT_CAP = 150;
export const listFacts = () => loadMemory().facts.slice();
/** The facts in use: replaced ones (kept for the owner to forget) are left out of everything the model sees. */
export const liveFacts = () => loadMemory().facts.filter((f) => !f.supersededBy);

/** Saves a fact; a near-duplicate of an existing one replaces it instead of piling up. */
export async function addFact(text) {
  const t = String(text).trim().replace(/\s+/g, ' ').slice(0, 240);
  const key = t.toLowerCase().replace(/[^a-z0-9 ]/g, '');
  const facts = loadMemory().facts;
  const same = facts.find((f) => f.text.toLowerCase().replace(/[^a-z0-9 ]/g, '') === key);
  // Said again: it's current again, even if a later fact had replaced it.
  if (same) { same.updatedAt = Date.now(); delete same.supersededBy; delete same.supersededAt; await saveMemory(); return same; }
  const f = { id: newId('f'), text: t, createdAt: Date.now() };
  facts.push(f);
  // No cap that deletes: every fact stays until the owner forgets it (pickFacts keeps the prompt small).
  await saveMemory();
  return f;
}

// Picks which facts go into the prompt: the newest few always, then the ones that share words with
// what's being talked about, then the most recently used. Keeps the prompt small as memory grows.
const STOP = new Set('the a an and or but to of in on at for with is are was were be it this that my me i you your his her its our their what how when where why can do does just like about from have has had will would should could not no yes so if then than'.split(' '));
const words = (t) => new Set(String(t).toLowerCase().match(/[a-z0-9]{3,}/g)?.filter((w) => !STOP.has(w)) ?? []);
export function pickFacts(context = '', limit = 40) {
  const facts = loadMemory().facts.filter((f) => !f.supersededBy); // replaced ones are kept, never used
  if (facts.length <= limit) return facts.slice();
  const ctx = words(context), byNew = facts.slice().sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt));
  const chosen = new Set(byNew.slice(0, 8).map((f) => f.id));
  const scored = facts.filter((f) => !chosen.has(f.id)).map((f) => {
    let hit = 0; for (const w of words(f.text)) if (ctx.has(w)) hit++;
    return { f, score: hit * 10 + ((f.usedAt ?? f.updatedAt ?? f.createdAt) / 1e12) };
  }).sort((a, b) => b.score - a.score);
  for (const { f } of scored) { if (chosen.size >= limit) break; chosen.add(f.id); }
  return facts.filter((f) => chosen.has(f.id));
}

/** Marks facts as used (they were in the prompt for a turn), so useful ones stay near the top. */
export function touchFacts(ids) {
  const now = Date.now(), set = new Set(ids);
  for (const f of loadMemory().facts) if (set.has(f.id)) f.usedAt = now;
}

export async function clearFacts() {
  const n = loadMemory().facts.length;
  if (n) await toBin('facts', `${n} thing${n === 1 ? '' : 's'} I remembered`, memory.facts.map((f) => ({ ...f })));
  memory.facts = [];
  await saveMemory();
  return n;
}

/** A newer fact corrects an older one: the old one is kept (only the owner deletes), marked replaced, never used. */
export async function supersedeFact(oldId, newId) {
  const f = loadMemory().facts.find((x) => x.id === oldId);
  if (!f || f.id === newId) return null;
  f.supersededBy = newId; f.supersededAt = Date.now();
  await saveMemory();
  return f;
}

/** What the memory pass learned, saved only with the owner's yes (tenth review R10-7): one question for the batch,
 *  each fact in full and the one it replaces. yes(question) → true or false. Returns the facts saved. */
export async function learnFactsAsked(facts, yes) {
  const list = (Array.isArray(facts) ? facts : []).filter((f) => String(f?.text ?? '').trim());
  if (!list.length) return [];
  const had = new Map(listFacts().map((f) => [f.id, f.text]));
  const line = (f) => `- ${String(f.text).trim()}${f.replaces && had.has(f.replaces) ? ` (instead of "${had.get(f.replaces)}")` : ''}`;
  if (!(await Promise.resolve().then(() => yes(`Remember ${list.length === 1 ? 'this' : `these ${list.length}`}?\n${list.map(line).join('\n')}`)).catch(() => false))) return [];
  const added = [];
  for (const f of list) {
    // A correction is added and the old fact kept, marked replaced: nothing is deleted without the owner's yes.
    const nf = await addFact(f.text);
    if (f.replaces) await supersedeFact(f.replaces, nf.id);
    added.push(nf);
  }
  return added;
}

export async function forgetFact(id) {
  const facts = loadMemory().facts, i = facts.findIndex((f) => f.id === id);
  if (i < 0) return null;
  const [f] = facts.splice(i, 1);
  await toBin('fact', f.text, { ...f });
  await saveMemory();
  return f;
}

// ---------- recently deleted ----------
// Owner: "I should be able to undo deletions and undo past behaviors." Whatever is deleted (a fact, all facts, a
// dropped commitment, a scheduled job, a skill, a connection) and a file write_file overwrote is kept here for
// BIN_DAYS, then let go. Each kind is put back by its own module (onRestore); a skill's folder or an old file's copy
// sits in Data/bin/<id>/ meanwhile. Nothing in it goes to the model unless the owner asks to see or restore it.
const BIN = path.join(DIR, 'bin.json'), BIN_DIR = path.join(DIR, 'bin');
export const BIN_DAYS = 30, BIN_MAX = 200;
const restorers = new Map(), purgers = new Map();
let bin = null;
const loadBin = () => {
  if (bin) return bin;
  const b = readJson(BIN, { backup: true });
  bin = b?.version === 1 && Array.isArray(b.items) ? b : { version: 1, items: [] };
  return bin;
};
const saveBin = () => writeJson(BIN, loadBin(), { backup: true });
/** Where an item's files are kept while it's in the bin. */
export const binFolder = (id) => path.join(BIN_DIR, String(id).replace(/[^a-z0-9]/gi, ''));
/** How a kind is put back: fn(item) → a line saying what came back (throws when it can't). */
export const onRestore = (kind, fn) => restorers.set(kind, fn);
/** What else goes when an item of this kind leaves the bin for good (a connection's saved keys). */
export const onPurge = (kind, fn) => purgers.set(kind, fn);

/** Keeps something deleted so it can be put back. title: what the owner sees; data: all it takes to restore it. */
export async function toBin(kind, title, data, { files = null } = {}) {
  const b = loadBin(), id = `d${randomBytes(4).toString('hex')}`;
  b.items.unshift({ id, kind, title: String(title ?? ''), at: Date.now(), data, ...(files ? { files } : {}) });
  await pruneBin();
  await saveBin();
  return id;
}
/** Lets go of what's older than BIN_DAYS or past BIN_MAX (a connection's keys, a skill's folder go with it). */
export async function pruneBin(now = Date.now()) {
  const b = loadBin(), cut = now - BIN_DAYS * 864e5;
  const gone = b.items.filter((x, i) => x.at < cut || i >= BIN_MAX);
  if (!gone.length) return 0;
  const left = new Set(b.items.filter((x) => !gone.includes(x)).map((x) => x.id));
  for (const x of gone) {
    // A kind whose module isn't loaded yet can't tidy up after itself: kept until it is.
    const purge = purgers.get(x.kind);
    if (x.kind === 'connection' && !purge) { left.add(x.id); continue; }
    try { await purge?.(x); } catch {}
    await fs.rm(binFolder(x.id), { recursive: true, force: true }).catch(() => {});
  }
  b.items = b.items.filter((x) => left.has(x.id));
  await saveBin();
  return gone.length;
}
/** What's in the bin, newest first: { id, kind, title, at } (no contents). */
export const listBin = () => loadBin().items.map(({ id, kind, title, at }) => ({ id, kind, title, at }));
export const getBin = (id) => { const x = loadBin().items.find((i) => i.id === String(id)); return x ? JSON.parse(JSON.stringify(x)) : null; };
/** Puts one item back where it was and takes it out of the bin. → the restorer's line. Throws with a reason. */
export async function restoreFromBin(id) {
  const b = loadBin(), x = b.items.find((i) => i.id === String(id));
  if (!x) throw new Error(`Nothing in Recently deleted has the id ${id}.`);
  const fn = restorers.get(x.kind);
  if (!fn) throw new Error(`I can't put back a ${x.kind} yet.`);
  const said = await fn(JSON.parse(JSON.stringify(x)));
  b.items = b.items.filter((i) => i !== x);
  await saveBin();
  await fs.rm(binFolder(x.id), { recursive: true, force: true }).catch(() => {});
  return said;
}
/** A bin line for the model and the panel: what it was, when it went. */
export const binLine = (x, fmt = (ms) => new Date(ms).toLocaleString()) => `${x.id}  ${BIN_KIND[x.kind] ?? x.kind}: ${x.title} (deleted ${fmt(x.at)})`;
export const binKind = (k) => BIN_KIND[k] ?? k;
const BIN_KIND = { fact: 'Fact', facts: 'Facts', commitment: 'Commitment', job: 'Scheduled job', skill: 'Skill', connection: 'Connection', file: 'File before it was changed' };

// Facts and commitments come back with a new id, so sync doesn't take them for the ones it saw deleted.
onRestore('fact', async ({ data }) => {
  const f = { ...data, id: newId('f'), updatedAt: Date.now() };
  delete f.supersededBy; delete f.supersededAt;
  loadMemory().facts.push(f);
  await saveMemory();
  return `Remembered again: ${f.text}`;
});
onRestore('facts', async ({ data }) => {
  const have = new Set(loadMemory().facts.map((f) => f.text));
  const back = (Array.isArray(data) ? data : []).filter((f) => f?.text && !have.has(f.text)).map((f) => ({ ...f, id: newId('f'), updatedAt: Date.now() }));
  memory.facts.push(...back);
  await saveMemory();
  return `Remembered ${back.length} thing${back.length === 1 ? '' : 's'} again.`;
});
onRestore('commitment', async ({ data }) => {
  const m = loadMemory();
  m.commitments = m.commitments.filter((c) => c.id !== data.id);
  const c = { ...data, id: newId('c'), updatedAt: Date.now() };
  m.commitments.push(c);
  await saveMemory();
  return `Back on the list: ${c.text}`;
});
// A file write_file changed: its old contents go back where they were (what's there now is kept in the bin too).
onRestore('file', async ({ id, data }) => {
  const from = path.join(binFolder(id), 'old');
  if (!existsSync(from)) throw new Error('Its old copy is gone, so it can\'t be put back.');
  if (existsSync(data.path)) await keepOldFile(data.path);
  await fs.mkdir(path.dirname(data.path), { recursive: true });
  await fs.copyFile(from, data.path);
  return `Put back ${data.path} as it was before it was changed.`;
});
/** Keeps a copy of a file about to be overwritten (a regular file up to 25 MB) so the change can be undone. */
export async function keepOldFile(file) {
  const st = await fs.lstat(file).catch(() => null);
  if (!st?.isFile() || st.size > 25 * 2 ** 20) return null;
  const id = await toBin('file', file, { path: file, size: st.size });
  await fs.mkdir(binFolder(id), { recursive: true, mode: 0o700 });
  await fs.copyFile(file, path.join(binFolder(id), 'old'));
  return id;
}

/** Open commitments whose time has come and that haven't been reminded yet. Marks them reminded; plain
 *  reminders are done once they've fired, so they never hang around as overdue. */
export async function takeDueReminders(now = Date.now()) {
  // A repeating commitment left undone past its next time: it moves on to the latest time that has come, and is
  // nudged again (marked `missed`), so skipping Monday's gym doesn't silence Tuesday's.
  const missed = new Set();
  for (const c of openCommitments()) {
    let t = missedAt(c);
    if (t == null || t > now) continue;
    const r = parseRepeat(c.repeat);
    for (let i = 0, n; i < 10_000 && (n = nextOccurrence(r.rule, c.repeatFrom ?? c.due, t)) != null && n <= now; i++) t = n;
    c.due = t; c.remindedAt = null; missed.add(c.id);
  }
  const due = openCommitments().filter((c) => c.due && c.due <= now && !c.remindedAt);
  if (!due.length) return [];
  const fired = due.map((c) => ({ ...c }));
  for (const c of due) {
    c.remindedAt = now;
    // A repeating reminder moves on to its next time; times missed while the computer slept are skipped, not stacked.
    if (c.kind === 'reminder' && c.repeat && advance(c, now)) continue;
    if (c.kind === 'reminder') { c.status = 'done'; c.doneAt = now; }
  }
  await saveMemory();
  return fired.map((c, i) => ({ ...c, missed: missed.has(c.id), next: due[i].repeat && due[i].status === 'open' && due[i].due !== c.due ? due[i].due : null }));
}
