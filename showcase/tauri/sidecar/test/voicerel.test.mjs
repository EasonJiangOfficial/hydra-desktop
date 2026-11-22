// Voice reliability (owner: "clapping and saying the keyphrase still barely work"; "when I hit change starting phrase
// the menu closes"), the desktop side, against fakes with a temp HOME:
// - Hydra's clap sensitivity and wake phrase from GET /api/agent/state when the server sends them, the Mac's own
//   values when an older one doesn't, and a change made on the Mac saved with PATCH;
// - the sleep word heard with numbers spelled out ("3 kill" is "three kill") and words joined or split;
// - the settings go to the voice helper once per change, and again when the helper starts;
// - the wake phrase is typed in place on the Listening page, and an ask while the orb is attached opens in the panel;
// - "Clap twice" and the live clap level are wired from the panel through the shell to the helper and back.
// The helper's own rules (one mic, the clap detector, the phrase matcher) are checked by its --test-* modes and
// measured by --bench / --bench-claps (voice/bench).
// Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { CLAP_LEVELS, SETTINGS_DEFAULTS, cleanSettings, createSettingsWatch, servedFields } from '../agentsettings.mjs';
import { cleanSleepWord, heardSleepWord } from '../power.mjs';

assert.ok(fs.realpathSync(os.homedir()).startsWith(fs.realpathSync(os.tmpdir())), 'runs with a temp HOME (test/run.mjs)');
const res = (status, body) => ({ status, ok: status >= 200 && status < 300, headers: new Headers(), json: async () => body });

// ---- Shared settings: clap sensitivity, what the server really sent, PATCH.
{
  assert.deepEqual(CLAP_LEVELS, { low: 0.2, medium: 0.5, high: 0.8 }, 'Low, Medium, High as the helper takes them');
  assert.equal(SETTINGS_DEFAULTS.clapSensitivity, null, 'none until Hydra sends one');
  assert.equal(cleanSettings({ settings: { clap_sensitivity: 'high' } }).clapSensitivity, 'high');
  assert.equal(cleanSettings({ settings: { clapSensitivity: 'low' } }).clapSensitivity, 'low', 'camelCase too');
  assert.equal(cleanSettings({ settings: { clap_sensitivity: 'loud' } }, { ...SETTINGS_DEFAULTS, clapSensitivity: 'medium' }).clapSensitivity, 'medium', 'a bad value keeps the last');
  assert.deepEqual([...servedFields({ settings: { wake_phrase: 'Hey Jarvis', sleep_word: 'Goodnight Hydra', clap_sensitivity: 'low', model: 'claude-opus-5-5' } })].sort(), ['clapSensitivity', 'sleepWord', 'wakePhrase']);
  assert.deepEqual([...servedFields({ settings: { model: 'claude-opus-5-5', effort_live: 'low' } })], [], 'an older server sends no voice fields: the Mac keeps its own');
  assert.deepEqual([...servedFields({ settings: { wake_phrase: 'x', clap_sensitivity: 'loud' } })], [], 'nor does a bad value count as sent');

  let answer = res(200, { settings: { model: 'claude-opus-5-5' } });
  const asked = [];
  const api = { req: async (p, o) => { asked.push({ p, method: o?.method ?? 'GET', body: o?.body }); return answer; } };
  const changes = [];
  const w = createSettingsWatch({ api, onChange: (n) => changes.push(n), setTimer: () => 1, clearTimer: () => {} });
  await w.start();
  assert.equal(w.served.size, 0, 'old server: nothing served');
  answer = res(200, { ok: true, settings: { wakePhrase: 'Okay Computer', clapSensitivity: 'high', sleepWord: 'Hydra, sleep', model: 'claude-opus-5-5' } });
  const p = await w.patch({ wakePhrase: 'Okay Computer' });
  assert.deepEqual(p, { ok: true, status: 200 });
  assert.deepEqual(asked.at(-1), { p: '/api/agent/state', method: 'PATCH', body: { wakePhrase: 'Okay Computer' } }, 'the contract\'s PATCH');
  assert.equal(w.current.wakePhrase, 'Okay Computer', 'the answer\'s full settings are taken');
  assert.equal(w.current.clapSensitivity, 'high');
  assert.ok(w.served.has('wakePhrase') && w.served.has('clapSensitivity'));
  assert.equal(changes.length, 1, 'and the change is applied once');
  answer = res(400, { error: 'invalid' });
  assert.deepEqual(await w.patch({ wakePhrase: 'x' }), { ok: false, status: 400 }, 'a refused value: told, nothing changed');
  assert.equal(w.current.wakePhrase, 'Okay Computer');
  answer = new Error('offline');
  api.req = async () => { throw answer; };
  assert.deepEqual(await w.patch({ clapSensitivity: 'low' }), { ok: false, status: 0 }, 'offline');
  w.stop();
}

