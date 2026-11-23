// Hydra's voice when this Mac has no Fish Audio key of its own (W3 contract): each sentence comes from Hydra's server
// (POST /api/voice/tts with the device key, which speaks with the server's Fish Audio key, as MP3), turned into PCM
// with macOS's afconvert. Not paired, or the server has no voice (503), or it fails: the Mac's own voice, as before.
// A 502 or 503 is tried once more, then this sentence uses the best installed Mac voice. The next sentence tries Fish again.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { SystemVoice, bestMacVoice, wavPcm } from './sysvoice.mjs';
import { FILLERS, PROGRESS } from './speaker.mjs';

export const SERVER_RATE = 44100;
// The opener and the progress lines are kept for the session, keyed by text and voice id, so a voice change
// never replays the previous avatar.
const kept = new Map();
const FILLER_SET = new Set([...FILLERS, ...PROGRESS]);
const sayList = () => new Promise((resolve) => {
  execFile('/usr/bin/say', ['-v', '?'], { timeout: 8_000 }, (e, out) => resolve(e ? '' : String(out ?? '')));
});

const afconvert = (from, to) => new Promise((resolve, reject) => {
  execFile('/usr/bin/afconvert', ['-f', 'WAVE', '-d', `LEI16@${SERVER_RATE}`, '-c', '1', from, to], { timeout: 20_000 }, (e) => (e ? reject(e) : resolve()));
});

export class HydraVoice extends SystemVoice {
  /** { api: { req }, paired(): boolean } from the sidecar; null: always the Mac's voice. */
  static server = null;
  /** The Fish voice id the server is using (the active avatar). Part of the cache key. */
  static voiceId = '';
  static listVoices = sayList;
  static _listed = undefined;
  static _fallbackLog = 0;
  static onTiming = null;
  static resetForTests() { kept.clear(); HydraVoice.voiceId = ''; HydraVoice._listed = undefined; HydraVoice._fallbackLog = 0; HydraVoice.onTiming = null; }
  static forget() { kept.clear(); }

  async render(text, file) {
    const s = HydraVoice.server;
    const key = `${HydraVoice.voiceId}\0${text}`;
    const keep = FILLER_SET.has(text) && !this.voice;
    if (keep && kept.has(key)) return kept.get(key);
    const out = await this.renderNow(text, file, s);
    if (keep && out?.pcm?.length) kept.set(key, out);
    return out;
  }

  async renderNow(text, file, s) {
    // A Mac voice the owner picked stays his pick; Hydra's server voice only stands in for the default one.
    if (!this.voice && s?.paired()) {
      try {
        const out = await this.fromServer(s, text, file);
        if (out) return out;
      } catch (e) {
        if (this.done) return null;
        console.error('[voice] Hydra server voice:', String(e?.message ?? e).slice(0, 120));
      }
    }
    return this.local(text, file);
  }

  /** The best installed Mac voice, once per process. */
  static async macVoice() {
    if (HydraVoice._listed !== undefined) return HydraVoice._listed;
    HydraVoice._listed = bestMacVoice(await HydraVoice.listVoices());
    return HydraVoice._listed;
  }

  async local(text, file) {
    const picked = this.voice || await HydraVoice.macVoice();
    if (!this.voice && picked && Date.now() - HydraVoice._fallbackLog > 60_000) {
      HydraVoice._fallbackLog = Date.now();
      console.error(`[voice] Fish voice unavailable; using the Mac voice ${picked}`);
    }
    const prev = this.voice;
    this.voice = picked;
    try { return await super.render(text, file); }
    finally { this.voice = prev; }
  }

  /** null when the server has no voice. A 502 or 503 is tried once more, then the Mac voice for this sentence. */
  async fromServer(s, text, file) {
    const t0 = Date.now();
    let r = await s.api.req('/api/voice/tts', { method: 'POST', body: { text: text.slice(0, 1000) }, timeout: 20_000, accept: 'audio/mpeg' });
    if (r.status === 502 || r.status === 503) r = await s.api.req('/api/voice/tts', { method: 'POST', body: { text: text.slice(0, 1000) }, timeout: 20_000, accept: 'audio/mpeg' });
    const fetchMs = Date.now() - t0;
    if (r.status === 502 || r.status === 503) { HydraVoice.onTiming?.({ fetchMs, convertMs: 0, chars: text.length, fallback: true }); return null; }
    if (!r.ok) throw new Error(`Hydra answered ${r.status}`);
    const c0 = Date.now();
    const mp3 = `${file}.mp3`;
    try {
      await fs.writeFile(mp3, Buffer.from(await r.arrayBuffer()));
      await (this.convert ?? afconvert)(mp3, file);
      HydraVoice.onTiming?.({ fetchMs, convertMs: Date.now() - c0, chars: text.length });
      return { pcm: wavPcm(await fs.readFile(file)), rate: SERVER_RATE };
    } finally { fs.unlink(mp3).catch(() => {}); }
  }
}
