// The owner's hard limits, round 6 (A3 desktop, the round-5 review's findings, each in the shape it was found), with
// Approve all ON unless said:
// 1. typing a password, credential, key or card number into any field, and reading a password manager's or a secret
//    file's window: refused, never asked, whatever the owner says;
// 2. paying, buying, ordering, subscribing, transferring money or trading: always asked.
// Everything else runs unasked under Approve all (deletes too): the false asks and false refusals found are here too.
// Nothing here reaches the Mac: the hands helper is a stub that reads main.swift's own patterns (as round 5's, with the
// helper's full line-break set: \n, \r, U+0003, U+0085, U+2028, U+2029); the system commands are stubs on PATH (open
// fails).
import { credentialFixture } from './fixtures/credential-fixtures.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hardlimits6-'));
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
const P = { RISKY: pat('RISKY'), MONEY: pat('MONEY'), AMBIG: pat('AMBIG'), CRED: pat('CRED_FIELD'), REVEAL: pat('REVEAL'), PROMPT: pat('PROMPT'), SIGNIN: pat('SIGNIN'),
  optTypes: /flags\.isDisjoint\(with: \[\.maskCommand, \.maskControl\]\)/.test(SWIFT) };
const stub = path.join(tmp, 'hands.mjs'), stState = path.join(tmp, 'st.json'), stLog = path.join(tmp, 'log.jsonl');
fs.writeFileSync(stub, `import fs from 'node:fs';
const P = ${JSON.stringify(P)};
const rx = (p) => (p ? new RegExp(p, 'iu') : null);
const RISKY = rx(P.RISKY), MONEY = rx(P.MONEY), AMBIG = rx(P.AMBIG), CRED = rx(P.CRED), REVEAL = rx(P.REVEAL), PROMPT = rx(P.PROMPT), SIGNIN = rx(P.SIGNIN);
const parts = (s) => String(s).split(' | ').map((x) => x.trim()).filter(Boolean);
const forms = (s) => { let l = String(s).normalize('NFKC').toLowerCase().replace(/\\s+/g, ' ').trim().replace(/^[^\\p{L}\\p{N}$€£¥]+|[^\\p{L}\\p{M}\\p{N}$€£¥%)]+$/gu, ''); const f = l.normalize('NFD').replace(/\\p{M}/gu, '').normalize('NFC'); return f === l ? [l] : [l, f]; };
const any = (s, f) => parts(s).some((p) => forms(p).some(f));
const moneyWord = (s) => any(s, (x) => x && x.split(' ').length <= 6 && MONEY.test(x));
const ambiguous = (s) => any(s, (x) => AMBIG.test(x) && x.split(' ').length <= 5);
const reveal = (s) => !!REVEAL && any(s, (x) => REVEAL.test(x));
const credLabel = (s) => { const r = String(s ?? '').normalize('NFKC').toLowerCase().replace(/\\s+/g, ' ').trim(); if (!r) return false; const f = r.normalize('NFD').replace(/\\p{M}/gu, '').normalize('NFC'); return CRED.test(r) || CRED.test(f); };
const passwordLike = (t0) => { const t = String(t0).trim(); return /^\\S{6,64}$/.test(t) && /\\p{L}/u.test(t) && /[\\d\\W_]/.test(t) && !/^[^@\\s]+@[^@\\s]+\\.[a-z]{2,}$/i.test(t) && !/^([a-z][a-z0-9+.-]*:|www\\.|[~/.])/i.test(t) && !/^[\\w-]+\\.(com|org|net|io|dev|app|co|ai)(\\/\\S*)?$/i.test(t); };
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
  const isField = (c) => !!c && /field|text|area|combo|search/.test(c.role);
  const isCred = (c) => !!c && (c.role === 'password field' || c.secure === true || credLabel(c.label) || credLabel(c.placeholder));
  const pageCred = () => controls.some(isCred);
  const signin = !!SIGNIN && forms(w.title ?? '').some((x) => SIGNIN.test(x));
  const keyTypes = (k) => { const m = k.split('+').slice(0, -1), key = k.split('+').at(-1); if (key === 'v' && m.includes('cmd')) return true; if (m.some((x) => ['cmd', 'ctrl', 'control', 'command'].includes(x))) return false; if (!P.optTypes && m.some((x) => ['opt', 'alt', 'option'].includes(x))) return false; return key.length === 1 || key === 'space'; };
  let focus = controls.find((c) => c.focused) ?? null, clickedSpot = false;
  const done = [];
  for (const [i, x] of plan.steps.entries()) {
    const yes = (l) => x.confirmed && String(x.confirmedLabel ?? '').toLowerCase().trim() === String(l).toLowerCase().trim();
    const refuse = () => out({ ok: false, error: 'Blocked for safety: step ' + (i + 1) + ' types into a field that takes a password (helper).', refused: 'credential', done });
    const stop = (l, why) => out({ ok: false, needsConfirm: true, step: i, label: l, why: why ?? 'Click "' + l + '" in ' + w.app + '?', done });
    const ret = () => { const needs = []; if (s.returnPresses && stopsAt(s.returnPresses)) needs.push(s.returnPresses); if (s.webForm && isField(focus) && !isCred(focus)) needs.push('send'); const both = needs.join(' + '); if (needs.length && !yes(both)) stop(both, 'Return would press "' + both + '" in ' + w.app + '.'); };
    let l = '';
    if (x.do === 'click' || x.do === 'focus') { const c = controls.find((c) => c.id === x.id); l = c?.label ?? ''; focus = isField(c) ? c : (s.clickReveals ?? null); }
    if (x.do === 'click_text') { l = x.text; const c = controls.find((c) => c.label === x.text); focus = isField(c) ? c : null; }
    if (x.do === 'click_at') { l = s.under ?? ''; focus = s.atFocus ?? null; clickedSpot = true; }
    if (x.do === 'choose') l = x.option;
    if (l && reveal(l)) out({ ok: false, error: 'Blocked for safety: step ' + (i + 1) + ' clicks a reveal (helper).', refused: 'credential', done });
    if (['click', 'click_text', 'click_at', 'choose'].includes(x.do) && l && stopsAt(l) && !yes(l)) stop(l);
    if (x.do === 'fill') { const c = controls.find((c) => c.label === x.field || c.placeholder === x.field); if (isCred(c) || credLabel(x.field)) refuse(); focus = c ?? focus; if (/[\\n\\r\\u0003\\u0085\\u2028\\u2029]/.test(x.text ?? '')) ret(); }
    if (x.do === 'type') {
      const editable = isField(focus);
      if (!editable && !clickedSpot) out({ ok: false, error: 'Step ' + (i + 1) + ': the cursor is not in a text field.', done });
      if (prompt(w.app, focus?.value)) refuse();
      if (isCred(focus) || (!editable && (pageCred() || (signin && passwordLike(x.text))))) refuse();
      if (/[\\n\\r\\u0003\\u0085\\u2028\\u2029]/.test(x.text ?? '')) ret();
    }
    if (x.do === 'key') {
      const k = String(x.key).toLowerCase();
      if (keyTypes(k) && (isCred(focus) || prompt(w.app, focus?.value) || (!isField(focus) && pageCred()))) refuse();
      if (/^(return|enter)$/.test(k)) { if (focus && /button/.test(focus.role) && stopsAt(focus.label) && !yes(focus.label)) stop(focus.label); ret(); }
    }
    done.push(x.do + (x.text ? ':' + x.text : '') + (x.key ? ':' + x.key : ''));
  }
  out({ ok: true, done, window: s.after ?? w, controls: s.afterControls, texts: s.afterTexts });
}
if (a[0] === 'manage') out({ ok: true, done: 'done' });
if (a[0] === 'windows') out({ ok: true, windows: [w], all: true });
out({ ok: true });
`);
process.env.ROAMIES_HANDS = stub;

