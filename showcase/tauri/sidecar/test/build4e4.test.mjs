// Desktop build 4 E4, sounds and the wake look (owner: "And the sound effects sometimes play randomly and it didn't play
// when I triggered the orb for listening"; "when I clap or say hey hydra there should be a sound effect that plays and
// the orb should change texture or color"; "when I wake hydra up from sleep it should go into listenting for my
// commands"; the pending experience; "I should be able to drag the orb and that automatically detaches it"). By
// behavior where the code can run here (the wake flow and orb taps on stubs, the progress cadence on a fake clock, the
// orb's drawing, the pending sound file), source checks for the wiring. The voice helper's own checks are its
// --test-cue; the bridge's are hydra.rs tests (cargo test).
// Run: npm test
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { FILLER_MS, PROGRESS_MS, pendingWanted, startProgress, wakeActions } from '../voiceturn.mjs';
import { FILLERS, PROGRESS } from '../speaker.mjs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const side = read('../sidekick.mjs'), host = read('../../../roamies/host.js'), agent = read('../../../roamies/agent.js');
const dither = read('../../../roamies/10-dither.js'), home = read('../../../roamies/agent-home.js'), tools = read('../../../roamies/agent-tools.js');
const cards = read('../../../roamies/agent-cards.js'), ink = read('../../../roamies/ink.js'), bridge = read('../../../../docs/BRIDGE.md');
const swift = read('../../src-tauri/voice/main.swift'), cue = read('../../src-tauri/voice/cue.swift'), mainRs = read('../../src-tauri/src/main.rs');
const voiceRs = read('../../src-tauri/src/voice.rs'), macConf = JSON.parse(read('../../src-tauri/tauri.macos.conf.json'));

// ---- Every wake opens a take at once, with the wake chime and no greeting (the phrase's take is already open).
{
  for (const why of ['clap', 'web', 'orb', 'panel', 'asked']) assert.deepEqual(wakeActions(why), { cue: true, listen: true, woke: why === 'clap' }, why);
  assert.deepEqual(wakeActions('phrase'), { cue: false, listen: false, woke: true }, "the phrase's own take listens, with its listen chime");
  assert.deepEqual(wakeActions('talk'), { cue: false, listen: false, woke: false }, 'a talk wake is a take');
  // The real power.onChange, run on stubs, for each wake source and the sleeps.
  const block = side.match(/\n  onChange: \(\{ asleep, why \}\) => \{\n([\s\S]*?)\n  \},\n\}\);/)[1];
  assert.doesNotMatch(block, /speakLine|at your service|listen_after/, 'no greeting, no wait for one');
  const run = (asleep, why) => {
    const sent = [], uis = [], web = [], said = [];
    vm.runInNewContext(block, {
      asleep, why, wakeActions, Date, logLine() {}, voiceConfig() {}, menu() {}, interruptQuietly() {}, asksAsleep() {}, speech: { stop() {} },
      send: (m) => sent.push(m), ui: (m) => uis.push(m), pushWeb: (m) => web.push(m), speakLine: (t) => said.push(t),
    });
    return JSON.parse(JSON.stringify({ sent, uis, web, said })); // out of the vm's realm
  };
  for (const why of ['clap', 'web', 'orb', 'panel']) {
    const r = run(false, why);
    assert.deepEqual(r.said, [], `${why}: nothing spoken`);
    assert.deepEqual(r.sent.filter((m) => m.type === 'listen'), [{ type: 'listen', via: 'wake', wait: 8 }], `${why}: a take opens at once`);
    assert.deepEqual(r.sent.filter((m) => m.type === 'cue'), [{ type: 'cue', name: 'wake' }], `${why}: one wake chime`);
    assert.equal(r.sent.findIndex((m) => m.type === 'cue') < r.sent.findIndex((m) => m.type === 'listen'), true, 'the chime first, so the take keeps it audible');
  }
  const ph = run(false, 'phrase');
  assert.deepEqual(ph.sent.filter((m) => m.type === 'listen' || m.type === 'cue'), [], 'the phrase: its take is already open');
  for (const why of ['clap', 'phrase']) {
    const r = run(false, why);
    assert.equal(r.web.length, 1); assert.equal(r.web[0].woke.from, why); assert.ok(Number.isInteger(r.web[0].woke.at));
    assert.deepEqual(r.uis.filter((m) => m.kind === 'woke'), [{ kind: 'woke', from: why }], `${why}: the overlay orb's burst`);
  }
  for (const why of ['web', 'orb', 'panel']) assert.deepEqual(run(false, why).web, [], `${why}: no wake burst on the web`);
  for (const why of ['sleep_word', 'idle', 'web']) {
    const r = run(true, why);
    assert.deepEqual(r.sent.filter((m) => m.type === 'listen' || m.type === 'cue'), [], `asleep (${why}): no take, no chime`);
    assert.deepEqual(r.web, []);
  }
  // A wake's take that hears nothing: Hydra stays awake, with no "I didn't hear anything" (the helper never reports it).
  assert.match(swift, /quietEmpty = via == "wake"/);
  assert.match(swift, /reportEmpty = shown && !failed && !quietEmpty/);
}

