// Security reviews: every ask asks the owner (the "Skip Allow prompts" setting is gone); overwrite, delete, quit, send
// and pay steps (owner: every deletion of anything is confirmed, no exceptions), and risky clicks by position, risky key
// chords and Return on a risky default button ask too. There is no shell tool (sixth review). Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkMcpCall, checkWrite, isRiskyClick, riskyKey } from '../safety.mjs';

const HOME = os.homedir();
// Third review: case-insensitive protected places (APFS), app bundles, files another tool runs later.
{
  const H3 = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-third-'));
  if (process.platform === 'darwin') {
    const up = H3.toUpperCase();
    assert.equal(checkWrite(`${up}/.zshrc`, H3).level, 'block');
    assert.equal(checkWrite(`${up}/Documents/notes.txt`, H3).level, 'safe', 'a home spelled in capitals is still home');
  }
  // .app: an app bundle in any case (sixth review: ~/proj/Foo.APP/x was writable).
  assert.equal(checkWrite(`${H3}/Applications/Foo.APP/Contents/x`, H3).level, 'block');
  assert.equal(checkWrite('/Applications/Foo.App/x', H3).level, 'block');
  assert.equal(checkWrite(`${H3}/proj/Foo.app/x`, H3).level, 'block');
  assert.equal(checkWrite(`${H3}/proj/Foo.APP/x`, H3).level, 'block');
  assert.equal(checkWrite(`${H3}/Documents/notes.APP`, H3).level, 'block', 'any name ending in .app, any case');
  // Files another tool runs later ask, always.
  // Seventh review F3: .envrc holds secrets too (any .env name), so it is never written or read.
  assert.equal(checkWrite(`${H3}/proj/.envrc`, H3).level, 'block');
  for (const f of ['.husky/pre-commit', 'proj/.vscode/tasks.json', 'proj/.vscode/settings.json', 'proj/.git/worktrees/w/gitdir', 'proj/.git/HEAD']) {
    const v = checkWrite(`${H3}/${f}`, H3); assert.ok(v.level === 'ask' && v.always, `${f} asks`);
  }
  fs.rmSync(H3, { recursive: true, force: true });
}
// Fourth review: project paths that merely share a name with a Mac folder are the project's. A repo's pointer and
// attribute files ask; its config and hooks are blocked.
{
  const H4 = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-fourth-'));
  for (const p2 of ['~/Documents/proj/src/cookies', '~/Documents/proj/lib/web data', '~/Documents/proj/library/mail', '~/Documents/proj/music/music', '~/Documents/proj/library/preferences/x.json'])
    assert.equal(checkWrite(p2, H4, { exists: false }).level, 'safe', `${p2} is a project file`);
  for (const p2 of ['~/proj/.git', '~/proj/.gitattributes', '~/proj/.gitmodules']) { const v = checkWrite(p2, H4, { exists: false }); assert.ok(v.level === 'ask' && v.always, `${p2} asks`); }
  for (const p2 of ['~/proj/.git/config', '~/proj/.git/config.worktree', '~/proj/.git/info/attributes', '~/proj/.git/modules/x/config', '~/proj/.git/modules/x/hooks/post-checkout', '~/proj/.git/objects/info/alternates'])
    assert.equal(checkWrite(p2, H4, { exists: false }).level, 'block', `${p2} is blocked`);
  for (const n of ['purge_cache', 'list_and_purge', 'find_and_replace', 'fetch_and_overwrite', 'check_out', 'getAndDelete', 'list.delete', 'read_and_quit', 'list_and_shutdown', 'get_runcmd', 'get_spawn', 'get_eval', 'list_uninstall', 'get_format', 'listPurge', 'list_prune', 'get_cleanup', 'get_discard', 'read_reboot', 'list_install'])
    assert.equal(checkMcpCall({ name: n, annotations: { readOnlyHint: true } }).level, 'ask', `${n} asks`);
  fs.rmSync(H4, { recursive: true, force: true });
  console.log('fourth review files and MCP names: passed');
}

const noop = async () => {};
const base = { allowActions: () => true, ui: () => {}, openUrl: noop, onCommitments: noop, showList: noop, fmtWhen: String, commitmentsText: () => '', userName: 'Test' };

// write_file: overwriting asks (a tool set made with the old skipAllow option too), and a no keeps it from running.
{
  const docs = path.join(HOME, 'Documents', `riskgate-${process.pid}`);
  fs.mkdirSync(docs, { recursive: true });
  const asked = [];
  const { createTools } = await import('../tools.mjs');
  const { tools } = createTools({ ...base, workdir: docs, skipAllow: () => true, ask: async (o) => { asked.push(o); return null; } });
  assert.equal(tools.find((t) => t.name === 'run_command'), undefined, 'no shell tool');
  const write = tools.find((t) => t.name === 'write_file');
  const f = path.join(docs, 'keep.txt');
  fs.writeFileSync(f, 'old');
  await assert.rejects(write.execute({ path: f, content: 'new' }, undefined), /said no/, 'overwrite asks with skip on');
  assert.equal(fs.readFileSync(f, 'utf8'), 'old', 'and the file is untouched');
  assert.equal(asked.length, 1);
  assert.equal(asked[0].always, true, 'the ask says always, so an agent job can\'t auto-answer it');
  // A new file in Documents asks too (owner's rule), naming it.
  asked.length = 0;
  await assert.rejects(write.execute({ path: path.join(docs, 'new.txt'), content: 'hi' }, undefined), /said no/);
  assert.equal(asked.length, 1, 'a new file asks');
  assert.equal(asked[0].placeholder, `Create ${path.join(fs.realpathSync.native(docs), 'new.txt')}?`);
  assert.ok(!fs.existsSync(path.join(docs, 'new.txt')));
  fs.rmSync(docs, { recursive: true, force: true });
  console.log('skip allow never answers overwrites: passed');
}

