// One classifier for web and Mac (A3 item 1): the web's own hard-limits.test.ts at ceecb0e0e4637d648214d311ba3017a643c7b116,
// kept in test/fixtures with independently generated examples for the credential shapes. Run against the port
// (hardlimits-core.mjs, with the web's zod schemas from ./hard-limits) using describe/it/expect in place of vitest.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import * as core from '../hard-limits';
import { credentialFixture, privateKeyHeader } from './fixtures/credential-fixtures.mjs';

const src = fs.readFileSync(new URL('./fixtures/hard-limits.web-ceecb0e.test.ts', import.meta.url), 'utf8');
// Its types come off as node strips them, and its imports are given below.
const body = stripTypeScriptTypes(src).replace(/^import .*$/gm, '');
let pass = 0;
const fail = [];
let cur = '';
const expect = (x) => {
  const rec = (ok, how, y) => { if (ok) pass++; else fail.push(`${cur} :: ${how} got=${JSON.stringify(x)} want=${JSON.stringify(y)}`); };
  const o = (neg) => ({
    toBe: (y) => rec(neg !== Object.is(x, y), `${neg ? 'not.' : ''}toBe`, y),
    toBeNull: () => rec(neg !== (x === null), `${neg ? 'not.' : ''}toBeNull`, null),
    toEqual: (y) => rec(neg !== (JSON.stringify(x) === JSON.stringify(y)), `${neg ? 'not.' : ''}toEqual`, y),
    toBeInstanceOf: (C) => rec(neg !== (x instanceof C), `${neg ? 'not.' : ''}toBeInstanceOf`, C.name),
    toMatch: (re) => rec(neg !== (typeof re === 'string' ? String(x).includes(re) : re.test(String(x))), `${neg ? 'not.' : ''}toMatch`, String(re)),
    toContain: (y) => rec(neg !== x.includes(y), `${neg ? 'not.' : ''}toContain`, y),
    toBeLessThanOrEqual: (y) => rec(neg !== (x <= y), `${neg ? 'not.' : ''}toBeLessThanOrEqual`, y),
  });
  return { ...o(false), not: o(true) };
};
const it = (n, f) => { cur = n; try { f(); } catch (e) { fail.push(`${n} :: threw ${e.message}`); } };
it.each = (list) => (n, f) => { for (const w of list) { const a = Array.isArray(w) ? w : [w]; it(n.replace('%s', a[0]), () => f(...a)); } };
const describe = (_n, f) => f();
// eslint-disable-next-line no-new-func
new Function('describe', 'expect', 'it', 'test', 'hardLimits', 'CREDENTIAL_REFUSAL', 'hardLimit', 'hardMatch', 'credentialFixture', 'privateKeyHeader', body)(
  describe, expect, it, it, core, core.CREDENTIAL_REFUSAL, core.hardLimit, core.hardMatch, credentialFixture, privateKeyHeader,
);
assert.deepEqual(fail, [], `the port differs from the web on ${fail.length} of its phrases`);
assert.ok(pass >= 600, `only ${pass} checks ran`);
console.log(`hardlimits-web: ${pass} checks, all on the web's side`);
