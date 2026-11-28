// The phone view's rules (RV plan section 7), pure: which windows the stream hides (shieldsFor) and whether one remote
// input may happen (checkInput: allow, ask or refuse). One source of rules: safety.mjs. The owner's fixed rule holds
// for his own remote hands too: passwords, credentials and card numbers are never typed from the phone, password
// managers and secret files are hidden and dead, and a click that pays asks on the phone first.
import * as safety from './safety.mjs';
import { SEARCH_FIELD, TERMINALS, checkoutText, inBrowser, membershipPage, moneySurface, ordinaryPage, passwordPrompt, payStepPage, revealLabel, storePage, typedCredential } from './hardlimits-core.mjs';

// One classifier (A3, hardlimits-core.mjs through safety.mjs): the money labels and pages, the credential fields, the
// card numbers and the reveal buttons are A3's, the same the agent's plans are judged by (tools.mjs).
const { checkWindow, isPasswordApp, BLOCK, credentialField, hasCardNumber: hasCardNumberRaw, isPayClick } = safety;
/** The money context of a window ({ app, title, url }), as A3's isPayClick reads it, from the evidence tools.mjs's
 *  mctx counts for a plan: a money surface; next to an amount only on checkout evidence (a browser page, no mail, chat,
 *  doc or sheet, whose title shows a checkout's total), never any $ in a title; a membership, store or pay-step page. */
export const payCtx = (win) => ({
  surface: !!win && moneySurface(win), amount: !!win && inBrowser(win.app) && !ordinaryPage(win.url) && checkoutText(String(win.title ?? '')),
  membership: membershipPage(win?.url), store: !!win && storePage(win), payStep: !!win && payStepPage(win),
});
// Typed text as the card check reads it: full-width digits as ASCII (NFKC) and no format characters (\p{Cf}: a
// zero-width space between the digits), for A3's check too.
const cardText = (s) => String(s ?? '').normalize('NFKC').replace(/\p{Cf}/gu, '');
// Any decimal digit (Arabic-Indic, Persian, Devanagari...) as its ASCII digit: each script's digits are one run of
// ten from its zero.
const asciiDigits = (s) => s.replace(/\p{Nd}/gu, (ch) => { const c = ch.codePointAt(0); let z = c; while (z > c - 9 && /\p{Nd}/u.test(String.fromCodePoint(z - 1))) z -= 1; return String(c - z); });
// The digits alone, as a card field with a mask reads them: letters and marks dropped, any other separator (an en
// dash, a middle dot) a space. Both readings are checked.
const cardDigits = (t) => asciiDigits(t).replace(/[\p{L}\p{M}]/gu, '').replace(/[^\d\s]/gu, ' ');
// A3's card check reads a card by its groups (fours, Amex's 4-6-5): a format character may stand where a separator was
// ("4111\u2060 1111\u200d1111\u00ad1111"), so each reading is also tried with them as spaces.
const hasCardNumber = (text) => [cardText(text), String(text ?? '').normalize('NFKC').replace(/\p{Cf}/gu, ' ')].some((t) => hasCardNumberRaw(t) || hasCardNumberRaw(cardDigits(t)));
// The next characters can land anywhere in the tail (a Delete went back into it): each place is checked.
const cardInsert = (tail, s) => { const a = [...cardText(tail)]; for (let i = 0; i <= a.length; i++) if (hasCardNumber(`${a.slice(0, i).join('')}${s}${a.slice(i).join('')}`)) return true; return false; };
const digitsOf = (t) => cardDigits(cardText(t)).replace(/\D/g, '');
const digitCount = (t) => digitsOf(t).length;
// A delete that would leave a card. Release round 2: with the cursor at the tail's end (not moved), only what the
// delete leaves is read (editTail: the last character, word or line gone; a forward delete removes nothing there), the
// way A3 reads a card (grouped, one separator kind), and only a card that was not there before counts. Once the
// cursor moved, a delete of any length anywhere: the digits alone (the mask reading joins every digit in the text),
// every cut through them read across the cut.
const cardDelete = (tail, k, moved) => {
  if (!moved) {
    const { key, mods } = parseKey(k), left = editTail(tail, mods.includes('ctrl') && key === 'h' ? 'delete' : k); // ctrl+h is a Backspace
    return left !== tail && hasCardNumber(left) && !hasCardNumber(tail);
  }
  const d = digitsOf(tail);
  for (let i = 0; i < d.length; i++) for (let j = i + 1; j <= d.length; j++) if (hasCardNumberRaw(d.slice(Math.max(0, i - 18), i) + d.slice(j, j + 18))) return true;
  return false;
};
/** Text that may type a card: anywhere in the last 40 characters of the tail. Once the cursor moved (a click, a cursor
 *  key, a paste) the sidecar cannot tell where it is: the helper decides then (remoteview sends it `moved`), from the
 *  field's own value, or, when it cannot read that, by refusing a digit once the field could hold 13 (remote/card.swift). */
