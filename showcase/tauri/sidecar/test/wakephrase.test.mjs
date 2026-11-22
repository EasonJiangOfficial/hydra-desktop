// "Listening but not responding" (owner): awake and idle, the Mac only listens for the key phrase, so the bridge
// snapshot says so (wake: 'phrase'); a real take, thinking, speaking or asleep is wake 'off' (docs/BRIDGE.md).
// The web card shows "Say \"Hey Hydra\"" from it. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const side = fs.readFileSync(new URL('../sidekick.mjs', import.meta.url), 'utf8');
const host = fs.readFileSync(new URL('../../../roamies/host.js', import.meta.url), 'utf8');
const rust = fs.readFileSync(new URL('../../src-tauri/src/hydra.rs', import.meta.url), 'utf8');

// The overlay's real orbNow, run against stubs.
const body = host.match(/\n  function orbNow\(\) \{[\s\S]*?\n  \}\n/)[0];
const run = ({ asleep = false, phrase = false, hearing = false, responding = false, speaking = false }) => {
  const ctx = { Roamie: { asleep, orbAttached: true, voiceOut: { playing: () => speaking, level: () => 0.5 } }, wakePhrase: phrase, hearing2: hearing, responding, micLevel: 0.3 };
  vm.runInNewContext(`${body}\nthis.o = orbNow();`, ctx);
  return ctx.o;
};
assert.deepEqual([run({ phrase: true }).state, run({ phrase: true }).wake], ['Listening', 'phrase'], 'idle: only the key phrase listens');
assert.equal(run({ phrase: true, hearing: true }).wake, 'off', 'a real take');
assert.equal(run({ phrase: true, hearing: true }).state, 'Listening');
assert.equal(run({ phrase: true, responding: true }).wake, 'off', 'thinking');
assert.equal(run({ phrase: true, speaking: true }).wake, 'off', 'speaking');
assert.equal(run({ phrase: true, asleep: true }).wake, 'off', 'asleep');
assert.equal(run({ phrase: false }).wake, 'off', 'phrase off');
// The key that throttles pushes changes with wake, so the switch reaches the page at once.
assert.match(host, /key = `\$\{o\.state\}\|\$\{o\.wake\}\|/);
// The overlay learns it from the sidecar, at every voice config change and when it (re)starts.
assert.match(host, /m\.kind === 'wake_phrase'\) \{ wakePhrase = !!m\.on; pushOrb\(true\);/);
assert.match(side, /const voiceConfig = \(\) => \{\n  ui\(\{ kind: 'wake_phrase', on: phraseListening\(\) \}\);/);
assert.match(side, /ui\(\{ kind: 'orb_mode', detached: orbDetached\(\) \}\); send\(\{ type: 'orb_mode', detached: orbDetached\(\) \}\);\n    ui\(\{ kind: 'wake_phrase', on: phraseListening\(\) \}\);/);
assert.match(side, /const phraseListening = \(\) => VOICE_OK && !!config\.voice && voiceReady\(\) && phraseOn\(\) && !power\.asleep;/);
// The shell lets it through (hydra.rs tests the filter itself) and the page starts at 'off'.
assert.match(rust, /msg\.get\("wake"\)\.and_then\(Value::as_str\)\.filter\(\|w\| \["phrase", "off"\]\.contains\(w\)\)/);
assert.match(rust, /let snap = \{ state: 'Asleep', wake: 'off',/);
console.log('wake phrase tests: passed');
