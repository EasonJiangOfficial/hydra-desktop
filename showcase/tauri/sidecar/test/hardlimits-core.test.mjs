// The one hard-limits classifier (hardlimits-core.mjs), ported from the web's src/lib/agent/hard-limits.ts at
// cf1fe0fb51d38eff4932beed445d3c04a0684f91. Part 1: the web's own test phrases (hard-limits.test.ts at that commit,
// copied verbatim), each on the same side. Part 2: the Mac's additions (labels with where they are, field labels,
// card windows, key shapes) and the round-1 verifier's false asks and false refusals (L10, L12). Run: npm test
import { credentialFixture } from './fixtures/credential-fixtures.mjs';
import assert from 'node:assert/strict';
import { CREDENTIAL_REFUSAL, cardNumber, credentialLabel, hardLimit, hardMatch, moneyLabel, moneySurface, typedCredential } from '../hardlimits-core.mjs';

// ---- Part 1: the web's hard-limits.test.ts at ceecb0e runs against this port in test/hardlimits-web.test.mjs,
// using inert examples for credential shapes.
// The tag decides first; the words can only add a limit, and credential wins.
assert.equal(hardLimit('money', 'Click Continue'), 'money');
assert.equal(hardLimit('credential', 'Fill the form'), 'credential');
assert.equal(hardLimit('money', 'Type my password'), 'credential');
// The web at ceecb0e: the phrase is empty when only the tag said so.
assert.deepEqual(hardMatch('money', 'Click Continue'), { kind: 'money', phrase: '' });
assert.equal(hardMatch(undefined, 'Open Safari, then click Pay now')?.phrase, 'pay');
assert.equal(CREDENTIAL_REFUSAL, 'Refused: Hydra never types or reads passwords, keys, codes or card numbers.');

// ---- Part 2: the Mac's additions.
// Labels that pay by their words, anywhere (B2: the round-1 misses), in every listed language.
const PAYS = ['Pay', 'Pay now', 'Buy now', 'Place order', 'Submit order', 'Complete order', 'Order now', 'Start free trial', 'Tip $5', 'Venmo', 'Zelle',
  'PayPal', 'Apple Pay', 'Slide to pay', 'Place bid', 'Book now', 'Upgrade to Pro', 'Top up', 'Add funds', 'Donate', 'Send $50', 'Send $50 to Alex',
  'Complete purchase', 'Confirm payment', 'Transfer funds', 'Withdraw to bank', 'Zahlungspflichtig bestellen', 'Jetzt bestellen', 'Transferir',
  'Überweisen', 'Pagar', 'Comprar ahora', 'Acheter', 'Payer', 'Kaufen', '支付', '转账', '下单', '卖出', '买入', '提现', '充值', '注文を確定する', '購入する',
  '송금', '주문하기', '결제', 'Ｐａｙ', 'P a y'];
for (const l of PAYS) assert.ok(moneyLabel(l), `pays anywhere: ${l}`);
// Round 2 review: a money word that is also a tab, a list or a price tag ("Payments", "Trade", "Checkout", "$4.99")
// is money only in a money surface (a bank, broker, checkout page, app store), never on an ordinary page.
const SURFACE_ONLY = ['Checkout', 'Transfer', 'Withdraw', 'Deposit', 'Sell', 'Vender', 'Trade', 'Swap', 'Subscribe', 'Tip', 'Bid', 'Upgrade', 'Redeem',
  'Repay', 'Wire', 'Exercise', 'Close position', 'Stake', 'Short', 'Long', 'Rent', 'Book', 'Reserve', 'Order', '$4.99', 'Rent $3.99'];
for (const l of SURFACE_ONLY) {
  assert.equal(moneyLabel(l), null, `not money on an ordinary page: ${l}`);
  assert.ok(moneyLabel(l, { surface: true }), `money in a money surface: ${l}`);
}
// Ambiguous labels: money only in a money surface or next to an amount.
const AMBIG = ['Confirm', 'Submit', 'Continue', 'Send', 'Approve', 'Authorize', 'Review order', 'Confirm →'];
for (const l of AMBIG) {
  assert.equal(moneyLabel(l), null, `not money alone: ${l}`);
  assert.ok(moneyLabel(l, { surface: true }), `money in a money surface: ${l}`);
  assert.ok(moneyLabel(l, { amount: true }), `money next to an amount: ${l}`);
}
// A3 round 4 (round-3 review, medium): the weak ones (Done, OK, Next, Return, Get) mostly close or move on, so they are
// money next to an amount only, never for being in a bank or an app store alone.
for (const l of ['Done', 'OK', 'Next', 'Return', 'Get']) {
  assert.equal(moneyLabel(l, { surface: true }), null, `not money in a money surface alone: ${l}`);
  assert.ok(moneyLabel(l, { amount: true }), `money next to an amount: ${l}`);
}
// L10: clear non-money labels never ask, in a money surface too.
const PLAIN = ['Check out this article', 'Transfer photos to Downloads', 'Trade-offs', 'Checkout branch', 'Pay attention', 'Transfer ownership',
  'Withdraw application', 'Purchase history', 'Payroll report', 'File Transfer', 'Deposit photos', 'Sell-by date', 'Order history', 'Payment methods',
  'Transfers', 'Stocks', 'Save', 'Cancel', 'Reply', 'Delete', 'Open the Stocks app', 'Statements', 'Settings'];
