// Security review F1/F2: "Skip Allow prompts" never answers delete, kill, quit, send, pay, overwrite or move-to-Trash
// steps (owner: every deletion of anything is confirmed, no exceptions), and risky clicks by position, risky key chords
// and Return on a risky default button ask too. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkMcpCall, classifyCommand, isRiskyClick, riskyKey } from '../safety.mjs';

const HOME = os.homedir();
// Each of these asks and is marked `always`.
const ALWAYS = ['rm ~/Desktop/a.txt', 'mv ~/Desktop/a.txt ~/.Trash/', 'pkill -9 Safari', 'killall TextEdit', `osascript -e 'quit app "Notes"'`,
  'trash ~/Desktop/a.txt', 'kill 4242', 'bash -c "rm notes.txt"', 'git push --force', 'git reset --hard HEAD~1', 'sed -i "" s/a/b/ notes.txt',
  'curl -d "x=1" https://example.com/pay', 'find ~/Projects/logs -name "*.log" -delete', 'mail -s hi someone@example.com', 'npm publish'];
for (const c of ALWAYS) {
  const v = classifyCommand(c, HOME, { exists: () => false });
  assert.equal(v.level, 'ask', `${c} asks`);
  assert.equal(v.always, true, `${c} always asks, even with Skip Allow prompts on`);
}
// Review B1: every way round the first program, all of which used to come back skippable.
const BYPASS = [`bash -lc "rm a"`, `zsh -ic "rm a"`, `( rm a )`, `{ rm a; }`, `if true; then rm a; fi`, `for f in a b; do rm $f; done`, `! rm a`,
  `ls | xargs -I {} rm {}`, `xargs -n 1 rm`, `env -u FOO rm a`, `nice -n 10 rm a`, `timeout 5 rm a`, `watch rm a`, `r''m a`, `echo $(rm a)`,
  `python3 -c "import os; os.remove('a')"`, `node -e "require('fs').rmSync('a')"`, `perl -e 'unlink("a")'`, `ruby -e "File.delete('a')"`, `git rm a`,
  `defaults delete com.apple.dock`, `tmutil delete`, `rsync --del a b`, `tar --remove-files -cf x.tar a`, `zip -m x.zip a`, `docker rm x`,
  `gh repo delete --yes`, `sqlite3 db "DELETE FROM t"`, `npx rimraf a`, `curl --request DELETE https://x.y/z`, `shortcuts run "Delete All"`,
  `tee a.txt`, `cp /dev/null a.txt`, `ln -sf a b`, `unzip -o x.zip`];
for (const c of BYPASS) {
  const v = classifyCommand(c, HOME, { exists: () => false });
  assert.equal(v.level, 'ask', `${c} asks`);
  assert.equal(v.always, true, `${c} always asks, even with Skip Allow prompts on`);
}
// Only a few plain commands that make something new stay skippable.
for (const c of ['touch brand-new-riskgate-file.txt', 'cp a.txt riskgate-new-copy.txt', 'npm install']) assert.ok(!classifyCommand(c, HOME, { exists: () => false }).always, `${c} is not always`);
console.log(`skip allow bypass list: ${BYPASS.length} commands, every one always asks`);
console.log('always-ask command tests: passed');

const noop = async () => {};
const base = { allowActions: () => true, ui: () => {}, openUrl: noop, onCommitments: noop, showList: noop, fmtWhen: String, commitmentsText: () => '', userName: 'Test' };

