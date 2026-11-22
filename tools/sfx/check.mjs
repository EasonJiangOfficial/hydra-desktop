#!/usr/bin/env node
// Checks the rendered sounds and sfx.js together: every mapped file exists and is 48 kHz 24-bit stereo with
// silent first and last samples; sfx.js plays mapped names, keeps the rest silent, throttles repeats,
// honours the on/off switch and ticks only when switched on after start-up.
// Run: node tools/sfx/check.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const ROAMIES = join(dirname(fileURLToPath(import.meta.url)), '../../showcase/roamies');
const SRC = readFileSync(join(ROAMIES, 'sfx.js'), 'utf8');

// WAV files.
const files = [...SRC.matchAll(/\['(\w+)', [\d.]+\]/g)].map((m) => m[1]);
assert.ok(files.length >= 10, 'MAP lists the palette');
for (const f of new Set(files)) {
  const b = readFileSync(join(ROAMIES, 'sounds', `${f}.wav`));
  assert.equal(b.toString('ascii', 0, 4), 'RIFF', f);
  assert.equal(b.readUInt16LE(22), 2, `${f} stereo`);
  assert.equal(b.readUInt32LE(24), 48000, `${f} 48 kHz`);
  assert.equal(b.readUInt16LE(34), 24, `${f} 24-bit`);
  const n = b.readUInt32LE(40) / 6, ms = (n / 48000) * 1000;
  assert.ok(ms >= 80 && ms <= 900, `${f} length ${ms} ms`);
  for (const o of [44, 47, b.length - 6, b.length - 3]) assert.equal(b.readIntLE(o, 3), 0, `${f} silent edge at ${o}`);
}

// sfx.js with a fake Web Audio.
let clock = 0;
const started = [];
class AudioContext {
  constructor() { this.state = 'running'; this.destination = {}; }
  get currentTime() { return clock; }
  resume() {}
  createGain() { return { gain: { value: 1 }, connect() {} }; }
  createBufferSource() { const s = { connect() {}, start: () => started.push({ buf: s.buffer, gain: g?.gain.value }) }; let g; s.connect = (x) => { g = x; }; return s; }
  decodeAudioData(b) { return Promise.resolve({ name: b.name }); }
}
const fetched = [];
const store = {};
const ctx = {
  Roamie: {}, ROAMIE_AUTOSOUND: true, AudioContext, URL,
  document: { currentScript: { src: pathToFileURL(join(ROAMIES, 'sfx.js')).href } }, location: { href: 'file:///' },
  localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } },
  fetch: async (u) => { fetched.push(String(u)); return { arrayBuffer: async () => ({ name: String(u).split('/').pop().replace('.wav', '') }) }; },
  addEventListener() {},
};
ctx.window = ctx;
vm.runInNewContext(SRC, ctx);
await new Promise((r) => setTimeout(r, 10));
const sfx = ctx.Roamie.sfx;
assert.ok(fetched.every((u) => u.includes('/roamies/sounds/')), 'loads from roamies/sounds/');
assert.equal(fetched.length, new Set(files).size);

const play = (n) => { const k = started.length; sfx.play(n); return started[k]?.buf.name ?? null; };
assert.equal(play('listen'), 'listen');
assert.equal(play('hydra_wake'), 'wake');
assert.equal(play('remind'), 'attention');
assert.equal(play('toolstart'), 'working');
assert.equal(started.at(-1).gain, 0.35, 'working plays quietly');
for (const n of ['hop', 'stomp', 'bonk', 'hype', 'wave', 'motivate', 'yawn', 'snore', 'gulp', 'boop', 'grab', 'upset', 'pop', 'poof', 'hmm', 'scribble', 'page', 'wake', 'blip', 'key', 'tick', 'pip'])
  assert.equal(play(n), null, `${n} is silent`);
clock = 1; assert.equal(play('done'), 'done');
clock = 1.1; assert.equal(play('done'), null, 'a repeat inside the gap is dropped');
clock = 2; assert.equal(play('done'), 'done');

sfx.enabled = true; // start-up sync: no tick
clock = 3; assert.equal(started.at(-1).buf.name, 'done');
sfx.enabled = false; assert.equal(play('heard'), null, 'off means silent');
assert.equal(store['roamie-sound'], 'off');
const k = started.length; sfx.enabled = true;
assert.equal(started[k]?.buf.name, 'toggle', 'switching on ticks');
console.log('sfx check: ok');
