// Where Hydra keeps everything: one visible folder, ~/HydraAgent, with Agents/, Skills/ and Data/ (settings, memory,
// chats, logs, usage, jobs, MCP servers, sync state, catalogs). Not ~/Hydra: that name is often taken (the owner's
// Hydra web app checkout lives there). It used to be ~/Roamies: the first run after the rename copies all of it across
// the same careful way (copy, check, switch), keeps ~/Roamies untouched with a MOVED.txt, and uses ~/Roamies for now
// if anything fails. Sign-in stays in ~/.gg/auth.json (shared with GG Coder).
// Data used to live in ~/.gg/sidekick and ~/.gg/sidekick.json. The first run after the update copies it across,
// checks the copy and only then switches; the old copy is never deleted, and if anything fails this run keeps using it.
// ROAMIES_DATA_DIR (tests and benchmarks) stands in for the home folder, so they exercise the same migration.
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const SKIP = (name) => name === '.DS_Store' || name.endsWith('.tmp') || name === 'MOVED.txt';
const TMP = /^\.Data-(\d+)\.tmp$/;

export const baseDir = (env = process.env) => env.ROAMIES_DATA_DIR || os.homedir();
export const ROOT_NAME = 'HydraAgent', OLD_ROOT_NAME = 'Roamies';
const ROOT_TMP = /^\.HydraAgent-(\d+)\.tmp$/;
/** The folder in use: ~/HydraAgent, or ~/Roamies while it hasn't been moved (an agent process, or a failed move). */
export const roamiesDir = (env = process.env) => dataPaths(env).root;

// The old layout: ~/.gg/sidekick and ~/.gg/sidekick.json, or <ROAMIES_DATA_DIR>/sidekick(.json) in tests.
export const oldBase = (env = process.env) => env.ROAMIES_DATA_DIR || path.join(os.homedir(), '.gg');

/** Every path, new and old: `base` holds HydraAgent/ (or `rootName`), `old` holds the old sidekick/ and sidekick.json. */
export function layout(base, old, rootName = ROOT_NAME) {
  const root = path.join(base, rootName);
  return { root, dir: path.join(root, 'Data'), config: path.join(root, 'Data', 'settings.json'), oldDir: path.join(old, 'sidekick'), oldConfig: path.join(old, 'sidekick.json') };
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

// Files to bring across, as [from, to-relative-to-Data]; models/ is renamed across afterwards instead.
function plan(L) {
  const out = [];
  const walk = (from, rel) => {
    for (const e of readdirSync(from, { withFileTypes: true })) {
      if (SKIP(e.name) || (!rel && e.name === 'models')) continue;
      const src = path.join(from, e.name), dst = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) { out.push([src, dst, true]); walk(src, dst); } else if (e.isFile()) out.push([src, dst, false]);
    }
  };
  if (isDir(L.oldDir)) walk(L.oldDir, '');
  if (existsSync(L.oldConfig)) out.push([L.oldConfig, 'settings.json', false]);
  if (existsSync(`${L.oldConfig}.bak`)) out.push([`${L.oldConfig}.bak`, 'settings.json.bak', false]);
  return out;
}

function copyOne(src, dst) {
  copyFileSync(src, dst);
  chmodSync(dst, 0o600); // the store keeps every data file private
  const st = statSync(src);
  const fd = openSync(dst, 'r+');
  try { fsyncSync(fd); } finally { closeSync(fd); }
  utimesSync(dst, st.atime, st.mtime);
}

const parses = (file) => { try { JSON.parse(readFileSync(file, 'utf8')); return true; } catch { return false; } };

function verify(files, tmp) {
  for (const [src, rel, dir] of files) {
    const dst = path.join(tmp, rel);
    if (dir) { if (!isDir(dst)) throw new Error(`${rel} is missing from the copy`); continue; }
    if (!existsSync(dst) || statSync(dst).size !== statSync(src).size) throw new Error(`${rel} didn't copy whole`);
    if (['memory.json', 'settings.json'].includes(path.basename(rel)) && parses(src) && !parses(dst)) throw new Error(`${rel} doesn't read back`);
  }
}

