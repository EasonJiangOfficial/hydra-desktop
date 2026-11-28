// The owner's hard limits, round 8 (the round-7 regressions):
// 1. Ordinary clicks on a money surface run with no ask: a bank's or a checkout's navigation in a script the word lists
//    barely cover, eBay's messages, Venmo's or PayPal's Request. The unread-script rule holds next to an amount or on a
//    pay step only; eBay is a money surface on an item, bid, offer or checkout; a bare Request pays on a ride page only.
// 2. A terminal's "AWS Access Key ID [None]:", "Token ID:" and "Password expiry (days):" are credential prompts again.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isPayClick } from '../safety.mjs';
import { credentialLabel, moneySurface, passwordPrompt, payStepPage } from '../hardlimits-core.mjs';

const S = new URL('..', import.meta.url).pathname;
const SWIFT = fs.readFileSync(path.join(S, '../src-tauri/hands/main.swift'), 'utf8');
const pat = (name) => new RegExp(SWIFT.match(new RegExp(`^let ${name} = try! NSRegularExpression\\(pattern: #"(.*)"#, options: .*\\)$`, 'm'))[1], 'iu');
const MONEY = pat('MONEY'), AMBIG = pat('AMBIG'), PROMPT = pat('PROMPT');
const forms = (s) => { const l = String(s).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim().replace(/^[^\p{L}\p{N}$€£¥]+|[^\p{L}\p{M}\p{N}$€£¥%)]+$/gu, ''); const f = l.normalize('NFD').replace(/\p{M}/gu, '').normalize('NFC'); return [l, f]; };
const helperStops = (l, money) => forms(l).some((x) => MONEY.test(x) || (money && AMBIG.test(x)));
const W = (url, title = 'Page') => ({ app: 'Safari', title, url });
// The context tools.mjs builds for a window (amount: a checkout's total, a card form or an amount filled).
const ctx = (w, amount = false) => ({ surface: moneySurface(w), payStep: payStepPage(w), amount });
const bad = [];
const check = (ok, what) => { if (!ok) bad.push(what); };

// 1. Ordinary labels on money surfaces, no amount in view: no pay.
const ordinary = [
  [W('https://online.sberbank.ru/CSAFront/index.do', 'СберБанк Онлайн'), ['Выписка', 'История операций', 'Настройки', 'Мои карты', 'Профиль']],
  [W('https://www.mizuhobank.co.jp/retail/index.html', 'みずほ銀行'), ['ログイン', '詳細', 'お知らせ', 'ヘルプ']],
  [W('https://www.shop.example/checkout', 'Checkout'), ['Изменить адрес', 'Применить промокод', 'Выбрать доставку', 'お届け先を変更', '配送方法を選択', '修改地址']],
  [W('https://apps.apple.com/cn/app/id123', 'App Store'), ['评分及评论', '查看全部']],
  [W('https://www.ebay.com/cnt/ViewMessage?id=1', 'eBay Messages'), ['Send', 'Submit', 'Continue']],
  [W('https://www.ebay.com/', 'eBay'), ['Sign in', 'Continue']],
  [W('https://account.venmo.com/pay', 'Venmo'), ['Request']],
  [W('https://www.paypal.com/myaccount/transfer/homepage/request', 'PayPal'), ['Request']],
];
for (const [w, ls] of ordinary) for (const l of ls) check(!isPayClick(l, ctx(w)), `"${l}" on ${w.url} is no pay`);
for (const u of ['https://www.ebay.com/cnt/ViewMessage?id=1', 'https://www.ebay.com/', 'https://www.ebay.com/fdbk/leave_feedback', 'https://signin.ebay.com/ws/eBayISAPI.dll']) check(!moneySurface(W(u)), `${u} is no money surface`);
for (const u of ['https://www.ebay.com/itm/1234', 'https://www.ebay.com/product/1', 'https://offer.ebay.com/ws/eBayISAPI.dll?MakeBid', 'https://pay.ebay.com/rxo?item=1', 'https://www.ebay.co.uk/itm/9']) check(moneySurface(W(u)), `${u} is a money surface`);
for (const u of ['https://www.shop.example/checkout', 'https://www.shop.example/cart', 'https://www.example.com/payment-history', 'https://docs.stripe.com/payment']) check(!payStepPage(W(u)), `${u} is no pay step`);
for (const u of ['https://www.shop.example/checkout/payment', 'https://account.venmo.com/pay', 'https://www.example.com/confirm-order', 'https://www.ebay.com/bfl/bid/1', 'https://checkout.stripe.com/c/pay/cs_1']) check(payStepPage(W(u)), `${u} is a pay step`);