const typesCard = (tail, s) => digitCount(s) > 0 && cardInsert([...tail].slice(-TAIL).join(''), s);

const inside = (r, x, y) => x >= r[0] && y >= r[1] && x < r[0] + r[2] && y < r[1] + r[3];
const clip = (b, d) => {
  const x0 = Math.max(b[0], d.x), y0 = Math.max(b[1], d.y), x1 = Math.min(b[0] + b[2], d.x + d.w), y1 = Math.min(b[1] + b[3], d.y + d.h);
  return x1 > x0 && y1 > y0 ? [x0 - d.x, y0 - d.y, x1 - x0, y1 - y0] : null;
};

/** A window the stream never shows: a password manager (by name or bundle id), a vault or password page, or a window
 *  that shows a secret file (checkWindow BLOCK or secret). */
export const secretWindow = (w, home) => {
  if (isPasswordApp(w?.app) || (w?.bundle && isPasswordApp(w.bundle))) return true;
  const v = checkWindow({ app: w?.app, title: w?.title, document: w?.document, url: w?.url }, home);
  return v.level === BLOCK || v.secret === true;
};

// Notification banners and alerts (a texted sign-in code): hidden while a session is live, never a key target.
const NOTIFY = /^(notification ?center|notificationcenter)$/i;
// What a capture of the screen shows: the owner's Screenshot and QuickTime windows, and an image or a movie opened
// after one. Hidden once a secret window was on screen in this session (secretSeen), so a capture of a vault never
// reaches the phone as a plain file. ponytail: by app and title; an image renamed without its extension still shows.
const CAPTURE_APPS = /^(screenshot|screencaptureui|screen ?capture ?ui|quicktime player)$/i;
const CAPTURE_TITLE = /\.(png|jpe?g|heic|tiff?|gif|bmp|pdf|mov|mp4|m4v)$|^(screenshot|screen shot|screen recording|bildschirmfoto|capture d.écran|captura de pantalla|スクリーンショット|截屏|스크린샷)\b/i;
// The Dock's and WindowManager's own windows over most of the display: Mission Control, App Exposé, Stage Manager,
// Launchpad. They draw thumbnails of every window away from its frame, so the shields at the frames miss them.
// The Dock bar's own window is layer 20 (kCGDockWindowLevel) and as big as the display whenever the Dock shows
// (measured), so a layer-20 Dock window is no proof of Mission Control: it counts only while a secret window is on
// screen now, never for secretSeen alone. ponytail: Mission Control's own layer is not measured on a real Mac; if it
// is also 20, Mission Control after a vault closed is not blacked out (the Dock's AX expose notifications would tell).
const dockBar = (w) => w?.app === 'Dock' && w?.layer === 20;
const coversDisplay = (w, d) => { const r = Array.isArray(w?.bounds) && w.bounds.length === 4 && d ? clip(w.bounds, d) : null; return !!r && r[2] * r[3] >= 0.9 * d.w * d.h; };

/** windows: the helper's list (global points). display: { x, y, w, h } of the viewed display, global points.
 *  rects: display points, clipped to it. exclude: window ids the capture leaves out (password apps). ids: every
 *  hidden window. frontSecret: the front window is hidden (no keys go to it). secret: a secret window is on screen
 *  (for secretSeen). secretSeen: one was on screen earlier in this session. While a system overlay (Mission Control)
 *  covers the display and a secret window is or was on screen, the whole display is one shield. */
