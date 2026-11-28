// Drawings go to Hydra's Notes page (owner, 2026-11-26: "they should be stored on the notes page"). One note per
// request that drew: every draw call of it, every mark, in order. Cards with words become text; every other card,
// and the marks drawn on the screen, become pictures the overlay made of Hydra's own marks (ink.js drawImage, never a
// capture of the screen). Each request is a folder on disk (note.json and its PNGs) until Hydra has it, so nothing is
// lost offline, unpaired or across a restart: a failure keeps it and is logged, never dropped in silence.
// This module only gets the Hydra API, a folder, a log and a clock.
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CARDS, SCREEN, partWords } from './draw.mjs';

const MIN = 60_000;
export const CLOSE_AFTER = 5 * MIN; // a request's pictures never all came: sent this long after the last was heard, words for them
// A drawing can play on long after its request ended (a deep explanation's pages, a long voiced one): each picture and
// beat heard keeps its note open (CLOSE_AFTER more), up to this long after the request ended. A request whose end
// was never heard is closed this long after its last drawing or picture.
export const HARD_CAP = 30 * MIN;
const REF_DAYS = 7 * 24 * 60 * MIN; // an uploaded picture older than this is sent again first (Hydra sweeps unused ones after 30 days)
const MAX_RECORDS = 200, MAX_BYTES = 200 * 1024 * 1024, KEEP_FAILED = 20; // ponytail: fixed cap; raise if a real queue hits it.
export const IMAGE_MAX = 4_000_000;
const RETRY_MAX = 5 * MIN;
const HOLD_MAX = 15 * MIN; // the longest Retry-After waited for
const STUCK = 3; // a note Hydra failed this many times in a row (5xx) no longer holds up the newer ones
const AUTH_AGAIN = 30_000; // a first 401 (Hydra's owner session renewing) is tried again this soon, once
// A picture is never given up on for a retry status (offline, 404 before Hydra's route is there, 429, 5xx): it stays
// queued with its PNG until Hydra takes it, or the queue is full (then failed/, PNGs and all).
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_MIN = 67; // the smallest whole PNG: signature, IHDR, one IDAT, IEND
const REF = /^hydra-media:\/\/notes\/drawn\/[0-9a-f]{32}\.png$/;
const TEXT_KINDS = new Set(['note', 'card', 'clip', 'list']);

const cut = (s, n) => String(s ?? '').slice(0, n);
const lines = (s) => cut(s, 20_000).split('\n').map((l) => l.trim()).filter(Boolean);
const inline = (text) => [{ type: 'text', text: cut(text, 20_000), styles: {} }];
const para = (text) => ({ type: 'paragraph', content: inline(text) });
const heading = (text) => ({ type: 'heading', props: { level: 3 }, content: inline(text) });
const bullet = (text) => ({ type: 'bulletListItem', content: inline(text) });
const check = (text) => ({ type: 'checkListItem', props: { checked: false }, content: inline(text) });

/** What is kept of a drawn mark: its kind, part and words (never a photo's pixels or a place on screen). */
export function slimMark(m) {
  const o = { kind: String(m?.kind ?? ''), part: m?.part ? String(m.part) : null, words: cut(partWords(m ?? {}), 300) };
  for (const k of ['title', 'heading', 'label', 'text']) if (m?.[k] != null) o[k] = cut(m[k], 20_000);
  if (Array.isArray(m?.items)) o.items = m.items.slice(0, 100).map((x) => cut(x, 2000));
  if (Array.isArray(m?.sources)) o.sources = m.sources.slice(0, 30).map((x) => ({ name: cut(x?.name, 200), url: cut(x?.url, 2000) }));
  return o;
}

