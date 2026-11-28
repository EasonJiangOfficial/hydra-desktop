// The startup sound (owner, 2026-11-26: "there should be an audio when hydra starts up along with the loading
// animation"): one soft tone, once per app launch, with the launch logo. The sidecar asks once, at its start, with sound
// on and volume above zero (voiceturn.mjs startupCue), and the app plays the bundled file itself (afplay), so the tone
// never waits for the voice helper (voice on or off) and starts while the launch logo is up. The app (main.rs,
// startup.rs) keeps the once-per-launch latch, so a reload, a relay reconnect, a helper or sidecar restart, or a wake
// never plays it again. Open at Login and the setup guide's relaunch are launches too: they play it (orchestrator
// decision, 2026-11-26: "A login-item launch or a relaunch IS a startup").
// Nothing is played here.
// Run: npm test
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as turn from '../voiceturn.mjs';
const { startupCue } = turn;

const at = (p) => new URL(p, import.meta.url);

// ---- the WAV: format, length, silent ends, peak level measured, bytes pinned ----
const wav = readFileSync(at('../../../roamies/sounds/startup.wav'));
assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
assert.equal(wav.readUInt16LE(20), 1, 'PCM');
assert.equal(wav.readUInt16LE(22), 2, 'stereo');
assert.equal(wav.readUInt32LE(24), 48000, '48 kHz');
assert.equal(wav.readUInt16LE(34), 24, '24-bit');
assert.equal(wav.toString('ascii', 36, 40), 'data');
const bytes = wav.readUInt32LE(40), frames = bytes / 6;
assert.equal(frames, 57600, '1.2 s');
let peak = 0;
const sample = (i) => wav.readIntLE(44 + i * 3, 3);
for (let i = 0; i < frames * 2; i++) peak = Math.max(peak, Math.abs(sample(i)));
assert.equal(sample(0), 0); assert.equal(sample(1), 0);
assert.equal(sample(frames * 2 - 2), 0); assert.equal(sample(frames * 2 - 1), 0);
const peakDb = 20 * Math.log10(peak / 8388607);
assert.ok(peakDb > -20.2 && peakDb < -19.8, `sample peak ${peakDb.toFixed(2)} dBFS, want -20`);
assert.equal(createHash('sha256').update(wav).digest('hex'), '36447f0f428b952ce0b08b9a801d6ac51e4db8d6af452ca454fb37ed3297bf3b');

// ---- the decision ----
const on = { mac: true, sound: true, volume: 80 };
assert.deepEqual(startupCue(on), { type: 'cue', name: 'startup', v: 0.8 });
assert.deepEqual(startupCue({ ...on, volume: 100 }), { type: 'cue', name: 'startup', v: 1 });
assert.equal(startupCue({ ...on, mac: false }), null, 'Mac only');
assert.equal(startupCue({ ...on, sound: false }), null, 'the sound switch');
assert.equal(startupCue({ ...on, volume: 0 }), null, 'volume 0');
// No helper wait and no fallback clock: the tone does not depend on the voice helper.
assert.equal(turn.STARTUP_FALLBACK_MS, undefined, 'no fallback timer');
assert.equal(turn.startupFallbackDelay, undefined);