// The whole ~/Roamies tree, as [from, relative, kind] (kind: 'dir', 'file' or 'link'); Data/models is renamed across
// afterwards instead. A symlink is copied as the same symlink (never followed, never dropped); a socket or fifo (a
// running program's, not data) is left behind with a log line.
function treePlan(from, log = () => {}) {
  const out = [];
  const walk = (dir, rel) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.DS_Store' || ROOT_TMP.test(e.name) || TMP.test(e.name) || (rel === 'Data' && e.name === 'models')) continue;
      const src = path.join(dir, e.name), r = rel ? path.join(rel, e.name) : e.name;
      if (e.isSymbolicLink()) out.push([src, r, 'link']);
      else if (e.isDirectory()) { out.push([src, r, 'dir']); walk(src, r); }
      else if (e.isFile()) out.push([src, r, 'file']);
      else log(`left ${r} behind: not a file, folder or link (a socket or pipe some program made while running)`);
    }
  };
  walk(from, '');
  return out;
}

function verifyTree(files, tmp) {
  for (const [src, rel, kind] of files) {
    const dst = path.join(tmp, rel);
    if (kind === 'link') { if (!lstatSync(dst).isSymbolicLink() || readlinkSync(dst) !== readlinkSync(src)) throw new Error(`${rel} didn't copy as a link`); continue; }
    if (kind === 'dir') { if (!isDir(dst)) throw new Error(`${rel} is missing from the copy`); continue; }
    if (!existsSync(dst) || statSync(dst).size !== statSync(src).size) throw new Error(`${rel} didn't copy whole`);
    if (['memory.json', 'settings.json'].includes(path.basename(rel)) && parses(src) && !parses(dst)) throw new Error(`${rel} doesn't read back`);
  }
}

const digest = (f) => { try { return createHash('sha256').update(readFileSync(f)).digest('hex'); } catch { return null; } };

// Removes a folder even when it holds read-only folders (a copy that got its original modes back).
function forceRm(p) {
  const open = (d) => { try { chmodSync(d, 0o700); for (const e of readdirSync(d, { withFileTypes: true })) if (e.isDirectory() && !e.isSymbolicLink()) open(path.join(d, e.name)); } catch {} };
  open(p);
  rmSync(p, { recursive: true, force: true });
}

// Every regular file and link in a tree (Data/models and MOVED.txt aside), as relative paths.
function treeFiles(root) {
  const out = [];
  const walk = (dir, rel) => {
    for (const e of (() => { try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; } })()) {
      if (e.name === '.DS_Store' || (!rel && e.name === 'MOVED.txt') || (rel === 'Data' && e.name === 'models')) continue;
      const r = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory() && !e.isSymbolicLink()) walk(path.join(dir, e.name), r); else out.push(r);
    }
  };
  walk(root, '');
  return out;
}

// Whether ~/Roamies may hold data ~/HydraAgent doesn't. Marked moved: a file changed after the mark (an older Hydra
// kept running and saving there). Not marked: a file the copy lacks or holds with other contents (sha-256), or a link
// pointing elsewhere; only when every one matches is the old folder marked moved. The whole tree is read.
// Same data and no MOVED.txt (a crash right after the switch): it is marked now, and nothing is reported.
function olderThere(from, to) {
  let moved = null;
  try { moved = statSync(path.join(from, 'MOVED.txt')).mtimeMs; } catch {}
  for (const r of treeFiles(from)) {
    let a, b;
    try { a = lstatSync(path.join(from, r)); } catch { continue; }
    // Marked moved: only a change after the mark counts (the copy is the live one and changes on its own).
    if (moved != null) { if (a.mtimeMs > moved + 1000) return true; continue; }
    // Not marked: the copy must hold every file, the same size.
    try { b = lstatSync(path.join(to, r)); } catch { return true; }
    if (a.isFile() && (!b.isFile() || a.size !== b.size || digest(path.join(from, r)) !== digest(path.join(to, r)))) return true;
    if (a.isSymbolicLink() && (!b.isSymbolicLink() || readlinkSync(path.join(from, r)) !== readlinkSync(path.join(to, r)))) return true;
  }
  if (moved == null) { try { writeFileSync(path.join(from, 'MOVED.txt'), `Hydra now keeps everything in ${to}.\n\nThis folder is the copy from before the move, kept in case you go back to an older version.\nYou can delete it.\n`); } catch {} }
  return false;
}

const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Moves ~/Roamies to ~/HydraAgent once: copy into a temporary folder beside it, check every file, then rename into
 *  place in one step. One process at a time (a lock file); one that finds the move done by another adopts it.
 *  { ok }: ~/HydraAgent is the one to use. { older }: both are there and ~/Roamies was never marked moved (data in it
 *  may be newer than the copy: the panel says where it is). */
