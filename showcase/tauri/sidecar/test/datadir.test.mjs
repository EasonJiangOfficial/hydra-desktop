// Moving data from ~/.gg/sidekick into ~/HydraAgent/Data: a fresh install, a full move, running twice, a failed copy
// falling back to the old place, leftover temporary folders, the speech model, MOVED.txt and settings.json.
// Every case uses its own temp folders. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-datadir-test-'));
process.env.ROAMIES_DATA_DIR = path.join(TMP, 'import');
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));
const { migrateData, dataPaths, DATA_DIR, CONFIG_PATH, ROAMIES_DIR } = await import('../datadir.mjs');

assert.equal(ROAMIES_DIR, path.join(TMP, 'import', 'HydraAgent'), 'ROAMIES_DATA_DIR stands in for the home folder');
assert.equal(DATA_DIR, path.join(TMP, 'import', 'HydraAgent', 'Data'));
assert.equal(CONFIG_PATH, path.join(DATA_DIR, 'settings.json'));

let n = 0;
const setup = (files = {}) => {
  const home = path.join(TMP, `h${n++}`), old = path.join(home, '.gg');
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(old, rel)), { recursive: true });
    fs.writeFileSync(path.join(old, rel), text);
  }
  fs.mkdirSync(home, { recursive: true });
  const logs = [];
  return { home, old, logs, run: (o = {}) => migrateData({ base: home, old, log: (m) => logs.push(m), ...o }) };
};
const memory = JSON.stringify({ version: 1, commitments: [{ id: 'c1', text: 'call mum' }], facts: [{ id: 'f1', text: 'likes tea' }] });
const settings = JSON.stringify({ onboarded: true, provider: 'anthropic' });
const full = {
  'sidekick.json': settings, 'sidekick.json.bak': settings,
  'sidekick/memory.json': memory, 'sidekick/memory.json.bak': memory, 'sidekick/usage.jsonl': '{"t":1}\n',
  'sidekick/sessions/20261118-101010-abcdef.json': '{"messages":[]}', 'sidekick/logs/2026-11-18.log': 'a line\n',
  'sidekick/beats/tour.json': '{}', 'sidekick/jobs.json': '[]', 'sidekick/.DS_Store': 'x', 'sidekick/memory.json.1.tmp': 'half',
  'sidekick/models/parakeet/vocab.txt': 'words',
};

// A fresh install: nothing old, nothing moved, the new place.
{
  const t = setup();
  const p = t.run();
  assert.deepEqual([p.dir, p.legacy, p.migrated], [path.join(t.home, 'HydraAgent', 'Data'), false, false]);
  assert.ok(!fs.existsSync(path.join(t.home, 'HydraAgent')), 'nothing is created until something is saved');
}

