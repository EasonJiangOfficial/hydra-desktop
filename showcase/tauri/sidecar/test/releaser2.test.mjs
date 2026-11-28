// Release review round 2 (2026-11-27): eight over-matches in the hard limits' credential, card and money rules, each
// refusing or asking on an ordinary action. Failed before its fix. Run: npm test
import { credentialFixture } from './fixtures/credential-fixtures.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as core from '../hardlimits-core.mjs';
import { credentialArgs } from '../safety.mjs';
import { brainGate } from '../brain-server.mjs';
import { checkInput, payCtx } from '../remotepolicy.mjs';

const bad = [];
const check = (ok, what) => { if (!ok) bad.push(what); };

// 1. Connector reads: an ID, an event ID, a page token or a cursor is machine-made by design, not a key. A card or a
// known key prefix in them is still refused, and a random token anywhere else too.
{
  const ids = [{ eventId: '4jtsc0i0lvk2hqg0p4ovl2f0o3_20261127T150000Z' }, { pageToken: 'CiAKGjBpNDd2Nmp2Zml2cXRwYjBpOXA0dDQ3dDA2EAEYAQ' },
    { query: 'invoice', nextPageToken: 'CiAKGjBpNDd2Nmp2Zml2cXRwYjBpOXA0dDQ3dDA2EAEYAQ' }, { fileId: '1Bx9MVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms' },
    { page_id: '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d' }, { id: 'https://www.notion.so/Plan-1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d' }, { cursor: 'Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56' },
    { ids: ['1Bx9MVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms'] }];
  for (const a of ids) check(!credentialArgs(a), `an ID is no credential: ${JSON.stringify(a)}`);
  for (const a of [{ fileId: '4111 1111 1111 1111' }, { id: credentialFixture('sk-ant-', 8) }, { query: 'Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56' }, { body: '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d' }])
    check(credentialArgs(a), `still a credential: ${JSON.stringify(a)}`);
  const gate = brainGate({ approve: async () => 'approved' });
  check(await gate('mcp__claude_ai_Google_Calendar__get_event', { eventId: '4jtsc0i0lvk2hqg0p4ovl2f0o3_20261127T150000Z' }) === true, 'a recurring event read runs');
  check(await gate('mcp__claude_ai_Gmail__search_threads', { query: 'invoice', pageToken: 'CiAKGjBpNDd2Nmp2Zml2cXRwYjBpOXA0dDQ3dDA2EAEYAQ' }) === true, 'page 2 of a Gmail search runs');
}

