// Every ask asks (owner: "for deletion of everything have the agent confirm before doing ... for everything"; the old
// "Skip Allow prompts" setting is gone), a no keeps the step from running, BLOCK never asks, and commands run in the
// working folder. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTools } from '../tools.mjs';

const noop = async () => {};
const base = { allowActions: () => true, ui: () => {}, openUrl: noop, onCommitments: noop, showList: noop, fmtWhen: String, commitmentsText: () => '', userName: 'Test' };
const sidekick = fs.readFileSync(new URL('../sidekick.mjs', import.meta.url), 'utf8'), panelSrc = fs.readFileSync(new URL('../../../panel/panel.js', import.meta.url), 'utf8');
assert.ok(!/skipAllow|skipallow|Skip Allow/.test(sidekick.replace('delete config.skipAllow;', '')) && !/skipAllow|Skip Allow/.test(panelSrc), 'the setting, its switch and its menu item are gone');
assert.match(sidekick, /delete config\.skipAllow;/, 'an old saved value is dropped');

for (const command of ['cp x.txt y.txt', 'rm -f x.txt', 'npm run clean', 'git commit -m x']) {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'askalways-'));
  fs.writeFileSync(path.join(workdir, 'x.txt'), 'hi');
  const asked = [];
  // A tool set made the old way, with skipAllow, still asks: there is nothing that reads it.
  const { tools } = createTools({ ...base, workdir, skipAllow: () => true, ask: async (o) => { asked.push(o); return null; } });
  await assert.rejects(tools.find((t) => t.name === 'run_command').execute({ command }, undefined), /said no|Blocked/, `${command}: asks`);
  assert.ok(asked.length <= 1);
  if (asked.length) assert.equal(asked[0].always, true, 'only the owner can answer it');
  assert.ok(fs.existsSync(path.join(workdir, 'x.txt')), `${command}: nothing ran on a no`);
  fs.rmSync(workdir, { recursive: true, force: true });
}
{
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'askalways-'));
  const asked = [];
  const { tools } = createTools({ ...base, workdir, ask: async (o) => { asked.push(o); return 'yes'; } });
  await assert.rejects(tools.find((t) => t.name === 'run_command').execute({ command: 'sudo rm -rf /' }, undefined), /Blocked for safety/, 'BLOCK stays blocked');
  assert.deepEqual(asked, [], 'BLOCK never asks');
  fs.rmSync(workdir, { recursive: true, force: true });
}
console.log('every ask asks: ok');

// The working folder (~/Roamies for the chat): commands run there, and the tool says so instead of "home folder".
{
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'workdir-'));
  const { tools } = createTools({ ...base, ask: async () => null, workdir });
  const run = tools.find((t) => t.name === 'run_command');
  assert.ok(run.description.includes(`its working folder (${workdir})`), 'run_command names its folder');
  assert.ok(!run.description.includes("the user's home folder"));
  const out = await run.execute({ command: process.platform === 'win32' ? 'cd' : 'pwd' }, undefined);
  assert.ok(String(out).includes(fs.realpathSync(workdir)) || String(out).includes(workdir), 'and runs there');
  if (process.platform === 'darwin') {
    // Fifth review: a plain read never touches a shell. With no usable shell it still runs, by absolute path, piped.
    const keep = process.env.SHELL; process.env.SHELL = '/nonexistent/shell';
    fs.writeFileSync(path.join(workdir, 'a.txt'), 'b\na\n');
    try {
      assert.equal(String(await run.execute({ command: 'cat a.txt | sort | head -n 1' }, undefined)).trim(), 'a', 'a pipeline of plain reads runs with no shell');
      await assert.rejects(run.execute({ command: 'echo $HOME' }, undefined), /said no/, '$ is not a plain word: it asks');
    } finally { process.env.SHELL = keep; }
  }
  fs.rmSync(workdir, { recursive: true, force: true });
  console.log('workdir tests: passed');
}