const safety = await import('../safety.mjs');
const core = await import('../hardlimits-core.mjs');
const { approveAllSays, credentialArgs, moneyCall, checkWindow, checkRead } = safety;
const { createTools } = await import('../tools.mjs');
const { askAsApproval } = await import('../relay.mjs');
const { askMacTool } = await import('../brain-server.mjs');

const failed = [];
const section = async (name, fn) => { try { await fn(); console.log(`  ok   ${name}`); } catch (e) { failed.push(name); console.log(`  FAIL ${name}: ${String(e.message).replace(/\n/g, " ").slice(0, 900)}`); } };
const run = async (state, fn, { owner = () => null, approveAll = true, ask: ask0 = null, remote = false } = {}) => {
  fs.writeFileSync(stState, JSON.stringify(state)); fs.writeFileSync(stLog, ''); fs.writeFileSync(clip, state.clip ?? '');
  const asks = [];
  const ask = ask0 ?? (async (o) => { const auto = approveAllSays(approveAll, o); asks.push({ auto, pay: !!o.pay, q: String(o.placeholder ?? '').split('\n')[0] }); return auto ? 'yes' : owner(o); });
  const tools = createTools({ allowActions: () => true, ui: () => {}, openUrl: async () => {}, onCommitments: async () => {}, showList: async () => {}, fmtWhen: String, commitmentsText: () => '', userName: 'Test', workdir: tmp, ask, remote: () => remote });
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
const show = (x) => `${x.r.slice(0, 140)} asks=${JSON.stringify(x.asks).slice(0, 200)}`;
const refused = (x, why) => { assert.match(x.r, /^ERR Blocked for safety/, `${why}: ${show(x)}`); };
const asked = (x, why) => assert.ok(x.asks.some((a) => !a.auto), `${why}: a hard ask (${show(x)})`);
const ran = (x, why) => { assert.ok(!x.asks.some((a) => !a.auto), `${why}: no ask the owner must answer (${show(x)})`); assert.doesNotMatch(x.r, /^ERR/, `${why}: ${x.r}`); };
// Every case in a section is tried, and all the misses are said at once.
const each = async (cases, f) => { const bad = []; for (const c of cases) { try { await f(c); } catch (e) { bad.push(String(e.message).split('\n')[0].slice(0, 120)); } } assert.deepEqual(bad, [], `${bad.length} of ${cases.length}: ${bad.slice(0, 6).join(' || ')}`); };

const plain = W('Safari', 'Example Shop', 'https://www.example-shop.com/');
const checkout = W('Safari', 'Checkout - Example Shop', 'https://www.example-shop.com/checkout');
const cb = W('Coinbase', 'Coinbase'), mm = W('MetaMask', 'MetaMask');
const hl = W('Google Chrome', 'Hyperliquid', 'https://app.hyperliquid.xyz/trade');
const binance = W('Google Chrome', 'BTCUSDT Perpetual | Binance Futures', 'https://www.binance.com/en/futures/BTCUSDT');
const gusto = W('Safari', 'Run payroll | Gusto', 'https://app.gusto.com/payrolls/123/review');
const stripeDash = W('Safari', 'Payments – Stripe', 'https://dashboard.stripe.com/payments/pi_123');
const godaddy = W('Safari', 'My Products | GoDaddy', 'https://account.godaddy.com/products');
const vercel = W('Safari', 'Billing – Vercel', 'https://vercel.com/acme/~/settings/billing');
const amazon = W('Safari', 'Amazon.com: Dune: Part Two', 'https://www.amazon.com/Dune-Part-Two/dp/B0CW1Y9ZKN');
const yt = W('Safari', 'Some Channel - YouTube', 'https://www.youtube.com/@somechannel');
const flip = W('Safari', 'Flipkart', 'https://www.flipkart.com/viewcheckout');


// ---- high (1): a relay turn's ordinary asks are no credential and no money to the server's words.
// The fake server is the approval route at ceecb0e: hardMatch on the summary (credential: 403 refused), Approve all only
// for a plain ask (no match, hard none, deletion false, danger false).
const { relayWords } = await import('../relay.mjs');
const server = (sent) => async (b) => { const m = core.hardMatch(b.hard === 'none' ? null : b.hard, b.summary); sent.push({ ...b, match: m }); if (m?.kind === 'credential') return 'refused'; return !m && b.hard === 'none' && !b.deletion && !b.danger ? 'approved' : 'declined'; };
const relayed = async (state, fn) => { const sent = []; const x = await run(state, fn, { ask: askAsApproval(server(sent)), remote: true }); return { ...x, sent }; };
const R = (x) => `${x.r.slice(0, 100)} sent=${JSON.stringify(x.sent.map((b) => [b.summary.slice(0, 90), b.hard, b.deletion, b.danger, b.match]))}`;
await section('high: relay reads, screenshots and nav clicks are auto-approved, never refused', async () => {
  const gh = W('Safari', 'acme/app', 'https://github.com/acme/app'), news = W('Safari', 'News', 'https://www.bbc.com/news');
  await each([
    ['read_window Safari', { win: gh }, (T) => T('read_window').execute({ target: 'Safari' }, {})],
    ['read_window Notes', { win: W('Notes', 'Groceries') }, (T) => T('read_window').execute({ target: 'Notes' }, {})],
    ['read_window Mail', { win: W('Mail', 'Inbox') }, (T) => T('read_window').execute({ target: 'Mail' }, {})],
    ['take_screenshot Safari', { win: news }, (T) => T('take_screenshot').execute({ target: 'Safari' }, {})],
    ['act_in_app scroll', { win: news }, A([{ do: 'scroll', direction: 'down', amount: 3 }])],
    ...[[W('Safari', 'Home – Stripe', 'https://dashboard.stripe.com/'), 'Payments'], [W('Safari', 'Gusto', 'https://app.gusto.com/'), 'Payroll'],
      [W('Safari', 'Shopify', 'https://admin.shopify.com/store/acme'), 'Refunds'], [W('Safari', 'Shopify', 'https://admin.shopify.com/store/acme'), 'Orders'],
      [W('Safari', 'Your Account', 'https://www.amazon.com/your-account'), 'Payment methods'], [W('Safari', 'Your Account', 'https://www.amazon.com/your-account'), 'Your Payments'],
      [W('Safari', 'Overview – Vercel', 'https://vercel.com/acme'), 'Billing'], [W('Safari', 'Hydra', 'https://hydra-olive-one.vercel.app/'), 'Transactions']]
      .map(([win, l]) => [`${win.url} click "${l}"`, { win, controls: [{ id: 1, role: 'button', label: l }] }, A([{ do: 'click_text', text: l }])]),
  ], async ([n, state, fn]) => {
    const x = await relayed(state, fn);
    assert.ok(x.sent.length && x.sent.every((b) => !b.match && !b.danger && b.hard === 'none'), `${n}: ${R(x)}`);
    assert.doesNotMatch(x.r, /^ERR/, `${n}: ${R(x)}`);
  });
  // Risky clicks (a deletion, a send) wait as deletions, never as money.
  await each([[W('Mail', 'Inbox'), 'Delete'], [W('Messages', 'Sam'), 'Send'], [W('Safari', 'Home - YouTube', 'https://www.youtube.com/'), 'Short'],
    [W('Safari', 'acme/app · Settings', 'https://github.com/acme/app/settings'), 'Transfer'], [W('Safari', 'Acme Store', 'https://store.acme.com/'), 'Refund policy']], async ([win, l]) => {
    const x = await relayed({ win, controls: [{ id: 1, role: 'button', label: l }] }, A([{ do: 'click_text', text: l }], win.app));
    assert.ok(x.sent.length && x.sent.every((b) => !b.match && b.hard === 'none'), `${win.app} "${l}": ${R(x)}`);
  });
  // A money label the Mac's money words flag keeps its click word, and the server still sees it.
  const x = await relayed({ win: W('Safari', 'Acme', 'https://www.acme.com/'), controls: [{ id: 1, role: 'button', label: 'Pay now' }] }, A([{ do: 'click_text', text: 'Pay now' }]));
  assert.ok(x.sent.some((b) => b.match?.kind === 'money' && /click "Pay now"/.test(b.summary)), R(x));
});
await section('high: every Mac question template carries no credential or money word to the server', async () => {
  const L = ['Delete', 'Archive', 'Send', 'Sign out', 'Payments', 'Refund policy', 'Orders', 'Billing', 'Transfer', 'Short'];
  const templates = [];
  for (const l of L) templates.push(
    `In Safari, every step I'd take:\n1. click ${JSON.stringify(l)}\n\n${JSON.stringify(l)} could delete, send, quit or sign out.`,
    `In Safari, every step I'd take:\n1. click control 3 (${JSON.stringify(l)})`,
    `In Safari, every step I'd take:\n1. choose ${JSON.stringify(l)} in "Menu"`,
    `Click ${JSON.stringify(l)} in Safari? It could delete, send, quit or sign out. Go ahead?`,
    `Choose ${JSON.stringify(l)} in Safari? It could delete, send, quit or sign out. Go ahead?`,
    `That spot is ${JSON.stringify(l)} in Safari: it could delete, send, quit or sign out. Go ahead?`);
  templates.push('That step could delete, send or quit. Go ahead?', "Open Notes? It isn't open, and the steps run in it.",
    'Change ~/Documents/notes.txt in TextEdit? What I type or save there goes into that file.',
    'In Terminal, every step I\'d take:\n1. press cmd+v, pasting what is on the clipboard (I can\'t read it)\n\nStep 1 pastes what is on the clipboard, which I can\'t read.');
  // The read and screenshot asks, built by checkWindow itself.
  for (const w of [W('Safari', 'Reset your password · GitHub', 'https://github.com/password_reset'), W('Notes', 'Groceries'), W('Mail', 'Inbox'), W('Terminal', 'zsh'), W('Preview', 'Invoice.pdf', null, '/Users/x/Invoice.pdf')]) {
    const v = checkWindow(w, H, { viewers: false }); if (v.reason) templates.push(v.reason);
  }
  const bad = templates.map((t) => [t, core.hardMatch(null, relayWords(t))]).filter(([, m]) => m);
  assert.deepEqual(bad.map(([t, m]) => `${m.kind}:${m.phrase} <- ${t.slice(0, 80)}`), []);
});

// ---- high (2): money buttons in many languages, payouts, rides, pledges, bids and offers ask; the helper stops at them.
await section('high: pay, order and transfer buttons in many languages, payouts, rides, pledges and bids ask under Approve all', async () => {
  const shop = (host) => W('Safari', 'Shop', `https://${host}/product/1`);
  const cases = [
    ['www.magazin.ru', ['Оплатить заказ', 'Купить сейчас', 'Перевести деньги']], ['www.sklep.pl', ['Zapłać teraz', 'Kupuję i płacę', 'Zamawiam i płacę', 'Wykonaj przelew']],
    ['www.example-shop.de', ['Zahlung bestätigen', 'Überweisung ausführen', 'Jetzt überweisen', 'Auftrag freigeben']], ['www.boutique.fr', ['Confirmer le paiement', 'Effectuer le virement']],
    ['www.tienda.es', ['Hacer transferencia']], ['www.loja.com.br', ['Fazer Pix', 'Transferir agora']], ['www.negozio.it', ['Effettua bonifico']], ['www.winkel.nl', ['Bestelling plaatsen', 'Overboeken']],
    ['www.shop.com.tr', ['Ödemeyi tamamla', 'Siparişi onayla', 'Para gönder']], ['www.shop.sa', ['إتمام الشراء', 'تأكيد الطلب', 'تحويل الأموال']], ['www.shop.in', ['ऑर्डर करें']],
    ['www.shop.vn', ['Đặt hàng', 'Chuyển tiền']], ['www.toko.co.id', ['Buat pesanan']], ['www.shop.co.th', ['สั่งซื้อ', 'โอนเงิน']], ['www.shop.co.il', ['קנה עכשיו', 'בצע הזמנה', 'העבר כסף']],
    ['www.taobao.com', ['马上抢', '立即转账']], ['www.rakuten.co.jp', ['振込']], ['m.uber.com', ['Request UberX', 'Confirm UberX']], ['ride.lyft.com', ['Request Lyft', 'Request ride']],
    ['www.kickstarter.com', ['Pledge', 'Pledge $25', 'Back this project']], ['www.ebay.com', ['Submit bid', 'Confirm bid', 'Make offer']],
  ].flatMap(([host, ls]) => ls.map((l) => [shop(host), l]));
  cases.push(...['Create payout', 'Instant payout'].map((l) => [W('Safari', 'Balances – Stripe', 'https://dashboard.stripe.com/balance'), l]),
    ...['Approve USDC', 'Wrap'].map((l) => [W('Safari', 'Uniswap', 'https://app.uniswap.org/swap'), l]), [W('Safari', 'OpenSea', 'https://opensea.io/assets/1'), 'Make offer']);
  await each(cases, async ([win, l]) => asked(await run({ win, controls: [{ id: 1, role: 'button', label: l }] }, A([{ do: 'click_text', text: l }])), `${win.url} "${l}"`));
  // By a spot: the helper stops at the label, and the sidecar asks with it.
  await each([['m.uber.com', 'Request UberX'], ['dashboard.stripe.com', 'Create payout'], ['www.example-shop.de', 'Zahlung bestätigen'], ['www.kickstarter.com', 'Pledge $25'], ['www.sklep.pl', 'Kupuję i płacę']],
    async ([host, l]) => asked(await run({ win: shop(host), controls: [{ id: 1, role: 'button', label: l }], under: `${l} | ${l}` }, SA([{ do: 'click_at', x: 400, y: 300 }])), `click_at "${l}"`));
});

// ---- medium (7): labels that move no money run unasked; (8) a slug word makes no money page.
await section('medium: transfer, renew, refund, withdraw, swap and order-view labels that move no money run unasked', async () => {
  await each([[W('Safari', 'acme/app · Settings', 'https://github.com/acme/app/settings'), 'Transfer repository'], [W('Safari', 'Issue #4 · acme/app', 'https://github.com/acme/app/issues/4'), 'Transfer issue'],
    [W('Safari', 'Settings – Vercel', 'https://vercel.com/acme/app/settings'), 'Transfer project'], [W('Safari', 'Board | Trello', 'https://trello.com/b/1'), 'Transfer board'],
    [W('zoom.us', 'Zoom Meeting'), 'Transfer call'], [W('Safari', 'Inbox | Intercom', 'https://app.intercom.com/a/inbox'), 'Transfer chat'], [W('Contacts', 'All Contacts'), 'Transfer contacts'],
    [W('System Settings', 'Network'), 'Renew DHCP Lease'], [W('Safari', 'Certificates', 'https://certs.acme.com/'), 'Renew certificate'], [W('Safari', 'Acme Store', 'https://store.acme.com/'), 'Refund policy'],
    [W('Safari', 'Acme Store', 'https://store.acme.com/'), 'Return & refund policy'], [W('Safari', 'News', 'https://news.acme.com/'), 'Withdraw consent'], [W('System Settings', 'Displays'), 'Swap screens'],
    [W('Logic Pro', 'Song'), 'Swap audio channels'], [W('Safari', 'Meine Bestellungen', 'https://www.amazon.de/gp/css/order-history'), 'Bestellung ansehen'],
    [W('Safari', 'Meine Bestellungen', 'https://www.amazon.de/gp/css/order-history'), 'Bestellung verfolgen'], [W('Safari', 'Vos commandes', 'https://www.amazon.fr/gp/css/order-history'), 'Suivre ma commande'],
    [W('Safari', 'Vos commandes', 'https://www.amazon.fr/gp/css/order-history'), 'Détails de la commande'], [W('Safari', 'Mis pedidos', 'https://www.amazon.es/gp/css/order-history'), 'Ver detalles del pedido'],
    [W('Safari', 'I miei ordini', 'https://www.amazon.it/gp/css/order-history'), 'Dettagli ordine'], [W('Safari', 'Mon compte', 'https://www.boutique.fr/compte'), "Historique d'achat"],
    [W('Safari', 'Meus pedidos', 'https://www.loja.com.br/conta'), 'Acompanhar pedido']],
  async ([win, l]) => ran(await run({ win, controls: [{ id: 1, role: 'button', label: l }] }, A([{ do: 'click_text', text: l }], win.app)), `${win.app} "${l}"`));
  // A family word with a money object still pays anywhere.
  await each(['Transfer funds now', 'Renew now', 'Withdraw $500', 'Sell all shares', 'Refund $20'], async (l) => asked(await run({ win: W('Safari', 'Acme', 'https://www.acme.com/'), controls: [{ id: 1, role: 'button', label: l }] }, A([{ do: 'click_text', text: l }])), l));
});
await section('medium: an article whose slug says pay, buy or cart is no money page', async () => {
  await each([['https://www.nerdwallet.com/article/finance/how-to-pay-off-credit-card-debt', ['Subscribe', 'Submit']], ['https://www.theverge.com/23/best-laptops-to-buy-right-now', ['Send', 'Continue']],
    ['https://acme.com/posts/why-we-killed-the-cart-page', ['Submit']]], async ([url, ls]) => {
    for (const l of ls) ran(await run({ win: W('Safari', 'Article', url), controls: [{ id: 1, role: 'button', label: l }] }, A([{ do: 'click_text', text: l }])), `${url} "${l}"`);
  });
  for (const u of ['https://shop.com/checkout', 'https://www.flipkart.com/viewcheckout', 'https://x.com/confirm_order.htm', 'https://x.com/cart/step-2', 'https://x.com/en/buy-now']) assert.ok(core.moneySurface({ app: 'Safari', url: u }), u);
});

// ---- high (3): a card or a seed typed in pieces is refused, whatever came between the pieces.
await section('high: a card in four boxes or pieces is refused, with clicks, hovers, scrolls, waits, keys or calls between', async () => {
  const shop = W('Safari', 'Payment details', 'https://pay.example-shop.com/details');
  const box = (id, label = '') => ({ id, role: 'text field', label });
  const boxes = [box(1, 'Name on card'), box(2), box(3), box(4), box(5), { id: 6, role: 'button', label: 'Save card' }];
  const notes = [box(1, 'Notes')];
  const fills = (between) => [2, 3, 4, 5].flatMap((id, k) => [...(k && between ? [between] : []), { do: 'fill', id, text: '4242' }]);
  await each([
    ['click_at + type each', { win: shop, controls: boxes, atFocus: box(2) }, SA([0, 1, 2, 3].flatMap((k) => [{ do: 'click_at', x: 100 + 60 * k, y: 200 }, { do: 'type', text: '4242' }]))],
    ['fill with hover between', { win: shop, controls: boxes }, async (T) => { await T('take_screenshot').execute({ target: 'Safari' }, {}); return RA(fills({ do: 'hover', x: 10, y: 10 }))(T); }],
    ['fill with scroll between', { win: shop, controls: boxes }, RA(fills({ do: 'scroll', direction: 'down', amount: 1 }))],
    ['fill with wait between', { win: shop, controls: boxes }, RA(fills({ do: 'wait', seconds: 1 }))],
    ['fill with a right arrow between', { win: shop, controls: boxes }, RA(fills({ do: 'key', key: 'right' }))],
    ['fill "Notes" 4242 4242, space, type 4242 4242', { win: shop, controls: notes }, RA([{ do: 'fill', field: 'Notes', text: '4242 4242' }, { do: 'key', key: 'space' }, { do: 'type', text: '4242 4242' }])],
    ['fill "Notes" three groups, space, keys 4 2 4 2', { win: shop, controls: notes }, RA([{ do: 'fill', field: 'Notes', text: '4242 4242 4242' }, { do: 'key', key: 'space' }, ...'4242'.split('').map((key) => ({ do: 'key', key }))])],
    ['a seed: fill 6 words, space, type 6 words', { win: W('Notes', 'Notes'), controls: notes }, RA([{ do: 'fill', field: 'Notes', text: 'abandon ability able about above absent' }, { do: 'key', key: 'space' }, { do: 'type', text: 'absorb abstract absurd abuse access accident' }], 'Notes')],
  ], async ([n, state, fn]) => { const x = await run(state, fn); refused(x, n); assert.ok(!x.acts.some((p) => p.steps.filter((s) => /4242/.test(s.text ?? '')).length >= 4), `${n}: no act typed four groups`); });
  // Four act_in_app calls, one box each: the fourth is refused.
  {
    fs.writeFileSync(stState, JSON.stringify({ win: shop, controls: boxes })); fs.writeFileSync(stLog, '');
    const tools = createTools({ allowActions: () => true, ui: () => {}, openUrl: async () => {}, onCommitments: async () => {}, showList: async () => {}, fmtWhen: String, commitmentsText: () => '', userName: 'Test', workdir: tmp, ask: async () => 'yes' });
    const act = tools.tools.find((x) => x.name === 'act_in_app');
    await tools.tools.find((x) => x.name === 'read_window').execute({ target: 'Safari' }, {});
    const out = [];
    for (const id of [2, 3, 4, 5]) out.push(await act.execute({ target: 'Safari', steps: [{ do: 'fill', id, text: '4242' }] }, {}).then(String, (e) => `ERR ${e.message}`));
    assert.match(out[3], /^ERR Blocked for safety/, `the fourth box: ${out.join(' / ')}`);
  }
  // Not a card: an address and a phone in two fields, a date and a time, four sheet cells.
  await each([['address + zip', RA([{ do: 'fill', field: 'Street', text: '4242 Main St' }, { do: 'fill', field: 'Zip', text: '94110' }]), [box(1, 'Street'), box(2, 'Zip')]],
    ['phone + time', RA([{ do: 'fill', field: 'Phone', text: '415 555 0142' }, { do: 'fill', field: 'Time', text: '10:30' }]), [box(1, 'Phone'), box(2, 'Time')]],
    ['sheet cells', RA(['A1', 'B1', 'C1', 'D1'].map((field) => ({ do: 'fill', field, text: '4242' })), 'Numbers'), ['A1', 'B1', 'C1', 'D1'].map((l, k) => box(k + 1, l))]],
  async ([n, fn, controls]) => ran(await run({ win: n === 'sheet cells' ? W('Numbers', 'Budget') : shop, controls }, fn), n));
});

// ---- medium (4): OTP, CVV, PIN and password labels; (5) terminal prompts for MFA codes and tokens.
await section('medium: one-time code, CVV, PIN and password field labels in more languages are refused', async () => {
  const L = ['Two-factor code', 'Card code', 'CID', 'PIN-Code', 'Code PIN', 'Código PIN', 'Mã PIN', 'رمز التحقق', 'Cod de verificare', 'Bevestigingscode', 'Код підтвердження', 'Kod potwierdzający',
    'Ellenőrző kód', 'קוד אימות', 'सत्यापन कोड', 'รหัสยืนยัน', 'Κωδικός επαλήθευσης', 'Kod pengesahan', 'Prüfziffer', 'Sandi', 'Kode sandi', 'Κωδικός', 'Şifrə', 'Contrasinal', 'Introduceți parola',
    'Nenosiri', 'Cyfrinair', 'Գաղտնաբառ', 'პაროლი', 'கடவுச்சொல்'];
  await each(L, async (l) => refused(await run({ win: W('Safari', 'Account', 'https://www.example.com/account'), controls: [{ id: 1, role: 'text field', label: l }] }, A([{ do: 'fill', field: l, text: /code|kod|kód|ziffer|cid|pin|رمز|קוד|कोड|รหัส|Κωδικός επ/i.test(l) ? '483920' : 'hunter22' }])), l));
  await each(['PIN code (postal)', 'Pin title', 'Pin to top', 'Coupon code', 'Country code', 'Zip code', 'Parola chiave', 'Promo code'], async (l) => assert.equal(core.credentialLabel(l), false, l));
});
await section('medium: a terminal asking for an MFA or 2FA code, a token or an API key is a credential prompt', async () => {
  await each(['Enter MFA code for arn:aws:iam::123456789012:mfa/fixtureuser:', 'Enter your 2FA code:', 'Authenticator code:', 'Two-factor authentication code:', '? Paste your authentication token:', 'Enter your API key:', 'Token:', 'Enter TOTP:'],
    async (p) => refused(await run({ win: W('Terminal', 'fixtureuser — zsh'), controls: [{ id: 1, role: 'text area', label: 'shell', focused: true, value: `fixtureuser@mac ~ % aws s3 ls\n${p}` }] }, A([{ do: 'type', text: '483920\n' }], 'Terminal')), p));
  ran(await run({ win: W('Terminal', 'fixtureuser — zsh'), controls: [{ id: 1, role: 'text area', label: 'shell', focused: true, value: 'Building token parser...\neason@mac ~ % ' }] }, A([{ do: 'type', text: 'ls\n' }], 'Terminal')), 'an ordinary prompt');
});

// ---- medium (6): a Unicode line break submits a money form.
await section('medium: a Unicode line break in a money form asks as money', async () => {
  const chase = W('Safari', 'Chase', 'https://secure.chase.com/web/auth/dashboard#/payBills'), wise = W('Safari', 'Wise', 'https://wise.com/send');
  await each([' ', ' ', '\u0085', '\u0003', '\n'], async (ch) => {
    const a1 = await run({ win: chase, controls: [{ id: 1, role: 'text field', label: 'Amount' }], webForm: true }, RA([{ do: 'fill', field: 'Amount', text: `120${ch}` }]));
    assert.ok(a1.asks.some((a) => a.pay && !a.auto), `Chase fill U+${ch.codePointAt(0).toString(16)}: ${show(a1)}`);
    const a2 = await run({ win: wise, controls: [{ id: 1, role: 'text field', label: 'You send', focused: true }], webForm: true }, RA([{ do: 'type', text: `500${ch}` }]));
    assert.ok(a2.asks.some((a) => a.pay && !a.auto), `Wise type U+${ch.codePointAt(0).toString(16)}: ${show(a2)}`);
  });
});

// ---- medium (9): ordinary pastes run.
await section('medium: a one-word paste that is a file or product name runs; a pasted password on a sign-in page is refused', async () => {
  const slack = W('Slack', 'general (Channel) - Acme - Slack'), box = [{ id: 1, role: 'text area', label: 'Message #general', focused: true }];
  await each(['Invoice_2026-11.pdf', 'iPhone15Pro', 'Q3-Report', '#ShipIt2026'], async (clip) => ran(await run({ win: slack, controls: box, clip }, A([{ do: 'key', key: 'cmd+v' }], 'Slack')), clip));
  refused(await run({ win: W('Safari', 'Sign in – Acme', 'https://acme.com/login'), controls: [{ id: 1, role: 'text field', label: 'Username', focused: true }], clip: 'Tr0ub4dor&3' }, A([{ do: 'key', key: 'cmd+v' }])), 'a pasted password on a sign-in page');
});

// ---- medium (10): a password said in a message; (15) more key shapes.
await section('medium: a password or a code inside a typed message, and more key shapes, are refused', async () => {
  const slack = W('Slack', 'general (Channel) - Acme - Slack'), box = [{ id: 1, role: 'text area', label: 'Message #general' }];
  await each(['my Netflix password is Tr0ub4dor&3', 'wifi: CoffeeShop / pw: Hunter2!2026', 'login fixtureuser@example.test pass Hunter2!x', 'The 2FA backup code is 8273-1928'],
    async (text) => refused(await run({ win: slack, controls: box }, A([{ do: 'fill', field: 'Message #general', text }], 'Slack')), text));
  assert.ok(credentialArgs({ body: 'my password is Tr0ub4dor&3' }), 'a connector body with a password');
  await each(['the password is required', 'pass the salt please', 'error code is 404', 'pass Q3-Report to Sam', 'Your password must be 8+ characters'],
    async (text) => ran(await run({ win: slack, controls: box }, A([{ do: 'fill', field: 'Message #general', text }], 'Slack')), text));
  const env = [{ id: 1, role: 'text field', label: 'Name' }, { id: 2, role: 'text field', label: 'Value' }];
  await each(['A3-ASWWYB-798JRY-LJVD4-23DC2-86TVM-H43EB', credentialFixture('dckr_pat_', 16), credentialFixture('nfp_', 16), credentialFixture('rnd_', 16), credentialFixture('sq0atp-', 16), 'c2a6f3e1b0d94e8f7a6b5c4d3e2f1a0b9c8d7'],
    async (text) => refused(await run({ win: W('Safari', 'Settings', 'https://app.example.com/settings'), controls: env }, A([{ do: 'fill', field: 'Value', text }])), text));
  assert.ok(credentialArgs({ text: 'A3-ASWWYB-798JRY-LJVD4-23DC2-86TVM-H43EB' }), 'a 1Password Secret Key in args');
});

// ---- medium (11): connector money writes; low (17): catalog and app-data writes are no money.
await section('medium: connector writes that move money are hard asks; catalog, content and app-data writes are not', async () => {
  for (const [server, name, args] of [['zapier', 'run_action', { instructions: 'Send $500 to John via PayPal' }], ['starbucks', 'reload_card', { amount: 50 }], ['openai', 'add_credit', { amount: 20 }],
    ['twilio', 'recharge_balance', { amount: 20 }], ['opensea', 'mint_nft', { contract: '0xabc', quantity: 1 }], ['telegram', 'send_stars', { user: 'x', stars: 100 }],
    ['github', 'create_sponsorship', { sponsorable: 'octocat', amount: 5 }], ['apple_pay', 'authorize', { merchant: 'x', total: '9.99' }],
    ['http', 'post', { url: 'https://api-m.paypal.com/v1/payments/payouts', json: { items: [{ amount: { value: '50.00', currency: 'USD' } }] } }]]) assert.equal(moneyCall({ server, name, args }), true, `${server}.${name}`);
  for (const [server, name, args] of [['stripe', 'create_payment_link', { price: 'price_1', quantity: 1 }], ['stripe', 'create_price', { product: 'prod_1', unit_amount: 999, currency: 'usd' }],
    ['stripe', 'create_coupon', { percent_off: 20 }], ['stripe', 'update_subscription_metadata', { metadata: { a: 1 } }], ['linear', 'create_issue', { title: 'Payouts broken', description: 'POST /v1/payouts 500' }],
    ['supabase', 'execute_sql', { query: "update orders set status='shipped' where id=1" }], ['stripe', 'list_payouts', {}], ['coinbase', 'get_balance', {}]]) assert.equal(moneyCall({ server, name, args }), false, `${server}.${name}`);
  assert.equal(moneyCall({ server: 'supabase', name: 'execute_sql', args: { query: 'update balances set amount = amount - 50 where id = 1' } }), true, 'SQL on balances');
});

// ---- low (16): credentialArgs.
await section('low: basic auth, user:pass and *_PASS are secrets; public, publishable and site keys and plain words are not', async () => {
  const password = credentialFixture('FixturePassword-', 6);
  for (const a of [{ headers: { Authorization: `Basic ${Buffer.from(`fixtureuser:${password}`).toString('base64')}` } }, { auth: `fixtureuser:${password}` }, { env: [{ name: 'DB_PASS', value: password }] }, { pin: '4821' }, { pass: password }]) assert.equal(credentialArgs(a), true, JSON.stringify(a));
  for (const a of [{ key: 'STRIPE_PUBLISHABLE_KEY', value: credentialFixture('pk_live_', 13) }, { key: 'PUBLIC_KEY', value: credentialFixture('ssh-ed25519 ', 20) + ' fixtureuser@example.test' }, { name: 'TURNSTILE_SITE_KEY', value: credentialFixture('0x', 20) },
    { pin: 'top' }, { pass: 'through' }, { headers: { Authorization: 'none' } }]) assert.equal(credentialArgs(a), false, JSON.stringify(a));
});

// ---- low (18): a key's name only makes the value next to it a secret, by its end.
await section('low: a value after a name with auth, token or key inside it is typed; after API_KEY it is refused', async () => {
  const env = [{ id: 1, role: 'text field', label: 'Key' }, { id: 2, role: 'text field', label: 'Value' }];
  const vercel = W('Safari', 'Environment Variables – Vercel', 'https://vercel.com/acme/app/settings/environment-variables');
  ran(await run({ win: vercel, controls: env }, A([{ do: 'fill', field: 'Key', text: 'GOOGLE_AUTH_REDIRECT' }, { do: 'fill', field: 'Value', text: 'https://app.acme.com/callback' }])), 'GOOGLE_AUTH_REDIRECT');
  ran(await run({ win: W('Google Chrome', 'Sheet1 - Google Sheets', 'https://docs.google.com/spreadsheets/d/1'), controls: [{ id: 1, role: 'text field', label: 'A1' }, { id: 2, role: 'text field', label: 'B1' }] },
    A([{ do: 'fill', field: 'A1', text: 'AUTHOR_NAME' }, { do: 'fill', field: 'B1', text: 'FixtureUser' }], 'Google Chrome')), 'AUTHOR_NAME');
  ran(await run({ win: W('Numbers', 'Usage'), controls: [{ id: 1, role: 'text field', label: 'A1' }, { id: 2, role: 'text field', label: 'B1' }] }, A([{ do: 'fill', field: 'A1', text: 'TOKEN_COUNT' }, { do: 'fill', field: 'B1', text: 'Quarterly' }], 'Numbers')), 'TOKEN_COUNT');
  refused(await run({ win: vercel, controls: env }, A([{ do: 'fill', field: 'Key', text: 'API_KEY' }, { do: 'fill', field: 'Value', text: 'q8Zx2Lm9Pw4Rt7Yv' }])), 'API_KEY');
  refused(await run({ win: vercel, controls: env }, A([{ do: 'fill', field: 'Key', text: 'DB_PASS' }, { do: 'fill', field: 'Value', text: 'Hunter2!2026' }])), 'DB_PASS');
});

// ---- medium (12): reveal and copy-password buttons in other languages; low (13, 14, 21): secret files and vault titles.
await section('medium: localized reveal and copy-password buttons are refused clicks', async () => {
  const chrome = W('Google Chrome', 'Google Passwortmanager');
  await each(['Passwort kopieren', 'Copier le mot de passe', 'Copy one-time password', 'Kennwort kopieren', 'Copiar contraseña', 'Скопировать пароль', '复制密码', 'パスワードをコピー', '비밀번호 복사', 'Passwort anzeigen'],
    async (l) => assert.ok(core.revealLabel(l), l));
  refused(await run({ win: W('Safari', 'Account', 'https://www.example.com/account'), controls: [{ id: 1, role: 'button', label: 'Passwort kopieren' }] }, A([{ do: 'click_text', text: 'Passwort kopieren' }])), 'click Passwort kopieren');
  refused(await run({ win: chrome }, (T) => T('read_window').execute({ target: 'Google Chrome' }, {})), 'a Google Passwortmanager window');
  for (const l of ['Copy code', 'View code', 'Show more']) assert.equal(core.revealLabel(l), false, l);
});
await section('low: localized password files, recovery sheets and a secret-printing CLI are refused windows; keys.txt is not', async () => {
  const doc = (rel) => { const p = path.join(H, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'x'); return p; };
  await each([['Microsoft Excel', 'Documents/Passwörter.xlsx'], ['TextEdit', 'Documents/contraseñas.txt'], ['TextEdit', 'Documents/密码.txt'], ['Preview', 'Documents/Bitcoin wallet recovery sheet.pdf']],
    async ([app, rel]) => { const v = checkWindow(W(app, path.basename(rel), null, doc(rel)), H); assert.ok(v.level === 'block' || v.vault, `${app} ${rel}: ${v.level}`); });
  assert.equal(checkWindow(W('Terminal', 'fixtureuser — op item get GitHub --reveal — 80×24'), H).level, 'block', 'op item get --reveal');
  await each([['TextEdit', 'Documents/keys.txt'], ['TextEdit', 'Documents/Piano keys.txt'], ['TextEdit', 'Documents/tokens.txt']],
    async ([app, rel]) => { const v = checkWindow(W(app, path.basename(rel), null, doc(rel)), H); assert.ok(v.level !== 'block' && !v.vault, `${app} ${rel} stays readable: ${v.level}`); });
});
await section('low: a vault page by its localized title or any part of it, with no address read, is a vault', async () => {
  for (const w of [W('Google Chrome', 'Gestionnaire de mots de passe Google'), W('Safari', 'Passwörter'), W('Firefox', 'Contraseñas'), W('Safari', 'Vaults | Bitwarden Web vault')]) assert.ok(checkWindow(w, H).vault, `${w.app} "${w.title}"`);
  for (const w of [W('Safari', 'Reset your password · GitHub'), W('Safari', 'Obsidian vault - notes'), W('Safari', 'Enable 2FA · Settings')]) assert.ok(!checkWindow(w, H).vault, `${w.app} "${w.title}" is ordinary`);
});

// ---- low (20): the web contract: relayschema.mjs is the web's relay-schema.ts byte for byte (its own sync test).
fs.rmSync(tmp, { recursive: true, force: true });
assert.deepEqual(failed, [], `failing: ${failed.join('; ')}`);
console.log('hard limits round 6 (A3 desktop, round-5 findings): passed');
