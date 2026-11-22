// Sixth security review (probes v6/a-l), with the owner's decisions: no shell tool (toolschema.test.mjs), write_file
// unasked only for a new plain file in Desktop, Documents or Downloads, every path check on the real path, recursive
// search never into secrets, every question shown whole, .app in any case. Run: npm test (its home is a temp folder).
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkLink, checkMcpServer, checkOpen, checkRead, checkWrite } from '../safety.mjs';
import { createTools } from '../tools.mjs';
import { createAgents } from '../agents.mjs';

const HOME = fs.realpathSync.native(os.homedir());
assert.ok(HOME.includes('roamies-test-') || HOME.startsWith(fs.realpathSync.native(os.tmpdir())), 'runs only with a temp home');
const lv = (v) => v.level;

// D2 (finding 1, 7): config files other programs run later are never made unasked, wherever they are.
for (const p of ['~/.config/git/config', '~/.config/git/attributes', '~/.oh-my-zsh/custom/evil.zsh', '~/.vimrc', '~/.config/nvim/init.lua', '~/.tmux.conf',
  '~/.yarnrc.yml', '~/proj/.yarnrc.yml', '~/Library/Python/3.12/lib/python/site-packages/evil.pth', '~/.local/lib/python3.12/site-packages/evil.pth',
  '~/.config/karabiner/karabiner.json', '~/.hammerspoon/init.lua', '~/.lldbinit', '~/.psqlrc', '~/.curlrc', '~/.wgetrc', '~/proj/mise.toml', '~/.config/mise/config.toml',
  '~/proj/proj.code-workspace', '~/Library/Application Support/Code/User/settings.json', '~/Library/Services/x.workflow/Contents/document.wflow', '~/Library/Scripts/x.scpt',
  '~/.p10k.zsh', '~/.zshrc.local', '~/proj/.git/refs/heads/main', '~/proj/.git/info/sparse-checkout', '~/notes.txt',
  // Inside the three folders: a dot part, a runnable or loaded file, a bundle.
  '~/Documents/.config/x', '~/Desktop/run.command', '~/Downloads/x.pth', '~/Documents/a.plist', '~/Documents/Flow.workflow/x', '~/Desktop/a.SH', '~/Documents/proj/.git/config2', '~/Documents/x.Tool'])
  assert.notEqual(lv(checkWrite(p, HOME)), 'safe', `${p} is not written unasked`);
for (const p of ['~/Desktop/notes.md', '~/Documents/proj/README.md', '~/Downloads/list.csv', '~/documents/case.txt'])
  assert.equal(lv(checkWrite(p, HOME)), 'safe', `${p}: a new plain file there needs no yes`);
assert.equal(lv(checkWrite('~/Documents/notes.md', HOME, { exists: true })), 'ask', 'overwriting always asks');
{
  const v = checkWrite('~/.config/git/config', HOME);
  assert.equal(v.reason, `Create ${path.join(HOME, '.config/git/config')}?`, 'the question shows the whole real path');
  assert.equal(v.always, true);
}
// D5 (finding 6): .app in any case.
for (const p of ['~/Documents/Evil.APP/Contents/MacOS/x', '~/proj/x.App/Info.plist', '~/Downloads/a.aPp']) assert.equal(lv(checkWrite(p, HOME)), 'block', p);

