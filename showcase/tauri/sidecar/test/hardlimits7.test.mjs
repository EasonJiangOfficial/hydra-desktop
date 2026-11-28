// The owner's hard limits, round 7 (A3 desktop, the final review's H2 and the M2 regression):
// H2: pay, transfer and buy verbs are matched by stem with their inflections and an amount after them, anywhere; in a
//     money surface a button in a script the word lists barely cover asks unless it is a known way back or to the cart.
//     The hands helper (main.swift MONEY, AMBIG) stops at the same labels, so a click by a spot asks too.
// M2: a terminal prompt for a token's or a key's name, label, description or limit is no password prompt.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isPayClick } from '../safety.mjs';
import { moneySurface, passwordPrompt } from '../hardlimits-core.mjs';

const S = new URL('..', import.meta.url).pathname;
const SWIFT = fs.readFileSync(path.join(S, '../src-tauri/hands/main.swift'), 'utf8');
const pat = (name) => new RegExp(SWIFT.match(new RegExp(`^let ${name} = try! NSRegularExpression\\(pattern: #"(.*)"#, options: .*\\)$`, 'm'))[1], 'iu');
const MONEY = pat('MONEY'), AMBIG = pat('AMBIG'), PROMPT = pat('PROMPT');
// The helper's label forms: NFKC, lower case, trimmed edges, and the same with accents dropped.
const forms = (s) => { const l = String(s).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim().replace(/^[^\p{L}\p{N}$€£¥]+|[^\p{L}\p{M}\p{N}$€£¥%)]+$/gu, ''); const f = l.normalize('NFD').replace(/\p{M}/gu, '').normalize('NFC'); return [l, f]; };
const helperStops = (l, money) => forms(l).some((x) => MONEY.test(x) || (money && AMBIG.test(x)));
const W = (url, title = 'Shop') => ({ app: 'Safari', title, url });
const bad = [];
const check = (ok, what) => { if (!ok) bad.push(what); };

// Siblings of the round-6 labels: inflections, an amount after the verb, other words of the same languages. Each
// pays on an ordinary shop page with no surface, and the helper stops at it.
const anywhere = ['Перевести 500 ₽', 'Перевести 1 200 руб.', 'Оплатить 990 ₽', 'Przelej', 'Przelej 100 zł', 'Zapłać 49,99 zł', 'Overmaken', 'Maak over', 'Betaal €25',
  'Virer', 'Virer 50 €', 'Envoyer de l’argent', "Envoyer de l'argent", 'Enviar Pix', 'Pagar R$ 50', 'Havale yap', 'EFT yap', 'Öde 100 ₺', 'شراء', 'اشتري', 'ซื้อ', 'ชำระ',
  '注文を確定', '注文確定', 'Pay $50.00', 'Купить за 990 ₽'];
for (const l of anywhere) {
  check(isPayClick(l, {}), `"${l}" pays anywhere`);
  check(helperStops(l, false), `the helper stops at "${l}"`);
}
// The ride and auction pages are money surfaces, where Request and Bid pay.
const uber = W('https://m.uber.com/go/product-selection'), ebay = W('https://www.ebay.com/product/1'), ing = W('https://www.ing.nl/particulier/betalen/overmaken', 'ING');
for (const w of [uber, ebay, ing]) check(moneySurface(w), `${w.url} is a money surface`);
for (const l of ['Request', 'Request Uber Comfort', 'Request UberX', 'Request Lyft XL']) {
  check(isPayClick(l, { surface: moneySurface(uber) }), `"${l}" pays on m.uber.com`);
  check(helperStops(l, true), `the helper stops at "${l}" on m.uber.com`);
}
check(isPayClick('Bid', { surface: moneySurface(ebay) }), '"Bid" pays on an eBay item');
// A money surface's button in a script the lists barely cover (Cyrillic, Arabic, Thai, CJK...): its words may pay.
const checkout = W('https://www.shop.example/checkout');
for (const l of ['Отправить', 'Подтвердить', 'إرسال', 'ยืนยัน', '提交', 'Далее 500 ₽']) {
  check(isPayClick(l, { surface: moneySurface(checkout), amount: true }), `"${l}" pays on a checkout`);
  check(helperStops(l, true), `the helper stops at "${l}" in a money plan`);
}
// Ordinary labels stay ordinary: off a money surface, and a known way back or to the cart on one.
for (const [w, l] of [[W('https://github.com/acme/app/pull/12'), 'Request review'], [W('https://github.com/acme/app/pull/12/files'), 'Approve'],
  [W('https://docs.google.com/document/d/1/edit'), 'Request access'], [W('https://docs.google.com/spreadsheets/d/1/edit'), 'Wrap text'],
  [W('https://www.uber.com/us/en/about/'), 'Request a demo'], [W('https://www.example.com/help'), 'Give feedback'], [W('https://www.magazin.ru/'), 'Перейти в корзину'],
  [W('https://www.sklep.pl/'), 'Dodaj do koszyka'], [W('https://www.example-shop.de/'), 'In den Warenkorb'], [W('https://www.boutique.fr/'), 'Ajouter au panier'],
  [W('https://www.example.com/'), 'Place'], [W('https://www.example.com/'), 'Page'], [W('https://www.example.com/'), 'Перевести страницу'],
  [W('https://www.example.com/'), 'Virement history'], [W('https://www.example.com/'), 'Zahlen'], [checkout, 'Назад'], [checkout, 'Отмена'], [checkout, 'Перейти в корзину'], [checkout, '返回']]) {
  check(!isPayClick(l, { surface: moneySurface(w) }), `"${l}" on ${w.url} is no pay`);
}
for (const l of ['Перевести страницу', 'Page', 'Place', 'Request review']) check(!forms(l).some((x) => MONEY.test(x)), `the helper does not stop at "${l}" off a money plan`);

// M2: a token's name, label, description or limit is typed; the token, key, code or password itself is refused.
for (const t of ['? Token name:', 'Name for this API key:', 'Token limit (4096):', 'Enter the token name:', 'Personal access token name:', 'API key label:', 'Description of the API key:', 'Token expiration (days):']) {
  check(!passwordPrompt(t), `"${t}" is no password prompt`);
  check(!PROMPT.test(t), `the helper types at "${t}"`);
}
for (const t of ['Password:', '[sudo] password for fixtureuser:', 'Enter passphrase for key \'/Users/e/.ssh/id_ed25519\':', 'Enter MFA code for arn:aws:iam::123456789012:mfa/fixtureuser:', 'Token:', 'Enter your API key:', '? Paste your token:', 'API key (sk-...):', 'Verification code:']) {
  check(passwordPrompt(t), `"${t}" is a password prompt`);
  check(PROMPT.test(t), `the helper refuses at "${t}"`);
}
assert.deepEqual(bad, [], `${bad.length} wrong:\n${bad.join('\n')}`);
console.log('hard limits round 7: stems, inflections and amounts pay; token names are typed');
