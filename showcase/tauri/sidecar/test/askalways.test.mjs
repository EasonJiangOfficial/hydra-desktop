// Every ask asks while Approve all is off (a delete still asks, and a no keeps the step from running). Approve all
// runs every yes/no and does not open an ask, including a delete. BLOCK never asks, and relative paths start in the
// working folder.
// The ask here goes through the same rule as sidekick ask() (approveAllSays, safety.mjs). Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeHands } from './fakehands.mjs';
import { approveAllSays } from '../safety.mjs';

// The working folder (~/Roamies for the chat) lives in the home folder; the test's home is a temp folder (npm test).
const HOME = os.homedir();
assert.ok(fs.realpathSync.native(HOME).startsWith(fs.realpathSync.native(os.tmpdir())) || HOME.includes('roamies-test-'), 'runs only with a temp home');
// Fakes only, set before tools.mjs loads: a fake hands helper, and open/osascript/screencapture/sips that only log.
const dir = fs.mkdtempSync(path.join(HOME, 'approveall-'));
const bin = path.join(dir, 'bin'), launched = path.join(dir, 'launched.log');
fs.mkdirSync(bin);
for (const c of ['open', 'osascript', 'screencapture', 'sips']) fs.writeFileSync(path.join(bin, c), `#!/bin/sh\necho ${c} "$@" >> '${launched}'\nexit 0\n`, { mode: 0o755 });
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
const fake = fakeHands(dir);
const { createTools } = await import('../tools.mjs');

const noop = async () => {};
const base = { allowActions: () => true, ui: () => {}, openUrl: noop, onCommitments: noop, showList: noop, fmtWhen: String, commitmentsText: () => '', userName: 'Test' };
const sidekick = fs.readFileSync(new URL('../sidekick.mjs', import.meta.url), 'utf8'), panelSrc = fs.readFileSync(new URL('../../../panel/panel.js', import.meta.url), 'utf8');
assert.ok(!/skipAllow|skipallow|Skip Allow/.test(sidekick.replace('delete config.skipAllow;', '')) && !/skipAllow|Skip Allow/.test(panelSrc), 'the setting, its switch and its menu item are gone');
assert.match(sidekick, /delete config\.skipAllow;/, 'an old saved value is dropped');

for (const p of ['x.txt', 'notes/new.md', '.config/git/config']) {
  const workdir = fs.mkdtempSync(path.join(HOME, 'askalways-'));
  fs.writeFileSync(path.join(workdir, 'x.txt'), 'hi');
  const asked = [];
  // A tool set made the old way, with skipAllow, still asks: there is nothing that reads it.
  const { tools } = createTools({ ...base, workdir, skipAllow: () => true, ask: async (o) => { asked.push(o); return null; } });
  await assert.rejects(tools.find((t) => t.name === 'write_file').execute({ path: p, content: 'x' }, undefined), /said no/, `${p}: asks`);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].always, true, 'only the owner can answer it');
  // The question names the whole real path, not a cut one (sixth review).
  assert.ok(asked[0].placeholder.includes(path.join(fs.realpathSync(workdir), p)), `${p}: the full path is in the question`);
  assert.equal(fs.readFileSync(path.join(workdir, 'x.txt'), 'utf8'), 'hi', `${p}: nothing written on a no`);
  assert.ok(p === 'x.txt' || !fs.existsSync(path.join(workdir, p)));
  fs.rmSync(workdir, { recursive: true, force: true });
}
{
  const asked = [];
  const { tools } = createTools({ ...base, workdir: HOME, ask: async (o) => { asked.push(o); return 'yes'; } });
  await assert.rejects(tools.find((t) => t.name === 'write_file').execute({ path: '~/.zshrc', content: 'x' }, undefined), /Blocked for safety/, 'BLOCK stays blocked');
  assert.deepEqual(asked, [], 'BLOCK never asks');
}