// D3 (finding 4): the data volume's second name and a symlinked home reach the same rules.
fs.mkdirSync(path.join(HOME, '.ssh'), { recursive: true }); fs.writeFileSync(path.join(HOME, '.ssh', 'id_rsa'), 'SSHSECRET');
if (process.platform === 'darwin') {
  const D = `/System/Volumes/Data${HOME}`;
  assert.equal(lv(checkRead(`${D}/.ssh/id_rsa`, HOME)), 'block', 'firmlink to a key');
  assert.equal(lv(checkRead(D, HOME, { recursive: true })), 'block', 'firmlink to all of home');
  for (const top of ['/System/Volumes/Data', '/System/Volumes/Data/Users', '/USERS', path.dirname(HOME), `${D}/..`]) assert.equal(lv(checkRead(top, HOME, { recursive: true })), 'block', top);
  assert.equal(lv(checkWrite(`${D}/.zshrc`, HOME)), 'block', 'firmlink to a startup file');
  assert.equal(lv(checkWrite(`${D}/Library/LaunchAgents/x.plist`, HOME)), 'block');
  assert.equal(lv(checkWrite(`${D}/Documents/a.txt`, HOME)), 'safe', 'and it is the same Documents');
  assert.equal(checkWrite(`${D}/Documents/a.txt`, HOME).path, path.join(HOME, 'Documents/a.txt'), 'written at the real path');
}
{
  const link = `${HOME}-link`;
  fs.symlinkSync(HOME, link);
  assert.equal(lv(checkRead(HOME, link, { recursive: true })), 'block', 'home given as a link: its real path is still all of home');
  assert.equal(lv(checkRead(`${HOME}/.ssh/id_rsa`, link)), 'block');
  assert.equal(lv(checkWrite(`${HOME}/.zshrc`, link)), 'block');
  assert.equal(lv(checkWrite(`${link}/Documents/x.md`, HOME)), 'safe');
  fs.unlinkSync(link);
}
// Finding 10: home and path compared part by part, so a letter whose lower case is longer can't shift where home ends.
assert.equal(lv(checkWrite('/Users/İvan/.ZSHRC', '/Users/i̇van')), 'block', 'İ vs i + dot above');
assert.equal(lv(checkWrite('/Users/İvan/Documents/x.md', '/Users/i̇van')), 'safe');
assert.equal(lv(checkRead('/Users/İvan', '/Users/i̇van', { recursive: true })), 'block');
assert.equal(lv(checkRead('/Users/KEN/.ſsh/id_rsa', '/Users/ken')), 'block', 'ſ folds to s, as on APFS');
assert.equal(lv(checkRead('~/.cargo/credentials.toml', HOME)), 'block', 'cargo\'s registry token (probe i)');
// open: judged where a link leads.
{
  fs.mkdirSync(path.join(HOME, 'Downloads'), { recursive: true });
  fs.mkdirSync(path.join(HOME, 'Downloads', 'Evil.app'), { recursive: true });
  fs.symlinkSync(path.join(HOME, 'Downloads', 'Evil.app'), path.join(HOME, 'Downloads', 'notes.txt'));
  assert.equal(lv(checkOpen('~/Downloads/notes.txt', HOME)), 'block', 'a link named like a document that leads to an app');
}

