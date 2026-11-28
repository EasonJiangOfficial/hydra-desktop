// The owner's hard limits, round 4 (A3 desktop, the round-3 review's findings, each in the shape it was found), with
// Approve all ON unless said:
// 1. typing a password, credential, key or card number into any field, and reading a password manager's or a secret
//    file's window: refused, never asked, whatever the owner says;
// 2. paying, buying, ordering, subscribing, transferring money or trading: always asked.
// Everything else runs unasked under Approve all (deletes too): the false asks and false refusals found are here too.
// Nothing here reaches the Mac: the hands helper is a stub that reads main.swift's own patterns (RISKY, MONEY, AMBIG,
// CRED_FIELD, REVEAL, PROMPT) and stops, refuses and splits a spot's "words | words" where main.swift does; the system
// commands are stubs on PATH (open fails).
import { credentialFixture } from './fixtures/credential-fixtures.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hardlimits4-'));
process.env.ROAMIES_DATA_DIR = path.join(tmp, 'data');
process.env.HOME = path.join(tmp, 'home'); fs.mkdirSync(process.env.HOME);
const H = process.env.HOME;
const bin = path.join(tmp, 'bin'), clip = path.join(tmp, 'clip.txt');
fs.mkdirSync(bin); fs.writeFileSync(clip, '');
for (const c of ['osascript', 'screencapture', 'sips', 'afplay', 'say', 'pbcopy']) fs.writeFileSync(path.join(bin, c), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
fs.writeFileSync(path.join(bin, 'pbpaste'), `#!/bin/sh\ncat ${JSON.stringify(clip)}\n`, { mode: 0o755 });
fs.writeFileSync(path.join(bin, 'open'), '#!/bin/sh\necho "Unable to find application" >&2\nexit 1\n', { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;
const S = new URL('..', import.meta.url).pathname;
const SWIFT = fs.readFileSync(path.join(S, '../src-tauri/hands/main.swift'), 'utf8');
const pat = (name) => SWIFT.match(new RegExp(`^let ${name} = try! NSRegularExpression\\(pattern: #"(.*)"#, options: .*\\)$`, 'm'))?.[1] ?? null;
const P = { RISKY: pat('RISKY'), MONEY: pat('MONEY'), AMBIG: pat('AMBIG'), CRED: pat('CRED_FIELD'), REVEAL: pat('REVEAL'), PROMPT: pat('PROMPT'), parts: /func labelParts/.test(SWIFT) };
const stub = path.join(tmp, 'hands.mjs'), stState = path.join(tmp, 'st.json'), stLog = path.join(tmp, 'log.jsonl');
fs.writeFileSync(stub, `import fs from 'node:fs';
const P = ${JSON.stringify(P)};
const rx = (p) => (p ? new RegExp(p, 'iu') : null);
const RISKY = rx(P.RISKY), MONEY = rx(P.MONEY), AMBIG = rx(P.AMBIG), CRED = rx(P.CRED), REVEAL = rx(P.REVEAL), PROMPT = rx(P.PROMPT);
const parts = (s) => (P.parts ? String(s).split(' | ').map((x) => x.trim()).filter(Boolean) : [String(s)]);
const forms = (s) => { let l = String(s).normalize('NFKC').toLowerCase().replace(/\\s+/g, ' ').trim().replace(/^[^\\p{L}\\p{N}$€£¥]+|[^\\p{L}\\p{M}\\p{N}$€£¥%)]+$/gu, ''); const f = l.normalize('NFD').replace(/\\p{M}/gu, '').normalize('NFC'); return f === l ? [l] : [l, f]; };
const any = (s, f) => parts(s).some((p) => forms(p).some(f));
const moneyWord = (s) => any(s, (x) => x && x.split(' ').length <= 6 && MONEY.test(x));
const ambiguous = (s) => any(s, (x) => AMBIG.test(x) && x.split(' ').length <= 5);
const reveal = (s) => !!REVEAL && any(s, (x) => REVEAL.test(x));
const credLabel = (s) => { const r = String(s ?? '').normalize('NFKC').toLowerCase().replace(/\\s+/g, ' ').trim(); if (!r) return false; const f = r.normalize('NFD').replace(/\\p{M}/gu, '').normalize('NFC'); return CRED.test(r) || CRED.test(f); };
const prompt = (app, t) => !!PROMPT && /^(terminal|iterm2?|warp|ghostty|kitty|alacritty|wezterm|hyper|tabby|rio|wave)$/i.test(app) && (() => { const last = String(t ?? '').split(/\\n/).map((x) => x.trim()).filter(Boolean).at(-1) ?? ''; return last.length <= 160 && PROMPT.test(last); })();
const a = process.argv.slice(2), s = JSON.parse(fs.readFileSync(${JSON.stringify(stState)}, 'utf8'));
fs.appendFileSync(${JSON.stringify(stLog)}, JSON.stringify({ a }) + '\\n');
const out = (o) => { console.log(JSON.stringify(o)); process.exit(0); };
const w = s.win ?? { id: 1, pid: 10, app: 'Safari', title: 'Example', url: 'https://www.example.com/page', bounds: [0, 0, 800, 600] };
const controls = s.controls ?? [{ id: 1, role: 'text field', label: 'Email' }, { id: 3, role: 'button', label: 'Sign in' }];
if (a[0] === 'resolve') out({ ok: true, window: w, running: w.app, runningPid: w.pid });
if (a[0] === 'locate') out({ ok: true, window: w });
if (a[0] === 'front') out({ ok: true, app: w.app, pid: w.pid });
if (a[0] === 'ui') out({ ok: true, window: w, controls, texts: s.texts ?? [], note: '' });
if (a[0] === 'capture') { fs.writeFileSync(a[1], 'png'); out({ ok: true, window: w, pixels: [800, 600] }); }
if (a[0] === 'act') {
  const plan = JSON.parse(a[1]);
  const stopsAt = (l) => RISKY.test(l) || moneyWord(l) || (plan.money === true && ambiguous(l));
  const isCred = (c) => !!c && (c.role === 'password field' || credLabel(c.label));
  let focus = controls.find((c) => c.focused) ?? null;
  const done = [];
  for (const [i, x] of plan.steps.entries()) {
    const yes = (l) => x.confirmed && x.confirmedLabel === l;
    const refuse = () => out({ ok: false, error: 'Blocked for safety: step ' + (i + 1) + ' (helper).', refused: 'credential', done });
    let l = '';
    if (x.do === 'click' || x.do === 'focus') { const c = controls.find((c) => c.id === x.id); l = c?.label ?? ''; focus = c && /field|text|area/.test(c.role) ? c : null; }
    if (x.do === 'click_text') { l = x.text; const c = controls.find((c) => c.label === x.text); focus = c && /field|text|area/.test(c.role) ? c : null; }
    if (x.do === 'click_at') { l = s.under ?? ''; focus = null; }
    if (x.do === 'choose') l = x.option;
    if (l && reveal(l)) refuse();
    if (['click', 'click_text', 'click_at', 'choose'].includes(x.do) && l && stopsAt(l) && !yes(l)) out({ ok: false, needsConfirm: true, step: i, label: l, why: 'Click "' + l + '" in ' + w.app + '?', done });
    if (x.do === 'fill') { const c = controls.find((c) => c.label === x.field); if (isCred(c) || credLabel(x.field)) refuse(); focus = c ?? focus; }
    if (x.do === 'type' && (isCred(focus) || prompt(w.app, focus?.value))) refuse();
    if (x.do === 'key') {
      const k = String(x.key).toLowerCase();
      if (/^(cmd\\+v|.|shift\\+.)$/.test(k) && (isCred(focus) || prompt(w.app, focus?.value))) refuse();
      if (/^(return|enter)$/.test(k) && s.returnPresses && stopsAt(s.returnPresses) && !yes(s.returnPresses)) out({ ok: false, needsConfirm: true, step: i, label: s.returnPresses, why: 'Return would press "' + s.returnPresses + '" in ' + w.app + '.', done });
    }
    done.push(x.do);
  }
  out({ ok: true, done, window: s.after ?? w });
}
if (a[0] === 'manage') out({ ok: true, done: 'done' });
if (a[0] === 'windows') out({ ok: true, windows: [w], all: true });
out({ ok: true });
`);
process.env.ROAMIES_HANDS = stub;

const safety = await import('../safety.mjs');
const core = await import('../hardlimits-core.mjs');
const { approveAllSays, checkTyped, moneyCall, credentialArgs } = safety;
const { createTools } = await import('../tools.mjs');
const relay = await import('../relay.mjs');
const { askAsApproval, APPROVE_CAPS } = relay;
const { capabilitiesSchema } = await import('../relayschema.mjs');

// Each section runs on even when one before it fails, so a run on the code before the fix shows every finding red.
const failed = [];
const section = async (name, fn) => { try { await fn(); console.log(`  ok   ${name}`); } catch (e) { failed.push(name); console.log(`  FAIL ${name}: ${String(e.message).split('\n')[0].slice(0, 220)}`); } };
const run = async (state, fn, { owner = () => null, approveAll = true } = {}) => {
  fs.writeFileSync(stState, JSON.stringify(state)); fs.writeFileSync(stLog, ''); fs.writeFileSync(clip, state.clip ?? '');
  const asks = [];
  const ask = async (o) => { const auto = approveAllSays(approveAll, o); asks.push({ auto, pay: !!o.pay, q: String(o.placeholder ?? '').split('\n')[0] }); return auto ? 'yes' : owner(o); };
  const tools = createTools({ allowActions: () => true, ui: () => {}, openUrl: async () => {}, onCommitments: async () => {}, showList: async () => {}, fmtWhen: String, commitmentsText: () => '', userName: 'Test', workdir: tmp, ask });
  const T = (n) => tools.tools.find((x) => x.name === n);
  const r = await fn(T).then((x) => String(x), (e) => `ERR ${e.message}`);
  const calls = fs.readFileSync(stLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).a);
  const acts = calls.filter((c) => c[0] === 'act').map((c) => JSON.parse(c[1]));
  return { asks, r, acts };
};
const A = (steps, target = 'Safari') => (T) => T('act_in_app').execute({ target, steps }, {});
const RA = (steps, target = 'Safari') => async (T) => { await T('read_window').execute({ target }, {}); return T('act_in_app').execute({ target, steps }, {}); };
const SA = (steps, target = 'Safari') => async (T) => { await T('take_screenshot').execute({ target }, {}); return T('act_in_app').execute({ target, steps }, {}); };
const W = (app, title, url, document) => ({ id: 1, pid: 10, app, title, ...(url ? { url } : {}), ...(document ? { document } : {}), bounds: [0, 0, 800, 600] });
const show = (x) => `${x.r.slice(0, 120)} asks=${JSON.stringify(x.asks)}`;
const refused = (x, why) => { assert.match(x.r, /^ERR Blocked for safety/, `${why}: ${show(x)}`); assert.equal(x.acts.length, 0, `${why}: nothing acted`); };
const asked = (x, why) => assert.ok(x.asks.some((a) => !a.auto), `${why}: a hard ask (${show(x)})`);
const ran = (x, why) => { assert.ok(!x.asks.some((a) => !a.auto), `${why}: no ask the owner must answer (${show(x)})`); assert.doesNotMatch(x.r, /^ERR/, `${why}: ${x.r}`); };

const rh = W('Robinhood', 'Robinhood'), chase = W('Chase', 'Chase');
const amazon = W('Safari', 'Amazon.com: Echo Dot', 'https://www.amazon.com/dp/B09B8V1LZ3');
const plain = W('Safari', 'Example', 'https://www.example.com/page');
const stripeCo = W('Safari', 'Pay Acme', 'https://checkout.stripe.com/c/pay/cs_live_abc');

// ---- critical: pay verbs with their object ask anywhere, read-first clicks by id too; clear non-money labels run.
await section('critical: pay, buy and sell labels with an object ask, on listed surfaces and anywhere', async () => {
  for (const [win, labels] of [[rh, ['Buy AAPL', 'Sell all shares', 'Submit buy order']], [chase, ['Pay bill', 'Send with Zelle', 'Make transfer']],
    [amazon, ['Buy now with 1-Click', 'Buy it again', 'Subscribe & Save']], [W('Google Chrome', 'Polymarket', 'https://polymarket.com/event/rain'), ['Buy Yes', 'Buy No']], [plain, ['Buy AAPL', 'Pay bill']]]) {
    for (const l of labels) asked(await run({ win }, A([{ do: 'click_text', text: l }], win.app)), `${win.app} "${l}"`);
  }
  asked(await run({ win: chase, controls: [{ id: 1, role: 'button', label: 'Pay bill' }] }, RA([{ do: 'click', id: 1 }], 'Chase')), 'Chase read, click id "Pay bill"');
  for (const l of ['Pay attention', 'Purchase history', 'Order #1234', 'Subscribe to newsletter', 'Sell on Amazon', 'Transfer photos', 'Trade-offs', 'Checkout branch', 'Withdraw application']) {
    ran(await run({ win: plain }, A([{ do: 'click_text', text: l }])), `"${l}" on a plain page`);
  }
});

// ---- high: money surfaces beyond the lists: unlisted banks, brokers, wallets, sportsbooks, media stores, browser channels.
await section('high: unlisted banks, brokers, wallets, sportsbooks, stores and browser channels are money surfaces', async () => {
  const mercury = W('Safari', 'Mercury', 'https://app.mercury.com/dashboard'), nfcu = W('Safari', 'Navy Federal Credit Union', 'https://digitalomni.navyfederal.org/nfoaa/dashboard');
  asked(await run({ win: mercury }, A([{ do: 'click_text', text: 'Send' }])), 'Mercury Send');
  asked(await run({ win: nfcu }, A([{ do: 'click_text', text: 'Transfer' }])), 'Navy Federal Transfer');
  asked(await run({ win: W('Safari', 'USAA', 'https://www.usaa.com/my/banking'), controls: [{ id: 1, role: 'text field', label: 'Amount' }], returnPresses: 'Send' }, A([{ do: 'fill', field: 'Amount', text: '500' }, { do: 'key', key: 'return' }])), 'USAA fill Amount, Return');
  for (const [win, l] of [[W('MetaTrader 5', 'EURUSD,H1'), 'Sell'], [W('Electrum', 'Electrum - default_wallet'), 'Send'], [W('Trezor Suite', 'Trezor Suite'), 'Confirm on Trezor'],
    [W('Safari', 'DraftKings Sportsbook', 'https://sportsbook.draftkings.com/event/1'), 'Place Bet'], [W('Dia', 'Checkout', stripeCo.url), 'Confirm'],
    [W('Google Chrome Canary', 'Checkout', stripeCo.url), 'Subscribe'], [W('TV', 'Dune: Part Two'), 'Rent $3.99'], [W('Music', 'iTunes Store'), '$1.29'], [W('Safari', 'eToro', 'https://www.etoro.com/markets/aapl'), 'Trade']]) {
    asked(await run({ win }, A([{ do: 'click_text', text: l }], win.app)), `${win.app} "${l}"`);
  }
});

// ---- high: a spot's words come as "words | words": every part is judged.
await section('high: click_at labels in the helper\'s "words | words" form are judged part by part', async () => {
  for (const [win, under] of [[stripeCo, 'Pay now | Pay now'], [rh, 'Sell | Sell'], [W('App Store', 'App Store'), '$4.99 | $4.99'], [W('Venmo', 'Venmo'), 'Pay | Pay']]) {
    asked(await run({ win, under }, SA([{ do: 'click_at', x: 400, y: 300 }], win.app)), `${win.app} click_at "${under}"`);
  }
  assert.ok(core.moneyLabel('Pay now | Pay now') && core.moneyStop('$4.99 | $4.99') && core.moneyLabel('Short | Short', { surface: true }), 'each part judged');
});

// ---- high: keys typed in common shapes, a value next to a key's name, a pasted password, secrets passed by name.
await section('high: keys in common shapes, a key\'s value, a pasted password and named secret arguments are refused', async () => {
  const vercel = W('Safari', 'Environment Variables – Vercel', 'https://vercel.com/acme/app/settings/environment-variables');
  const env = [{ id: 1, role: 'text field', label: 'Key' }, { id: 2, role: 'text field', label: 'Value' }, { id: 3, role: 'button', label: 'Save' }];
  for (const k of [credentialFixture('pplx-', 20), credentialFixture('lin_api_', 20), '7f3a9c1e5b2d4f6a8c0e1b3d5f7a9c2e', 'Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56Qr78St90',
    credentialFixture('00000000:', 35), 'https://' + credentialFixture('hooks.slack.com/services/TTEST000/BTEST000/', 12), 'Tr0ub4dor&3']) {
    refused(await run({ win: vercel, controls: env }, A([{ do: 'fill', field: 'Key', text: 'API_KEY' }, { do: 'fill', field: 'Value', text: k }])), `Value ${k.slice(0, 12)}`);
  }
  refused(await run({ win: vercel, controls: env, clip: 'Tr0ub4dor&3' }, A([{ do: 'click_text', text: 'Value' }, { do: 'key', key: 'cmd+v' }])), 'a password pasted from the clipboard');
  ran(await run({ win: vercel, controls: env, clip: 'hello world' }, A([{ do: 'click_text', text: 'Value' }, { do: 'key', key: 'cmd+v' }])), 'plain words pasted');
  ran(await run({ win: vercel, controls: env }, A([{ do: 'fill', field: 'Key', text: 'REGION' }, { do: 'fill', field: 'Value', text: 'us-east-1' }])), 'a plain variable');
  assert.equal(credentialArgs({ password: 'Tr0ub4dor&3' }), true, 'password by name');
  assert.equal(credentialArgs({ api_key: credentialFixture('pplx-', 20) }), true, 'api_key by name');
  assert.equal(credentialArgs({ key: 'STRIPE_SECRET_KEY', value: 'anything-at-all' }), true, 'a value next to a key name');
  assert.equal(credentialArgs({ page_token: 'abc123', max_tokens: 100, query: 'tokens' }), false, 'a page token is no secret');
});

// ---- high: the relay contract at 457bd57: hardTags declared, hard on every ask ("none" when neither).
await section('high: the Mac speaks the web\'s 457bd57 relay contract (hardTags, hard "none")', async () => {
  assert.deepEqual(capabilitiesSchema.parse(JSON.stringify(APPROVE_CAPS)), { approveAllDeletionTags: 1, hardTags: 1 }, 'hardTags declared');
  const sent = [];
  const ask = askAsApproval(async (b) => { sent.push(b); return 'declined'; });
  await ask({ placeholder: 'Rename the file?', choices: ['Allow', "Don't allow"], deletion: false });
  await ask({ placeholder: 'Pay $5?', choices: ['Allow', "Don't allow"], deletion: false, pay: true });
  assert.deepEqual(sent.map((b) => [b.hard, b.deletion]), [['none', false], ['money', true]], JSON.stringify(sent));
  const schema = fs.readFileSync(path.join(S, 'relayschema.mjs'));
  assert.equal(crypto.createHash('sha256').update(schema).digest('hex'), '663fd02bc86756d5eb0323223cf126e0297facb5f34087122a20cdcd7005cad1', 'relayschema.mjs is the web\'s relay-schema.ts');
});

// ---- medium: one-time code and other credential field labels, in many languages.
await section('medium: one-time code, Wi-Fi key, memorable word and security answer fields are refused', async () => {
  const signin = W('Safari', 'Sign in', 'https://accounts.example.com/login');
  for (const l of ['Enter the code we sent', 'Code from your authenticator app', 'SMS code', 'Enter the 6 digits', 'Unlock code', 'PUK', 'Kod', 'Код', 'Код из SMS', 'コード', '코드', '代码', 'Mã xác minh',
    'Kode verifikasi', 'Doğrulama kodu', 'Network key', 'Wi-Fi network key', 'WPA2 key', 'Security key', 'Master key', 'Encryption key', 'Memorable word', 'Security number', 'Your answer to: first pet']) {
    refused(await run({ win: signin, controls: [{ id: 1, role: 'text field', label: l }] }, A([{ do: 'fill', field: l, text: '482913' }])), `"${l}"`);
  }
  for (const l of ['Promo code', 'ZIP code', 'License key', 'Quantity']) ran(await run({ win: plain, controls: [{ id: 1, role: 'text field', label: l }] }, A([{ do: 'fill', field: l, text: '482913' }])), `"${l}"`);
});

// ---- medium: a terminal at a password prompt.
await section('medium: typing at a terminal\'s password prompt is refused', async () => {
  const term = W('Terminal', 'zsh — sudo'), ctl = [{ id: 1, role: 'text area', label: 'shell', focused: true, value: 'fixtureuser@mac ~ % sudo ls\nPassword:' }];
  refused(await run({ win: term, controls: ctl, texts: ['Password:'] }, A([{ do: 'type', text: 'Tr0ub4dor&3\n' }], 'Terminal')), 'type the password');
  refused(await run({ win: term, controls: ctl }, A([...'hunter2'].map((k) => ({ do: 'key', key: k })), 'Terminal')), 'key by key');
  refused(await run({ win: term, controls: [{ ...ctl[0], value: "Enter passphrase for key '/Users/e/.ssh/id_ed25519':" }] }, A([{ do: 'type', text: 'correct horse battery staple\n' }], 'Terminal')), 'an ssh passphrase');
  ran(await run({ win: W('Terminal', 'zsh'), controls: [{ ...ctl[0], value: 'fixtureuser@mac ~ % ' }] }, A([{ do: 'type', text: 'ls -la\n' }], 'Terminal')), 'a plain command');
});

// ---- medium: shortcuts, search + Return and weak confirm words in money surfaces are no money.
await section('medium: shortcuts, search + Return, Done, OK, Next and a free app\'s Get run unasked in money surfaces', async () => {
  const paypal = W('Safari', 'Activity | PayPal', 'https://www.paypal.com/myaccount/activities/');
  const search = [{ id: 1, role: 'search field', label: 'Search' }];
  for (const [n, win, steps, st = {}] of [['Robinhood cmd+c', rh, [{ do: 'key', key: 'cmd+c' }]], ['Chase cmd+f', chase, [{ do: 'key', key: 'cmd+f' }]], ['Chase cmd+r', chase, [{ do: 'key', key: 'cmd+r' }]],
    ['Chase Done', chase, [{ do: 'click_text', text: 'Done' }]], ['Chase OK', chase, [{ do: 'click_text', text: 'OK' }]], ['PayPal Next', paypal, [{ do: 'click_text', text: 'Next' }]],
    ['PayPal search + Return', paypal, [{ do: 'fill', field: 'Search', text: 'spotify' }, { do: 'key', key: 'return' }], { controls: search }], ['App Store Get', W('App Store', 'App Store'), [{ do: 'click_text', text: 'Get' }]],
    ['Robinhood search + Return', rh, [{ do: 'fill', field: 'Search', text: 'NVDA' }, { do: 'key', key: 'return' }], { controls: search }]]) {
    ran(await run({ win, ...st }, A(steps, win.app)), n);
  }
  // Still money: a plain Confirm in a bank, an amount filled then Return, a Next next to an amount.
  asked(await run({ win: chase }, A([{ do: 'click_text', text: 'Confirm' }], 'Chase')), 'Chase Confirm');
  asked(await run({ win: chase, controls: [{ id: 1, role: 'text field', label: 'Amount' }] }, A([{ do: 'fill', field: 'Amount', text: '500' }, { do: 'key', key: 'return' }], 'Chase')), 'Chase fill Amount, Return');
  asked(await run({ win: chase, controls: [{ id: 1, role: 'text field', label: 'Amount' }] }, A([{ do: 'fill', field: 'Amount', text: '500' }, { do: 'click_text', text: 'Next' }], 'Chase')), 'Chase fill Amount, Next');
});

// ---- medium: the Mac's plan question on a relay turn goes as written, click words and labels too (round 4 reversed the
// round-3 rewrite: hiding the clicked labels let a money click the Mac missed pass the server's word layer; the
// nav-noun false waits are the web classifier's to fix).
await section('medium: the relay summary of a plan is sent as the Mac wrote it, with the Mac\'s verdict', async () => {
  const sent = [];
  await askAsApproval(async (b) => { sent.push(b); return 'declined'; })({ placeholder: 'In Chase, every step I\'d take:\n1. click "Pay bill"', choices: ['Allow', "Don't allow"], deletion: false, pay: true });
  assert.equal(sent[0].hard, 'money', 'the Mac\'s own verdict still says money');
  assert.equal(sent[0].summary, 'In Chase, every step I\'d take:\n1. click "Pay bill"', 'the summary is not rewritten');
});

// ---- medium: secret-file windows by export and backup names.
await section('medium: password exports, authenticator backups, seed and wallet key files are refused windows', async () => {
  const D = path.join(H, 'Downloads'); fs.mkdirSync(D, { recursive: true });
  for (const f of ['logins.csv', 'bitwarden_export_20261126.json', '1PasswordExport-ABCD-20261126.1pux', 'lastpass_export.csv', 'aegis-backup-20261126.json', '2fas-backup-20261126.2fas', 'metamask-seed.txt',
    'UTC--2026-11-26T00-00-00.000Z--0123456789abcdef0123456789abcdef01234567', 'private-key.txt', 'wallet-backup.txt', 'google-authenticator-export.png']) {
    fs.writeFileSync(path.join(D, f), 'x');
    refused(await run({ win: W('TextEdit', f, null, path.join(D, f)) }, (T) => T('read_window').execute({ target: 'TextEdit' }, {})), f);
  }
  for (const f of ['seeds.sql', 'notes.txt', 'export.csv']) { fs.writeFileSync(path.join(D, f), 'x'); ran(await run({ win: W('TextEdit', f, null, path.join(D, f)) }, (T) => T('read_window').execute({ target: 'TextEdit' }, {})), f); }
});

// ---- medium: connector money by what a call does, before the verb list; plain writes on money servers are no money.
await section('medium: connector money: convert, liquidate, rebalance, supply, borrow, contract transfers; customers and watchlists are not', async () => {
  for (const c of [{ server: 'coinbase', name: 'convert', args: { from: 'USDC', to: 'ETH', amount: '500' } }, { server: 'coinbase', name: 'wrap_eth', args: { amount: '1' } }, { server: 'aave', name: 'supply', args: { asset: 'USDC', amount: '1000' } },
    { server: 'aave', name: 'borrow', args: { asset: 'ETH', amount: '1' } }, { server: 'onchain', name: 'write_contract', args: { functionName: 'transfer', args: ['0xabc', '1'] } }, { server: 'portfolio', name: 'rebalance_portfolio', args: {} },
    { server: 'alpaca', name: 'liquidate_all', args: {} }, { server: 'google_ads', name: 'mutate_campaign_budgets', args: { amount_micros: 50000000 } }, { server: 'twilio', name: 'incoming_phone_numbers_create', args: { PhoneNumber: '+12025550114' } }]) {
    assert.equal(moneyCall(c), true, `money: ${c.server}.${c.name}`);
  }
  for (const c of [{ server: 'stripe', name: 'create_customer', args: { email: 'a@b.c' } }, { server: 'stripe', name: 'update_product_description', args: { description: 'x' } }, { server: 'wallet', name: 'add_contact', args: { name: 'A' } },
    { server: 'coinbase', name: 'create_watchlist', args: { name: 'alts' } }, { server: 'robinhood', name: 'add_to_watchlist', args: { symbol: 'NVDA' } }, { server: 'vercel', name: 'create_project_env', args: { key: 'PRICE', value: '$5' } },
    { server: 'coinbase', name: 'list_accounts', args: {} }]) {
    assert.equal(moneyCall(c), false, `not money: ${c.server}.${c.name}`);
  }
});

// ---- medium: a vault reached mid-plan: a control that copies or shows a secret is refused up front.
await section('medium: Copy password and Show password are refused anywhere, so a vault reached mid-plan is not acted in', async () => {
  const start = W('Safari', 'Apple', 'https://www.apple.com/'), vault = W('Safari', 'Passwords');
  refused(await run({ win: start, after: vault }, A([{ do: 'key', key: 'cmd+,' }, { do: 'click_text', text: 'Passwords' }, { do: 'click_text', text: 'Copy Password' }])), 'Safari Passwords, Copy Password');
  refused(await run({ win: start, after: vault }, A([{ do: 'click_text', text: 'Settings' }, { do: 'click_text', text: 'Google Password Manager' }, { do: 'click_text', text: 'Copy password' }])), 'Chrome, Copy password');
  refused(await run({ win: plain, controls: [{ id: 1, role: 'button', label: 'Show password' }] }, RA([{ do: 'click', id: 1 }])), 'click id Show password');
  ran(await run({ win: plain }, A([{ do: 'click_text', text: 'Copy code' }])), 'a code block\'s Copy code');
});

// ---- low: vault titles in browser channels and newer browsers.
await section('low: vault titles in Dia, Chrome Canary, Firefox Developer Edition, Safari Technology Preview and Edge Beta are refused', async () => {
  for (const [app, title] of [['Dia', 'Google Password Manager'], ['Google Chrome Canary', 'Google Password Manager'], ['Firefox Developer Edition', 'Passwords'], ['Safari Technology Preview', 'Passwords'], ['Microsoft Edge Beta', 'Passwords']]) {
    refused(await run({ win: W(app, title) }, (T) => T('read_window').execute({ target: app }, {})), `${app} "${title}"`);
  }
});

// ---- low: false refusals of ordinary typed text.
await section('low: a grocery list, colours, the NATO alphabet and a bare NNN-NN-NNNN are typed; a BIP39 seed and a named SSN are not', async () => {
  for (const t of ['milk eggs bread butter cheese apples bananas coffee sugar flour rice beans', 'red blue green yellow orange purple pink brown black white gray gold',
    'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima', 'call 555-12-3456', 'order 123-45-6789 shipped']) {
    assert.equal(core.typedCredential(t), null, `typed: ${t}`);
  }
  for (const t of ['legal winner thank year wave sausage worth useful legal winner thank yellow', 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', 'SSN 123-45-6789', 'my social security number is 123-45-6789']) {
    assert.notEqual(core.typedCredential(t), null, `refused: ${t}`);
  }
  const { BIP39_WORDS } = await import('../bip39.mjs');
  assert.equal(crypto.createHash('sha256').update(`${BIP39_WORDS.join('\n')}\n`).digest('hex'), '2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda', 'BIP39 English, as published');
});

// ---- low: plan.money only where money can be: no second ask at OK, Go or Continue elsewhere.
await section('low: an ordinary plan tells the helper no money, so Finder Go, a dialog OK and a form Continue ask once', async () => {
  for (const [n, win, steps, st] of [['Finder Go to Folder', W('Finder', 'Downloads'), [{ do: 'key', key: 'cmd+shift+g' }, { do: 'type', text: '~/Documents' }, { do: 'key', key: 'return' }], { returnPresses: 'Go' }],
    ['TextEdit dialog OK', W('TextEdit', 'Untitled'), [{ do: 'key', key: 'return' }], { returnPresses: 'OK' }], ['a form Continue', plain, [{ do: 'fill', field: 'Name', text: 'FixtureUser' }, { do: 'key', key: 'return' }], { returnPresses: 'Continue', controls: [{ id: 1, role: 'text field', label: 'Name' }] }]]) {
    const x = await run({ win, ...st }, A(steps, win.app), { approveAll: false, owner: () => 'yes' });
    assert.equal(x.acts[0]?.money, false, `${n}: no money stop`);
    assert.equal(x.asks.length, 1, `${n}: one ask (${JSON.stringify(x.asks)})`);
    assert.doesNotMatch(x.r, /^ERR/, `${n}: ${x.r}`);
  }
  assert.equal((await run({ win: chase }, A([{ do: 'click_text', text: 'Statements' }], 'Chase'))).acts[0]?.money, true, 'a bank plan still tells the helper');
});

// ---- low: card numbers in pairs, triples and with a stray split group.
await section('low: cards written in pairs, triples or with a split group are refused; separate values are not', async () => {
  // Round 4: pairs and triples are no longer read as a card (8 two-digit numbers read as one 3.4% of the time); a card
  // typed in fours with a split last group still is.
  for (const t of ['4242 4242 4242 424 2', '4242 4242 4242 4242']) assert.equal(checkTyped(t, H).level, 'block', `typed: ${t}`);
  for (const t of ['4155550132 94107 04/12/1990', 'DE89 3704 0044 0532 0130 00', '114-3941689-8772232', 'call 415 555 0132']) assert.notEqual(checkTyped(t, H).level, 'block', `typed: ${t}`);
});

fs.rmSync(tmp, { recursive: true, force: true });
assert.deepEqual(failed, [], `failing: ${failed.join('; ')}`);
console.log('hard limits round 4 (A3 desktop, round-3 findings): passed');