for (const l of PLAIN) assert.equal(moneyLabel(l, { surface: true }), null, `not money: ${l}`);
// Money surfaces: by app, by host, by a checkout path or title.
for (const w of [{ app: 'Robinhood' }, { app: 'Venmo' }, { app: 'Coinbase' }, { app: 'App Store' }, { app: 'Safari', url: 'https://www.chase.com/x' },
  { app: 'Safari', url: 'https://shop.example.com/cart' }, { app: 'Arc', url: 'https://checkout.stripe.com/c/pay/cs_1' }, { app: 'Safari', url: 'https://x.com/checkout/step2' },
  { app: 'Google Chrome', title: 'Checkout - Example' }, { app: 'Safari', url: 'https://apps.apple.com/us/app/x/id1' }]) assert.equal(moneySurface(w), true, JSON.stringify(w));
for (const w of [{ app: 'Mail' }, { app: 'Safari', url: 'https://github.com/x/y', title: 'Pull request' }, { app: 'Notes', title: 'Groceries' }, { app: 'Stocks' }]) assert.equal(moneySurface(w), false, JSON.stringify(w));
// H4: card numbers in every common shape, every window, brand-gated; L12: IMEIs and other digits pass.
for (const t of ['4242 4242 4242 4242', '4242.4242.4242.4242', '4242  4242  4242  4242', '4242/4242/4242/4242', '4242\t4242\t4242\t4242', '4242–4242–4242–4242',
  '４２４２４２４２４２４２４２４２', '4242_4242_4242_4242', '4 2 4 2 4 2 4 2 4 2 4 2 4 2 4 2', '4242 4242 4242 4242 12/29 123', '4242424242424242 1229 123',
  'card: 4242-4242-4242-4242.', '378282246310005', '3782 822463 10005', '0000 4242 4242 4242 4242', '2 4242424242424242', '5555 5555 5555 4444', '6011 1111 1111 1117']) assert.ok(cardNumber(t), `a card: ${JSON.stringify(t)}`);
for (const t of ['490154203237518', 'IMEI 490154203237518', '1764201600000', '9780306406157', 'tracking 9400111899223197428490', '4242 4242 4242 4241', 'Call 555 0100 at 3', '4242', '2026-11-26 12:30', '+1 512 555 0123']) assert.equal(cardNumber(t), null, `not a card: ${JSON.stringify(t)}`);
// M9: key shapes in typed text are refused; plain words are not.
for (const t of [credentialFixture('sk_live_', 8), credentialFixture('ghp_', 8), credentialFixture('AKIA', 16), credentialFixture('sk-ant-', 8), credentialFixture('xoxb-', 8), '4242 4242 4242 4242']) assert.ok(typedCredential(t), `typed credential: ${t}`);
for (const t of ['correct horse battery staple', 'my password reset steps', 'Open .env later', 'hello', '$50 for lunch', 'sk_note']) assert.equal(typedCredential(t), null, `typed text: ${t}`);
// B1 / L12: credential field labels in several languages; near misses pass.
for (const f of ['Password', 'Passcode', 'Contraseña', 'Mot de passe', 'Passwort', 'Kennwort', 'Senha', '密码', 'パスワード', '비밀번호', 'PIN', 'Enter PIN', 'Card PIN',
  'PW', 'Pwd', 'SSN', 'Social Security number', 'Recovery phrase', 'Seed phrase', 'Private key', 'Access key', 'Authentication code', 'Verification code',
  '6-digit code', 'Security code', 'Card number', 'Card information', 'CVV', 'CVC', 'MM / YY', 'Numéro de carte', 'Kartennummer', 'Número de tarjeta',
  'API key', 'Client secret', 'One-time code', 'Enter your password', 'Confirm password']) assert.equal(credentialLabel(f), true, `credential field: ${f}`);
for (const f of ['Pin title', 'Pin to top', 'PIN code (postal)', 'Secret Santa name', 'Search secrets', 'Token name', 'Email', 'Username', 'Name', 'Spinner',
  'Search', 'Code', 'Promo code', 'Passport number', 'Gift card number', 'Cardholder name', 'Expiry', 'Licence key', 'Account number', 'Enter it']) assert.equal(credentialLabel(f), false, `not a credential field: ${f}`);
assert.equal(credentialLabel('Expiry', { cardForm: true }), true, 'an expiry field next to a card field');
console.log('hardlimits-core (the web classifier, ported, plus the Mac labels): ok');
