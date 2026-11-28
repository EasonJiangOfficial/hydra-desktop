// Audit 2026-11-26, 02 A1-A3 (lane A2). Owner: "make sure that when hydra agent triggers or talks it doesnt disable my
// mic on other apps like discord or make it so that I cant hear other audio sources".
// 1. Grep gate: the Swift helpers never write a shared audio setting (mute, volume, sample rate, buffer size, default
//    devices, hog mode, aggregates, the mute and volume keys). No write is allowed at all: not even an unmute, since the
//    old build's log never names the device it muted. The gate is also run on a fixed copy of the 5fbfc98 OutputMute
//    and must catch it there. Rust (src/) and every sidecar file are scanned for script mutes too. Bypass shapes the
//    earlier versions missed are cases.
// 2. The one-time move: "Mute Mac while talking" and "Interrupt by talking" (its echo cancellation ducks other apps,
//    02 A4) go off, the voice helper is never told to mute, and an owner whose log shows an older build ever muted is
//    told once how to turn the sound back on. Hydra never unmutes for him: it can't know which device, or whether the
//    mute is his own.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { noSystemMute, MUTE_NOTICE } from '../nosystemmute.mjs';
import { aboutHydra } from '../about.mjs';

const root = new URL('../../src-tauri/', import.meta.url);
const read = (rel) => fs.readFileSync(new URL(rel, root), 'utf8');
const swiftFiles = ['voice/', 'shared/', 'hands/'].flatMap((d) => fs.readdirSync(new URL(d, root)).filter((f) => f.endsWith('.swift')).map((f) => d + f));