// The note's blocks before pictures are known: text blocks, and { slot, kind, words } where a picture goes.
function layout(r) {
  const out = [], skip = new Set(r.skipped ?? []);
  for (const seg of r.segs) {
    let screen = false;
    for (const b of seg.beats) {
      if (b.caption) out.push(para(b.caption));
      for (const m of b.marks) {
        if (m.part && skip.has(m.part)) continue;
        if (SCREEN.includes(m.kind)) { screen = true; continue; }
        if (!CARDS.includes(m.kind)) continue; // actions (emote, copy, open …) are not saved
        if (m.kind === 'note') out.push(...lines(m.text).map(para));
        else if (m.kind === 'card') {
          const h = m.heading || m.title;
          if (h) out.push(heading(cut(h, 300)));
          out.push(...lines(m.text).map(para), ...(m.items ?? []).map(bullet), ...(m.sources ?? []).map((s) => bullet(`${s.name} (${s.url})`)));
        } else if (m.kind === 'clip') {
          if (m.title) out.push(heading(cut(m.title, 300)));
          out.push(...lines(m.text).map(para));
        } else if (m.kind === 'list') {
          // ponytail: the list as drawn (a snapshot); ticks and items added on the card later don't reach the note.
          // Sync them with a PATCH once Hydra has a device route to edit a note.
          if (m.title) out.push(heading(cut(m.title, 300)));
          out.push(...(m.items ?? []).map(check));
        } else out.push({ slot: m.part, kind: m.kind, name: `${m.kind}.png`, caption: m.words });
      }
    }
    if (screen) out.push({ slot: `${seg.id}:marks`, kind: 'marks', name: 'marks.png', caption: 'Marks on screen' });
  }
  return out;
}
const slotsOf = (items) => items.filter((x) => x.slot).slice(0, 100).map((x) => x.slot);

/** The note's title: the first card's title, heading or label; else the first line said; else their words; else Drawing. */
export function drawingTitle(r) {
  const marks = r.segs.flatMap((s) => s.beats.flatMap((b) => b.marks)).filter((m) => CARDS.includes(m.kind));
  const t = marks.map((m) => m.title || m.heading || m.label).find(Boolean) || r.segs.flatMap((s) => s.beats).map((b) => b.caption).find(Boolean) || r.words || 'Drawing';
  return String(t).replace(/\s+/g, ' ').trim().slice(0, 120) || 'Drawing';
}

/** The note's doc (Notes editor blocks): a picture with its uploaded ref, or [kind: words] where it has none. */
export function drawingDoc(r) {
  const n = new Set(slotsOf(layout(r)));
  return layout(r).map((x) => {
    if (!x.slot) return x;
    const ref = n.has(x.slot) ? r.images?.[x.slot]?.ref : null;
    if (ref) return { type: 'image', props: { url: ref, name: x.name, caption: x.caption } };
    return para(`[${x.kind}${x.caption ? `: ${x.caption}` : ''}]`);
  });
}
// Worth a note: a card or a picture. Only lines said and actions (copy, open …): nothing was drawn to keep.
const worthSaving = (r) => layout(r).some((x) => x.slot) || r.segs.some((s) => s.beats.some((b) => b.marks.some((m) => TEXT_KINDS.has(m.kind) && !(r.skipped ?? []).includes(m.part))));

/**
 * The queue. api: hydraApi (req). pairing(): the current pairing binding or null. dir: its folder (0700; files 0600).
 * log(data): one notes_sync line. now: the clock.
 * timer(f, ms): a retry or a request's close later. onSaved({ parts, noteId }), onPending({ parts }), onDropped({ parts }):
 * for the overlay (dropped: Hydra refused it for good, it will never be saved).
 */
