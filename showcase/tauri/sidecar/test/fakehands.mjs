// A fake hands helper for tests: sends what hands/main.swift (or, with win: true, hands-win main.rs) sends, command by
// command, from a state file the test writes. Never touches the Mac: it only reads that file and appends to a log.
// In a test: const fake = fakeHands(dir); then fake.set({ wins, frontPid, hidden, running, win, act }), fake.calls().
// running: the regular apps running, in order (default: every window's app), each a name or { app, pid } (a name's pid:
// that of a window of its app not taken by an earlier one); hidden: apps running with no window on screen (hands-win:
// minimised). Bringing one forward is logged as ['UNHIDE', app], an app managed as ['MANAGE', do, app].
// Run as the helper itself (ROAMIES_HANDS points here): node fakehands.mjs <command> <args…>.
// A window: { id, pid, app, exe?, title, doc?, url?, text (lines), bounds?, listed? (false: a panel above layer 0 or
// 80x60 and smaller, which 'windows' and find-text leave out but the screen's pixels show) }.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);

/** Points the sidecar at this fake (ROAMIES_HANDS) with its state and log in dir. */
export function fakeHands(dir) {
  const state = path.join(dir, 'fakehands-state.json'), log = path.join(dir, 'fakehands-calls.jsonl');
  process.env.ROAMIES_HANDS = SELF;
  process.env.FAKEHANDS_STATE = state;
  process.env.FAKEHANDS_LOG = log;
  fs.writeFileSync(log, '');
  return {
    set: (st) => fs.writeFileSync(state, JSON.stringify(st)),
    get: () => JSON.parse(fs.readFileSync(state, 'utf8')),
    clear: () => fs.writeFileSync(log, ''),
    calls: () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)),
  };
}

if (process.argv[1] === SELF) main(process.argv.slice(2));

