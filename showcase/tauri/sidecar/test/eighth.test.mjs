// Eighth security review (probes v8/probe1.log, probe_open.log) and the owner's "undo deletions and past behaviors",
// each with a check that fails without its fix. Run: npm test (its home is a temp folder; the hands helper is a fake).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkMcpCall, checkOpen, checkRead, checkTyped, checkWrite } from '../safety.mjs';

const HOME = fs.realpathSync.native(os.homedir());
assert.ok(HOME.includes('roamies-test-') || HOME.startsWith(fs.realpathSync.native(os.tmpdir())), 'runs only with a temp home');
const lv = (v) => v.level;
const mk = (rel, body = 'x') => { const p = path.join(HOME, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); return p; };

// V8-1: in an app folder only a whole app bundle opens unasked; a script or tool there (or inside a bundle) never.
for (const t of ['/Applications/Fix.command', '/applications/fix.COMMAND', '/System/Library/CoreServices/x.sh', '/Applications/Python 3.12/Update Shell Profile.command',
  '/Applications/Safari.app/Contents/MacOS/Safari', '/Applications/Tool', '/Applications/x.terminal', '/Applications/Some.app/Contents/Resources/run.sh'])
  assert.equal(lv(checkOpen(t, HOME, { executable: true })), 'block', `open ${t}`);
assert.equal(lv(checkOpen('/Applications/Fix.command', HOME)), 'block', 'a script by its name, executable bit or not');
for (const t of ['/Applications/Safari.app', '/APPLICATIONS/Safari.APP', '/System/Applications/Notes.app']) assert.equal(lv(checkOpen(t, HOME)), 'safe', `open ${t}`);

// V8-2 (open's side): apps that run code from what they're given are never the app a file opens in.
mk('Documents/payload.txt');
for (const app of ['Sublime Text', 'Nova', 'BBEdit', 'TextMate', 'MacVim', 'Emacs', 'Alfred 5', 'Raycast', 'Swift Playgrounds', 'Wave', 'Shortcuts'])
  assert.equal(lv(checkOpen('~/Documents/payload.txt', HOME, { app })), 'block', `open in ${app}`);

// V8-4: typed text: a path after =, one with no leading ~ or /, and an invisible character before a scheme.
for (const t of ['.ssh/id_rsa', '--key=~/.ssh/id_rsa', '​javascript:alert(1)', '​file:///etc/passwd', 'Library/Keychains/login.keychain-db', 'a=.aws/credentials'])
  assert.equal(lv(checkTyped(t, HOME)), 'block', `type ${JSON.stringify(t)}`);
for (const t of ['~/', 'hello world', 'and/or', 'https://example.com/a/b', 'Documents/report.md']) assert.equal(lv(checkTyped(t, HOME)), 'safe', `type ${JSON.stringify(t)}`);

// V8-6: a connected server's tool: nothing is skipped (long, multi-line, deep, other schemes), and a search or list
// tool is checked as a recursive read.
{
  const ro = { readOnlyHint: true };
  const call = (name, args) => lv(checkMcpCall({ name, annotations: ro, args, home: HOME }));
  assert.equal(call('read_file', { path: `${HOME}/${'a/../'.repeat(900)}.ssh/id_rsa` }), 'block', 'normalized before the check');
  assert.equal(call('read_file', { path: '~/.ssh/id_rsa\n' }), 'block', 'a trailing newline');
  assert.equal(call('read_file', { text: 'notes\n~/.aws/credentials' }), 'block', 'a path on a line of its own');
  let deep = { path: '~/.ssh/id_rsa' }; for (let i = 0; i < 12; i++) deep = { x: [deep] };
  assert.equal(call('read_file', deep), 'block', 'twelve levels deep');
  assert.equal(call('read_file', { uri: `fs://${HOME}/.ssh/id_rsa` }), 'block', 'another scheme');
  assert.equal(call('read_file', { uri: `vscode-file://vscode-app${HOME}/.ssh/id_rsa` }), 'block', 'a host before the path');
  assert.equal(call('search_code', { path: '~', pattern: 'PRIVATE KEY' }), 'block', 'searching the whole home');
  assert.equal(call('list_directory', { path: '/' }), 'block');
  assert.equal(call('get_page', { body: 'x'.repeat(9000) }), 'block', 'too long to check, to a tool that reads unasked');
  assert.equal(lv(checkMcpCall({ name: 'create_page', annotations: {}, args: { body: 'x'.repeat(9000) }, home: HOME })), 'ask', 'a write with a long body still just asks');
  assert.equal(call('read_file', { path: '~/Documents/a.md' }), 'ask', 'a server read asks (R10-3)');
  assert.equal(call('search_issues', { query: 'login bug', url: 'https://x.com/a' }), 'ask');
}