// D3 (finding 3): search_files never goes into or returns secrets, other apps' data or links; never all of home.
{
  const proj = path.join(HOME, 'Documents', 'proj');
  fs.mkdirSync(path.join(proj, 'certs'), { recursive: true }); fs.mkdirSync(path.join(proj, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.env'), 'STRIPE=sk_live_SECRET\n'); fs.writeFileSync(path.join(proj, 'certs', 'server.key'), 'KEY_SECRET\n');
  fs.writeFileSync(path.join(proj, 'id_ed25519'), 'ED_SECRET\n'); fs.writeFileSync(path.join(proj, 'notes.md'), 'a plain SECRET word\n');
  fs.mkdirSync(path.join(proj, '.config', 'gh'), { recursive: true }); fs.writeFileSync(path.join(proj, '.config', 'gh', 'hosts.yml'), 'oauth_token: GH_SECRET\n');
  fs.mkdirSync(path.join(proj, '.docker'), { recursive: true }); fs.writeFileSync(path.join(proj, '.docker', 'config.json'), '{"auth":"DOCKER_SECRET"}');
  fs.symlinkSync(path.join(HOME, '.ssh'), path.join(proj, 'sub', 'keys'));
  fs.mkdirSync(path.join(HOME, '.gg'), { recursive: true }); fs.writeFileSync(path.join(HOME, '.gg', 'auth.json'), '{"t":"GG_SECRET"}');
  const { tools } = createTools({ allowActions: () => true, ui: () => {}, ask: async () => null, openUrl: async () => {}, onCommitments: () => {}, showList: () => {}, fmtWhen: String, commitmentsText: () => '', userName: 'Test', workdir: HOME });
  const search = (dir) => tools.find((t) => t.name === 'search_files').execute({ pattern: 'SECRET', dir }, undefined);
  const out = await search('~/Documents/proj');
  assert.match(out, /notes\.md:1:a plain SECRET word/, 'ordinary files are searched');
  for (const s of ['sk_live', 'KEY_SECRET', 'ED_SECRET', 'GH_SECRET', 'DOCKER_SECRET', 'SSHSECRET']) assert.ok(!out.includes(s), `${s} never comes back`);
  for (const d of ['~', HOME, '/Users', path.dirname(HOME), '~/Documents/proj/sub/keys', ...(process.platform === 'darwin' ? [`/System/Volumes/Data${HOME}`] : [])])
    await assert.rejects(search(d), /Blocked for safety/, `search ${d}`);
  assert.ok(!(await search('~/.gg')).includes('GG_SECRET'), 'a folder with a key file in it: searched, the key file never');
  await assert.rejects(tools.find((t) => t.name === 'read_file').execute({ path: '~/Documents/proj/sub/keys/id_rsa' }, undefined), /Blocked for safety/, 'read through a link');
}
// write_file writes where it checked, and a new file in Documents needs no yes; a dotfile asks with its full path.
{
  const asked = [];
  const { tools } = createTools({ allowActions: () => true, ui: () => {}, ask: async (o) => { asked.push(o); return null; }, openUrl: async () => {}, onCommitments: () => {}, showList: () => {}, fmtWhen: String, commitmentsText: () => '', userName: 'Test', workdir: HOME });
  const write = tools.find((t) => t.name === 'write_file');
  await write.execute({ path: '~/Documents/new.md', content: 'hi' }, undefined);
  assert.equal(fs.readFileSync(path.join(HOME, 'Documents', 'new.md'), 'utf8'), 'hi');
  await assert.rejects(write.execute({ path: '~/.config/git/config', content: '[core]\n\tfsmonitor = /tmp/x' }, undefined), /said no/);
  assert.equal(asked.at(-1).placeholder, `Create ${path.join(HOME, '.config/git/config')}?`);
  assert.ok(!fs.existsSync(path.join(HOME, '.config/git/config')), 'nothing written on a no');
  asked.length = 0;
  await assert.rejects(write.execute({ path: '~/Documents/new.md', content: 'x' }, undefined), /said no/, 'overwriting asks');
  assert.equal(asked.length, 1);
}

// D4 (finding 2): every question is shown whole.
{
  const long = `Run npx server-pkg ${'--flag '.repeat(80)}--then rm -rf ~/Documents`;
  assert.equal(checkMcpServer({ name: 'x', command: 'npx', args: long.split(' ').slice(2) }).reason, long, 'a connection\'s command, uncut');
  const kids = [];
  const fork = () => { const c = new EventEmitter(); Object.assign(c, { sent: [], connected: true, send(m) { c.sent.push(m); }, kill() {} }); kids.push(c); return c; };
  const config = { model: async () => ({ provider: 'anthropic', model: 'm1', route: 'api' }), creds: async () => ({}), allowActions: () => true, open: async () => {}, reveal: async () => {} };
  const events = [];
  const mgr = createAgents({ fork, ui: (m) => { if (m.e) events.push(m.e); }, config, root: path.join(HOME, 'HydraAgent'), userName: 'Ken', runner: '/x/agentrun.mjs', safety: { checkRead, checkWrite, checkOpen, checkLink }, home: HOME, now: () => 1 });
  const a = await mgr.start({ type: 'maker', title: 'Q', brief: 'x' });
  const q = `Create ${HOME}/${'deep/'.repeat(80)}x.sh?`;
  kids[0].emit('message', { t: 'ask', id: 1, question: q, always: true });
  assert.equal(mgr.get(a.id).ask.question, q, 'an agent\'s question reaches the owner whole');
  assert.equal(events.filter((e) => e.type === 'ask').at(-1).agent.ask.question, q);
  const worker = fs.readFileSync(new URL('../agentrun.mjs', import.meta.url), 'utf8');
  assert.match(worker, /question: String\(opts\?\.placeholder \?\? ''\),/, 'the worker passes it on uncut');
  const ui = fs.readFileSync(new URL('../../../roamies/agent-home.js', import.meta.url), 'utf8');
  assert.ok(!/\.ah-q \{[^}]*line-clamp/.test(ui) && /\.ah-q \{[^}]*overflow: hidden auto/.test(ui), 'the row shows it all, scrolling when long');
  const bubble = fs.readFileSync(new URL('../../../roamies/agent.js', import.meta.url), 'utf8');
  assert.match(bubble, /const s0 = ph && !bb\.input\.choices \? 0 : bb\.scroll\.x/, 'the bubble scrolls a long yes/no question');
}
console.log('sixth review: passed');
