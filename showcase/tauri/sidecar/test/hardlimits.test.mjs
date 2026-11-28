// The owner's hard limits, fixed and not a setting (audit 2026-11-26 PLAN "Safety rule for Approve all"; 03 CU-01,
// CU-02; 04 F5), with Approve all ON:
// 1. typing a password, credential or card number into any field, and reading a password manager's window: refused,
//    never asked;
// 2. paying, buying, transferring money or trading: always asked.
// A plain Approve-all action (a delete too, owner's PR #8 decision) still runs unasked. Nothing here reaches the Mac:
// the hands helper is a stub written below, and open, osascript, screencapture and sips are stubs on PATH.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hardlimits-'));
process.env.ROAMIES_DATA_DIR = path.join(tmp, 'data');
process.env.HOME = path.join(tmp, 'home'); fs.mkdirSync(process.env.HOME);
const bin = path.join(tmp, 'bin'), launched = path.join(tmp, 'launched.log');
fs.mkdirSync(bin);
for (const c of ['open', 'osascript', 'screencapture', 'sips', 'afplay', 'say']) fs.writeFileSync(path.join(bin, c), `#!/bin/sh\necho ${c} "$@" >> '${launched}'\nexit 0\n`, { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;
// The hands helper: a stub. mode: 'form' (a sign-in form in Safari), 'vault' (1Password runs, no window on screen),
// 'vaultfront' (1Password's window in front), 'pay' (the helper stops at a Pay now button).
const stub = path.join(tmp, 'hands.mjs'), stState = path.join(tmp, 'st.json'), stLog = path.join(tmp, 'log.jsonl');
fs.writeFileSync(stub, `import fs from 'node:fs';
const a = process.argv.slice(2), s = JSON.parse(fs.readFileSync(${JSON.stringify(stState)}, 'utf8'));
fs.appendFileSync(${JSON.stringify(stLog)}, JSON.stringify({ a }) + '\\n');
const out = (o) => { console.log(JSON.stringify(o)); process.exit(0); };
const vault = { id: 7, pid: 70, app: '1Password', title: 'All Items', bounds: [0, 0, 800, 600] };
const w = s.mode === 'vaultfront' ? vault : { id: 1, pid: 10, app: 'Safari', title: 'Sign in', url: 'https://example.com/login', bounds: [0, 0, 800, 600] };
const controls = [{ id: 1, role: 'text field', label: 'Email' }, { id: 2, role: 'password field', label: 'Enter it' }, { id: 3, role: 'button', label: 'Place order' }];
if (a[0] === 'resolve') out(s.mode === 'vault' ? { ok: true, window: null, running: '1Password', runningPid: 70 } : { ok: true, window: w, running: w.app, runningPid: w.pid });
if (a[0] === 'locate') out({ ok: true, window: w });
if (a[0] === 'front') out({ ok: true, app: w.app, pid: w.pid });
if (a[0] === 'ui') out({ ok: true, window: w, controls, texts: [], note: '' });
if (a[0] === 'capture') { fs.writeFileSync(a[1], 'png'); out({ ok: true, window: w, pixels: [800, 600] }); }
if (a[0] === 'act') {
  const plan = JSON.parse(a[1]);
  if (s.mode === 'pay' && !plan.steps[0]?.confirmed) out({ ok: false, needsConfirm: true, step: 0, label: 'Pay now', why: 'Click "Pay now" in Safari? It could delete, pay, send, quit or sign out.', done: [] });
  out({ ok: true, done: ['ran'], window: w });
}
if (a[0] === 'manage') out({ ok: true, done: 'done' });
if (a[0] === 'windows') out({ ok: true, windows: [w], all: true });
out({ ok: true });
`);
process.env.ROAMIES_HANDS = stub;

const { approveAllSays, hardAsk, checkTyped, isPayClick, paysCall, credentialField, hasCardNumber, checkMcpCall, isYes, BLOCK } = await import('../safety.mjs');
const { createTools } = await import('../tools.mjs');
const { createMcpTools } = await import('../mcp.mjs');
const { askAsApproval } = await import('../relay.mjs');

const yesNo = { choices: ['Allow', "Don't allow"] };
// ---- The rule itself (approveAllSays): a hard tag is checked before Approve all's yes.
assert.equal(approveAllSays(true, { pay: true }), false, 'pay asks');
assert.equal(approveAllSays(true, { ...yesNo, pay: true }), false, 'a pay yes/no asks');
assert.equal(approveAllSays(true, { ...yesNo, deletion: false, pay: true }), false, 'pay asks, whatever the deletion tag');
assert.equal(approveAllSays(true, { ...yesNo, secret: true }), false, 'a sign-in read asks');
assert.equal(approveAllSays(true, { ...yesNo, deletion: false }), true, 'a normal Approve-all action is still a yes');
assert.equal(approveAllSays(true, { ...yesNo, deletion: true }), true, 'a delete is still a yes (PR #8 decision kept)');
assert.equal(hardAsk({ pay: true }) && hardAsk({ secret: true }) && !hardAsk({ deletion: true }), true);
// Card numbers (Luhn), credential fields, money words.
assert.equal(hasCardNumber('4242 4242 4242 4242'), true); assert.equal(hasCardNumber('4111-1111-1111-1111'), true);
assert.equal(hasCardNumber('4242 4242 4242 4241'), false, 'not Luhn'); assert.equal(hasCardNumber('Call 555 0100 at 3'), false);
assert.equal(checkTyped('my card is 4242424242424242', os.homedir()).level, BLOCK, 'a card number is never typed');
for (const f of ['Password', 'Passcode', 'PIN', 'CVV', 'Security code', 'Card number', 'API key', 'Client secret', 'Verification code', { role: 'password field', label: 'x' }]) assert.equal(credentialField(f), true, JSON.stringify(f));
for (const f of ['Email', 'Name', 'Spinner', 'Search', { role: 'text field', label: 'Email' }]) assert.equal(credentialField(f), false, JSON.stringify(f));
for (const l of ['Pay', 'Pay now', 'Place order', 'Buy now', 'Confirm payment', 'Pagar', '支付']) assert.equal(isPayClick(l), true, l);
// A3 round 3: a money word that is also a tab or a nav link pays in a money surface only (the round-2 false asks).
for (const l of ['Checkout', 'Transfer', 'Withdraw', 'Sell']) { assert.equal(isPayClick(l), false, l); assert.equal(isPayClick(l, { surface: true }), true, l); }
for (const l of ['Payroll report', 'Save', 'Reply', 'Delete']) assert.equal(isPayClick(l), false, l);
for (const n of ['create_payment', 'createPayment', 'send_money', 'place_order', 'transfer_funds', 'buy_stock']) assert.equal(paysCall(n), true, n);
for (const n of ['list_events', 'get_order', 'delete_event']) assert.equal(paysCall(n), false, n);

// ---- The Mac tools, Approve all on: each ask is answered by the one rule, the owner says no to the rest.
const noop = async () => {};
const run = async (mode, fn, { owner = () => null } = {}) => {
  fs.writeFileSync(stState, JSON.stringify({ mode })); fs.writeFileSync(stLog, ''); fs.writeFileSync(launched, '');
  const asks = [];
  const ask = async (o) => { const auto = approveAllSays(true, o); asks.push({ auto, pay: !!o.pay, secret: !!o.secret, q: String(o.placeholder).split('\n')[0] }); return auto ? 'yes' : owner(o); };
  const t = createTools({ allowActions: () => true, ui: () => {}, openUrl: noop, onCommitments: noop, showList: noop, fmtWhen: String, commitmentsText: () => '', userName: 'Test', workdir: tmp, ask });
  t.nextTurn?.();
  const T = (n) => t.tools.find((x) => x.name === n);
  const r = await fn(T).then(String, (e) => `ERR ${e.message}`);
  const calls = fs.readFileSync(stLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).a);
  return { asks, r, calls, acts: calls.filter((c) => c[0] === 'act').length, opened: fs.readFileSync(launched, 'utf8') };
};
const refused = (x, label) => {
  assert.match(x.r, /^ERR Blocked for safety/, `${label}: refused (${x.r})`);
  assert.deepEqual(x.asks, [], `${label}: never asked: ${JSON.stringify(x.asks)}`);
  assert.equal(x.acts, 0, `${label}: nothing ran`);
};
// 1. Typing a password, credential or card number: refused.
{
  refused(await run('form', (T) => T('act_in_app').execute({ target: 'Safari', steps: [{ do: 'fill', field: 'Password', text: 'hunter2' }] }, {})), 'fill a field named Password');
  // By id, after read_window: the control is a password field (whatever its label says).
  refused(await run('form', async (T) => { await T('read_window').execute({ target: 'Safari' }, {}); return T('act_in_app').execute({ target: 'Safari', steps: [{ do: 'fill', id: 2, text: 'hunter2' }] }, {}); }), 'fill a password field by id');
  refused(await run('form', async (T) => { await T('read_window').execute({ target: 'Safari' }, {}); return T('act_in_app').execute({ target: 'Safari', steps: [{ do: 'click', id: 2 }, { do: 'type', text: 'hunter2' }] }, {}); }), 'click a password field, then type');
  refused(await run('form', (T) => T('act_in_app').execute({ target: 'Safari', steps: [{ do: 'fill', field: 'Email', text: '4242 4242 4242 4242' }] }, {})), 'a card number into any field');
  refused(await run('form', (T) => T('act_in_app').execute({ target: 'Safari', steps: [{ do: 'fill', field: 'CVV', text: '123' }] }, {})), 'a CVV');
  // A normal Approve-all fill still runs unasked.
  const ok = await run('form', (T) => T('act_in_app').execute({ target: 'Safari', steps: [{ do: 'fill', field: 'Email', text: 'me@example.com' }] }, {}));
  assert.equal(ok.acts, 1, `a normal fill runs: ${ok.r}`);
  assert.ok(ok.asks.length >= 1 && ok.asks.every((a) => a.auto), `a normal fill is answered by Approve all: ${JSON.stringify(ok.asks)}`);
}
// 1. Reading a password manager's window: refused, never asked, nothing brought forward or shot.
{
  for (const [mode, label, fn] of [
    ['vault', 'take_screenshot 1Password', (T) => T('take_screenshot').execute({ target: '1Password' }, {})],
    ['vault', 'read_window 1Password', (T) => T('read_window').execute({ target: '1Password' }, {})],
    ['vaultfront', 'read_window of 1Password in front', (T) => T('read_window').execute({ target: 'front' }, {})],
    ['vaultfront', 'take_screenshot of 1Password in front', (T) => T('take_screenshot').execute({ target: 'front' }, {})],
    ['vault', 'act_in_app in 1Password', (T) => T('act_in_app').execute({ target: '1Password', steps: [{ do: 'key', key: 'tab' }] }, {})],
  ]) {
    const x = await run(mode, fn, { owner: () => 'yes' });
    refused(x, label);
    // Hidden: nothing brought forward or shot. In front: a shot taken is deleted before it reaches the model.
    if (mode === 'vault') assert.ok(!x.calls.some((c) => c[0] === 'capture' || c[0] === 'ui'), `${label}: nothing read or shot: ${JSON.stringify(x.calls)}`);
  }
  // Only putting the vault on screen (no read): asked, Approve all never answers it.
  const sw = await run('vault', (T) => T('manage_app').execute({ do: 'switch', app: '1Password' }, {}));
  assert.deepEqual(sw.asks.map((a) => [a.auto, a.secret]), [[false, true]], `switch to 1Password asks: ${JSON.stringify(sw.asks)}`);
  assert.ok(!sw.calls.some((c) => c[0] === 'manage'), 'and a no keeps it hidden');
}
// 2. Paying, buying, transferring money, trading: always asked.
{
  const order = await run('form', (T) => T('act_in_app').execute({ target: 'Safari', steps: [{ do: 'click_text', text: 'Place order' }] }, {}));
  assert.deepEqual(order.asks.map((a) => [a.auto, a.pay]), [[false, true]], `Place order asks: ${JSON.stringify(order.asks)}`);
  assert.match(order.r, /said no/); assert.equal(order.acts, 0, 'nothing clicked on a no');
  // The helper's own stop at a Pay now button it only sees there.
  const pay = await run('pay', (T) => T('act_in_app').execute({ target: 'Safari', steps: [{ do: 'click_text', text: 'Continue' }] }, {}));
  assert.deepEqual(pay.asks.map((a) => [a.auto, a.pay]), [[true, false], [false, true]], `Pay now asks: ${JSON.stringify(pay.asks)}`);
  assert.match(pay.r, /said no/); assert.equal(pay.acts, 1, 'the helper stopped before it, and nothing ran after a no');
  // A connected server's tool that pays.
  let ran = 0;
  const mcp = { tool: async () => ({ annotations: {}, execute: async () => { ran++; return 'paid'; } }), list: () => [] };
  const asks = [];
  const ask = async (o) => { asks.push(o); return approveAllSays(true, o) ? 'yes' : null; };
  const t = createMcpTools({ mcp, ask, isYes, userName: 'Test', checkCall: (x) => checkMcpCall({ ...x, home: os.homedir() }), openUrl: noop, allowActions: () => true, keyStore: 'Keychain' }).find((x) => x.name === 'use_connection');
  await assert.rejects(t.execute({ server: 'stripe', tool: 'create_payment', args: JSON.stringify({ amount: 5 }) }, {}), /said no/);
  assert.equal(asks[0]?.pay, true); assert.equal(ran, 0, 'Approve all never paid');
  // A relay turn: a hard ask goes to the server as a deletion, which its Approve all never skips.
  const sent = [];
  await askAsApproval(async (b) => { sent.push(b); return 'pending'; })({ placeholder: 'Pay $5?', ...yesNo, deletion: false, pay: true });
  assert.deepEqual([sent[0].deletion, sent[0].danger], [true, true], JSON.stringify(sent));
}
// A background agent's asks: its process sends the hard tag, and the parent's Approve all never answers one.
{
  const run = fs.readFileSync(new URL('../agentrun.mjs', import.meta.url), 'utf8');
  const agents = fs.readFileSync(new URL('../agents.mjs', import.meta.url), 'utf8');
  assert.match(run, /hard: hardAsk\(opts\)/, 'agentrun sends the hard tag');
  assert.match(agents, /config\.approveAll\?\.\(\) === true && m\.hard !== true/, 'agents.mjs checks it before Approve all');
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log('hard limits under Approve all (no credentials typed, no vault read, money always asks): ok');