export function shieldsFor(windows, { home, display, secretSeen = false, focus = null }) {
  const rects = [], exclude = [], ids = [];
  let frontSecret = false, secret = false, overlay = false;
  // A browser's untitled small windows (its autofill list, a password manager extension's popup with its vault items
  // and codes) are hidden and dead, whatever has focus: a popup opened from the toolbar has its own search field.
  // Front or not: the helper marks the front app's first layer-0 window front, and a popup above its browser window is
  // that one. A front popup takes no keys either (Return there fills the picked item).
  // Its menus (layer 101, kCGPopUpMenuWindowLevel) show unless focus is in a credential field (the autofill list).
  // ponytail: by app, title, size and layer; GUESS (not checked live): an extension popup's CGWindow title is empty
  // and its layer is not 101.
  const credFocus = !!focus && (focus.secureInput === true || credOf(focus));
  const popup = (w) => inBrowser(w?.app) && !String(w?.title ?? '').trim() && (credFocus || w?.layer !== 101)
    && Array.isArray(w?.bounds) && display && w.bounds[2] * w.bounds[3] < 0.4 * display.w * display.h;
  for (const w of windows ?? []) {
    if (w?.overlay === true) { if (coversDisplay(w, display)) overlay = dockBar(w) ? overlay || 'bar' : true; continue; }
    const vault = secretWindow(w, home);
    if (vault) secret = true;
    const pop = popup(w);
    const hide = vault || NOTIFY.test(String(w?.app ?? '')) || w?.bundle === 'com.apple.notificationcenterui' || pop
      || ((secretSeen || secret) && (CAPTURE_APPS.test(String(w?.app ?? '')) || CAPTURE_TITLE.test(String(w?.title ?? '').trim())));
    if (!hide) continue;
    ids.push(w.id);
    if (isPasswordApp(w.app) || (w.bundle && isPasswordApp(w.bundle))) exclude.push(w.id);
    if ((vault || pop) && w.front) frontSecret = true;
    const r = Array.isArray(w.bounds) && w.bounds.length === 4 && display ? clip(w.bounds, display) : null;
    if (r) rects.push(r);
  }
  // A password field shown in plain text (its eye toggle, a "show password"): the field itself is hidden.
  const shown = credFocus && focus.secure !== true && focus.secureInput !== true && Array.isArray(focus.rect) && display ? clip(focus.rect, display) : null;
  if (shown) rects.push(shown);
  // A capture window found before the vault in the list (front to back): checked again now that one is known.
  if (secret && !secretSeen) return shieldsFor(windows, { home, display, secretSeen: true, focus });
  if (overlay && (secret || (secretSeen && overlay !== 'bar')) && display) return { rects: [[0, 0, display.w, display.h]], exclude, ids, frontSecret, secret };
  return { rects, exclude, ids, frontSecret, secret };
}

/** The last 40 characters typed in one field (remoteview keeps one per field), for the card check; 400 once the
 *  cursor moved (moved), when any digit typed earlier may sit next to the cursor. */
export const cardTail = (tail, s, moved = false) => [...cardText(`${tail ?? ''}${s ?? ''}`)].slice(-(moved ? MOVED_TAIL : TAIL)).join('');
const TAIL = 40, MOVED_TAIL = 400; // room for the letters a card mask drops
/** The tail after a key that edits: Delete drops the last character, option+Delete the last word, cmd+Delete the
 *  line, while the cursor is at the end. Everything else (a cursor move, select-all, cut), and any delete once the
 *  cursor moved (moved), keeps it: what is left in the field is not known, and a tail too long only refuses more. */
export const editTail = (tail, k, moved = false) => {
  const { key, mods } = parseKey(k), a = [...String(tail ?? '')];
  if (moved || (key !== 'delete' && key !== 'backspace')) return String(tail ?? '');
  if (mods.includes('cmd')) return '';
  if (mods.includes('alt') || mods.includes('opt') || mods.includes('option')) return a.join('').replace(/\S*\s*$/u, '');
  return a.slice(0, -1).join('');
};
/** A key after which the cursor may be anywhere in the field: anything but a typed character, Delete, Tab, Return,
 *  Space and Esc (a cursor key, select-all, undo, cut, paste, a forward or a word delete). remoteview marks the field's
 *  tail moved then, as it does for a click. */
