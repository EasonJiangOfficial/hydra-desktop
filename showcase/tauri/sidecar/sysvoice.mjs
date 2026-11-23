// Hydra's voice until a Fish Audio key is added: the Mac's own speech (`say`), rendered on this Mac, nothing sent
// anywhere. The same shape as the speaker's local voice (speaker.mjs startLocal): say(sentence) as they come, end(),
// abort(); audio comes back as 16-bit mono PCM chunks through onAudio(pcm, rate), one per sentence.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const SYSTEM_RATE = 22050;

/** The PCM samples of a WAVE file (its "data" chunk), or null. */
export function wavPcm(buf) {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  for (let i = 12; i + 8 <= buf.length;) {
    const id = buf.toString('ascii', i, i + 4), n = buf.readUInt32LE(i + 4);
    if (id === 'data') return buf.subarray(i + 8, Math.min(buf.length, i + 8 + n));
    i += 8 + n + (n & 1);
  }
  return null;
}

/**
 * 16-bit mono PCM brought to one loudness (W5 contract 6): the RMS of its sounding part (10 ms frames above -50 dBFS)
 * to `target` (about -18 dBFS), at most `maxGain` louder, and never past `peak`. Silence stays silent.
 */
export function levelPcm(pcm, { target = 0.125, maxGain = 8, peak = 0.89 } = {}) {
  const n = pcm.length >> 1;
  if (!n) return pcm;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = pcm.readInt16LE(2 * i) / 32768;
  const hop = 220;
  let sum = 0, count = 0, top = 0;
  for (let i = 0; i < n; i += hop) {
    let e = 0;
    const end = Math.min(n, i + hop);
    for (let j = i; j < end; j++) { e += x[j] * x[j]; top = Math.max(top, Math.abs(x[j])); }
    if (e / (end - i) > 1e-5) { sum += e; count += end - i; }
  }
  if (!count || !top) return pcm;
  const gain = Math.min(maxGain, target / Math.sqrt(sum / count), peak / top);
  if (Math.abs(gain - 1) < 0.02) return pcm;
  const out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * gain * 32768))), 2 * i);
  return out;
}

/** What's spoken of a line: voice cues ([warm]) and Markdown marks dropped. */
export const spokenText = (s) => String(s ?? '').replace(/\[[^\]]*\]\s*/g, '').replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim();

export class SystemVoice {
  constructor({ voice = null, onAudio, onEnd, onError, run = spawn, tmp = os.tmpdir() }) {
    Object.assign(this, { voice, onAudio, onEnd, onError, run, tmp });
    this.queue = []; this.ended = false; this.done = false; this.child = null; this.busy = false;
  }
  open() { return this; }
  /** done (optional): called once this sentence's audio has gone out (onAudio), before the next one's, as StudioVoice does. */
  say(text, done) { if (this.done) return; const t = spokenText(text); if (t) this.queue.push([t, done]); this.next(); }
  end() { this.ended = true; this.next(); }
  abort() { this.done = true; this.queue = []; this.child?.kill('SIGKILL'); this.child = null; }
  async next() {
    if (this.busy || this.done) return;
    const [text, said] = this.queue.shift() ?? [];
    if (text == null) { if (this.ended) { this.done = true; this.onEnd?.(); } return; }
    this.busy = true;
    const file = path.join(this.tmp, `hydra-say-${process.pid}-${Math.random().toString(36).slice(2)}.wav`);
    try {
      const out = await this.render(text, file);
      if (this.done) return;
      // One steady loudness for every sentence (W5 contract 6), whichever voice made it.
      if (out?.pcm?.length) this.onAudio?.(levelPcm(out.pcm), out.rate);
      said?.();
    } catch (e) {
      if (!this.done) { this.done = true; this.onError?.({ reason: 'error', message: `The Mac's voice failed: ${e.message}` }); }
      return;
    } finally {
      this.child = null; this.busy = false;
      fs.unlink(file).catch(() => {});
    }
    this.next();
  }
  /** One sentence as { pcm, rate }, made with the Mac's `say` into `file` (deleted by the caller). */
  async render(text, file) {
    await new Promise((resolve, reject) => {
      // The text goes in on stdin, never in the arguments (other processes can read those).
      const args = ['-o', file, '--file-format=WAVE', `--data-format=LEI16@${SYSTEM_RATE}`, '-f', '-', ...(this.voice ? ['-v', this.voice] : [])];
      const c = this.child = this.run('/usr/bin/say', args, { stdio: ['pipe', 'ignore', 'pipe'] });
      let err = '';
      c.stderr?.on('data', (d) => { err += d; });
      c.on('error', reject);
      c.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `say exited ${code}`))));
      c.stdin.end(text);
    });
    return { pcm: wavPcm(await fs.readFile(file)), rate: SYSTEM_RATE };
  }
}

/** The local voice's status for the speaker: always there on a Mac. */
export const systemStatus = async () => ({ ok: process.platform === 'darwin', reason: process.platform === 'darwin' ? null : 'offline', message: process.platform === 'darwin' ? '' : 'Only on a Mac.', engine: 'macOS', voices: [] });