// A full move: everything copied, settings renamed, junk skipped, the model renamed across, originals kept.
{
  const t = setup(full);
  const p = t.run();
  assert.equal(p.migrated, true); assert.equal(p.legacy, false);
  const D = p.dir;
  assert.equal(p.config, path.join(D, 'settings.json'));
  assert.equal(fs.readFileSync(path.join(D, 'settings.json'), 'utf8'), settings, 'sidekick.json becomes settings.json');
  assert.equal(fs.readFileSync(path.join(D, 'settings.json.bak'), 'utf8'), settings);
  assert.equal(fs.readFileSync(path.join(D, 'memory.json'), 'utf8'), memory);
  for (const rel of ['memory.json.bak', 'usage.jsonl', 'sessions/20261118-101010-abcdef.json', 'logs/2026-11-18.log', 'beats/tour.json', 'jobs.json']) {
    assert.equal(fs.readFileSync(path.join(D, rel), 'utf8'), full[`sidekick/${rel}`], rel);
  }
  assert.ok(!fs.existsSync(path.join(D, '.DS_Store')) && !fs.existsSync(path.join(D, 'memory.json.1.tmp')), 'junk stays behind');
  assert.equal(fs.readFileSync(path.join(D, 'models', 'parakeet', 'vocab.txt'), 'utf8'), 'words', 'the speech model comes across');
  assert.ok(!fs.existsSync(path.join(t.old, 'sidekick', 'models')), 'renamed, not copied');
  assert.equal(fs.readFileSync(path.join(t.old, 'sidekick', 'memory.json'), 'utf8'), memory, 'the old copy is kept');
  assert.equal(fs.readFileSync(path.join(t.old, 'sidekick.json'), 'utf8'), settings);
  const moved = fs.readFileSync(path.join(t.old, 'sidekick', 'MOVED.txt'), 'utf8');
  assert.match(moved, /Hydra now keeps its data in/); assert.ok(moved.includes(D)); assert.match(moved, /You can delete them/);
  assert.deepEqual(fs.readdirSync(path.join(t.home, 'HydraAgent')), ['Data'], 'no temporary folder left');
  if (process.platform !== 'win32') assert.equal((fs.statSync(path.join(D, 'memory.json')).mode & 0o777).toString(8), '600', 'still private');

  // Running again changes nothing, even after the old copy changes.
  fs.writeFileSync(path.join(t.old, 'sidekick', 'memory.json'), '{"version":1,"commitments":[],"facts":[]}');
  const again = t.run();
  assert.deepEqual([again.dir, again.migrated, again.legacy], [D, false, false]);
  assert.equal(fs.readFileSync(path.join(D, 'memory.json'), 'utf8'), memory, 'Data/ is never overwritten');
}

// Only settings (no sidekick folder yet), or only the folder: each moves alone.
{
  const t = setup({ 'sidekick.json': settings });
  const p = t.run();
  assert.ok(p.migrated); assert.equal(fs.readFileSync(p.config, 'utf8'), settings);
  assert.ok(!fs.existsSync(path.join(t.old, 'sidekick')), 'no old folder appears for MOVED.txt');
  const u = setup({ 'sidekick/memory.json': memory });
  assert.equal(fs.readFileSync(path.join(u.run().dir, 'memory.json'), 'utf8'), memory);
}

// A copy that doesn't check out: the temporary folder goes, this run uses the old place, and the next run tries again.
{
  const t = setup(full);
  const p = t.run({ afterCopy: (tmp) => fs.writeFileSync(path.join(tmp, 'memory.json'), '{"version":1') });
  assert.equal(p.legacy, true); assert.equal(p.migrated, false);
  assert.equal(p.dir, path.join(t.old, 'sidekick')); assert.equal(p.config, path.join(t.old, 'sidekick.json'));
  assert.deepEqual(fs.readdirSync(path.join(t.home, 'HydraAgent')), [], 'the temporary folder is removed and Data/ never appears');
  assert.ok(fs.existsSync(path.join(t.old, 'sidekick', 'models')) && !fs.existsSync(path.join(t.old, 'sidekick', 'MOVED.txt')), 'the old place is untouched');
  assert.match(t.logs.join('\n'), /couldn't move data .*didn't copy whole/);
  const missing = setup(full).run({ afterCopy: (tmp) => fs.rmSync(path.join(tmp, 'sessions'), { recursive: true }) });
  assert.equal(missing.legacy, true, 'a missing folder fails the check');
  const bad = setup(full).run({ afterCopy: (tmp) => fs.writeFileSync(path.join(tmp, 'settings.json'), 'x'.repeat(Buffer.byteLength(settings))) });
  assert.equal(bad.legacy, true, 'settings that no longer parse fail the check');
  assert.ok(t.run().migrated, 'the next launch tries again');
}

// A memory file that was already unreadable still moves (the store sets it aside as before), rather than blocking forever.
{
  const t = setup({ 'sidekick/memory.json': '{"version":1,"comm' });
  assert.ok(t.run().migrated);
}

