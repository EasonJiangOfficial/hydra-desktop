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

/** What's spoken of a line: voice cues ([warm]) and Markdown marks dropped. */
export const spokenText = (s) => String(s ?? '').replace(/\[[^\]]*\]\s*/g, '').replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim();

export class SystemVoice {
  constructor({ voice = null, onAudio, onEnd, onError, run = spawn, tmp = os.tmpdir() }) {
    Object.assign(this, { voice, onAudio, onEnd, onError, run, tmp });
    this.queue = []; this.ended = false; this.done = false; this.child = null; this.busy = false;
  }
  open() { return this; }
  say(text) { if (this.done) return; const t = spokenText(text); if (t) this.queue.push(t); this.next(); }
  end() { this.ended = true; this.next(); }
  abort() { this.done = true; this.queue = []; this.child?.kill('SIGKILL'); this.child = null; }
  async next() {
    if (this.busy || this.done) return;
    const text = this.queue.shift();
    if (text == null) { if (this.ended) { this.done = true; this.onEnd?.(); } return; }
    this.busy = true;
    const file = path.join(this.tmp, `hydra-say-${process.pid}-${Math.random().toString(36).slice(2)}.wav`);
    try {
      const out = await this.render(text, file);
      if (this.done) return;
      if (out?.pcm?.length) this.onAudio?.(out.pcm, out.rate);
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