/** Every shared-audio write in these Swift sources, as "file: what" (empty: clean). */
function audioWrites(files) {
  // Comments blanked with a string-aware pass (a "//" inside a string, such as a URL, hides nothing after it). `bare`
  // also blanks string contents, at the same offsets, for brace matching.
  const strip = (s) => {
    let code = '', bare = '';
    const strs = [];
    for (let i = 0; i < s.length;) {
      let end, isStr = false;
      if (s.startsWith('//', i)) { end = s.indexOf('\n', i); if (end < 0) end = s.length; }
      else if (s.startsWith('/*', i)) {
        // Swift block comments nest.
        let d = 0, j = i;
        while (j < s.length) {
          if (s.startsWith('/*', j)) { d++; j += 2; } else if (s.startsWith('*/', j)) { j += 2; if (--d === 0) break; } else j++;
        }
        end = Math.min(s.length, j);
      } else if (s[i] === '"' || (s[i] === '#' && /^#+"/.test(s.slice(i, i + 64)))) {
        // "...", """...""", and raw strings #"..."# (any number of #, no escapes but \#): "// inside one is not a comment.
        const hashes = s.slice(i).match(/^#*/)[0], open = s.startsWith('"""', i + hashes.length) ? '"""' : '"';
        const close = open + hashes;
        let j = i + hashes.length + open.length;
        while (j < s.length && !s.startsWith(close, j)) j += s[j] === '\\' && !hashes ? 2 : 1;
        end = Math.min(s.length, j + close.length); isStr = true;
      } else { code += s[i]; bare += s[i]; i++; continue; }
      const chunk = s.slice(i, end), blank = chunk.replace(/[^\n]/g, ' ');
      code += isStr ? chunk : blank; bare += blank; i = end;
      if (isStr) strs.push(chunk);
    }
    return { code, bare, strs };
  };
  // [start, end) of `head { ... }` in the source, by braces outside strings and comments.
  const block = (bare, head) => {
    const h = bare.indexOf(head); if (h < 0) return null;
    let d = 0;
    for (let i = bare.indexOf('{', h); i < bare.length; i++) { if (bare[i] === '{') d++; else if (bare[i] === '}' && --d === 0) return [h, i + 1]; }
    return [h, bare.length];
  };
  const cut = (src, [a, b], f) => src.slice(0, a) + f(src.slice(a, b)) + src.slice(b);
  const bad = [];
  for (const [name, src0] of Object.entries(files)) {
    // "a" + "b" (and #"a"# + #"b"#) joined first, so a name split in two strings is still that name.
    let { code: src, bare } = strip(src0.replace(/"#*\s*\+\s*#*"/g, ''));
    if (name.endsWith('nomute.swift')) {
      // The read-only hygiene check reads (names) mute, volume, sample rate and hog mode; every other check still runs on it.
      const hy = block(bare, 'enum AudioHygiene');
      if (hy) src = cut(src, hy, (t) => t.replace(/kAudioDevicePropertyMute|kAudioDevicePropertyVolumeScalar|kAudioDevicePropertyNominalSampleRate|kAudioDevicePropertyHogMode/g, ''));
    }
    for (const [re, what] of [
      [/\bAudioObjectSetPropertyData\b/, 'AudioObjectSetPropertyData'], [/\bAudioHardwareSetProperty\b/, 'AudioHardwareSetProperty'],
      [/\bAudioDeviceSetProperty\b/, 'AudioDeviceSetProperty'], [/\bAudioStreamSetProperty\b/, 'AudioStreamSetProperty'],
      [/\bAudioHardwareService\w*/, 'AudioHardwareService'], [/kAudioDevicePropertyMute/, 'system mute'],
      [/VolumeScalar|VolumeDecibels|Virtual\w*Volume/, 'volume'], [/NominalSampleRate/, 'sample rate'], [/BufferFrameSize/, 'buffer size'],
      [/HogMode/, 'hog mode'], [/CreateAggregate/, 'aggregate device'],
      // A setter looked up by name, and the keyboard's mute and volume keys (posted as system-defined events).
      [/\bdlsym\b/, 'dlsym'], [/NX_KEYTYPE_(MUTE|SOUND_UP|SOUND_DOWN)|\.systemDefined\b/, 'mute or volume key'],
      // A process tap (macOS 14.2+) can mute other apps' output; a capture device's format is the shared mic's.
      [/CATap\w*|ProcessTap|\bmuteBehavior\b/, 'process tap'], [/lockForConfiguration|\.active\w*Format\s*=/, 'shared mic format'],
      // An audio setting set by key (KVC) instead of by its property.
      [/forKey(Path)?:\s*"[^"]*(voiceProcessing|duck|mute|volume|sampleRate)/i, 'audio setting by key'],
      // A name spelled one character at a time (["s", "e", "t", ...].joined()).
      [/\[\s*"(\\.|[^"\\])"\s*(,\s*"(\\.|[^"\\])"\s*){3,}\]\s*\.\s*(joined|reduce)\b/, 'string built from characters'],
    ]) if (re.test(src)) bad.push(`${name}: ${what}`);
    // Scripts (osascript, a shell): the strings never set the volume or mute. Escapes, "\(\"lit\")" and runs of
    // whitespace are read as what they say. An interpolated word after "set" can't be read, so "set \(w)" followed by
    // what a volume command takes next (a number, output, input, with, another interpolation) is refused.
    const strs = strip(src).strs.map((s) => s
      .replace(/\\\(\s*"([^"]*)"\s*\)/g, '$1')
      .replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/\\[tnr0]/g, ' ').replace(/\s+/g, ' ')).join(' ');
    if (/set volume|output volume|input volume|output muted|SwitchAudioSource|setVolume/i.test(strs) || /SwitchAudioSource/.test(src)) bad.push(`${name}: volume or mute by script`);
    if (/\bset \\\([^)]*\)\s*(\d|\\\(|output\b|input\b|with\b)/i.test(strs)) bad.push(`${name}: a script "set" with an interpolated word`);
    // Voice processing (which ducks other apps) is turned on in one place only: Mic.open in voice/mic.swift, behind
    // the echo decision. Any other turn-on, here or in another file, is a new way to duck.
    const vpOn = (src.match(/setVoiceProcessingEnabled\s*\(\s*(?!false\s*\))/g) ?? []).length;
    if (vpOn > (name === 'voice/mic.swift' ? 1 : 0)) bad.push(`${name}: voice processing turned on (${vpOn})`);
    // Hydra's own AUHAL unit may pick its own input device (per process); no other AudioUnit property is set, with any
    // first argument (au.unit, unit!), and the setter is never passed around by name.
    const calls = [...src.matchAll(/\bAudioUnitSetProperty\s*\(\s*[^,]+,\s*([\w.]+)/g)];
    for (const m of calls) if (m[1] !== 'kAudioOutputUnitProperty_CurrentDevice') bad.push(`${name}: AudioUnitSetProperty ${m[1]}`);
    if ((src.match(/\bAudioUnitSetProperty\b/g) ?? []).length !== calls.length) bad.push(`${name}: AudioUnitSetProperty not called directly`);
    // Voice processing (Apple's echo cancellation) ducks other apps on macOS: only ever the least (Ducking, hydraout.swift).
    for (const m of src.matchAll(/voiceProcessingOtherAudioDuckingConfiguration\s*=\s*([^\n;]+)/g)) if (m[1].trim() !== 'Ducking.configuration') bad.push(`${name}: ducking set to ${m[1].trim()}`);
    for (const m of src.matchAll(/duckingLevel:\s*\.?(\w+)/g)) if (m[1] !== 'min') bad.push(`${name}: ducking level ${m[1]}`);
    if (/enableAdvancedDucking:\s*true/.test(src)) bad.push(`${name}: advanced ducking`);
    if (/kAUVoiceIOProperty_\w+/.test(src)) bad.push(`${name}: voice I/O unit property`);
  }
  return bad;
}