export const movesCursor = (k) => {
  const { key, mods } = parseKey(k);
  if (keyChar(k)) return false;
  return mods.some((x) => x !== 'shift') || !['delete', 'backspace', 'tab', 'return', 'enter', 'space', 'escape', 'esc'].includes(key);
};
/** Key focus in a hidden window or a password app while another app is front (a password manager's Quick Access
 *  panel): focus { pid, app, rect } from the helper; windows: its list; ids: the hidden ones (shieldsFor). */
export const focusHidden = (focus, windows, ids) => {
  if (!focus) return false;
  if (isPasswordApp(focus.app)) return true;
  const hidden = new Set(ids ?? []), pid = focus.pid, r = Array.isArray(focus.rect) && focus.rect.length === 4 ? focus.rect : null;
  if (!Number.isInteger(pid)) return false;
  for (const w of windows ?? []) {
    if (w?.pid !== pid) continue;
    if (isPasswordApp(w.app) || (w.bundle && isPasswordApp(w.bundle))) return true;
    // The focused element inside a hidden window of its app (or no rect to tell): another window of that app is not.
    if (hidden.has(w.id) && (!r || (Array.isArray(w.bounds) && inside(w.bounds, r[0] + r[2] / 2, r[1] + r[3] / 2)))) return true;
  }
  return false;
};

const POINT = new Set(['click', 'down', 'move', 'up', 'scroll']);
const NAV = new Set(['tab', 'escape', 'esc', 'left', 'right', 'up', 'down', 'home', 'end', 'pageup', 'pagedown', 'return', 'enter']);
// Roles a key types into. Space or Return on anything else (a focused button, link or menu item) presses it.
const ENTRY = /^AX(TextField|TextArea|SecureTextField|SearchField|ComboBox)$/;
// The Paste menu item in the languages macOS ships (the helper also flags it by its cmd+V shortcut: hit.paste).
const PASTE = /^(paste|einsetzen|einfügen|coller|pegar|colar|incolla|plakken|wklej|вставить|vložit|beillesztés|yapıştır|klistra in|lim inn|sæt ind|indsæt|liitä|επικόλληση|הדבק|لصق|chèn|tempel|วาง|粘贴|貼上|ペースト|貼り付け|붙여넣기)(\s|$|…)/i;
// Roles where a click with no label of its own is ordinary and presses nothing (a page, a list, a scroll bar). In a
// money app any other unlabeled target (an icon button, a canvas-drawn Buy) asks: what it does cannot be read.
const BLANK_OK = /^AX(WebArea|ScrollArea|ScrollBar|ValueIndicator|Splitter|SplitGroup|Window|Sheet|Heading|List|Table|Outline|Row|Cell|Column|Browser|LayoutArea|TextField|TextArea|SearchField|ComboBox|SecureTextField)$/;
// The on-screen keyboards that type wherever focus is: their clicks are keys.
const KEYBOARDS = /assistivecontrol|accessibility keyboard|keyboard viewer|characterpalette|character viewer|emoji ?(&|and) ?symbols|textinputmenuagent/i;
// The owner's own screenshot and recording shortcuts: they would put a hidden window into a plain file on screen.
const CAPTURE = new Set(['3', '4', '5', '6']);
// A password manager's fill item, on every click: a browser extension's context menu (Bitwarden > Auto-fill login)
// fills the page's stored password wherever focus is, as its chord does (autofillKey). By the item or its parents.
// PM_FILL (a fill phrase) anywhere; PM_NAME (a manager's bare name: its submenu, its toolbar button) only on a menu or
// a toolbar (pmMenu), so a link, a message or a file that names one is an ordinary click.
// Kept in sync with pmFillRx and pmNameRx in src-tauri/remote/hit.swift (test/remoteround10.test.mjs runs both).
export const PM_FILL = /auto-?fill|\bfill (in )?(the )?(login|logins|username|password|passwords|credentials?|identity|card)\b|use (a |this |strong |suggested )?(password|passkey)|suggested password|passwords…|passwords\.\.\.|^passwords$|select a password/i;
export const PM_NAME = /\b(keychain|1password|bitwarden|lastpass|dashlane|keeper|proton pass|nordpass|enpass|roboform)\b/i;
// The roles of a menu or a browser's toolbar (an extension's button), on the element or its 3 parents (hit.roles).
// ponytail: GUESS (not read on a real Mac): an extension's toolbar button is an AXPopUpButton or sits in an AXToolbar
// within 3 parents; one deeper is not seen (its popup window is hidden and dead anyway: shieldsFor).
const PM_MENU = new Set(['AXMenuItem', 'AXMenu', 'AXMenuBar', 'AXMenuBarItem', 'AXMenuButton', 'AXPopUpButton', 'AXToolbar']);
const pmFill = (h, labels) => labels.some((l) => l && PM_FILL.test(String(l).trim()))
  || ([h.role, ...(h.roles ?? [])].some((r) => PM_MENU.has(String(r))) && labels.some((l) => l && PM_NAME.test(String(l).trim())));
