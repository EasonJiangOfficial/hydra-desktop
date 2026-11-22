// R11c-3: on Windows (process.platform faked, a fake helper), saying no to a relay turn's screenshot stops it; only a
// failed capture falls back to PowerShell's whole screen, and in a relay turn that asks for the whole screen first.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

Object.defineProperty(process, 'platform', { value: 'win32' });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-11cw-'));
const log = path.join(dir, 'calls.jsonl'), fake = path.join(dir, 'hands.mjs'), fail = path.join(dir, 'fail');
fs.writeFileSync(fake, `import fs from 'node:fs'; const a = process.argv.slice(2); fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + '\\n');
let o = { ok: true };
if (a[0] === 'capture') { if (fs.existsSync(${JSON.stringify(fail)})) o = { ok: false, error: 'capture failed' }; else { fs.writeFileSync(a[1], 'x'); o = { ok: true, file: a[1], what: 'screen', bounds: [0, 0, 1440, 900], shown: [{ id: 3, app: 'Terminal', title: 'zsh' }], pixels: [1440, 900] }; } }
console.log(JSON.stringify(o));`);
process.env.ROAMIES_HANDS = fake;
const { createTools } = await import('../tools.mjs');
const asks = [];
const t = createTools({ remote: () => true, allowActions: () => true, ui: () => {}, ask: async (o) => { asks.push(o.placeholder); return "Don't allow"; }, openUrl: async () => {}, onCommitments: () => {}, showList: () => {}, fmtWhen: String, commitmentsText: () => '', userName: 'Test', workdir: os.homedir(), skills: { changed: () => {} } });
t.nextTurn();
const shot = () => t.tools.find((x) => x.name === 'take_screenshot').execute({ target: 'screen' }, {});
// A no to the helper's picture: no fallback to a picture taken without asking.
await assert.rejects(shot(), /said no/);
assert.equal(asks.length, 1);
// The helper's capture fails: PowerShell's whole screen asks first, and a no stops it.
fs.writeFileSync(fail, '');
asks.length = 0;
await assert.rejects(shot(), /said no/);
assert.equal(asks.length, 1);
assert.ok(asks[0].includes('whole screen'), asks[0]);
console.log('eleventhcwin: ok');