// The 5fbfc98 helper's OutputMute (voice/main.swift:324-368), kept here so the check never depends on git history.
const OLD_OUTPUT_MUTE = `enum OutputMute {
    private static var device: AudioDeviceID?
    static var enabled = true

    private static func addr(_ sel: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: sel, mScope: scope, mElement: kAudioObjectPropertyElementMain)
    }
    private static func set(_ dev: AudioDeviceID, _ on: Bool) -> Bool {
        var a = addr(kAudioDevicePropertyMute, kAudioDevicePropertyScopeOutput)
        var v: UInt32 = on ? 1 : 0
        return AudioObjectSetPropertyData(dev, &a, 0, nil, UInt32(MemoryLayout<UInt32>.size), &v) == noErr
    }
    static func begin() {
        guard shouldMute(enabled: enabled, hydraPlaying: hydraPlaying()), device == nil, let dev = defaultOutput(), muted(dev) == false else { return }
        if set(dev, true) { device = dev; log("output muted while listening") }
    }
    static func end() {
        guard let dev = device else { return }
        device = nil
        // Unmute only if it's still muted: the user may have unmuted by hand meanwhile.
        if muted(dev) == true, set(dev, false) { log("output restored") }
    }
}
`;

// ---- 1. The gate: clean now, it catches the old OutputMute, and the shapes that got past the earlier versions.
{
  const now = Object.fromEntries(swiftFiles.map((f) => [f, read(f)]));
  assert.ok(Object.keys(now).includes('voice/nomute.swift') && Object.keys(now).includes('voice/main.swift'));
  assert.deepEqual(audioWrites(now), [], 'no shared-audio write in the Swift helpers');
  const all = Object.values(now).join('\n');
  assert.doesNotMatch(all, /OutputMute|MuteRestore|--restore-mute/, 'OutputMute and the unmute are gone');
  assert.doesNotMatch(all, /AudioObjectSetPropertyData\(/, 'no CoreAudio property write at all');
  const caught = audioWrites({ 'voice/main.swift': OLD_OUTPUT_MUTE });
  assert.ok(caught.some((b) => /AudioObjectSetPropertyData/.test(b)) && caught.some((b) => /system mute/.test(b)), `the gate catches the old OutputMute (${caught})`);
  // Each shape must be caught (verifier probes, 2026-11-26).
  const nm = now['voice/nomute.swift'];
  for (const [what, src] of Object.entries({
    'a "//" in a string before a write': `let u = "https://x"; var v: UInt32 = 1; AudioObjectSetPropertyData(dev, &a, 0, nil, 4, &v)\n`,
    'a write after a block comment': `/* note */ AudioHardwareSetProperty(0, 4, &v)\n`,
    'a write after a nested block comment': `/* a /* b */ still a comment */ AudioHardwareSetProperty(0, 4, &v)\n`,
    'a "// in a raw string before a write': `let s = #"a"//"#; var v: UInt32 = 1; AudioObjectSetPropertyData(dev, &a, 0, nil, 4, &v)\n`,
    'a "/* in a raw string, a write, then */ in another': `let s = #"a"/*"#\nAudioObjectSetPropertyData(dev, &a, 0, nil, 4, &v)\nlet t = #"*/"#\n`,
    'a write after a ##raw## string with "# inside': `let s = ##"a"#//"##; AudioObjectSetPropertyData(dev, &a, 0, nil, 4, &v)\n`,
    'an AudioUnit property on a member': `AudioUnitSetProperty(au.unit, kAUVoiceIOProperty_BypassVoiceProcessing, kAudioUnitScope_Global, 0, &v, 4)\n`,
    'an AudioUnit property through a force unwrap': `AudioUnitSetProperty(unit!, kAudioDevicePropertyBufferFrameSize, kAudioUnitScope_Global, 0, &v, 4)\n`,
    'the setter passed by name': `let f = AudioUnitSetProperty; _ = f(u, kAudioOutputUnitProperty_CurrentDevice, 0, 0, &v, 4)\n`,
    'the setter looked up by a split name': `let f = dlsym(h, "AudioObjectSet" + "PropertyData")\n`,
    'the setter looked up in raw strings': `let f = dlsym(h, #"AudioHardware"# + #"SetProperty"#)\n`,
    'the mute key posted': `let e = NSEvent.otherEvent(with: .systemDefined, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: 0, context: nil, subtype: 8, data1: (Int(NX_KEYTYPE_MUTE) << 16) | (0xa << 8), data2: -1)\n`,
    'a volume key by name': `let k = NX_KEYTYPE_SOUND_DOWN\n`,
    'AudioHardwareService volume': `AudioHardwareServiceSetPropertyData(dev, &a, 0, nil, 4, &vol)\n`,
    'virtual main volume': `var a = addr(kAudioHardwareServiceDeviceProperty_VirtualMainVolume)\n`,
    'osascript split in two strings': `p.arguments = ["-e", "set " + "volume output volume 10"]\n`,
    'osascript mute in three strings': `p.arguments = ["-e", "set volume with " + "output " + "muted"]\n`,
    'osascript in a raw string': `p.arguments = ["-e", #"set volume output volume 0"#]\n`,
    'JXA setVolume in a string': `p.arguments = ["-l", "JavaScript", "-e", "Application.currentApplication().setVolume(null, {outputMuted: true})"]\n`,
    'ducking at max': `input.voiceProcessingOtherAudioDuckingConfiguration = .init(enableAdvancedDucking: true, duckingLevel: .max)\n`,
    'ducking set some other way': `input.voiceProcessingOtherAudioDuckingConfiguration = loud\n`,
    'a default device written through a variable': `let f = AudioObjectSetPropertyData; _ = f(sys, &a, 0, nil, 4, &id)\n`,
    'an unmute in nomute.swift': `var a = addr(kAudioDevicePropertyMute, kAudioDevicePropertyScopeOutput)\nvar v: UInt32 = 0\n_ = AudioObjectSetPropertyData(dev, &a, 0, nil, 4, &v)\n`,
    // Verifier probes, round 3 (v-a2a4-r3/gate.mjs).
    'osascript with two spaces': `p.arguments = ["-e", "set  volume 0"]\n`,
    'osascript with a tab escape': `p.arguments = ["-e", "set\\tvolume 0"]\n`,
    'osascript with a unicode escape': `p.arguments = ["-e", "set\\u{20}volume 0"]\n`,
    'osascript with an interpolated word': `let w = "vol" + "ume"; p.arguments = ["-e", "set \\(w) 0"]\n`,
    'osascript with an interpolated literal': `p.arguments = ["-e", "set \\("volume") 0"]\n`,
    'osascript spelled in characters': `let s = ["s", "e", "t", " ", "v"].joined()\n`,
    'a process tap that mutes other apps': `let d = CATapDescription(stereoMixdownOfProcesses: []); d.muteBehavior = .muted; AudioHardwareCreateProcessTap(d, &tap)\n`,
    'the shared mic format changed': `try dev.lockForConfiguration(); dev.activeFormat = f\n`,
    'ducking set by key': `input.setValue(cfg, forKey: "voiceProcessingOtherAudioDuckingConfiguration")\n`,
    'voice processing turned on somewhere new': `try input.setVoiceProcessingEnabled(true)\n`,
    'voice processing turned on through a variable': `try input.setVoiceProcessingEnabled(on)\n`,
  })) {
    assert.notDeepEqual(audioWrites({ 'voice/x.swift': src }), [], `the gate catches: ${what}`);
    assert.notDeepEqual(audioWrites({ 'voice/nomute.swift': nm + '\n' + src }), [], `the gate catches in nomute.swift: ${what}`);
  }
  // mic.swift's one turn-on is allowed; a second one is not.
  assert.deepEqual(audioWrites({ 'voice/mic.swift': now['voice/mic.swift'] }), []);
  assert.notDeepEqual(audioWrites({ 'voice/mic.swift': now['voice/mic.swift'] + '\nfunc again() { try? eng.inputNode.setVoiceProcessingEnabled(true) }\n' }), [], 'a second turn-on in mic.swift');
  // Raw strings and comments don't hide real code from the gate, nor make it see code that isn't there.
  assert.deepEqual(audioWrites({ 'voice/x.swift': 'let r = #"(?i)\\b(volume)\\b"#\n/* /* AudioObjectSetPropertyData */ */\n// kAudioDevicePropertyMute\nlet u = "https://x"\n' }), [], 'comments are skipped');
  const hy = nm.indexOf('enum AudioHygiene');
  assert.notDeepEqual(audioWrites({ 'voice/nomute.swift': nm.slice(0, hy) + nm.slice(hy).replace('return s\n', 'AudioObjectSetPropertyData(0, &a, 0, nil, 4, &v); return s\n') }), [], 'AudioHygiene never writes');
  assert.notDeepEqual(audioWrites({ 'voice/nomute.swift': nm + '\nfunc later() { var a = addr(kAudioDevicePropertyMute, 0); _ = a }\n' }), [], 'code after AudioHygiene is checked');
  // Rust (src/) and every sidecar file (subfolders too, tests aside): no volume or mute by script, no CoreAudio setter.
  const script = /set volume|output volume|input volume|output muted|SwitchAudioSource|\.setVolume\s*\(|AudioObjectSetPropertyData|AudioHardwareSetProperty|AudioHardwareService/i;
  const rsDir = new URL('src/', root);
  for (const f of fs.readdirSync(rsDir).filter((f) => f.endsWith('.rs'))) assert.doesNotMatch(fs.readFileSync(new URL(f, rsDir), 'utf8'), script, `src/${f}: no volume or mute by script`);
  const sideDir = fileURLToPath(new URL('../', import.meta.url));
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? (['node_modules', 'test', 'dist'].includes(e.name) ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)]);
  const side = walk(sideDir).filter((f) => /\.(m?js|cjs|sh|applescript|scpt)$/.test(f));
  assert.ok(side.some((f) => f.endsWith(`${path.sep}beats${path.sep}make.mjs`)), 'subfolders are scanned');
  for (const f of side) {
    let t = fs.readFileSync(f, 'utf8');
    // nosystemmute.mjs reads the old helper's log line by name.
    if (f.endsWith(`${path.sep}nosystemmute.mjs`)) t = t.replace("const MUTED = 'output muted while listening'", '');
    assert.doesNotMatch(t, script, `${path.relative(sideDir, f)}: no volume or mute by script`);
  }
  assert.match('osascript -l JavaScript -e "Application(\'System Events\').setVolume(0)"', script, 'JXA setVolume is caught');
  // The Windows helpers (Rust): no endpoint volume or mute, no exclusive mode, no default-device switch, no volume key.
  const win = /SetMute|SetMasterVolume|SetChannelVolume|ISimpleAudioVolume|IAudioEndpointVolume|waveOutSetVolume|VK_VOLUME_|AUDCLNT_SHAREMODE_EXCLUSIVE|ShareMode::Exclusive|SetDefaultEndpoint|IPolicyConfig/;
  const rs = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? (e.name === 'target' ? [] : rs(path.join(d, e.name))) : e.name.endsWith('.rs') ? [path.join(d, e.name)] : []);
  const winFiles = ['voice-win/', 'hands-win/'].flatMap((d) => rs(fileURLToPath(new URL(d, root))));
  assert.ok(winFiles.some((f) => f.endsWith(`voice-win${path.sep}src${path.sep}audio.rs`)), 'the Windows voice helper is scanned');
  for (const f of winFiles) {
    const t = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(t, script, `${f}: no volume or mute by script`);
    assert.doesNotMatch(t, win, `${f}: no shared-audio write`);
  }
  assert.match('let ev: IAudioEndpointVolume = dev.Activate(CLSCTX_ALL, None)?; ev.SetMute(true, null)?;', win, 'a Windows mute is caught');
  // The webviews (overlay and panel) set only their own gain; they never run a script that mutes the Mac.
  const web = /osascript|SwitchAudioSource|output muted|output volume|input volume/i;
  const webDir = fileURLToPath(new URL('../../../', import.meta.url));
  const webFiles = ['roamies', 'panel'].flatMap((d) => fs.readdirSync(path.join(webDir, d)).filter((f) => f.endsWith('.js')).map((f) => path.join(webDir, d, f)));
  assert.ok(webFiles.some((f) => f.endsWith(`roamies${path.sep}host.js`)) && webFiles.some((f) => f.endsWith(`panel${path.sep}panel.js`)), 'the webviews are scanned');
  for (const f of webFiles) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), web, `${f}: no volume or mute by script`);
}

