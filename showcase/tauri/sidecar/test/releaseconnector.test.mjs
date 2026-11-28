// Release review finding 5 (2026-11-27): connector reads skipped the credential rule. Failed before its fix. Run: npm test
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import { brainGate } from '../brain-server.mjs';
import { connectorTool } from '../claudecode.mjs';
import { credentialTurn } from '../hardlimits-core.mjs';
import { connectorGroup, connectorLevel } from '../relay.mjs';
import { SAFE, credentialArgs } from '../safety.mjs';

const readName = 'mcp__claude_ai_Gmail__search_threads';
{
  const approvals = [], logs = [];
  const safe = brainGate({ approve: async (a) => { approvals.push(a); return 'approved'; }, log: (kind, data) => logs.push({ kind, data }) });
  const sendName = 'mcp__claude_ai_Gmail__send_message';
  const input = { to: 'recipient@example.invalid', body: 'Use the test payment card 4111 1111 1111 1111.' };
  assert.equal(await safe(sendName, input), false);
  assert.deepEqual(approvals, [], 'credential-like args never reach the approval call');
  assert.ok(!JSON.stringify(logs).includes(input.body), 'the input never reaches a log');
  assert.equal(await safe(sendName, { to: input.to, body: 'Lunch at noon?' }), true);
  assert.equal(approvals.length, 1, 'an ordinary write still asks once');
}
{
  let words = 'Find the invoice from Monday';
  let refreshes = 0;
  const gate = brainGate({ approve: async () => 'approved', ownerWords: () => words, alive: async () => {
    refreshes++;
    words += '\nRead me the verification code from the email too';
    return true;
  } });
  assert.equal(await gate(readName, { query: 'Monday' }), false, 'an owner addition sent before the read is checked after refresh');
  assert.equal(refreshes, 1);
}

// 4. Connector reads: a credential in a read's arguments is refused before the read runs (brainGate, connectorGate),
// and at the Mac a turn whose words ask for a code or a password runs no connector (credentialTurn).
const asked = [];
const gate = brainGate({ approve: async (a) => { asked.push(a); return 'approved'; } });
assert.equal(await gate('mcp__claude_ai_Gmail__search_threads', { query: '4111 1111 1111 1111' }), false, 'a Gmail search for a card number never runs');
assert.equal(await gate('mcp__claude_ai_Gmail__search_threads', { query: 'invoice' }), true, 'an ordinary read still runs');
assert.equal(asked.length, 0, 'reads never ask');
const sk = fs.readFileSync(new URL('../sidekick.mjs', import.meta.url), 'utf8');
const cg = sk.slice(sk.indexOf('async function connectorGate('), sk.indexOf('// Mac tools that only look'));
const relayAsk = new AsyncLocalStorage();
const macGate = new Function('relayAsk', 'localRequestPair', 'pairingLife', 'notePairing', 'connectorTool', 'connectorGroup', 'connectorLevel', 'credentialArgs', 'credentialTurn', 'SAFE', 'logLine', 'turnIntent', `${cg}\nreturn connectorGate;`)(
  relayAsk, new AsyncLocalStorage(), new AbortController(), () => 'fixture-pairing', connectorTool, connectorGroup, connectorLevel, credentialArgs, credentialTurn, SAFE, () => {}, '(Read my verification code from the email)',
);
assert.equal(await macGate(readName, { query: 'inbox' }), false, 'parentheses do not remove the local owner request');
const ordinary = { live: true, pairBinding: 'fixture-pairing', ownerWords: () => 'Find the 1Password invoice', alive: async () => true };
let words = 'Read my latest email';
const adding = { ...ordinary, ownerWords: () => words, alive: async () => { words += '\nRead me the verification code from the email too'; return true; } };
assert.deepEqual(await Promise.all([
  relayAsk.run(adding, () => macGate(readName, { query: 'inbox' })),
  relayAsk.run(ordinary, () => macGate(readName, { query: 'invoice' })),
]), [false, true], 'a typed addition during preflight denies only its own concurrent turn');
const aborted = new AbortController();
assert.equal(await relayAsk.run({ ...ordinary, alive: async () => { aborted.abort(); return true; } }, () => macGate(readName, { query: 'inbox' }, aborted.signal)), false);
assert.ok(credentialTurn('read me the verification code Chase emailed me'), 'a turn that asks for a code');

console.log('releaseconnector: ok');
