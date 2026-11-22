// Every ask asks (owner: "for deletion of everything have the agent confirm before doing ... for everything"; the old
// "Skip Allow prompts" setting is gone), a no keeps the step from running, BLOCK never asks, and relative paths start
// in the working folder. Run: npm test
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

// The working folder (~/Roamies for the chat) lives in the home folder; the test's home is a temp folder (npm test).
const HOME = os.homedir();
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
console.log('every ask asks: ok');