// ---- 2a. Nothing tells the helper to mute or unmute: no "mute" in voice_config, no mute command, no panel toggle.
// Interrupt by talking (voice processing, which ducks other apps on macOS) is off unless turned on, and says so.
{
  const side = fs.readFileSync(new URL('../sidekick.mjs', import.meta.url), 'utf8');
  const mainRs = read('src/main.rs'), voiceRs = read('src/voice.rs'), swift = read('voice/main.swift');
  const panel = fs.readFileSync(new URL('../../../panel/panel.js', import.meta.url), 'utf8');
  const about = fs.readFileSync(new URL('../about.mjs', import.meta.url), 'utf8');
  const vc = side.slice(side.indexOf("const msg = { type: 'voice_config'"), side.indexOf('\n', side.indexOf("const msg = { type: 'voice_config'")));
  assert.ok(vc.length > 40);
  assert.doesNotMatch(vc, /\bmute\s*:|muteMarker/, 'voice_config carries no mute and no unmute');
  assert.doesNotMatch(side, /MUTE_MARKER|muteMarker|output-muted/, 'no unmute marker');
  assert.doesNotMatch(mainRs + voiceRs, /"cmd": "mute"|"cmd": "restore_mute"|restore_mute|muteMarker|--restore-mute/, 'the app never asks the helper to mute or unmute');
  assert.doesNotMatch(swift, /case "mute":|case "restore_mute":|--restore-mute|--test-mute-restore/, 'the helper has no mute or unmute');
  assert.doesNotMatch(panel, /mutetalk|Mute Mac while talking/, 'the panel toggle is gone');
  assert.doesNotMatch(about, /Mute Mac While Talking/i, 'the agent is not told about the removed setting');
  // No comment or doc still describes mute-while-listening (it is gone), and the cue header reads as a sentence.
  const host = fs.readFileSync(new URL('../../../roamies/host.js', import.meta.url), 'utf8');
  const sounds = fs.readFileSync(new URL('./sounds.test.mjs', import.meta.url), 'utf8');
  const bridge = fs.readFileSync(new URL('../../../../docs/BRIDGE.md', import.meta.url), 'utf8');
  for (const [f, s] of Object.entries({ 'src/main.rs': mainRs, 'roamies/host.js': host, 'test/sounds.test.mjs': sounds, 'docs/BRIDGE.md': bridge })) assert.doesNotMatch(s, /mute[- ]while/i, `${f}: no stale mute-while-listening`);
  assert.doesNotMatch(bridge, /other audio never ducked/, 'BRIDGE.md does not claim echo cancellation never ducks');
  assert.match(read('voice/cue.swift'), /sees every trigger with its source\. Listen and wake are/, 'the cue.swift header is whole');
  assert.doesNotMatch(side, /config\.muteWhileTalking = config\.muteWhileTalking === false/, 'mutetalk no longer flips it');
  assert.match(side, /muteWhileTalking: false/, 'off by default');
  assert.match(side, /const bargeOn = \(\) => MAC && config\.barge === true && !bargeUnavailable;/, 'interrupt by talking: off unless turned on');
  assert.match(mainRs, /"cmd": "barge", "on": msg\.get\("barge"\)\.and_then\(Value::as_bool\)\.unwrap_or\(false\)/, 'the app defaults it off');
  assert.match(swift, /static let bargeDefault = false/);
  // A barge command with no bool "on" leaves it off, like every other on/off command.
  assert.match(swift, /case "barge": let on = msg\["on"\] as\? Bool == true;/, 'the helper takes only a true "on" as on');
  // The label says how long: echo cancellation stays on through the take after Hydra speaks and 3 s after (echoWanted).
  assert.match(panel, /toggle\('Interrupt by talking'[^\n]*Turns other apps\\' sound down while Hydra talks and while you answer it/, 'the toggle names the ducking, all of it');
  assert.match(about, /turns other apps' sound down while you speak and while the owner answers you/, 'the agent says the same');
  // The agent tells the owner the truth about talking over it: that needs Interrupt by talking, off by default.
  const on = aboutHydra({ name: 'Hydra', mac: true, snap: true, voice: true, hotkeys: true, wake: true, barge: true });
  const off = aboutHydra({ name: 'Hydra', mac: true, snap: true, voice: true, hotkeys: true, wake: true, barge: false });
  assert.match(on, /the owner talking over you, or a double clap even with Clap to talk off, stops you and starts listening/, 'barge on: a double clap interrupts too (Trigger.decide)');
  assert.doesNotMatch(off, /talking over you (\(or a double clap\) )?stops you/, 'barge off: talking over Hydra is not said to stop it');
  assert.match(off, /Talking over you does not stop you: that needs Interrupt by talking, which is off/);
  assert.match(side, /aboutHydra\(\{[^}]*barge: bargeOn\(\)/, 'the agent reads the setting');
  const moveAt = side.indexOf("const move = noSystemMute(config, { logDirs: [path.join(HOME, '.gg'), LOG_DIR], done: path.join(DATA_DIR, 'no-system-mute') });");
  assert.ok(moveAt > 0, 'the move runs once at start');
  // Before the first top-level await: stdin is already read there, and a ui_ready handled then must find the notice.
  const firstAwait = side.search(/^(await |(const|let|var) [^=\n]+= await )/m);
  assert.ok(firstAwait > 0 && moveAt < firstAwait, `the move runs before the first top-level await (${moveAt} < ${firstAwait})`);
  assert.ok(side.indexOf("process.stdin") < moveAt || side.indexOf('createInterface') < moveAt, 'the stdin listener is set up before the move');
  // The done file only after the config that says the move ran is on disk.
  assert.match(side.slice(moveAt), /^[^\n]*\n[^\n]*\n  if \(move\.save\) Promise\.resolve\(saveConfig\(\)\)\.then\(\(\) => \{ if \(readJson\(CONFIG_PATH\)\?\.noSystemMute\) move\.markDone\(\); \}\);\n  muteNotice = move\.notice;\n\}/, 'done is written after the save lands');
  // Told once, when the overlay is up to show it.
  assert.match(side, /if \(muteNotice\) \{ muteNotice = false; say\(MUTE_NOTICE, 'concerned'\); \}/, 'the notice is said once, on ui_ready');
}

// ---- 2b. The move itself, on a temp folder (never the real HOME).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nomute-'));
try {
  const logs = path.join(tmp, 'logs'); fs.mkdirSync(logs);
  const done = path.join(tmp, 'no-system-mute');
  const writes = [];
  const run = (config) => noSystemMute(config, { logDirs: [path.join(tmp, 'nogg'), logs], done, write: (p, s) => { writes.push(p); fs.writeFileSync(p, s); } });
  const log = (s, f = 'sidekick-voice.log') => fs.writeFileSync(path.join(logs, f), s);
  const fresh = () => { fs.rmSync(done, { force: true }); for (const f of ['sidekick-voice.log', 'sidekick-voice.log.old']) fs.rmSync(path.join(logs, f), { force: true }); };

  // The notice: what happened, that it no longer does, how to turn the sound back on. Never says it was undone.
  assert.match(MUTE_NOTICE, /Older Hydra builds muted your Mac's sound/);
  assert.match(MUTE_NOTICE, /Control Center/);
  assert.doesNotMatch(MUTE_NOTICE, /set volume|output volume|output muted/i);

  // A fresh install: off, no notice; once only.
  const res = (r) => ({ save: r.save, notice: r.notice });
  let c = { muteWhileTalking: false };
  let r = run(c);
  assert.deepEqual(res(r), { save: true, notice: false }); assert.equal(c.muteWhileTalking, false); assert.equal(c.noSystemMute, true); assert.equal(c.barge, false);
  // A quit before the caller's save lands: no done file yet, so the next start (config without the flag) runs it all again.
  assert.ok(!fs.existsSync(done), 'the move writes no done file itself');
  c = { muteWhileTalking: false, barge: true };
  assert.deepEqual(res(run(c)), { save: true, notice: false }); assert.equal(c.barge, false, 'a quit before the save: barge still goes off');
  r.markDone();
  assert.ok(fs.existsSync(done), 'the move is recorded beside the config, once the save landed');
  assert.deepEqual(res(run(c)), { save: false, notice: false }, 'once only');
  fresh();

  // Every old-build log that ever muted gets the notice, whatever came after: the log can't prove the Mac was put back.
  // Verifier probes: a helper killed mid-take, restarted by the app (its begin() skipped: already muted), then a reply
  // or the next take; a quick tap inside the chime's lift; a clean take; the mute only in the rotated .old file.
  for (const [what, text, f] of [
    ['killed mid-take', '[voice] output muted while listening\n[voice] output restored\n[voice] speech: analyzer\n[voice] output muted while listening\n'],
    ['crash, restart, reply', "[voice] speech: analyzer\n[voice] output muted while listening\n[voice] mic open (plain)\n[voice] Hydra's voice for this reply: output only\n"],
    ['crash, restart, next take', '[voice] output muted while listening\n[voice] mic open (plain)\n[voice] speech: analyzer\n[voice] sent what was said\n'],
    ['quick tap inside the chime lift', '[voice] speech: analyzer\n[voice] output muted while listening\n'],
    ['a clean take', '[voice] output muted while listening\n[voice] output restored\n'],
    ['the .old file', '[voice] output muted while listening\n', 'sidekick-voice.log.old'],
  ]) {
    log(text, f);
    c = { muteWhileTalking: true, barge: true };
    r = run(c);
    assert.deepEqual(res(r), { save: true, notice: true }, `${what}: told once`);
    assert.equal(c.muteWhileTalking, false); assert.equal(c.barge, false);
    // A quit before the save landed: told on the next start too, never lost.
    assert.deepEqual(res(run({ muteWhileTalking: true, barge: true })), { save: true, notice: true }, `${what}: not lost by a quit before the save`);
    r.markDone();
    assert.deepEqual(res(run(c)), { save: false, notice: false }, `${what}: never twice`);
    fresh();
  }
  // A log from a build that never muted: no notice.
  log('[voice] start\n[voice] speech: analyzer\n[voice] sent what was said\n');
  assert.deepEqual(res(run({})), { save: true, notice: false });
  fresh();
  // The config lost or reset (DEFAULTS, no flag): the done file keeps the notice from coming back.
  log('[voice] output muted while listening\n');
  c = {}; run(c).markDone();
  c = { muteWhileTalking: false };
  assert.deepEqual(res(run(c)), { save: true, notice: false }); assert.equal(c.noSystemMute, true);
  // Nothing but the done file is ever written: no marker, no unmute.
  assert.ok(writes.every((p) => p === done), `only the done file is written (${writes})`);
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }

console.log('nosystemmute: ok');