// ---- The sleep word, as the voice helper hears it (numbers, joined and split words).
{
  assert.equal(heardSleepWord('Three kill.', '3 kill'), true, 'owner: "3 kill" works 1 in 10');
  assert.equal(heardSleepWord('3 kill', '3 kill'), true);
  assert.equal(heardSleepWord('3kill', '3 kill'), true);
  assert.equal(heardSleepWord('We killed three hours', '3 kill'), false);
  assert.equal(heardSleepWord('Good night, Hydra', 'Goodnight Hydra'), true, 'two words for one');
  assert.equal(heardSleepWord('Goodnight Hydra', 'Good night Hydra'), true, 'one for two');
  assert.equal(heardSleepWord('Good night everyone', 'Goodnight Hydra'), false);
  assert.equal(heardSleepWord('Hidra, sleep'), true, 'the default, a letter off');
  assert.equal(heardSleepWord('Hydra, open Sleep Cycle'), false);
  assert.deepEqual(cleanSleepWord('3 kill'), { ok: true, phrase: '3 kill' }, 'a number is a word');
}

// ---- The sidecar, the panel and the shell (source checks: these run in the app).
{
  const side = fs.readFileSync(new URL('../sidekick.mjs', import.meta.url), 'utf8');
  const panel = fs.readFileSync(new URL('../../../panel/panel.js', import.meta.url), 'utf8');
  const shell = fs.readFileSync(new URL('../../src-tauri/src/main.rs', import.meta.url), 'utf8');
  const voice = fs.readFileSync(new URL('../../src-tauri/src/voice.rs', import.meta.url), 'utf8');
  const helper = fs.readFileSync(new URL('../../src-tauri/voice/main.swift', import.meta.url), 'utf8');

  // Settings once per change (the log had "wake name: Hydra" and "wake phrase set" 127 times in an evening).
  assert.match(side, /const key = JSON\.stringify\(msg\);\n  if \(key !== voiceConfigSent\) \{ voiceConfigSent = key; send\(msg\); \}/, 'the same settings aren\'t sent again');
  assert.match(side, /m\.type === 'voice_ready'\) \{ micPick\(\); voiceHelperUp = true; voiceConfigSent = ''; voiceConfig\(\); \}/, 'a helper that starts again hears them all');
  assert.match(helper, /let was = WakeWord\.signature; let ok = WakeWord\.setPhrase\(p\); if !ok \{ log\("wake phrase refused"\) \} else if WakeWord\.signature != was \{ log\("wake phrase set"\) \}/, 'and the helper logs only a change');

  // Paired: Hydra's values, else the Mac's.
  assert.match(side, /const servedNow = \(field\) => !!hydraKey && !hydraRevoked && agentSettings\.served\.has\(field\);/);
  assert.match(side, /const clapSensitivity = \(\) => \(servedNow\('clapSensitivity'\) \? CLAP_LEVELS\[agentSettings\.current\.clapSensitivity\]/);
  assert.match(side, /clapSensitivity: clapSensitivity\(\), clapCal: config\.clapCalibration \?\? null,/, 'the owner\'s own claps reach the helper');

  // The wake phrase in place, never through ask() (it rendered on the orb, hidden while attached: the menu closed).
  const phraseAction = side.slice(side.indexOf("else if (id.startsWith('wakephrase:')"), side.indexOf("else if (id === 'clapcal'"));
  assert.ok(phraseAction.length > 100, 'the wakephrase action');
  assert.doesNotMatch(phraseAction, /ask\(/, 'no ask for the phrase');
  assert.match(phraseAction, /agentSettings\.patch\(\{ wakePhrase: r\.phrase \}\)/, 'saved in Hydra when paired');
  assert.doesNotMatch(side, /id === 'wakename'/, 'the old ask is gone');
  assert.match(panel, /function phraseRow\(v\) \{/);
  assert.match(panel, /el\('input', \{ type: 'text', value: ui\.phrase \?\? now, 'aria-labelledby': 'lbl-wakephrase', 'data-k': 'wakephrase'/);
  assert.match(panel, /if \(t && t !== now\) act\(`wakephrase:\$\{t\}`\)/);
  assert.doesNotMatch(panel, /Not while asleep/, 'the phrase wakes Hydra from sleep (W5 contract 4)');

  // Any ask while attached opens in the panel.
  assert.match(side, /const to = onboarding \? ob : !orbDetached\(\) \? panelAsk : ui;\n  if \(to === panelAsk\) send\(\{ type: 'panel_show' \}\);/);
  assert.match(panel, /else if \(m\.kind === 'ask'\) askSheet\(m\);\n    else if \(m\.kind === 'cancel_ask'\) closeAsk\(m\.id, true\);/);
  assert.match(panel, /answer\(i === 0 \? 'yes' : null\)/, 'a choice answers as the overlay does: the first is yes');
  assert.match(panel, /if \(askNow\) \{ const id = askNow\.id; closeAsk\(id, false\); send\(\{ type: 'answer', id, text: null \}\); \}/, 'the panel closing answers no');

  // "Clap twice" and the clap level, panel -> sidecar -> shell -> helper and back.
  assert.match(side, /else if \(id === 'clapcal' && MAC\) \{ clapCalibrating = true; send\(\{ type: 'voice_clap_calibrate' \}\);/);
  assert.match(shell, /Some\("voice_clap_calibrate"\) => to_voice\(app, &json!\(\{ "cmd": "clap_calibrate" \}\)\),/);
  assert.match(shell, /Some\("voice_clap_meter"\) => to_voice\(app, &json!\(\{ "cmd": "clap_meter", "on":/);
  assert.match(shell, /"cal": msg\.get\("clapCal"\)\.cloned\(\)\.unwrap_or\(Value::Null\)/);
  assert.match(helper, /case "clap_calibrate": DispatchQueue\.main\.async \{ voice\.calibrateClaps\(\) \}/);
  assert.match(voice, /Some\("clap_calibrated"\) \| Some\("clap_level"\) => \{/);
  assert.match(side, /m\.type === 'voice_clap_calibrated'\) \{\n    if \(m\.ok && Number\.isFinite\(m\.peakDb\) && Number\.isFinite\(m\.riseDb\)\) \{\n      config\.clapCalibration = /);
  assert.match(side, /m\.type === 'voice_clap_level' && panelOpen\) send\(\{ type: 'panel', msg: \{ kind: 'clap_level'/);
  assert.match(panel, /function meterWanted\(on\) \{ if \(on !== !!ui\.meter\) \{ ui\.meter = on; act\(on \? 'clapmeter:on' : 'clapmeter:off'\); \} \}/, 'the meter runs only while the Agent page shows');
  assert.match(panel, /el\('div', \{ className: 'clapmeter', id: 'clapmeter', role: 'meter'/);
  // Custom controls only: the panel draws its own (no checkbox, radio or range of the system's own look).
  assert.doesNotMatch(panel.slice(panel.indexOf('function phraseRow'), panel.indexOf('// The keys that work from anywhere.')), /type: '(?:checkbox|radio|range)'/);
}
console.log('voice reliability tests: passed');
