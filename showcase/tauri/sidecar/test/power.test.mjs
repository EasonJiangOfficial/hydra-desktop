// Hydra's sleep and wake (power.mjs): five quiet minutes put it to sleep; talking, a clap or a click wakes it; the
// sleep word is heard in what was said.
import assert from 'node:assert/strict';
import { cleanSleepWord, createPower, heardSleepWord, SLEEP_AFTER_MS } from '../power.mjs';

// A fake clock with timers that fire when it's moved on.
let t = 0, timers = [];
const clock = { now: () => t, setTimer: (f, ms) => { const h = { f, at: t + ms }; timers.push(h); return h; }, clearTimer: (h) => { timers = timers.filter((x) => x !== h); } };
const advance = (ms) => { const end = t + ms; for (;;) { const next = timers.filter((h) => h.at <= end).sort((a, b) => a.at - b.at)[0]; if (!next) break; t = next.at; timers = timers.filter((h) => h !== next); next.f(); } t = end; };

const changes = [];
const p = createPower({ ...clock, onChange: (c) => changes.push(c) });
assert.equal(p.asleep, false, 'starts awake');
advance(SLEEP_AFTER_MS - 1000);
assert.equal(p.asleep, false, 'not before five minutes');
p.talked();
advance(SLEEP_AFTER_MS - 1000);
assert.equal(p.asleep, false, 'talking restarts the five minutes');
advance(1000);
assert.equal(p.asleep, true, 'five quiet minutes: asleep');
assert.deepEqual(changes.at(-1), { asleep: true, why: 'idle' });
advance(60 * 60_000);
assert.equal(changes.length, 1, 'asleep stays asleep, with no more changes');
assert.equal(p.wake('clap'), true);
assert.deepEqual(changes.at(-1), { asleep: false, why: 'clap' });
assert.equal(p.wake('orb'), false, 'already awake: nothing changes');
p.sleep('sleep_word');
assert.equal(p.asleep, true);
p.talked();
assert.equal(p.asleep, false, 'talking with the talk keys wakes it');
assert.deepEqual(changes.at(-1), { asleep: false, why: 'talk' });
advance(SLEEP_AFTER_MS - 1);
p.busy();
advance(SLEEP_AFTER_MS - 1);
assert.equal(p.asleep, false, 'a reply running counts as not quiet');
advance(1);
assert.equal(p.asleep, true);
p.stop();

let taking = true, working = false;
const provisionalChanges = [];
const provisional = createPower({ ...clock, taking: () => taking, working: () => working, onChange: (c) => provisionalChanges.push(c) });
provisional.sleep();
provisional.wake('clap');
advance(12_000);
assert.equal(provisional.asleep, false, 'a clap take continues after 12 seconds');
advance(17_999);
assert.equal(provisional.asleep, false, 'a clap take continues until 30 seconds');
advance(1);
assert.deepEqual(provisionalChanges.at(-1), { asleep: true, why: 'unconfirmed' }, 'a clap take alone has a 30-second cap');

working = true;
provisional.wake('clap');
advance(60_000);
assert.equal(provisional.asleep, false, 'a live turn or approval still holds a clap wake after 60 seconds');
working = false;
advance(12_000);
assert.deepEqual(provisionalChanges.at(-1), { asleep: true, why: 'unconfirmed' }, 'the expired take cannot hold after work ends');

taking = false;
provisional.wake('phrase');
advance(11_999);
assert.equal(provisional.asleep, false);
advance(1);
assert.deepEqual(provisionalChanges.at(-1), { asleep: true, why: 'unconfirmed' }, 'a phrase wake without a take sleeps after 12 seconds');

taking = true;
provisional.wake('clap');
advance(29_999);
provisional.talked();
advance(1);
assert.equal(provisional.asleep, false, 'speech confirms even just before the cap');
provisional.stop();

// The sleep word, anywhere in what was said; words of 5 letters or more may be one letter off.
assert.ok(heardSleepWord('Hydra, sleep.'));
assert.ok(heardSleepWord('okay hydra sleep now'));
assert.ok(heardSleepWord('Hidra sleep'));
assert.ok(!heardSleepWord('Hydra, open Sleep Cycle'));
assert.ok(!heardSleepWord('I need some sleep'));
assert.ok(!heardSleepWord('Hydra'));
assert.ok(heardSleepWord('Goodnight, Hydra!', 'Goodnight Hydra'));
assert.ok(!heardSleepWord('Hydra, sleep', 'Goodnight Hydra'));
assert.ok(heardSleepWord('hydra sleep', ''), 'an empty setting is the default');
assert.deepEqual(cleanSleepWord(''), { ok: true, phrase: '' });
assert.deepEqual(cleanSleepWord('  Goodnight   Hydra '), { ok: true, phrase: 'Goodnight Hydra' });
assert.equal(cleanSleepWord('one two three four five').ok, false);
assert.equal(cleanSleepWord('off').ok, false);
console.log('power tests: passed');
