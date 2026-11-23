// The Mac launch page must not sit on the loader forever. If Hydra's first page has not painted
// (this document is still here) about 15 s after navigation starts, show "Hydra is taking long to load"
// and a Retry button. Retry, and a 10 s timer while the window is visible, call location.replace again.
// If requestAnimationFrame never fires, a 1 s timeout navigates anyway.
// Run: npm test
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const html = readFileSync(new URL('../../../launch/index.html', import.meta.url), 'utf8');
const script = html.match(/<script id="launch-watchdog">([\s\S]*?)<\/script>/)[1];
const HYDRA = 'https://hydra-olive-one.vercel.app/';

assert.match(html, /Hydra is taking long to load/);
assert.match(html, />Retry</);
assert.match(html, /font: 16px\/1\.4 system-ui, -apple-system, sans-serif/);
assert.match(html, /font: 500 28px\/1\.2 ui-serif, Georgia, serif/);
assert.match(html, /height: 34px; padding: 0 14px; border: 1px solid #1d1d1f; border-radius: 8px; background: #1d1d1f; color: #fff/);

function boot({ rafFires, visible }) {
  const calls = [];
  const timers = [];
  const listeners = [];
  let now = 0;
  let seq = 1;
  let rafQ = [];
  const slow = { hidden: true };
  const clicks = [];
  const document = {
    visibilityState: visible ? 'visible' : 'hidden',
    getElementById(id) {
      if (id === 'slow') return slow;
      if (id === 'retry') return { addEventListener(_ev, fn) { clicks.push(fn); } };
      return null;
    },
    addEventListener(ev, fn) { if (ev === 'visibilitychange') listeners.push(fn); },
    removeEventListener(ev, fn) {
      if (ev !== 'visibilitychange') return;
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
  };
  const location = { replace(url) { calls.push(url); } };
  function setTimeout(fn, ms) {
    const id = seq++;
    timers.push({ id, fn, at: now + ms });
    return id;
  }
  function clearTimeout(id) {
    const i = timers.findIndex((t) => t.id === id);
    if (i >= 0) timers.splice(i, 1);
  }
  function requestAnimationFrame(fn) {
    if (rafFires) rafQ.push(fn);
    return 1;
  }
  const ctx = createContext({ document, location, setTimeout, clearTimeout, requestAnimationFrame });
  runInContext(script, ctx);
  return {
    calls,
    slow,
    fireRaf() {
      const q = rafQ.splice(0);
      for (const fn of q) fn();
    },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at || a.id - b.id);
        if (!due.length) { now = end; return; }
        const t = due[0];
        timers.splice(timers.indexOf(t), 1);
        now = t.at;
        t.fn();
      }
    },
    click() { for (const fn of clicks) fn(); },
    show() {
      document.visibilityState = 'visible';
      for (const fn of listeners.splice(0)) fn();
    },
  };
}

// Two paints, then one navigation. The 1 s fallback does not navigate a second time.
{
  const page = boot({ rafFires: true, visible: true });
  assert.deepEqual(page.calls, []);
  page.fireRaf();
  assert.deepEqual(page.calls, [], 'the first frame only schedules the next');
  page.fireRaf();
  assert.deepEqual(page.calls, [HYDRA]);
  page.advance(1000);
  assert.deepEqual(page.calls, [HYDRA], 'the fallback does not navigate again');
  // Navigation started at t=0 (the second frame). 14.999 s later the notice is still hidden.
  page.advance(13999);
  assert.equal(page.slow.hidden, true, 'still waiting at 14.999 s');
  page.advance(1);
  assert.equal(page.slow.hidden, false, 'the notice shows at 15 s');
  page.advance(9999);
  assert.equal(page.calls.length, 1, 'no auto retry before 10 s');
  page.advance(1);
  assert.equal(page.calls.length, 2, 'auto retry at 10 s while visible');
  page.click();
  assert.equal(page.calls.length, 3, 'Retry navigates at once');
  page.advance(10000);
  assert.equal(page.calls.length, 4, 'the 10 s timer starts again after Retry');
}

// A hidden window: requestAnimationFrame never runs, so the 1 s timeout navigates.
{
  const page = boot({ rafFires: false, visible: false });
  page.advance(999);
  assert.deepEqual(page.calls, [], 'still on the loader before the fallback');
  page.advance(1);
  assert.deepEqual(page.calls, [HYDRA]);
  page.advance(15000);
  assert.equal(page.slow.hidden, false);
  page.advance(10000);
  assert.equal(page.calls.length, 1, 'a hidden window does not retry');
  page.show();
  assert.equal(page.calls.length, 2, 'becoming visible retries once');
  page.advance(10000);
  assert.equal(page.calls.length, 3, 'then every 10 s while it stays visible');
}