// run_command and write_file with Skip Allow prompts on: these still ask, and a no keeps them from running.
{
  // Under /tmp (or home): write_file only writes there.
  const workdir = fs.mkdtempSync(path.join(process.platform === 'win32' ? os.homedir() : '/tmp', 'riskgate-'));
  const asked = [];
  const { createTools } = await import('../tools.mjs');
  const { tools } = createTools({ ...base, workdir, skipAllow: () => true, ask: async (o) => { asked.push(o); return null; } });
  const run = tools.find((t) => t.name === 'run_command'), write = tools.find((t) => t.name === 'write_file');
  for (const c of [...ALWAYS.slice(0, 5), ...BYPASS]) {
    asked.length = 0;
    await assert.rejects(run.execute({ command: c }, undefined), /said no/, `${c}: skip on still asks, and no refuses`);
    assert.equal(asked.length, 1, `${c}: asked once`);
    assert.equal(asked[0].always, true, `${c}: the ask says always, so an agent job can't auto-answer it`);
  }
  const f = path.join(workdir, 'keep.txt');
  fs.writeFileSync(f, 'old');
  asked.length = 0;
  await assert.rejects(write.execute({ path: f, content: 'new' }, undefined), /said no/, 'overwrite asks with skip on');
  assert.equal(fs.readFileSync(f, 'utf8'), 'old', 'and the file is untouched');
  assert.equal(asked.length, 1);
  // A new file needs no yes; a plain ask (touch) is still skipped.
  asked.length = 0;
  await write.execute({ path: path.join(workdir, 'new.txt'), content: 'hi' }, undefined);
  if (process.platform !== 'win32') await run.execute({ command: 'touch made.txt' }, undefined);
  assert.equal(asked.length, 0, 'ordinary steps still skip the Allow question');
  fs.rmSync(workdir, { recursive: true, force: true });
  console.log('skip allow never answers deletes, kills, quits or overwrites: passed');
}

// Agent jobs: the parent auto-answers a yes/no only when it isn't `always`.
{
  const src = fs.readFileSync(new URL('../agents.mjs', import.meta.url), 'utf8');
  assert.match(src, /m\.t === 'ask' && !m\.always && config\.skipAllow/, 'agent jobs pass always through');
}

// Labels and chords.
for (const l of ["Don't Save", 'Don’t Save', 'Move to Trash', 'Force Quit', 'Close Without Saving', 'Submit', 'Confirm', 'Overwrite',
  'Quit', 'Quit Anyway', 'Replace', 'Trash', 'Empty Bin', 'Shut Down', 'Restart', 'Post', 'Reply', 'Tweet']) assert.ok(isRiskyClick(l), `"${l}" needs a yes`);
for (const l of ['Save', 'Keep Both', 'Cancel', 'OK', 'Close']) assert.ok(!isRiskyClick(l), `"${l}" is a normal click`);
for (const k of ['cmd+q', 'Command+Q', 'cmd+delete', 'cmd+backspace', 'cmd+opt+delete', 'cmd+option+delete', 'cmd+shift+delete',
  'cmd+back', 'cmd+opt+back', 'command+del', 'cmd+shift+q', 'cmd+opt+shift+q', 'ctrl+cmd+q', 'cmd+return', 'cmd+enter', 'cmd+shift+d']) assert.ok(riskyKey(k), `${k} needs a yes`);
for (const k of ['cmd+s', 'cmd+w', 'delete', 'return', 'cmd+z', 'shift+return']) assert.equal(riskyKey(k), null, `${k} is a normal key`);
// Review M4: connected apps' tools that change, send or delete ask every time.
for (const name of ['trash_message', 'trash_file', 'create_payment', 'execute_sql', 'apply_migration', 'reset_branch', 'merge_branch', 'update_doc'])
  assert.equal(checkMcpCall({ name }).always, true, `${name} always asks`);
assert.equal(checkMcpCall({ name: 'list_files', annotations: { readOnlyHint: true } }).level, 'safe', 'a read-only tool runs');
console.log('risky labels and chords: passed');