// V8-8: key files outside dot folders are never read.
for (const f of ['AuthKey_ABC123.p8', 'x.ppk', 'client_secret_123.apps.googleusercontent.com.json', 'proj-firebase-adminsdk-ab12.json', 'terraform.tfvars', 'deploy_key',
  'id_ed25519_sk', 'secrets.yml', 'wallet.dat', 'x.ovpn', 'config/master.key'])
  assert.equal(lv(checkRead(`~/Documents/${f}`, HOME)), 'block', `read ~/Documents/${f}`);
assert.equal(lv(checkRead('~/Documents/keynotes.md', HOME)), 'safe');

// V8-9: files tools run or load later are never made unasked in the safe folders.
for (const f of ['mise.local.toml', '.mise.toml', 'mise.dev.toml', 'a.pyz', 'a.jsx', 'a.vsix', 'a.alfredworkflow', 'a.afploc', 'a.ftploc', 'Makefile', 'proj/justfile'])
  assert.notEqual(lv(checkWrite(`~/Documents/${f}`, HOME)), 'safe', `write ~/Documents/${f}`);
assert.equal(lv(checkWrite('~/Documents/notes.md', HOME)), 'safe');

// V8-10 (binding D2): overwriting asks even in an agent's own folder; a new file there doesn't.
{
  const own = path.join(HOME, 'HydraAgent', 'Agents', 'a8');
  mk('HydraAgent/Agents/a8/files/x.md');
  const v = checkWrite(path.join(own, 'files', 'x.md'), HOME, { exists: true, own });
  assert.equal(v.level, 'ask'); assert.equal(v.always, true); assert.ok(v.reason.includes(path.join(own, 'files', 'x.md')), 'with the whole path');
  assert.equal(lv(checkWrite(path.join(own, 'files', 'x.md'), HOME, { own })), 'ask', 'found there even when not said');
  assert.equal(lv(checkWrite(path.join(own, 'files', 'new.md'), HOME, { own })), 'safe');
}

// V8-12: deleting keeps a copy in Recently deleted, and it can be put back.
{
  const store = await import('../store.mjs');
  const f = await store.addFact('Lives in Lisbon');
  await store.forgetFact(f.id);
  assert.ok(!store.listFacts().some((x) => x.text === 'Lives in Lisbon'));
  const b = store.listBin().find((x) => x.kind === 'fact');
  assert.equal(b.title, 'Lives in Lisbon');
  assert.match(await store.restoreFromBin(b.id), /Remembered again/);
  assert.ok(store.listFacts().some((x) => x.text === 'Lives in Lisbon' && x.id !== f.id), 'back, with a new id so sync keeps it');
  assert.ok(!store.listBin().some((x) => x.id === b.id), 'out of the bin');
  await store.addFact('Has a cat'); const n = await store.clearFacts();
  assert.equal(store.listFacts().length, 0);
  await store.restoreFromBin(store.listBin().find((x) => x.kind === 'facts').id);
  assert.equal(store.listFacts().length, n, 'forget everything is undone too');
  const c = await store.addCommitment('Call mum', null);
  await store.updateCommitment(c.id, { status: 'dropped' });
  await store.restoreFromBin(store.listBin().find((x) => x.kind === 'commitment').id);
  assert.ok(store.openCommitments().some((x) => x.text === 'Call mum'), 'a dropped commitment is open again');

  const jobs = await import('../jobs.mjs');
  const j = await jobs.addJob({ title: 'Tech news', brief: 'sum up', due: 'in 1h' });
  await jobs.removeJob(j.id);
  assert.equal(jobs.getJob(j.id), null);
  await store.restoreFromBin(store.listBin().find((x) => x.kind === 'job').id);
  assert.equal(jobs.getJob(j.id).paused, true, 'back, paused');

  const skills = await import('../skills.mjs');
  await skills.saveSkill({ name: 'weekly invoice', description: 'When making the invoice.', steps: '1. Open Numbers.' });
  await skills.deleteSkill('weekly invoice');
  assert.equal(skills.readSkill('weekly invoice'), null);
  await store.restoreFromBin(store.listBin().find((x) => x.kind === 'skill').id);
  assert.match(skills.readSkill('weekly invoice').steps, /Open Numbers/);

  const { createMcp } = await import('../mcp.mjs');
  const kept = new Map([['k', 'v']]), deleted = [];
  const mcp = createMcp({ file: path.join(HOME, 'mcp-test.json'), secrets: { get: async (k) => kept.get(k), set: async (k, v) => kept.set(k, v), delete: async (k) => { deleted.push(k); } }, manager: { connect: async () => ({ ok: true, tools: [] }), disconnect: async () => {} } });
  fs.writeFileSync(path.join(HOME, 'mcp-test.json'), JSON.stringify({ mcpServers: { notes: { command: 'npx', args: ['notes-mcp'], env: { TOKEN: '@roamies-secret' }, enabled: false } } }));
  await mcp.remove('notes');
  assert.equal(mcp.has('notes'), false);
  assert.equal(deleted.length, 0, 'its keys stay until the bin lets it go');
  await store.restoreFromBin(store.listBin().find((x) => x.kind === 'connection').id);
  assert.equal(mcp.has('notes'), true);
  // Past the 30 days, a connection's keys go with it.
  await mcp.remove('notes');
  await store.pruneBin(Date.now() + 31 * 864e5);
  assert.equal(deleted.length, 1, 'keys deleted when it leaves the bin');
  assert.equal(store.listBin().length, 0);
}

