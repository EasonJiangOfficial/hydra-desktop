// L13: a background agent's asks, end to end through the real fork path: agents.mjs forks the real worker
// (agentrun.mjs) as its own process, driven by a scripted model (test/fakeagent-hard.mjs), with Approve all ON. The
// parent answers the ordinary asks at once (a write in its own folder, a dotfile read), and a sign-in store is refused
// in the worker before any ask (owner's hard limit: never asked, never read). The parent's rule that it never answers a
// hard ask runs through the same fork with a stubbed child (part 2). Nothing reaches the real home folder. Run: npm test
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-agenthard-')));
process.env.HOME = process.env.USERPROFILE = tmp;
process.env.ROAMIES_DATA_DIR = path.join(tmp, 'data');
process.env.ROAMIES_FAKE_AGENT = fileURLToPath(new URL('./fakeagent-hard.mjs', import.meta.url));
process.env.FAKE_LOG = path.join(tmp, 'fake.log');
delete process.env.ROAMIES_HANDS;
fs.mkdirSync(path.join(tmp, '.config', 'hydra'), { recursive: true });
fs.writeFileSync(path.join(tmp, '.config', 'hydra', 'notes.txt'), 'token=abc');
fs.writeFileSync(path.join(tmp, '.zshrc'), 'export PATH=/bin');
const { agentsRoot, createAgents } = await import('../agents.mjs');
const { checkOpen, checkRead, checkWrite } = await import('../safety.mjs');

const events = [], autos = [];
let onEnd = null;
const mgr = createAgents({
  fork, root: agentsRoot(), userName: 'Ken', home: tmp, runner: fileURLToPath(new URL('../agentrun.mjs', import.meta.url)), safety: { checkRead, checkWrite, checkOpen },
  log: (ev, d) => { if (ev === 'agent_ask_auto') autos.push(d.question); },
  config: { approveAll: () => true, model: async () => ({ provider: 'anthropic', model: 'fake', route: 'api' }), creds: async () => ({}), allowActions: () => true, image: () => null, open: async () => {}, reveal: async () => {} },
  ui: ({ e }) => {
    if (!e) return;
    events.push(e);
    // The owner's no, on the row's Don't allow button.
    if (e.type === 'ask') setTimeout(() => mgr.answer(e.agent.id, false), 50);
    if (e.type === 'done' || e.type === 'fail' || e.type === 'gone') onEnd?.(e);
  },
});
const done = new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`no result in 20 s: ${JSON.stringify(events.map((e) => e.type))}`)), 20_000);
  onEnd = (e) => { clearTimeout(t); resolve(e); };
});
const a = await mgr.start({ type: 'maker', title: 'Hard asks', brief: 'Write a note, then read the notes file.' });
const end = await done;
const log = fs.readFileSync(process.env.FAKE_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
assert.equal(end.type, 'done', `${end.agent.reason}\n${JSON.stringify(log, null, 1)}`);
// Approve all answered the ordinary asks at once: the create and the overwrite in its own folder, and the dotfile read
// (round 1 L12: a hidden file is an ordinary ask, never a hard one). (The log keeps a question's first 120 characters.)
assert.deepEqual(autos, [`Create ${path.join(a.dir, 'files', 'a.txt')}?`, `Overwrite ${path.join(a.dir, 'files', 'a.txt')}?`, `Read ${path.join(tmp, '.zshrc')}? It's a hidden or app-data file, which can hold sign-ins.`].map((q) => q.slice(0, 120)), JSON.stringify(autos));
assert.equal(fs.readFileSync(path.join(a.dir, 'files', 'a.txt'), 'utf8'), 'two');
const reads = log.filter((l) => l.name === 'read_file');
assert.equal(reads[0].isError, false, JSON.stringify(reads[0]));
assert.match(reads[0].result, /export PATH/);
// The sign-in store (~/.config/hydra) is refused in the worker, never asked: the owner saw no ask at all.
assert.deepEqual(events.filter((e) => e.type === 'ask').map((e) => e.agent.ask.question), []);
assert.equal(reads[1].isError, true, JSON.stringify(reads[1]));
assert.match(reads[1].result, /holds passwords or keys, so I never read it/);
assert.doesNotMatch(JSON.stringify(log), /token=abc/, 'the sign-in store was never read');
mgr.stopAll();

// Part 2: the parent's rule through the same fork path, with a stubbed child (test/fakerunner-hard.mjs) that asks one
// ordinary yes/no and one hard one (a money step): Approve all answers the first at once and never the second, which
// waits on the agent's row for the owner (who says no here).
{
  process.env.FAKE_LOG2 = path.join(tmp, 'fake2.log');
  const ev2 = [], autos2 = [];
  let onEnd2 = null;
  const mgr2 = createAgents({
    fork, root: agentsRoot(), userName: 'Ken', home: tmp, runner: fileURLToPath(new URL('./fakerunner-hard.mjs', import.meta.url)), safety: { checkRead, checkWrite, checkOpen },
    log: (ev, d) => { if (ev === 'agent_ask_auto') autos2.push(d.question); },
    config: { approveAll: () => true, model: async () => ({ provider: 'anthropic', model: 'fake', route: 'api' }), creds: async () => ({}), allowActions: () => true, image: () => null, open: async () => {}, reveal: async () => {} },
    ui: ({ e }) => {
      if (!e) return;
      ev2.push(e);
      if (e.type === 'ask') setTimeout(() => mgr2.answer(e.agent.id, false), 50);
      if (e.type === 'done' || e.type === 'fail' || e.type === 'gone') onEnd2?.(e);
    },
  });
  const done2 = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no result in 20 s: ${JSON.stringify(ev2.map((e) => e.type))}`)), 20_000);
    onEnd2 = (e) => { clearTimeout(t); resolve(e); };
  });
  await mgr2.start({ type: 'maker', title: 'Hard ask', brief: 'Ask twice.' });
  await done2;
  assert.deepEqual(autos2, ['Overwrite files/a.txt?'], 'Approve all answered only the ordinary ask');
  assert.deepEqual(ev2.filter((e) => e.type === 'ask').map((e) => e.agent.ask.question), ['Pays or moves money: buy. Click "Buy now" in Safari?'], 'the hard one waited for the owner');
  assert.deepEqual(JSON.parse(fs.readFileSync(process.env.FAKE_LOG2, 'utf8')), { ordinary: true, hard: false }, 'the owner\'s no reached the worker');
  mgr2.stopAll();
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log('agent asks through the real fork (ordinary ones answered, a sign-in store refused unasked): ok');