const LOCK_STALE_MS = 10 * 60_000;
export function moveRoot({ base = baseDir(), log = (m) => console.error(`[datadir] ${m}`), afterCopy, waitMs = 2_000 } = {}) {
  const from = path.join(base, OLD_ROOT_NAME), to = path.join(base, ROOT_NAME), lock = path.join(base, `.${ROOT_NAME}.lock`);
  if (!isDir(from)) return { ok: true };
  if (existsSync(to)) return { ok: true, older: !existsSync(lock) && olderThere(from, to) };
  // The lock: made new (wx) with this process's id and the time. One older than LOCK_STALE_MS, or whose process is
  // gone, is taken over (a crashed run's, or one whose id was reused). A fresh one from a live process is moving it
  // now: wait a little (never long: this is the app starting), then use ~/Roamies for this launch.
  let fd = null;
  for (let tries = 0; fd == null; tries++) {
    try { fd = openSync(lock, 'wx', 0o600); writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() })); }
    catch (e) {
      if (e.code !== 'EEXIST' || tries > 1) { log(`couldn't lock the move (${e.message}), using ${from} for now`); return { ok: false }; }
      let held = null;
      try { held = JSON.parse(readFileSync(lock, 'utf8')); } catch {}
      const at = Number(held?.at) || (() => { try { return statSync(lock).mtimeMs; } catch { return 0; } })();
      const live = held?.pid && held.pid !== process.pid && alive(Number(held.pid)) && Date.now() - at < LOCK_STALE_MS;
      if (live) {
        for (let t = 0; t < waitMs && existsSync(lock); t += 100) sleepMs(100);
        if (existsSync(to) && !existsSync(lock)) return { ok: true };
        log(`another Hydra is moving ${from}; using it for this launch`);
        return { ok: false };
      }
      rmSync(lock, { force: true }); // stale: a crashed run's, or its process id now belongs to something else
    }
  }
  let tmp = null;
  const modes = [];
  try {
    for (const n of readdirSync(base)) {
      const m = ROOT_TMP.exec(n);
      if (m && (Number(m[1]) === process.pid || !alive(Number(m[1])) || Date.now() - statSync(path.join(base, n)).mtimeMs > LOCK_STALE_MS)) forceRm(path.join(base, n));
    }
    tmp = path.join(base, `.${ROOT_NAME}-${process.pid}.tmp`);
    mkdirSync(tmp, { mode: 0o700 });
    modes.push([tmp, statSync(from).mode & 0o777]);
    const files = treePlan(from, log);
    for (const [src, rel, kind] of files) {
      const dst = path.join(tmp, rel), st = lstatSync(src);
      // Folders and files are made writable while copying; their own modes go back on at the end (read-only ones too).
      if (kind === 'dir') { mkdirSync(dst, { recursive: true, mode: 0o700 }); modes.push([dst, st.mode & 0o777]); continue; }
      if (kind === 'link') { symlinkSync(readlinkSync(src), dst); continue; }
      copyFileSync(src, dst);
      chmodSync(dst, 0o600);
      const fd2 = openSync(dst, 'r+');
      try { fsyncSync(fd2); } finally { closeSync(fd2); }
      utimesSync(dst, st.atime, st.mtime);
      modes.push([dst, st.mode & 0o777]);
    }
    afterCopy?.(tmp);
    verifyTree(files, tmp);
    for (const [p, m] of modes.reverse()) chmodSync(p, m); // deepest first, so a read-only folder is closed last
    try { renameSync(tmp, to); }
    catch (e) {
      // Another process finished first (ENOTEMPTY/EEXIST): its copy is whole, so use it and drop this one.
      if (!['ENOTEMPTY', 'EEXIST'].includes(e.code) || !isDir(to)) throw e;
      log(`${to} was finished by another Hydra; using it`);
    }
    if (existsSync(tmp)) forceRm(tmp);
    tmp = null;
  } catch (e) {
    if (tmp && existsSync(tmp)) forceRm(tmp);
    closeSync(fd); rmSync(lock, { force: true });
    log(`couldn't move ${from} to ${to}, using ${from} for now: ${e.message}`);
    return { ok: false };
  }
  const models = path.join(from, 'Data', 'models');
  if (isDir(models)) {
    try { renameSync(models, path.join(to, 'Data', 'models')); } catch (e) { log(`left the speech model in ${models} (it downloads again if needed): ${e.message}`); }
  }
  try {
    writeFileSync(path.join(from, 'MOVED.txt'), `Hydra now keeps everything in ${to}.\n\nThis folder is the copy from before the move, kept in case you go back to an older version.\nYou can delete it.\n`);
  } catch (e) { log(`couldn't write MOVED.txt: ${e.message}`); }
  closeSync(fd); rmSync(lock, { force: true });
  log(`moved ${from} to ${to}`);
  return { ok: true };
}