// In a credential field: a click that fills it (an autofill or password manager item, a texted code) or any menu
// item (the browser's autofill list). Anywhere: a toggle that shows a password in plain text.
const FILL = /auto-?fill|\bfill\b|use (a |this |strong |suggested )?(password|passkey|code)|suggested password|passwords…|passwords\.\.\.|from (messages|mail)|keychain|1password|bitwarden|lastpass|dashlane|keeper|proton pass|nordpass|enpass|roboform/i;
// A3's revealLabel only (release round 2: a second list here refused "View code" and "Show code").
const reveals = (l) => !!l && revealLabel(l);
// A login form's other field: a username, email or phone field (Chrome and Safari offer the saved sign-ins from it).
const LOGIN = /e-?mail|user ?name|\buser\b|\blog ?in\b|\bsign ?in\b|account (name|id)|apple id|phone|mobile number|identifier|benutzername|usuario|correo|identifiant|utilisateur|用户名|邮箱|帳號|ユーザー名|아이디/i;
// Password-manager fill chords: 1Password (cmd+\, Quick Access cmd+shift+space), Bitwarden (cmd+shift+l, ctrl+shift+l),
// LastPass and others (ctrl+y, cmd+shift+x). They fill a stored password wherever focus is on the page: refused on
// every remote key.
const autofillKey = ({ key, mods }) => {
  const cmd = mods.includes('cmd'), ctrl = mods.includes('ctrl'), shift = mods.includes('shift');
  return ((cmd || ctrl) && key === '\\') || ((cmd || ctrl) && shift && ['l', 'space', 'x'].includes(key)) || (ctrl && key === 'y');
};
const money = (label, app) => ({ do: 'ask', why: 'money', label: String(label).slice(0, 120), app: String(app ?? '').slice(0, 80) });
// A3's credentialField with cardForm: the phone cannot see a field's form, so an expiry field counts as a card's.
const credOf = (c) => c?.secure === true || /secure/i.test(String(c?.role ?? '')) || credentialField({ role: c?.role, label: c?.label ?? '', secure: c?.secure === true }, { cardForm: true });

/** Keys (with all their modifiers, "shift+cmd+v") as { key, mods }. */
const parseKey = (k) => { const parts = String(k ?? '').toLowerCase().replace(/\s+/g, '').split('+'); return { key: parts.at(-1), mods: parts.slice(0, -1) }; };
/** The one character a key types, or '' (a chord, or a named key like tab). For the card tail. */
export const keyChar = (k) => { const { key, mods } = parseKey(k); return !mods.includes('cmd') && !mods.includes('ctrl') && [...key].length === 1 ? key : ''; };

