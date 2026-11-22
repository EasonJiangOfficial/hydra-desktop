// window.hydraDesktop's transport (hydra.rs BRIDGE_JS, W3 contract-fixes 9), run as the page would run it: every call
// is a top-level navigation to hydra-desktop:// (CSP doesn't govern those; a frame would be blocked by frame-src),
// sent one at a time with a gap so quick calls never replace each other, each with the launch token and a request id.
// Promise answers come back through __hydraDesktopPush by id; ids start at a random point on each page load.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const rs = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src-tauri/src/hydra.rs'), 'utf8');
const js = rs.slice(rs.indexOf('const BRIDGE_JS: &str = r#"') + 'const BRIDGE_JS: &str = r#"'.length, rs.indexOf('})();"#;') + '})();'.length);
const TOKEN = '0123456789abcdef0123456789abcdef';
assert.ok(js.startsWith('(() => {') && js.includes('__HYDRA_TOKEN__'));

function page() {
  const navs = [];
  const location = { origin: 'https://hydra-olive-one.vercel.app', set href(v) { navs.push([v, Date.now()]); }, get href() { return 'https://hydra-olive-one.vercel.app/'; } };
  // No document.createElement: a frame transport would throw here.
  const document = { addEventListener() {} };
  const win = { location, document, setTimeout, clearTimeout, CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o?.detail; } }, dispatchEvent() {} };
  win.window = win; win.top = win;
  vm.createContext(win);
  vm.runInContext(js.replace('__HYDRA_TOKEN__', TOKEN), win);
  return { win, navs, bridge: win.hydraDesktop };
}
const parse = (u) => { const url = new URL(u); return { cmd: url.host, t: url.searchParams.get('t'), id: url.searchParams.get('id'), q: url.searchParams }; };

const { win, navs, bridge } = page();
assert.equal(bridge.version, 3);
// Five calls in a row, three with no answer and two promise calls.
bridge.setMuted(true);
bridge.wake();
const setup = bridge.setup();
bridge.pause();
const pair = bridge.pair('AB12-CD34');
assert.equal(navs.length, 1, 'the first goes at once, the rest wait their turn');
const until = Date.now() + 3000;
while (navs.length < 5 && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
assert.equal(navs.length, 5, 'every call went out, none replaced');
const calls = navs.map(([u]) => parse(u));
assert.deepEqual(calls.map((c) => c.cmd), ['mute', 'wake', 'setup', 'pause', 'pair'], 'in order');
for (const c of calls) {
  assert.equal(c.t, TOKEN, 'each carries the launch token');
  assert.match(c.id, /^\d{1,9}$/, 'each carries a request id the app accepts');
}
assert.equal(new Set(calls.map((c) => c.id)).size, 5, 'ids are unique');
assert.equal(calls[0].q.get('on'), '1');
assert.equal(calls[4].q.get('code'), 'AB12-CD34');
for (let i = 1; i < navs.length; i++) assert.ok(navs[i][1] - navs[i - 1][1] >= 60, `a gap between calls (${navs[i][1] - navs[i - 1][1]} ms)`);

// Answers by id: each resolves its own call; an unknown id resolves nothing and isn't merged into the state.
win.__hydraDesktopPush({ res: { id: Number(calls[4].id), result: { ok: true } } });
win.__hydraDesktopPush({ res: { id: Number(calls[2].id), result: { paired: false } } });
win.__hydraDesktopPush({ res: { id: 1, result: 'stray' } });
assert.deepEqual(await pair, { ok: true });
assert.deepEqual(await setup, { paired: false });
assert.equal(bridge.snapshot().res, undefined);
win.__hydraDesktopPush({ reply: null, heard: { text: 'hi', final: false } });
assert.deepEqual(bridge.snapshot().heard, { text: 'hi', final: false });

// A reload: ids start somewhere else, so an old answer can't resolve the new page's call.
const firsts = [Number(calls[0].id)];
for (let i = 0; i < 3; i++) { const p = page(); p.bridge.wake(); firsts.push(Number(parse(p.navs[0][0]).id)); }
assert.ok(new Set(firsts).size > 1, `random starting ids: ${firsts}`);
assert.ok(firsts.every((n) => n < 1e9), 'ids stay 9 digits');
console.log('bridgequeue: ok');
