// Release review finding 1 (2026-11-27): A3's CRED_FIELD missed a PIN after a prefix, '<word> token', '<word> secret'
// and a security question, so the agent and the phone typed into them. Failed before its fix. Run: npm test
import assert from 'node:assert/strict';
import { credentialLabel } from '../hardlimits-core.mjs';
import { checkInput } from '../remotepolicy.mjs';

// 1. Credential fields: a PIN after any short prefix, "<word> token", "<word> secret", a security question.
const CRED = ['Enter your PIN', 'Please enter your PIN', 'Transaction PIN', 'Account PIN', 'Carrier PIN', 'Port-out PIN', 'Transfer PIN', 'App PIN', 'Phone PIN',
  'API token', 'API Token', 'Refresh token', 'Session token', 'Bot token', 'Slack bot token', 'Personal token', 'Deploy token', 'Integration token', 'Your token', 'Paste your token', 'Enter token',
  'App secret', 'Consumer secret', 'Signing secret', 'Webhook signing secret', 'Webhook secret', 'Shared secret', 'API secret', 'Secret value', 'Value (secret)',
  'Security question', 'Security question answer', 'Digit code'];
const PLAIN = ['Pin title', 'Pin to top', 'Drop pin', 'Token name', 'Token description', 'Search token', 'Select token', 'Secret Santa', 'Top secret', 'Search', 'Name', 'Spinner', 'Promo code', 'Country code', 'Subject', 'Title'];
for (const l of CRED) assert.ok(credentialLabel(l), `a credential field: ${l}`);
for (const l of PLAIN) assert.ok(!credentialLabel(l), `an ordinary field: ${l}`);
// The phone refuses typing into them (it reads A3's credentialField).
const base = { display: { w: 1000, h: 800 }, shields: [], locked: false, agent: { busy: false, owner: false }, hit: { app: 'Safari' }, frontSecret: false, tail: '', pay: {} };
for (const l of CRED) assert.deepEqual(checkInput({ t: 'text', n: 1, s: '4' }, { ...base, focus: { role: 'AXTextField', label: l } }), { do: 'refuse', why: 'credential' }, `the phone types nothing into ${l}`);
for (const l of ['Pin title', 'Token name']) assert.equal(checkInput({ t: 'text', n: 1, s: '4' }, { ...base, focus: { role: 'AXTextField', label: l } }).do, 'allow', `the phone types into ${l}`);
console.log('releasecred: ok');
