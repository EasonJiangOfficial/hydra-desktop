// Desktop build 5: ChatGPT stays on the Mac, the voice cache key, and the phase list (drawn notes: notesync.test.mjs).
import assert from 'node:assert/strict';
import { avatarStyle, cleanAvatar, gptRoute } from '../agentsettings.mjs';
import { phaseOf } from '../voiceturn.mjs';
import { bestMacVoice } from '../sysvoice.mjs';

assert.deepEqual(gptRoute({ model: 'claude-opus-5-5', chatgpt: true }), { provider: null, model: 'claude-opus-5-5', fallback: null, note: '' });
assert.equal(gptRoute({ model: 'gpt-6.2-sol', chatgpt: true }).provider, 'openai');
assert.equal(gptRoute({ model: 'gpt-6.2-sol', chatgpt: false }).fallback, 'not_connected');
assert.equal(gptRoute({ model: 'gpt-6.2-astra', chatgpt: true, server: true }).fallback, 'server_claude_only');
assert.match(gptRoute({ model: 'gpt-6.2-sol', server: true }).note, /Mac/);

const av = cleanAvatar({ activeAvatar: { name: 'Tony', voiceId: '0123456789abcdef0123456789abcdef', curse: true, slang: false, styleNotes: 'Brooklyn.' } });
assert.equal(av.voiceId, '0123456789abcdef0123456789abcdef');
assert.match(avatarStyle(av), /Do not curse|Cursing is fine/);
assert.match(avatarStyle(av), /Cursing is fine/);
assert.match(avatarStyle(av), /No slang/);
assert.equal(cleanAvatar({ activeAvatar: { name: 'x', voiceId: 'nope' } }), null);

assert.equal(phaseOf({ asleep: true, listening: true }), 'asleep');
assert.equal(phaseOf({ listening: true, busy: true }), 'listening');
assert.equal(phaseOf({ asking: true, busy: true }), 'asking');
assert.equal(phaseOf({ busy: true, answerSaid: false, playing: true }), 'working');
assert.equal(phaseOf({ busy: true, answerSaid: true }), 'talking');
assert.equal(phaseOf({}), 'idle');

const listing = [
  'Alex                en_US    # Hello',
  'Samantha (Enhanced) en_US    # Hello',
  'Zoe (Premium)       en_GB    # Hello',
  'Thomas              fr_FR    # Bonjour',
].join('\n');
assert.equal(bestMacVoice(listing), 'Zoe (Premium)');
assert.equal(bestMacVoice(''), null);

console.log('build 5: ok');