/**
 * Moves old data into HydraAgent/Data once: copy to a temporary folder, check it, rename it into place in one step.
 * Returns the paths to use this run; `legacy` means the copy failed and the old location is still in use.
 * `agent` (a background agent's process) never migrates, it follows whatever the main process left.
 * `afterCopy(tmp)` is for tests.
 */
export function migrateData({ base = baseDir(), old = oldBase(), agent = false, log = (m) => console.error(`[datadir] ${m}`), afterCopy } = {}) {
  // An agent never moves anything: it uses ~/HydraAgent if the main process made it, else ~/Roamies if that's there.
  const moved = agent ? { ok: existsSync(path.join(base, ROOT_NAME)) || !isDir(path.join(base, OLD_ROOT_NAME)) } : moveRoot({ base, log });
  const L = layout(base, old, moved.ok ? ROOT_NAME : OLD_ROOT_NAME);
  // older: ~/Roamies is there beside ~/HydraAgent without a MOVED.txt (the panel says older data is in it).
  const paths = { root: L.root, dir: L.dir, config: L.config, legacy: false, migrated: false, older: !!moved.older, oldRoot: path.join(base, OLD_ROOT_NAME) };
  const hasOld = isDir(L.oldDir) || existsSync(L.oldConfig);
  if (existsSync(L.dir) || !hasOld) return paths;
  const legacy = { ...paths, dir: L.oldDir, config: L.oldConfig, legacy: true };
  if (agent) return legacy;
  let tmp = null;
  try {
    mkdirSync(L.root, { recursive: true });
    for (const n of readdirSync(L.root)) {
      const m = TMP.exec(n);
      if (m && (Number(m[1]) === process.pid || !alive(Number(m[1])))) rmSync(path.join(L.root, n), { recursive: true, force: true });
    }
    tmp = path.join(L.root, `.Data-${process.pid}.tmp`);
    mkdirSync(tmp, { mode: 0o700 });
    const files = plan(L);
    for (const [src, rel, dir] of files) {
      const dst = path.join(tmp, rel);
      if (dir) mkdirSync(dst, { recursive: true, mode: 0o700 }); else copyOne(src, dst);
    }
    afterCopy?.(tmp);
    verify(files, tmp);
    renameSync(tmp, L.dir);
    tmp = null;
  } catch (e) {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    log(`couldn't move data to ${L.dir}, using ${L.oldDir} for now: ${e.message}`);
    return legacy;
  }
  const models = path.join(L.oldDir, 'models');
  if (isDir(models)) {
    try { renameSync(models, path.join(L.dir, 'models')); } catch (e) { log(`left the speech model in ${models} (it downloads again if needed): ${e.message}`); }
  }
  if (isDir(L.oldDir)) {
    try {
      writeFileSync(path.join(L.oldDir, 'MOVED.txt'), `Hydra now keeps its data in ${L.dir}\n(settings are ${L.config}).\n\nThis folder and ${L.oldConfig} are the copy from before the move,\nkept in case you go back to an older version. You can delete them.\n`);
    } catch (e) { log(`couldn't write MOVED.txt: ${e.message}`); }
  }
  log(`moved data to ${L.dir}`);
  return { ...paths, migrated: true };
}

const cache = new Map();
/** Paths for the current home (or ROAMIES_DATA_DIR), migrating on first use; resolved once per folder. */
export function dataPaths(env = process.env) {
  const base = baseDir(env);
  if (!cache.has(base)) cache.set(base, migrateData({ base, old: oldBase(env), agent: !!env.ROAMIES_AGENT }));
  return cache.get(base);
}

const here = dataPaths();
export const ROAMIES_DIR = here.root;
/** ~/Roamies when it sits beside ~/HydraAgent without having been marked moved (older data may be in it), else null. */
export const OLDER_DATA = here.older ? here.oldRoot : null;
export const DATA_DIR = here.dir;
export const CONFIG_PATH = here.config;
