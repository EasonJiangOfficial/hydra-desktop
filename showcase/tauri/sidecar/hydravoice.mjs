// Hydra's voice when this Mac has no Fish Audio key of its own (W3 contract): each sentence comes from Hydra's server
// (POST /api/voice/tts with the device key, which speaks with the server's Fish Audio key, as MP3), turned into PCM
// with macOS's afconvert. Not paired, or the server has no voice (503), or it fails: the Mac's own voice, as before.
// A 503 is remembered for ten minutes so every sentence doesn't ask again.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { SystemVoice, wavPcm } from './sysvoice.mjs';

export const SERVER_RATE = 44100;
const OFF_MS = 10 * 60_000;
let offUntil = 0;

const afconvert = (from, to) => new Promise((resolve, reject) => {
  execFile('/usr/bin/afconvert', ['-f', 'WAVE', '-d', `LEI16@${SERVER_RATE}`, '-c', '1', from, to], { timeout: 20_000 }, (e) => (e ? reject(e) : resolve()));
});

export class HydraVoice extends SystemVoice {
  /** { api: { req }, paired(): boolean } from the sidecar; null: always the Mac's voice. */
  static server = null;
  static resetForTests() { offUntil = 0; }

  async render(text, file) {
    const s = HydraVoice.server;
    // A Mac voice the owner picked stays his pick; Hydra's server voice only stands in for the default one.
    if (!this.voice && s?.paired() && Date.now() >= offUntil) {
      try {
        const out = await this.fromServer(s, text, file);
        if (out) return out;
      } catch (e) {
        if (this.done) return null;
        console.error('[voice] Hydra server voice:', String(e?.message ?? e).slice(0, 120));
      }
    }
    return super.render(text, file);
  }

  /** null when the server has no voice (503: the Mac's voice from now on, for a while). */
  async fromServer(s, text, file) {
    const r = await s.api.req('/api/voice/tts', { method: 'POST', body: { text: text.slice(0, 1000) }, timeout: 20_000, accept: 'audio/mpeg' });
    if (r.status === 503) { offUntil = Date.now() + OFF_MS; return null; }
    if (!r.ok) throw new Error(`Hydra answered ${r.status}`);
    const mp3 = `${file}.mp3`;
    try {
      await fs.writeFile(mp3, Buffer.from(await r.arrayBuffer()));
      await (this.convert ?? afconvert)(mp3, file);
      return { pcm: wavPcm(await fs.readFile(file)), rate: SERVER_RATE };
    } finally { fs.unlink(mp3).catch(() => {}); }
  }
}
