// Release review finding 4 (2026-11-27): the phone asked money for any $ in a window title, and Return in a text area
// counted as a submit. Its money context is now checkout evidence, as the agent's. Failed before its fix. Run: npm test
import assert from 'node:assert/strict';
import { checkInput, payCtx } from '../remotepolicy.mjs';

const base = { display: { w: 1000, h: 800 }, shields: [], locked: false, agent: { busy: false, owner: false }, hit: { app: 'Safari' }, frontSecret: false, tail: '', pay: {} };
// 3. The phone's money context is checkout evidence, as the agent's (tools.mjs mctx): any $ in a title is not one.
const keyIn = (k, title, app, focus) => checkInput({ t: 'key', n: 1, k }, { ...base, hit: { app }, focus, pay: payCtx({ app, title }) }).do;
const clickIn = (label, win) => checkInput({ t: 'click', n: 1, x: 0.5, y: 0.5 }, { ...base, focus: {}, hit: { role: 'AXButton', label, app: win.app }, pay: payCtx(win) }).do;
const body = { role: 'AXTextArea', label: 'Message body', buttons: ['Send', 'Cancel'] };
for (const [title, app] of [['Re: Invoice for $1,200', 'Mail'], ['#general - $5 pizza Friday - Slack', 'Slack'], ['Budget $500 - Notes', 'Notes']]) {
  assert.equal(keyIn('return', title, app, body), 'allow', `Return in a text area is a newline: ${app} "${title}"`);
  assert.equal(checkInput({ t: 'text', n: 2, s: 'ok\n' }, { ...base, hit: { app }, focus: body, pay: payCtx({ app, title }) }).do, 'allow', `a typed newline too: ${app}`);
}
for (const label of ['OK', 'Next', 'Done', 'Continue', 'Send', 'Get', 'Accept', 'Yes', 'Go']) {
  for (const win of [{ app: 'Mail', title: 'Invoice for $1,200' }, { app: 'Numbers', title: 'Budget $500.numbers' }, { app: 'Safari', title: 'Bitcoin hits $100,000 - The Verge', url: 'https://www.theverge.com/x' }]) {
    assert.equal(clickIn(label, win), 'allow', `${label} in ${win.app} "${win.title}" is no payment`);
  }
}
// A checkout still asks: its total in the title of a browser page, a pay-step page, a money surface.
assert.equal(clickIn('Continue', { app: 'Safari', title: 'Checkout - Order total $84.20', url: 'https://shop.example.com/cart' }), 'ask', 'Continue on a page that shows a checkout total');
assert.equal(clickIn('Continue', { app: 'Safari', title: 'Checkout', url: 'https://shop.example.com/checkout' }), 'ask', 'Continue on a checkout page');
assert.equal(keyIn('return', 'Robinhood', 'Robinhood', { role: 'AXTextField', label: 'Amount', buttons: ['Review'] }), 'ask', 'Return in a broker still asks');
assert.equal(keyIn('return', 'Checkout', 'Safari', { role: 'AXTextField', label: 'Name', buttons: ['Place order'] }), 'ask', 'Return in a field of a form that pays still asks');
console.log('releasemoney: ok');
