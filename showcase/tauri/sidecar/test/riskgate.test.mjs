// Security reviews: every ask asks the owner (the "Skip Allow prompts" setting is gone); delete, kill, quit, send, pay, overwrite and move-to-Trash
// steps (owner: every deletion of anything is confirmed, no exceptions), and risky clicks by position, risky key chords
// and Return on a risky default button ask too. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkMcpCall, checkWrite, classifyCommand, isRiskyClick, riskyKey } from '../safety.mjs';

const HOME = os.homedir();
// Each of these asks and is marked `always`.
const ALWAYS = ['rm ~/Desktop/a.txt', 'mv ~/Desktop/a.txt ~/.Trash/', 'pkill -9 Safari', 'killall TextEdit', `osascript -e 'quit app "Notes"'`,
  'trash ~/Desktop/a.txt', 'kill 4242', 'bash -c "rm notes.txt"', 'git push --force', 'git reset --hard HEAD~1', 'sed -i "" s/a/b/ notes.txt',
  'curl -d "x=1" https://example.com/pay', 'find ~/Projects/logs -name "*.log" -delete', 'mail -s hi someone@example.com', 'npm publish'];
for (const c of ALWAYS) {
  const v = classifyCommand(c, HOME, { exists: () => false });
  assert.equal(v.level, 'ask', `${c} asks`);
  assert.equal(v.always, true, `${c} always asks`);
}
// Review B1: every way round the first program, all of which used to come back skippable.
const BYPASS = [`bash -lc "rm a"`, `zsh -ic "rm a"`, `( rm a )`, `{ rm a; }`, `if true; then rm a; fi`, `for f in a b; do rm $f; done`, `! rm a`,
  `ls | xargs -I {} rm {}`, `xargs -n 1 rm`, `env -u FOO rm a`, `nice -n 10 rm a`, `timeout 5 rm a`, `watch rm a`, `r''m a`, `echo $(rm a)`,
  `python3 -c "import os; os.remove('a')"`, `node -e "require('fs').rmSync('a')"`, `perl -e 'unlink("a")'`, `ruby -e "File.delete('a')"`, `git rm a`,
  `defaults delete com.apple.dock`, `tmutil delete`, `rsync --del a b`, `tar --remove-files -cf x.tar a`, `zip -m x.zip a`, `docker rm x`,
  `gh repo delete --yes`, `sqlite3 db "DELETE FROM t"`, `npx rimraf a`, `curl --request DELETE https://x.y/z`, `shortcuts run "Delete All"`,
  `tee a.txt`, `cp /dev/null a.txt`, `ln -sf a b`, `unzip -o x.zip`];
for (const c of BYPASS) {
  // Run from a project folder (unpacking into the home folder itself is blocked outright).
  const v = classifyCommand(c, HOME, { cwd: path.join(HOME, 'proj'), exists: () => false });
  assert.equal(v.level, 'ask', `${c} asks`);
  assert.equal(v.always, true, `${c} always asks`);
}
// Second review: the commands the old allowlist let through, and copies into protected places. Every one asks (or is
// blocked); nothing is skippable any more.
const P2 = ['git switch --discard-changes main', 'git switch -C main', 'git checkout -B main', 'git checkout -b x --force', 'git checkout -- .', 'git checkout file.txt', 'git checkout .',
  'git stash push', 'git stash push -u', 'git pull', 'git pull origin +main:main', 'git fetch origin +main:main', 'git fetch --prune', 'git fetch -p',
  'git clone --upload-pack=python3 /tmp/x y', 'git clone -u python3 /tmp/x y', 'git fetch --upload-pack=python3 /tmp/x', 'git clone -c core.fsmonitor=/tmp/evil.sh /tmp/r y', 'git commit --amend', 'git commit -c core.x',
  'git tag v1', 'git tag -a v1', 'git add -A', 'git init', 'npm run clean', 'npm test', 'npm install', 'npm i -g evilpkg', 'npm init evilpkg', 'npm ci', 'pnpm run nuke', 'pnpm add x', 'yarn run x', 'yarn add x', 'pnpm test',
  'cargo build', 'cargo run', 'cargo test', 'brew install x', 'pip install .', 'pip install evil', 'pip3 install -e .', 'touch exists.txt', 'touch newfile',
  'cp a proj/exists.txt', 'cp a proj', 'cp -r src newdir', 'ditto a b', 'cp -f a newname', 'cp -n a newname', 'cp -R ~/Documents /tmp/exfil', 'cp /dev/urandom big.bin'];
