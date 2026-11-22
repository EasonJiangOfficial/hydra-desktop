// Review M5: forgetting a fact, dropping a commitment, removing a scheduled job and deleting a skill ask first, every
// time (owner: every deletion is confirmed). Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-memconfirm-'));
process.env.ROAMIES_DATA_DIR = TMP;
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));
const { addFact, addCommitment, listFacts, getCommitment } = await import('../store.mjs');
const { createTools } = await import('../tools.mjs');

const asked = [];
let answer = null;
const noop = async () => {};
const { tools } = createTools({ allowActions: () => true, ui: () => {}, openUrl: noop, onCommitments: () => {}, showList: noop, fmtWhen: String, commitmentsText: () => '', userName: 'Test',
  ask: async (o) => { asked.push(o); return answer; } });
const tool = (n) => tools.find((t) => t.name === n);

const f = await addFact('likes green tea');
await assert.rejects(tool('forget_fact').execute({ id: f.id }, undefined), /said no/);
assert.equal(asked.pop()?.always, true, 'forget_fact asks, always');
assert.ok(listFacts().some((x) => x.id === f.id), 'a no keeps the fact');
answer = 'Allow';
await tool('forget_fact').execute({ id: f.id }, undefined);
assert.ok(!listFacts().some((x) => x.id === f.id), 'a yes forgets it');

answer = null;
const c = await addCommitment('call mum', null);
await assert.rejects(tool('update_commitment').execute({ id: c.id, status: 'dropped' }, undefined), /said no/);
assert.equal(asked.pop()?.always, true, 'dropping a commitment asks, always');
assert.equal(getCommitment(c.id).status, 'open', 'a no keeps it');
asked.length = 0;
await tool('update_commitment').execute({ id: c.id, status: 'done' }, undefined);
assert.equal(asked.length, 0, 'ticking one off needs no yes');

// The job and skill tools: the asks are in place before anything is removed.
const src = fs.readFileSync(new URL('../tools.mjs', import.meta.url), 'utf8');
assert.match(src, /action === 'remove' && !\(await confirm\(`Remove the scheduled job[\s\S]{0,80}ctx\)\)/);
assert.match(src, /confirm\(`Delete the skill "\$\{name\}"\?`, ctx\)/);
assert.match(src, /skillExists\(args\.name\) && !\(await confirm\(`Replace the skill/, 'saving over a skill asks (second review M8)');
// Fourth review: a fact said again after it was replaced is current again, and replaced facts never reach the model.
{
  const { supersedeFact, liveFacts, pickFacts } = await import('../store.mjs');
  const a = await addFact('Has a cat called Miso');
  const b = await addFact('Has a cat called Momo, not Miso'); await supersedeFact(a.id, b.id);
  assert.ok(!liveFacts().some((f) => f.id === a.id) && !pickFacts('cat').some((f) => f.id === a.id), 'replaced: not used');
  const c = await addFact('Has a cat called Miso'); await supersedeFact(b.id, c.id);
  assert.equal(c.id, a.id, 'the same fact');
  assert.ok(liveFacts().some((f) => f.id === a.id) && !liveFacts().some((f) => f.id === b.id), 'current again; the other one replaced');
}
console.log('memory deletes ask: passed');