// ---- Approve all (E2).
assert.equal(approveAllSays(true, { choices: ['Allow', "Don't allow"], deletion: false }), true);
assert.equal(approveAllSays(true, { choices: ['Allow', "Don't allow"], deletion: true }), true, 'a delete runs');
assert.equal(approveAllSays(true, { choices: ['Allow'], deletion: true }), true, 'a one-choice delete runs');
assert.equal(approveAllSays(true, { choices: ['Allow'] }), true, 'an untagged yes/no runs');
assert.equal(approveAllSays(true, { choices: ['Install', "Don't install"], deletion: true }), true, 'an install runs');
for (const o of [{ prompt: 'Paste the key', deletion: false }, null, { placeholder: 'The orb', choices: ['Attach to Hydra', 'Keep it here'] }]) assert.equal(approveAllSays(true, o), false, `still asks: ${JSON.stringify(o)}`);
assert.equal(approveAllSays(false, { choices: ['Allow'], deletion: true }), false, 'off: a delete asks');
assert.equal(approveAllSays(false, { choices: ['Allow'], deletion: false }), false, 'off: every ask asks');
{
  const wins = [{ id: 1, pid: 10, app: 'TextEdit', title: 'Draft', text: 'x' }, { id: 2, pid: 20, app: 'Notes', title: 'Notes', text: 'y' }];
  const store = await import('../store.mjs'), jobs = await import('../jobs.mjs'), skills = await import('../skills.mjs');
  let on = false, answer = null;
  const asked = [];
  const ask = async (o) => {
    if (approveAllSays(on, o)) return 'yes';
    asked.push(o.placeholder ?? o.prompt);
    return typeof answer === 'function' ? answer(o) : answer;
  };
  const t = createTools({ ...base, workdir: dir, ask, skills: { changed: () => {} }, jobs: { changed: () => {}, run: noop } });
  const T = (n) => t.tools.find((x) => x.name === n);
  const run = (p) => p.then((x) => String(x?.content?.[0]?.text ?? x), (e) => String(e?.message ?? e));
  const reset = (setting, ans = null) => { on = setting; answer = ans; asked.length = 0; fake.clear(); fake.set({ wins }); t.nextTurn?.(); };
  const managed = () => fake.calls().filter((c) => c[0] === 'MANAGE').map((c) => c.slice(1));

  for (const setting of [false, true]) {
    const tag = `approve all ${setting ? 'on' : 'off'}`;
    // Not deletions: a new file, a quit, a hide, a close, an open, a new skill. On: done, nothing asked. Off: asked.
    reset(setting, 'yes');
    const f = path.join(dir, `new-${setting}.txt`);
    await run(T('write_file').execute({ path: f, content: 'new' }, {}));
    assert.equal(fs.readFileSync(f, 'utf8'), 'new', `${tag}: written`);
    assert.equal(asked.length, setting ? 0 : 1, `${tag}: a new file ${setting ? 'runs unasked' : 'asks'}`);
    for (const what of ['quit', 'hide', 'close']) {
      reset(setting, 'yes');
      const r = await run(T('manage_app').execute({ do: what, app: 'TextEdit' }, {}));
      assert.deepEqual(managed(), [[what, 'TextEdit']], `${tag}: ${what} ran (${r})`);
      assert.equal(asked.length, setting ? 0 : 1, `${tag}: ${what} ${setting ? 'runs unasked' : 'asks'}: ${asked}`);
    }
    reset(setting, 'yes');
    await run(T('open').execute({ target: 'https://ui.elevenlabs.io' }, {}));
    assert.equal(asked.length, setting ? 0 : 1, `${tag}: an open ${setting ? 'runs unasked' : 'asks'}: ${asked}`);
    reset(setting, 'yes');
    await run(T('save_skill').execute({ name: `Orb shot ${setting}`, description: 'Screenshot the orbs.', steps: '1. Open the page.' }, {}));
    assert.equal(asked.length, setting ? 0 : 1, `${tag}: a new skill ${setting ? 'saves unasked' : 'asks'}`);

    // Deletions. Off: each one asks, and a no keeps it. On: it runs, and no ask opens.
    const deletion = async (label, p, { off, ran } = {}) => {
      reset(setting, null);
      const r = await run(p());
      if (setting) {
        assert.equal(asked.length, 0, `${tag}: ${label} does not ask (${r})`);
        assert.doesNotMatch(String(r), /said no/, `${tag}: ${label} ran`);
        ran?.(r);
      } else {
        assert.equal(asked.length >= 1, true, `${tag}: ${label} asks (${r})`);
        assert.match(String(r), /said no/, `${tag}: ${label}: a no stops it`);
        off?.();
      }
    };
    fs.writeFileSync(f, 'keep');
    await deletion('an overwrite', () => T('write_file').execute({ path: f, content: 'gone' }, {}), {
      off: () => assert.equal(fs.readFileSync(f, 'utf8'), 'keep'),
      ran: () => assert.equal(fs.readFileSync(f, 'utf8'), 'gone'),
    });
    const c = await store.addCommitment(`Call the bank ${setting}`, null);
    await deletion('dropping a commitment', () => T('update_commitment').execute({ id: c.id, status: 'dropped', reason: 'done elsewhere' }, {}), {
      off: () => assert.equal(store.getCommitment(c.id).status, 'open'),
      ran: () => assert.equal(store.getCommitment(c.id).status, 'dropped'),
    });
    const fact = await store.addFact(`Likes tea ${setting}`);
    await deletion('forgetting a fact', () => T('forget_fact').execute({ id: fact.id, reason: 'wrong' }, {}), {
      off: () => assert.ok(store.listFacts().some((x) => x.id === fact.id)),
      ran: () => assert.ok(!store.listFacts().some((x) => x.id === fact.id)),
    });
    const job = await jobs.addJob({ title: `Digest ${setting}`, brief: 'Sum up.', due: 'in 5h' });
    await deletion('removing a job', () => T('update_job').execute({ id: job.id, action: 'remove', reason: 'not needed' }, {}), {
      off: () => assert.ok(jobs.getJob(job.id)),
      ran: () => assert.ok(!jobs.getJob(job.id)),
    });
    await deletion('deleting a skill', () => T('forget_skill').execute({ name: `Orb shot ${setting}`, reason: 'wrong' }, {}), {
      off: () => assert.ok(skills.skillExists(`Orb shot ${setting}`)),
      ran: () => assert.ok(!skills.skillExists(`Orb shot ${setting}`)),
    });
    await deletion('replacing a skill', () => T('save_skill').execute({ name: `Orb shot ${setting}`, description: 'New.', steps: '1. Other.' }, {}), {
      off: () => assert.equal(skills.readSkill(`Orb shot ${setting}`)?.steps, '1. Open the page.'),
      ran: () => assert.match(skills.readSkill(`Orb shot ${setting}`)?.steps ?? '', /Other/),
    });
    // A force quit loses unsaved work. Off: both asks, and a no keeps it. On: it quits, and no ask opens.
    if (!setting) {
      await deletion('a force quit', () => T('manage_app').execute({ do: 'force_quit', app: 'TextEdit' }, {}), { off: () => assert.deepEqual(managed(), []) });
      reset(setting, (o) => (/anyway\?$/.test(o.placeholder) ? null : 'yes'));
      const fq = await run(T('manage_app').execute({ do: 'force_quit', app: 'TextEdit' }, {}));
      assert.deepEqual(asked, ['Force quit TextEdit?', 'Force quitting TextEdit loses anything unsaved. Force quit anyway?'], `${tag}: both asked (${fq})`);
      assert.deepEqual(managed(), [], `${tag}: nothing quit on a no`);
    } else {
      await deletion('a force quit', () => T('manage_app').execute({ do: 'force_quit', app: 'TextEdit' }, {}), { ran: () => assert.deepEqual(managed(), [['force_quit', 'TextEdit']]) });
    }
    // Putting a file back over the one there now replaces it. Off: a no keeps the file. On: it is put back.
    reset(setting, 'yes');
    await run(T('write_file').execute({ path: f, content: 'changed' }, {}));
    const kept = store.listBin().filter((x) => x.kind === 'file' && store.getBin(x.id)?.data?.path === fs.realpathSync(f)).at(-1);
    assert.ok(kept, `${tag}: the old file is in Recently deleted`);
    const beforeRestore = fs.readFileSync(f, 'utf8');
    await deletion('a restore over a file', () => T('restore_deleted').execute({ id: kept.id }, {}), {
      off: () => assert.equal(fs.readFileSync(f, 'utf8'), 'changed'),
      ran: () => assert.notEqual(fs.readFileSync(f, 'utf8'), beforeRestore),
    });
    // The helper's own risky step. Off: it asks, and a no stops it. On: Approve all runs it, and no ask opens.
    if (!setting) {
      reset(setting, (o) => (/Go ahead\?$/.test(o.placeholder) ? null : 'yes'));
      fake.set({ wins, act: { ok: false, needsConfirm: true, step: 0, why: 'That click could delete the note.', label: 'Delete' } });
      const risky = await Promise.race([run(T('act_in_app').execute({ target: 'Notes', steps: [{ do: 'click_text', text: 'Note one' }] }, {})), new Promise((r) => setTimeout(() => r('no answer in 10 s'), 10_000).unref())]);
      assert.deepEqual(asked.filter((q) => /Go ahead\?$/.test(q)), ['That click could delete the note. Go ahead?'], `${tag}: the risky step asks (${risky}; ${asked})`);
      assert.equal(asked.length, 2, `${tag}: the plan asks too: ${asked}`);
      assert.match(risky, /said no/);
    } else {
      reset(setting, null);
      fake.set({ wins, act: { ok: true, done: ['clicked Delete'], window: { id: 2, app: 'Notes', title: 'Notes', bounds: [0, 0, 800, 600] } } });
      const risky = await run(T('act_in_app').execute({ target: 'Notes', steps: [{ do: 'click_text', text: 'Note one' }] }, {}));
      assert.equal(asked.length, 0, `${tag}: the plan does not ask (${risky})`);
      assert.match(String(risky), /clicked Delete/);
      assert.equal(approveAllSays(true, { placeholder: 'That click could delete the note. Go ahead?', choices: ['Allow', "Don't allow"], deletion: true }), true, 'the risky step is a yes too');
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log('Approve all runs every yes/no, including a delete; off, a delete still asks: ok');