// Temporary folders left by a crash are cleared first; a live process's is left alone.
{
  const t = setup(full);
  const dead = path.join(t.home, 'HydraAgent', '.Data-999999999.tmp'), live = path.join(t.home, 'HydraAgent', `.Data-${process.ppid}.tmp`);
  fs.mkdirSync(path.join(dead, 'sessions'), { recursive: true }); fs.writeFileSync(path.join(dead, 'memory.json'), 'half');
  fs.mkdirSync(live, { recursive: true });
  assert.ok(t.run().migrated);
  assert.ok(!fs.existsSync(dead), 'a crashed copy is cleared');
  assert.ok(fs.existsSync(live), "another running process's copy is left alone");
}

// A background agent's process never migrates: it follows the old place until the main process has moved the data.
{
  const t = setup(full);
  const p = t.run({ agent: true });
  assert.equal(p.legacy, true); assert.ok(!fs.existsSync(path.join(t.home, 'HydraAgent')));
  t.run();
  assert.equal(t.run({ agent: true }).legacy, false, 'and the new place once it exists');
}

// dataPaths resolves once per folder, migrating ROAMIES_DATA_DIR's old layout (sidekick/ beside HydraAgent/).
{
  const base = path.join(TMP, 'env');
  fs.mkdirSync(path.join(base, 'sidekick'), { recursive: true });
  fs.writeFileSync(path.join(base, 'sidekick', 'memory.json'), memory);
  fs.writeFileSync(path.join(base, 'sidekick.json'), settings);
  const p = dataPaths({ ROAMIES_DATA_DIR: base });
  assert.equal(p.dir, path.join(base, 'HydraAgent', 'Data')); assert.ok(p.migrated);
  assert.equal(fs.readFileSync(path.join(p.dir, 'settings.json'), 'utf8'), settings);
  assert.equal(dataPaths({ ROAMIES_DATA_DIR: base }), p, 'resolved once');
}
console.log('datadir tests: passed');