// 2. A turn that only names a password manager, a card or a token runs its connectors; one that asks to read or type
// a credential does not.
{
  const turn = core.credentialTurn ?? (() => 'missing');
  for (const w of ['find the 1Password invoice in my Gmail', 'search my email for the keychain I ordered from Etsy', 'show the emails from Bitwarden', 'did LastPass send me a receipt',
    'what did Google Authenticator email me about', 'show me my Coinbase token balance', 'read the email from my bank about my new debit card', 'read my latest email', 'how many tokens did I use this month'])
    check(!turn(w), `an ordinary turn: ${w}`);
  for (const w of ['read me the verification code Chase emailed me', 'copy my password from that email', 'type the code 482913 into the box', 'search my email for 4111 1111 1111 1111', 'show me the seed phrase in my notes'])
    check(!!turn(w), `a credential turn: ${w}`);
  const sk = fs.readFileSync(new URL('../sidekick.mjs', import.meta.url), 'utf8');
  const cg = sk.slice(sk.indexOf('async function connectorGate('), sk.indexOf('// Mac tools that only look'));
  check(/credentialTurn\(words\)/.test(cg) && !/hardMatch\(/.test(cg), 'connectorGate reads the turn with credentialTurn, not the whole hardMatch');
}

// 3. Count, limit and design token fields, and ordinary pins and secrets, are no credential fields.
{
  for (const l of ['Max tokens', 'Max output tokens', 'Number of tokens', 'Tokens', 'Design tokens', 'Context tokens', 'Output tokens', 'Total tokens', 'Gas token', 'Max token',
    'Rolling pin', 'Bowling pin', 'Lapel pin', 'Enamel pin', 'Board pin', 'Comment pin', 'Tag secret', 'Little secret', 'Security questions'])
    check(!core.credentialLabel(l), `an ordinary field: ${l}`);
  for (const l of ['Enter your PIN', 'Transaction PIN', 'API token', 'Refresh token', 'Webhook secret', 'Shared secret', 'Security question'])
    check(core.credentialLabel(l), `still a credential field: ${l}`);
}

const base = { display: { w: 100, h: 100 }, shields: [], locked: false, agent: { busy: false, owner: false }, frontSecret: false, tail: '', pay: {} };

// 4. The phone at a terminal's password prompt (A3's passwordPrompt) and a typed key (A3's typedCredential).
{
  const term = { role: 'AXTextArea', label: '', app: 'Terminal', lastLine: '[sudo] password for fixtureuser:' };
  check(checkInput({ t: 'text', n: 1, s: 'hunter2' }, { ...base, focus: term }).why === 'credential', 'text at a sudo prompt');
  check(checkInput({ t: 'key', n: 1, k: 'h' }, { ...base, focus: term }).why === 'credential', 'a key at a sudo prompt');
  check(checkInput({ t: 'text', n: 1, s: 'ls -la' }, { ...base, focus: { ...term, lastLine: 'fixtureuser@mac ~ %' } }).do === 'allow', 'an ordinary shell line');
  check(checkInput({ t: 'text', n: 1, s: credentialFixture('sk-ant-', 8) }, { ...base, focus: { role: 'AXTextArea', label: 'Note' } }).why === 'credential', 'an API key pasted into a note');
  check(checkInput({ t: 'text', n: 1, s: credentialFixture('ghp_', 8) }, { ...base, focus: { role: 'AXTextField', label: 'Search' } }).why === 'credential', 'a GitHub token into a search field');
  check(checkInput({ t: 'text', n: 1, s: 'see you at 10:30' }, { ...base, focus: { role: 'AXTextArea', label: 'Note' } }).do === 'allow', 'ordinary text');
}

// 5. A click on "View code" or "Show code" is no reveal; "Show password" and a password visibility toggle still are.
{
  const click = (label) => checkInput({ t: 'click', n: 1, x: 0.5, y: 0.5, b: 'l', c: 1 }, { ...base, focus: { role: 'AXWebArea', label: '' }, hit: { role: 'AXButton', label, app: 'Safari' } });
  for (const l of ['View code', 'Show code', 'Display code', 'Toggle code', 'View the code', 'Show your code']) check(click(l).do === 'allow', `an ordinary click: ${l}`);
  for (const l of ['Show password', 'View PIN', 'Toggle password visibility', 'Show/hide password', 'Mostrar contraseña']) check(click(l).why === 'credential', `a reveal: ${l}`);
}

// 6. Return in a store's or YouTube's search box runs a search, not the window's Buy Now or Join.
{
  const amazon = payCtx({ app: 'Google Chrome', title: 'Amazon.com: Kindle Paperwhite', url: 'https://www.amazon.com/dp/B0CFPJYX7P' });
  for (const role of ['AXTextField', 'AXSearchField', 'AXComboBox']) {
    const v = checkInput({ t: 'key', n: 1, k: 'return' }, { ...base, pay: amazon, focus: { role, label: 'Search Amazon', buttons: ['Go', 'Add to Cart', 'Buy Now'] } });
    check(v.do === 'allow', `Return in Search Amazon (${role}): ${JSON.stringify(v)}`);
  }
  const yt = payCtx({ app: 'Safari', title: 'MKBHD - YouTube', url: 'https://www.youtube.com/@mkbhd' });
  check(checkInput({ t: 'key', n: 1, k: 'return' }, { ...base, pay: yt, focus: { role: 'AXComboBox', label: 'Search', buttons: ['Search', 'Join', 'Subscribe'] } }).do === 'allow', 'Return in YouTube search');
  check(checkInput({ t: 'key', n: 1, k: 'return' }, { ...base, pay: amazon, focus: { role: 'AXTextField', label: 'Quantity', buttons: ['Buy Now'] } }).do === 'ask', 'Return in another field of the form still asks');
}

// 7. Backspace at the end of the tail: only what it leaves is read, the way A3 reads a card.
{
  const notes = { role: 'AXTextArea', label: 'Note' };
  for (const tail of ['Mom 202 555 0112. Dad 202 555 0113', 'Order 608960 total 09.95 ref 53804481'])
    check(checkInput({ t: 'key', n: 1, k: 'delete' }, { ...base, focus: notes, tail }).do === 'allow', `Backspace after ${tail}`);
  check(checkInput({ t: 'key', n: 1, k: 'delete' }, { ...base, focus: notes, tail: '41111111111111112' }).why === 'card', 'a Backspace that leaves a card');
  check(checkInput({ t: 'key', n: 1, k: 'ctrl+h' }, { ...base, focus: notes, tail: '41111111111111112' }).why === 'card', 'a ctrl+h that leaves a card');
  check(checkInput({ t: 'key', n: 1, k: 'alt+delete' }, { ...base, focus: notes, tail: '4111 1111 1111 1111x' }).do === 'allow', 'a word delete of a card already there');
  check(checkInput({ t: 'key', n: 1, k: 'delete' }, { ...base, focus: notes, tail: '4111 1111 15111 1111', moved: true }).why === 'card', 'a Delete after a cursor move still joins');
}

for (const b of bad) console.error(`not ok: ${b}`);
assert.equal(bad.length, 0, `${bad.length} failed`);
console.log('releaser2: ok');