// ---- the wiring: asked exactly once, at the sidecar's start, right after the settings are read (a sidecar restart
// asks again; the app drops it). Never from voice_ready, a reload, a relay reconnect or a wake. ----
const side = readFileSync(at('../sidekick.mjs'), 'utf8');
assert.equal(side.match(/startupCue\(/g).length, 1, 'one call');
// The raw file runs too (a debug build without dist/ falls back to it, sidecar.rs): MAC is declared before any use,
// so loading it never throws "Cannot access 'MAC' before initialization" before the startup cue is sent.
assert.equal(side.match(/\bMAC\b/).index, side.indexOf("\nconst MAC = process.platform === 'darwin';\n") + '\nconst '.length, 'MAC declared before its first use');
assert.ok(!/askStartupCue|startupCueSent|ROAMIES_SPAWN_AFTER_MS/.test(side), 'no second ask path, no flag, no fallback clock');
// Right after the settings are read, at top level, before the first top-level await (refreshAuth, syncLocal,
// catalogs.load can each wait seconds): the live run below proves it with a 10 s refreshAuth.
const ask = side.indexOf("\n{ const cue = startupCue({ mac: MAC, sound: !!config.sound, volume: volumeNow() }); if (cue) send(cue); }\n");
const read = side.indexOf('const saved = readJson(CONFIG_PATH');
assert.ok(read > 0 && ask > read && side.indexOf('\n}\n', read) < ask, 'asked right after the config block');
assert.ok(ask < side.search(/\nawait /), 'asked before the first top-level await');
const onVoice = side.slice(side.indexOf('function onVoice(m) {'), side.indexOf('\n}\n', side.indexOf('function onVoice(m) {')));
assert.ok(!/startup/i.test(onVoice), 'voice_ready (a helper restart, voice off/on) never asks');
for (const f of readdirSync(at('..')).filter((f) => f.endsWith('.mjs'))) {
  const src = readFileSync(at(`../${f}`), 'utf8');
  assert.ok(!/name: 'startup'/.test(src) || f === 'voiceturn.mjs', `${f} must not send the startup cue itself`);
}

// ---- the app's latch, and the app plays it ----
const rs = readFileSync(at('../../src-tauri/src/main.rs'), 'utf8');
const arm = rs.slice(rs.search(/Some\("cue"\) if msg\.get\("name"\)\.and_then\(Value::as_str\) == Some\("startup"\) => \{/), rs.indexOf('Some("cue") => to_voice'));
assert.ok(arm.length > 0, 'the startup cue has its own arm, before any other cue');
assert.match(arm, /startup::drop_reason\(done, since\)/, 'through the launch latch');
assert.match(arm, /"\/usr\/bin\/afplay"/, 'the app plays the bundled file');
assert.ok(!/to_voice|via_helper/.test(arm), 'never handed to the voice helper, so it never waits for it');
// The app's log line says what afplay did, after it ran (played, or why not); a missing resource dir is logged too.
assert.ok(!/played by the app/.test(arm), 'no "played" line before afplay has run');
assert.match(arm, /thread::spawn\(move \|\| eprintln!\("\{\}", startup::afplay_line\(ms, c\.wait\(\)\.map\(\|s\| s\.code\(\)\)\.map_err\(\|e\| e\.to_string\(\)\)\)\)\)/);
assert.match(arm, /Err\(e\) => eprintln!\("startup cue: not played \(no resource dir: \{e\}\)"\)/);
assert.match(arm, /join\("sounds"\)\.join\("startup\.wav"\)/);
assert.ok(!/ROAMIES_SPAWN_AFTER_MS/.test(readFileSync(at('../../src-tauri/src/sidecar.rs'), 'utf8')), 'no fallback clock');
assert.match(rs, /static STARTUP_CUE_DONE: AtomicBool/);
// Open at Login and the setup guide's relaunch are startups: every launch gets the one tone, nothing makes one quiet.
assert.ok(!/QUIET_LAUNCH|launched_as_login_item|relaunch_marker/.test(rs), 'no quiet launch');
assert.match(rs, /fn relaunch\(app: AppHandle\) \{\n    app\.restart\(\);\n\}/);
assert.match(rs, /let _ = LAUNCHED\.set\(Instant::now\(\)\);\n            spawn_sidecar\(app\.handle\(\)\);/, 'the clock starts just before the sidecar');
const st = readFileSync(at('../../src-tauri/src/startup.rs'), 'utf8');
assert.match(st, /pub\(crate\) const WINDOW: Duration = Duration::from_secs\(6\);/);
assert.match(st, /pub\(crate\) fn drop_reason\(done: bool, since_launch: Duration\) -> Option<&'static str>/);
assert.ok(!/quiet|marker/i.test(st), 'startup.rs has no quiet-launch rule');
assert.match(st, /pub\(crate\) fn afplay_line\(ms: u128, wait: Result<Option<i32>, String>\) -> String/);
assert.ok(!/via_helper/.test(st), 'one player: the app');
// The voice helper is not a startup-sound player (its cue list is unchanged).
const swift = readFileSync(at('../../src-tauri/voice/main.swift'), 'utf8');
assert.match(swift, /\["wake", "listen"\]\.contains\(n\)/);
assert.ok(!/startup cue/.test(swift));
assert.ok(!/startup/.test(readFileSync(at('../../../roamies/sfx.js'), 'utf8')), 'the overlay never plays it');

// ---- the real sidecar: a slow sign-in check (a locked Keychain, an unreachable local model server) never holds the
// cue past the app's 6 s window. sidekick.mjs runs as is, with refreshAuth stubbed to take 10 s (a load hook), in an
// empty home folder, no hands helper (so no Keychain) and a PATH whose afplay, say, osascript and security do nothing.
// The cue must reach stdout within 1 s of the spawn; the process is killed as soon as it does. ----
{
  const home = mkdtempSync(path.join(os.tmpdir(), 'startupcue-'));
  const bin = path.join(home, 'bin');
  mkdirSync(bin);
  for (const b of ['afplay', 'say', 'osascript', 'security', 'open']) { writeFileSync(path.join(bin, b), '#!/bin/sh\nexit 0\n'); chmodSync(path.join(bin, b), 0o755); }
  const hooks = `export async function load(url, ctx, next) {
    const r = await next(url, ctx);
    if (!url.endsWith('/sidekick.mjs')) return r;
    const src = String(r.source), at = 'async function refreshAuthNow() {';
    if (!src.includes(at)) throw new Error('refreshAuthNow not found: the stub would test nothing');
    return { ...r, source: src.replace(at, at + ' await new Promise((ok) => setTimeout(ok, 10_000));') };
  }`;
  const reg = `import { register } from 'node:module'; register(${JSON.stringify('data:text/javascript,' + encodeURIComponent(hooks))});`;
  const side = fileURLToPath(at('../sidekick.mjs'));
  const t0 = Date.now();
  const child = spawn(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(reg), side], {
    cwd: path.dirname(side),
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, USERPROFILE: home, ROAMIES_DATA_DIR: home, ROAMIES_HANDS: '', TMPDIR: home },
  });
  const cue = await new Promise((resolve) => {
    let buf = '';
    const done = (v) => { clearTimeout(timer); child.kill('SIGKILL'); resolve(v); };
    const timer = setTimeout(() => done(null), 3000);
    child.stdout.on('data', (d) => {
      buf += d;
      for (const line of buf.split('\n')) { try { const m = JSON.parse(line); if (m.type === 'cue' && m.name === 'startup') return done({ m, ms: Date.now() - t0 }); } catch {} }
    });
    child.on('exit', () => done(null));
  });
  rmSync(home, { recursive: true, force: true });
  if (process.platform === 'darwin') {
    assert.ok(cue, 'the startup cue was sent while refreshAuth was still running (10 s)');
    assert.deepEqual(cue.m, { type: 'cue', name: 'startup', v: 1 });
    assert.ok(cue.ms < 1000, `cue sent ${cue.ms} ms after spawn, want under 1 s`);
    console.log(`startupcue: cue sent ${cue.ms} ms after spawn with a 10 s refreshAuth`);
  } else assert.equal(cue, null, 'Mac only');
}

console.log('startupcue: all passed');