// ---- The router: the auto_listen 'wake' branch is reachable (it was after the catch-all), voice_trigger too, and
// an orb tap listens.
{
  const at = (re) => side.search(re);
  assert.ok(at(/m\.type === 'auto_listen' && m\.turn === 'wake'/) < at(/else if \(m\.type === 'auto_listen'\) \{/), "the 'wake' branch comes first");
  assert.equal([...side.matchAll(/m\.type === 'auto_listen' && m\.turn === 'wake'/g)].length, 1, 'one wake branch');
  assert.ok(at(/m\.type === 'voice_trigger'/) < at(/m\.type\?\.startsWith\('voice'\)\) onVoice\(m\)/), "voice_trigger before the voice* catch-all");
  const tap = side.match(/\n  else if \(m\.type === 'orb_listen'\) \{\n([\s\S]*?)\n  \}\n/)[1];
  const run = (m, asleep, voiceBusy) => {
    const sent = [], woke = [];
    vm.runInNewContext(tap, { m, voiceBusy, logLine() {}, send: (x) => sent.push(x), power: { asleep, wake: (f) => woke.push(f) } });
    return JSON.parse(JSON.stringify({ sent, woke }));
  };
  assert.deepEqual(run({ from: 'web' }, false, false).sent, [{ type: 'listen', via: 'orb' }], 'awake: a take, with the listen chime');
  assert.deepEqual(run({ from: 'web' }, false, true).sent, [{ type: 'listen_finish' }], 'mid-take: the take is sent (lane E fix round)');
  assert.deepEqual(run({ from: 'web' }, true, false), { sent: [], woke: ['web'] }, 'asleep: it wakes (and so listens)');
  assert.deepEqual(run({ from: 'orb' }, true, false).woke, ['orb']);
  assert.deepEqual(run({ from: 'evil' }, true, false).woke, ['web'], 'only web or orb');
  // The desktop orb: a click (under 6 px) asleep wakes, awake listens; a drag is a drag.
  assert.match(host, /Math\.hypot\(e\.clientX - p\[0\], e\.clientY - p\[1\]\) >= 6\) return;\n    send\(Roamie\.asleep \? \{ type: 'agent_power', on: true, from: 'orb' \} : \{ type: 'orb_listen', from: 'orb' \}\);/);
}

