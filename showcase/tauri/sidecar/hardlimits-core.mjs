/**
 * The two hard limits, one classifier for web and Mac (audit 2026-11-26, PLAN.md "Safety rule for Approve all"):
 * fixed, not a setting, checked before Approve all.
 * - "credential": typing a password, key, code or card number, or reading a password manager, an authenticator or a
 *   secret file. Refused, with or without the owner's yes. Wins over money.
 * - "money": paying, buying, ordering, transferring money, trading. Always asks.
 *
 * Part 1 is a faithful port of the web's src/lib/agent/hard-limits.ts at commit
 * ceecb0e0e4637d648214d311ba3017a643c7b116 (lane A3 web, round 8 merged with main): the file itself with its types
 * taken off (node:module stripTypeScriptTypes) and nothing else changed but three names: its zod schemas are plain
 * lists here (HARD_LIMITS, HARD_VERDICTS; the zod schemas are in ./hard-limits, which relayschema.mjs imports), and its
 * local cardNumber is webCardNumber (Part 2 has the Mac's). test/hardlimits-web.test.mjs runs the web's
 * hard-limits.test.ts at that commit, kept verbatim in test/fixtures. When the web file changes, port it again the same
 * way and copy its test.
 *
 * Part 2 is the Mac's own judges, which the web has no use for (they read a control, a field, a window, typed text):
 * - cardNumber: a card written as one (whole, in fours, 4-6-5, digit by digit) with one separator, any digit script,
 *   by the brand's prefix (IIN) and length, and Luhn. Never across separate values (a phone, a ZIP and a date) or a
 *   list (comma lists, times).
 * - typedCredential: typed text that is a card, a key or token, a URL with a password, a bearer token, a private key,
 *   a BIP39 seed phrase, an SSN next to its name, a secret assigned in a command or a source line, a TOTP secret.
 * - credentialLabel / codeBox: a field that takes a password, a code, a key or a card's number, in many languages.
 * - moneyLabel / moneyStop / moneySurface / checkoutText: a button's label judged with where it is (B2).
 * - SECRET_FILE: the file names that hold sign-ins (password exports, recovery codes, seed phrases, wallet keys).
 */

import { BIP39_WORDS } from './bip39.mjs';

// ════════════════════════════ Part 1: the web's hard-limits.ts at ceecb0e ════════════════════════════

/**
 * The two hard limits (audit 2026-11-26; owner 2026-11-26: "just have the claude on the vps handle that"): fixed, not a
 * setting, checked before approve all on every web path (live, routine, MCP, relay approval, relay sub-turn).
 * - "credential": typing, entering, pasting, revealing or reading a password, passcode, PIN, one-time code, API key,
 *   secret, token, seed phrase or card number, or opening a password manager or a secret file. Refused, with or
 *   without the owner's yes (he does it himself). Wins over money.
 * - "money": paying, buying, ordering, checking out, subscribing, booking with payment, sending or transferring money,
 *   trading, swapping crypto. Always asks.
 * How a call is judged, per call (one step's words, not the whole plan):
 * 1. The structured tag is the main judge: the Claude that runs the turn (the web loop's mac_do `hard`, the Mac's
 *    relay ask `hard`, the server brain's sub-turn `hard`) tags every step "money", "credential" or "none". A limit
 *    tag only adds a limit. "none" is the model's verdict that the step is neither: it adds nothing and removes nothing
 *    (layers 2 and 3 still run). No second model is called here.
 * 2. A high-precision credential layer always runs: a Luhn-valid card number with an issuer prefix, a key or token
 *    prefix, a secret file, a password-manager or authenticator app, a command that prints secrets.
 * 3. The broad word layer always runs too, so a wrong "none" or a missing verdict (an older client) still hits the plain
 *    steps: it over-asks on purpose.
 * Labels are not actions: quoted text and the words after called, titled, named or saying are left out before word
 * matching, unless the clause clicks, presses or uses it or it names a control (a button's label is the action).
 */

/** The web's hardLimitSchema values (a zod enum there; the zod schemas are in ./hard-limits). */
export const HARD_LIMITS = Object.freeze(["money", "credential"]);
/** The model's verdict on a step: a limit or "none" (hardVerdictSchema there). */
export const HARD_VERDICTS = Object.freeze(["money", "credential", "none"]);

/** The refusal: generic on purpose, so it does not teach a rewording. */
export const CREDENTIAL_REFUSAL = "Refused: Hydra never types or reads passwords, keys, codes or card numbers.";

/** Long text cut in the middle, so its start and its end (where the amount and payee usually are) both stay. */
export function clipMiddle(text, max) {
  // Code points, not UTF-16 units: a cut never leaves half an emoji (Postgres rejects a lone surrogate).
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  const headLen = Math.floor((max - 1) * 0.4);
  return `${chars.slice(0, headLen).join("").trimEnd()}…${chars.slice(chars.length - (max - 1 - headLen)).join("").trimStart()}`;
}
/** A money gate's summary: the reason first, then the whole step, cut in the middle to fit max. */
export function moneySummary(m, rest, max = 500) {
  const prefix = `Pays or moves money: ${m.phrase ? `${Array.from(m.phrase).slice(0, 40).join("")}. ` : ""}`;
  return prefix + clipMiddle(rest, max - Array.from(prefix).length);
}

// Cyrillic and Greek letters that look Latin (the common confusables).
const CONFUSABLE = {
  а: "a", в: "b", е: "e", ё: "e", к: "k", м: "m", н: "h", о: "o", р: "p", с: "c", т: "t", у: "y", х: "x", ѕ: "s", і: "i",
  ї: "i", ј: "j", ԁ: "d", һ: "h", ӏ: "l", ԛ: "q", ԝ: "w", ɡ: "g", α: "a", β: "b", ε: "e", ι: "i", κ: "k", ν: "v", ο: "o",
  ρ: "p", τ: "t", υ: "u", χ: "x", ω: "w", η: "n",
};

/**
 * NFKC (fullwidth, math bold, circled), no format characters, no accents, Latin look-alikes, plain quotes and dashes.
 * A line break is a clause break ("; ").
 */
