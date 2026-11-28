// The owner's hard limits, round 3 (A3 desktop, the round-2 review's findings, each in the shape it was found), with
// Approve all ON unless said:
// 1. typing a password, credential, key or card number into any field, and reading a password manager's or a secret
//    file's window: refused, never asked, whatever the owner says;
// 2. paying, buying, ordering, subscribing, transferring money or trading: always asked.
// Everything else runs unasked under Approve all (deletes too): the false asks and false refusals found are here too.
// Nothing here reaches the Mac: the hands helper is a stub written below that stops where main.swift stops (RISKY and
// MONEY by isRiskyClick, AMBIG by confirmWord when the plan says money), and the system commands are stubs on PATH.
import { credentialFixture, privateKeyHeader } from './fixtures/credential-fixtures.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hardlimits3-'));
process.env.ROAMIES_DATA_DIR = path.join(tmp, 'data');
process.env.HOME = path.join(tmp, 'home'); fs.mkdirSync(process.env.HOME);
const H = process.env.HOME;
const bin = path.join(tmp, 'bin');
fs.mkdirSync(bin);
for (const c of ['osascript', 'screencapture', 'sips', 'afplay', 'say', 'pbcopy', 'pbpaste']) fs.writeFileSync(path.join(bin, c), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
fs.writeFileSync(path.join(bin, 'open'), '#!/bin/sh\necho "Unable to find application" >&2\nexit 1\n', { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;
const S = new URL('..', import.meta.url).pathname;
const stub = path.join(tmp, 'hands.mjs'), stState = path.join(tmp, 'st.json'), stLog = path.join(tmp, 'log.jsonl');
fs.writeFileSync(stub, `import fs from 'node:fs';
const { isRiskyClick } = await import(${JSON.stringify(`${S}safety.mjs`)});
const { confirmWord } = await import(${JSON.stringify(`${S}hardlimits-core.mjs`)});
const a = process.argv.slice(2), s = JSON.parse(fs.readFileSync(${JSON.stringify(stState)}, 'utf8'));
fs.appendFileSync(${JSON.stringify(stLog)}, JSON.stringify({ a }) + '\\n');
const out = (o) => { console.log(JSON.stringify(o)); process.exit(0); };
const w = s.win ?? { id: 1, pid: 10, app: 'Safari', title: 'Example', url: 'https://www.example.com/page', bounds: [0, 0, 800, 600] };
const controls = s.controls ?? [{ id: 1, role: 'text field', label: 'Email' }, { id: 2, role: 'password field', label: '' }, { id: 3, role: 'button', label: 'Sign in' }];
if (a[0] === 'resolve') out({ ok: true, window: w, running: w.app, runningPid: w.pid });
if (a[0] === 'locate') out({ ok: true, window: s.now ?? w });
if (a[0] === 'front') out({ ok: true, app: w.app, pid: w.pid });
if (a[0] === 'ui') out({ ok: true, window: w, controls, texts: s.texts ?? [], note: '' });
if (a[0] === 'capture') { fs.writeFileSync(a[1], 'png'); out(s.capShown ? { ok: true, shown: s.capShown, bounds: [0, 0, 800, 600], pixels: [800, 600] } : { ok: true, window: w, pixels: [800, 600] }); }
if (a[0] === 'act') {
  const plan = JSON.parse(a[1]);
  const stops = (l) => isRiskyClick(l) || (plan.money === true && confirmWord(l));
  const done = [];
  for (const [i, x] of plan.steps.entries()) {
    const l = x.do === 'click_text' ? x.text : x.do === 'click' ? (controls.find((c) => c.id === x.id)?.label ?? '') : x.do === 'click_at' ? (s.under ?? '') : x.do === 'choose' ? x.option : '';
    if (l && stops(l) && !(x.confirmed && x.confirmedLabel === l)) out({ ok: false, needsConfirm: true, step: i, label: l, why: 'Click "' + l + '" in ' + w.app + '? It could delete, pay, send, quit or sign out.', done });
    done.push(x.do);
  }
  out({ ok: true, done, window: s.after ?? w });
}
if (a[0] === 'manage') out({ ok: true, done: 'done' });
if (a[0] === 'windows') out({ ok: true, windows: s.wins ?? [w], all: true });
out({ ok: true });
`);
process.env.ROAMIES_HANDS = stub;

const safety = await import('../safety.mjs');
const core = await import('../hardlimits-core.mjs');
const { approveAllSays, checkWindow, moneyCall, hardTag, checkTyped, isRiskyClick } = safety;
const { createTools } = await import('../tools.mjs');
const { askAsApproval, createRelay, moneyTools, moneyTurn } = await import('../relay.mjs');
const { askMacTool, brainGate } = await import('../brain-server.mjs');
const { relaySubturnSchema, relayApprovalSchema } = await import('../relayschema.mjs');

// Each section runs on even when one before it fails, so a run on the code before the fix shows every finding red.
const failed = [];
const section = async (name, fn) => { try { await fn(); console.log(`  ok   ${name}`); } catch (e) { failed.push(name); console.log(`  FAIL ${name}: ${String(e.message).split('\n')[0].slice(0, 200)}`); } };
let tools = null;
const run = async (state, fn, { owner = () => null, approveAll = true, fresh = true } = {}) => {
  fs.writeFileSync(stState, JSON.stringify(state)); fs.writeFileSync(stLog, '');
  const asks = [];
  const ask = async (o) => { const auto = approveAllSays(approveAll, o); asks.push({ auto, pay: !!o.pay, q: String(o.placeholder ?? '').split('\n')[0] }); return auto ? 'yes' : owner(o); };
  if (fresh || !tools) {
    tools = createTools({ allowActions: () => true, ui: () => {}, openUrl: async () => {}, onCommitments: async () => {}, showList: async () => {}, fmtWhen: String, commitmentsText: () => '', userName: 'Test', workdir: tmp, ask: (o) => tools.ask(o) });
    tools.nextTurn?.();
  }
  tools.ask = ask;
  const T = (n) => tools.tools.find((x) => x.name === n);
  const r = await fn(T).then((x) => String(x), (e) => `ERR ${e.message}`);
  const calls = fs.readFileSync(stLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).a);
  const acts = calls.filter((c) => c[0] === 'act').map((c) => JSON.parse(c[1]));
  return { asks, r, calls, acts };
};
const A = (steps, target = 'Safari') => (T) => T('act_in_app').execute({ target, steps }, {});
const RA = (steps, target = 'Safari') => async (T) => { await T('read_window').execute({ target }, {}); return T('act_in_app').execute({ target, steps }, {}); };
const SA = (steps, target = 'Safari') => async (T) => { await T('take_screenshot').execute({ target }, {}); return T('act_in_app').execute({ target, steps }, {}); };
const refused = (x, why) => { assert.match(x.r, /^ERR Blocked for safety/, `${why}: ${x.r}`); assert.equal(x.acts.length, 0, `${why}: nothing acted`); };
const asked = (x, why) => assert.ok(x.asks.some((a) => !a.auto), `${why}: a hard ask (${JSON.stringify(x.asks)}; ${x.r})`);
const ran = (x, why) => { assert.ok(!x.asks.some((a) => !a.auto), `${why}: no ask the owner must answer (${JSON.stringify(x.asks)})`); assert.doesNotMatch(x.r, /^ERR/, `${why}: ${x.r}`); };
const W = (app, title, url, document) => ({ id: 1, pid: 10, app, title, ...(url ? { url } : {}), ...(document ? { document } : {}), bounds: [0, 0, 800, 600] });

// ---- critical: choose types its option, so into a credential field it is refused (sidecar layer).
await section('critical: choose types its option, so into a credential field it is refused (sidecar layer', async () => {
  const login = W('Safari', 'Sign in - Example', 'https://accounts.example.com/signin');
  const ctl = [{ id: 1, role: 'text field', label: 'Email' }, { id: 2, role: 'password field', label: 'Password' }, { id: 3, role: 'text field', label: 'Verification code' }, { id: 4, role: 'button', label: 'Sign in' }];
  refused(await run({ win: login, controls: ctl }, RA([{ do: 'choose', id: 2, option: 'hunter2' }])), 'choose id 2 (password field)');
  refused(await run({ win: login, controls: ctl }, A([{ do: 'choose', field: 'Password', option: 'hunter2' }])), 'choose field Password, no read');
  refused(await run({ win: login, controls: ctl }, A([{ do: 'choose', field: 'Verification code', option: '482913' }])), 'choose field Verification code');
  ran(await run({ win: W('Safari', 'Shipping', 'https://shop.example.com/address'), controls: [{ id: 1, role: 'pop up button', label: 'Country' }] }, A([{ do: 'choose', field: 'Country', option: 'France' }])), 'choose a country');
});

// ---- low (sidecar tracking): typing where the field can't be named, on a page with a password field.
await section('low (sidecar tracking): typing where the field can\'t be named, on a page with a password f', async () => {
  const login = W('Safari', 'Sign in', 'https://accounts.example.com/login');
  const C = [{ id: 1, role: 'text field', label: 'Email' }, { id: 2, role: 'password field', label: '' }, { id: 3, role: 'button', label: 'Sign in' }];
  const PW = 'hunter2', keys = PW.split('').map((k) => ({ do: 'key', key: k }));
  for (const [n, f] of [
    ['click id 1, tab, key by key', RA([{ do: 'click', id: 1 }, { do: 'key', key: 'tab' }, ...keys])],
    ['click id 1, tab, cmd+v', RA([{ do: 'click', id: 1 }, { do: 'key', key: 'tab' }, { do: 'key', key: 'cmd+v' }])],
    ['type with a tab inside', RA([{ do: 'click', id: 1 }, { do: 'type', text: `me@example.com\t${PW}` }])],
    ['fill with a tab inside', RA([{ do: 'fill', field: 'Email', text: `me@example.com\t${PW}` }])],
    ['tab, tab, shift+tab, type', RA([{ do: 'click', id: 1 }, { do: 'key', key: 'tab' }, { do: 'key', key: 'tab' }, { do: 'key', key: 'shift+tab' }, { do: 'type', text: PW }])],
    ['focus the Sign in button, shift+tab, type', RA([{ do: 'focus', id: 3 }, { do: 'key', key: 'shift+tab' }, { do: 'type', text: PW }])],
    ['no read: click_text Email, tab, type', A([{ do: 'click_text', text: 'Email' }, { do: 'key', key: 'tab' }, { do: 'type', text: PW }])],
    ['no read: fill Email, tab, type', A([{ do: 'fill', field: 'Email', text: 'me@example.com' }, { do: 'key', key: 'tab' }, { do: 'type', text: PW }])],
    ['screenshot, click_at, type', SA([{ do: 'click_at', x: 100, y: 100 }, { do: 'type', text: PW }])],
    ['screenshot, click_at, key by key', SA([{ do: 'click_at', x: 100, y: 100 }, ...keys])],
    ['screenshot, click_at, cmd+v', SA([{ do: 'click_at', x: 100, y: 100 }, { do: 'key', key: 'cmd+v' }])],
    ['click_text Next (reveals the password field), type', RA([{ do: 'fill', field: 'Email', text: 'a@b.c' }, { do: 'click_text', text: 'Next' }, { do: 'type', text: PW }])],
    ['click_text Next, key by key', RA([{ do: 'click_text', text: 'Next' }, ...keys])],
    ['fill Email, return, type', RA([{ do: 'fill', field: 'Email', text: 'a@b.c' }, { do: 'key', key: 'return' }, { do: 'type', text: PW }])],
  ]) refused(await run({ win: login, controls: C }, f), n);
  // A form with no credential field: tab and type run.
  ran(await run({ win: W('Safari', 'Contact', 'https://example.com/contact'), controls: [{ id: 1, role: 'text field', label: 'Email' }, { id: 2, role: 'text field', label: 'Name' }] }, A([{ do: 'fill', field: 'Email', text: 'a@b.c' }, { do: 'key', key: 'tab' }, { do: 'type', text: 'FixtureUser' }])), 'fill Email, tab, type a name');
});

// ---- medium: credential fields in other languages and sign-in codes; label shapes that are not one.
await section('medium: credential fields in other languages and sign-in codes; label shapes that are not ', async () => {
  const win = W('Safari', 'Sign in', 'https://accounts.example.com/login');
  for (const l of ['Sign-in code', 'Login code', 'Backup code', 'Code', 'Enter code', 'Código de verificación', 'Code de vérification', 'Bestätigungscode', '验证码', '認証コード', '인증번호', 'Kata sandi', 'Mật khẩu', 'Salasana', 'Hasło', 'Parola', 'Κωδικός πρόσβασης', 'סיסמה', 'كلمة المرور', 'รหัสผ่าน', 'Clave', 'Geheimzahl', 'NIP', 'Numer karty', 'Wallet seed', '12-word phrase', 'रहस्यशब्द', 'Security answer', "Mother's maiden name"]) {
    refused(await run({ win, controls: [{ id: 1, role: 'text field', label: 'Email' }, { id: 2, role: 'text field', label: l }] }, A([{ do: 'fill', field: l, text: '482913' }])), `fill "${l}"`);
  }
  const plain = W('Safari', 'Example Domain', 'https://www.example.com/');
  const ok = [{ id: 1, role: 'text field', label: 'Email' }, { id: 2, role: 'text field', label: 'Name' }];
  for (const [f, t] of [['API key name', 'ci-deploy'], ['Card title', 'Ship it'], ['Card #', '42'], ['Code', 'print(1)'], ['Pin title', 'Trip'], ['Promo code', 'SAVE10'], ['Gift card number', '1234567'], ['Token name', 'ci'], ['Expiry', '2027-01-01']]) {
    ran(await run({ win: plain, controls: ok }, A([{ do: 'fill', field: f, text: t }])), `fill "${f}"`);
  }
});

// ---- high: ordinary address and contact forms are no card number; a card is still found in its shapes.
await section('high: ordinary address and contact forms are no card number; a card is still found in its ', async () => {
  const form = W('Safari', 'Contact details - Example Clinic', 'https://www.example-clinic.com/intake');
  const ctl = [{ id: 1, role: 'text field', label: 'Phone' }, { id: 2, role: 'text field', label: 'ZIP code' }, { id: 3, role: 'text field', label: 'Date of birth' }];
  ran(await run({ win: form, controls: ctl }, A([{ do: 'fill', field: 'Phone', text: '4155550100' }, { do: 'fill', field: 'ZIP code', text: '94107' }, { do: 'fill', field: 'Date of birth', text: '04/12/1990' }])), 'phone, ZIP, date of birth');
  ran(await run({ win: form, controls: ctl }, A([{ do: 'fill', field: 'Phone', text: '202-555-0112' }, { do: 'fill', field: 'ZIP code', text: '94043' }, { do: 'fill', field: 'Date of birth', text: '1990-04-12' }])), 'phone, ZIP, date (dashes)');
  ran(await run({ win: form, controls: ctl }, A(['4539', '1488', '0343', '6467'].map((t, i) => ({ do: 'fill', field: `B${i + 2}`, text: t })))), 'four spreadsheet cells');
  ran(await run({ win: form, controls: ctl }, A(['1250', '3400', '980', '4521', '2210', '675', '1830', '5120'].map((t, i) => ({ do: 'fill', field: `B${i + 2}`, text: t })))), 'eight cells');
  for (const t of ['2125551234 10001 12/25/1985', '1 Infinite Loop 95014 4089961010', '021000021 483920175566', '00012345600012 00012345600029']) assert.equal(core.cardNumber(t), null, `not a card: ${t}`);
  // A card: in one fill, key by key into one field, and typed on into the same field in the next request.
  refused(await run({ win: form, controls: ctl }, A([{ do: 'fill', field: 'Phone', text: '4242 4242 4242 4242' }])), 'a card in one fill');
  refused(await run({ win: form, controls: ctl }, RA([{ do: 'click', id: 1 }, ...'4242424242424242'.split('').map((k) => ({ do: 'key', key: k }))])), 'a card key by key');
  const one = await run({ win: form, controls: [{ id: 1, role: 'text field', label: 'Reference', focused: true }] }, RA([{ do: 'type', text: '4242 4242' }]));
  ran(one, 'half a card');
  tools.nextTurn();
  refused(await run({ win: form, controls: [{ id: 1, role: 'text field', label: 'Reference', focused: true }] }, RA([{ do: 'type', text: ' 4242 4242' }]), { fresh: false }), 'the rest of it, next request, same field');
  // Two requests of separate fills (round 1: 89% of routing + account numbers were refused).
  ran(await run({ win: form, controls: ctl }, async (T) => { await T('act_in_app').execute({ target: 'Safari', steps: [{ do: 'fill', field: 'Qty', text: '4539' }, { do: 'fill', field: 'SKU', text: '148803' }] }, {}); tools.nextTurn(); return T('act_in_app').execute({ target: 'Safari', steps: [{ do: 'fill', field: 'Qty', text: '43' }, { do: 'fill', field: 'SKU', text: '6467' }] }, {}); }), 'two requests of separate fills');
});
await section('low: card numbers with more separators and digit scripts', async () => {
  for (const t of ['4242,4242,4242,4242', '4242:4242:4242:4242', '4242+4242+4242+4242', '4242x4242x4242x4242', '٤٢٤٢٤٢٤٢٤٢٤٢٤٢٤٢', '4242 - 4242 - 4242 - 4242']) {
    assert.ok(core.cardNumber(t), `a card: ${JSON.stringify(t)}`);
  }
});

// ---- medium: key and token shapes typed.
await section('medium: key and token shapes typed', async () => {
  for (const t of [credentialFixture('ASIA', 16), credentialFixture('AIza', 20), credentialFixture('hf_', 20), credentialFixture('gsk_', 16), credentialFixture('xai-', 16), (credentialFixture('SG.', 8) + '.' + credentialFixture('', 8)), credentialFixture('dop_v1_', 8), credentialFixture('shpat_', 8), credentialFixture('sbp_', 8), credentialFixture('ya29.', 8), 'Bearer FAKEFAKEFAKEFAKEFAKEFAKE', `https://fixtureuser:${credentialFixture('FixturePassword-', 6)}@example.com/`, 'postgres://user:hunter2@db.example.com:5432/app', 'legal winner thank year wave sausage worth useful legal winner thank yellow', credentialFixture('0x', 64, '0'), credentialFixture('5', 50, '1'), 'SSN 123-45-6789']) {
    assert.equal(checkTyped(t, H).level, 'block', `typed: ${t}`);
  }
  for (const t of ['ask-me-anything thread', 'Remember to change your password every 90 days', 'correct horse battery staple', 'see you at 6', 'git checkout main', 'the quick brown fox jumps over the lazy dog then runs back home']) assert.notEqual(checkTyped(t, H).level, 'block', `typed: ${t}`);
  refused(await run({ win: W('Safari', 'Example', 'https://example.com/'), controls: [{ id: 1, role: 'text field', label: 'Notes', focused: true }] }, RA([...credentialFixture('sk_live_', 8).split('').map((k) => ({ do: 'key', key: k === '_' ? 'shift+-' : k.toLowerCase() }))])), 'a key typed key by key');
});

// ---- high: money still asks: many languages, by context at each stop, cmd+return, prices, Long and Short.
await section('high: money still asks: many languages, by context at each stop, cmd+return, prices, Long ', async () => {
  const shop = W('Safari', 'Your order - Acme Outdoor', 'https://www.acme-outdoor.com/step/3');
  const bank = W('Safari', 'Ally - Move money', 'https://secure.ally.com/dashboard/transfers/new');
  const paypal = W('Safari', 'PayPal: Geld senden', 'https://www.paypal.com/myaccount/transfer/homepage/pay');
  const monzo = W('Monzo', 'Monzo'), appstore = W('App Store', 'App Store'), rh = W('Robinhood', 'Robinhood');
  const plain = W('Safari', 'Example Domain', 'https://www.example.com/');
  for (const l of ['Betalen', 'Kopen', 'Paga', 'Bayar', 'Beli', 'Afrekenen', 'Commander', 'Passer la commande', 'Realizar pedido', 'Finalizar pedido', 'Zur Kasse', 'Köp', 'Betala', 'Kup teraz', 'Zapłać', 'Satın al', 'Оплатить', 'Купить', 'Оформить заказ', '提交订单', '去结算', '買う', 'खरीदें', 'Complete booking', 'Confirm booking', 'Request to book', 'Get tickets']) {
    asked(await run({ win: plain }, A([{ do: 'click_text', text: l }])), `click_text "${l}" on any page`);
  }
  for (const l of ['Bestätigen', 'Senden', 'Weiter', 'Confirmar', '确认']) asked(await run({ win: paypal }, A([{ do: 'click_text', text: l }])), `PayPal "${l}"`);
  for (const l of ['Send', 'Confirm', 'Continue']) asked(await run({ win: monzo }, A([{ do: 'click_text', text: l }], 'Monzo')), `Monzo "${l}"`);
  for (const l of ['Send', 'Submit', 'Confirm', 'Schedule transfer']) asked(await run({ win: bank }, A([{ do: 'click_text', text: l }])), `bank transfers page "${l}"`);
  for (const l of ['Confirm', 'Continue', 'Join now']) asked(await run({ win: shop }, A([{ do: 'click_text', text: l }])), `checkout step "${l}"`);
  // The money context at each helper stop and along the plan: product page, Add to bag, Continue, Confirm.
  asked(await run({ win: W('Safari', 'Trail shoes - Acme Outdoor', 'https://www.acme-outdoor.com/p/trail-shoes') }, A([{ do: 'click_text', text: 'Add to bag' }, { do: 'click_text', text: 'Continue' }, { do: 'click_text', text: 'Continue' }, { do: 'click_text', text: 'Confirm' }])), 'a plan heading to checkout');
  // The page the helper stops on is a checkout by then (it changed since the plan started): judged there.
  asked(await run({ win: W('Safari', 'Trail shoes', 'https://www.acme-outdoor.com/p/trail-shoes'), now: W('Safari', 'Checkout', 'https://www.acme-outdoor.com/checkout'), under: 'Confirm' }, SA([{ do: 'click_at', x: 400, y: 300 }])), 'a stop on a page that is a checkout now');
  // Keys that submit in a money surface.
  for (const [n, win, steps] of [['PayPal cmd+return', paypal, [{ do: 'key', key: 'cmd+return' }]], ['bank fill Amount, return', bank, [{ do: 'fill', field: 'Amount', text: '500' }, { do: 'key', key: 'return' }]], ['bank key enter', bank, [{ do: 'key', key: 'enter' }]], ['bank tab, space', bank, [{ do: 'click_text', text: 'Amount' }, { do: 'key', key: 'tab' }, { do: 'key', key: 'space' }]], ['Robinhood ctrl+m', rh, [{ do: 'key', key: 'ctrl+m' }]]]) {
    asked(await run({ win, controls: [{ id: 1, role: 'text field', label: 'Amount' }, { id: 2, role: 'button', label: 'Send' }] }, A(steps, win.app)), n);
  }
  // Clicks by a spot: the helper stops at prices, Long, Short, Open position; the sidecar asks there. (App Store's Get
  // is a free app's button since round 4: a paid one shows its price, hardlimits4.)
  for (const [win, under] of [[appstore, '$4.99'], [appstore, 'Rent $3.99'], [rh, 'Long'], [rh, 'Short'], [rh, 'Open position'], [rh, 'Exercise'], [rh, 'Close position'], [shop, '$49.00'], [shop, 'PayPal'], [shop, 'Überweisen']]) {
    asked(await run({ win, under }, SA([{ do: 'click_at', x: 400, y: 300 }], win.app)), `${win.app}: click_at on "${under}"`);
  }
  // A stop at a word that is not money where it is: runs on with no ask.
  ran(await run({ win: plain, under: 'Next' }, SA([{ do: 'click_at', x: 400, y: 300 }])), 'click_at on Next on a plain page');
  ran(await run({ win: plain, under: 'Short' }, SA([{ do: 'click_at', x: 400, y: 300 }])), 'click_at on Short on a plain page');
});

// ---- high: no false asks for plain nav labels and ordinary windows that look like money.
await section('high: no false asks for plain nav labels and ordinary windows that look like money', async () => {
  const plain = W('Safari', 'Example Domain', 'https://www.example.com/');
  for (const l of ['Payments', 'Payroll', 'Short', 'Trade', 'Exercise', 'Purchases', 'Purchased', 'Buying guide', 'Sell on Amazon', 'Refunds', 'Donations', 'Renewals', 'Tip', 'Book', 'Rent', 'Reserve', 'Upgrade', 'Order', 'Deposit', 'Withdraw', 'Swap columns', 'Reorder columns', 'Settled', 'Pay period', 'Paying customers', 'Pre-order info', 'Subscribers', 'Subscribe', 'Checkout', 'Trading 101', 'Price: $20', 'MacBook Air from $999', 'Coffee $5.00', 'Under $25', 'Rent $1,200', 'Send', 'Confirm', 'Continue', 'Next', 'Delete', 'Transfer photos', 'Pay attention', 'Checkout branch', 'Withdraw application']) {
    ran(await run({ win: plain }, A([{ do: 'click_text', text: l }])), `click_text "${l}" on a plain page`);
  }
});
await section('high: no false asks from the money context: a money word in a title or path, a listed app, an amount anywhere', async () => {
  const typ = [{ do: 'click_text', text: 'Body' }, { do: 'type', text: 'hello\nworld' }];
  for (const [label, win, steps, texts] of [
    ['Notes "Things to buy", two lines', W('Notes', 'Things to buy'), typ],
    ['Slack #billing, type + return', W('Slack', '#billing - Acme - Slack'), [{ do: 'type', text: 'on it' }, { do: 'key', key: 'return' }]],
    ['docs.stripe.com/payments, Next', W('Safari', 'Payments | Stripe Documentation', 'https://docs.stripe.com/payments/accept-a-payment'), [{ do: 'click_text', text: 'Next' }]],
    ['github checkout/index.ts, Go to file', W('Safari', 'shop/src/checkout/index.ts at main', 'https://github.com/acme/shop/blob/main/src/checkout/index.ts'), [{ do: 'click_text', text: 'Go to file' }]],
    ['localhost:3000/billing, Continue', W('Safari', 'Acme dev', 'http://localhost:3000/billing'), [{ do: 'click_text', text: 'Continue' }]],
    ['Google results for "buy a bike", Next', W('Safari', 'buy a bike - Google Search', 'https://www.google.com/search?q=buy+a+bike'), [{ do: 'click_text', text: 'Next' }]],
    ['TradingView, Done', W('TradingView', 'AAPL chart'), [{ do: 'click_text', text: 'Done' }]],
    ['Steam, Next', W('Steam', 'Steam'), [{ do: 'click_text', text: 'Next' }]],
    ['Wallet, Done', W('Wallet', 'Wallet'), [{ do: 'click_text', text: 'Done' }]],
    ['Numbers budget with amounts, type + return', W('Numbers', 'Budget 2026'), [{ do: 'type', text: '42' }, { do: 'key', key: 'return' }], ['Rent $1,200.00', 'Food $400.00']],
    ['Messages with an amount, type + return', W('Messages', 'Sam'), [{ do: 'type', text: 'see you at 6' }, { do: 'key', key: 'return' }], ['you owe me $5 lol']],
    ['Hydra Transactions, Next', W('Hydra', 'Transactions'), [{ do: 'click_text', text: 'Next' }], ['Coffee $5.00', 'Rent $1,200.00']],
    ['news with "$5 billion", Continue reading', W('Safari', 'Markets today', 'https://news.example.com/markets'), [{ do: 'click_text', text: 'Continue reading' }], ['The fund raised $5 billion']],
    ['Finder folder "Cart", return', W('Finder', 'Cart'), [{ do: 'key', key: 'return' }]],
  ]) ran(await run({ win, texts: texts ?? [], controls: [{ id: 1, role: 'text field', label: 'Body' }, { id: 2, role: 'search field', label: 'Search' }] }, texts ? RA(steps, win.app) : A(steps, win.app)), label);
  // A checkout's total on the page makes it a money surface.
  asked(await run({ win: W('Safari', 'Step 3 of 3', 'https://www.acme-outdoor.com/step/3'), texts: ['Total $84.20'], controls: [{ id: 1, role: 'button', label: 'x' }] }, RA([{ do: 'click_text', text: 'Continue' }])), 'Continue under a total');
  asked(await run({ win: W('Safari', 'Schritt 3', 'https://www.acme-outdoor.de/step/3'), texts: ['Gesamt 84,20 €'], controls: [{ id: 1, role: 'button', label: 'x' }] }, RA([{ do: 'click_text', text: 'Weiter' }])), 'Weiter under a German total');
});

// ---- secret files, vaults and dotfiles.
const mkf = (rel, body = 'x') => { const p = path.join(H, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); return p; };
const rd = (win) => run({ win }, (T) => T('read_window').execute({ target: win.app }, {}));
await section('high: password exports, recovery and backup codes, emergency kits and seed phrases are refused', async () => {
  // high: password exports, recovery and backup codes, emergency kits, seed phrases: refused, as windows and read_file.
  for (const rel of ['Documents/passwords.txt', 'Documents/passwords.csv', 'Downloads/Chrome Passwords.csv', 'Desktop/github-recovery-codes.txt', 'Desktop/2fa-backup-codes.txt', 'Desktop/1Password Emergency Kit.pdf', 'Desktop/seed phrase.txt', 'Desktop/credentials.json', '.config/gh/hosts.yml', '.config/hydra/notes.txt']) {
    const f = mkf(rel, 'name,url,username,password\nx,https://x,me,hunter2\n');
    refused(await rd(W(/pdf$/.test(rel) ? 'Preview' : 'TextEdit', path.basename(rel), null, f)), `window on ~/${rel}`);
    const x = await run({ win: W('Safari', 'Example', 'https://example.com/') }, (T) => T('read_file').execute({ path: f }, {}));
    assert.match(x.r, /^ERR .*holds passwords or keys/, `read_file ~/${rel}: ${x.r}`);
    assert.doesNotMatch(x.r, /hunter2/);
  }
});
await section('medium: dotfiles and project settings are ordinary asks, never hard, never tagged credential', async () => {
  for (const rel of ['.zshrc', '.gitconfig', 'proj/.gitignore', 'proj/.eslintrc.json', '.config/nvim/init.lua', '.config/ghostty/config', 'proj/.env.example', 'proj/.github/workflows/ci.yml', 'proj/.vscode/settings.json', 'proj/docs/credentials.md']) {
    const f = mkf(rel, 'set nu');
    const x = await run({ win: W('Safari', 'Example', 'https://example.com/') }, (T) => T('read_file').execute({ path: f }, {}));
    ran(x, `read_file ~/${rel}`);
    assert.match(x.r, /set nu/, `read_file ~/${rel}`);
    ran(await rd(W('Code', path.basename(rel), null, f)), `window on ~/${rel}`);
  }
  assert.equal(hardTag({ secret: true }), null, 'a plain secret ask is never tagged credential');
});
await section('medium: an ordinary ~/.config window is no secret file (whole-screen shot, read_window); a .key deck is no key', async () => {
  const code = W('Code', 'init.lua — nvim', null, path.join(H, '.config/nvim/init.lua'));
  const safari = W('Safari', 'Example', 'https://www.example.com/');
  ran(await run({ win: safari, capShown: [safari, { ...code, id: 2 }], wins: [safari, { ...code, id: 2 }] }, (T) => T('take_screenshot').execute({ target: 'screen' }, {})), 'screen shot with a ~/.config editor window');
  // A Keynote deck is a .key file, not a key (by its content: a key starts -----BEGIN or is DER).
  const deck = mkf('Documents/Q3-pitch.key', 'PK\u0003\u0004deck');
  for (const app of ['Keynote', 'Preview', 'Finder']) ran(await rd(W(app, 'Q3-pitch.key', null, deck)), `${app} on a Keynote deck`);
  refused(await rd(W('TextEdit', 'server.key', null, mkf('Desktop/server.key', (privateKeyHeader('') + '\nx')))), 'a PEM .key');
});
await section('medium: vaults by extension id, self-hosted host, more web vaults and apps; ordinary windows that name one', async () => {
  for (const [t, u] of [['Bitwarden', 'https://bw.example-selfhosted.com/#/vault'], ['Bitwarden', 'chrome-extension://nngceckbapebfimnlniiiahkandclblb/popup/index.html#/tabs/vault'], ['1Password', 'chrome-extension://aeblfdkhhhdcdjpifhhbdiojplfjncoa/app/app.html'], ['1Password – Password Manager', 'safari-web-extension://1E2D3C4B/popup.html'], ['LastPass Vault', 'chrome-extension://hdokiejnpimakedhajhdlcegeplioahd/vault.html'], ['NordPass', 'https://app.nordpass.com/'], ['Zoho Vault', 'https://vault.zoho.com/app#/unlock'], ['RoboForm Online', 'https://online.roboform.com/site/'], ['Passbolt', 'https://cloud.passbolt.com/acme/app/passwords'], ['Passwords — iCloud', 'https://www.icloud.com/passwords/'], ['Saved Passwords', ''], ['Passwords', ''], ['Password Manager – Google Chrome', '']]) {
    refused(await rd(W('Google Chrome', t, u || null)), `Chrome "${t}" ${u}`);
  }
  refused(await rd(W('Safari', 'Passwords')), 'Safari Passwords window');
  for (const a of ['Elpass', 'SafeInCloud', 'mSecure', 'Minimalist', 'pass', 'Duo Mobile']) refused(await rd(W(a, a)), `app ${a}`);
  for (const [a, t, u] of [['Safari', 'Keeper Review 2026 - PCMag', null], ['Safari', 'Best password managers 2026: Bitwarden, 1Password', null], ['Safari', 'Reset your password · GitHub', 'https://github.com/password_reset'], ['Safari', '1Password pricing', 'https://1password.com/pricing'], ['Notes', 'Passwords', null], ['Obsidian', 'Daily - My Vault - Obsidian v1.7', null]]) {
    ran(await rd(W(a, t, u)), `ordinary window "${t}"`);
  }
});

// ---- medium: connectors: reads never ask; content writes that mention money are no money; real money writes are.
await section('medium: connectors: reads never ask; content writes that mention money are no money; real ', async () => {
  for (const [s, n, a] of [['stripe', 'create_customer', { email: 'a@b.c' }], ['claude_ai_Stripe', 'stripe_api_read', {}], ['claude_ai_Stripe', 'stripe_analytics', {}], ['claude_ai_Stripe', 'send_stripe_feedback', { text: 'hi' }], ['claude_ai_Stripe', 'stripe_implementation_planner', {}], ['gmail', 'create_draft', { body: 'Amount due: $500' }], ['claude_ai_Gmail', 'create_draft', { body: 'Total: $84.20' }], ['claude_ai_Google_Drive', 'create_file', { name: 'orders.csv' }], ['notion', 'create_page', { title: 'Order of operations' }], ['notion', 'update_page', { id: 1, title: 'Q3 budget', amount: 5000, currency: 'USD' }], ['linear', 'create_issue', { title: 'Fix checkout/orders page' }], ['sheets', 'update_cell', { value: '$500' }], ['figma', 'swap_component', {}], ['calendar', 'book_meeting_room', {}], ['hubspot', 'create_deal', { amount: 5000 }], ['coinbase', 'portfolio', {}], ['alpaca', 'positions', {}], ['alpaca', 'account', {}], ['wallet', 'address', {}], ['plaid', 'sync_transactions', {}], ['ynab', 'create_transaction', { amount: -5000, payee: 'Coffee' }]]) {
    assert.equal(moneyCall({ server: s, name: n, args: a }), false, `not money: ${s}.${n}`);
  }
  for (const [s, n, a] of [['gusto', 'run_payroll', {}], ['bill_com', 'approve_and_send', { bill: 7 }], ['adyen', 'capture', { id: 'x' }], ['braintree', 'sale', { value: '10.00' }], ['razorpay', 'capture', { id: 'p', amount: 5000 }], ['evm', 'send_raw', { to: '0xabc' }], ['solana', 'sign_and_send', { tx: 'b' }], ['hyperliquid', 'market_open', { coin: 'ETH', sz: 1 }], ['polymarket', 'place_bet', { shares: 100 }], ['okx', 'open_long', { sz: '1' }], ['doordash', 'submit_cart', {}], ['uber', 'request_ride', { to: 'SFO' }], ['expedia', 'confirm_booking', { hotel: 1 }], ['namecheap', 'register_domain', { domain: 'x.com' }], ['ads', 'increase_budget', { daily_budget: 500 }], ['x', 'execute_sql', { query: 'update accounts set balance = balance - 500 where id = 1' }], ['claude_ai_Higgsfield', 'gpu_job_start', {}], ['mybank', 'send', { to: 'alex', amount: 50 }], ['claude_ai_Stripe', 'stripe_api_write', { path: '/v1/payouts' }]]) {
    assert.equal(moneyCall({ server: s, name: n, args: a }), true, `money: ${s}.${n}`);
  }
});

// ---- high: a relay turn tagged hard "money" makes every ask a money ask, and every Mac tool that acts asks.
await section('high: a relay turn tagged hard "money" makes every ask a money ask, and every Mac tool tha', async () => {
  const res = (status, body) => ({ status, ok: status >= 200 && status < 300, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body ?? null) });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const relayRun = async (extra, fn) => {
    const turn = { id: randomUUID(), claimId: randomUUID(), threadId: randomUUID(), surface: 'phone', context: { path: '/', search: '', scope: 'all' }, history: [], allowedTools: ['mac'], parentTurnId: randomUUID(), input: { text: 'Finish it' }, ...extra };
    const posts = []; let given = false, over = false, money = null;
    const api = { req: async (p, o = {}) => {
      const url = new URL(p, 'https://h.invalid');
      if (url.pathname === '/api/agent/relay/next') { if (given) { await wait(20); return res(204); } given = true; return res(200, { turn }); }
      if (url.pathname === '/api/agent/relay/events') { if ((o.body.events ?? []).some((e) => e.type === 'done' || e.type === 'error')) over = true; return res(200, { ok: true, status: over ? 'done' : 'claimed', inputs: [] }); }
      if (url.pathname === '/api/agent/relay/approval' && o.method === 'POST') { posts.push(o.body); return res(201, { id: randomUUID() }); }
      return res(404, {});
    } };
    const relay = createRelay({ api, log: () => {}, slots: ['a'], minPollMs: 5, waitFor: async () => 'approved', runTurn: async (t, h) => {
      money = h.money;
      const ask = askAsApproval(h.approve);
      const T = createTools({ allowActions: () => true, ui: () => {}, openUrl: async () => {}, onCommitments: async () => {}, showList: async () => {}, fmtWhen: String, commitmentsText: () => '', userName: 'Test', workdir: H, ask });
      T.nextTurn();
      const list = moneyTools(T.tools, { money: h.money, ask, reads: new Set(['read_window', 'take_screenshot', 'read_file']) });
      await fn((n) => list.find((x) => x.name === n)).catch(() => {});
      h.emit({ type: 'text', delta: 'ok' }); h.emit({ type: 'done' });
    } });
    relay.start?.(); const end = Date.now() + 8000; while (!over && Date.now() < end) await wait(10); await relay.stop?.();
    return { posts, money };
  };
  fs.writeFileSync(stState, JSON.stringify({ win: W('Safari', 'Step 3 of 3', 'https://www.acme-outdoor.com/go/3'), controls: [{ id: 1, role: 'button', label: 'Continue' }] }));
  for (const extra of [{ hard: 'money' }, { input: { text: 'Finish it', hard: 'money' } }]) {
    const r = await relayRun(extra, (tool) => tool('act_in_app').execute({ target: 'Safari', steps: [{ do: 'click_text', text: 'Continue' }] }, {}));
    assert.equal(r.money, true);
    assert.ok(r.posts.length >= 1 && r.posts.every((p) => p.hard === 'money' && p.deletion === true && p.danger === true), JSON.stringify(r.posts));
  }
  for (const fn of [(tool) => tool('open').execute({ target: 'https://www.acme-outdoor.com/go?sku=1' }, {}), (tool) => tool('write_file').execute({ path: `${H}/Documents/x.txt`, content: 'hi' }, {}), (tool) => tool('manage_app').execute({ do: 'hide', app: 'Safari' }, {})]) {
    const r = await relayRun({ hard: 'money' }, fn);
    assert.ok(r.posts.length >= 1 && r.posts.every((p) => p.hard === 'money'), `a no-ask tool asks in a money turn: ${JSON.stringify(r.posts)}`);
  }
  const plainTurn = await relayRun({}, (tool) => tool('act_in_app').execute({ target: 'Safari', steps: [{ do: 'click_text', text: 'Continue' }] }, {}));
  assert.ok(plainTurn.posts.every((p) => p.hard === 'none'), 'an untagged turn carries the verdict none (hardTags, web ceecb0e)');
  assert.equal(moneyTurn({ input: { hard: 'money' } }), true);
  assert.equal(moneyTurn({ hard: 'credential' }), false);
});

// ---- high: the VPS brain sends its hard tag on the sub-turn and on connector approvals.
await section('high: the VPS brain sends its hard tag on the sub-turn and on connector approvals', async () => {
  const res = (status, body) => ({ status, ok: status >= 200 && status < 300, headers: new Headers(), json: async () => body });
  const bodies = [];
  const api = { req: async (p, o = {}) => { if (o.method === 'POST') { bodies.push(o.body); return res(403, { error: 'refused' }); } return res(200, { status: 'done', text: 'ok' }); } };
  const t = askMacTool({ api, turn: { id: randomUUID(), claimId: randomUUID() }, pollMs: 1, sleep: async () => {} });
  assert.ok('hard' in t.parameters.shape, 'ask_mac takes hard');
  await t.execute({ instruction: 'Buy the AirPods on Amazon with 1-click', hard: 'money' }, {}).catch(() => {});
  assert.equal(bodies[0].hard, 'money', 'the sub-turn POST carries hard');
  assert.ok(relaySubturnSchema.safeParse(bodies[0]).success === false || relaySubturnSchema.shape.hard, 'the web schema has the field');
  const sent = [];
  const gate = brainGate({ approve: async (b) => { sent.push(b); return 'declined'; } });
  assert.equal(await gate('mcp__claude_ai_Gmail__send_message', { to: 'a@b.c', subject: 'Card', body: 'It is 4242 4242 4242 4242' }), false);
  assert.deepEqual(sent, [], 'a card in a connector call never reaches approval');
  assert.equal(relaySubturnSchema.shape.hard.safeParse('money').success, true);
  assert.equal(relayApprovalSchema.shape.hard.safeParse('credential').success, true);
});

fs.rmSync(tmp, { recursive: true, force: true });
assert.deepEqual(failed, [], `failing: ${failed.join('; ')}`);
console.log('hard limits round 3 (A3 desktop, round-2 findings): passed');