// ---- The listen and wake chimes play in the voice helper (never muted), only for the owner's own triggers.
{
  assert.match(swift, /if !dryRun \{ OutputMute\.begin\(\) \}\n        quietEmpty = via == "wake"\n[\s\S]{0,200}Cue\.pending\(false\)\n        if !dryRun \{ if Cue\.audible\(via: via\) \{ Cue\.play\("listen"\) \} else \{ Cue\.keepAudible\(\) \} \}/,
    'the chime plays as the mute begins, in the same process (it lifts the mute for its length)');
  assert.match(cue, /static func audible\(via: String\) -> Bool \{ \["clap", "phrase", "keys", "orb"\]\.contains\(via\) \}/);
  assert.match(cue, /OutputMute\.lift\(for: p\.duration \+ 0\.05\)/);
  assert.match(swift, /listenNow\(via: via\)/, 'a clap or barge take passes what started it');
  assert.match(swift, /\["orb", "wake"\]\.contains\(\$0\) \? \$0 : nil \} \?\? "listen"/, "the sidecar's listen: orb, wake, else a silent auto-listen");
  assert.match(swift, /case "sound": [^\n]*Cue\.soundOn = on/, 'the sound switch gates the cues');
  assert.match(swift, /Cue\.volume = \{ voice\.out\.volume \}/, "and Hydra's volume");
  assert.match(mainRs, /Some\("listen"\) => to_voice\(app, &json!\(\{ "cmd": "listen", "wait": [^\n]*"via": msg\.get\("via"\)/);
  assert.match(mainRs, /Some\("cue"\) => to_voice/); assert.match(mainRs, /Some\("pending"\) => to_voice/);
  assert.match(voiceRs, /cmd\.arg\("--sounds"\)\.arg\(dir\.join\("sounds"\)\)/);
  assert.equal(macConf.bundle.resources['../../roamies/sounds/'], 'sounds/', 'the WAVs ship with the app');
  assert.equal(macConf.bundle.resources['../sidecar/dist/'], 'sidecar/', 'the sidecar still ships');
}

// ---- Nothing else makes a sound the owner didn't cause.
{
  assert.doesNotMatch(dither, /\bS\(name\)/, 'acts are silent (the idle loop, emotes)');
  assert.match(dither, /const startAct = \(name\) => \{\n        if \(pres\.state !== 'shown'\) \{ pending = name; return; \}\n        act = /);
  assert.doesNotMatch(agent, /k\.S\('(toolstart|listen)'\)/);
  assert.doesNotMatch(tools, /S\('shutter'\)/);
  assert.doesNotMatch(cards, /'error'\)/, 'no error chime on a card step');
  assert.doesNotMatch(ink, /REM\.ticked\.set\(i\.id, t\); sfx\('done'\)/, 'a list push is silent');
  assert.doesNotMatch(home, /S\('(remind|done|error)'\)/, 'background agents are silent');
  assert.doesNotMatch(host, /play\('(listen|hydra_wake)'\)/);
  assert.doesNotMatch(read('../../../onboarding/onboarding.js'), /sfx\('listen'\)/, 'the setup window: one listen chime (the helper), not two');
  // Kept: heard, the sleep word, done for the owner's own tool turn, the sound switch (sounds.test.mjs).
  assert.match(host, /Roamie\.sfx\?\.play\('heard'\)/);
  assert.match(host, /if \(toolsRan && !e\.stopped\) Roamie\.sfx\?\.play\('done'\);/);
}

// ---- Progress lines every 5 to 6 s, the owner's phrases, never twice in a row.
{
  assert.ok(PROGRESS_MS >= 5000 && PROGRESS_MS <= 6000, 'every 5 to 6 s');
  for (const l of ['Checking it now.', 'Looking at it now.', 'Almost there.', 'Still on it.', 'One more second.']) assert.ok(PROGRESS.includes(l), l);
  assert.ok(PROGRESS.every((l) => !FILLERS.includes(l)));
  let t = 0, timers = [];
  const c = { now: () => t, setTimer: (f, ms) => { const h = { f, at: t + ms }; timers.push(h); return h; }, clearTimer: (h) => { timers = timers.filter((x) => x !== h); } };
  const advance = (ms) => { const end = t + ms; for (;;) { const n = timers.filter((h) => h.at <= end).sort((a, b) => a.at - b.at)[0]; if (!n) break; timers = timers.filter((h) => h !== n); t = n.at; n.f(); } t = end; };
  const said = [];
  let r = 0;
  const p = startProgress({ voice: { beat: () => { said.push(['beat', t]); return true; }, progress: (l) => { said.push([l, t]); return true; } }, live: () => true, random: () => (r = (r + 0.37) % 1), ...c });
  advance(FILLER_MS + PROGRESS_MS * 6);
  assert.deepEqual(said[0], ['beat', 1100], 'the opener at 1.1 s');
  assert.equal(said.length, 7);
  for (let i = 1; i < said.length; i++) {
    assert.equal(said[i][1] - said[i - 1][1], PROGRESS_MS, 'one each 5.5 s of quiet');
    if (i > 1) assert.notEqual(said[i][0], said[i - 1][0], 'never the same twice in a row');
  }
  p.stop();
  assert.match(bridge, /about 5\.5 s pass with nothing new/);
}

// ---- The pending sound: a spoken turn at work, until its answer; never over the owner or an ask.
{
  const base = { voice: true, busy: true, answerSaid: false, listening: false, asking: false };
  assert.equal(pendingWanted(base), true);
  for (const [k, v] of [['voice', false], ['busy', false], ['answerSaid', true], ['listening', true], ['asking', true]]) assert.equal(pendingWanted({ ...base, [k]: v }), false, `${k}: ${v}`);
  // Wiring: on at the turn's start, off at the first answer sentence, on again at a tool after it, off with the turn,
  // the owner's take and any yes/no; sent to the helper and the overlay on change only.
  assert.match(side, /pendingVoice = own \? voice : null; answerSaid = false; pendingNow\(\);/);
  assert.match(side, /voice\.say\(t\); if \(!answerSaid\) \{ answerSaid = true; pendingNow\(\); \}/);
  assert.match(side, /msg\.e\?\.type === 'tool' && answerSaid\) \{ answerSaid = false; pendingNow\(\); \}/);
  assert.match(side, /power\.busy\(\); \/\/ the 5 minutes[^\n]*\n    pendingVoice = null; pendingNow\(\);/);
  assert.match(side, /voiceBusy = m\.state === 'listening' \|\| m\.state === 'processing'; if \(m\.state === 'listening'\) takeAt = Date\.now\(\); stir\(\); pendingNow\(\);/);
  assert.match(side, /yesNoOpen\.set\(id, \{ a, to, voice \}\); pendingNow\(\);/);
  assert.match(side, /yesNoOpen\.delete\(id\); pendingNow\(\);/);
  assert.match(side, /if \(on === pendingSent\) return;\n  pendingSent = on;\n  send\(\{ type: 'pending', on \}\);\n  ui\(\{ kind: 'pending', on \}\);/);
  // The helper: 0.6 s in, 150 ms out, ducked under Hydra's voice, never while listening.
  assert.match(cue, /static let pendingDelay = 0\.6, pendingFadeIn = 0\.4, pendingFadeOut = 0\.15/);
  // The loop itself: 2.4 s, quiet (about -24 dBFS peak), no click at the loop point.
  const b = readFileSync(new URL('../../../roamies/sounds/pending.wav', import.meta.url));
  assert.equal(b.readUInt16LE(22), 2); assert.equal(b.readUInt32LE(24), 48000); assert.equal(b.readUInt16LE(34), 24);
  const n = b.readUInt32LE(40) / 6, s = (i) => b.readIntLE(44 + i * 6, 3) / 8388607;
  assert.equal(n, 2.4 * 48000);
  let pk = 0, step = 0;
  for (let i = 0; i < n; i++) { pk = Math.max(pk, Math.abs(s(i))); if (i) step = Math.max(step, Math.abs(s(i) - s(i - 1))); }
  assert.ok(Math.abs(20 * Math.log10(pk) + 24) < 0.5, `peak ${(20 * Math.log10(pk)).toFixed(1)} dBFS`);
  assert.ok(Math.abs(s(0) - s(n - 1)) <= step * 1.01, 'the loop point is as smooth as any other step');
  assert.ok(step < 0.002, 'no harsh transient');
}

// ---- The desktop orb: listening leans in, pending orbits on the pulse, talking pushes out; eased, never a snap; the
// wake burst; asleep pale and still.
{
  const R = {};
  globalThis.window = { Roamie: R };
  new Function(read('../../../roamies/hydra.js'))();
  const H = R.hydra;
  const draw = (st, rad = 12) => { const d = []; H.body({ dot: (x, y, r, shade) => d.push([x, y, r, shade]), L: 4 }, 50, 50, rad, { t: 1, dt: 0.016, ...st }); return d; };
  const mean = (d) => d.reduce((a, [x, y]) => a + Math.hypot(x - 50, y - 50), 0) / d.length;
  const rest = mean(draw({}));
  assert.ok(mean(draw({ mode: 'listen', heard: 0.3 })) < rest, 'listening leans inward');
  assert.ok(mean(draw({ mode: 'talk', voice: 0.9 })) > rest, 'talking pushes outward');
  const loud = draw({ mode: 'talk', voice: 1 }), soft = draw({ mode: 'talk', voice: 0.1 });
  assert.ok(mean(loud) > mean(soft), 'on its own output level');
  R.pendingAt = performance.now() - 1200; // the pulse's peak
  const peak = draw({ mode: 'think' });
  R.pendingAt = performance.now(); // its trough
  const low = draw({ mode: 'think' });
  assert.ok(mean(peak) > mean(low), 'pending swells on the pending pulse');
  assert.ok(Math.max(...peak.map(([x, y]) => Math.hypot(x - 50, y - 50))) > Math.max(...low.map(([x, y]) => Math.hypot(x - 50, y - 50))), 'its orbiting band reaches out');
  // A change of state eases over 250 ms: one frame later it has moved a little of the way, after 250 ms all of it.
  const st = { t: 1, dt: 0.016, mode: 'listen', heard: 0.3 };
  const k = (d) => ({ dot: (x, y, r, s) => d.push([x, y, r, s]), L: 4 });
  const a0 = []; H.body(k(a0), 50, 50, 12, st);
  st.mode = 'talk'; st.voice = 0.9;
  const a1 = []; H.body(k(a1), 50, 50, 12, st);
  const full = mean(draw({ mode: 'talk', voice: 0.9 })) - mean(a0);
  assert.ok(Math.abs(mean(a1) - mean(a0)) < Math.abs(full) * 0.2, 'no snap on the first frame');
  for (let i = 0; i < 16; i++) H.body({ dot() {}, L: 4 }, 50, 50, 12, st);
  const a2 = []; H.body(k(a2), 50, 50, 12, st);
  assert.ok(Math.abs(mean(a2) - mean(draw({ mode: 'talk', voice: 0.9, spin: st.spin }))) < Math.abs(full) * 0.05, 'there by 250 ms');
  // The wake burst: every dot full ink, the shell up to 10% out, a ring of dots outward; gone after 900 ms.
  R.pendingAt = null;
  R.wokeAt = performance.now() - 200;
  const burst = draw({});
  assert.ok(burst.length === 220 + 36, 'the ring');
  assert.ok(burst.slice(0, 220).every(([, , , s]) => s === 0), 'full ink');
  assert.ok(mean(burst.slice(0, 220)) > rest * 1.04 && mean(burst.slice(0, 220)) < rest * 1.11, 'the shell swells, at most 10%');
  assert.ok(burst.slice(220).every(([x, y]) => Math.hypot(x - 50, y - 50) <= 12 * 1.42), 'inside the patch the overlay redraws');
  R.wokeAt = performance.now() - 1000;
  assert.equal(draw({}).length, 220, 'over after 900 ms');
  // Asleep: pale and still, burst or not.
  const z1 = draw({ asleep: true, t: 1 }), z2 = draw({ asleep: true, t: 3 });
  assert.deepEqual(z1.map(([x, y]) => [x.toFixed(3), y.toFixed(3)]), z2.map(([x, y]) => [x.toFixed(3), y.toFixed(3)]));
  assert.ok(z1.every(([, , , s]) => s >= 0.75));
  // The overlay feeds it: the burst on 'woke', the pulse's phase on 'pending' (0.6 s: the helper's fade-in).
  assert.match(host, /m\.kind === 'pending'\) \{ Roamie\.pendingAt = m\.on \? performance\.now\(\) \+ 600 : null; return; \}/);
}

