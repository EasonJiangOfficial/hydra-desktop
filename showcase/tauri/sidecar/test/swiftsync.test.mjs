// The two hard-limit layers read the same words (A3 round 3): the hands helper's MONEY, AMBIG and CRED_FIELD
// patterns in main.swift, the remote helper's CRED_FIELD_CARD (hit.swift) and card brands (card.swift) are the ones built
// from hardlimits-core.mjs (test/swiftsync.mjs). After a change to the
// sidecar's words: node test/swiftsync.mjs --write, then rebuild the helper and run its --self-test.
import assert from 'node:assert/strict';
import { swiftHas, swiftPatterns } from './swiftsync.mjs';

const want = swiftPatterns(), have = swiftHas();
for (const k of Object.keys(want)) assert.equal(have[k], want[k], `main.swift ${k} differs from hardlimits-core.mjs: run node test/swiftsync.mjs --write`);
// The patterns compile as JS regexes too (ICU reads the same syntax for these): a typo shows here first.
for (const [k, v] of Object.entries(want)) if (k !== 'CARD_BRANDS') assert.doesNotThrow(() => new RegExp(v, 'iu'), k);
console.log('swift sync: the helper reads the sidecar\'s money and credential words');
