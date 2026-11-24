// Desktop build 4 C7 (owner: "the agent speaks and is interupted by my laptop fans or sounds not by my speach for some
// reason"), the sidecar's side: a take over the last reply while it is still being said holds the reply instead of
// cutting it; the owner's words then keep it cut, and a take that hears no words (a noise opened it) lets the cut
// sentence go on, with no "I didn't hear anything" over it. By behavior (voiceturn.mjs) and by the wiring in
// sidekick.mjs. What may open such a take at all (two real words, a stop word or the wake phrase; a clean double clap)
// is the voice helper's: --test-triggers, --test-clap and --bench-claps.
// Run: npm test
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterHeld, createSpokenTrack, overReply, whileBusy } from '../voiceturn.mjs';

const side = readFileSync(new URL('../sidekick.mjs', import.meta.url), 'utf8');

// ---- the decisions
{
  assert.equal(overReply({ saying: true, voiceOn: true, via: 'clap' }), 'stop', 'a double clap cuts the reply being said');
  assert.equal(overReply({ saying: true, voiceOn: true, via: 'barge' }), 'hold', 'the talk-over check still holds it');
  assert.equal(overReply({ saying: false, voiceOn: true, via: 'clap' }), 'stop', 'nothing being said: nothing to hold');
  assert.equal(overReply({ saying: true, voiceOn: false, via: 'clap' }), 'stop', 'voice off: nothing plays, nothing to hold');
  // Second verify pass: a take the owner opened on purpose (talk keys, orb tap, the phrase, auto-listen) cuts the reply,
  // and its "I didn't hear anything" stays.
  for (const via of ['', undefined, 'keys', 'tap', 'phrase', 'listen']) assert.equal(overReply({ saying: true, voiceOn: true, via }), 'stop', `a ${via || 'keys/orb'} take cuts the reply`);
  assert.equal(afterHeld({ words: 'wait, what was that?' }), 'stop', 'the owner said something: the reply stays cut');
  assert.equal(afterHeld({ words: '' }), 'resume', 'no words: the reply goes on');
  assert.equal(afterHeld({ words: '   ' }), 'resume', 'blank words are none');
  assert.equal(afterHeld({}), 'resume', 'a take that ended with nothing');
  // Hydra's own words left in the mic after echo cancellation, heard in a check a fan opened: not the owner's.
  const reply = 'Your balance is four hundred dollars. The rent goes out on Friday.';
  assert.equal(afterHeld({ words: 'rent goes', reply }), 'echo', "two of Hydra's own words are its echo: the reply goes on");
  assert.equal(afterHeld({ words: 'The rent goes out.', reply }), 'echo');
  assert.equal(afterHeld({ words: 'wait', reply: 'Wait until Friday.' }), 'stop', 'a stop word is always the owner');
  assert.equal(afterHeld({ words: 'what rent', reply }), 'stop', 'a word that is not in the reply is the owner');
  // The spoken track keeps the reply's lines after a barge-in ended it, so the echo check still has them.
  const track = createSpokenTrack({ now: () => 0 });
  track.start('r1'); track.line('Your balance is four hundred dollars.'); track.audio({ id: 'r1', pcm: 'AAAA', rate: 16000 });
  track.interrupted();
  assert.match(track.said(), /four hundred dollars/, 'said() keeps the interrupted reply');
  track.start('r2');
  assert.equal(track.said(), '', 'a new reply starts empty');
  // While a turn runs it is still C1's add-on (the voice holds and goes on), never this path.
  assert.equal(whileBusy({ busy: true }), 'add_on');
}

// ---- the wiring
{
  assert.match(side, /else if \(m\.type === 'voice_state' && m\.state === 'listening'\) \{ addOnTake = false; const via = takeVia && Date\.now\(\) - takeVia\.at < 3000 \? takeVia\.via : ''; takeVia = null; cutTake = overReply\(\{ saying: saidPending, voiceOn: VOICE_ON\(\), via \}\) === 'hold'; if \(cutTake\) hush\(true\); else speech\.stop\(\);/,
    'a talk-over check holds the reply still being said; a clap and any other take cut it');
  assert.match(side, /if \(via === 'clap'\) \{ takeVia = null; speech\.stop\(\); \}/, 'a clap while a turn is open still cuts the speech');
  assert.match(side, /else if \(m\.type === 'voice_trigger'\) \{ logLine\('trigger', \{ via: m\.via \}\); takeVia = \{ via: String\(m\.via \?\? ''\), at: Date\.now\(\) \};/, 'the trigger says what opened the take');
  assert.doesNotMatch(side, /m\.state === 'listening'\) \{ addOnTake = false; speech\.stop\(\);/, 'the old cut is gone');
  assert.match(side, /else if \(m\.type === 'voice' && m\.text\?\.trim\(\)\) \{\n\s+const held = cutTake \? afterHeld\(\{ words: m\.text, reply: heardTrack\.said\(\) \}\) : null;\n\s+if \(held === 'stop'\) \{ cutTake = false; speech\.stop\(\); \}/,
    'the owner\'s words over the reply keep it cut');
  assert.match(side, /if \(held === 'echo'\) \{ logLine\('echo_words', \{ chars: m\.text\.trim\(\)\.length \}\); return; \}/, "Hydra's own words are dropped, never sent as a request");
  assert.match(side, /m\.state === 'idle'\) \{ addOnTake = false; hush\(false\);[^\n]*if \(snap\?\.waitingVoice\) snap\.waitingVoice = false; if \(cutTake\) resumeCut\(\); \}/, 'a take that heard nothing lets the reply go on');
  const resume = side.match(/function resumeCut\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.match(resume, /cutTake = false;/);
  assert.match(resume, /interruptedAfter = '';/, 'the next turn isn\'t told the reply was cut off');
  assert.match(resume, /logLine\('resumed', \{ by: 'no words' \}\);/, 'logged');
  assert.match(side, /else if \(m\.code === 'nothing_heard' && Date\.now\(\) - resumedAt < 3000\) logLine\('nothing_heard', \{ resumed: true \}\);\n\s+\/\/ While a turn runs/,
    'no "I didn\'t hear anything" over the reply that goes on');
}

console.log('build4c7 ok');
