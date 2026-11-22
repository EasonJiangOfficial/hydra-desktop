// Hydra Desktop's type is the system sans only (DESIGN.md section 7): no web font is bundled or declared, every text
// stack in the overlay, panel and setup guide is the system's, and Arabic still reads (the system font has it, and
// typed text runs right to left). Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('../../../', import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, root), 'utf8');
assert.ok(!fs.existsSync(new URL('onboarding/fonts', root)), 'no bundled fonts folder');
const pages = ['desktop.html', 'onboarding/onboarding.css', 'onboarding/index.html', 'panel/panel.css', 'panel/index.html'];
const scripts = ['glass.js', 'ink.js', 'agent.js', 'agent-panel.js', 'agent-home.js', 'ask-bar.js', 'notch.js', 'core.js'].map((f) => `roamies/${f}`);
for (const f of [...pages, ...scripts]) {
  const t = read(f);
  assert.ok(!/@font-face/.test(t), `${f}: no @font-face`);
  assert.ok(!/Martian Mono|"Doto"|Readex|Roamies Arabic/.test(t), `${f}: no Martian Mono, Doto or Readex Pro`);
}
assert.match(read('onboarding/onboarding.css'), /--mono:\s*-apple-system/, 'the panel and guide stack is the system sans');
for (const f of ['glass.js', 'ink.js', 'agent-panel.js', 'ask-bar.js', 'notch.js']) assert.match(read(`roamies/${f}`), /system-ui, -apple-system/, `${f}: system sans`);
assert.match(read('roamies/ask-bar.js'), /ta\.dir = 'auto'/, 'typing Arabic runs right to left');
console.log('arabic tests: passed');
