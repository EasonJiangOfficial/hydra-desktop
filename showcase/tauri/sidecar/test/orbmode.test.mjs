// Attached (default) or detached orb (owner: "the voice agent is completely separate from the app, which shouldn't be the
// case unless I detatch it"). The mode is kept in config, switched from the tray menu, the panel, a right-click on the
// orb and the web app's bridge (orb_set, which the shell passes on only from Hydra's own page), and told to the overlay
// (ui orb_mode) and the shell (orb_mode, for the menu bar icon). Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const side = fs.readFileSync(new URL('../sidekick.mjs', import.meta.url), 'utf8');
const host = fs.readFileSync(new URL('../../../roamies/host.js', import.meta.url), 'utf8');
const core = fs.readFileSync(new URL('../../../roamies/core.js', import.meta.url), 'utf8');
const panel = fs.readFileSync(new URL('../../../panel/panel.js', import.meta.url), 'utf8');

// setOrbMode, run for real against stubs: it saves, tells the overlay and the shell, and refreshes the menu.
const body = side.match(/const orbDetached = [^\n]+\nfunction setOrbMode[\s\S]*?\n}\n/)[0];
const calls = [];
const ctx = { config: {}, saveConfig: () => calls.push('save'), logLine: () => {}, ui: (m) => calls.push(['ui', m]), send: (m) => calls.push(['send', m]), menu: () => calls.push('menu'), panel: () => {}, panelOpen: false };
vm.runInNewContext(`${body}\nthis.orbDetached = orbDetached; this.setOrbMode = setOrbMode;`, ctx);
assert.equal(ctx.orbDetached(), false, 'attached by default');
ctx.setOrbMode(true, 'web');
assert.equal(ctx.config.orbDetached, true, 'remembered in config (so across restarts)');
assert.deepEqual(JSON.parse(JSON.stringify(calls.filter((c) => Array.isArray(c)))), [['ui', { kind: 'orb_mode', detached: true }], ['send', { type: 'orb_mode', detached: true }]]);
assert.ok(calls.includes('save') && calls.includes('menu'));
ctx.setOrbMode(false, 'menu');
assert.equal(ctx.orbDetached(), false, 'attached again');

// Every way in.
assert.match(side, /\{ id: orbDetached\(\) \? 'orb:attach' : 'orb:detach', label: orbDetached\(\) \? 'Attach Orb' : 'Detach Orb' \}/, 'tray menu item');
assert.match(side, /id === 'orb:detach'\) setOrbMode\(true/);
assert.match(side, /id === 'orb:attach'\) setOrbMode\(false/);
assert.match(side, /id === 'orb:offer' && orbDetached\(\)[\s\S]{0,200}'Attach to Hydra'/, 'right-click on the orb offers Attach to Hydra');
assert.match(side, /m\.type === 'orb_set'\) setOrbMode\(!!m\.detached/, 'the web app bridge');
assert.match(side, /ui\(\{ kind: 'orb_mode', detached: orbDetached\(\) \}\); send\(\{ type: 'orb_mode', detached: orbDetached\(\) \}\);/, 'said again when the overlay starts');
assert.match(panel, /toggle\('Detached orb'[\s\S]{0,300}act\(h\.detached \? 'orb:attach' : 'orb:detach'\)/, 'panel switch');
// The overlay: attached by default, no orb to hit, and right-click only on a floating orb.
assert.match(host, /if \(Roamie\.orbAttached == null\) Roamie\.orbAttached = true;/);
assert.match(host, /m\.kind === 'orb_mode'\) \{ Roamie\.orbAttached = !m\.detached;/);
assert.match(core, /R\.orbAttached\) continue;/);
console.log('orb mode tests: passed');
