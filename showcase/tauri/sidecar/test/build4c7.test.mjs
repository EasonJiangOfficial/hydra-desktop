// Desktop build 4 C7 (owner: "the agent speaks and is interupted by my laptop fans or sounds not by my speach for some
// reason"), the sidecar's side: a take over the last reply while it is still being said holds the reply instead of
// cutting it; the owner's words then keep it cut, and a take that hears no words (a noise opened it) lets the cut
// sentence go on, with no "I didn't hear anything" over it. By behavior (voiceturn.mjs) and by the wiring in
// sidekick.mjs. What may open such a take at all (two real words, a stop word or the wake phrase; a clean double clap)
// is the voice helper's: --test-triggers, --test-clap and --bench-claps.
// Run: npm test
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterHeld, overReply, whileBusy } from '../voiceturn.mjs';

const side = readFileSync(new URL('../sidekick.mjs', import.meta.url), 'utf8');

// ---- the decisions
{
  assert.equal(overReply({ saying: true, voiceOn: true }), 'hold', 'a take over the reply being said holds it');
  assert.equal(overReply({ saying: false, voiceOn: true }), 'stop', 'nothing being said: nothing to hold');
  assert.equal(overReply({ saying: true, voiceOn: false }), 'stop', 'voice off: nothing plays, nothing to hold');
  assert.equal(afterHeld({ words: 'wait, what was that?' }), 'stop', 'the owner said something: the reply stays cut');
  assert.equal(afterHeld({ words: '' }), 'resume', 'no words: the reply goes on');
  assert.equal(afterHeld({ words: '   ' }), 'resume', 'blank words are none');
  assert.equal(afterHeld({}), 'resume', 'a take that ended with nothing');
  // While a turn runs it is still C1's add-on (the voice holds and goes on), never this path.
  assert.equal(whileBusy({ busy: true }), 'add_on');
}

// ---- the wiring
{
  assert.match(side, /else if \(m\.type === 'voice_state' && m\.state === 'listening'\) \{ addOnTake = false; cutTake = overReply\(\{ saying: saidPending, voiceOn: VOICE_ON\(\) \}\) === 'hold'; if \(cutTake\) hush\(true\); else speech\.stop\(\);/,
    'a take with nothing running holds the reply still being said, never cuts it');
  assert.doesNotMatch(side, /m\.state === 'listening'\) \{ addOnTake = false; speech\.stop\(\);/, 'the old cut is gone');
  assert.match(side, /else if \(m\.type === 'voice' && m\.text\?\.trim\(\)\) \{\n\s+if \(cutTake && afterHeld\(\{ words: m\.text \}\) === 'stop'\) \{ cutTake = false; speech\.stop\(\); \}/,
    'the owner\'s words over the reply keep it cut');
  assert.match(side, /m\.state === 'idle'\) \{ addOnTake = false; hush\(false\);[^\n]*if \(snap\?\.waitingVoice\) snap\.waitingVoice = false; if \(cutTake\) resumeCut\(\); \}/, 'a take that heard nothing lets the reply go on');
  const resume = side.match(/function resumeCut\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.match(resume, /cutTake = false;/);
  assert.match(resume, /interruptedAfter = '';/, 'the next turn isn\'t told the reply was cut off');
  assert.match(resume, /logLine\('resumed', \{ by: 'no words' \}\);/, 'logged');
  assert.match(side, /else if \(m\.code === 'nothing_heard' && Date\.now\(\) - resumedAt < 3000\) logLine\('nothing_heard', \{ resumed: true \}\);\n\s+\/\/ While a turn runs/,
    'no "I didn\'t hear anything" over the reply that goes on');
}

console.log('build4c7 ok');