for (const c of P2) { const v = classifyCommand(c, HOME, { cwd: HOME, exists: () => false }); assert.ok(v.level === 'block' || (v.level === 'ask' && v.always), `${c}: ${v.level}`); }
const PROTECTED = ['mkdir -p ~/Library/LaunchAgents/x', 'mkdir ~/HydraAgent/Skills/x', 'cp evil.plist ~/Library/LaunchAgents/com.x.plist', 'cp x ~/.zshenv',
  'cp x ~/HydraAgent/Skills/new/SKILL.md', 'cp x ~/Applications/Foo.app/Contents/MacOS/foo', 'cp x ~/.ssh/authorized_keys', 'ditto x ~/Library/LaunchAgents/a.plist',
  'git clone https://example.com/r ~/Library/LaunchAgents/r', 'tee ~/.zshrc', 'mv x ~/.bash_profile', 'ln -s /tmp/x ~/Library/LaunchAgents/x.plist', 'curl -o ~/.zshrc https://x.y/z'];
for (const c of PROTECTED) assert.equal(classifyCommand(c, HOME, { cwd: HOME, exists: () => false }).level, 'block', `${c} is blocked`);
// Third review: case-insensitive protected places (APFS), $HOME forms, folder-contents copies, -t/-o/-P/-C/-d forms,
// sed -i, find's writing primaries, npm audit fix, scutil --set, git status (filters), less +cmd, .git/hooks.
{
  const H3 = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-third-'));
  const B3 = ['cp a ~/.Zshenv', 'echo x > ~/.ZSHENV', 'printf x > ~/.Zlogin', 'cp a ~/.Bash_profile', 'cp a ~/.config/Fish/config.fish', 'cp a ~/.Gitconfig',
    'mkdir -p ~/library/launchagents', 'echo x > ~/library/launchagents/x.plist', 'echo x > ~/Applications/Evil.APP/Contents/MacOS/x', 'cp a $HOME/.zshrc', 'cp a "${HOME}/.zshrc"', 'cp a "$HOME"/.zshrc',
    'ditto evil ~/Library', 'cp -R evil/. ~/Library/', 'rsync -a evil/ ~/Library/', 'cp -t ~/Library/LaunchAgents a', 'cp --target-directory=~/.ssh a', 'mv -t ~/.ssh a',
    'curl -o~/.zshrc https://x', 'curl --output=~/.zshrc https://x', 'wget https://x -P ~/Library/LaunchAgents', 'tar -xf x.tar -C ~/Library/LaunchAgents', 'unzip x.zip -d ~/Library',
    'sed -i "" s/a/b/ ~/.zshrc', 'git log --output=~/.zshrc', 'echo x > .git/hooks/pre-commit', 'mkdir -p .git/hooks', 'cp hook .git/config'];
  for (const c of B3) assert.equal(classifyCommand(c, H3, { cwd: H3, exists: () => false }).level, 'block', `${c} is blocked`);
  const A3 = ['find proj -fls out', 'find proj -fprint out', 'find proj -fprintf out %p', 'find proj -delete', 'npm audit fix', 'npm audit fix --force', 'npm audit --fix', 'scutil --set HostName x',
    'git status', 'git status --porcelain', 'git ls-files', 'git describe', 'less +!rm a', 'more +/x a'];
  for (const c of A3) { const v = classifyCommand(c, H3, { cwd: H3, exists: () => false }); assert.ok(v.level === 'ask' && v.always, `${c}: ${v.level}`); }
  // Fourth review: only the pure-read tools run without a yes; git, npm and the rest all ask.
  for (const c of ['ls -la', 'cat a', 'wc -l a', 'scutil --get HostName', 'head -5 a 2>/dev/null', 'ls | grep x']) assert.equal(classifyCommand(c, H3, { cwd: H3, exists: () => false }).level, 'safe', `${c} only reads`);
  for (const c of ['npm audit', 'npm ls', 'git log', 'git rev-parse HEAD', 'git log -U1', 'git log --cc', 'git log -S x', 'git remote show origin', 'less a', 'brew list', 'python3 -V', 'make -n', 'open .', 'curl https://x', 'echo x > new', 'mkdir x', 'scutil --get A --set B']) {
    const v = classifyCommand(c, H3, { cwd: H3, exists: () => false }); assert.ok(v.level === 'ask' && v.always, `${c} asks`);
  }
  console.log(`third review commands: ${B3.length} blocked, ${A3.length} ask`);
  fs.rmSync(H3, { recursive: true, force: true });
}
// Fourth review: ordinary recursive copies, clones and unpacks into projects or backups ask (they were blocked); only
// the home folder itself or a folder above a protected place blocks. Project paths that merely share a name with a
// Mac folder are fine. A repo's pointer and attribute files ask; its config and hooks are blocked.
{
  const H4 = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-fourth-'));
  for (const c of ['cp -a src/. ~/proj', 'cp -r src ~/proj', 'tar -xf a.tar -C ~/proj', 'git clone https://x/y.git ~/proj/y', 'unzip a.zip -d ~/Downloads/x', 'cp -R ~/Downloads/x ~/Desktop', 'rsync -a ~/proj/ ~/backup/', 'cp -r ~/Projects ~/Backup', 'tar -cf x.tar a', 'unzip -o x.zip'])
    { const v = classifyCommand(c, H4, { cwd: path.join(H4, 'proj'), exists: () => false }); assert.ok(v.level === 'ask' && v.always, `${c}: ${v.level}`); }
  for (const c of ['cp -r x ~/', 'rsync -a dir/ ~/', 'tar -xf a.tar -C ~', 'ditto src ~/Library', 'curl -O --output-dir ~/Library/LaunchAgents https://x/y.plist', 'sed --in-place s/a/b/ ~/.zshrc', 'perl -0pi -e s/a/b/ ~/.zshrc', 'patch ~/.zshrc p.diff', 'echo x > "$HOME"/.zshrc', 'echo x >| ~/.zshrc'])
    assert.equal(classifyCommand(c, H4, { cwd: path.join(H4, 'proj'), exists: () => false }).level, 'block', `${c} is blocked`);
  for (const c of ['tar -xzf a.tgz', 'unzip a.zip']) assert.equal(classifyCommand(c, H4, { cwd: H4, exists: () => false }).level, 'block', `${c} in the home folder is blocked`);
  for (const p2 of ['~/proj/src/cookies', '~/proj/lib/web data', '~/proj/library/mail', '~/proj/music/music', '~/proj/library/preferences/x.json'])
    assert.equal(checkWrite(p2, H4, { exists: false }).level, 'safe', `${p2} is a project file`);
  for (const p2 of ['~/proj/.git', '~/proj/.gitattributes', '~/proj/.gitmodules']) { const v = checkWrite(p2, H4, { exists: false }); assert.ok(v.level === 'ask' && v.always, `${p2} asks`); }
  for (const p2 of ['~/proj/.git/config', '~/proj/.git/config.worktree', '~/proj/.git/info/attributes', '~/proj/.git/modules/x/config', '~/proj/.git/modules/x/hooks/post-checkout', '~/proj/.git/objects/info/alternates'])
    assert.equal(checkWrite(p2, H4, { exists: false }).level, 'block', `${p2} is blocked`);
  for (const n of ['purge_cache', 'list_and_purge', 'find_and_replace', 'fetch_and_overwrite', 'check_out', 'getAndDelete', 'list.delete', 'read_and_quit', 'list_and_shutdown', 'get_runcmd', 'get_spawn', 'get_eval', 'list_uninstall', 'get_format', 'listPurge', 'list_prune', 'get_cleanup', 'get_discard', 'read_reboot', 'list_install'])
    assert.equal(checkMcpCall({ name: n, annotations: { readOnlyHint: true } }).level, 'ask', `${n} asks`);
  fs.rmSync(H4, { recursive: true, force: true });
  console.log('fourth review commands, files and MCP names: passed');
}
// M3: a repo whose .git/config runs a program from fsmonitor, a pager or a hook: the read-only git commands that run
// without a yes run with those switched off (git log), and git status asks.
if (process.platform !== 'win32') {
  const repo = fs.mkdtempSync(path.join('/tmp', 'hydra-fsm-'));
  const marker = path.join(repo, 'PWNED'), evil = path.join(repo, 'evil.sh');
  fs.writeFileSync(evil, `#!/bin/sh\ntouch ${marker}\n`); fs.chmodSync(evil, 0o755);
  const { execFileSync } = await import('node:child_process');
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'config', 'core.fsmonitor', evil]); execFileSync('git', ['-C', repo, 'config', 'core.pager', evil]);
  execFileSync('git', ['-C', repo, '-c', 'core.fsmonitor=false', 'commit', '-q', '--allow-empty', '-m', 'x'], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  fs.rmSync(marker, { force: true });
  const { createTools: ct } = await import('../tools.mjs');
  const askedG = [];
  const { tools: tg } = ct({ allowActions: () => true, ui: () => {}, openUrl: async () => {}, onCommitments: async () => {}, showList: async () => {}, fmtWhen: String, commitmentsText: () => '', userName: 'Test', workdir: repo, ask: async (o) => { askedG.push(o); return null; } });
  const rc = tg.find((t) => t.name === 'run_command');
  // Every git command asks now (fourth review); with a no, nothing runs at all.
  for (const command of ['git log --oneline', 'git rev-parse HEAD', 'git log -U1', 'git remote show origin']) await assert.rejects(rc.execute({ command }, undefined), /said no/, `${command} asks`);
  assert.equal(askedG.length, 4, 'each git command asked');
  assert.ok(!fs.existsSync(marker), "and the repo's fsmonitor and pager never ran");
  await assert.rejects(rc.execute({ command: 'git status' }, undefined), /said no/, 'git status asks');
  assert.ok(!fs.existsSync(marker));
  fs.rmSync(repo, { recursive: true, force: true });
  console.log('malicious repo config: nothing ran');
}
console.log(`second review commands: ${P2.length} ask, ${PROTECTED.length} protected destinations blocked`);
console.log('always-ask command tests: passed');

const noop = async () => {};
const base = { allowActions: () => true, ui: () => {}, openUrl: noop, onCommitments: noop, showList: noop, fmtWhen: String, commitmentsText: () => '', userName: 'Test' };

// run_command and write_file: these ask (a tool set made with the old skipAllow option too), and a no keeps them from running.
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
  // A new file needs no yes (write_file makes it); a shell command that changes anything asks.
  asked.length = 0;
  await write.execute({ path: path.join(workdir, 'new.txt'), content: 'hi' }, undefined);
  assert.equal(asked.length, 0, 'a new file needs no yes');
  if (process.platform !== 'win32') await assert.rejects(run.execute({ command: 'touch made.txt' }, undefined), /said no/, 'touch asks too');
  fs.rmSync(workdir, { recursive: true, force: true });
  console.log('skip allow never answers deletes, kills, quits or overwrites: passed');
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
