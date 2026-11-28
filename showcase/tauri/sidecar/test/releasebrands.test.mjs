// Release review findings 1 and 3 (2026-11-27): the helpers read the sidecar's credential words and A3's card brands
// (card.swift's backstop was RV's stale copy). Failed before its fix. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { swiftHas, swiftPatterns } from './swiftsync.mjs';

// 2. The helpers read the same words and brands (written by node test/swiftsync.mjs --write).
const want = swiftPatterns(), have = swiftHas();
for (const k of ['CRED_FIELD', 'CRED_FIELD_CARD', 'CARD_BRANDS']) assert.equal(have[k], want[k], `${k} in the Swift helper is the sidecar's`);
const card = fs.readFileSync(new URL('../../src-tauri/remote/card.swift', import.meta.url), 'utf8');
assert.ok(!/BRAND in remotepolicy\.mjs/.test(card), 'card.swift no longer cites a BRAND remotepolicy.mjs deleted');
console.log('releasebrands: ok');