// act_in_app against a fake helper that stops before a risky click_at or Return (needsConfirm), as the real one does.
if (['darwin', 'win32'].includes(process.platform)) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'riskgate-hands-'));
  const log = path.join(dir, 'calls.jsonl'), fake = path.join(dir, 'hands.mjs');
  fs.writeFileSync(fake, `import fs from 'node:fs'; const a = process.argv.slice(2);
const win = { id: 7, app: 'Finder', title: 'Desktop', bounds: [0, 0, 800, 600] };
let o = { ok: true, window: win };
if (a[0] === 'act') {
  const p = JSON.parse(a[1]); fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(p.steps) + '\\n');
  // As the real helper: a risky step goes ahead only with a yes for exactly what it would hit.
  const hit = (s) => s.do === 'click_at' ? 'Move to Trash' : s.do === 'key' && s.key === 'return' ? 'Delete' : s.do === 'click_text' ? s.text : null;
  const i = p.steps.findIndex((s) => hit(s) && !(s.confirmed && s.confirmedLabel === hit(s)));
  o = i >= 0 ? { ok: false, needsConfirm: true, step: i, label: hit(p.steps[i]), why: 'That step could delete.', done: p.steps.slice(0, i).map((s) => s.do) } : { ok: true, done: p.steps.map((s) => s.do), window: win };
}
if (a[0] === 'capture') { fs.writeFileSync(a[1], 'x'); o = { ok: true, file: a[1], window: win, pixels: [800, 600] }; }
console.log(JSON.stringify(o));
`);
  process.env.ROAMIES_HANDS = fake;
  const { createTools } = await import(`../tools.mjs?riskgate`);
  let answer = null;
  const asked = [];
  const { tools } = createTools({ ...base, skipAllow: () => true, ask: async (o) => { asked.push(o); return answer; } });
  const act = tools.find((t) => t.name === 'act_in_app'), shot = () => tools.find((t) => t.name === 'take_screenshot').execute({ target: 'Finder' }, { toolCallId: 's' });
  const calls = () => fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  // A risky label: asks with skip on.
  await assert.rejects(act.execute({ target: 'Finder', steps: [{ do: 'click_text', text: 'Move to Trash' }] }, { toolCallId: 'r1' }), /said no/);
  assert.equal(asked.pop()?.always, true, 'risky click asks, always');
  // A risky chord: asks before anything runs.
  for (const key of ['cmd+q', 'cmd+delete', 'cmd+opt+delete', 'cmd+shift+delete']) {
    fs.writeFileSync(log, '');
    await assert.rejects(act.execute({ target: 'Finder', steps: [{ do: 'key', key }] }, { toolCallId: `k-${key}` }), /said no/, `${key} asks`);
    assert.equal(asked.pop()?.always, true);
    assert.equal(calls().length, 0, `${key}: nothing ran`);
  }
  // click_at on a risky spot: the helper stops there; a no stops the plan, a yes goes on from that step.
  fs.writeFileSync(log, '');
  await shot();
  await assert.rejects(act.execute({ target: 'Finder', steps: [{ do: 'type', text: 'a' }, { do: 'click_at', x: 10, y: 10 }, { do: 'type', text: 'b' }] }, { toolCallId: 'c1' }), /said no/);
  assert.equal(calls().length, 1, 'no: the plan stops at the risky spot');
  answer = 'Allow';
  fs.writeFileSync(log, '');
  await shot();
  const out = await act.execute({ target: 'Finder', steps: [{ do: 'type', text: 'a' }, { do: 'click_at', x: 10, y: 10 }, { do: 'type', text: 'b' }] }, { toolCallId: 'c2' });
  const c = calls();
  assert.equal(c.length, 2, 'yes: run again from the risky step');
  assert.deepEqual(c[1].map((s) => s.do), ['click_at', 'type'], 'only the steps from there on');
  assert.equal(c[1][0].confirmed, true);
  assert.equal(c[1][0].confirmedLabel, 'Move to Trash', 'the yes names what was asked about');
  assert.match(out, /type, click_at, type/, 'what was done before and after');
  // Return on a risky default button: same path.
  answer = null;
  await assert.rejects(act.execute({ target: 'Finder', steps: [{ do: 'key', key: 'return' }] }, { toolCallId: 'e1' }), /said no/);
  assert.equal(asked.pop()?.always, true, 'Return on a risky default button asks');
  // Review m2: two Delete clicks in one plan ask twice, not once for both.
  answer = 'Allow'; asked.length = 0;
  await act.execute({ target: 'Finder', steps: [{ do: 'click_text', text: 'Delete' }, { do: 'click_text', text: 'Delete' }] }, { toolCallId: 'd2' });
  assert.equal(asked.length, 2, 'each delete click asks on its own');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('risky click_at, chords and Return ask: passed');
}