// Agent jobs: the parent auto-answers a yes/no only when it isn't `always`.
{
  const src = fs.readFileSync(new URL('../agents.mjs', import.meta.url), 'utf8');
  assert.ok(!/skipAllow/.test(src), 'agent jobs never auto-answer');
  assert.match(src, /if \(allow && by !== 'owner' && a\.ask\.always\) return 'owner';/, 'answer_agent can say no, never yes, for the owner');
}

// Labels and chords.
for (const l of ["Don't Save", 'Don’t Save', 'Move to Trash', 'Force Quit', 'Close Without Saving', 'Submit', 'Confirm', 'Overwrite',
  'Quit', 'Quit Anyway', 'Replace', 'Trash', 'Empty Bin', 'Shut Down', 'Restart', 'Post', 'Reply', 'Tweet']) assert.ok(isRiskyClick(l), `"${l}" needs a yes`);
for (const l of ['Save', 'Keep Both', 'Cancel', 'OK', 'Close']) assert.ok(!isRiskyClick(l), `"${l}" is a normal click`);
for (const k of ['cmd+q', 'Command+Q', 'cmd+delete', 'cmd+backspace', 'cmd+opt+delete', 'cmd+option+delete', 'cmd+shift+delete',
  'cmd+back', 'cmd+opt+back', 'command+del', 'cmd+shift+q', 'cmd+opt+shift+q', 'ctrl+cmd+q', 'cmd+return', 'cmd+enter', 'cmd+shift+d']) assert.ok(riskyKey(k), `${k} needs a yes`);
for (const k of ['cmd+s', 'cmd+w', 'delete', 'return', 'cmd+z', 'shift+return']) assert.equal(riskyKey(k), null, `${k} is a normal key`);
// Second review B1: any order, read the way pressKey reads it (k.mjs).
const perms = (a) => (a.length <= 1 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p])));
for (const chord of [['cmd', 'q'], ['cmd', 'shift', 'q'], ['cmd', 'opt', 'shift', 'q'], ['cmd', 'delete'], ['cmd', 'opt', 'delete'], ['cmd', 'shift', 'delete'], ['cmd', 'opt', 'shift', 'delete'],
  ['cmd', 'return'], ['cmd', 'enter'], ['cmd', 'shift', 'd'], ['cmd', 'backspace'], ['cmd', 'back'], ['ctrl', 'cmd', 'q']])
  for (const p of perms(chord)) assert.ok(riskyKey(p.join('+')), `${p.join('+')} needs a yes`);
for (const k of ['CMD+Q', 'cmd+ q', 'Command + Q', 'cmd+del']) assert.ok(riskyKey(k), `${k} needs a yes`);
for (const k of ['meta+q', 'super+q', 'cmdorctrl+q', 'cmd+a+q']) assert.equal(riskyKey(k), null, `${k}: the helper presses nothing (not one key it knows)`);
// Second review M10 (m2.mjs): names that write ask whatever readOnlyHint says.
for (const n of ['update_file', 'execute_sql', 'run_query', 'archive_thread', 'apply_migration', 'create_payment', 'merge_branch', 'deploy_website', 'move_project_asset', 'batch',
  'sandbox_exec', 'set_variables', 'share_file', 'label_thread', 'gpu_rent', 'buy_domain', 'write_db', 'api_request', 'invoke', 'apps_invoke', 'query'])
  assert.equal(checkMcpCall({ name: n, annotations: { readOnlyHint: true } }).level, 'ask', `${n} asks even marked read-only`);
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
  const { tools } = createTools({ ...base, skipAllow: () => true, ask: async (o) => { asked.push(o); return typeof answer === 'function' ? answer(o.placeholder) : answer; } });
  // Owner's rule: every plan is asked first as a whole ("In Finder, every step…"); these cases say yes to that.
  const planYes = (q) => (q.startsWith('In Finder, every step') ? 'Allow' : null);
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
  answer = planYes;
  await assert.rejects(act.execute({ target: 'Finder', steps: [{ do: 'type', text: 'a' }, { do: 'click_at', x: 10, y: 10 }, { do: 'type', text: 'b' }] }, { toolCallId: 'c1' }), /said no/);
  assert.equal(calls().length, 1, 'no: the plan stops at the risky spot');
  // A no to the whole plan: nothing reaches the helper.
  answer = null; fs.writeFileSync(log, ''); await shot();
  await assert.rejects(act.execute({ target: 'Finder', steps: [{ do: 'type', text: 'a' }] }, { toolCallId: 'c0' }), /said no/);
  assert.equal(calls().length, 0, 'no to the plan: nothing ran');
  assert.ok(asked.at(-1).placeholder.includes('1. type "a"'), 'the plan question shows the step');
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
  answer = planYes;
  await assert.rejects(act.execute({ target: 'Finder', steps: [{ do: 'key', key: 'return' }] }, { toolCallId: 'e1' }), /said no/);
  assert.equal(asked.pop()?.always, true, 'Return on a risky default button asks');
  // Review m2: two Delete clicks in one plan ask twice, not once for both.
  answer = 'Allow'; asked.length = 0;
  await act.execute({ target: 'Finder', steps: [{ do: 'click_text', text: 'Delete' }, { do: 'click_text', text: 'Delete' }] }, { toolCallId: 'd2' });
  assert.equal(asked.length, 3, 'the plan, then each delete click on its own');
  assert.ok(asked[0].placeholder.includes('1. click "Delete"') && asked[0].placeholder.includes('2. click "Delete"'), 'the plan names both');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('risky click_at, chords and Return ask: passed');
}
