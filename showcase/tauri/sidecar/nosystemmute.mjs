// Hydra never mutes the Mac (owner, 2026-11-26: "make sure that when hydra agent triggers or talks it doesnt disable my
// mic on other apps like discord or make it so that I cant hear other audio sources"). Builds before that muted the
// default output during each take ("Mute Mac while talking", on by default), and a voice helper killed mid-take left
// the Mac muted for good. Once, on the first start of a build without it: the setting goes off, "Interrupt by talking"
// goes off (the echo cancellation it needs turns other apps down while Hydra talks; the owner can turn it back on), and
// if the voice log shows an older build ever muted, the owner is told once how to turn the sound back on. Hydra never
// unmutes for him: the old log never names the device it muted, and a crash, a restart of the helper or a mute the
// owner set by hand all look alike in it (audit 2026-11-26, 02 A3). A `done` file next to the config keeps a lost or
// reset config from running the move (and the notice) again. The caller writes it (`markDone`) only once the config
// that says the move ran is on disk: written before, a quit in between would skip the move for good.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const MUTED = 'output muted while listening';
export const MUTE_NOTICE = "Older Hydra builds muted your Mac's sound while I listened. I never do that now. If your sound is still off, turn it back on in Control Center.";

/**
 * The one-time move. `logDirs`: where sidekick-voice.log may be; `done`: the file that says the move ran.
 * Returns { save: the caller saves the config, notice: tell the owner MUTE_NOTICE once, markDone: call once that save landed }.
 */
export function noSystemMute(config, { logDirs, done, read = (p) => readFileSync(p, 'utf8'), exists = existsSync, write = (p, s) => writeFileSync(p, s, { mode: 0o600 }) }) {
  const markDone = () => { try { write(done, `${new Date().toISOString()}\n`); } catch {} };
  if (config.noSystemMute) return { save: false, notice: false, markDone };
  config.noSystemMute = true;
  config.muteWhileTalking = false;
  if (exists(done)) return { save: true, notice: false, markDone };
  config.barge = false;
  let notice = false;
  for (const dir of logDirs) for (const f of ['sidekick-voice.log.old', 'sidekick-voice.log']) {
    const p = path.join(dir, f);
    if (!notice && exists(p)) { try { notice = read(p).includes(MUTED); } catch {} }
  }
  return { save: true, notice, markDone };
}