// ---- Drag to detach: the bridge's point reaches the overlay, the shell drops it when the button is let go.
{
  // setOrbMode, run for real against stubs (as orbmode.test.mjs does), with the drag the bridge passes on.
  const body = side.match(/const orbDetached = [^\n]+\nfunction setOrbMode[\s\S]*?\n}\n/)[0];
  const run = (detached, from, drag) => {
    const sent = [], uis = [];
    const ctx = { config: {}, saveConfig() {}, logLine() {}, ui: (x) => uis.push(x), send: (x) => sent.push(x), menu() {}, panel() {}, panelOpen: false, Number };
    vm.runInNewContext(`${body}\nsetOrbMode(${JSON.stringify(detached)}, ${JSON.stringify(from)}, ${JSON.stringify(drag ?? null)});`, ctx);
    return JSON.parse(JSON.stringify({ sent: sent.filter((x) => x.type === 'orb_drag'), uis: uis.filter((x) => x.kind === 'orb_drag'), detached: ctx.config.orbDetached }));
  };
  const d = run(true, 'web', { x: 812, y: 40 });
  assert.equal(d.detached, true);
  assert.deepEqual(d.uis, [{ kind: 'orb_drag', x: 812, y: 40 }], 'the overlay puts the orb under the cursor');
  assert.deepEqual(d.sent, [{ type: 'orb_drag' }], 'the shell watches the button');
  assert.deepEqual(run(true, 'web').sent, [], 'a plain detach');
  assert.deepEqual(run(true, 'web', { x: 'a', y: 1 }).uis, []);
  assert.deepEqual(run(false, 'drop', { x: 1, y: 1 }), { sent: [], uis: [], detached: false }, 'let go over the Hydra window: attached');
  assert.match(side, /m\.type === 'orb_set'\) setOrbMode\(!!m\.detached, m\.from \?\? 'web', m\.drag\);/);
  assert.match(mainRs, /if ORB_DRAG\.load\(Ordering::Relaxed\) && !left_button_down\(\) \{/);
  assert.match(mainRs, /if over_main_window\(&app, cur\) \{\n\s*to_sidecar\(&app, &json!\(\{ "type": "orb_set", "detached": false, "from": "drop" \}\)\);/);
  assert.match(host, /window\.__roamieOrbDrop = \(\) => \{ if \(Roamie\.orbDrag\) \{ Roamie\.orbDrag = false; getAgent\(\)\?\.carry\?\.\(false\); \} \};/);
  assert.match(agent, /carry: \(on, x, y\) => \{/);
  for (const w of ['listen?(): void', 'detach(drag?: { x: number; y: number; dragging: true })', "woke?: { at: number; from: 'clap' | 'phrase' }", 'drag=1&x=']) assert.ok(bridge.includes(w), `BRIDGE.md: ${w}`);
}

console.log('build 4 E4 (sounds and wake look): ok');