export function foldHard(words) {
  return (
    words
      .normalize("NFKC")
      .replace(/\p{Cf}/gu, "")
      .replace(/\s*[\r\n]+\s*/g, "; ")
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .normalize("NFC")
      .replace(/[Ѐ-ӿͰ-Ͽɡ]/g, (c) => CONFUSABLE[c] ?? c)
      .replace(/[‘’‛ʼ`´′]/g, "'")
      .replace(/[“”„‟″]/g, '"')
      .replace(/[‐-―−﹘﹣－]/g, "-")
      // Letter-spaced words ("p a y", "p.a.y") join up.
      .replace(/(?<![\p{L}\d])\p{L}(?:[.\s-]+\p{L}(?![\p{L}\d])){2,}/gu, (run) => run.replace(/[.\s-]+/g, ""))
      .replace(/[ \t\f\v]+/g, " ")
      .trim()
  );
}

/**
 * The clauses of a step: split on , ; " & " ". " ": " "! " "? " " - word" and/then/also, each without a leading
 * please/now/first or trailing punctuation. AT&T and "invoice - $1,200" stay whole.
 */
const CLAUSE_BREAK = /(?<!\d),|,(?!\d)|;|\s&\s|[.:!?]\s|\s-\s(?=[a-z])|\b(?:and|then|also|after that)\b/;
const clauses = (w) =>
  w
    .split(CLAUSE_BREAK)
    .map((c) => (c ?? "").trim().replace(/^(please|now|first|next|finally)\s+/, "").replace(/\s*[.!?]+$/, ""))
    .filter(Boolean);
const lastClause = (before) => before.split(CLAUSE_BREAK).at(-1) ?? "";

// ── Labels ───────────────────────────────────────────────────────────────

/** A clause that acts on what it names: click, press, tap, use... (the label is the button). */
const PRESSES = /(^|[^\p{L}])(click\w*|press\w*|tap\w*|hit|select\w*|choose|push|use|clique\w*|klick\w*|pulsa\w*|toca)(?![\p{L}])|haz clic|点击|点按|按下|轻点/u;
/** A label right after a control's noun: "the button called Pay", "the link named Checkout". */
const CONTROL = /\b(button|link|tab|option|menu item|item|icon|toggle|switch|checkbox|control)\s*$/;
const LABEL = /"[^"]*"|'[^']*'|«[^»]*»|「[^」]*」|\b(?:called|titled|named|saying|says|labell?ed)\b[^,;]*?(?=[,;]|\band\b|\bthen\b|$)/gu;

/** Labels are not actions: quoted text and what follows called, titled... unless the clause presses it or names a control. */
export function stripLabels(w) {
  return w
    .replace(LABEL, (m, at) => {
      const clause = lastClause(w.slice(0, at));
      return PRESSES.test(clause) || CONTROL.test(clause.replace(/\b(that|which)\s*$/, "").trimEnd()) ? ` ${m.replace(/["'«»「」]/g, " ")} ` : " ";
    })
    .replace(/\s+/g, " ")
    .trim();
}

// ── Credential (precise: always) ─────────────────────────────────────────

const luhn = (digits) => {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
};
/** Visa, Mastercard (51-55, 2221-2720), Amex, Diners, Discover, JCB, UnionPay: prefix and length. */
const ISSUER = /^(4(\d{12}|\d{15}|\d{18})|5[1-5]\d{14}|2(2[2-9]\d|[3-6]\d\d|7[01]\d|720)\d{12}|3[47]\d{13}|3(0[0-5]|[689]\d)\d{11}|6(011|5\d\d|4[4-9]\d)\d{12,15}|35(2[89]|[3-8]\d)\d{12,15}|62\d{14,17})$/;
/**
 * Every run of whole digit groups in a digit run: "4242 4242 4242 4242 12/27 123" holds the card in its first four
 * groups, "1 4242 4242 4242 4242" in its last four. Whole groups only, so a long tracking number is not cut anywhere.
 */
function webCardNumber(w) {
  for (const m of w.matchAll(/\d(?:[\s./_-]*\d)*/g)) {
    const groups = m[0].split(/[\s./_-]+/);
    for (let i = 0; i < groups.length; i++) {
      let digits = "";
      for (let j = i; j < groups.length && digits.length < 19; j++) {
        digits += groups[j];
        if (digits.length >= 13 && ISSUER.test(digits) && luhn(digits)) return groups.slice(i, j + 1).join(" ");
      }
    }
  }
  return null;
}

/** Not the app itself: "best password manager", "Keychain Access help page". */
const NOT_THE_APP = String.raw`(?<!\b(best|top|good|free|cheapest|compare|comparing|about|reviews? of)\s+)`;
const PRECISE = [
  // Key and token prefixes.
  /(?<![\w-])(sk-(ant-|proj-)?[\w-]{8,}|sk_(live|test)_\w{8,}|rk_(live|test)_\w{8,}|aiza[\w-]{20,}|gh[pousr]_\w{8,}|github_pat_\w+|glpat-[\w-]{8,}|xox[abprs]-[\w-]+|(akia|asia)[0-9a-z]{16}\b|eyj[\w-]{8,}\.[\w-]+|-----begin)/,
  // Commands that print secrets (in backticks or quotes too).
  /\bprintenv\b|\benv ?\| ?grep|\bgrep\b[^|;]*\b(secret|token|password|api_?key)|\baws configure get\b|\becho \$\w*(secret|key|token|password|pass)\w*|\bgcloud auth print-(access|identity)-token|\bfind-(generic|internet)-password\b|\bgh auth token\b|\bcat\b[^;|]*\.env\b/,
];
const PRECISE_LABELLED = [
  // Secret files.
  /(^|[\s/("'=:`])\.env(\.[\w-]+)?(?![\w-])|(^|[\s/~("'`])\.(ssh|gnupg|netrc|npmrc|pgpass)\b|\.aws\/credentials|\.kube\/config|\.docker\/config\.json|\bid_(rsa|dsa|ecdsa|ed25519)\b|\.(pem|p12|pfx|keystore|jks)\b|\bwallet\.dat\b|\b(secrets?|credentials?)\.(ya?ml|json|txt|env|toml|csv)\b|\bclient_secret[\w.-]*\.json\b|[\w-]*(recovery|backup)[-_ ]codes?\b|\bpasswords?\.(txt|csv)\b/,
  // Password managers, authenticators, browser password stores (not their help pages).
  new RegExp(
    String.raw`\b(1 ?password|bitwarden|dashlane|lastpass|roboform|enpass|nordpass|proton ?pass|strongbox|keepass\w*|keychain access|keeper (security|app)|passwords? ?(app|\.app)|apple passwords|${NOT_THE_APP}password manager|saved passwords|authy|(google |microsoft )?authenticator|2fas|raivo|otp ?auth|about:logins|chrome:\/\/(password-manager|settings\/passwords))\b(?!( app)? (help|docs|documentation|guide|support)\b)|\bsettings\b[^.;]{0,30}\bpasswords\b`,
  ),
];
/** Reading or typing a wallet's seed or recovery phrase (not an article about one). */
const SEED = /\b(read|copy|type|enter|paste|reveal|show|get|tell me|say|write down|fill)\b[^.;]{0,40}\b(seed|recovery|secret|mnemonic|backup) (phrase|words)\b/;
/** The macOS Passwords app by its bare name: "open Passwords", "bring up the Passwords window". */
const PASSWORDS_APP = /^(\w+\s+){1,2}(the\s+)?(apple\s+|macos\s+)?passwords( app| window)?$/;
/** A clause that opens or reads what it names: there the name is the target, so the precise layer sees it. */
const ACCESS = /^(open|launch|start|run|read|cat|less|head|tail|show|view|display|print|reveal|copy|edit|go to|navigate to|visit|bring up|bring|focus|switch to|activate|unlock|use|access|load|preview)\b/;
/** In an opening clause, a named note, document or event is still content, not the target. */
const CONTENT_LABEL =
  /\b(notes?|documents?|docs?|events?|tasks?|reminders?|messages?|emails?|threads?|slides?|decks?|presentations?|playlists?|songs?|videos?|articles?|posts?|projects?|boards?|issues?|tickets?|branch(es)?|commits?|lists?)\s+((called|titled|named|saying|says|that says|labell?ed)\b.*|("[^"]*"|'[^']*'|«[^»]*»).*)$/;

function firstHit(res, text) {
  for (const re of res) {
    const m = text.match(re);
    if (m) return m[0].trim();
  }
  return null;
}

/** Typing into Spotlight, a launcher or a shell opens or runs what is typed: there a quoted name is the target. */
const LAUNCHER = /\b(spotlight|alfred|raycast|terminal|iterm2?|shell|zsh|bash)\b|\b(cmd|command) ?\+ ?space\b/;

function preciseCredential(folded) {
  const card = webCardNumber(folded);
  if (card) return card;
  const hit =
    firstHit(PRECISE, folded) ??
    firstHit(PRECISE_LABELLED, stripLabels(folded)) ??
    (LAUNCHER.test(folded) ? firstHit(PRECISE_LABELLED, folded.replace(/["'«»「」]/g, " ")) : null) ??
    firstHit([SEED], folded.replace(ABOUT, " "));
  if (hit) return hit;
  for (const c of clauses(folded)) {
    if (!ACCESS.test(c)) continue;
    if (PASSWORDS_APP.test(c)) return c;
    const named = firstHit(PRECISE_LABELLED, c.replace(CONTENT_LABEL, " "));
    if (named) return named;
  }
  return null;
}

// ── Broad words (the fallback on a step with no verdict) ───────────────

const CRED_OBJECT = String.raw`(pass ?-?words?|passcodes?|passkeys?|passphrases?|pwd|pw|pins?(?!\s+(on|from|in)\s+pinterest)|2fa|mfa|totp|otp|one-time (codes?|passwords?)|(sign|log)-? ?in (codes?|details|info)|verification codes?|security codes?|auth(entication)? codes?|(?<!(design|input|output|prompt|completion|context|cached) )tokens?(?!\s+(usage|counts?|limits?|budget|costs?|files?|spent|used))|api ?keys?|secrets?(?!\s+santa)|seed (phrase|words)|recovery (phrase|words|keys?|codes?)|private keys?|cvv|cvc|expiry|expiration( date)?|ssn|social security (number|no)|card (number|details)|(credit|debit) card(?!\s+(transactions?|statements?|page|tab|bills?|balance|payments?|rewards|offers|limit|activity|due))|credentials?|(?<!(daily|weekly|monthly|failed|recent|user|active) )logins?(?!\s+(items?|page|screen|url|link|button|history|window))|digits on the back)`;
/** The credential verbs with their -s, -ed and -ing forms ("typing my password", "entering the PIN"). */
const CRED_VERB = String.raw`typ(e|es|ed|ing)|enter(s|ed|ing)?|input(s|ted|ting)?|past(e|es|ed|ing)|fill(s|ed|ing)?|put(s|ting)?|auto-?fill(s|ed|ing)?|reveal(s|ed|ing)?|read(s|ing)?|show(s|ed|ing|n)?|cop(y|ies|ied|ying)|dictat(e|es|ed|ing)|unlock(s|ed|ing)?`;
const CRED_PATTERNS = [
  // Key and token prefixes.
  /(?<![\w-])(sk-(ant-)?[\w-]{4,}|ghp_\w{8,}|gh[ousr]_\w{8,}|github_pat_\w+|akia[0-9a-z]{12,}|xox[abprs]-[\w-]+|eyj[\w-]{8,}\.[\w-]+|-----begin)/,
  // Secret paths and files.
  /(^|[\s/("'=:])\.env(\.[\w-]+)?(?![\w-])|\benv files?\b|(^|[\s/~("'])\.(ssh|gnupg|aws|netrc|npmrc|pgpass|kube|docker)\b|\bid_(rsa|dsa|ecdsa|ed25519)\b|\.(pem|p12|pfx|keystore|jks)\b|\bwallet\.dat\b|\bsecrets?\.(ya?ml|json|txt|env|toml)\b|\bcredentials?\.(json|ya?ml|csv|txt)\b|\bservice account (json|key)|~\/\.config\//,
  // Password managers, authenticators, browser password stores (not their help pages).
  new RegExp(
    String.raw`\b(1 ?password|bitwarden|dashlane|lastpass|roboform|enpass|nordpass|proton ?pass|strongbox|keepass\w*|keychain( access)?|passwords?\.app|passwords app|apple passwords|${NOT_THE_APP}password manager|authy|authenticator|2fas|raivo|otp ?auth|about:logins|chrome:\/\/settings\/(autofill|passwords))\b(?!( access| app)? (help|docs|documentation|guide)\b)|\b(open|launch|start|bring up|switch to)\s+(the\s+)?(apple\s+)?passwords\b(?!\s*(help|docs|page|report|folder|file|doc|spreadsheet|list))|\b(open|launch|start)\s+keeper\b(?!\s+notes?)|\bsettings\s*(>|,)?\s*(go to |open )?autofill\b`,
  ),
  // A credential verb with its object, in one clause.
  // The object may sit inside an identifier: "STRIPE_SECRET_KEY" (an underscore is a boundary here).
  new RegExp(String.raw`\b(${CRED_VERB}|tell me|say|speak|give me|get me)\b[^.;,]{0,40}?(?<![a-z0-9])${CRED_OBJECT}(?![a-z0-9-])`),
  // A one-time code: "type the code 482913", "enter the SMS code 301 772", "read the 6-digit number".
  new RegExp(String.raw`\b(${CRED_VERB})\b[^.;,]{0,20}?(\b\d-digit (code|number)\b|\bcode \d{4,8}\b|\bcode \d{3}[\s-]\d{3}\b)`),
  // Typing or pasting into a verification box: "paste the copied code into the verification box".
  new RegExp(String.raw`\b(${CRED_VERB})\b[^.;]{0,40}\b(verif(y|ication)|2fa|mfa|otp|one-time|security code|confirmation code|sms code)\s+(box|field|input|code)\b`),
  // Typing into the field under the email, a login form, signing in with something, the eye next to a password.
  /\b(fill|type|enter)\b[^.;]{0,40}\b(login|log-? ?in|sign-? ?in) (form|page|field|screen)\b|(^|[,;]\s*|\b(and|then|to|please|first)\s+)(sign|log)-? ?(in|on)\b[^.;]{0,40}\bwith\b|\bunlock\b[^.;]{0,40}\breveal\b|\bfind-(generic|internet)-password\b|\beye( icon| button)?\b[^.;,]{0,30}\bpass ?words?\b/,
  // Not English.
  /\b(contrasena|passwort|kennwort|mot de passe|senha|parola d'ordine)\b|密码|口令|パスワード|암호|비밀번호/,
];
/** "Log in: type the email, then the password X": a secret typed as the next item of a typing step. */
const THEN_SECRET = new RegExp(String.raw`\b(${CRED_VERB})\b[^;]*?\b(then|and)\s+(the |my |your )?(pass ?-?words?|passcodes?|pins?|passphrases?)\s+(?!(field|box|input|reset|page|settings|manager|policy|hint|rules?|screen)\b)\S`);
/** A step that is only the word: "password", "pass-word", "p4ssword". */
const BARE = new RegExp(String.raw`^(the |my )?${CRED_OBJECT}$`);
const unLeet = (w) => w.replace(/[4@]/g, "a").replace(/0/g, "o").replace(/3/g, "e").replace(/[$5]/g, "s").replace(/1/g, "i");
/** Reading about a topic is not reading the secret: "the article about passkeys". */
const ABOUT = /\b((bug )?reports?|tickets?|issues?|articles?|posts?|notes?|memos?|emails?|messages?|pages?|sections?|chapters?|books?|courses?|lessons?|polic(y|ies)|tips|stor(y|ies)|news|blogs?|videos?|threads?|podcasts?|episodes?|docs?|documentation|guides?|tutorials?|reviews?)\s+(about|on)\b[^,;]*/g;

/** The field under the email or username on a sign-in form is the password field, unless the step types a plain value. */
const FIELD_UNDER = /\b(field|box) (under|below|after|beneath|next to) (the )?(email|e-mail|username|user name|login)\b/;
const PLAIN_ENTRY =
  /\b(type|enter|put|fill( in)?|write|input)\s+(in\s+)?(my |the |your |an? |his |her |our )?(full |first |last |home |work |street )?(name|address|e-?mail( address)?|user ?name|phone( number)?|company|city|zip( code)?|date)\b/;
const fieldUnder = (w) => clauses(w).find((c) => FIELD_UNDER.test(c) && !PLAIN_ENTRY.test(c)) ?? null;
/**
 * Quoted text with a space in it is reported text ("type 'Password field is broken'"), not a field's label. Double quotes
 * pair in order from the start, so a label's closing quote never pairs with the value's opening one.
 */
const QUOTED_PAIRS = /"[^"]*"|'[^'\s]*\s[^']*'/g;
const dropQuotedText = (w) => w.replace(QUOTED_PAIRS, (q) => (/\s/.test(q) ? " " : q));
/** Typing into a field named for a secret: 'type hunter2 in the "Password" field', "the field labeled Password". */
const SECRET_NAME = String.raw`(pass ?-?words?|passcodes?|pins?|passphrases?)`;
const SECRET_FIELD = new RegExp(
  String.raw`\b${SECRET_NAME}["']?\s*(field|box|input|text ?box)\b|\b(field|box|input|text ?box)\s+(labell?ed|called|named|titled|marked)\s+["']?${SECRET_NAME}\b`,
);
const TYPES = /\b(type|enter|paste|fill|input|key in|put|write)\b/;
function secretField(folded) {
  const text = dropQuotedText(folded).replace(ABOUT, " ");
  return TYPES.test(text) ? (text.match(SECRET_FIELD)?.[0] ?? null) : null;
}

function broadCredential(w) {
  const text = w.replace(ABOUT, " ");
  const hit = firstHit(CRED_PATTERNS, text) ?? fieldUnder(text) ?? text.match(THEN_SECRET)?.[0] ?? null;
  if (hit) return hit;
  if (!text.includes(" ") && (BARE.test(text) || BARE.test(unLeet(text)))) return text;
  return null;
}

// ── Money ────────────────────────────────────────────────────────────────

/** Text typed or added as words ("type 'buy milk'", "add 'pay rent' to the list") is not an action. */
const TYPED_TEXT = /\b(type|add|write|enter|put|note|search( for)?|rename (it )?to|title (it)?)\s+("[^"]*"|'[^']*')/g;
/** A number typed into a spreadsheet cell, or a reminder or note about paying, is not paying. */
const NOT_PAYING = [
  /\b(type|enter|write|put|fill( in)?)\s+(?:[^,;]|(?<=\d),(?=\d))*?\b(in|into)\s+(the\s+)?(cell|column|row|spreadsheet|sheet|calculator)\b[^,;]*/g,
  /\b(set|create|add|make|schedule|start)\s+(a |an |the |my )?(reminder|note|task|to-?do|event|calendar event|sticky note|alarm|list|shopping list|wish ?list|gift list)s?\b[^,;]*?(?=[,;]|\band\b|\bthen\b|$)/g,
  // Up to the clause break: "edit the address and buy it" still buys.
  /\b(remind me|new note|draft|write|edit)\b[^,;]*?(?=[,;]|\band\b|\bthen\b|$)/g,
  // Adding words to a list: "add renew passport to my to-do list".
  /\badd\b[^,;]*?\bto (my |the |a |his |her )?(to-?do |task |shopping |grocery |reading |wish ?|gift |packing )?(list|reminders|tasks|notes)\b/g,
  // Formatting a sheet or a slide: its amounts are content ("highlight the rows over $500", "set the heading to $2M").
  /\b(highlight|format|bold|colou?r|shade|set|change|update)\b[^,;]*?\b(rows?|cells?|columns?|sheets?|spreadsheets?|slides?|headings?|titles?|charts?|captions?|labels?)\b[^,;]*?(?=[,;]|\band\b|\bthen\b|$)/g,
  // The store named Best Buy.
  /\bbest buy\b/g,
];
/**
 * A clause that acts inside Hydra (its own pages and rows: it never pays): "in Hydra", "Hydra's budget page". Naming
 * Hydra is not enough ("pay the bill Hydra found"). Also a clause that moves a file or folder.
 */
const IN_HYDRA = /\b(in|on|inside|within|into|to|from) hydra\b(?!('s)? (\w+ )?(wish ?list|cart)\b)|\bhydra('s)? (\w+ ){0,2}(page|tab|panel|app|screen|view|table|dashboard|settings|ledger|sidebar|window|transactions|rows|entries|records|categories|budgets?|reports?)s?\b/;
const NOT_PAYING_CLAUSE = new RegExp(
  String.raw`${IN_HYDRA.source}|^move\b[^;]*\b(folders?|files?|statements?|spreadsheets?|sheets?|documents?|docs?|pdfs?|notes?|photos?|\w+\.[a-z]{2,4})\b`,
);
/** A clause that only looks: open, show, find, read, play... (unless it opens a position or checks out a cart). */
const LOOKS =
  /^(open|show|find|read|view|look|scroll|play|arrange|sort|search|go|navigate|switch|list|check|see|watch|launch|bring|focus|hide|minimi[sz]e|zoom|preview|share|quit)\b(?!\s+(a |an |my |the )?(new )?(long |short )?positions?\b)(?!\s+out\b[^.;]*\b(cart|basket|bag|order)\b)/;
/** ...but a look clause that goes on to pay still pays: "open Venmo to pay Sam", "go pay the bill", "go to checkout". */
const LOOK_PAYS =
  /^check-? ?out$|(?<!\bgit )\bcheckout\b(?!\s+(branch|page|screen|flow|design|form|ui|mock-?ups?|templates?|code|component)\b)|^(go|come)\s+(and\s+)?(pay|buy|purchase|order|send|transfer|tip|donate|subscribe|check-? ?out)\b|\bto (pay|buy|purchase|order|send money|transfer money|tip|donate|subscribe|wire|venmo|zelle)\b|\bcheck-? ?out (with|using|via|now)\b|\bto (the )?check-? ?out\b|\b(button|link|tab|option)\s+(that\s+)?(called|named|labell?ed|titled|says|saying)\s+(pay|buy|purchase|order|place|checkout|check out|subscribe|send|confirm|complete)\b/;
/** An amount of money. "pounds" alone is a weight too, so it counts only next to a send or transfer. */
const amount = (pounds) =>
  String.raw`([$€£¥]\s?\d|\d[\d,.]*\s?([$€£¥]|(dollars?|bucks|usd|eur|euros?|gbp|${pounds ? "pounds|" : ""}yen|btc|eth|usdc|usdt|sol)\b)|\b(usd|eur|gbp) ?\d)`;
/** "Order the list alphabetically", "order the rows by date": sorting, not buying. */
const NOT_SORT = String.raw`(?![^;]*\b(alphabetically|chronologically|numerically|ascending|descending|by (date|name|price|size|title|type|time|kind|newest|oldest|rating|relevance|priority|status|due date|amount|length|number))\b)`;
const MONEY_PATTERNS = [
  /\b(apple ?pay|google ?pay|g ?pay|auto ?pay|bill ?pay|re ?pay\w*|pre ?pay\w*|payroll|pay|pays|paying|payment|payments)\b(?!\s+(attention|heed|tribute|respects?|a visit)\b)/,
  /\b(buy|buys|buying|bought|purchas\w*|pre-?orders?|pre-?ordering|1-click|one-click|ordering)\b|\bre-?order\w*\b(?=\s+(my |the |that |this )?(last|previous|same|again|it)\b)/,
  new RegExp(
    String.raw`\b(place|submit|complete|confirm|put in)( (the|an|my|your|this|a))?( [a-z-]+){0,2} orders?\b|\border (it|the|a|an|this|that|my|now|\d)\b${NOT_SORT}|(^|; )order\b${NOT_SORT}|\b(click|tap|press|hit|select)\s+(the\s+)?orders?\b(?!\s+(history|details|status|numbers?|page|tab|summary|list))`,
  ),
  /(?<!\bgit )\bcheck-?out\b(?! branch)|\bcheck out (the |my |your )?(cart|basket|bag|order)\b|\bcheck-? ?out (with|using|via|now)\b|(^|; )check-? ?out( ;|$)/,
  /\bsubscrib\w*\b(?![^.;]*\b(channels?|newsletters?|podcasts?|calendars?|feeds?|playlists?|mailing lists?|notifications?|updates|repos?|rss|alerts?)\b)|\brenew\w*\b|\bupgrade\b[^.;]*\b(plan|premium|plus|tier|subscription|membership)\b|\bupgrade to (the )?(pro|premium|plus)\b|\b(book|reserve)\b.*\bconfirm\w*|\bbook\w*\s+(a |an |the |my |that |this )?(\w+ )?(flights?|hotels?|rooms?|tickets?|tables?|rides?|ubers?|lyfts?|stays?|rentals?|trips?|seats?|airbnb)\b/,
  /\bswap\w*\b(?=[^.;]*(\d|\b(eth|btc|usdc|usdt|sol|tokens?|coins?|crypto)\b))|\b(trade|trades|trading|traded|sell|sells|selling|liquidat\w*|stake|staking|rebalanc\w*|exercise)\b|\bshort \d[\d,.]*(?!\s*(seconds?|secs?|s\b|minutes?|mins?|hours?|days?|frames?|ms\b|clips?))|(^|; )(open|close)( a| an| my| the)?( new)?( long| short)? positions?\b/,
  /\b(remit\w*|ach|zelle|venmo|wire|wiring|withdraw\w*)\b|\bdeposit\w*\b[^.;]{0,30}\d/,
  new RegExp(String.raw`\b(send|transfer\w*|move|give|fund|tip|top-? ?up)\b[^.;]{0,40}?(${amount(true)}|\b(checking|savings|account|bank|brokerage|wallet|iban|landlord)\b)`),
  /\b(send|transfer|move|give|fund|tip|top-? ?up)\s+(\p{L}+\s+)?\d[\d,.]*(?=\s+(to|from|into|for)\b|\s*$)/u,
  /\b(send|transfer|move|wire|give)\w*\s+(the\s+|some\s+|my\s+)?(money|cash|funds|payment|crypto|bitcoin)\b/,
  /\b(refund\w*|bid|bids|bidding|add funds|top-? ?up|cash ?out|donat\w*|redeem\w*|settle\w*|tuition)\b|\btip (the|my|\d)|\bauthori[sz]e\w* (the |a )?(charge|payment|transaction)|\b(complete|confirm|approve|submit|authori[sz]e|finali[sz]e)\w* (the |a |my |this )?(transaction|purchase|payment|transfer|wire|withdrawal|deposit|trade|booking|reservation|subscription)s?\b|\bconvert\b[^.;]*\b(usd|eur|gbp|yen|btc|eth|currency)\b/,
  new RegExp(amount(false)),
  /\b(pagar|pague|pago|payer|payez|paie|bezahl\w*|zahlen|comprar|compra|acheter|achetez|kaufen|kauf|transferir|uberweis\w*|ueberweis\w*|virement)\b|支付|付款|购买|購買|买|購入|支払|払う/,
];
const MONEY_SURFACE =
  /\b(chase|bank of america|wells fargo|capital one|amex|american express|venmo|cash ?app|paypal|zelle|wise|revolut|robinhood|webull|fidelity|schwab|vanguard|interactive brokers|ibkr|etrade|coinbase|kraken|binance|uniswap|metamask|phantom|stripe|amazon|doordash|uber eats|instacart|app store|in-app|gofundme|namecheap|steam wallet|cart|bank (site|page|app))\b/;
/** On a money surface, a step that commits or presses, unless it presses a tab, a widget, a chart or "Return items". */
const ACTS = /\b(confirm|approve|submit|schedule|continue|send|accept|authori[sz]e|proceed|finish|click|press|tap|hit|get|select|choose)\b/;
const NOT_A_BUY =
  /\b(tabs?|widgets?|charts?|graphs?|returns?|return items|history|activity|statements?|balances?|receipts?|transactions?|revenue|numbers|directions|branch(es)?|play|podcasts?|emails?|settings|search|menus?|sidebar|notifications?|help|invites?|invitations?|meetings?|watching|shows?|episodes?|movies?|prime video)\b|\bto (see|view|check|read|show)\b/;

function broadMoney(w) {
  const text = NOT_PAYING.reduce((t, re) => t.replace(re, " "), stripLabels(w).replace(TYPED_TEXT, " "));
  const acting = clauses(text).filter((c) => (!LOOKS.test(c) || LOOK_PAYS.test(c)) && !NOT_PAYING_CLAUSE.test(c));
  if (!acting.length) return null;
  const doing = acting.join(" ; ");
  const hit = firstHit(MONEY_PATTERNS, doing);
  if (hit) return hit;
  const surface = text.match(MONEY_SURFACE);
  if (surface && ACTS.test(doing) && !NOT_A_BUY.test(doing) && !IN_HYDRA.test(text)) return surface[0];
  return null;
}

/**
 * The hard limit of a call (see the header). Credential wins over money. Null: none.
 * tag: the turn model's verdict. It only adds: "none" removes nothing, every layer runs on every call.
 */
export function hardMatch(tag, words) {
  const folded = foldHard(words);
  const cred = preciseCredential(folded) ?? broadCredential(stripLabels(folded)) ?? secretField(folded);
  if (tag === "credential" || cred) return { kind: "credential", phrase: cred ?? "" };
  const pay = broadMoney(folded);
  if (tag === "money" || pay) return { kind: "money", phrase: pay ?? "" };
  return null;
}
export const hardLimit = (tag, words) => hardMatch(tag, words)?.kind ?? null;
/** A credential verb right before its object ("read me the verification code", "copy my password"), with at most two
 *  words between, and not an account's or a price's word after it ("my Coinbase token balance"). */
const TURN_CRED = new RegExp(String.raw`\b(${CRED_VERB}|tell me|say|speak|give me|get me)\s+(me\s+)?((the|my|your|a|an|this|that|our|his|her)\s+)?([a-z0-9'-]+\s+){0,2}?${CRED_OBJECT}(?![a-z0-9-])(?!\s+(balances?|prices?|holdings|values?|worth|invoices?|receipts?|statements?|transactions?|bills?|rewards|offers?|reset|policy|settings|page|help|docs?|manager|app)\b)`);
/** A turn's words that ask to read, type or show a credential (connectorGate: such a turn runs no connector): a card
 *  number or a key in them, a seed phrase, a command that prints secrets, a one-time code typed, or a credential verb
 *  with its object (TURN_CRED). Release round 2: not hardMatch's whole broad layer, so a turn that only names a
 *  password manager, a card or a token ("find the 1Password invoice", "my new debit card", "my Coinbase token
 *  balance") still reads the owner's mail. */
export function credentialTurn(words) {
  const folded = foldHard(words), text = folded.replace(ABOUT, " ");
  return webCardNumber(folded) ?? firstHit(PRECISE, folded) ?? firstHit([SEED, TURN_CRED, CRED_PATTERNS[4]], text) ?? null;
}

// ════════════════════════════ Part 2: the Mac's own judges ════════════════════════════

/** An amount of money (the Mac's: "pounds" counts, a price button says $, € or £ anyway). */
/** The web's foldHard on any value (it takes a string only): a missing label folds to ''. */
const fold = (x) => foldHard(String(x ?? ''));
export const AMOUNT = String.raw`([$€£¥]\s?\d|\d[\d,.]*\s?([$€£¥]|(dollars?|bucks|usd|eur|euros?|gbp|pounds|yen|btc|eth|usdc|usdt|sol)\b)|\b(usd|eur|gbp) ?\d)`;

// ── Cards ────────────────────────────────────────────────────────────────

// Every decimal digit script's zero (Arabic-Indic, Extended Arabic-Indic, Devanagari, Bengali, Thai, Myanmar...).
// Fullwidth digits are folded by NFKC.
const ZEROS = [0x660, 0x6f0, 0x7c0, 0x966, 0x9e6, 0xa66, 0xae6, 0xb66, 0xbe6, 0xc66, 0xce6, 0xd66, 0xde6, 0xe50, 0xed0, 0xf20, 0x1040, 0x1090, 0x17e0, 0x1810, 0x1946, 0x19d0, 0x1a80, 0x1a90, 0x1b50, 0x1bb0, 0x1c40, 0x1c50, 0xa620, 0xa8d0, 0xa900, 0xa9d0, 0xaa50, 0xabf0];
/** Any script's digits as ASCII digits. */
export const asciiDigits = (s) => String(s ?? '').normalize('NFKC').replace(/\p{Nd}/gu, (d) => {
  const c = d.codePointAt(0);
  if (c < 0x80) return d;
  const z = ZEROS.find((z0) => c >= z0 && c <= z0 + 9);
  return z == null ? d : String(c - z);
});
// Card brands by prefix (IIN) and length. A Luhn-valid run with no brand's prefix and length is not a card: IMEIs (15
// digits, no 15-digit brand but Amex 34/37), timestamps, ISBNs, most tracking numbers.
// ponytail: the brands here only (Visa 16/19, Mastercard, Amex, Diners, Discover, JCB, UnionPay, Maestro, Mir, RuPay,
// UzCard, Humo, Troy, Verve); a rare brand's card passes. Ceiling: a run of other digits that fits a brand and Luhn
// (1 in 10 for a fitting run) is refused, so a Luhn-valid 16-digit id that starts with 4 (Stripe's test card
// 4000 0000 0000 0002 among them) is refused like a card. Visa's old 13-digit cards are left out on purpose (too many
// false matches, none issued for years).
const BRANDS = [
  [/^4/, [16, 19]], [/^(5[1-5]|2[2-7])/, [16]], [/^3[47]/, [15]], [/^3(0[0-5]|[689])/, [14, 16]],
  [/^6(011|4[4-9]|5)/, [16, 17, 18, 19]], [/^35(2[89]|[3-8])/, [16, 17, 18, 19]], [/^62/, [16, 17, 18, 19]],
  [/^(50|5[6-8]|6[37])/, [13, 14, 15, 16, 17, 18, 19]], [/^220[0-4]/, [16, 17, 18, 19]],
  [/^(60|65|81|82|508)/, [16]], [/^(8600|9860)/, [16]], [/^9792/, [16]], [/^(506[01]|507[89]|650[0-2])/, [16, 18, 19]],
];
const isCard = (d) => luhn(d) && BRANDS.some(([re, lens]) => re.test(d) && lens.includes(d.length));
// The separators people put between a card's groups: spaces, tabs and line breaks, dots, commas, colons, plus, an x,
// slashes, underscores, every dash, bullets and stars.
const SEP = String.raw`\s*[.,:+x×*·•/_\-‐-―−]\s*|\s+`;
const RUN = new RegExp(String.raw`\d+(?:(?:${SEP})\d+)*`, 'g');
// How a card is written (round 4: a list of numbers is no card): whole (one group of 13-19), or in groups the way a
// card is printed, with one separator between every group: fours (the last one 1 to 4: 13, 16 and 19 digits), Amex's
// 4-6-5, Diners' 4-6-4, or digit by digit. A comma or a colon never joins two groups (a list, times of day), nor do two
// kinds of separator, and every window needs the brand's prefix and length and Luhn. ponytail: a card typed in pairs or
// triples passes this check (the field's label, the boxes join and key-by-key typing still see it); a run of fours of
// other digits that fits a brand and Luhn (1 in 10 of the fitting ones) is refused like a card.
const cardGroups = (g, seps) => {
  if (g.length === 1) return true;
  if (new Set(seps).size !== 1 || /, /.test(seps[0])) return false;
  const s = g.join('-');
  // A comma or colon with no space only between fours ("4242,4242,4242,4242"); a list's ", " and times never.
  if (/[,:]/.test(seps[0]) && !/^(4-)+4$/.test(s)) return false;
  // A stray split in the last group ("4242 4242 4242 424 2") is still fours.
  return g.every((n) => n === 1) || /^(4-)+[1-4]$/.test(s) || (/^(4-){2,}[1-3]-[1-3]$/.test(s) && g.at(-1) + g.at(-2) === 4) || s === '4-6-5' || s === '4-6-4';
};
// A separator as it is written: spaces alone are one space, ", " stays (a list), others lose their spaces (" - " is "-").
const sepOf = (x) => { const t = x.replace(/\s+/g, ' '); return !t.trim() ? ' ' : t.trim() === ',' ? t.trimStart() : t.trim(); };
/** A card number anywhere: each run of digit groups is tried group-aligned, every 13-19 digit window written as a card
 *  is (cardGroups), with the brand's prefix and length and Luhn. A run is never joined to the next value across a word,
 *  and a single group of more than 19 digits (a tracking number) is not a card. */
export function cardNumber(w) {
  const text = asciiDigits(w);
  for (const m of text.matchAll(RUN)) {
    const groups = m[0].match(/\d+/g), seps = (m[0].match(/\D+/g) ?? []).map(sepOf);
    for (let i = 0; i < groups.length; i++) {
      let digits = '';
      for (let j = i; j < groups.length; j++) {
        digits += groups[j];
        if (digits.length > 19) break;
        if (digits.length >= 13 && cardGroups(groups.slice(i, j + 1).map((x) => x.length), seps.slice(i, j)) && isCard(digits)) return m[0];
      }
    }
  }
  return null;
}

// ── Keys, tokens and other secrets in typed text ─────────────────────────

// Key and token prefixes (on folded, lower-case text): the web's precise layer's (AWS AKIA and ASIA, AIza at 20+,
// Stripe, GitHub, GitLab, Slack, JWTs, PEM) and other common providers' (Stripe webhooks, npm, Hugging Face, Groq, xAI,
// SendGrid, DigitalOcean, Shopify, Supabase, Google OAuth access tokens, OpenRouter).
const KEY_SHAPES = /(?<![\w-])(sk-(ant-|proj-|or-v1-|admin-)?[\w-]{4,}|sk_[0-9a-f]{32,}|sk[0-9a-f]{32}(?![0-9a-z])|pplx-\w{20,}|lin_api_\w{20,}|ntn_\w{20,}|secret_\w{20,}|r8_\w{20,}|key-[0-9a-f]{32}|pypi-[\w-]{20,}|gocspx-[\w-]{16,}|sntry[su]_[\w=-]{20,}|pmak-[\w-]{20,}|atatt[\w=-]{20,}|dp\.(st|pt|ct|sa|scim|audit)\.[\w.-]{16,}|vercel_\w{16,}|[sr]k_(live|test)_\w{8,}|aiza[\w-]{20,}|gh[pousr]_\w{8,}|github_pat_\w+|glpat-[\w-]{10,}|xox[abprs]-[\w-]+|(akia|asia)[0-9a-z]{16}\b|eyj[\w-]{8,}\.[\w-]+|-----begin|whsec_\w{8,}|npm_\w{30,}|hf_[a-z0-9]{20,}|gsk_\w{16,}|xai-[\w-]{16,}|sg\.[\w-]{8,}\.[\w-]{8,}|dop_v1_\w{8,}|shp(at|ss|ca|pa)_\w{8,}|sbp_\w{8,}|ya29\.[\w-]{8,}|dckr_pat_[\w-]{16,}|nfp_\w{16,}|rnd_\w{16,}|sq0(atp|csp|idp)-[\w-]{16,}|a3-[a-z0-9]{6}-[a-z0-9]{6}(-[a-z0-9]{5}){4}|(?<![0-9a-f])[0-9a-f]{37}(?![0-9a-f]))/;
// Keys with no prefix: a 32-hex key (Fish Audio, Mailgun's newer ones; an MD5 hash typed is refused like one), a Telegram
// bot token, Slack's and Discord's webhook addresses (the address is the secret) on folded text; Discord's bot token and
// an Azure storage key, case kept.
const HEX32 = /(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/;
const BOT_TOKEN = /(?<!\d)\d{8,10}:[\w-]{35}(?![\w-])/;
const WEBHOOK = /hooks\.slack\.com\/services\/[\w/]{20,}|discord(app)?\.com\/api\/webhooks\/\d+\/[\w-]{20,}/;
const DISCORD_TOKEN = /(?<![\w-])[MNO][\w-]{23,27}\.[\w-]{6}\.[\w-]{27,40}(?![\w-])/;
const AZURE_KEY = /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{86}==(?![A-Za-z0-9+/=])/;
/** A token that looks machine-made: 24 or more letters, digits, _ and - with upper and lower case and digits in three
 *  or more places and six digits or more ("Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56"). ponytail: a long camelCase name with six digits in three places is
 *  refused like a key; a shorter or all-lower-case token passes (the prefix list catches the common ones). */
const randomToken = (raw) => raw.split(/\s+/).find((t) => /^[A-Za-z0-9_-]{24,}$/.test(t) && /[A-Z]/.test(t) && /[a-z]/.test(t) && (t.match(/\d+/g) ?? []).length >= 3 && (t.match(/\d/g) ?? []).length >= 6) ?? null;
/** A strong password's shape: one word of 8 to 64 characters with three of upper case, lower case, digits and symbols, not
 *  an address, a path or a number. A pasted clipboard and a value typed next to a key's name are refused when they are
 *  one (what is typed as a plain word elsewhere stays the owner's text). */
export const strongSecret = (text) => {
  const t = String(text ?? '').trim();
  if (!/^\S{8,64}$/.test(t) || /^([a-z][a-z0-9+.-]*:|www\.|[~/.])/i.test(t) || /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(t)) return false;
  return [/[A-Z]/, /[a-z]/, /\d/, /[^\w\s]|_/].filter((re) => re.test(t)).length >= 3;
};
/** A variable's or field's name that says a secret goes in its value: API_KEY, STRIPE_SECRET_KEY, DB_PASSWORD, token. */
/** Round 6: a name that ends in a secret's word (API_KEY, DB_PASSWORD, DB_PASS, GITHUB_TOKEN), not one with it inside
 *  (GOOGLE_AUTH_REDIRECT, TOKEN_COUNT, AUTHOR_NAME). */
export const SECRET_NAME_END = /(^|[_.-])(key|secret|token|password|passwd|pass|pwd|credentials?|private_?key|dsn|webhook(_url)?)$/i;
export const KEY_NAME = /^[\w.-]*(key|secret|token|password|passwd|pwd|credentials?|private|auth|dsn|webhook)[\w.-]*$/i;
// A URL with a password in it (postgres://user:hunter2@db...), and a bearer token.
const URL_PASSWORD = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/;
const BEARER = /\bbearer\s+[\w.~+/-]{16,}/;
// A private key in hex (an Ethereum key: 64 hex digits) or Bitcoin's WIF form (case kept: 5, K or L and base58).
const HEX_KEY = /(?<![0-9a-f])(0x)?[0-9a-f]{64}(?![0-9a-f])/;
const WIF_KEY = /(?<![1-9A-HJ-NP-Za-km-z])[5KL][1-9A-HJ-NP-Za-km-z]{50,51}(?![1-9A-HJ-NP-Za-km-z])/;
// An SSN only next to its name ("SSN 123-45-6789"): a bare NNN-NN-NNNN is a phone or an order number as often; a field
// called SSN is refused by its label (credentialLabel).
const SSN = /\b(ssn|social security( (number|no\.?))?|ss#)\W{0,3}(is\W{0,2})?\d{3}-\d{2}-\d{4}(?![\d-])/i;
// A seed phrase typed whole: 12, 15, 18, 21 or 24 words, every one on BIP39's list (a grocery list, colours or the
// NATO alphabet have words off it). The checksum is not checked, so a seed with a wrong word order or one typo in a
// word's ending still counts. ponytail: 12 plain words that are all on the list are refused like a seed.
const SEED_LENGTHS = new Set([12, 15, 18, 21, 24]);
const BIP39 = new Set(BIP39_WORDS);
// Written any way (round 4): split on spaces, commas, semicolons and line breaks, with "1." or "12)" numbering left out,
// and with one more word after it (a passphrase, the "25th word").
const seedPhrase = (raw) => {
  const words = raw.trim().toLowerCase().replace(/(^|[\s,;])\d{1,2}[.):]/g, ' ').split(/[\s,;|]+/).filter(Boolean);
  const n = [...SEED_LENGTHS].reverse().find((k) => k <= words.length && words.length - k <= 1);
  return n && words.slice(0, n).every((x) => BIP39.has(x)) ? raw.trim() : null;
};
// More providers' keys (case kept): GitLab runner tokens, Twilio account and key SIDs (AC/SK and 32 hex), Okta API
// tokens (00 and 40), Square access tokens (EAAA), a Solana keypair typed as its 64-number array.
const MORE_KEYS = /(?<![\w-])(glrt-[\w-]{16,}|(AC|SK)[0-9a-f]{32}|00[A-Za-z0-9_-]{38,42}|EAAA[\w-]{40,})(?![\w-])|^\s*\[(\s*\d{1,3}\s*,){63}\s*\d{1,3}\s*\]\s*$/;
// An AWS secret access key: exactly 40 of A-Z, a-z, 0-9, / and +, with both cases and a slash, a plus or three digits
// (a git SHA is lower-case hex, a camelCase name has no slash and few digits).
const AWS_SECRET = /(?<![A-Za-z0-9/+=])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])/;
const awsSecret = (raw) => [...raw.matchAll(new RegExp(AWS_SECRET, 'g'))].map((m) => m[0]).find((t) => /[A-Z]/.test(t) && /[a-z]/.test(t) && (/[/+]/.test(t) || (t.match(/\d/g) ?? []).length >= 3)) ?? null;
// A secret written into a command or a source line (round 4): NAME=value or NAME: "value" where the name says a
// password, secret, token or key ("export DB_PASSWORD=Hunter2!", 'DB_PASSWORD = "Tr0ub4dor&3"'), a client's password
// flag (mysql -pHunter2!, --password=X, sshpass -p X) and a password piped into sudo -S. Not a value read from
// somewhere else ($VAR, $(cmd), os.environ[...], getpass()), not a limit or a count (MAX_TOKENS=4000), not a URL or a
// path, not an empty or placeholder value.
const SECRET_NAME_WORD = String.raw`(?:[a-z_][\w.-]*?)?(pass(word|wd)?|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|auth[_-]?key|credentials?)s?`;
const NOT_SECRET_NAME = /max|min|limit|count|num|len|size|budget|usage|expir|ttl|timeout|url|uri|path|file|name|type|_id\b|prefix|header|endpoint|field|length|policy|hint|reset|rule|label|placeholder/i;
const ASSIGN_QUOTED = new RegExp(String.raw`(?<![\w-])(${SECRET_NAME_WORD})["']?\s*[:=]\s*(?<q>["'])(?![$%{<])([^"'\s]{4,})\k<q>`, 'i');
const ASSIGN_SHELL = new RegExp(String.raw`(?<![\w-])(${SECRET_NAME_WORD})=(?![$("'\`<{%])([^\s;|&]{4,})`, 'i');
const PASSWORD_FLAG = /\b(mysql|mysqldump|mysqladmin|mariadb)\b[^\n|;]*\s-p(?![\s-])\S{3,}|--pass(word)?[= ](?![$-])\S{3,}|\bsshpass\s+-p\s*(?![$-])\S{3,}|\becho\s+(?<e>["']?)(?!\$)[^|\n]{3,}\k<e>\s*\|\s*sudo\s+-\w*S/i;
const PLACEHOLDER = /^(none|null|nil|true|false|undefined|empty|changeme|change_me|xxx+|\*+|\.\.\.|your[\w-]*|<[^>]*>|example|placeholder|todo|redacted)$/i;
const assignedSecret = (raw) => {
  for (const re of [ASSIGN_QUOTED, ASSIGN_SHELL]) {
    const m = raw.match(re);
    if (!m) continue;
    const value = m.at(-1);
    if (NOT_SECRET_NAME.test(m[1]) || PLACEHOLDER.test(value) || /^(https?:|\/|~|\.\/)/i.test(value)) continue;
    return m[0];
  }
  return raw.match(PASSWORD_FLAG)?.[0] ?? null;
};
// A whole typed text that is a TOTP secret (base32, 16 or more of A-Z and 2-7, in groups of four too) or a Google app
// password (four groups of four lower-case letters).
const TOTP_SECRET = /^\s*(?=(?:[A-Z2-7]\s?){16,}\s*$)(?=.*[2-7].*[2-7])(?=(?:.*[A-Z]){8})[A-Z2-7]{4}(\s?[A-Z2-7]{4})+[A-Z2-7]*={0,6}\s*$/;
const APP_PASSWORD = /^\s*[a-z]{4} [a-z]{4} [a-z]{4} [a-z]{4}\s*$/;
// Round 6: a password or a code said in a message ("my Netflix password is Tr0ub4dor&3", "wifi: CoffeeShop / pw:
// Hunter2!2026", "login fixtureuser@example.test pass Hunter2!x", "The 2FA backup code is 8273-1928"): a strong-secret word right after
// a password word, or a code's digits right after a one-time or backup code's words. Not "the password is required",
// "pass the salt", "code is 404".
const SAID_PASSWORD = /(?<![\p{L}])(password|passwd|pwd|pw|pass|passcode|passphrase|passwort|contraseña|mot de passe|senha|wachtwoord|пароль|密码)(?![\p{L}])\s*(is|was|=|:|-|ist|es|est|é|is now)?\s*[:=]?\s*["'“]?(\S{8,64}?)["'”]?(?=[\s.,;!?)]*$|[\s,;)])/giu;
const SAID_CODE = /\b(2fa|mfa|otp|totp|backup|recovery|verification|one-time|security|sign-?in|login|auth(entication)?)( \w+)? codes?\s*(is|was|=|:|-)?\s*[:=]?\s*(\d{3,8}([ -]\d{3,8})*)\b|\b(pin|passcode)\s*(is|was|=|:)\s*\d{4,8}\b/i;
const saidSecret = (raw) => {
  for (const m of raw.matchAll(SAID_PASSWORD)) {
    const v = m[3].replace(/[.,;!?]+$/, '');
    // A bare "pass" or "pw" with no "is", ":" or "=" is a password only after a sign-in's user ("login fixtureuser@example.test pass
    // X"), not a verb ("pass Q3-Report to Sam").
    if (!m[2] && /^(pass|pw)$/i.test(m[1]) && !/(\b(login|user(name)?|e-?mail|account|wifi|wi-fi|ssid)\b|@)/i.test(raw.slice(0, m.index))) continue;
    if (strongSecret(v)) return m[0].trim();
  }
  return raw.match(SAID_CODE)?.[0] ?? null;
};
/** Text that is typed into a field (not a step's words): a card number, a key or token, a URL with a password, a bearer
 *  token, a private key, a seed phrase or an SSN. A path or a word like "password" in typed text is the text itself (a
 *  note, a search), checked elsewhere. */
export function typedCredential(text) {
  const raw = String(text ?? '').normalize('NFKC').replace(/\p{Cf}/gu, '');
  const w = fold(raw);
  return cardNumber(raw) ?? w.match(KEY_SHAPES)?.[0] ?? w.match(URL_PASSWORD)?.[0] ?? w.match(BEARER)?.[0] ?? w.match(HEX_KEY)?.[0]
    ?? w.match(HEX32)?.[0] ?? w.match(BOT_TOKEN)?.[0] ?? w.match(WEBHOOK)?.[0] ?? raw.match(DISCORD_TOKEN)?.[0] ?? raw.match(AZURE_KEY)?.[0]
    ?? raw.match(WIF_KEY)?.[0] ?? raw.match(SSN)?.[0] ?? seedPhrase(raw) ?? randomToken(raw) ?? raw.match(MORE_KEYS)?.[0] ?? awsSecret(raw)
    ?? assignedSecret(raw) ?? raw.match(TOTP_SECRET)?.[0]?.trim() ?? raw.match(APP_PASSWORD)?.[0]?.trim() ?? saidSecret(raw) ?? null;
}

/** The precise part of typedCredential: a card number, a known key or token prefix, a URL with a password, a bearer
 *  token, a bot token, a webhook address. For a value that is machine-made by design (an ID, a page token, a cursor:
 *  credentialArgs), where a random-looking token or 32 hex digits are the ID itself. */
export function preciseTyped(text) {
  const raw = String(text ?? '').normalize('NFKC').replace(/\p{Cf}/gu, '');
  const w = fold(raw);
  return cardNumber(raw) ?? w.match(KEY_SHAPES)?.[0] ?? w.match(URL_PASSWORD)?.[0] ?? w.match(BEARER)?.[0] ?? w.match(BOT_TOKEN)?.[0] ?? w.match(WEBHOOK)?.[0] ?? raw.match(DISCORD_TOKEN)?.[0] ?? null;
}

/** What a request typed so far, in pieces joined in order (round 6: four card boxes with clicks, hovers or waits between,
 *  a space key between two fills, a seed split over two steps): a card number in it, or a seed phrase at its end. */
export function piecesCredential(joined) {
  const raw = String(joined ?? '').normalize('NFKC');
  const card = cardNumber(raw);
  if (card) return card;
  const words = raw.trim().toLowerCase().replace(/(^|[\s,;])\d{1,2}[.):]/g, ' ').split(/[\s,;|]+/).filter(Boolean);
  for (const k of SEED_LENGTHS) if (words.length >= k && words.slice(-k).every((x) => BIP39.has(x))) return words.slice(-k).join(' ');
  return null;
}

// ── Files that hold sign-ins ─────────────────────────────────────────────

/** A file's name or path that holds sign-ins: a password export (passwords.csv, "Chrome Passwords.csv"), recovery or
 *  backup codes, a password manager's emergency kit, a seed or recovery phrase written down, an authenticator's backup.
 *  On top of the key files and sign-in stores the sidecar's read rules already refuse (safety.mjs SECRET). */
export const SECRET_FILE = /(^|\/)[^/]*\bpasswords?\.(txt|csv|tsv|json|xlsx?|numbers|1pux|1pif)$|(^|\/)[^/]*(recovery|backup)[-_ ]?codes?[^/]*$|(^|\/)[^/]*emergency[-_ ]?kit[^/]*$|(^|\/)[^/]*(seed|recovery|mnemonic|secret)[-_ ]?(phrase|words)[^/]*$|(^|\/)[^/]*authy[-_ ]?backup[^/]*$|(^|\/)logins?\.(csv|json)$|(^|\/)[^/]*(bitwarden|lastpass|dashlane|keeper|nordpass|enpass|roboform|proton[-_ ]?pass|1password|keepass\w*)[-_ ]?(vault[-_ ]?)?export[^/]*$|(^|\/)1passwordexport[^/]*$|\.(1pux|1pif|2fas)$|(^|\/)[^/]*(aegis|2fas|raivo|andotp|otpauth|freeotp|google[-_ ]?authenticator|authenticator)[-_ ]?(backup|export)[^/]*$|(^|\/)[^/]*(metamask|wallet|phantom|ledger|trezor|exodus|crypto|bitcoin|btc|eth)[^/]*(seed|mnemonic)[^/]*$|(^|\/)[^/]*mnemonic[^/]*$|(^|\/)[^/]*private[-_ ]?key[^/]*$|(^|\/)[^/]*wallet[-_ ]?backup[^/]*$|(^|\/)UTC--\d{4}-[^/]*$|(^|\/)keystore[^/]*\.json$|(^|\/)([\w-]+ )?(my |all |old |new )?(passwords?|logins?|passcodes?)([-_ ](\d[\w-]*|backup|export|list|old|new|copy|final|all|vault|\(\d+\)))?\.(txt|rtf|rtfd|md|markdown|docx?|pages|pdf|csv|tsv|xlsx?|numbers|json|ya?ml|odt|ods|kdbx|note)$|(^|\/)([\w-]+ )?(credentials?|api[-_ ]?keys?|access[-_ ]?keys?|secret[-_ ]?keys?|api[-_ ]?tokens?|access[-_ ]?tokens?|secrets|ssh[-_ ]?keys|api[-_ ]?keys|secret[-_ ]?tokens)([-_ ](\d[\w-]*|backup|export|list|old|new|copy|final|all|vault|\(\d+\)))?\.(txt|rtf|docx?|pages|pdf|csv|xlsx?|numbers)$|(^|\/)(api[-_ ]?keys?|api[-_ ]?tokens?|access[-_ ]?tokens?|secret[-_ ]?keys?)\.(json|ya?ml|env|toml)$|(^|\/)[^/]*recovery[-_ ]?keys?[^/]*$|(^|\/)[^/]*(metamask|phantom|ledger|trezor|exodus|seed)[-_ ]?backup[^/]*$|(^|\/)(2fa|mfa|otp|totp)([-_ ]?(codes?|backup|secrets?|keys?))?\.(txt|csv|json|pdf|rtf|md)$|(^|\/)[^/]*(passwörter|passworter|passwort|kennwörter|kennworter|kennwort|contraseñas|contrasenas|contraseña|mots? de passe|senhas|wachtwoorden|lösenord|losenord|hasła|hasla|пароли|密码|密碼|パスワード|비밀번호)[^/]*\.(txt|rtf|rtfd|md|docx?|pages|pdf|csv|tsv|xlsx?|numbers|json|odt|ods|note)$|(^|\/)[^/]*(recovery|seed|backup|wallet)[-_ ]?(sheet|card|phrase)s?[^/]*$/i;
/** The web's own secret-file words (Part 1's precise layer): a window title that names one ("vim .env") is a secret
 *  file's window. */
export const WEB_SECRET_FILE = PRECISE_LABELLED[0];

// ── A field that takes a credential ──────────────────────────────────────

// Kept in sync with CRED_FIELD in src-tauri/hands/main.swift (the helper refuses typing into these itself). On a
// folded label (no accents, lower case) and on the raw lower-case one.
const CRED_FIELD = new RegExp([
  // Passwords in many languages (Polish hasło keeps its ł through folding).
  String.raw`pass ?(word|wd|code|phrase|key)|passwort|\bpwd\b|^pw$|kennwort|contrasena|contraseña|mot de passe|senha|parola d'ordine|^parola$|wachtwoord|losenord|lösenord|adgangskode|haslo|hasło|heslo|jelszo|jelszó|sifre|şifre|kata ?sandi|mat khau|mật khẩu|salasana|lozinka|geslo|parool|jelszó|κωδικ(ος|ός) προσβασης|κωδικός πρόσβασης|סיסמה|סיסמא|كلمة (ال)?(مرور|سر)|รหัสผ่าน|пароль|密码|密碼|口令|パスワード|暗証番号|비밀번호|암호|पासवर्ड|रहस्यशब्द|^clave$|clave de acceso|clave secreta|^nip$|geheimzahl|geheimnummer`,
  // A PIN, alone or with its kind: "PIN", "Enter PIN", "Card PIN" (not "Pin title", "Pin to top").
  String.raw`^((enter|your|card|atm|sim|new|current|confirm|security|bank|debit) )?pin( ?(number|#|code))?[ :*]*$|\b(card|atm|sim|bank|debit|security) pin\b`,
  // Recovery phrases, keys and tokens.
  String.raw`\bssn\b|social security|security answer|secret answer|answer to (your |the )?security question|mother'?s maiden name|recovery (phrase|key|code|words)|seed (phrase|words)|wallet seed|\b(12|24)[- ]word|secret (recovery )?phrase|mnemonic|private key|secret key|secret access key|client secret|^secret$|api[ _-]?key(?! (name|label|description|title))|access key(?! (name|label|description|title))|access token|auth(entication)? token|bearer token|personal access token|^token$`,
  // One-time and sign-in codes, in many languages. A box called just "Code" is judged with what is typed in it
  // (codeBox).
  String.raw`auth(entication)? code|verification code|security code|one[- ]time (code|password|passcode)|\b\d[- ]digit code|\b2fa\b|\bmfa\b|\botp\b|\btotp\b|(sign|log)[- ]?in code|backup code|recovery code|confirmation code|access code|codigo de (verificacion|seguridad|acceso)|code de (verification|securite|confirmation)|bestatigungscode|verifizierungscode|sicherheitscode|codice di verifica|verificatiecode|kod weryfikacyjny|kod (sms|jednorazowy)|код подтверждения|验证码|驗證碼|校验码|認証コード|確認コード|인증 ?번호|인증 ?코드|otp कोड`,
  // A card's number, in many languages ("Gift card number" is not a payment card; "Card #" and "Card title" are
  // Trello's).
  String.raw`(?<!gift )card ?(number|no\b)|cardnumber|credit card|debit card|card information|card details|numero de (la )?tarjeta|número de (la )?tarjeta|numero do cartao|número do cartão|numero de carte|numéro de carte|kartennummer|numero (della )?carta|kaartnummer|numer karty|номер карты|卡号|卡號|カード番号|카드 ?번호|kortnummer|kart numarasi|kart numarası`,
  String.raw`\bcvv2?\b|\bcvc2?\b|\bcvn\b|\bcsc\b|card (verification|security)|\bmm ?/ ?(yy|aa|jj)(yy|aa|jj)?\b|card expir`,
  // Round 4: security, one-time and verification codes and CVV labels in more languages (pt, fr, de, it, nl, ja, zh, ko,
  // vi, Nordic, cs, pl), more words for a password, and a field that only shows bullets.
  String.raw`codigo de (verificacao|seguranca|confirmacao)|código de (verificação|segurança|confirmação)|cryptogramme|kartenprufnummer|kartenprüfnummer|prufnummer|prüfnummer|einmalcode|einmalpasswort|codice di sicurezza|codice (otp|monouso)|beveiligingscode|eenmalige code|セキュリティコード|安全码|安全碼|보안 ?코드|ma bao mat|mã bảo mật|engangskode|engangskod|engångskod|bekræftelseskode|bekraftelseskode|bekreftelseskode|verifieringskod|verifiseringskode|bekraftelsekod|bekräftelsekod|sikkerhedskode|sikkerhetskode|sakerhetskod|säkerhetskod|vahvistuskoodi|turvakoodi|kertakayttokoodi|kertakäyttökoodi|overovaci kod|ověřovací kód|bezpecnostni kod|bezpečnostní kód|kod bezpieczenstwa|kod bezpieczeństwa|passord|contrasenya|^parole$|slaptazodis|slaptažodis|kata laluan|lykilorð|lykilord|парола|лозинка|құпия сөз|رمز عبور|پاس ورڈ|পাসওয়ার্ড|^[•●*·]{4,}$`,
  // One-time codes in other phrasings and languages, Wi-Fi and other keys, memorable words and security answers.
  // Round 6: more one-time code, PIN, CVV and password labels ("Two-factor code", "Card code", "CID", "PIN-Code", "Code
  // PIN", "رمز التحقق", "Kode sandi", "Şifrə"...), and a code or PIN next to a verify, 2FA or card word.
  String.raw`\b(two|2)[- ]?(factor|step) (auth(entication)? )?(code|pin)|card code|^cid$|^pin-code$|\bpin[- ](kode|kod)\b|\b(code|codigo|código|kod|kode|ma|mã|numero|número|numéro) (pin|nip)\b|\b(verify|verification|2fa|mfa|otp|sms|security|authenticator|authentication|confirmation|login|sign-?in) (pin|kod|kode|codigo|código)\b|رمز التحقق|رمز الأمان|cod de verificare|codul de verificare|bevestigingscode|код підтвердження|kod potwierdzający|kod potwierdzajacy|ellenőrző kód|ellenorzo kod|biztonsági kód|קוד אימות|סיסמה חד פעמית|सत्यापन कोड|ओटीपी|รหัสยืนยัน|รหัส otp|κωδικός επαλήθευσης|κωδικος επαληθευσης|kod pengesahan|kode keamanan|kod keselamatan|prüfziffer|prufziffer|kartenprüfziffer|^sandi$|kode sandi|kata kunci sandi|^κωδικός$|^κωδικος$|şifrə|sifrə|contrasinal|introduceți parola|introduceti parola|parola (ta|dvs|contului)|nenosiri|cyfrinair|գաղտնաբառ|პაროლი|கடவுச்சொல்|పాస్‌వర్డ్|ពាក្យសម្ងាត់|စကားဝှက်`,
  // Release review: a PIN after any short prefix ("Enter your PIN", "Transaction PIN", "Port-out PIN"; not "Drop pin"),
  // "<word> token" and "<word> secret" ("API token", "Bot token", "Shared secret", "Secret value"; not "Token name",
  // "Search token", "Top secret"), a security question and a digit code. Round 2: a PIN's and a secret's prefix from a
  // list (not "Rolling pin", "Lapel pin", "Little secret"), one token only and never a count's or a design's ("Max
  // tokens", "Output tokens", "Design tokens", "Gas token"), not "Security questions" or "Select a security question".
  String.raw`^((please|enter|re-?enter|type|confirm|create|choose|set|change|verify|your|the|a|new|current|old|existing|card|atm|sim|bank|debit|credit|security|transaction|transfer|port-?out|account|carrier|wireless|mobile|phone|app|device|login|sign-?in|unlock|access|personal|spending|payment|wallet|voicemail|parental|\d+-?digit|four-?digit|six-?digit) ){1,4}pin( ?(number|#|code))?[ :*]*$|^(?!(search|select|choose|find|import|custom|crypto|erc-?20|bep-?20|nft|swap|from|to|receive|sell|buy|send|reward|game|gift|loyalty|bonus|gas) )(?!.*\b(max|maximum|min|minimum|output|input|context|total|design|number|prompt|completion|cached|reasoning|remaining|used)\b)([a-z0-9'-]+ ){0,3}token[ :*]*$|^((enter|paste|your|the|a|new|app|application|consumer|signing|webhook|shared|api|client|oauth|jwt|hmac|bot|totp|otp|2fa|mfa|account|session|encryption|access|integration|auth|authentication|cookie) ){1,3}secret( value| key| token)?[ :*]*$|^secret value\b|\(secret\)|(?<!(select|choose|pick) (a |your |the )?)security question(?!s)|\bdigit (code|pin)\b`,
  String.raw`code (we|that we|i|you've been) (just )?(sent|texted|emailed)|code (from|in) (your |the )?(authenticator|app|sms|text|texts|email|phone)|authenticator|\b(sms|text( message)?|texted|e-?mail(ed)?) code\b|enter the \d+ digits?|\b\d+[- ]digit (code|number|pin)\b|unlock code|\bpuk\d?\b|network key|wi-?fi (network )?(key|password)|\bwpa\d?(-psk)?( (key|passphrase))?\b|\bpsk\b|security key|master key|encryption key|decryption key|memorable (word|information|phrase)|security number|answer to\b|mã xác minh|ma xac minh|mã otp|kode verifikasi|kode otp|doğrulama kodu|dogrulama kodu|код из (смс|sms)|sms[- ]?код|код из сообщения|驗證碼|认证码|ワンタイム|일회용`,
].join('|').normalize('NFKC'));
const EXPIRY = /\bexp(iry|iration)?( date)?\b|\bvalid (thru|through|until)\b|ablaufdatum|\bvalidade\b|gultig bis|gültig bis|date d'expiration|fecha de (caducidad|vencimiento)|data de validade|有效期|有効期限|유효기간/;
/** A box called just "Code" in any of many languages ("Enter code", "Your code", "Kod", "Код", "コード", "코드", "代码"):
 *  a sign-in code box when it is on a sign-in or verify page (signin: a password field, or a sign-in title or text, on
 *  it) and what goes in is a code (4 to 10 digits, or letters and digits in one short word with a digit). */
const CODE_BOX = /^((enter|type|your|the|a|sms|text|e-?mail) )*(code|kod|kodu|kode|kód|код|コード|코드|代码|代碼|codigo|código|codice|ma|mã)( (sms|смс))?[ :*]*$/;
/** A page that signs in or verifies (round 4: a "Code" box elsewhere is a course, coupon or country code): its title or
 *  its text says sign in, log in, verify, two-step, 2FA or "the code we sent", in several languages. */
// Kept in sync with SIGNIN in src-tauri/hands/main.swift (test/swiftsync.mjs).
const SIGNIN_WORDS = String.raw`\b(sign.?in|log.?in|sign.?on|verif\w*|2-step|two-step|two-factor|2fa|mfa|authenticat\w*|one-time|otp|security code|confirm (it'?s you|your (identity|account|email|phone|number))|enter (the |your )?code|code (we|was|has been) (just )?(sent|texted|emailed)|anmeld\w*|connexion|iniciar sesi\w*|accedi|inloggen|bestatig\w*|bestätig\w*)\b|登录|登錄|ログイン|認証|로그인|인증`;
const SIGNIN = new RegExp(SIGNIN_WORDS, 'i');
export const signinPage = (texts) => [texts].flat().some((t) => SIGNIN.test(fold(t)) || SIGNIN.test(String(t ?? '')));
export const codeBox = (label, text, { signin = false } = {}) => signin && [fold(label), String(label ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()].some((l) => CODE_BOX.test(l)) && /^\s*(?=[^\s]*\d)[a-z0-9]{3,10}(?:[ -][a-z0-9]{2,6})?\s*$/i.test(String(text ?? ''));
/** A field's label (or placeholder) that takes a password, a code, a key or a card's number, in several languages.
 *  cardForm: the same form has a card field, so its expiry field counts too. */
export function credentialLabel(label, { cardForm = false } = {}) {
  const raw = String(label ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim(), l = fold(label);
  if (!l) return false;
  return CRED_FIELD.test(l) || CRED_FIELD.test(raw) || (cardForm && EXPIRY.test(l));
}

// ── A control's label, judged with where it is (B2) ──────────────────────

// Clear pay labels: they pay by their words alone, anywhere. A verb that pays alone or with what it pays for, in many
// languages. Matched against the whole label (folded, and raw lower-case for scripts the folding changes).
const PAY_WORDS = String.raw`pay|pay now|pay (it|the bill|the balance|the invoice|in full|securely|online|today)|pay with [\w .-]+|buy|buy (it )?now|buy with [\w .-]+|buy for .+|purchase|purchase now|complete (my |the |your )?(purchase|payment|booking|reservation|transfer|order)|confirm (and pay|payment|purchase|order|transfer|booking|reservation|trade|subscription)|confirm (&|and) (pay|buy|book)|place (my |your |the )?order|submit (my |your |the )?order|order now|book now|reserve now|request to book|get tickets|buy tickets|checkout now|proceed to (checkout|payment)|continue to (checkout|payment)|go to checkout|send money|send payment|transfer (money|funds|now)|move money|make (a )?payment|add money|add funds|top up|cash out|donate( now)?|start (a |your |my )?(free )?trial|start (my |your )?subscription|subscribe now|upgrade now|upgrade to [\w ]+|place bid|pledge|pledge now|back (this|the) project|make (an |a )?offer|submit (my |your |an |a )?(bid|offer|pledge)|confirm (my |your |the |an |a )?(bid|offer|pledge)|request (a |an )?(uber\w*|lyft\w*|ride|taxi|cab|car|driver|pickup)|confirm (uber\w*|lyft\w*|ride|pickup)|(create|send|make|initiate|request|schedule|start) (an |a )?(instant |manual )?payouts?|instant payouts?|pay ?out( now)?|1-click|buy with 1-click|apple pay|google pay|paypal|venmo|zelle|klarna|afterpay|slide to (send|pay)|hold to (confirm|pay|send)|swipe to (pay|send)`;
const PAY_FOREIGN = String.raw`betalen|nu betalen|afrekenen|kopen|nu kopen|bestellen|jetzt bestellen|kostenpflichtig bestellen|zahlungspflichtig bestellen|jetzt kaufen|kaufen|zur kasse|bezahlen|jetzt bezahlen|uberweisen|überweisen|paga|paga ora|ordina|ordina ora|acquista|acquista ora|compra|compra ora|compra ahora|comprar|comprar ahora|pagar|pagar ahora|realizar pedido|finalizar pedido|finalizar compra|tramitar pedido|transferir|valider la commande|commander|passer la commande|payer|acheter|acheter maintenant|bayar|bayar sekarang|beli|beli sekarang|kop|köp|köp nu|betala|kup|kup teraz|zaplac|zapłać|kupuje|satin al|satın al|ode|öde|thanh toan|thanh toán|mua ngay|ชำระเงิน|ซื้อเลย|ادفع|ادفع الآن|اشتر الآن|שלם|לתשלום|оплатить|купить|оформить заказ|перевести|खरीदें|भुगतान करें|अभी खरीदें`;
const PAY_CJK = /^(提交订单|去结算|结算|立即购买|立即支付|确认支付|确认付款|支付|付款|购买|下单|立即下单|买入|卖出|转账|充值|提现|提交訂單|結帳|立即購買|確認付款|購買|轉帳|買う|購入|購入する|今すぐ購入|お支払い|支払う|注文する|注文を確定する|送金|送金する|入金|出金|売却|결제|결제하기|구매|구매하기|주문하기|송금|이체|충전|매수|매도|출금)$/;
// Round 7 (A3 H2): pay, transfer and buy verbs by stem with their inflections and set phrases ("Przelej", "Overmaken",
// "Virer", "Havale yap", "شراء", "ซื้อ", "注文を確定"), whole label. Kept in sync with MONEY in main.swift.
const PAY_INFLECT = String.raw`перевест(и|ь)|переведи(те)?|перечисл(ить|ите|и)|оплат(ить|ите|и)|заплат(ить|ите|и)|куп(ить|ите|и)|отправить (деньги|средства|перевод)|сплатити|оплатити|переказати|купити|zapłać|zapłacić|zaplac|zaplacic|przelej|przelać|przelac|przelew|kupuję|kupię|kupuje|kupie|zamów|zamow|zamawiam|overmaken|maak over|overboeken|betaal( nu)?|koop( nu)?|bestel( nu)?|virer|virez|envoyer (de )?l['’]argent|payez|achetez|pague|compre|enviar pix|pagar (com|con) pix|enviar (dinero|dinheiro)|(havale|eft|fast) yap|havale gönder|havale gonder|ödeme yap|odeme yap|para gönder|para gonder|satın alın|satin alin|شراء|اشتري|اشتر|ادفع|ادفع الآن|إرسال الأموال|ارسال الاموال|ซื้อ|ชำระ|ชำระเลย|จ่าย|จ่ายเงิน|โอน|โอนเลย|注文(を)?確定(する)?|購入(を)?確定(する)?|支払(い)?(を)?確定(する)?|今すぐ支払う|送金(を)?確定(する)?|确认购买|確認購買`;
// A clear pay label with an amount after it ("Перевести 500 ₽", "Przelej 100 zł", "Pagar R$ 50", "Купить за 990 ₽").
const PAY_TAIL = String.raw`( (za |for |pour |por |für |fur |per )?(\d[\d .,]*\s?(₽|руб|р|₴|грн|zł|zl|pln|₺|tl|₹|rs|₩|₫|đ|฿|บาท|₪|kr|chf|r\$|\$|€|£|¥|eur|usd|gbp)?|(r\$|₽|₺|₹|₩|₫|฿|₪|\$|€|£|¥|zł)\s?\d[\d .,]*))?`;
const CLEAR_PAY = new RegExp(String.raw`^(${PAY_WORDS}|${PAY_FOREIGN}|${PAY_INFLECT})${PAY_TAIL}$`.normalize('NFKC'));
// A pay verb with an amount ("Pay $50", "Send $20", "Donate $10", "Buy for $9.99", "Tip $5").
const PAY_AMOUNT = new RegExp(String.raw`^(pay|send|transfer|donate|tip|buy|purchase|deposit|withdraw|give|top up|add|join|subscribe|bet|wager|order|renew|upgrade|book|place|start|try|charge|refund|pledge|back|bid|offer|chip in)\b.{0,20}${AMOUNT}|^(withdraw|deposit|transfer|send|move)\b.{0,30}\b(funds|money|cash|to (checking|savings|bank|account|wallet|card)|from (checking|savings|bank|account|wallet))\b`);
// A pay verb that starts the label, with what it pays for after it: "Buy AAPL", "Sell all shares", "Pay bill", "Buy now
// with 1-Click", "Subscribe & Save", "Buy / Long", "Send with Zelle", "Make transfer", "Submit buy order", "Place $10
// Bet", "Open Trade". It pays anywhere. Not when what follows is no money ("Pay attention", "Purchase history", "Order
// #1234", "Subscribe to newsletter", "Tip of the day"); a verb joined by a dash ("Trade-offs", "Sell-by date") is no verb.
const NOT_MONEY = String.raw`attention|history|details?|status|summary|settings|preferences|options?|methods?|info|information|overview|reports?|statements?|activity|records?|logs?|lists?|ideas?|guides?|tracking|numbers?|ids?|dates?|photos?|pictures?|images?|videos?|files?|folders?|documents?|data|ownership|applications?|requests?|newsletters?|channels?|updates|calendars?|feeds?|podcasts?|notifications|emails?|threads?|comments?|alerts?|branch(es)?|of|by (date|name|newest|oldest|price|size|type|relevance|status|title)|calculator|offs?|periods?|stubs?|slips?|rates?|scale|grades?|cycles?|days?|columns?|rows?|layers?|panes?|tabs?|places|sides|views?|colou?rs?|themes?|instances?|components?|variants?|screens?|displays?|monitors?|audio|left|right|policy|policies|consent|on (amazon|ebay|etsy|shopify|facebook|marketplace|craigslist|poshmark|depop|mercari|google|apple)|#\d*|no\.? ?\d+|\d+$`;
const PAY_VERB = String.raw`(pay|buy|purchase|sell|trade|swap|subscribe|donate|bid|bet|wager|order|tip|stake|redeem|repay|re-?order|pre-?order) (?!((to|for|on|in|with|from|of) )?((the|our|my|your|this|a|an) )?(${NOT_MONEY})(\s|$))\S.*|send (money|payment|funds|cash|crypto|bitcoin|btc|eth|usdc|usdt|sol|tokens?|coins?|(with|via|by) (zelle|venmo|paypal|cash app|apple cash|wise|revolut|interac))\b.*|make (a |the )?(transfer|payment|deposit|withdrawal|purchase|trade|bet|donation)\b.*|submit (a |my |your |the )?((buy|sell|limit|market|stop) )?(order|payment|transfer|trade|bet)\b.*|place (a |my |your |the )?([$€£¥]?[\d.,]+ )?(bet|bid|order|trade|wager)s?\b.*|open (a |new )?(trade|position|long|short)\b.*|(get|try|join|start) ([\w-]+ )?(premium|pro|plus|gold|ultimate|unlimited|membership)\b.*`;
const VERB_PAY = new RegExp(String.raw`^(${PAY_VERB})$`);
// Round 4: a money-family word anywhere in the label pays anywhere ("Pay in 4", "Proceed to Pay", "Agree and pay",
// "Valider et payer", "Confirmar compra", "Renew now", "Buy/Long", "Issue refund", "去支付", "송금하기"), unless what
// follows it is no money ("Transfer photos", "Pay attention", "Purchase history", "Withdraw application", "Checkout
// branch", "Swap instance") or a dash joins it ("Trade-offs"). A noun alone ("Payments", "Payroll", "Refunds") is no
// family word, and a family word alone pays in a money surface only (below). Kept in sync with MONEY in main.swift (the helper stops at every family word; the sidecar judges).
const FAMILY = String.raw`pay|payer|payez|pagar|pague|paga|zahlen|bezahlen|betalen|betala|bayar|buy|purchase|transfer|withdraw|sell|trade|swap|renew|refund|donate|compra|comprar|achat|acheter|acquista|acquisto|kaufen|kopen|bestellung|commande|ordine|pedido`;
// Round 6: a family word that is also an everyday verb or a noun ("Transfer repository", "Renew DHCP lease", "Refund
// policy", "Withdraw consent", "Swap screens", "Bestellung ansehen", "Suivre ma commande", "Historique d'achat") pays
// with other words only with a money object after or before it (now, funds, an amount, a coin, a plan) or in a money
// surface. The others (pay, buy, purchase, donate, comprar...) pay with any words but no-money ones. The helper stops at
// both (FAMILY); the sidecar judges.
const FAMILY_WEAK = String.raw`transfer|withdraw|sell|trade|swap|renew|refund|achat|acquisto|bestellung|commande|ordine|pedido`;
const MONEY_OBJECT = new RegExp(String.raw`(^|[^\p{L}])(now|today|instantly|instant|funds|money|cash|crypto|bitcoin|btc|eth|usdc|usdt|sol|tokens?|coins?|shares?|stocks?|all|max|balance|subscription|plan|membership|domain|payment|position|jetzt|sofort|maintenant|ahora|agora|ora|nu|teraz|ya)(?![\p{L}])|[$€£¥]|\d`, 'u');
// Pay, buy, order and transfer verbs in other languages, by stem and in their word order ("Zahlung bestätigen",
// "Confirmer le paiement", "Kupuję i płacę", "Оплатить заказ", "Ödemeyi tamamla", "Đặt hàng"). Anywhere in the label,
// between letters' edges. Kept in sync with MONEY in main.swift (test/swiftsync.mjs).
const PAY_STEMS = String.raw`(zahlung|bezahlung|bestellung|kauf|auftrag|zahlungsauftrag|überweisung|uberweisung) (jetzt )?(bestätigen|bestatigen|ausführen|ausfuhren|absenden|freigeben|abschließen|abschliessen|durchführen|durchfuhren|senden)|(jetzt |sofort )?(überweisen|uberweisen)|geld (senden|überweisen|uberweisen)|(confirmer|valider|effectuer|finaliser|faire) (le |la |l'|mon |ma |votre )?(paiement|virement|achat|commande|transfert|versement)|passer (la |ma )?commande|(confirmar|realizar|hacer|completar|finalizar|tramitar|efetuar|fazer|concluir) (el |la |mi |tu |su |o |a |meu |minha )?(pago|pagamento|transferencia|transferência|compra|pedido|pix)|transferir (agora|ahora|ya)|enviar (dinero|dinheiro)|(conferma|effettua|esegui|completa) (il |la |l'|lo )?(pagamento|bonifico|acquisto|ordine|trasferimento)|invia denaro|(bestelling|betaling|overboeking|overschrijving) (plaatsen|bevestigen|afronden|uitvoeren|voltooien)|(nu )?overboeken|geld overmaken|zapłać( teraz)?|płacę|kupuję|kup teraz|zamawiam|zamów|(wykonaj|zleć|wyślij) przelew|potwierdź (płatność|zamówienie|przelew|zakup)|(ödemeyi|ödeme|siparişi|sipariş|satın almayı) (tamamla|onayla|yap|ver|gönder)|para gönder|şimdi öde|hemen al|оплатить|оплатите|оплатити|купить|купите|купити|перевести (деньги|средства)|переказати кошти|отправить деньги|подтвердить (оплату|заказ|перевод|покупку)|оформить заказ|(إتمام|اتمام|تأكيد|تاكيد) (الشراء|الطلب|الدفع)|تحويل (الأموال|الاموال|المال)|ادفع|اشتر|ऑर्डर (करें|दें)|भुगतान करें|खरीदें|पैसे भेजें|đặt hàng|chuyển tiền|thanh toán|mua ngay|buat pesanan|kirim uang|transfer sekarang|bayar sekarang|beli sekarang|קנה|בצע הזמנה|לתשלום|שלם|העבר כסף|העברת כסף`;
// The same in scripts with no spaces between words (Thai, Chinese, Japanese).
const PAY_NOSPACE = String.raw`で払う|を払う|チャージする|チップを送る|สั่งซื้อ|โอนเงิน|ชำระเงิน|ซื้อเลย|ซื้อทันที|转账|轉帳|抢购|搶購|马上抢|立即抢|振込|振り込|お振込`;
const PAY_STEMS_RE = new RegExp(String.raw`(^|[^\p{L}\p{M}])(${PAY_STEMS})(?![\p{L}\p{M}])|${PAY_NOSPACE}`.normalize('NFKC'), 'u');
const FAMILY_CJK = String.raw`支付|付款|下单|下單|购买|購買|買う|購入|支払|送金|결제|송금|구매|주문|이체|转账|轉帳|振込`;
// A commit verb with what it pays ("Authorize payment", "Confirm transaction", "Confirmar pagamento", "Run payroll",
// "Charge customer", "Upgrade plan").
const COMMIT_MONEY = String.raw`\b(confirm|confirmar|confirmer|conferma|bestatigen|approve|authori[sz]e|submit|complete|finish|finali[sz]e|process|make|send|accept|agree|valider|place|run|issue|review and|go to|proceed to|continue to)( (and|&|to|the|my|your|this|a|an|le|la|il|el|o))* (l'|d')?(payments?|purchase|order|transaction|transfer|withdrawal|swap|sale|trade|checkout|payroll|refund|charge|bid|offer|pledge|pagamento|pago|compra|achat|ordine|commande|pedido|bestellung|zahlung|paiement|acquisto)\b|^(run|submit|approve|process|pay|send|finish|confirm|preview) payroll\b|^charge( (the|this|a))? (customer|card|client|[$€£¥]\d)|^upgrade (plan|subscription|membership|account|tier|workspace|team)\b`;
const FAMILY_NOT_WORDS = String.raw`attention|heed|tribute|respects?|history|details?|status|summary|settings|preferences|options?|methods?|info|information|overview|reports?|statements?|activity|records?|logs?|lists?|ideas?|guides?|tracking|photos?|pictures?|images?|videos?|files?|folders?|documents?|data|ownership|applications?|requests?|newsletters?|channels?|updates|calendars?|feeds?|podcasts?|notifications|emails?|threads?|comments?|alerts?|branch(es)?|calculator|periods?|stubs?|slips?|rates?|scale|grades?|cycles?|columns?|rows?|layers?|panes?|tabs?|views?|themes?|instances?|components?|variants?|colou?rs?|sides|layouts?|loans?|books?|articles?|posts?|pages?|links?|show|shows|secrets|domains? (list|settings)|policy|policies|terms|consent|repository|repo|issues?|project|projects|board|boards|call|calls|chat|chats|conversation|contacts?|lease|dhcp|certificate|certs?|screens?|displays?|monitors?|audio|left|right|on (amazon|ebay|etsy|shopify|facebook|marketplace|craigslist|poshmark|depop|mercari|google|apple)|by (date|name|newest|oldest|price|size|type|relevance|status|title)`;
const CJK_NOT = String.raw`履歴|历史|歷史|記録|记录|紀錄|内訳|明細|明细|내역|方式|方法|設定|设置|設置|설정|수단|기록`;
// One pattern for the sidecar and the helper: a family word not followed by what is no money.
const FAMILY_MATCH = String.raw`(^|[^\p{L}-])(${FAMILY})(?![\p{L}-])(?!\s+((to|for|on|in|with|from|of|by) )?((the|our|my|your|this|these|that|a|an) )?(${FAMILY_NOT_WORDS})(\s|$))|(${FAMILY_CJK})(?!\s?(${CJK_NOT}))`;
const FAMILY_RE = new RegExp(FAMILY_MATCH.normalize('NFKC'), 'u');
const COMMIT_RE = new RegExp(COMMIT_MONEY);
// A family word alone ("Swap", "Trade", "Transfer" as a tab or a news site's button) pays in a money surface only
// (MONEY_WORD); with other words ("Limit Sell", "Renew now", "Buy/Long") it pays anywhere.
/** A label that says plainly it moves no money (L10): a money or send word with what is no money after it ("Transfer
 *  photos", "Check out this article", "Send feedback"), a dash-joined one ("Trade-offs"), File Transfer. In a money
 *  surface such a risky click is no pay ask. */
const NOT_MONEY_LABEL = new RegExp(String.raw`(^|[^\p{L}-])(${FAMILY}|check ?-?out|send|submit)\s+((to|for|on|in|with|from|of|by) )?((the|our|my|your|this|these|that|a|an) )?(${FAMILY_NOT_WORDS}|article|story|feedback|message|messages|invite|invitation|link|code|branch|bug report)(\s|$)|-(${FAMILY})(?![\p{L}])|(^|[^\p{L}])(${FAMILY})-|^(file|data|photo|video|music|contact|wi-?fi) transfers?$`, 'u');

const FAMILY_CJK_RE = new RegExp(String.raw`(${FAMILY_CJK})(?!\s?(${CJK_NOT}))`);
const STRONG_RE = new RegExp(FAMILY_MATCH.replace(`(${FAMILY})`, `(${FAMILY.split('|').filter((w) => !FAMILY_WEAK.split('|').includes(w)).join('|')})`).normalize('NFKC'), 'u');
const family = (l, raw, surface = true) => (((((surface || MONEY_OBJECT.test(l)) ? FAMILY_RE : STRONG_RE).test(l) || ((surface || MONEY_OBJECT.test(raw)) ? FAMILY_RE : STRONG_RE).test(raw)) && /[\s/]/.test(l || raw))
  || FAMILY_CJK_RE.test(raw) || COMMIT_RE.test(l) || PAY_STEMS_RE.test(raw) || PAY_STEMS_RE.test(l)) && !NOT_MONEY_LABEL.test(l);

// A label that may pay but whose words don't say: a money word that is also a tab or a list name (Trade, Order, Book,
// Rent, Short, Checkout, Subscribe), a confirm word in many languages, or a price button ("$4.99", "Rent $3.99").
// These pay in a money surface (a bank, broker, wallet, pay app, checkout page, app store) only.
const MONEY_WORD = String.raw`transfer|withdraw|deposit|wire|tip|swap|trade|sell|sell all|vender|vendre|vendi|verkaufen|buy|short|long|go long|go short|stake|bid|bet|place bet|wager|order|set order|checkout|check out|subscribe|rent|book|reserve|upgrade|renew|redeem|exercise|roll|repay|broadcast|open position|close position|open (a )?(long|short)|close (all|position|trade)|review (order|trade|transfer|payment)|schedule (transfer|payment)|send now|transfer now|sign|convert|convert now|capture|charge|refund|give|give now|approve [a-z0-9]{2,10}|(un)?wrap( [a-z0-9]{2,10})?|bridge|mint|(go )?(long|short) [a-z0-9]{2,10}(-perp)?|request (uber|lyft)( [a-z0-9]+){0,2}|request (a )?ride`;
// A confirm word: it pays in a money surface or next to an amount. A weak one (Done, OK, Next, Get, Accept, a page's
// Next in other languages) mostly closes or moves on, so it pays only next to an amount (the window shows one, or the
// plan fills one), never for being in a bank or an app store alone.
const CONFIRM_WORD = String.raw`schedule|confirm|confirm (on|in|with|via) [\w .-]+|submit|continue|send|approve|authori[sz]e|proceed|place|finish|complete|slide|swipe|hold to confirm|slide to send|join( now)?|enroll( now)?|become a member|start membership|activate( plan| membership| subscription)?|weiter|bestatigen|bestätigen|senden|absenden|fortfahren|abschicken|confirmar|continuar|enviar|confirmer|continuer|valider|envoyer|conferma|continua|invia|bevestigen|doorgaan|verzenden|fortsatt|fortsätt|bekrafta|bekräfta|skicka|potwierdz|potwierdź|wyslij|wyślij|devam|onayla|gonder|gönder|продолжить|подтвердить|отправить|xac nhan|xác nhận|tiep tuc|tiếp tục|konfirmasi|lanjutkan|kirim`;
const WEAK_CONFIRM = String.raw`review|get|install|done|ok|okay|next|return|enter|accept|agree|yes|verify|go|siguiente|aceptar|suivant|avanti|volgende|dalej|далее`;
const CONFIRM_CJK = /^(确认|確認|确定|確定|继续|繼續|提交|发送|發送|送信|続ける|확인|계속|보내기|전송|제출)$/;
const WEAK_CJK = /^(下一步|同意|次へ|다음)$/;
const MONEY_WORDS = new RegExp(String.raw`^(${MONEY_WORD})(\s*(→|>|›|»))?$`.normalize('NFKC'));
const CONFIRMS = new RegExp(String.raw`^(${CONFIRM_WORD})(\s*(→|>|›|»))?$`.normalize('NFKC'));
const WEAK_CONFIRMS = new RegExp(String.raw`^(${WEAK_CONFIRM})(\s*(→|>|›|»))?$`.normalize('NFKC'));
// A price tag or price button: an amount alone, or a word or two before or after it ("Rent $3.99", "Buy $9.99",
// "MacBook Air from $999", "$4.99/mo").
const PRICE = new RegExp(String.raw`^([\p{L}'-]+ ){0,4}(from |for |only |just |under )?${AMOUNT}[\d.,]*( ?/ ?(mo|month|yr|year|wk|week))?( [\p{L}'-]+){0,2}$`, 'u');
const labelText = (label) => fold(label).replace(/^[^\p{L}\p{N}$€£¥]+|[^\p{L}\p{M}\p{N}$€£¥%)]+$/gu, '');
const rawLabel = (label) => String(label ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim().replace(/^[^\p{L}\p{N}$€£¥]+|[^\p{L}\p{M}\p{N}$€£¥%)]+$/gu, '');
/** A label's parts: the hands helper reads a spot's words as "words | words" (the text and its button), and each part is
 *  a label of its own. */
const parts = (label) => [...new Set(String(label ?? '').split(/\s+\|\s+/).map((x) => x.trim()).filter(Boolean))];
const each = (label, f) => { for (const p of parts(label)) { const l = labelText(p), raw = rawLabel(p); if ((l || raw) && l.split(' ').length <= 6) { const hit = f(l, raw); if (hit) return l || raw; } } return null; };
const clearPay = (l, raw) => CLEAR_PAY.test(l) || CLEAR_PAY.test(raw) || PAY_CJK.test(raw) || PAY_AMOUNT.test(l) || VERB_PAY.test(l);
const moneyish = (l, raw) => MONEY_WORDS.test(l) || MONEY_WORDS.test(raw) || PRICE.test(l);
const strongConfirm = (l, raw) => CONFIRMS.test(l) || CONFIRMS.test(raw) || CONFIRM_CJK.test(raw);
const weakConfirm = (l, raw) => WEAK_CONFIRMS.test(l) || WEAK_CONFIRMS.test(raw) || WEAK_CJK.test(raw);
/** The money words a control's label says, or null (B2). A clear pay label ("Pay now", "Place order", "Buy AAPL", "Pay
 *  bill", "Kopen", "提交订单", "Pay $50") pays anywhere. In a money surface (ctx.surface: a bank, broker, wallet,
 *  exchange, pay app, sportsbook, store, checkout page or app store, or a plan heading to checkout) or next to an amount
 *  (ctx.amount: the window shows one, or the plan fills one), a money word (Trade, Short, Subscribe), a price button or
 *  a confirm word (Confirm, Continue, Send, Weiter, 确认) pays too; a weak confirm (Done, OK, Next, Get) only next to an
 *  amount. A noun, a tab, a list or a price tag on an ordinary page ("Payments", "Order history", "Coffee $5.00") and a
 *  clear non-money label ("Transfer photos", "Pay attention", "Checkout branch") never do. Each part of a spot's
 *  "words | words" is judged. */
// Round 7 (A3 H2): a money surface's button in a script the word lists barely cover (Greek, Cyrillic, Hebrew, Arabic,
// Devanagari, Thai, Japanese, Chinese, Korean) may pay by words we can't read, unless it is a known way back, out or
// to the cart. The helper stops at such a label in a money plan (AMBIG) so the sidecar judges it.
// By code point: NFKC (swiftsync) folds U+30FF to "コト", which cut the helper's katakana range at U+30B3.
const UNREAD_SCRIPT = String.raw`[\u0370-\u03FF\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u0900-\u097F\u0E00-\u0E7F\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF]`;
const UNREAD_RE = new RegExp(UNREAD_SCRIPT, 'u');
const UNREAD_NAV = /^(назад|отмена|отменить|закрыть|вернуться|корзина|в корзину|перейти в корзину|добавить в корзину|продолжить покупки|изменить|удалить|войти|выйти|поиск|найти|меню|ещё|еще|подробнее|применить|промокод|πίσω|ακύρωση|κλείσιμο|καλάθι|חזרה|ביטול|סגור|עגלה|הוסף לעגלה|رجوع|إلغاء|الغاء|إغلاق|اغلاق|السلة|أضف إلى السلة|اضف الى السلة|वापस|रद्द करें|बंद करें|कार्ट|कार्ट में जोड़ें|ย้อนกลับ|ยกเลิก|ปิด|ตะกร้า|หยิบใส่ตะกร้า|เพิ่มลงตะกร้า|返回|取消|关闭|關閉|购物车|購物車|加入购物车|加入購物車|戻る|キャンセル|閉じる|カート|カートに入れる|뒤로|취소|닫기|장바구니|장바구니 담기)$/u;
const unread = (raw) => UNREAD_RE.test(raw) && raw.split(' ').length <= 3 && !UNREAD_NAV.test(raw);
// Round 8 (the round-7 regressions): that unread-script rule holds only where a pay is likely, next to an amount
// (ctx.amount: a checkout's total, a card form, an amount filled) or on a pay step (ctx.payStep: payStepPage), never for a
// bank's or a checkout's plain navigation ("Выписка", "ログイン", "Изменить адрес"). A bare Request pays on a ride page
// only (moneySurface's 'ride'); Venmo's or PayPal's Request asks for money and pays none. The helper stops at it in a
// money plan (AMBIG) so the sidecar judges it.
const RIDE_WORD = String.raw`request`;
const RIDE_RE = new RegExp(String.raw`^(${RIDE_WORD})(\s*(→|>|›|»))?$`);
export function moneyLabel(label, { surface = false, amount = false, membership = false, store = false, payStep = false } = {}) {
  return each(label, (l, raw) => clearPay(l, raw) || ((amount || payStep) && unread(raw)) || (surface === 'ride' && RIDE_RE.test(l)) || family(l, raw, surface || amount) || (membership && /^join( now| channel| for .+)?$/.test(l)) || (store && (PRICE.test(l) || /^(rent|buy|pre-?order)\b/.test(l)))
    || ((surface || amount) && (moneyish(l, raw) || strongConfirm(l, raw))) || (amount && weakConfirm(l, raw)));
}
/** A label the hands helper stops at so the sidecar can judge it with the window it is in (a click by a spot or an id,
 *  where only the helper sees the words): a clear pay label, a pay verb with its object, a money word (Trade, Short,
 *  Rent, Order) or a price button, in any part of "words | words". The confirm words (Confirm, Continue, Next, Weiter,
 *  确认) are the helper's AMBIG list, stopped at when the plan is in a money surface. Kept in sync with MONEY and AMBIG in
 *  src-tauri/hands/main.swift. */
export const clearlyNotMoney = (label) => !!each(label, (l) => NOT_MONEY_LABEL.test(l));
export const moneyStop = (label) => !!each(label, (l, raw) => clearPay(l, raw) || family(l, raw) || moneyish(l, raw));
/** A confirm word in many languages, strong or weak (the helper's AMBIG list): it pays only in a money surface. */
export const confirmWord = (label) => !!each(label, (l, raw) => strongConfirm(l, raw) || weakConfirm(l, raw));
/** The window shows a currency amount. */
export const showsAmount = (text) => new RegExp(AMOUNT).test(fold(text));
// A checkout's total: "Total $84.20", "Gesamt 84,20 €", "Total: 84.20", "합계 ₩59,000", "Order total", "Amount due".
const TOTAL = /\b(order total|grand total|total (due|to pay|amount|price|cost)|subtotal|amount due|you pay|total|gesamt(betrag|summe)?|summe|importe total|montant total|totale|totaal|totalt|razem|toplam|итого|сумма к оплате|tong cong|tổng cộng)\b[^\n]{0,24}?\d|(合计|合計|总计|總計|小计|お支払い金額|합계|총액|결제 ?금액)[^\n]{0,12}?\d/;
/** Text a window shows that makes it a checkout: a total with a number. */
export const checkoutText = (texts) => [texts].flat().some((t) => TOTAL.test(fold(t)) || TOTAL.test(String(t ?? '').toLowerCase()));

// Banks, brokers, wallets, exchanges, pay apps, sportsbooks, media stores and app stores: a plain Confirm, Send or
// Continue in them can pay. By name, and (MONEY_APP_WORDS) by the words in any other app's name.
const MONEY_APPS = /^(robinhood|webull|moomoo|public|tastytrade|tastyworks|m1( finance)?|etoro|trading 212|coinbase( wallet)?|kraken( pro)?|binance( us)?|gemini|crypto\.com|okx|bybit|venmo|cash app|paypal|wise|revolut|monzo|starling( bank)?|n26|chime|sofi|ally|current|varo|zelle|fidelity( investments)?|schwab( mobile)?|thinkorswim|e\*?trade|power e\*?trade|interactive brokers|ibkr|trader workstation|ibkr desktop|vanguard|merrill( edge)?|metamask|phantom|ledger live|exodus|trust wallet|rainbow|uniswap|chase|bank of america|wells fargo|capital one|citi( mobile)?|american express|amex|discover|us bank|u\.s\. bank|pnc( mobile)?|td bank|hsbc|barclays|santander|lloyds( bank)?|natwest|halifax|apple cash|app store|mac app store|electrum|trezor suite|sparrow( wallet)?|wasabi( wallet)?|bitcoin core|atomic wallet|metatrader( ?\d)?|mt[45]|tradingview|ninjatrader|tradestation|draftkings( sportsbook)?|fanduel( sportsbook)?|betmgm|caesars sportsbook|bet365|polymarket|kalshi|itunes|itunes store|steam|alipay|支付宝|mercury|brex|ramp|usaa|marcus|nubank|navy federal)$/i;
const MONEY_APP_WORDS = /\b(bank|banking|wallet|broker|brokerage|trader|trading|crypto|sportsbook|casino|bet|bets|betting|credit union|pay)\b|银行/i;
const MONEY_HOSTS = /(^|\.)(paypal|venmo|wise|transferwise|revolut|monzo|starlingbank|n26|chime|sofi|ally|robinhood|webull|coinbase|kraken|binance|gemini|crypto|okx|bybit|fidelity|schwab|etrade|interactivebrokers|ibkr|vanguard|chase|bankofamerica|wellsfargo|capitalone|citi|americanexpress|discover|usbank|pnc|td|hsbc|barclays|santander|lloydsbank|natwest|zellepay|uniswap|opensea|klarna|affirm|afterpay|squareup|mercury|brex|ramp|marcus|usaa|navyfederal|penfed|sparkasse|nubank|cmbchina|icbc|alipay|etoro|kucoin|bitget|bitfinex|bitstamp|hyperliquid|dydx|polymarket|kalshi|draftkings|fanduel|betmgm|bet365|williamhill|ladbrokes|stake|pokerstars|tradingview|plus500|ig|oanda|robinhood|gusto|adp|paychex|rippling|deel|godaddy|namecheap|porkbun|dynadot|hover|gandi|ing|ipko|pkobp|mbank|abnamro|rabobank|bunq)\.[a-z.]+$|(^|[.-])[a-z0-9-]*(?<!food|blood|data|seed|image|photo|word|question|power|milk|sperm|tissue|egg|memory|river|west|left|south|nerd)(bank|banking|sportsbook|casino|wallet|brokerage|trading)[a-z0-9-]*\.[a-z.]+$|(^|\.)(bet|bets|betting)\.|^(m\.uber\.com|ride\.lyft\.com|checkout\.stripe\.com|invoice\.stripe\.com|buy\.stripe\.com|dashboard\.stripe\.com|squareup\.com|app\.squareup\.com|pay\.google\.com|apps\.apple\.com|checkout\.shopify\.com|cash\.app|app\.uniswap\.org|pay\.amazon\.com)$/;
// A checkout, cart, payment, booking or transfer page by its address (a path part, also inside a longer one:
// /gocheckout, confirm_order.htm, /dashboard/transfers/new, /book.html). Not an order history or a list of payments.
// Round 4: not a bare order, book, transfers or wallet part (a help page about an order, a book club, Hydra's own
// transfers page); billing, plan and payroll pages are.
// Round 6: a whole path part only (/checkout, /gocheckout, /viewcheckout, confirm_order.htm, /buy-now, /cart/step-2), never a
// word inside a dashed slug (/how-to-pay-off-debt, /best-laptops-to-buy, /why-we-killed-the-cart-page).
const MONEY_PATHS = /(^|\/)(go|view|my|secure|express|guest)?[-_]?(checkout|checkouts|cart|basket|payment|pay|purchase|buy|buy-now|donate|send-money|sendmoney|place-?order|confirm[_-]?order|booking|subscribe|onlinebanking|online-banking|billing|upgrade|payroll|payrolls|run-payroll)([-_](now|page|step-?\d*|v\d+|\d+))*(\.(html?|php|aspx?|jsp|do|htm))?(\/|$)(?!.*(history|list|status|track))/;
const NOT_PAGES = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|[\w-]+\.(local|test|localhost|internal))$|^(docs|developer|developers|dev|api|help|support|learn|blog|status|community|forum)\.|(^|\.)(github\.com|gitlab\.com|bitbucket\.org|githubusercontent\.com|stackoverflow\.com|wikipedia\.org|npmjs\.com|medium\.com)$|^(mail\.google\.com|docs\.google\.com|sheets\.google\.com|drive\.google\.com|calendar\.google\.com|outlook\.(live|office|office365)\.com|app\.slack\.com|[\w-]+\.slack\.com|discord\.com|web\.whatsapp\.com|web\.telegram\.org|teams\.microsoft\.com|(www\.)?notion\.so|[\w-]+\.notion\.site|(www\.)?figma\.com|app\.asana\.com|linear\.app|trello\.com|hydra-olive-one\.vercel\.app)$/;
// Round 4: a title names a money page only as the page's whole role, one part of the title ("Checkout - Example Shop",
// "Shopping Cart | Amazon", "Secure checkout", "Your bag"), never as a word inside it ("Bank holidays 2026", "Food
// bank volunteer signup", "Payment settings", "Trading card show tickets").
const MONEY_TITLE = /^(secure |express |guest )?(checkout|check out|shopping (cart|bag|basket)|your (shopping )?(cart|bag|basket|order)|cart|basket|payment|make a payment|order summary|review (your )?order|place (your )?order|confirm (your )?order|send money|transfer (money|funds)|move money|pay (a )?bills?|kasse|zur kasse|paiement|pago|pagamento|bezahlen|zahlung|online banking|run payroll|billing)( \(\d+\))?$|^(银行|оформление заказа|корзина|оплата|结算|确认订单|提交订单|支付|購物車|お支払い|ご注文|注文手続き|결제|주문서)$/;
// Round 8: eBay is a money surface on an item, a bid, an offer or its checkout only, never its messages, reviews or
// sign-in. Ride pages (a bare Request books a ride) by host.
const EBAY_HOSTS = /(^|\.)ebay\.[a-z.]+$/;
const EBAY_PAY = /^(pay|offer|checkout|bid)\.ebay\.|^[^/]*\/(itm|p|product|bfl|bid|offer|chk|checkout|pay)(\/|$)/;
const RIDE_HOSTS = /^(m\.uber\.com|ride\.lyft\.com)$/;
// A pay step by its address: a pay, payment, bid or order-confirm page, or a checkout's payment, review or confirm step
// (/pay, /payment, /bfl/bid, /confirm-order, /checkout/payment). Not a bare /checkout or /cart (an address or a promo
// code is changed there), and not a history or a list.
const PAY_STEP_PATH = /(^|\/)(pay|payment|bid|bids|place[-_]?order|confirm[-_]?order|review[-_]?order|buy-now|send-money|sendmoney)([-_](now|page|step-?\d*|v\d+|\d+))*(\.(html?|php|aspx?|jsp|do|htm))?(\/|$)(?!.*(history|list|status|track))|(^|\/)checkouts?\/(.*\/)?(pay|payment|review|confirm|place-?order)(\/|$)/;
/** A browser page that is a pay step (PAY_STEP_PATH), never a docs page, a code host or a site on this Mac. */
export const payStepPage = (win) => { try { const u = new URL(String(win?.url ?? '')); return !NOT_PAGES.test(u.hostname.toLowerCase()) && PAY_STEP_PATH.test(u.pathname.toLowerCase()); } catch { return false; } };
const titleRoles = (t) => String(t ?? '').split(/\s+[-–—|·:•]\s+|\s*[|·•]\s*/).map((x) => x.trim()).filter(Boolean);
// Browsers by family: a channel or edition after the name (Chrome Canary or Beta, Firefox Developer Edition or Nightly,
// Safari Technology Preview, Edge Beta), and the newer ones (Dia, Comet, SigmaOS).
const BROWSERS = /^(safari|google chrome|chrome|chromium|ungoogled chromium|arc|firefox|microsoft edge|msedge|brave browser|brave|opera( gx| one| air)?|vivaldi|orion|zen( browser)?|duckduckgo|dia|comet|sigmaos|waterfox|librewolf|floorp|tor browser|mullvad browser|yandex|naver whale|whale|min)( (canary|beta|dev|developer( edition)?|nightly|technology preview|esr|snapshot|rc))?$/i;
/** A web browser, by its app name. */
export const inBrowser = (app) => BROWSERS.test(String(app ?? '').trim().replace(/\.app$/i, ''));
/** Typed text that looks like a password: one word of 6 to 64 characters with letters and digits or symbols, not an
 *  email address, a web address, a path or a number. Typed where the cursor can't be named, it is refused. */
export const passwordLike = (text) => {
  const t = String(text ?? '').trim();
  return /^\S{6,64}$/.test(t) && /\p{L}/u.test(t) && /[\d\W_]/.test(t) && !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(t) && !/^([a-z][a-z0-9+.-]*:|www\.|[~/.])/i.test(t) && !/^[\w-]+\.(com|org|net|io|dev|app|co|ai)(\/\S*)?$/i.test(t);
};
/** A window where a plain Confirm or Continue can pay (B2): a bank, broker, wallet, exchange, pay app or app store by
 *  its name; in a browser, a money site by its host, or a checkout, cart, payment, booking or transfer page by its
 *  address or title. Never a docs page, a code host or a site on this Mac (docs.stripe.com/payments,
 *  github.com/.../checkout/index.ts, localhost:3000/billing), and never an editor, a chat, mail, notes or a sheet,
 *  whatever their titles say. win: { app, title, url }. */
export function moneySurface(win) {
  const app = String(win?.app ?? '').trim().replace(/\.app$/i, '');
  if (MONEY_APPS.test(app) || (!BROWSERS.test(app) && MONEY_APP_WORDS.test(app))) return true;
  if (app && !BROWSERS.test(app)) return false;
  try {
    const u = new URL(String(win?.url ?? ''));
    const h = u.hostname.toLowerCase(), p = u.pathname.toLowerCase();
    if (NOT_PAGES.test(h)) return false;
    // A ride page: truthy as any money surface, and there a bare Request pays (moneyLabel).
    if (RIDE_HOSTS.test(h)) return 'ride';
    if (MONEY_HOSTS.test(h) || MONEY_PATHS.test(p) || (EBAY_HOSTS.test(h) && EBAY_PAY.test(h + p))) return true;
  } catch { /* no address */ }
  return titleRoles(win?.title).some((part) => MONEY_TITLE.test(fold(part)) || MONEY_TITLE.test(part.toLowerCase()));
}
/** A page where an amount or a total on screen is a message's, a doc's or a sheet's words, never a checkout (round 4):
 *  mail, chat, docs, sheets, notes and Hydra's own app. */
export const ordinaryPage = (url) => { try { return NOT_PAGES.test(new URL(String(url ?? '')).hostname.toLowerCase()); } catch { return false; } };
/** A membership page (YouTube's or Twitch's channels, Patreon): there a plain Join pays. */
/** A media store (the Music, TV and Books apps' stores; Amazon's, Apple's and Google's video stores): there a price
 *  button and Rent or Buy pay, while a dialog's Continue is no money (round 4). */
const STORE_APPS = /^(music|tv|books|itunes|apple tv|apple books|amazon prime video|prime video)$/i;
const STORE_HOSTS = /(^|\.)(amazon\.[a-z.]+|primevideo\.com|tv\.apple\.com|play\.google\.com|vudu\.com|fandangoathome\.com|microsoft\.com)$/;
export const storePage = (win) => { if (STORE_APPS.test(String(win?.app ?? '').trim())) return true; try { return STORE_HOSTS.test(new URL(String(win?.url ?? '')).hostname.toLowerCase()); } catch { return false; } };
export const membershipPage = (url) => { try { return /(^|\.)(youtube\.com|twitch\.tv|patreon\.com)$/.test(new URL(String(url ?? '')).hostname.toLowerCase()); } catch { return false; } };
/** A step's label that heads a plan to checkout: once one runs, the plan's later Confirm or Continue is judged as in a
 *  money surface (a plan that starts on a product page and ends on the pay button). */
export const toCheckout = (label) => /^(add to (cart|bag|basket|order|trolley)|buy now|checkout|check out|proceed to checkout|go to checkout|view (cart|bag|basket)|in den warenkorb|ajouter au panier|añadir al carrito|aggiungi al carrello|加入购物车|カートに入れる|장바구니 담기)$/.test(labelText(label) || rawLabel(label));
/** A search, find or symbol box: Return there runs a search, not the form's pay button (tools.mjs's plans, the phone's
 *  Return: remotepolicy.mjs). */
export const SEARCH_FIELD = /search|find|filter|symbol|ticker|query|look ?up|suche|buscar|recherche|搜索|検索|검색/i;
/** Terminal apps: typing goes to a shell, which shows no field for a password prompt. */
export const TERMINALS = /^(terminal|iterm2?|warp|ghostty|kitty|alacritty|wezterm|hyper|tabby|rio|wave)$/i;
/** A terminal's last line asks for a password or passphrase (sudo, ssh, gpg, a database client): what is typed now is
 *  one, and the shell shows no field to judge. Kept in sync with PROMPT in src-tauri/hands/main.swift. */
// Round 8: a name prompt that also asks to paste or enter the token ("Name your API key, then paste the token:") is
// refused; "Name your token:", "Token alias:" and "Give your token a name:" are typed.
// Round 8: a password's own prompt ("Password expiry (days):") and a key's or token's ID ("AWS Access Key ID [None]:",
// "Token ID:") are still refused; only a token's or key's name, label, description, limit or expiry is typed.
// Round 7 (M2 regression): a prompt for a token's or a key's name, label, description, limit or expiry ("? Token name:",
// "Name for this API key:", "Token limit (4096):") asks for no secret.
const PROMPT = String.raw`^(?:(?=.*\b(paste|enter|type|provide|input)\s+((the|this|that|a|an|your|new|my)\s+)*(api[ _-]?key|token|access key|secret key|key|secret|password)\b)|(?!.*\b((name|label|description|title|comment|note)\s+(for|of)|name)\s+((the|this|that|a|an|your|new|my)\s+)*(api[ _-]?key|token|access key|secret key|key)\b)(?!.*\bgive\s+((the|this|that|a|an|your|new|my)\s+)*(api[ _-]?key|token|access key|secret key|key)\s+a\s+name\b)).*?((pass(word|phrase|code)|\bpin\b|verification code|one-time code|\botp\b|\btotp\b|\bmfa\b|\b2fa\b|two-factor|authenticator|authentication (code|token)|recovery code|backup code)|(\btoken\b|api[ _-]?key|secret key|access key)(?!\s+(name|nickname|alias|label|description|title|comment|note|limit|expiration|expiry|expires|lifetime|ttl|scopes?|type)\b))[^:]{0,80}:\s*$|^enter passphrase\b|^password for\b`;
const PROMPTS = new RegExp(PROMPT, 'i');
export const passwordPrompt = (text) => {
  const last = String(text ?? '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean).at(-1) ?? '';
  return last.length <= 160 && PROMPTS.test(last);
};
/** A control that copies or shows a secret ("Copy password", "Show password", "Reveal recovery phrase", "Copy
 *  verification code"): clicking it reads a credential, refused anywhere, in every part of "words | words". A plain
 *  "Copy code" (a code block's button) and "View code" are not one. Kept in sync with REVEAL in main.swift. */
const REVEAL = String.raw`^(copy|show|reveal|view|display|unhide|unmask|see)( the| my| your)? (password|passcode|passphrase|pin|secret|secret key|api key|access key|token|access token|recovery (phrase|key|codes?)|seed phrase|secret phrase|private key|card number|cvv|cvc)s?$|^copy( the| my| your)? (verification|one-time|2fa|otp|sms|authenticator|security|sign-?in|login|backup) codes?$|^copy (otp|2fa|totp)$|^copy username and password$|^(toggle|show/hide|show or hide|hide/show)( the| my| your)? (password|passcode|passphrase|pin)( visibility)?$|^(show |reveal |toggle )?(password|passcode|pin) visibility( toggle)?$|^copy one-time (password|code)$|^(passwort|kennwort|pin|code) (kopieren|anzeigen|einblenden)$|^(copier|afficher|voir) (le |la |l')?(mot de passe|code)$|^(copiar|mostrar|ver) (la |el |a |o )?(contraseña|contrasena|senha|código|codigo|clave)$|^(copia|mostra) (la |il )?(password|codice)$|^(kopieer|toon) (het |de )?(wachtwoord|code)$|^(kopiuj|pokaż|pokaz) hasło$|^(скопировать|показать|копировать) (пароль|код)$|^(复制|显示|查看|複製|顯示)(密码|密碼|验证码|驗證碼)$|^パスワードを(コピー|表示)$|^비밀번호 (복사|보기|표시)$`;
const REVEALS = new RegExp(REVEAL.normalize('NFKC'));
export const revealLabel = (label) => parts(label).some((p) => REVEALS.test(labelText(p)) || REVEALS.test(rawLabel(p)));
