// The hands helper's money and credential-field patterns (src-tauri/hands/main.swift MONEY, AMBIG, CRED_FIELD), and the
// remote helper's credential fields (src-tauri/remote/hit.swift CRED_FIELD_CARD: CRED_FIELD with A3's card expiry, as
// remotepolicy.mjs reads credentialField with cardForm) and card brands (src-tauri/remote/card.swift CARD_BRANDS: A3's
// BRANDS, and its card reading CARD_RUN), and hit.swift's TERMINALS, built from hardlimits-core.mjs's own sources, so every layer
// reads the same words. Used by test/swiftsync.test.mjs, and to write them into the Swift after a change:
// node test/swiftsync.mjs --write
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const CORE = new URL('../hardlimits-core.mjs', import.meta.url);
export const SWIFT = new URL('../../src-tauri/hands/main.swift', import.meta.url);
export const REMOTE = new URL('../../src-tauri/remote/hit.swift', import.meta.url);
export const CARD = new URL('../../src-tauri/remote/card.swift', import.meta.url);
// Which Swift file holds each pattern (the rest are in SWIFT). CARD_BRANDS: A3's card brands (BRANDS: each prefix and
// its lengths) for the remote helper's card backstop.
const FILE = { CRED_FIELD_CARD: REMOTE, TERMINALS: REMOTE, CARD_BRANDS: CARD, CARD_RUN: CARD };
const fileOf = (k) => FILE[k] ?? SWIFT;
export function swiftPatterns() {
  const src = fs.readFileSync(CORE, 'utf8');
  const raw = (name) => { const m = src.match(new RegExp(`const ${name} = String\\.raw\`([^\`]*)\`;`)); if (!m) throw new Error(`no ${name}`); return m[1]; };
  const list = (name) => { const m = src.match(new RegExp(`const ${name} = /\\^\\(([^/]*)\\)\\$/;`)); if (!m) throw new Error(`no ${name}`); return m[1]; };
  const credStart = src.indexOf('const CRED_FIELD = new RegExp([');
  const cred = [...src.slice(credStart, src.indexOf("].join('|')", credStart)).matchAll(/String\.raw`([^`]*)`/g)].map((m) => m[1]);
  const amount = raw('AMOUNT');
  const expiry = src.match(/^const EXPIRY = \/(.*)\/;$/m)?.[1];
  if (!expiry) throw new Error('no EXPIRY');
  const brandsAt = src.indexOf('const BRANDS = [');
  const brands = [...src.slice(brandsAt, src.indexOf('];', brandsAt)).matchAll(/\[\/([^/]+)\/, \[([\d, ]+)\]\]/g)].map((m) => `("${m[1]}", [${m[2]}])`);
  if (!brands.length) throw new Error('no BRANDS');
  const terminals = src.match(/^export const TERMINALS = \/(.*)\/i;$/m)?.[1];
  if (!terminals) throw new Error('no TERMINALS');
  const out = {
    MONEY: `^(${raw('PAY_WORDS')}|${raw('PAY_FOREIGN')}|${raw('MONEY_WORD')}|${list('PAY_CJK')})(\\s*(→|>|›|»))?$|${raw('FAMILY_MATCH').replace('${FAMILY}', raw('FAMILY')).replace('${FAMILY_NOT_WORDS}', raw('FAMILY_NOT_WORDS')).replace('${FAMILY_CJK}', raw('FAMILY_CJK')).replace('${CJK_NOT}', raw('CJK_NOT'))}|${raw('COMMIT_MONEY')}|(^|[^\\p{L}\\p{M}])(${raw('PAY_STEMS')})(?![\\p{L}\\p{M}])|${raw('PAY_NOSPACE')}|^(${raw('PAY_WORDS')}|${raw('PAY_FOREIGN')}|${raw('PAY_INFLECT')})${raw('PAY_TAIL')}$|^(${raw('PAY_VERB').replace('${NOT_MONEY}', raw('NOT_MONEY'))})$|^(pay|send|transfer|donate|tip|buy|purchase|deposit|withdraw|give|top up|add|join|subscribe|bet|wager|order|renew|upgrade|book|place|start|try)\\b.{0,20}${amount}|^(withdraw|deposit|transfer|send|move)\\b.{0,30}\\b(funds|money|cash|to (checking|savings|bank|account|wallet|card)|from (checking|savings|bank|account|wallet))\\b|^([\\p{L}'-]+ ){0,4}(from |for |only |just |under )?${amount}[\\d.,]*( ?/ ?(mo|month|yr|year|wk|week))?( [\\p{L}'-]+){0,2}$`,
    AMBIG: `^[^\\p{L}\\p{N}]*(${raw('CONFIRM_WORD')}|${raw('WEAK_CONFIRM')}|${list('CONFIRM_CJK')}|${list('WEAK_CJK')}|${raw('RIDE_WORD')})(?![\\p{L}])|^[^\\p{L}\\p{N}]*${raw('UNREAD_SCRIPT')}`,
    CRED_FIELD: cred.join('|'),
    CRED_FIELD_CARD: `${cred.join('|')}|${expiry}`,
    REVEAL: raw('REVEAL'),
    PROMPT: raw('PROMPT'),
    SIGNIN: raw('SIGNIN_WORDS'),
    CARD_BRANDS: `[${brands.join(', ')}]`,
    // Release round 2: A3's card reading (RUN: digit groups and the separators between them) for card.swift's
    // Card.has, and its terminal apps for hit.swift's lastLine.
    CARD_RUN: String.raw`\d+(?:(?:${raw('SEP')})\d+)*`,
    TERMINALS: terminals,
  };
  // NFKC, as the sidecar builds them and as the helper folds a label (Thai SARA AM, Japanese voiced marks).
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.normalize('NFKC')]));
}
const LINE = (name) => (name === 'CARD_BRANDS' ? /^( {4}static let CARD_BRANDS: \[\(String, \[Int\]\)\] = )(.*)()$/m : new RegExp(`^let ${name} = try! NSRegularExpression\\(pattern: #"(.*)"#, options: (.*)\\)$`, 'm'));
const lineOf = (name) => (name === 'CARD_BRANDS' ? 2 : 1);
export function swiftHas() {
  return Object.fromEntries(Object.keys(swiftPatterns()).map((k) => [k, fs.readFileSync(fileOf(k), 'utf8').match(LINE(k))?.[lineOf(k)] ?? null]));
}
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes('--write')) {
  for (const file of [SWIFT, REMOTE, CARD]) {
    let s = fs.readFileSync(file, 'utf8');
    for (const [k, v] of Object.entries(swiftPatterns())) if (fileOf(k) === file) s = s.replace(LINE(k), (_m, a, b) => (k === 'CARD_BRANDS' ? `${a}${v}` : `let ${k} = try! NSRegularExpression(pattern: #"${v}"#, options: ${b})`));
    fs.writeFileSync(file, s);
  }
  console.log('hands/main.swift, remote/hit.swift and remote/card.swift patterns written');
}