// A real pay button in Russian, Japanese or Chinese on a checkout with an amount still asks, and so does one in a script
// the lists barely cover on a pay step; the helper stops at it in a money plan (the katakana range past U+30B3 too).
const co = W('https://www.shop.example/checkout', 'Checkout'), pay = W('https://www.shop.example/checkout/payment', 'Payment');
for (const l of ['Оплатить', 'Отправить', 'Подтвердить', 'Перевести 500 ₽', '注文を確定する', '支払う', '提交订单', '提交', 'ยืนยัน', 'إرسال', 'Далее 500 ₽']) {
  check(isPayClick(l, ctx(co, true)), `"${l}" pays on a checkout with a total`);
  check(isPayClick(l, ctx(pay)), `"${l}" pays on a pay step`);
  check(helperStops(l, true), `the helper stops at "${l}" in a money plan`);
}
for (const l of ['チャージする', 'チップを送る', 'ペイで払う']) {
  check(isPayClick(l, ctx(co)), `"${l}" pays on a checkout`);
  check(helperStops(l, false), `the helper stops at "${l}"`);
}
for (const l of ['リクエスト', 'ポイント', 'レビュー', 'メッセージ']) check(helperStops(l, true), `the helper stops at "${l}" in a money plan (katakana past U+30B3)`);
// With a total in view, an unread label asks (the unread rule's ceiling: a total does not say which button pays).
check(isPayClick('お届け先を変更', ctx(co, true)), '"お届け先を変更" asks next to a checkout total');

// A bare Request pays on a ride page only; "Request UberX" anywhere on the money surface.
const uber = W('https://m.uber.com/go/product-selection'), lyft = W('https://ride.lyft.com/');
for (const w of [uber, lyft]) { check(isPayClick('Request', ctx(w)), `"Request" pays on ${w.url}`); check(helperStops('Request', true), 'the helper stops at "Request" in a money plan'); }
check(!isPayClick('Request', ctx(W('https://www.chase.com/'))), '"Request" on a bank is no pay');
check(!forms('Request').some((x) => MONEY.test(x)), 'the helper does not stop at "Request" off a money plan');

// 2. Terminal prompts: an ID or a password's expiry is refused; a token's name, label, description or limit is typed.
for (const t of ['AWS Access Key ID [None]:', 'Token ID:', 'Password expiry (days):', 'AWS Secret Access Key [None]:', 'Access key ID:', 'Name your API key, then paste the token:', 'Please give your token:']) {
  check(passwordPrompt(t), `"${t}" is a credential prompt`);
  check(PROMPT.test(t), `the helper refuses at "${t}"`);
}
check(credentialLabel('AWS Access Key ID'), '"AWS Access Key ID" is a credential field');
for (const t of ['? Token name:', 'Token label:', 'Token description:', 'Token limit (4096):', 'Token expiration (days):', 'API key label:', 'Name for this API key:', '? Name your token:', 'Token nickname:', 'Token alias:', '? Give your token a name:', 'Name the new API key:']) {
  check(!passwordPrompt(t), `"${t}" is no credential prompt`);
  check(!PROMPT.test(t), `the helper types at "${t}"`);
}
assert.deepEqual(bad, [], `${bad.length} wrong:\n${bad.join('\n')}`);
console.log('hard limits round 8: ordinary money-surface clicks run; IDs and a password expiry are refused');
