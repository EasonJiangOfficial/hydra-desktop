import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_VOICE } from '../fish.mjs';

// One character: Hydra, with the one Fish Audio voice the owner picked. No other look or picker is left; the orb's
// size is a setting (owner, 2026-11-22: "it's way too big"): Small 40, Medium 48 (default), Large 64.
const src = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const side = src('../sidekick.mjs');
const HYDRA_VOICE = '612b878b113047d9a770c069c8b4fdfe';
assert.match(side, /const LOOKS = \[\['hydra', 'Hydra', HYDRA_VOICE\]\];/);
assert.match(side, new RegExp(`const HYDRA_VOICE = '${HYDRA_VOICE}';`));
assert.equal(DEFAULT_VOICE, HYDRA_VOICE, 'Fish Audio speaks in Hydra\'s voice by default');
assert.match(side, /const SIZES = \[\['small', 'Small'\], \['default', 'Medium'\], \['large', 'Large'\]\];/);
const OLD = /\b(jarvis|glayos|ultren|anime girl|sarah|adrian|rita x)\b|'classic'|people\.js/i;
for (const f of ['../../../panel/panel.js', '../../../panel/index.html', '../../../onboarding/onboarding.js', '../../../onboarding/index.html', '../../../roamies/host.js', '../../../roamies/notch.js', '../../../desktop.html', '../gemini.mjs']) {
  assert.ok(!OLD.test(src(f)), `${f} names no removed character`);
}

// The orb draws an open sphere of dots, in every state, inside its area; asleep or at rest it barely moves.
globalThis.window = { Roamie: {} };
new Function(src('../../../roamies/hydra.js'))();
const H = window.Roamie.hydra;
const draw = (st, rad = 12) => {
  const dots = [];
  H.body({ dot: (x, y, r, shade) => dots.push([x, y, r, shade]), L: 4 }, 50, 50, rad, { t: 1, dt: 0.016, ...st });
  return dots;
};
for (const st of [{}, { mode: 'talk', voice: 0.9 }, { mode: 'listen', heard: 0.8 }, { mode: 'think' }, { asleep: true }]) {
  const d = draw(st);
  assert.ok(d.length >= 150, 'enough dots to read as a sphere');
  for (const [x, y, r, shade] of d) {
    assert.ok(Math.hypot(x - 50, y - 50) <= 12 * 1.3, 'inside the orb');
    assert.ok(r > 0 && r < 1 && shade >= 0 && shade <= 1);
  }
}
const spread = (d) => Math.max(...d.map(([x, y]) => Math.hypot(x - 50, y - 50)));
assert.ok(spread(draw({ mode: 'talk', voice: 1 })) > spread(draw({ asleep: true })), 'speaking ripples it outward');
const a = draw({ asleep: true, t: 1 }), b = draw({ asleep: true, t: 3 });
assert.deepEqual(a.map(([x, y]) => [x.toFixed(3), y.toFixed(3)]), b.map(([x, y]) => [x.toFixed(3), y.toFixed(3)]), 'asleep, it holds still');
assert.ok(draw({ asleep: true }).every(([, , , shade]) => shade >= 0.75), 'asleep, it is pale');
// Without vector dots (the notch lens), it writes LED cells instead.
const cells = [];
H.body({ put: (x, y, l) => cells.push(l), L: 4 }, 20, 20, 10, { t: 1 });
assert.ok(cells.length > 100 && cells.every((l) => l >= 1 && l <= 4));
console.log('looks tests: passed');

// Regression: a selected stage canvas showed as a grey box around the orb (WebKit tints selected canvases).
assert.match(src('../../../desktop.html'), /canvas \{[^}]*-webkit-user-select: none; user-select: none;[^}]*\}/);

// Regression: after a drawing the agent stopped following the cursor and hopped away from it instead.
{
  const agent = src('../../../roamies/agent.js'), rel = agent.slice(agent.indexOf('async release()'), agent.indexOf('place: (x, y) =>'));
  assert.match(agent, /pen\.follow = !!station\.byCursor/, 'take() remembers whether it was following the cursor');
  assert.match(rel, /if \(pen\.follow && presence\.ptr\) station\.byCursor = presence\.ptr\.slice\(\)/, 'release() goes back to following');
}

// The bubbles, tags and step list draw with glass.js, so the overlay loads it before them; hydra.js before the kit.
{
  const page = src('../../../desktop.html'), at = (f) => page.indexOf(`roamies/${f}`);
  assert.ok(at('glass.js') > 0 && at('glass.js') < at('agent.js') && at('glass.js') < at('agent-cards.js'), 'desktop.html loads glass.js before agent.js and agent-cards.js');
  assert.ok(at('hydra.js') > 0 && at('hydra.js') < at('10-dither.js'), 'and hydra.js before the kit that draws it');
}