function main(a) {
  const log = (x) => fs.appendFileSync(process.env.FAKEHANDS_LOG, JSON.stringify(x) + '\n');
  log(a);
  const file = process.env.FAKEHANDS_STATE, st = JSON.parse(fs.readFileSync(file, 'utf8'));
  // win: as hands-win sends (on a Windows host by default).
  const win = st.win ?? process.platform === 'win32', hidden = new Set(st.hidden ?? []);
  const done = (o) => { console.log(JSON.stringify(o)); process.exit(0); };
  const fail = (e) => done({ ok: false, error: e });
  const B = (w) => w.bounds ?? [0, 0, 800, 600];
  // windows(): on-screen windows at layer 0 bigger than 80x60, front to back, never a hidden app's.
  const onScreen = st.wins.filter((w) => !hidden.has(w.app));
  const listed = onScreen.filter((w) => w.listed !== false);
  const lines = (w) => String(w.text ?? '').split('\n');
  const BROWSERS = ['Brave Browser', 'Google Chrome', 'Safari', 'Arc', 'Firefox', 'Microsoft Edge', 'Opera', 'Vivaldi', 'Chromium', 'Orion', 'Zen'];
  const BROWSER_EXES = ['chrome', 'msedge', 'brave', 'firefox', 'opera', 'vivaldi', 'chromium', 'arc', 'zen', 'librewolf', 'waterfox', 'floorp', 'thorium'];
  // hands-win's exe: the program's file name without .exe (win.rs proc_names).
  const exe = (w) => String(w.exe ?? w.app.toLowerCase()).replace(/\.exe$/i, '');
  // Swift's String (main.swift): compared Character by Character (grapheme clusters, each up to canonical equivalence),
  // so "Finder‍ Mail" doesn't contain "finder" (r and the joiner are one Character); lowercased scalar by scalar
  // (no final-sigma rule); trimmed of .whitespaces (Zs, tab and U+200B: Apple's set still holds it, main.swift's
  // self-test checks it); "x".contains("") is false.
  const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const chars = (s) => [...seg.segment(String(s))].map((g) => g.segment.normalize('NFC'));
  const sEq = (a, b) => { const x = chars(a), y = chars(b); return x.length === y.length && x.every((c, i) => c === y[i]); };
  const sHas = (a, b) => { const x = chars(a), y = chars(b); for (let i = 0; y.length && i + y.length <= x.length; i++) if (y.every((c, j) => c === x[i + j])) return true; return false; };
  const sLow = (s) => [...String(s)].map((c) => c.toLowerCase()).join('');
  const sTrim = (s) => s.replace(/^[\p{Zs}\t\u200B]+|[\p{Zs}\t\u200B]+$/gu, '');
  // main.swift appMatches(app, want), word for word.
  const macMatches = (app, want) => {
    const w = sTrim(sLow(want));
    if (['browser', 'web browser', 'my browser'].some((b) => sEq(b, w))) return BROWSERS.some((b) => sEq(b, app));
    const x = sLow(app);
    return sEq(x, w) || sHas(x, w) || sHas(w, x);
  };
  // appMatches (main.swift: its browser names) / app_matches (logic.rs: the exe too, '.exe' off what's asked, 'browser'
  // by exe).
  const matches = (w, want) => {
    if (!win) return macMatches(w.app, want);
    // Rust's str::trim: White_Space (U+0085 too, never U+FEFF), not JS trim (E0-3).
    const x = want.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '').toLowerCase().replace(/\.exe$/, '');
    if (!x) return false;
    if (['browser', 'web browser', 'my browser'].includes(x)) return BROWSER_EXES.includes(exe(w).toLowerCase());
    return [w.app, exe(w)].map((n) => n.toLowerCase()).some((n) => n && (n === x || n.includes(x) || x.includes(n)));
  };
  // main.swift pickRunning over the regular apps running (exact: that very name only); hands-win: the first minimised
  // window's app that app_matches.
  const taken = new Set();
  const procs = (st.running ?? [...new Set(st.wins.map((w) => w.app))]).map((r) => {
    if (typeof r !== 'string') return r;
    const w = st.wins.find((x) => x.app === r && !taken.has(x.pid));
    if (w) taken.add(w.pid);
    return { app: r, pid: w?.pid };
  });
  const pickProc = (want, exact = false) => (exact ? procs.find((p) => sEq(p.app, want))
    : procs.find((p) => sEq(sLow(p.app), sTrim(sLow(want)))) ?? procs.find((p) => macMatches(p.app, want))) ?? null;
  const pickRunning = (want, exact = false) => pickProc(want, exact)?.app ?? null;
  // main.swift reads a spec with JSONSerialization, which drops one leading U+FEFF from each string; hands-win's serde
  // keeps it (E0-3).
  const spec = (s) => JSON.parse(s, win ? undefined : (k, v) => (typeof v === 'string' && v[0] === '\uFEFF' ? v.slice(1) : v));
  const pick = (want) => (win ? st.wins.find((x) => hidden.has(x.app) && matches(x, want))?.app ?? null : pickRunning(want));
  // ROAMIES_FORWARD: the app said yes to (main.swift mayBringForward, logic.rs may_bring_forward).
  const forward = process.env.ROAMIES_FORWARD || '';
  const info = (w) => ({ id: w.id, app: w.app, title: w.title, bounds: B(w) });
  // winShows: the file (AXDocument) and, unless url: false, a browser's address. hands-win: win_info only.
  const shows = (w, url = true) => (win ? info(w) : { ...info(w), ...(w.doc ? { document: w.doc } : {}), ...(url && w.url ? { url: w.url } : {}) });
  const mainWindow = (ws) => ws[0] ?? null;
  // resolveWin: 'app:X' with no window on screen brings the running app it picks forward (UNHIDE logged) and looks
  // again, only when that app is the one in ROAMIES_FORWARD; else no window. Once a run at most (main.swift
  // takeForward, win.rs TAKEN): once it's forward, the rest of the run finds its window.
  const resolve = (t) => {
    if (t === 'front') return mainWindow(listed.filter((w) => w.pid === st.frontPid)) ?? listed[0] ?? null;
    if (t.startsWith('window:')) return listed.find((w) => w.id === +t.slice(7)) ?? null;
    if (!t.startsWith('app:')) return null;
    const name = t.slice(4), w = mainWindow(listed.filter((x) => matches(x, name)));
    if (w) return w;
    const app = pick(name);
    if (!app || !(win ? app === forward : sEq(app, forward))) return null;
    log(['UNHIDE', app]);
    const back = st.wins.filter((x) => x.app === app && hidden.has(x.app));
    hidden.delete(app);
    onScreen.unshift(...back); listed.unshift(...back.filter((x) => x.listed !== false));
    fs.writeFileSync(file, JSON.stringify({ ...st, hidden: [...hidden] }));
    return back[0] ?? null;
  };
  const noWindow = (t) => `No matching window is open${t.startsWith('app:') ? ` for ${t.slice(4)}` : ''}.`;
  const score = (low, q) => (low === q ? 0 : new RegExp(`(?<![\\p{L}\\p{N}_./:@\\\\])${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])`, 'u').test(low) ? 1 : 2);
  const ocrLine = (w, s, q) => { const i = lines(w).indexOf(s), [x, y] = B(w); return { text: s, role: 'text', bounds: [x + 10 + s.toLowerCase().indexOf(q.toLowerCase()) * 7, y + 30 + i * 20, q.length * 7, 14] }; };
  switch (a[0]) {
    case 'windows': {
      // main.swift: 30 unless 'all' (then every one, and says so); hands-win: take(30), the exe, never 'all'.
      const every = !win && a[1] === 'all';
      done({ ok: true, ...(win ? {} : { all: every }), windows: (every ? listed : listed.slice(0, 30)).map((w) => ({ ...shows(w, false), ...(win ? { exe: exe(w) } : {}), ...(w.pid === st.frontPid ? { frontApp: true } : {}) })) });
    }
    case 'front': {
      if (win) {
        const w = resolve('front');
        if (!w) done({ ok: true });
        done({ ok: true, app: w.app, exe: exe(w), ...(w.title ? { title: w.title } : {}), ...(w.url ? { url: w.url } : {}) });
      }
      // main.swift: the front app (frontPid) even with no window on screen, its pid too; the first window's app only
      // when none is known in front (E0-3).
      const pid = st.frontPid ?? listed[0]?.pid, w = mainWindow(listed.filter((x) => x.pid === pid));
      const app = w?.app ?? procs.find((p) => p.pid === pid)?.app ?? st.wins.find((x) => x.pid === pid)?.app;
      if (pid == null || !app) done({ ok: true });
      done({ ok: true, app, pid, ...(w?.title ? { title: w.title } : {}), ...(w?.url ? { url: w.url } : {}), ...(w?.doc ? { document: w.doc } : {}) });
    }
    case 'resolve': {
      // The window 'app:X' uses on screen, and the app it would bring forward (main.swift: the running pick always;
      // hands-win: the minimised pick when no window is on screen), doing neither.
      const name = String(a[1]).slice(4), w = mainWindow(listed.filter((x) => matches(x, name))), app = win && w ? null : pick(name);
      const pid = win ? null : pickProc(name)?.pid;
      done({ ok: true, ...(w ? { window: info(w) } : {}), ...(app ? { running: app } : {}), ...(pid != null ? { runningPid: pid } : {}) });
    }
    case 'manage': {
      // main.swift manage: the window's own app, else the process pid while it has that very name, else the running app
      // picked for app (exact: that very name), else the front app. Force quit needs confirmed.
      const s = spec(a[1]), name = sTrim(String(s.app ?? ''));
      let app = null;
      if (s.window != null) { app = listed.find((x) => x.id === s.window)?.app; if (!app) fail(`No window with id ${s.window} (it may have closed). Call list_windows again.`); }
      else if (s.pid != null) { const p = procs.find((x) => x.pid === s.pid) ?? (st.running ? null : st.wins.find((x) => x.pid === s.pid)); app = p && sEq(p.app, name) ? p.app : null; }
      else app = name ? pickRunning(name, s.exact === true) : resolve('front')?.app ?? null;
      if (!app) fail(name ? `${name} isn't open.` : 'No app is in front.');
      if (s.do === 'force_quit' && !s.confirmed) done({ ok: false, needsConfirm: true, why: `Force quitting ${app} loses anything unsaved.`, app });
      log(['MANAGE', s.do, app]);
      done({ ok: true, done: { quit: `asked ${app} to quit`, force_quit: `force quit ${app}`, hide: `hid ${app}`, activate: `switched to ${app}`, close: `closed a ${app} window`, minimize: `minimised a ${app} window`, arrange: `put the ${app} window on the ${s.layout}` }[s.do] ?? s.do });
    }
    case 'locate': {
      if (a[1] === 'screen') done({ ok: true, what: 'screen' });
      const w = resolve(a[1]);
      done(w ? { ok: true, window: shows(w) } : { ok: false, error: noWindow(a[1]) });
    }
    case 'ui': {
      const w = resolve(a[1]);
      if (!w) fail('No matching window is open.');
      done({ ok: true, window: shows(w), controls: w.controls ?? [], ...(a[2] === 'controls' ? {} : { texts: lines(w), elsewhere: [], note: (w.controls ?? []).length ? '' : 'This app shares no controls. Use a screenshot plus click at coordinates instead.' }) });
    }
    case 'capture': {
      fs.writeFileSync(a[1], 'x');
      // main.swift: the screen with every window in it, at most 60 (shown); hands-win sends no list.
      if (a[2] === 'screen') done({ ok: true, file: a[1], what: 'screen', bounds: [0, 0, 1440, 900], ...(win ? {} : { shown: listed.slice(0, 60).map((w) => shows(w)) }), pixels: [1440, 900] });
      const w = resolve(a[2]);
      if (!w) fail(noWindow(a[2]));
      done({ ok: true, file: a[1], window: shows(w), pixels: [800, 600] });
    }
    case 'find-text': {
      // The windows searched: 'screen' every listed one, 'front' the front app's, 'app:X' each match (no window is
      // brought forward), else the one resolved; the first 12 only. Each match: its words (80 at most), how it
      // matched, its window bare.
      const t = a[1], q = String(a[2] ?? '').trim().toLowerCase(), f = resolve('front');
      const ws = t === 'screen' ? listed : t === 'front' ? listed.filter((w) => w.pid === f?.pid) : t.startsWith('app:') ? listed.filter((w) => matches(w, t.slice(4))) : [resolve(t)].filter(Boolean);
      if (!ws.length) fail('No matching window is open.');
      const all = ws.slice(0, 12).flatMap((w, z) => (w.ax === false ? [] : lines(w)).filter((s) => s.toLowerCase().includes(q)).slice(0, 8).map((s, i) => ({ text: s.slice(0, 80), match: ['exact', 'word', 'partial'][score(s.trim().toLowerCase(), q)], role: 'statictext', bounds: [B(w)[0] + 10, B(w)[1] + 30 + i * 20, 200, 14], window: info(w), rank: z * 100 + i })));
      const exact = all.filter((m) => m.text.trim().toLowerCase() === q);
      done({ ok: true, matches: [...exact, ...all.filter((m) => !exact.includes(m))].slice(0, 8) });
    }
    case 'ocr-find': {
      // The pixels of a window, or of the whole screen ('screen': every window on it, listed or not), each hit as its
      // whole recognized line; words match whole words only.
      const q = String(a[2] ?? '').trim();
      const ws = a[1] === 'screen' ? onScreen : [resolve(a[1])].filter(Boolean);
      if (a[1] !== 'screen' && !ws.length) fail('No matching window is open.');
      const re = new RegExp(`(?<![\\p{L}\\p{N}])${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, q.length === 1 ? 'u' : 'iu');
      const found = ws.flatMap((w) => lines(w).filter((s) => re.test(s)).map((s) => ocrLine(w, s, q)));
      done({ ok: true, matches: a[3] === 'all' ? found : found.slice(0, 1) });
    }
    case 'refine': done({ ok: true, boxes: JSON.parse(a[1]).map(() => null) });
    case 'act': {
      const plan = spec(a[1]);
      const t = plan.window != null ? `window:${plan.window}` : plan.app ? `app:${plan.app}` : 'front';
      if (!resolve(t)) fail(noWindow(t));
      done(st.act ?? { ok: true, done: [], window: shows(resolve(t)) });
    }
    default: done({ ok: true });
  }
}