// The hands and file tools against a fake helper (macOS and Windows only).
if (['darwin', 'win32'].includes(process.platform)) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-eighth-'));
  const log = path.join(dir, 'calls.jsonl'), fake = path.join(dir, 'hands.mjs'), next = path.join(dir, 'next.json');
  fs.writeFileSync(fake, `import fs from 'node:fs'; const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + '\\n');
const n = fs.existsSync(${JSON.stringify(next)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(next)}, 'utf8')) : {};
const win = n.window ?? { id: 7, app: 'TextEdit', title: 'x', bounds: [0, 0, 800, 600] };
let o = { ok: true, window: win, controls: [], texts: [], note: '' };
if (a[0] === 'act') { const p = JSON.parse(a[1]); o = n.whole && !(p.wholeOk ?? []).includes(n.whole) ? { ok: false, needsConfirm: true, step: n.step ?? 0, whole: n.whole, app: win.app, label: n.whole, why: 'A Save or Open panel is up in TextEdit: in it any file in any folder can be picked, uploaded or made.', done: [] } : { ok: true, done: p.steps.map((s) => s.do), window: win }; }
if (a[0] === 'capture') { fs.writeFileSync(a[1], 'x'); o = a[2] === 'screen' ? { ok: true, file: a[1], what: 'screen', bounds: [0, 0, 1600, 1000], pixels: [1568, 980], shown: n.shown ?? [win] } : { ok: true, file: a[1], window: win, pixels: [800, 600] }; }
if (a[0] === 'front') o = { ok: true, app: win.app };
console.log(JSON.stringify(o));
`);
  process.env.ROAMIES_HANDS = fake;
  const { createTools, stepsText } = await import('../tools.mjs');
  const asks = [];
  let answer = null;
  const { tools, nextTurn } = createTools({ allowActions: () => true, ui: () => {}, ask: async (o) => { asks.push(o.placeholder); return answer; }, openUrl: async () => {}, onCommitments: () => {}, showList: () => {}, fmtWhen: String, commitmentsText: () => '', userName: 'Test', workdir: HOME });
  const T = (n) => tools.find((t) => t.name === n);
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const set = (n) => fs.writeFileSync(next, JSON.stringify(n));
  const reset = () => { fs.writeFileSync(log, ''); asks.length = 0; answer = null; };

  // V8-4: a secret path typed in pieces across steps (and across calls in one request) is one path.
  reset(); set({}); nextTurn(); answer = 'Allow';
  await assert.rejects(T('act_in_app').execute({ target: 'Google Chrome', steps: [{ do: 'key', key: 'cmd+shift+g' }, { do: 'type', text: '~/' }, { do: 'type', text: '.ss' }, { do: 'type', text: 'h/id_rsa' }] }, {}), /Blocked for safety/);
  await T('act_in_app').execute({ target: 'TextEdit', steps: [{ do: 'type', text: '~/.' }] }, {});
  await assert.rejects(T('act_in_app').execute({ target: 'TextEdit', steps: [{ do: 'type', text: 'aws/credentials' }] }, {}), /Blocked for safety/, 'joined across calls');
  nextTurn();
  await T('act_in_app').execute({ target: 'TextEdit', steps: [{ do: 'type', text: '~/.' }] }, {});
  nextTurn();
  assert.match(await T('act_in_app').execute({ target: 'TextEdit', steps: [{ do: 'type', text: 'ssh keys' }] }, {}), /In TextEdit/, 'a new request starts over');

  // V8-3, V8-4, V8-7: a file panel or Finder asks once, with every step left in full; a yes covers just those.
  reset(); set({ whole: 'panel', step: 1 }); nextTurn();
  const long = `com.example.agent-${'x'.repeat(200)}.plist`;
  const plan = { target: 'TextEdit', steps: [{ do: 'click_text', text: 'Save…' }, { do: 'key', key: 'cmd+shift+g' }, { do: 'type', text: '~/Lib' }, { do: 'key', key: 'tab' }, { do: 'fill', field: 'Save As:', text: long }, { do: 'click_text', text: 'Save' }] };
  // Owner's rule: the whole plan is asked first, every step in full; a no runs nothing.
  await assert.rejects(T('act_in_app').execute(plan, {}), /Test said no/);
  assert.ok(asks[0].startsWith('In TextEdit, every step'), asks[0]);
  for (const line of ['1. click "Save…"', '2. press cmd+shift+g', '3. type "~/Lib"', '4. press tab', `5. fill "Save As:" with "${long}"`, '6. click "Save"']) assert.ok(asks[0].includes(line), `the question shows ${line}`);
  assert.equal(calls().filter((c) => c[0] === 'act').length, 0, 'nothing ran');
  reset(); answer = 'Allow';
  assert.match(await T('act_in_app').execute(plan, {}), /In TextEdit/);
  assert.equal(asks.length, 2);
  assert.ok(asks[1].startsWith('A Save or Open panel is up in TextEdit'), asks[1]);
  for (const line of ['1. press cmd+shift+g', '2. type "~/Lib"', '3. press tab', `4. fill "Save As:" with "${long}"`, '5. click "Save"']) assert.ok(asks[1].includes(line), `the panel question shows ${line}`);
  assert.ok(!asks[1].includes('Save…"\n'), 'the step already done is not in it');
  const sent = JSON.parse(calls().filter((c) => c[0] === 'act').at(-1)[1]);
  assert.deepEqual(sent.wholeOk, ['plan', 'panel']);
  assert.equal(sent.planApp, 'TextEdit');
  assert.equal(sent.steps.length, 5, 'from the step the panel was found at');
  assert.equal(stepsText([{ do: 'type', text: 'a"b' }]), '1. type "a\\"b"');

  // V8-5: a whole-screen picture is refused when any window on it shows a secret, not just the front one.
  reset();
  set({ shown: [{ id: 1, app: 'Safari', title: 'x', bounds: [800, 0, 800, 1000], url: 'https://example.com' }, { id: 2, app: 'TextEdit', title: 'id_rsa', bounds: [0, 0, 800, 1000], document: mk('.ssh/id_rsa', 'KEY') }] });
  await assert.rejects(T('take_screenshot').execute({ target: 'screen' }, {}), /Blocked for safety: TextEdit shows/);
  for (const c of calls().filter((x) => x[0] === 'capture')) assert.ok(!fs.existsSync(c[1]), 'the picture is deleted');
  reset(); set({ shown: [{ id: 1, app: 'Safari', title: 'x', bounds: [0, 0, 800, 1000], url: 'https://example.com' }] });
  const shot = await T('take_screenshot').execute({ target: 'screen' }, {});
  assert.match(shot.content[0].text, /whole screen/);
  set({});

  // V8-11: a yes to read a hidden file is for that read only: the next read asks again.
  reset(); mk('.config/tool/settings.json', 'S'); answer = 'Allow';
  assert.equal(await T('read_file').execute({ path: '~/.config/tool/settings.json' }, {}), 'S');
  assert.equal(await T('read_file').execute({ path: '~/.config/tool/settings.json' }, {}), 'S');
  assert.equal(asks.length, 2, 'asked both times');

  // D3: list_files never names a secret.
  reset(); mk('Documents/box/.env', 'K'); mk('Documents/box/notes.md');
  const listed = await T('list_files').execute({ dir: '~/Documents/box' }, {});
  assert.ok(listed.includes('notes.md') && !listed.includes('.env'), listed);

  // V8-12: write_file keeps the old file; restore_deleted puts it back (asking, as it overwrites).
  reset(); answer = 'Allow';
  const doc = mk('Documents/plan.md', 'first');
  await T('write_file').execute({ path: '~/Documents/plan.md', content: 'second' }, {});
  assert.equal(fs.readFileSync(doc, 'utf8'), 'second');
  const listedBin = await T('list_deleted').execute({}, {});
  const id = /^(d[0-9a-f]{8}) {2}File before it was changed: .*plan\.md/m.exec(listedBin)?.[1];
  assert.ok(id, listedBin);
  reset(); answer = null;
  await assert.rejects(T('restore_deleted').execute({ id }, {}), /said no/);
  assert.ok(asks[0].includes(doc), 'the question names the file');
  reset(); answer = 'Allow';
  assert.match(await T('restore_deleted').execute({ id }, {}), /Put back/);
  assert.equal(fs.readFileSync(doc, 'utf8'), 'first', 'the change is undone');
  assert.match(await T('list_deleted').execute({}, {}), /plan\.md/, 'what it held after the change is kept too');
}

console.log('eighth review: passed');