export function createNoteSync({ api, dir, pairing = () => null, log = () => {}, now = Date.now, timer = (f, ms) => setTimeout(f, ms).unref?.(), onSaved = () => {}, onPending = () => {}, onDropped = () => {} }) {
  const failedDir = path.join(dir, 'failed');
  const recs = new Map(); // folder name → record
  // Records made in this run: only theirs reach the overlay (onSaved, onPending). Part ids (p1 …) start again each run,
  // so an old record's p1 is not the p1 on screen now.
  const mine = new Set();
  let backoff = 0, retry = null, holdUntil = 0, authAgain = false, lastPair = null, chain = Promise.resolve();
  const mkdir = (d) => { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); fs.chmodSync(d, 0o700); };
  const write = (file, data) => { const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, data, { mode: 0o600 }); fs.renameSync(tmp, file); };
  const folder = (r) => path.join(dir, r.clientId.slice('desktop:'.length));
  const save = (r) => { mkdir(folder(r)); write(path.join(folder(r), 'note.json'), JSON.stringify(r)); };
  const remove = (r) => { recs.delete(path.basename(folder(r))); fs.rmSync(folder(r), { recursive: true, force: true }); };
  const partsOf = (r) => [...new Set(r.segs.flatMap((s) => s.beats.flatMap((b) => b.marks.map((m) => m.part))).filter((p) => p && !(r.skipped ?? []).includes(p)))];
  function toFailed(r, why) {
    mkdir(failedDir);
    recs.delete(path.basename(folder(r)));
    try { fs.renameSync(folder(r), path.join(failedDir, path.basename(folder(r)))); }
    catch { log({ quarantine: 'move_failed', id: r.clientId }); }
    log({ dropped: why, id: r.clientId });
    if (mine.has(r.clientId)) onDropped({ parts: partsOf(r) });
    const old = fs.readdirSync(failedDir).map((f) => ({ f, t: fs.statSync(path.join(failedDir, f)).mtimeMs })).sort((a, b) => b.t - a.t).slice(KEEP_FAILED);
    for (const { f } of old) fs.rmSync(path.join(failedDir, f), { recursive: true, force: true });
  }
  const oldestFirst = () => [...recs.values()].sort((a, b) => a.created - b.created || a.seq - b.seq);
  function trim() {
    const size = (r) => { try { return fs.readdirSync(folder(r)).reduce((n, f) => n + fs.statSync(path.join(folder(r), f)).size, 0); } catch { return 0; } };
    let list = oldestFirst(), bytes = list.reduce((n, r) => n + size(r), 0);
    while (list.length > MAX_RECORDS || (bytes > MAX_BYTES && list.length > 1)) { const r = list.shift(); bytes -= size(r); toFailed(r, 'full'); }
  }

  // What was left on disk: a request still open when the app quit is closed now, and sent.
  mkdir(dir);
  let seq = 0;
  for (const f of fs.readdirSync(dir)) {
    if (f === 'failed') continue;
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, f, 'note.json'), 'utf8'));
      if (!/^[0-9a-f-]{36}$/.test(f) || r?.clientId !== `desktop:${f}` || !Array.isArray(r.segs)) continue;
      if (!/^[0-9a-f]{64}$/.test(r.pairBinding ?? '')) { toFailed(r, 'pair_unbound'); continue; }
      recs.set(f, r); seq = Math.max(seq, r.seq ?? 0);
      if (r.open) { r.open = false; save(r); }
    } catch { /* not a record */ }
  }

  // A draw id can come again (Claude Code's gg_call_N and the parts p1 … start over each run): pictures only ever go
  // to an open record, the newest first, never to an older one still queued.
  const byDraw = (id) => oldestFirst().reverse().find((r) => r.open && r.segs.some((s) => s.id === id));
  // Heard from: its note stays open CLOSE_AFTER more (within HARD_CAP of the request's end).
  const heard = (r) => { r.lastAt = now(); timer(close, CLOSE_AFTER + 1000); };
  /**
   * A draw call's marks ({ id, turn, beats: [{ caption, marks }], words }): its request's record, opened now. turn is
   * the request's own number: requests run side by side (a relay turn and one at the Mac), and only turnEnded(turn)
   * (or HARD_CAP) ends a request's note, never another request's drawing.
   */
  function drawn({ id, turn, beats, words = '', pairBinding = pairing() }) {
    id = String(id);
    let r = [...recs.values()].find((x) => x.open && x.turn === turn && x.pairBinding === pairBinding);
    if (!r) {
      r = { clientId: `desktop:${randomUUID()}`, pairBinding, seq: ++seq, turn, created: now(), open: true, endedAt: null, words: cut(words, 300), segs: [], draws: {}, images: {}, skipped: [] };
      recs.set(path.basename(folder(r)), r); mine.add(r.clientId);
      timer(close, HARD_CAP + 1000);
    }
    r.lastAt = now();
    const seg = r.segs.find((s) => s.id === id) ?? (r.segs.push({ id, beats: [] }), r.segs.at(-1));
    seg.beats.push(...(beats ?? []).map((b) => ({ caption: cut(b?.caption, 2000), marks: (b?.marks ?? []).map(slimMark) })));
    r.draws[id] ??= false;
    save(r); trim(); close();
  }
  /** A picture from the overlay: { id, part ('marks' for the screen marks), data (base64 PNG) | error }. */
  function image({ id, part, data, error }) {
    const r = byDraw(String(id));
    if (!r) return;
    const slot = part === 'marks' ? `${id}:marks` : String(part);
    if (!slotsOf(layout(r)).includes(slot)) return; // a text card's words are the note: its picture isn't kept
    const buf = error ? null : Buffer.from(String(data ?? ''), 'base64');
    heard(r);
    if (!buf || buf.length < PNG_MIN || buf.length > IMAGE_MAX || !buf.subarray(0, 8).equals(PNG)) { r.images[slot] = { error: cut(error || 'bad_image', 40) }; save(r); return; }
    const file = `${createHash('sha256').update(slot).digest('hex').slice(0, 16)}.png`;
    mkdir(folder(r)); write(path.join(folder(r), file), buf);
    r.images[slot] = { file }; save(r);
  }
  /** The overlay sent every picture of a draw call; skipped: parts it never drew (a stop came first). */
  function imagesDone(id, skipped = []) {
    const r = byDraw(String(id));
    if (!r) return;
    r.draws[String(id)] = true; r.lastAt = now();
    r.skipped = [...new Set([...(r.skipped ?? []), ...(Array.isArray(skipped) ? skipped.map(String) : [])])];
    save(r); close();
  }
  function turnEnded(turn) {
    let ours = false;
    for (const r of recs.values()) if (r.open && r.turn === turn && r.endedAt == null) { r.endedAt = now(); save(r); ours = true; }
    if (!ours) return;
    close();
    timer(close, CLOSE_AFTER + 1000);
    timer(close, HARD_CAP + 1000);
  }
  /** The overlay started afresh (its window rebuilt): pictures it owed will never come, so no note waits for them. */
  function lost() { for (const r of recs.values()) if (r.open) for (const id of Object.keys(r.draws)) r.draws[id] = true; close(); }
  /** The overlay is still playing draw call id (a beat started): its note waits for it. */
  function playing(id) { const r = byDraw(String(id)); if (r) heard(r); }
  // A request is closed (ready to send) once it has ended and every picture came; or CLOSE_AFTER after the last thing
  // heard from it (its end, a picture, a beat), at most HARD_CAP after its end; or, its end never heard, HARD_CAP
  // after the last thing heard.
  function ripen() {
    let any = false;
    for (const r of [...recs.values()]) {
      if (!r.open) continue;
      const quiet = now() - Math.max(r.endedAt ?? 0, r.lastAt ?? r.created);
      const ready = r.endedAt == null ? quiet >= HARD_CAP : Object.values(r.draws).every(Boolean) || quiet >= CLOSE_AFTER || now() - r.endedAt >= HARD_CAP;
      if (!ready) continue;
      r.open = false;
      if (!worthSaving(r)) { remove(r); log({ skipped: 'empty' }); continue; }
      save(r); any = true;
      if (r.pairBinding && r.pairBinding === pairing() && mine.has(r.clientId)) onPending({ parts: partsOf(r) });
    }
    return any;
  }
  const close = () => { if (ripen()) flush(); };

  // How long Hydra asks to wait (Retry-After: seconds or a date), or 0.
  const waitOf = (res) => {
    const h = res?.headers?.get?.('retry-after');
    const n = Number(h), ms = !h ? 0 : Number.isFinite(n) ? n * 1000 : Date.parse(h) - Date.now();
    return Number.isFinite(ms) && ms > 0 ? Math.min(ms, HOLD_MAX) : 0;
  };
  const statusOf = async (call) => {
    try { const res = await call(); return { status: res.status, wait: waitOf(res), body: await res.json().catch(() => ({})) }; }
    catch (e) { return { status: ['unpaired', 'pair_changed'].includes(e?.code) ? e.code : 'offline', wait: 0, body: {} }; }
  };
  const classify = (s) => (s === 200 || s === 201 ? 'ok' : s === 401 || s === 403 || s === 'unpaired' ? 'auth' : s === 400 || s === 409 || s === 413 ? 'drop' : 'retry');
  const boundRequest = async (r, endpoint, options) => {
    const current = pairing();
    if (!current) return { status: 'unpaired' };
    if (current !== r.pairBinding) return { status: 'pair_changed' };
    const response = await statusOf(() => api.req(endpoint, { ...options, pairBinding: r.pairBinding }));
    const after = pairing();
    return after && after !== r.pairBinding ? { status: 'pair_changed' } : response;
  };
  // One request to Hydra: its pictures, then the note. 'ok', or why it stopped ('retry', 'auth', 'drop'); media: it
  // stopped at a picture.
  async function send(r) {
    const slots = slotsOf(layout(r));
    for (const slot of slots) {
      const img = r.images[slot];
      if (!img?.file || img.error || (img.ref && now() - img.refAt < REF_DAYS)) continue;
      let buf;
      try { buf = fs.readFileSync(path.join(folder(r), img.file)); } catch { img.error = 'missing'; save(r); continue; }
      // Its upload number (Hydra's path is made from it) is its own for good, so two pictures never share a path when
      // the slots shift. Sent again after REF_DAYS: a new number, a new path (the sweep counts from a path's first write).
      if (img.n == null || (img.ref && img.nFor !== img.ref)) { r.nextN ??= 0; if (r.nextN <= 99) { img.n = r.nextN++; img.nFor = img.ref ?? null; } else if (img.n == null) { img.error = 'slots'; save(r); continue; } }
      const { status, wait, body } = await boundRequest(r, `/api/agent/notes/media?client_id=${encodeURIComponent(r.clientId)}&n=${img.n}`, { method: 'POST', raw: buf, contentType: 'image/png', timeout: 60_000 });
      if (status === 'pair_changed') { toFailed(r, status); return { k: 'drop' }; }
      const k = classify(status);
      if (k === 'ok' && REF.test(String(body?.ref))) { img.ref = body.ref; img.refAt = now(); save(r); continue; }
      // Refused for good (400, 413, or an answer with no ref): its words go in its place. A retry status keeps it.
      if (k === 'ok' || k === 'drop') { img.error = String(status); save(r); log({ image: status, id: r.clientId }); continue; }
      save(r);
      return { k, status, wait, media: true };
    }
    const { status, wait, body } = await boundRequest(r, '/api/agent/notes', { method: 'POST', body: { title: drawingTitle(r), doc: drawingDoc(r), source: 'desktop', client_id: r.clientId }, timeout: 30_000 });
    if (status === 'pair_changed') { toFailed(r, status); return { k: 'drop' }; }
    const k = classify(status);
    if (k === 'ok') {
      remove(r);
      log({ ok: true, created: status === 201 });
      const noteId = typeof body?.note?.id === 'string' ? body.note.id : null;
      if (r.pairBinding === pairing() && mine.has(r.clientId)) onSaved({ parts: partsOf(r), noteId });
    } else if (k === 'drop') toFailed(r, status);
    return { k, status, wait };
  }
  // Offline, busy (429) or Hydra failing on a note (5xx): the rest would fail the same way, so the flush stops there
  // and waits (Retry-After when Hydra gives one). Only a picture's route failing (404 before it is there, a Storage
  // 502) holds just that record: the next one may be words only, and goes.
  async function flushOnce() {
    ripen();
    const current = pairing();
    for (const r of oldestFirst()) {
      if (!r.pairBinding && !r.open) toFailed(r, 'pair_unbound');
      else if (r.pairBinding && current && r.pairBinding !== current) toFailed(r, 'pair_changed');
    }
    if (!current) return;
    if (lastPair !== current) {
      lastPair = current;
      backoff = holdUntil = 0;
      authAgain = false;
      retry = null;
    }
    if (now() < holdUntil) return arm(holdUntil - now());
    let again = false, wait = 0;
    for (const r of oldestFirst()) {
      if (r.open || !recs.has(path.basename(folder(r)))) continue;
      const res = await send(r);
      if (res.k === 'ok' || res.k === 'drop') { authAgain = false; if (r.fails) r.fails = 0; continue; }
      // Sent again when paired (hydraOnline). A first 401 may be Hydra renewing the owner's session (review r3): one
      // more try soon, then it waits for pairing.
      if (res.k === 'auth') { log({ auth: res.status }); if (res.status === 401 && !authAgain) { authAgain = true; arm(AUTH_AGAIN); } return; }
      log({ retry: res.status, id: r.clientId });
      again = true; wait = Math.max(wait, res.wait ?? 0);
      // A note Hydra keeps failing (a 5xx for this one doc) stops holding up the newer ones after STUCK tries in a
      // row (review r3); it is still tried first each time.
      const stuck = !res.media && typeof res.status === 'number' && res.status >= 500 && recs.has(path.basename(folder(r))) && (r.fails = (r.fails ?? 0) + 1, save(r), r.fails >= STUCK);
      if (res.status === 'offline' || res.status === 429 || (!res.media && !stuck)) break;
    }
    if (!again) { backoff = 0; return; }
    backoff = Math.min(backoff ? backoff * 2 : 2000, RETRY_MAX);
    if (wait) holdUntil = now() + wait;
    arm(Math.max(backoff, wait));
  }
  function arm(ms) {
    if (retry) return;
    const scheduled = retry = {};
    timer(() => {
      if (retry !== scheduled) return;
      retry = null;
      flush();
    }, ms);
  }
  /** Sends every closed request, oldest first, one flush at a time. */
  function flush() {
    chain = chain.then(flushOnce).catch((e) => log({ error: String(e?.message ?? e).slice(0, 120) }));
    return chain;
  }
  return { drawn, image, imagesDone, playing, turnEnded, lost, flush, get pending() { return recs.size; } };
}
