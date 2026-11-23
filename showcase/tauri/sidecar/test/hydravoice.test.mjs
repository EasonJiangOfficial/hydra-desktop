// Hydra's server voice (POST /api/voice/tts with the device key) when the Mac has no Fish Audio key; the Mac's own
// voice when not paired or when the server has none (503, remembered for a while). Run: npm test
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HydraVoice, SERVER_RATE } from '../hydravoice.mjs';
import { SYSTEM_RATE } from '../sysvoice.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hydravoice-'));
const wav = (samples) => {
  const data = Buffer.alloc(samples * 2, 1);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(44100, 24); h.writeUInt32LE(88200, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
};
// The Mac's `say`: writes a 10-sample WAVE where -o points.
const said = [];
const run = (_cmd, args) => {
  const c = new EventEmitter();
  c.stderr = new EventEmitter();
  c.stdin = { end: (t) => { said.push(t); fs.writeFileSync(args[args.indexOf('-o') + 1], wav(10)); setImmediate(() => c.emit('close', 0)); } };
  return c;
};
const speak = (text, voice = null) => new Promise((resolve, reject) => {
  const got = [];
  const v = new HydraVoice({ voice, run, tmp, onAudio: (pcm, rate) => got.push([pcm.length, rate]), onEnd: () => resolve(got), onError: (e) => reject(new Error(e.message)) });
  v.convert = async (from, to) => { assert.ok(fs.readFileSync(from).length > 0, 'the MP3 was saved'); fs.writeFileSync(to, wav(20)); };
  v.say(text); v.end();
});

let status = 200;
const reqs = [];
const api = { req: async (p, o) => { reqs.push([p, o]); return { status, ok: status === 200, arrayBuffer: async () => new Uint8Array([0xff, 0xfb, 1, 2]).buffer }; } };
let paired = true;
HydraVoice.server = { api, paired: () => paired };
HydraVoice.listVoices = async () => 'Samantha (Premium)  en_US    # Hello\nAlex                en_US    # Hello\n';

// Paired: the server's voice.
assert.deepEqual(await speak('Hello sir.'), [[40, SERVER_RATE]]);
assert.equal(reqs[0][0], '/api/voice/tts');
assert.deepEqual(reqs[0][1].body, { text: 'Hello sir.' });
assert.equal(said.length, 0, 'the Mac\'s voice was not needed');
// The server fails once: that sentence in the Mac's voice, the next one tries the server again.
status = 500;
assert.deepEqual(await speak('One.'), [[20, SYSTEM_RATE]]);
status = 200;
assert.deepEqual(await speak('Two.'), [[40, SERVER_RATE]]);
// No voice on the server (503): one retry, then the Mac's voice. The next sentence tries Fish again.
status = 503;
const before = reqs.length;
assert.deepEqual(await speak('Three.'), [[20, SYSTEM_RATE]]);
assert.equal(reqs.length, before + 2, 'a 503 is tried once more');
status = 200;
assert.deepEqual(await speak('Four.'), [[40, SERVER_RATE]]);
HydraVoice.resetForTests();
// A Mac voice the owner picked: his voice, the server isn't asked.
const m = reqs.length;
assert.deepEqual(await speak('Picked.', 'Samantha'), [[20, SYSTEM_RATE]]);
assert.equal(reqs.length, m, 'a picked Mac voice stays his pick');
// Not paired: the Mac's voice, no request.
paired = false;
const n = reqs.length;
assert.deepEqual(await speak('Five.'), [[20, SYSTEM_RATE]]);
assert.equal(reqs.length, n);
fs.rmSync(tmp, { recursive: true, force: true });
console.log('hydravoice: ok');