/** One remote input. ctx: { display {w,h}, shields (display points), locked, agent {busy, owner}, hit (for a click or
 *  a press: {role,label,labels,app,secure,paste}; for the up of a drag, what is under it), focus {role,label,secure,
 *  secureInput,defaultButton}, frontSecret, tail, pay {surface, amount} (the window under a click, or the front window
 *  for a key: payCtx), dragged (an up that ends a drag) }.
 *  focus.buttons: the focused window's button labels (read live for Return, Space and a newline).
 *  { do: 'allow' } | { do: 'ask', why: 'money', label, app } | { do: 'refuse', why }. An `up` is never refused (a
 *  refused one would leave the Mac's button held down): inside a shield it is allowed with clamp, so the button goes
 *  up where the drag last was, never on the hidden window; a drag that would drop onto a secure or credential field
 *  goes up where it began (clamp 'start'), so nothing is dropped into it. */
export function checkInput(m, ctx) {
  const t = m?.t;
  const pay = ctx.pay ?? {};
  if (!POINT.has(t) && t !== 'key' && t !== 'text') return { do: 'refuse', why: 'changed' };
  if (t === 'up') {
    const x = m.x * (ctx.display?.w ?? 0), y = m.y * (ctx.display?.h ?? 0);
    if ((ctx.shields ?? []).some((r) => inside(r, x, y))) return { do: 'allow', clamp: true };
    if (ctx.dragged && (!ctx.hit || !ctx.hit.role || credOf(ctx.hit))) return { do: 'allow', clamp: 'start' };
    return { do: 'allow' };
  }
  if (ctx.locked) return { do: 'refuse', why: 'locked' };
  if (ctx.agent?.busy && !ctx.agent?.owner) return { do: 'refuse', why: 'agent' };
  const f = ctx.focus ?? {};
  // Release round 2: a terminal's last line that asks for a password (sudo, ssh, gpg: A3's passwordPrompt; the helper
  // sends lastLine for a terminal's text area) is a credential field too.
  const cred = f.secureInput === true || credOf(f) || (TERMINALS.test(String(f.app ?? '').replace(/\.app$/i, '')) && passwordPrompt(f.lastLine));
  // A login form: a credential field, or its username or email field.
  const login = cred || LOGIN.test(String(f.label ?? ''));
  if (POINT.has(t)) {
    const x = m.x * (ctx.display?.w ?? 0), y = m.y * (ctx.display?.h ?? 0);
    if ((ctx.shields ?? []).some((r) => inside(r, x, y))) return { do: 'refuse', why: 'secret' };
    // A press is a click once it comes up: it asks the same way.
    if ((t === 'click' && m.b !== 'r') || t === 'down') {
      // A hit test that failed (no role: an AX call that failed or timed out, an app with no AX) cannot be checked.
      if (ctx.hit && !String(ctx.hit.role ?? '')) return { do: 'refuse', why: 'changed' };
      const h = ctx.hit ?? {};
      const labels = [h.label, ...(h.labels ?? [])];
      if (cred && (h.paste === true || labels.some((l) => l && PASTE.test(String(l).trim())) || KEYBOARDS.test(String(h.app ?? '')))) return { do: 'refuse', why: 'credential' };
      if (login && (h.role === 'AXMenuItem' || labels.some((l) => l && FILL.test(String(l))))) return { do: 'refuse', why: 'credential' };
      if (pmFill(h, labels)) return { do: 'refuse', why: 'credential' };
      if (labels.some(reveals)) return { do: 'refuse', why: 'credential' };
      const label = labels.find((l) => l && isPayClick(l, pay));
      if (label) return money(label, h.app);
      if (ctx.hit && pay.surface && !String(h.label ?? '').trim() && !BLANK_OK.test(String(h.role))) return money('Unlabeled control', h.app);
    }
    return { do: 'allow' };
  }
  if (ctx.frontSecret) return { do: 'refuse', why: 'secret' };
  // Return (a key or a typed newline) submits: the default button, the focused control, or, from a field, its form
  // (a web page has no default button: any pay button in the window counts). Space presses a focused control.
  // Either one on a control that pays asks first.
  const entry = ENTRY.test(String(f.role ?? ''));
  const focusPays = !entry && f.label && isPayClick(f.label, pay);
  // Return in a text area is a newline (a mail's body, a chat, a note): only a one-line field submits its form.
  // Release round 2: nor a search box (A3's SEARCH_FIELD by its label, or its role): Return there runs the search.
  const search = f.role === 'AXSearchField' || SEARCH_FIELD.test(String(f.label ?? ''));
  const formPays = entry && f.role !== 'AXTextArea' && !search ? (f.buttons ?? []).find((l) => l && isPayClick(l, pay)) : null;
  const submitPays = () => (focusPays ? money(f.label, ctx.hit?.app) : f.defaultButton && isPayClick(f.defaultButton, pay) ? money(f.defaultButton, ctx.hit?.app)
    : formPays ? money(formPays, ctx.hit?.app) : null);
  if (t === 'key') {
    const { key, mods } = parseKey(m.k);
    if (mods.includes('cmd') && mods.includes('shift') && CAPTURE.has(key)) return { do: 'refuse', why: 'secret' };
    // Any chord of cmd and v pastes, whatever else is held (shift+cmd+v is Paste and Match Style).
    const typing = (key === 'v' && mods.includes('cmd')) || (!mods.includes('cmd') && !mods.includes('ctrl') && !NAV.has(key));
    if (cred && typing) return { do: 'refuse', why: 'credential' };
    // A password manager's fill chord, on every key: it fills the page's login wherever focus is on the page.
    if (autofillKey({ key, mods })) return { do: 'refuse', why: 'credential' };
    // In a login form Up and Down pick from the browser's saved sign-ins (Return then fills one).
    if (login && (key === 'up' || key === 'down')) return { do: 'refuse', why: 'credential' };
    // The card rule before any money ask: a Yes never types a card number. A Delete that leaves one is refused too.
    const c = keyChar(m.k);
    if (c && typesCard(ctx.tail ?? '', c)) return { do: 'refuse', why: 'card' };
    // A key or token typed key by key (A3's typedCredential on the tail with this key).
    if (c && typedCredential(cardTail(ctx.tail, c, ctx.moved))) return { do: 'refuse', why: 'credential' };
    const deletes = ['delete', 'backspace', 'fwddelete', 'forwarddelete'].includes(key) || (mods.includes('ctrl') && ['d', 'h', 'k'].includes(key));
    if (deletes && cardDelete(ctx.tail ?? '', m.k, ctx.moved === true)) return { do: 'refuse', why: 'card' };
    const submit = key === 'return' || key === 'enter';
    if (submit) { const a = submitPays(); if (a) return a; }
    else if (focusPays && (key === 'space' || typing)) return money(f.label, ctx.hit?.app);
    // In a money app every key asks but typing into a field and moving focus (trading hotkeys: Shift+B buys, one key
    // places an order; Return submits an order form). The label never names the key (it is logged).
    if (pay.surface && (submit || (!(entry && typing) && !NAV.has(key)))) return money(submit ? 'Return' : 'Keyboard shortcut', ctx.hit?.app);
    return { do: 'allow' };
  }
  if (cred) return { do: 'refuse', why: 'credential' };
  // The whole text with the field's tail: a card number anywhere in a paste, not only in its last 24 characters.
  // Before any money ask (a newline in a pay form asks): the Yes re-runs this and is refused too.
  if (typesCard(ctx.tail ?? '', m.s ?? '')) return { do: 'refuse', why: 'card' };
  // A key, a token, a seed phrase or a password said in a message (A3's typedCredential), in the text or with the tail.
  if (typedCredential(m.s) || typedCredential(cardTail(ctx.tail, m.s, ctx.moved))) return { do: 'refuse', why: 'credential' };
  const newline = /[\r\n]/.test(m.s ?? '');
  if (newline) { const a = submitPays(); if (a) return a; }
  // A typed space presses a focused control as the space key does (the phone's space bar sends text ' ').
  if (focusPays) return money(f.label, ctx.hit?.app);
  // In a money app: text anywhere but a field is a hotkey, and a newline submits.
  if (pay.surface && (newline || !entry)) return money(newline ? 'Return' : 'Keyboard shortcut', ctx.hit?.app);
  return { do: 'allow' };
}