// The rename (review m5): ~/Roamies moves to ~/HydraAgent once, whole (Agents, Skills, Data), checked before the switch;
// ~/Roamies stays with a MOVED.txt; the speech model is renamed across; a failed copy keeps using ~/Roamies.
{
  const home = path.join(TMP, `rename${n++}`), R = path.join(home, 'Roamies');
  const put = (rel, text, mode) => { fs.mkdirSync(path.dirname(path.join(R, rel)), { recursive: true }); fs.writeFileSync(path.join(R, rel), text); if (mode) fs.chmodSync(path.join(R, rel), mode); };
  put('Data/memory.json', memory); put('Data/settings.json', settings); put('Data/sessions/a.json', '{"messages":[]}');
  put('Agents/a1/notes.md', 'work'); put('Agents/a1/run.sh', '#!/bin/sh\necho hi\n', 0o755); put('Skills/tea/SKILL.md', '# Tea');
  put('Data/models/parakeet/vocab.txt', 'words');
  const logs = [];
  const p = migrateData({ base: home, old: path.join(home, '.gg'), log: (m) => logs.push(m) });
  const H = path.join(home, 'HydraAgent');
  assert.equal(p.root, H); assert.equal(p.dir, path.join(H, 'Data')); assert.equal(p.legacy, false);
  for (const rel of ['Data/memory.json', 'Data/settings.json', 'Data/sessions/a.json', 'Agents/a1/notes.md', 'Skills/tea/SKILL.md'])
    assert.equal(fs.readFileSync(path.join(H, rel), 'utf8'), fs.readFileSync(path.join(R, rel), 'utf8'), `${rel} copied whole`);
  assert.equal(fs.statSync(path.join(H, 'Agents/a1/run.sh')).mode & 0o777, 0o755, 'a script keeps its permissions');
  assert.equal(fs.readFileSync(path.join(H, 'Data/models/parakeet/vocab.txt'), 'utf8'), 'words', 'the model is renamed across');
  assert.ok(fs.existsSync(path.join(R, 'Data/memory.json')), 'the old folder is kept');
  assert.match(fs.readFileSync(path.join(R, 'MOVED.txt'), 'utf8'), /HydraAgent/);
  assert.ok(!fs.readdirSync(home).some((x) => x.endsWith('.tmp')), 'no temporary folder left');
  // Running again changes nothing.
  assert.equal(migrateData({ base: home, old: path.join(home, '.gg'), log: () => {} }).root, H);
}
{
  const home = path.join(TMP, `rename${n++}`), R = path.join(home, 'Roamies');
  fs.mkdirSync(path.join(R, 'Data'), { recursive: true }); fs.writeFileSync(path.join(R, 'Data', 'memory.json'), memory);
  const { moveRoot } = await import('../datadir.mjs');
  const logs = [];
  const ok = moveRoot({ base: home, log: (m) => logs.push(m), afterCopy: (tmp) => fs.writeFileSync(path.join(tmp, 'Data', 'memory.json'), 'half') }).ok;
  assert.equal(ok, false, 'a bad copy is never switched to (the JSON check reads Data/memory.json)');
  assert.ok(!fs.existsSync(path.join(home, 'HydraAgent')), 'and ~/HydraAgent is not made');
  assert.equal(fs.readFileSync(path.join(R, 'Data', 'memory.json'), 'utf8'), memory, 'the data is untouched');
  assert.ok(!fs.readdirSync(home).some((x) => x.endsWith('.tmp')), 'the temporary copy is removed');
  // migrateData then keeps using ~/Roamies, and a background agent follows it.
  const p = migrateData({ base: home, old: path.join(home, '.gg'), agent: true, log: () => {} });
  assert.equal(p.root, R, 'an agent uses ~/Roamies while it has not been moved');
}
// Second review: links stay links, read-only folders keep their modes, a lock, a move another process finished, and
// both folders there without MOVED.txt.
{
  const { moveRoot } = await import('../datadir.mjs');
  const home = path.join(TMP, `rename${n++}`), R = path.join(home, 'Roamies'), H = path.join(home, 'HydraAgent');
  fs.mkdirSync(path.join(R, 'Data'), { recursive: true }); fs.writeFileSync(path.join(R, 'Data', 'memory.json'), memory);
  fs.mkdirSync(path.join(R, 'Agents', 'locked'), { recursive: true }); fs.writeFileSync(path.join(R, 'Agents', 'locked', 'keep.txt'), 'kept');
  fs.symlinkSync('/etc/hosts', path.join(R, 'Agents', 'hosts-link')); fs.symlinkSync('../Data', path.join(R, 'Agents', 'data-link'));
  fs.chmodSync(path.join(R, 'Agents', 'locked', 'keep.txt'), 0o444); fs.chmodSync(path.join(R, 'Agents', 'locked'), 0o555);
  assert.equal(moveRoot({ base: home, log: () => {} }).ok, true);
  assert.equal(fs.readlinkSync(path.join(H, 'Agents', 'hosts-link')), '/etc/hosts', 'a link is copied as the same link, not followed');
  assert.equal(fs.readlinkSync(path.join(H, 'Agents', 'data-link')), '../Data');
  assert.equal(fs.readFileSync(path.join(H, 'Agents', 'locked', 'keep.txt'), 'utf8'), 'kept', 'a read-only folder copies');
  assert.equal(fs.statSync(path.join(H, 'Agents', 'locked')).mode & 0o777, 0o555, 'and keeps its mode');
  assert.equal(fs.statSync(path.join(H, 'Agents', 'locked', 'keep.txt')).mode & 0o777, 0o444);
  assert.ok(!fs.existsSync(path.join(home, '.HydraAgent.lock')), 'the lock is let go');
  fs.chmodSync(path.join(R, 'Agents', 'locked'), 0o755); fs.chmodSync(path.join(H, 'Agents', 'locked'), 0o755);
}
{
  const { moveRoot } = await import('../datadir.mjs');
  const home = path.join(TMP, `rename${n++}`), R = path.join(home, 'Roamies');
  fs.mkdirSync(path.join(R, 'Data'), { recursive: true }); fs.writeFileSync(path.join(R, 'Data', 'memory.json'), memory);
  // A live process holds the lock: this one waits, then keeps using ~/Roamies rather than moving at the same time.
  fs.writeFileSync(path.join(home, '.HydraAgent.lock'), JSON.stringify({ pid: process.ppid, at: Date.now() }));
  assert.equal(moveRoot({ base: home, log: () => {}, waitMs: 300 }).ok, false, 'never two moves at once');
  assert.ok(!fs.existsSync(path.join(home, 'HydraAgent')));
  // A lock left by a process that's gone is taken over.
  fs.writeFileSync(path.join(home, '.HydraAgent.lock'), JSON.stringify({ pid: 999999999, at: Date.now() }));
  assert.equal(moveRoot({ base: home, log: () => {} }).ok, true, 'a stale lock is taken over');
  assert.ok(fs.existsSync(path.join(home, 'HydraAgent', 'Data', 'memory.json')));
}
{
  const { moveRoot } = await import('../datadir.mjs');
  const home = path.join(TMP, `rename${n++}`), R = path.join(home, 'Roamies'), H = path.join(home, 'HydraAgent');
  fs.mkdirSync(path.join(R, 'Data'), { recursive: true }); fs.writeFileSync(path.join(R, 'Data', 'memory.json'), memory);
  // Another process finishes the move while this one copies: its folder is adopted, this copy dropped.
  const r = moveRoot({ base: home, log: () => {}, afterCopy: () => { fs.mkdirSync(path.join(H, 'Data'), { recursive: true }); fs.writeFileSync(path.join(H, 'Data', 'memory.json'), memory); } });
  assert.equal(r.ok, true, 'adopts the finished one');
  assert.ok(!fs.readdirSync(home).some((x) => x.endsWith('.tmp')), 'and drops its own copy');
}
{
  const home = path.join(TMP, `rename${n++}`);
  fs.mkdirSync(path.join(home, 'Roamies', 'Data'), { recursive: true }); fs.mkdirSync(path.join(home, 'HydraAgent', 'Data'), { recursive: true });
  fs.writeFileSync(path.join(home, 'Roamies', 'Data', 'memory.json'), memory); // only in the old one
  const p = migrateData({ base: home, old: path.join(home, '.gg'), log: () => {} });
  assert.equal(p.root, path.join(home, 'HydraAgent'), 'both there: HydraAgent is used');
  assert.equal(p.older, true, 'and the panel is told older data sits in Roamies');
  fs.writeFileSync(path.join(home, 'Roamies', 'MOVED.txt'), 'moved');
  assert.equal(migrateData({ base: home, old: path.join(home, '.gg'), log: () => {} }).older, false, 'not once it was marked moved');
  // An older Hydra kept saving in ~/Roamies after the move: the panel says so again.
  const later = (Date.now() + 5000) / 1000;
  fs.writeFileSync(path.join(home, 'Roamies', 'Data', 'memory.json'), memory); fs.utimesSync(path.join(home, 'Roamies', 'Data', 'memory.json'), later, later);
  assert.equal(migrateData({ base: home, old: path.join(home, '.gg'), log: () => {} }).older, true, 'written to after the move');
}
// Third review: a lock whose process id now belongs to a live process (pid 1), or an old-format or hours-old lock,
// is taken over at once, without a long wait; sockets are left behind with a log line; a crash between the switch and
// MOVED.txt reports nothing when the data is the same; a read-only leftover copy is cleaned up.
{
  const { moveRoot } = await import('../datadir.mjs');
  for (const lock of ['1', JSON.stringify({ pid: 1, at: Date.now() - 3600_000 }), JSON.stringify({ pid: process.ppid, at: Date.now() - 3600_000 })]) {
    const home = path.join(TMP, `rename${n++}`), R = path.join(home, 'Roamies');
    fs.mkdirSync(path.join(R, 'Data'), { recursive: true }); fs.writeFileSync(path.join(R, 'Data', 'memory.json'), memory);
    fs.writeFileSync(path.join(home, '.HydraAgent.lock'), lock);
    const t0 = Date.now();
    assert.equal(moveRoot({ base: home, log: () => {} }).ok, true, `lock ${lock} is taken over`);
    assert.ok(Date.now() - t0 < 1500, 'without waiting');
  }
}
{
  const { moveRoot } = await import('../datadir.mjs');
  const net = await import('node:net');
  const home = path.join(TMP, `r${n++}`), R = path.join(home, 'Roamies');
  fs.mkdirSync(path.join(R, 'Data'), { recursive: true }); fs.writeFileSync(path.join(R, 'Data', 'memory.json'), memory);
  const sock = path.join(R, 'Data', 's.sock'), srv = net.createServer().listen(sock);
  await new Promise((r) => srv.on('listening', r));
  const logs = [];
  assert.equal(moveRoot({ base: home, log: (m) => logs.push(m) }).ok, true, 'a socket does not stop the move');
  assert.ok(logs.some((m) => /left Data\/s\.sock behind/.test(m)), 'it is named in the log');
  srv.close();
  // Leftover copy with a read-only folder: cleaned up on the next try.
  const h2 = path.join(TMP, `r${n++}`);
  fs.mkdirSync(path.join(h2, 'Roamies', 'Data'), { recursive: true }); fs.writeFileSync(path.join(h2, 'Roamies', 'Data', 'memory.json'), memory);
  const left = path.join(h2, '.HydraAgent-999999999.tmp', 'Agents', 'ro');
  fs.mkdirSync(left, { recursive: true }); fs.writeFileSync(path.join(left, 'f'), 'x'); fs.chmodSync(left, 0o555);
  assert.equal(moveRoot({ base: h2, log: () => {} }).ok, true);
  assert.ok(!fs.existsSync(path.join(h2, '.HydraAgent-999999999.tmp')), 'a read-only leftover copy is removed');
}
{
  const home = path.join(TMP, `r${n++}`), R = path.join(home, 'Roamies'), H = path.join(home, 'HydraAgent');
  for (const root of [R, H]) { fs.mkdirSync(path.join(root, 'Data'), { recursive: true }); fs.writeFileSync(path.join(root, 'Data', 'memory.json'), memory); }
  const p = migrateData({ base: home, old: path.join(home, '.gg'), log: () => {} });
  assert.equal(p.older, false, 'same data, no MOVED.txt (a crash after the switch): nothing to report');
  assert.ok(fs.existsSync(path.join(R, 'MOVED.txt')), 'and the old folder is marked now');
  // Data changes in the new folder (the app is running there): still nothing to report.
  fs.writeFileSync(path.join(H, 'Data', 'memory.json'), memory + ' ');
  assert.equal(migrateData({ base: home, old: path.join(home, '.gg'), log: () => {} }).older, false);
  // A file anywhere in the old tree changed after the mark: reported.
  fs.mkdirSync(path.join(R, 'Agents'), { recursive: true });
  const later = (Date.now() + 5000) / 1000;
  fs.writeFileSync(path.join(R, 'Agents', 'late.md'), 'x'); fs.utimesSync(path.join(R, 'Agents', 'late.md'), later, later);
  assert.equal(migrateData({ base: home, old: path.join(home, '.gg'), log: () => {} }).older, true, 'the whole tree is looked at');
}
// Fourth review: same size but other contents, with no MOVED.txt: reported, and never marked moved.
{
  const home = path.join(TMP, `r${n++}`), R = path.join(home, 'Roamies'), H = path.join(home, 'HydraAgent');
  fs.mkdirSync(path.join(R, 'Data'), { recursive: true }); fs.mkdirSync(path.join(H, 'Data'), { recursive: true });
  fs.writeFileSync(path.join(R, 'Data', 'memory.json'), 'aaaa'); fs.writeFileSync(path.join(H, 'Data', 'memory.json'), 'bbbb');
  assert.equal(migrateData({ base: home, old: path.join(home, '.gg'), log: () => {} }).older, true, 'other contents, same size: reported');
  assert.ok(!fs.existsSync(path.join(R, 'MOVED.txt')), 'and the old folder is not marked (no "you can delete it")');
}
console.log('folder rename tests: passed');
