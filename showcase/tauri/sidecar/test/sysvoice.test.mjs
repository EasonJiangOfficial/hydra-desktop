// The Mac's voice (sysvoice.mjs), Hydra's voice until a Fish Audio key is added: what's spoken, and reading the WAVE.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { spokenText, SystemVoice, wavPcm } from '../sysvoice.mjs';

assert.equal(spokenText('[warm] Hydra at your **service**, sir.'), 'Hydra at your service, sir.');
assert.equal(spokenText('[pause]'), '');
// A WAVE with a "LIST" chunk before "data": the samples are found past it.
const pcm = Buffer.from([1, 0, 2, 0, 3, 0]);
const chunk = (id, body) => Buffer.concat([Buffer.from(id), Buffer.from(Uint32Array.of(body.length).buffer), body]);
const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), chunk('fmt ', Buffer.alloc(16)), chunk('LIST', Buffer.alloc(3)), Buffer.alloc(1), chunk('data', pcm)]);
assert.deepEqual(wavPcm(wav), pcm);
assert.equal(wavPcm(Buffer.from('not a wave')), null);

// Sentences play in order, the text goes in on stdin (never the arguments), and end() ends after the last one.
const calls = [];
const run = (bin, args) => {
  const c = new EventEmitter();
  c.stdin = { end: (text) => { calls.push({ bin, args, text }); fs.writeFileSync(args[1], wav); setTimeout(() => c.emit('close', 0), 5); } };
  c.stderr = new EventEmitter(); c.kill = () => {};
  return c;
};
const got = [];
await new Promise((done) => {
  const v = new SystemVoice({ run, onAudio: (p, rate) => got.push([p.length, rate]), onEnd: done, onError: (e) => { throw new Error(e.message); } });
  v.say('One.'); v.say('[sad] Two.'); v.end();
});
assert.deepEqual(calls.map((c) => c.text), ['One.', 'Two.']);
assert.ok(calls.every((c) => c.bin === '/usr/bin/say' && !c.args.includes('One.') && c.args.includes('-f')));
assert.deepEqual(got, [[6, 22050], [6, 22050]]);
console.log('sysvoice tests: passed');
