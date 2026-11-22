// Random sounds (owner): with the premium pack no sound plays without an event the owner sees. The pointer-idle
// 'wake' is silent; the host's chimes play once (only the overlay holding Hydra, not every overlay window); 'done'
// plays once per finished task, not per tool animation; sounds the model asks for (draw.mjs sfx) are silent.
// Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const sfxSrc = read('../../../roamies/sfx.js'), host = read('../../../roamies/host.js'), agent = read('../../../roamies/agent.js');
const ink = read('../../../roamies/ink.js'), dither = read('../../../roamies/10-dither.js'), side = read('../sidekick.mjs');

// sfx.js, run for real with a fake Web Audio: what each caller name plays.
const started = [];
class AudioContext {
  constructor() { this.state = 'running'; this.destination = {}; this.t = 0; }
  get currentTime() { return (this.t += 5); } // past every repeat gap
  resume() {}
  createGain() { return { gain: { value: 1 }, connect() {} }; }
  createBufferSource() { const s = { connect() {}, start: () => started.push(s.buffer.name) }; return s; }
  decodeAudioData(b) { return Promise.resolve({ name: b.name }); }
}
const ctx = {
  Roamie: {}, ROAMIE_AUTOSOUND: true, AudioContext, URL, location: { href: 'file:///r/' }, document: {},
  localStorage: { getItem: () => null, setItem() {} }, addEventListener() {},
  fetch: async (u) => ({ arrayBuffer: async () => ({ name: String(u).split('/').pop().replace('.wav', '') }) }),
};
ctx.window = ctx;
vm.runInNewContext(sfxSrc, ctx);
await new Promise((r) => setTimeout(r, 10));
const play = (n) => { const k = started.length; ctx.Roamie.sfx.play(n); return started[k] ?? null; };
assert.equal(play('wake'), null, "the pointer-idle 'wake' (10-dither.js) is silent");
assert.match(dither, /S\(asleep \? 'yawn' : 'wake'\)/, 'that is the name it uses');
assert.equal(play('hydra_wake'), 'wake', 'waking Hydra chimes');
for (const n of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) assert.equal(play(n), null, `${n} is no sound (and no throw)`);
assert.equal(play('done'), 'done');

// Host chimes: every overlay window gets the sidecar's messages; only the one holding Hydra plays them.
assert.match(host, /m\.kind === 'power'\) \{ Roamie\.asleep = !!m\.asleep; if \(m\.asleep && m\.sound && getAgent\(\)\) Roamie\.sfx\?\.play\('sleep'\);/);
assert.match(host, /m\.kind === 'listen_after'\) \{ if \(getAgent\(\)\) Roamie\.sfx\?\.play\('hydra_wake'\);/);
// Every other host play sits after the overlay's agent check (agentEvent and onVoice return without one).
const before = host.slice(0, host.indexOf('if (!getAgent()) return;\n    if (m.kind === \'agents\')'));
const loose = [...before.matchAll(/Roamie\.sfx\?\.play\('(\w+)'\)/g)].map((m) => m[1]);
assert.deepEqual(loose.sort(), ['done', 'heard', 'hydra_wake', 'listen', 'listen', 'sleep'], 'no other host sound outside a check');
assert.match(host, /function agentEvent\(e\) \{\n    const a = getAgent\(\);\n    if \(!a\) return;/, "done: Hydra's overlay only");
assert.match(host, /function onVoice\(m\) \{[\s\S]{0,300}const a = getAgent\(\);\n    if \(!a\) return;/, 'listen and heard: Hydra\'s overlay only');

// 'done': once per finished task. A tool animation ending is silent; the request's end chimes if a tool ran,
// unless that end wasn't a finished task (a retry follows, or it was stopped: that ends as an error line).
assert.doesNotMatch(agent, /k\.S\(final \? 'done' : 'error'\)/, 'no chime per tool');
assert.match(host, /case 'start':[\s\S]{0,600}toolsRan = false;/);
// toolsRan only where a tool visual shows: a tool with no animation (listing commitments) or one run while the mic
// is open shows nothing, so it earns no 'done'. The real case 'tool' block, run against stubs.
const toolCase = host.match(/\n      case 'tool':\n([\s\S]*?)\n      case 'tool_end':/)[1];
for (const [e, listen, notch, want] of [
  [{ anim: null }, null, false, false], [{ anim: { tool: 'files' } }, { open: true }, false, false],
  [{ id: 1, anim: { tool: 'files' } }, null, false, true], [{ anim: { tool: 'web' } }, null, true, true],
]) {
  const c = { e, listen, toolsRan: false, research: false, fromWeb: false, jobs: [], notchOn: () => notch, N: () => ({ tool() {} }),
    endTalk() {}, playTools() {}, panel: () => null, webStatus: () => '', toolWords: () => '' };
  vm.runInNewContext(`switch ('tool') { case 'tool':\n${toolCase} }`, c);
  assert.equal(c.toolsRan, want, JSON.stringify({ e, listen, notch }));
}
// The 'working' chime plays where the task tag starts, and the tag draws on the desktop even with the orb attached
// (only bubbles and the orb itself hide then), so that chime always has something on screen.
assert.match(agent, /def\.start\?\.\(st, C\);\n        k\.S\('toolstart'\);/);
const over = agent.match(/\n      over: \(ctx, env\) => \{([\s\S]*?)\n      \},/)[1];
assert.match(over, /\n        if \(tool\) drawTag\(ctx, tool\);/);
assert.doesNotMatch(over, /orbAttached/);
assert.match(host, /case 'done':\n        responding = false;\n        if \(toolsRan && !e\.stopped\) Roamie\.sfx\?\.play\('done'\);\n        toolsRan = false;/);
assert.match(side, /if \(retryNext\) \{ if \(!controller\.signal\.aborted\) voice\?\.end\(\); ui\(\{ kind: 'agent', e: \{ type: 'done', stopped: true \} \}\); \}/);
// Build 4 E1: a quiet stop (sleep) now says why, as an error line, which never chimes 'done' either.
assert.match(side, /const how = stalled \? 'stall' : controller\.signal\.aborted \? \(quiet \? 'sleep' : 'stop'\) : 'error';/);
assert.match(side, /ui\(\{ kind: 'agent', e: \{ type: 'error', message: msg, speech: sid \} \}\);/);
// The real case 'done' block, run against stubs: one chime with tools, none without, none when stopped.
const doneCase = host.match(/\n      case 'done':\n([\s\S]*?)\n        break;/)[1].split('\n').slice(0, 3).join('\n');
for (const [ran, e, want] of [[true, {}, ['done']], [false, {}, []], [true, { stopped: true }, []]]) {
  const got = [];
  vm.runInNewContext(doneCase, { e, toolsRan: ran, responding: true, Roamie: { sfx: { play: (n) => got.push(n) } } });
  assert.deepEqual(got, want, JSON.stringify({ ran, e }));
}

// Model-requested sounds: draw.mjs lets the model name a sound; the overlay plays none of them, nor for a handoff.
assert.match(ink, /async sfx\(\) \{\},/);
assert.match(ink, /async handoff\(m\) \{ leaveAfter\(/);
console.log('sound tests: passed');
