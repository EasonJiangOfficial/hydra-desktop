// What Sidekick may do on its own, what needs a yes from the user first, and what it never does.
// Pure functions so every rule is tested (test/safety.test.mjs). When unsure, ask; never guess "safe".
import dns from 'node:dns/promises';
import fs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';
// Rules work on forward-slash paths everywhere, so a Windows path (C:\Users\ken\.ssh) meets the same checks.
const path = nodePath.posix;
const slash = (p) => String(p ?? '').replace(/\\/g, '/');
const isAbs = (p) => p.startsWith('/') || /^[a-z]:\//i.test(p);

export const SAFE = 'safe', ASK = 'ask', BLOCK = 'block';
const verdict = (level, reason = '') => ({ level, reason });

// Secrets: keys, tokens, passwords, browser cookies and the keychain. Never read, never sent anywhere.
const SECRET = [
  /(^|\/)\.ssh(\/|$)/, /(^|\/)\.gnupg(\/|$)/, /(^|\/)\.aws(\/|$)/, /(^|\/)\.azure(\/|$)/, /(^|\/)\.kube\/config$/,
  /(^|\/)\.docker\/config\.json$/, /(^|\/)\.netrc$/, /(^|\/)\.cargo\/credentials(\.toml)?$/, /(^|\/)\.npmrc$/, /(^|\/)\.pypirc$/, /(^|\/)\.git-credentials$/,
  /(^|\/)\.config\/gh(\/|$)/, /(^|\/)\.config\/gcloud(\/|$)/, /(^|\/)\.gg\/auth\.json$/, /(^|\/)(Roamies|HydraAgent)\/Data\/secrets\.json$/i, /(^|\/)\.tauri(\/|$)/,
  /(^|\/)Library\/Keychains(\/|$)/, /(^|\/)Library\/Cookies(\/|$)/, /\/(Cookies|Login Data[^/]*|Web Data)(-journal)?$/,
  // Any .env name (.env.production.local, .env.local.bak, .envrc), in any case, anywhere, but a template
  // (.env.example, .env.sample: hidden, so still asked); and Cloudflare's .dev.vars.
  /(^|\/)\.env(?![^/]*\.(example|sample|template|dist)(\.md|\.txt)?$)[^/]*$/i, /(^|\/)\.dev\.vars$/i, /\.(pem|p12|pfx|key|keystore|jks)$/i, /(^|\/)id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/,
  // Sign-ins other tools keep (seventh review F3): any auth.json or credentials file (Codex, Claude Code, Vercel, gem,
  // Terraform), tokens, database and cloud configs, service-account keys and Terraform state (it holds secrets).
  /(^|\/)auth\.json$/i, /(^|\/)\.?credentials[^/]*$/i, /(^|\/)\.claude\.json$/i, /(^|\/)(\.vault-token|\.pgpass|\.s3cfg|\.boto|\.my\.cnf|access-token|token)$/i,
  /(^|\/)rclone\.conf$/i, /(^|\/)\.yarnrc\.yml$/i, /(^|\/)configstore(\/|$)/i, /(^|\/)\.railway(\/|$)/i, /(^|\/)\.supabase(\/|$)/i,
  /(^|\/)\.?huggingface\/(stored_)?tokens?$/i, /(^|\/)service[-_]?account[^/]*\.json$/i, /\.tfstate(\.backup)?$/i,
  // Key files kept outside dot folders (eighth review V8-8): App Store Connect .p8, PuTTY .ppk, Google OAuth client
  // secrets, Firebase admin keys, Terraform variables, SSH keys by other names, Rails secrets, wallets, VPN profiles.
  /\.(p8|ppk|ovpn|kdbx|asc|gpg)$/i, /(^|\/)client_secret[^/]*\.json$/i, /(^|\/)[^/]*adminsdk[^/]*\.json$/i, /\.tfvars(\.json)?$/i,
  /(^|\/)id_[a-z0-9]+(_sk)?(\.pub)?$/i, /(^|\/)[^/]*_(key|rsa|ed25519)$/i, /(^|\/)(master\.key|secrets?\.(ya?ml|json|toml)|wallet\.dat)$/i,
  // Browsers' saved logins and cookies (Firefox keeps cookies.sqlite on a Mac too) and apps' web storage (Discord's token).
  /\/(User Data|Profiles)\/.*\/(cookies\.sqlite[^/]*|logins[^/]*\.json|key[34]\.db|cert9\.db|signons\.sqlite)$/i, /\/(Local Storage|Session Storage|IndexedDB)(\/|$)/i,
  /(^|\/)\.(bash|zsh|fish)_history$/, /(^|\/)\.zsh_sessions(\/|$)/,
  /(^|\/)AppData\/(Roaming\/Microsoft\/(Credentials|Protect|Crypto)|Local\/Microsoft\/Credentials)(\/|$)/i, /\/(User Data|Profiles)\/.*\/(Cookies|Login Data|logins\.json|key4\.db)$/i,
  // Linux: GNOME's keyring and KDE's wallet, pass, the NSS certificate store and Firefox's saved logins and cookies.
  /(^|\/)\.local\/share\/(keyrings|kwalletd)(\/|$)/, /(^|\/)\.password-store(\/|$)/, /(^|\/)\.pki(\/|$)/,
  /(^|\/)\.mozilla\/.*\/(cookies\.sqlite|logins\.json|key4\.db|cert9\.db)$/,
];
// Other apps' private data and synced libraries: reading these sets off macOS privacy prompts.
const PRIVATE = [
  /(^|\/)Library\/(Containers|Group Containers|Application Support\/com\.apple\.TCC|Mail|Messages|Safari|Calendars|Photos|Accounts)(\/|$)/,
  /(^|\/)Pictures\/Photos Library\.photoslibrary(\/|$)/, /(^|\/)Music\/(Music|iTunes)(\/|$)/,
  /(^|\/)AppData\/Local\/Packages(\/|$)/i,
];
// Hydra's own data: memory, chats, settings, connections and Recently deleted (old copies of files the owner said yes
// to overwrite, hidden ones too). Never read by the tools (ninth review V9-4); only its logs are.
const OWN_DATA = [/(^|\/)(Roamies|HydraAgent)\/Data(\/(?!logs(\/|$))|$)/i];
// Writing here could let something run on its own later, or break the Mac.
const NO_WRITE = [
  // A repo's hooks, config and attributes (its own, a worktree's or a submodule's) run programs on the next git command.
  /(^|\/)\.git\/(.*\/)?hooks(\/|$)/i, /(^|\/)\.git\/(.*\/)?config(\.worktree)?$/i,
  /(^|\/)\.git\/(.*\/)?(info\/attributes|objects\/info\/alternates|commondir)$/i,
  /(^|\/)\.(zshrc|zprofile|zshenv|zlogin|bashrc|bash_profile|profile|login|inputrc)$/, /(^|\/)\.config\/fish(\/|$)/,
  /(^|\/)Library\/(LaunchAgents|LaunchDaemons|StartupItems|Preferences|Keychains|Application Support\/com\.apple)(\/|$)/,
  /(^|\/)\.gitconfig$/, /(^|\/)\.ssh(\/|$)/, /(^|\/)\.gg(\/|$)/, /(^|\/)(Roamies|HydraAgent)\/(Skills|Data)(\/|$)/i, /(^|\/)\.tauri(\/|$)/, /\.app(\/|$)/i, /(^|\/)Applications\/(.+\/)?[^/]+\.app(\/|$)/i, /(^|\/)crontab$/,
  /\/Start Menu\/Programs\/Startup(\/|$)/i, /(^|\/)Documents\/(Windows)?PowerShell\/.*profile\.ps1$/i, /^[a-z]:\/(Windows|Program Files( \(x86\))?|ProgramData)(\/|$)/i,
  // Linux: what starts at login (autostart entries, systemd user units, session environment), app launchers and
  // D-Bus services (each names a program the desktop runs), and the X session's startup files.
  /(^|\/)\.config\/(autostart|autostart-scripts|systemd|environment\.d|plasma-workspace\/(env|shutdown))(\/|$)/,
  /(^|\/)\.local\/share\/(systemd|dbus-1|applications|kservices[56]?)(\/|$)/, /\.desktop$/i,
  /(^|\/)\.(xprofile|xinitrc|xsession|xsessionrc|pam_environment|bash_login|bash_logout)$/,
];
// Mac (APFS) and Windows file names ignore case: ~/.ZSHENV is ~/.zshenv and ~/library/launchagents is
// ~/Library/LaunchAgents, even before the folder exists. So each rule also matches without case, but only from the
// home folder down (anchored at ~): a project's own src/cookies or library/mail is not the Mac's.
const homeCase = (list) => list.map((re) => new RegExp(`^(?:${re.source})`, re.flags.replace('i', '') + 'i'));
const CI = new Map([[SECRET, homeCase(SECRET)], [PRIVATE, homeCase(PRIVATE)], [NO_WRITE, homeCase(NO_WRITE)], [OWN_DATA, homeCase(OWN_DATA)]]);
// Case folded the way APFS folds it (ſ is s, the Kelvin sign is k). Only ever compared one path part at a time, so a
// letter whose lower case is longer (İ) can't shift where the home folder ends.
const fold = (s) => String(s).normalize('NFKC').toUpperCase().toLowerCase();
/** Whether a path (absolute, normalized) meets a rule list: as written anywhere, or without case from ~ down. */
const ruleHit = (list, a, home) => {
  const r = rel(a, home);
  return list.some((re) => re.test(r) || re.test(a)) || (!isAbs(r) && CI.get(list).some((re) => re.test(r) || re.test(fold(r))));
};
const SYSTEM_ROOTS = ['/System', '/usr', '/bin', '/sbin', '/etc', '/private', '/Library', '/Applications', '/var', '/opt', '/cores'];

const norm = (p, home) => {
  const s = slash(p).trim().replace(/^["']|["']$/g, '').replace(/^\$\{?HOME\}?(?=\/|$)/, '~'), h = slash(home);
  const abs = s === '~' ? h : s.startsWith('~/') ? path.join(h, s.slice(2)) : isAbs(s) ? s : path.join(h, s);
  return path.normalize(abs).replace(/(.)\/$/, '$1');
};
// The home folder matched without case on a Mac (APFS): /USERS/ken/.ssh is ~/.ssh.
const ciFs = process.platform === 'darwin' || process.platform === 'win32';
const samePart = (a, b) => (ciFs ? fold(a) === fold(b) : a === b);
/** The path below home ('' for home itself), or the path unchanged when it isn't inside home. Part by part. */
const rel = (abs, home) => {
  const A = abs.split('/'), H = slash(home).split('/');
  if (H.length > A.length || !H.every((h, i) => samePart(h, A[i]))) return abs;
  return A.slice(H.length).join('/');
};
const within = (a, top) => rel(a, top) !== a || samePath(a, top);
// Where a path really leads once symlinks are followed (also a dangling link, or a path not made yet): a link in a
// harmless folder can point into ~/.ssh or a startup file.
function realOf(abs, depth = 0) {
  // Only a path this system can look up (a C:/ path on a Mac is just text: never resolved against the working folder).
  if (depth > 8 || (process.platform === 'win32' ? !isAbs(abs) : !abs.startsWith('/'))) return abs;
  try { return slash(fs.realpathSync.native(abs)); } catch {}
  const rest = [];
  let at = abs;
  for (let i = 0; i < 64; i++) {
    try {
      const st = fs.lstatSync(at);
      if (st.isSymbolicLink()) { const t = slash(fs.readlinkSync(at)); return realOf(path.join(isAbs(t) ? t : path.join(path.dirname(at), t), ...rest), depth + 1); }
      return path.join(slash(fs.realpathSync.native(at)), ...rest);
    } catch {
      const up = path.dirname(at);
      if (up === at) return abs;
      rest.unshift(path.basename(at)); at = up;
    }
  }
  return abs;
}
// macOS shows the data volume twice: /System/Volumes/Data/Users/ken is /Users/ken (a firmlink).
const DATA_VOL = /^\/System\/Volumes\/Data(?=\/|$)/i;
const undata = (p) => (process.platform === 'win32' ? p : p.replace(DATA_VOL, '') || '/');
/** The one path every check reads: realpath of the nearest part that exists plus the rest, the data volume's
 *  second name taken off. */
export const canonical = (abs) => undata(realOf(undata(slash(abs))));
// The same path and where it really leads: every rule is checked against both.
// Windows puts a drive on a /-path (/tmp → D:/tmp) and may change letter case: that's the same path, not a link.
const samePath = (a, b) => { const k = (p) => (process.platform === 'win32' ? p.replace(/^[a-z]:(?=\/)/i, '').toLowerCase() : p); return k(a) === k(b); };
const both = (a, b) => (samePath(a, b) ? [a] : [a, b]);
/** { abs, real, all }: the path as written, where it really leads, and both (once each). */
const pathsOf = (p, home) => { const abs = undata(norm(p, home)), real = canonical(abs); return { abs, real, all: both(abs, real) }; };
const homesOf = (home) => both(slash(home), canonical(slash(home)));
const hits = (list, all, homes) => all.some((a) => homes.some((h) => ruleHit(list, a, h)));
// macOS names any file again at the root: /.resolve/<n>/…, /.nofollow/… and /.vol/<dev>/<inode>. Such a path hides
// where it leads from every rule above, so a path whose first part starts with "." is never read or written (V9-1, V9-10).
const rootDot = (all) => all.some((a) => /^\/\.[^/]/.test(a));

// Buttons that delete, pay, send or sign out: Sidekick needs the user's yes before clicking one,
// even if it was asked to "show" it. Kept in sync with RISKY in hands/main.swift.
export const RISKY_CLICK = /(?:^|[^\p{L}])(delete|remove|erase|destroy|wipe|reset|deactivate|close (my |your )?account|close without saving|quit anyway|quit|replace|trash|empty (the )?bin|shut down|restart|post|reply|tweet|don[’']?t save|do not save|move to (the )?(trash|bin)|force quit|overwrite|submit|cancel (my |your |the )?(subscription|plan|membership|account|order)|unsubscribe|pay|purchase|buy|place (the |your )?order|checkout|check out|confirm (payment|order|purchase|transfer)|confirm|send|transfer|withdraw|uninstall|empty trash|discard|sign out|log out|logout|format|revoke|publish|eliminar|borrar|pagar|comprar|enviar|cerrar sesi[oó]n|supprimer|effacer|payer|acheter|envoyer|se d[eé]connecter|d[eé]connexion|l[oö]schen|entfernen|bezahlen|kaufen|senden|abmelden|excluir|apagar|terminar sess[aã]o|elimina|cancella|paga|acquista|invia|esci|verwijderen|betalen|kopen|verzenden|uitloggen|afmelden|padam|hapus|bayar|beli|hantar|kirim|log keluar|nyahlanggan)(?![\p{L}])|删除|刪除|移除|清空|支付|付款|购买|購買|发送|發送|退出登录|登出|注销|削除|消去|支払|購入|送信|ログアウト|退会|삭제|결제|구매|전송|보내기|로그아웃/iu;
export const isRiskyClick = (label) => RISKY_CLICK.test(String(label ?? ''));
// Which kind of risky click a label is ("Delete post" → "delete"), so one yes can cover the same kind and no other.
export function riskyKind(label) {
  const m = RISKY_CLICK.exec(String(label ?? ''));
  return m ? (m[1] ?? m[0]).toLowerCase().replace(/\s+/g, ' ') : null;
}

// Key chords that quit, delete or send, read exactly as the helper's pressKey reads them (hands/main.swift parseKey):
// modifiers anywhere in the chord, the same aliases, and exactly one other key (the helper refuses zero or two, so
// nothing is pressed). Any chord with cmd and q; cmd with delete, backspace or forward delete; cmd+return or enter;
// cmd+shift+d (Mail's Send). Return alone, and Return with other modifiers, is checked by the helper against the
// focused field and the default button. Kept in sync with riskyKey in hands/main.swift. Says what it does, or null.
// pressKey's KEY_ALIASES: a whole chord or one part, swapped before reading.
const PRESS_ALIASES = { '*': 'shift+8', multiply: 'shift+8', times: 'shift+8', '+': 'shift+=', plus: 'shift+=', add: 'shift+=',
  minus: '-', subtract: '-', divide: '/', slash: '/', equals: '=', equal: '=', period: '.', dot: '.', decimal: '.', comma: ',',
  '%': 'shift+5', percent: 'shift+5', '(': 'shift+9', ')': 'shift+0', '!': 'shift+1', '@': 'shift+2', '#': 'shift+3', $: 'shift+4',
  '^': 'shift+6', '&': 'shift+7', _: 'shift+-', '?': 'shift+/', ':': 'shift+;', '"': "shift+'", '<': 'shift+,', '>': 'shift+.',
  '{': 'shift+[', '}': 'shift+]', '|': 'shift+\\', '~': 'shift+`', page_up: 'pageup', page_down: 'pagedown', pgup: 'pageup', pgdn: 'pagedown',
  del: 'forwarddelete', arrowleft: 'left', arrowright: 'right', arrowup: 'up', arrowdown: 'down', spacebar: 'space', back: 'backspace',
  'cmd+end': 'cmd+down', 'cmd+home': 'cmd+up', 'ctrl+end': 'cmd+down', 'ctrl+home': 'cmd+up', 'command+end': 'cmd+down', 'command+home': 'cmd+up' };
// pressKey's KEYS table (hands/main.swift): the only key names it presses.
const PRESS_KEYS = new Set(['return', 'enter', 'tab', 'space', 'delete', 'backspace', 'escape', 'esc', 'left', 'right', 'down', 'up', 'home', 'end', 'pageup', 'pagedown', 'forwarddelete',
  ...'abcdefghijklmnopqrstuvwxyz0123456789'.split(''), 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12', '=', '-', '/', '.', ',', ';', "'", '[', ']', '\\', '`']);
const PRESS_MODS = { cmd: 'cmd', command: 'cmd', ctrl: 'ctrl', control: 'ctrl', opt: 'opt', option: 'opt', alt: 'opt', shift: 'shift' };
/** { mods: Set, key } as pressKey would send it, or null when it wouldn't press anything (no key, or two). */
export function parseKey(combo) {
  let c = String(combo ?? '').toLowerCase().trim().replace(/ /g, '');
  if (PRESS_ALIASES[c]) c = PRESS_ALIASES[c];
  let parts = c.split('+').filter(Boolean);
  if (c.endsWith('++') || c === '+') parts.push('shift', '=');
  parts = parts.flatMap((p) => (PRESS_ALIASES[p] ? PRESS_ALIASES[p].split('+') : [p]));
  const mods = new Set(), keys = [];
  for (const p of parts) { if (PRESS_MODS[p]) mods.add(PRESS_MODS[p]); else keys.push(p); }
  // Exactly one key the helper knows (its KEYS table), or it presses nothing.
  if (keys.length !== 1 || !PRESS_KEYS.has(keys[0])) return null;
  const k = keys[0];
  return { mods, key: k === 'enter' ? 'return' : k === 'backspace' ? 'delete' : k };
}
export function riskyKey(combo) {
  const p = parseKey(combo);
  if (!p || !p.mods.has('cmd')) return null;
  const { mods, key } = p;
  if (key === 'q') return 'quits the app';
  if (key === 'delete' || key === 'forwarddelete') return mods.has('shift') ? 'empties the Trash' : mods.has('opt') ? 'deletes at once' : 'moves to the Trash';
  if (key === 'return') return 'can send a message or form';
  if (key === 'd' && mods.has('shift')) return 'can send (Mail)';
  // Spotlight starts any app, file or command named in it, outside every app check (V9-7).
  if (key === 'space') return 'opens Spotlight, which can start any app or file';
  return null;
}
const SHIFTED = { 1: '!', 2: '@', 3: '#', 4: '$', 5: '%', 6: '^', 7: '&', 8: '*', 9: '(', 0: ')', '-': '_', '=': '+', '[': '{', ']': '}', '\\': '|', ';': ':', "'": '"', ',': '<', '.': '>', '/': '?', '`': '~' };
/** The text a key step types, as pressKey would press it: a character, ' ' for space, '\n' for return or tab, '\b'
 *  for delete (backspace), '' for other keys and for any chord with cmd, ctrl or opt (V9-6: typing key by key). */
export function keyChar(combo) {
  const p = parseKey(combo);
  if (!p || p.mods.has('cmd') || p.mods.has('ctrl') || p.mods.has('opt')) return '';
  const { key } = p, shift = p.mods.has('shift');
  if (key === 'space') return ' ';
  if (key === 'return' || key === 'tab') return '\n';
  if (key === 'delete') return '\b';
  if (key.length !== 1) return '';
  return shift ? SHIFTED[key] ?? key.toUpperCase() : key;
}
/** cmd+v (any order, with shift or opt too): pastes the clipboard. */
export const isPasteKey = (combo) => { const p = parseKey(combo); return !!p && p.key === 'v' && p.mods.has('cmd'); };

/** Tool arguments as they go in the activity log: anything typed into fields or files becomes its length. */
export function redactArgs(name, args = {}) {
  const len = (t) => `[${String(t ?? '').length} chars]`;
  // Steps that aren't a list (a model sent them as one string) are logged as their size only: they can hold typed
  // text too, and reading them as a list crashed the request before the tool could say what was wrong.
  if (name === 'act_in_app') return { ...args, steps: Array.isArray(args.steps) ? args.steps.map((s) => (['type', 'set', 'fill'].includes(s?.do) ? { ...s, text: len(s.text) } : s)) : args.steps == null ? [] : `[${typeof args.steps}, ${len(typeof args.steps === 'string' ? args.steps : JSON.stringify(args.steps)).slice(1)}` };
  if (name === 'write_file') return { path: args.path, content: len(args.content) };
  // What goes to a connected app, a skill's steps and a job's brief can hold their words too.
  if (name === 'use_connection') return { ...args, args: len(args.args) };
  if (name === 'save_skill') return { ...args, steps: len(args.steps) };
  if (name === 'schedule_job') return { ...args, brief: len(args.brief) };
  return args;
}

/** A path's read verdict by the deny rules alone (secrets, Hydra's data, other apps' data, hidden files): what typed
 *  text, a connection's non-path values and open are judged by. Returns { level, reason, path }. */
function readCheck(p, home, { recursive = false } = {}) {
  const { real, all } = pathsOf(p, home), homes = homesOf(home);
  if (rootDot(all)) return { ...verdict(BLOCK, `${p} names a file by a hidden name at the top of the disk, so I don't read it. Use its usual path.`), path: real };
  if (hits(SECRET, all, homes)) return { ...verdict(BLOCK, `${p} holds passwords or keys, so I never read it.`), path: real };
  if (hits(OWN_DATA, all, homes)) return { ...verdict(BLOCK, `${p} is Hydra's own data (memory, chats, settings and Recently deleted), so I don't read it with tools.`), path: real };
  if (hits(PRIVATE, all, homes)) return { ...verdict(BLOCK, `${p} is another app's private data. Reading it sets off macOS privacy prompts.`), path: real };
  // The whole home folder, a folder above it (/Users, /) or all of Library: never searched or listed down through.
  // Anything in Library or AppData is searched never (other apps' data and tokens, seventh review F11).
  const appData = (a) => homes.some((h) => { const r = rel(a, h); return r !== a && ['library', 'appdata'].includes(fold(r.split('/')[0])); });
  const whole = (a) => a === '/' || /^[a-z]:$/i.test(a) || /^(\/Users|\/Volumes|\/home|[a-z]:\/Users)$/i.test(a)
    || homes.some((h) => within(h, a)) || appData(a);
  if (recursive && all.some(whole)) {
    return { ...verdict(BLOCK, `Searching all of ${p} reaches into other apps' data and sets off macOS privacy prompts. Pick a specific folder.`), path: real };
  }
  // A denylist always has gaps, so hidden files and folders (settings and sign-ins of every tool) and app data in the
  // home folder are read only with a yes, every time, naming the real path.
  const hidden = (a) => homes.some((h) => { const r = rel(a, h); return r !== a && r.split('/').some((x) => x.startsWith('.')); });
  if (all.some((a) => hidden(a) || appData(a))) return { ...verdict(ASK, `Read ${real}? It's a hidden or app-data file, which can hold sign-ins.`), path: real, always: true };
  return { ...verdict(SAFE), path: real };
}

/** A hidden or app-data file (which can hold sign-ins): one that reads only with a yes naming it, whatever folder. */
export const isHiddenRead = (p, home) => readCheck(p, home).level === ASK;

// Owner's rule (DESIGN.md decision "Mac actions"): only plain reads run without asking, and only inside these three
// folders. Everything else asks, every time, naming the real target; there is no setting that skips it.
const FREE_ZONES = ['desktop', 'documents', 'downloads'];
/** Inside ~/Desktop, ~/Documents or ~/Downloads (the folder itself too), with no dot-named part on the way. */
const inFreeZone = (a, homes) => homes.some((h) => {
  const r = rel(a, h);
  if (r === a || r === '') return false;
  const parts = r.split('/');
  return FREE_ZONES.includes(fold(parts[0])) && !parts.some((x) => x.startsWith('.'));
});
/** read_file / list_files / search_files and what a screenshot or read_window shows. SAFE only when the path, as
 *  written and where it really leads, is inside ~/Documents, ~/Desktop or ~/Downloads with no dot part and isn't a
 *  secret; BLOCK by the deny rules; anything else ASKs with the real path. Returns { level, reason, path }. */
export function checkRead(p, home, opts = {}) {
  const v = readCheck(p, home, opts);
  if (v.level !== SAFE) return v;
  const { all } = pathsOf(p, home), homes = homesOf(home);
  if (all.every((a) => inFreeZone(a, homes))) return v;
  // A background agent's own folder (own), as it really leads, no dot part: its inputs and the files it made (R10-16).
  if (opts.own) {
    const top = canonical(norm(opts.own, home));
    if (all.every((a) => { const r = rel(a, top); return r !== a && r !== '' && !r.split('/').some((x) => x.startsWith('.')); })) return v;
  }
  return { ...verdict(ASK, `Read ${v.path}? It's outside your Documents, Desktop and Downloads folders.`), path: v.path, always: true };
}

// Apps whose windows only show a page or a document: one of their windows with no file behind it is looked at freely.
const WINDOW_VIEWERS = /^(preview|textedit|pages|numbers|keynote|quicktime player|photos|microsoft (word|excel|powerpoint)|safari|google chrome|chrome|arc|firefox|microsoft edge|brave browser|opera|vivaldi|orion|zen|hydra)$/i;
/** What a window shows (take_screenshot, read_window) before its text or picture reaches the model: each file it has
 *  open (its document, a file:// page) is read like read_file; a window with no file is free only in a viewer app,
 *  any other (Terminal, a password manager, Messages) asks, naming the app (tenth review R10-11). { level, reason }. */
export function checkWindow(win, home) {
  const app = String(win?.app ?? '').trim(), files = [];
  if (win?.document) files.push(String(win.document));
  if (win?.url) { try { const u = new URL(String(win.url).replace(/^view-source:/i, '')); if (u.protocol === 'file:') files.push(decodeURIComponent(u.pathname)); } catch { /* not a URL */ } }
  let worst = verdict(SAFE);
  for (const f of files) {
    const v = checkRead(f, home);
    if (v.level === BLOCK) return verdict(BLOCK, `${app || 'That window'} shows ${f}, so I won't read it or look at it. ${v.reason}`);
    if (v.level === ASK) worst = verdict(ASK, `${v.reason} (${app || 'A window'} has it open.)`);
  }
  if (!files.length && !WINDOW_VIEWERS.test(app)) {
    const title = String(win?.title ?? '').trim();
    worst = { ...verdict(ASK, `Look at ${app ? `the ${app} window${title ? ` "${title}"` : ''}` : "a window I can't name"}? It has no file I can check, so it could show anything (a password, a message, a terminal).`), app };
  }
  return worst;
}

// Files other programs run or load later (scripts, app bundles, Python's .pth, property lists, workflows): a name
// part ending in one of these, or starting with "." (dotfiles and dot folders: shell, git, editor and tool settings),
// is never written without a yes.
// Also files an app or tool runs on its own when it starts or opens a folder (seventh review F9): MATLAB's startup.m,
// package.json scripts, editor workspaces with tasks, mise's config.
// Eighth review V8-9: mise's local and per-env configs (their [hooks] run on cd), Makefiles and Justfiles.
// Ninth review V9-8: build and task files that tools run (Gemfile, Podfile, build.rs, Next.js middleware, any
// *.config.ts, CMake, Gradle, Maven, Docker, tox, pyproject…).
const LOADED = /\.(pth|plist|code-workspace|sublime-project|gradle|gradle\.kts|cmake)$|^(package\.json|startup\.m|finish\.m|\.?mise(\.[^/]+)?\.toml|deno\.jsonc?|bunfig\.toml|makefile|gnumakefile|justfile|\.envrc|gemfile|rakefile|podfile|vagrantfile|brewfile|procfile|fastfile|appfile|dangerfile|guardfile|capfile|build\.rs|(instrumentation|middleware|proxy)(-client)?\.[cm]?[jt]sx?|[^/]*\.config\.[cm]?[jt]sx?|cmakelists\.txt|taskfile(\.dist)?\.ya?ml|(docker-)?compose(\.[^/]+)?\.ya?ml|pom\.xml|lefthook(-local)?\.ya?ml|tox\.ini|pyproject\.toml|setup\.cfg|pytest\.ini|noxfile\.py|conftest\.py|dockerfile(\.[^/]+)?|containerfile|[^/]*\.dockerfile|cargo\.toml|go\.mod|build\.zig|meson\.build|sconstruct|wscript|build\.sbt|mix\.exs|composer\.json|turbo\.json|nx\.json|project\.json|lerna\.json|\.?pre-commit-config\.ya?ml|\.?lintstagedrc[^/]*)$/i;
// A name part as the system reads it: Windows drops trailing dots and spaces (a.bat. is a.bat), and invisible
// characters at the end don't change what opens it.
const bare = (x) => String(x).replace(/[\s.\p{Cf}]+$/u, '');
const runnable = (x) => RUNNABLE.test(bare(x)) || RUNNABLE.test(x);
// .com and .pif run on Windows, but only as the file's own name: a folder called example.com is just a folder.
const LAST_RUNS = /\.(com|pif)$/i;
const riskyParts = (parts) => parts.some((x) => x.startsWith('.') || runnable(x) || LOADED.test(bare(x))) || LAST_RUNS.test(bare(parts.at(-1) ?? ''));
// The only places a new file is made without a yes; folders in them that an app loads code from are not.
const WRITE_ZONES = ['desktop', 'documents', 'downloads'];
const LOAD_DIRS = ['matlab', 'powershell', 'windowspowershell'];

/** write_file. Owner: a new file inside ~/Desktop, ~/Documents or ~/Downloads (and in `own`, an agent's own folder),
 *  with no dot or runnable part, needs no yes; everything else asks every time with the whole real path (overwriting
 *  too, in its own folder as well); secrets, startup files, apps and places outside the home folder never. Only where the path really leads
 *  counts. */
export function checkWrite(p, home, { exists = false, own = null } = {}) {
  const { real, all } = pathsOf(p, home), homes = homesOf(home);
  if (rootDot(all) || hits(SECRET, all, homes) || hits(NO_WRITE, all, homes)) {
    return { ...verdict(BLOCK, `${p} is a protected file (keys, settings, startup scripts or an app), so I won't write to it.`), path: real };
  }
  const inside = (a) => homes.some((h) => within(a, h) && rel(a, h) !== '') || /^\/(private\/)?tmp\//i.test(a);
  if (!inside(real)) { // where it really leads
    return { ...verdict(BLOCK, `I only write files inside your home folder, not ${p}.`), path: real };
  }
  const there = exists || fs.existsSync(real);
  const below = (top) => { const r = rel(real, top); return r !== real && r !== '' ? r.split('/') : null; };
  if (own) {
    const parts = below(canonical(norm(own, home)));
    // Its history and state go into every later run's prompt and the chat's report: never written by the agent (F10).
    if (parts?.length === 1 && /^(history\.md|\.agent\.json)$/i.test(bare(parts[0]))) return { ...verdict(BLOCK, `${parts[0]} is the agent's own record, so it can't write it.`), path: real };
    // Binding D2 (eighth review V8-10): overwriting asks even in its own folder; only a new file there is unasked.
    if (parts && !there && !riskyParts(parts)) return { ...verdict(SAFE), path: real };
  }
  if (there) return { ...verdict(ASK, `Overwrite ${real}?`), path: real, always: true };
  const parts = below(homes[homes.length - 1]);
  if (parts && parts.length >= 2 && WRITE_ZONES.includes(fold(parts[0])) && !(parts.length > 2 && LOAD_DIRS.includes(fold(parts[1]))) && !riskyParts(parts)) return { ...verdict(SAFE), path: real };
  return { ...verdict(ASK, `Create ${real}?`), path: real, always: true };
}

// ---------- opening things and fetching pages ----------

// Runs or follows a link when opened. Windows: script hosts, installers, registry files, shortcuts, control panels.
// Link files (.webloc, .inetloc, .fileloc, .url) carry any scheme or a file:// target, so they count too (F4, F6).
const RUNNABLE = /\.(app|command|sh|bash|zsh|csh|ksh|fish|tool|terminal|scpt|scptd|applescript|workflow|action|pkg|mpkg|dmg|jar|jnlp|py|pyw|pyc|rb|pl|js|jse|mjs|cjs|osax|exe|bat|cmd|ps1|psm1|psd1|vbs|vbe|wsf|wsh|wsc|hta|scr|msi|msp|msix|appx|reg|lnk|url|cpl|appref-ms|shortcut|mobileconfig|kext|plugin|prefPane|saver|desktop|appimage|deb|rpm|run|flatpakref|flatpak|snap|webloc|inetloc|fileloc|afploc|ftploc|smbloc|ics|pyz|jsx|vsix|alfredworkflow|alfredsnippets|sketchplugin|xpi|crx|qlgenerator|mdimporter|bundle|framework|dylib|so|service|tar|tgz|tbz2?|txz|tlz|cpio|xar|zipx?|aar|gz|bz2|xz|lzma|7z|rar|iso|img|sparseimage|sparsebundle|cdr|msc|settingcontent-ms|application|appinstaller|chm|scf|sct|library-ms|search-ms|searchconnector-ms|theme|themepack|deskthemepack|diagcab|wsb|xbap|inf|gadget|iqy|slk|xll|xlam)\/?$/i;
// Archives and disk images (V9-5) unpack what they hold (an executable .command, an app, links) with no quarantine;
// Windows shell, help and Office query files (V9-9) run or reach the network. All of them count as runnable.
// Pages that run script when opened (V9-9): opened only with a yes, naming the file.
const ACTIVE = /\.(html?|xhtml?|xht|shtml|svgz?|webarchive|mht(ml)?)$/i;
// Where installed apps live: opening one there just starts it. Linux lists them as .desktop files. Safari and a few
// other Apple apps really live in a cryptex (/Applications/Safari.app leads there).
const APP_DIRS = ['/Applications/', '/System/Applications/', '/System/Volumes/Preboot/Cryptexes/App/System/Applications/', '/System/Library/CoreServices/', '/usr/share/applications/', '/usr/local/share/applications/', '/var/lib/flatpak/exports/share/applications/', '/var/lib/snapd/desktop/applications/'];
// In one of them, without case (APFS): /applications/Fix.command is /Applications/Fix.command (D5).
const inAppDir = (a) => APP_DIRS.some((d) => fold(a).startsWith(fold(d)));

// Apps that run what they're given (shells, script hosts, interpreters, installers) or hold the Mac's settings: never
// the app something is opened in (seventh review F5; Windows' Start-Process runs the target with it).
const RUNNERS = /^(terminal|iterm2?|warp|ghostty|kitty|alacritty|wezterm|hyper|tabby|rio|script editor|automator|python launcher( \d+)?|pythonw?[\d.]*|py|java|javaw|jar launcher|installer|shortcuts( events)?|osascript|mshta|wscript|cscript|powershell(_ise)?|pwsh|cmd|conhost|wt|windows terminal|bash|sh|zsh|fish|wsl|node|deno|bun|perl|ruby|php|lua|rundll32|regsvr32|msiexec|regedit|reg|certutil|bitsadmin|curl|wget|explorer|xcode|visual studio code|code|cursor|zed|windsurf|vscodium|antigravity|sublime text|nova|bbedit|textmate|macvim|vim|emacs|alfred( \d+)?|raycast|swift playgrounds?|playgrounds|wave|warp preview|archive utility|keychain access|system settings|system preferences|disk utility|console|activity monitor|launchctl|open|start)$/i;
// Editors are runners only for what they're given (a folder's tasks run when it opens): by name alone they open empty.
const EDITORS = /^(xcode|visual studio code|code|cursor|zed|windsurf|vscodium|antigravity|sublime text|nova|bbedit|textmate|macvim|explorer)$/i;
// Apps that only show a file: opening one there needs no yes. Any other app asks, naming the file and the app.
const VIEWERS = /^(preview|textedit|pages|numbers|keynote|quicktime player|photos|finder|microsoft (word|excel|powerpoint)|word|excel|powerpoint|notepad|safari|google chrome|chrome|arc|firefox|microsoft edge|edge|brave browser|brave|opera|vivaldi|orion|zen)$/i;

/** open: websites and mail, documents and folders, and apps by name. Not scripts, installers or odd links.
 *  app: the app to open it in (checked too). ASK carries `always` and the whole real path. */
export function checkOpen(target, home, { executable = false, app = null } = {}) {
  home = slash(home);
  const t = String(target ?? '').trim();
  if (!t) return verdict(BLOCK, 'Nothing to open.');
  let inApp = null;
  if (app != null && String(app).trim()) {
    const a = String(app).trim();
    if (/[/\\:]|\.\./.test(a)) return verdict(BLOCK, `"${a}" isn't an app name.`);
    inApp = bare(a).replace(/\.(app|exe)$/i, '').replace(/\s+/g, ' ');
    if (RUNNERS.test(inApp) || runnable(a) && !/\.app$/i.test(a)) return verdict(BLOCK, `${a} runs what it's given, so I won't open things in it.`);
  }
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(t)?.[1]?.toLowerCase();
  if (scheme && !/^[a-z]:\\/i.test(t)) {
    // A web or mail link in any app that doesn't run what it's given (checked above).
    if (scheme === 'http' || scheme === 'https' || scheme === 'mailto') return verdict(SAFE);
    if (scheme === 'ms-settings' && !inApp) return verdict(SAFE); // a page of Windows Settings, nothing that runs (#81)
    return verdict(BLOCK, `I only open web and mail links, not ${scheme}: links.`);
  }
  if (/^[~/.]/.test(t) || /^[a-z]:\\/i.test(t)) {
    const abs = norm(t, home);
    const r = readCheck(abs, home);
    if (r.level === BLOCK) return verdict(BLOCK, r.reason);
    // Judged where it really leads: a link named notes.txt can lead to an app or a script.
    const all = both(abs, r.path), homes = homesOf(home);
    const inApps = all.every(inAppDir);
    // Only a whole installed app opens unasked: a bundle opened at its root (/Applications/Notes.app), or a Linux
    // launcher straight in an app folder. A script, a tool or anything inside a bundle in those folders is still a
    // program (eighth review V8-1: /Applications/Fix.command ran in Terminal).
    const appRoot = (a) => {
      const parts = a.split('/'), last = bare(parts.at(-1) ?? '');
      if (/\.desktop$/i.test(last)) return APP_DIRS.slice(4).some((d) => fold(path.dirname(a) + '/') === fold(d));
      return inAppDir(a) && /\.app$/i.test(last) && parts.filter((x) => /\.app$/i.test(bare(x))).length === 1 && !parts.slice(0, -1).some((x) => runnable(x));
    };
    const appBundle = all.every(appRoot);
    if ((all.some((a) => a.split('/').some(runnable) || LAST_RUNS.test(bare(a))) || executable) && !appBundle) return verdict(BLOCK, `${t} is a script, installer, link file or app that would run, so I won't open it. Open it yourself if you trust it.`);
    const mine = (a) => homes.some((h) => within(a, h)) || /^\/(private\/)?tmp\//i.test(a);
    if (!inApps && all.some((a) => !mine(a) && SYSTEM_ROOTS.some((d) => a === d || a.startsWith(d + '/')))) return verdict(BLOCK, `${t} is a system file, so I won't open it.`);
    // A startup or settings file, or a hidden or app-data one, opens only with a yes: in an editor the hands tools
    // could change it (seventh review F1), and on screen it can be read.
    if (r.level === ASK || (!appBundle && hits(NO_WRITE, all, homes))) return { ...verdict(ASK, `Open ${r.path}${inApp ? ` in ${inApp}` : ''}? It's a settings, startup, hidden or app-data file.`), always: true };
    if (inApp && !VIEWERS.test(inApp)) return { ...verdict(ASK, `Open ${r.path} in ${inApp}?`), always: true };
    if (all.some((a) => ACTIVE.test(bare(a.split('/').at(-1) ?? '')))) return { ...verdict(ASK, `Open ${r.path}? A page like that can run script when it opens.`), always: true, page: true };
    return verdict(SAFE);
  }
  if (/[/\\]|\.\./.test(t)) return verdict(BLOCK, `"${t}" isn't an app name.`);
  // An app by name is judged like the app= argument (tenth review R10-10): never a shell, script host or settings app.
  const named = bare(t).replace(/\.(app|exe)$/i, '').replace(/\s+/g, ' ');
  if ((RUNNERS.test(named) && !EDITORS.test(named)) || runnable(t) && !/\.app$/i.test(t)) return verdict(BLOCK, `${t} runs what it's given or holds the Mac's settings, so I won't open it. Open it yourself if you need it.`);
  return verdict(SAFE);
}

// Schemes a browser, a file panel or the system acts on by opening a file or running script.
const RUN_SCHEMES = /(?:^|[^a-z0-9+.-])(javascript|vbscript|livescript|data|file|view-source|blob|about|chrome|chrome-extension|edge|brave|opera|vivaldi|x-apple[a-z0-9.-]*|applescript|shortcuts|ms-[a-z0-9-]+|search-ms|smb|afp|nfs|ftp|vnc|ssh|telnet|itms[a-z-]*|steam|vscode|cursor|jetbrains)\s*:/i;
/** A key that moves the caret (arrows, Home, End, Page Up/Down, with any modifiers): what is typed after it can land
 *  anywhere in the text, so the joined text no longer says what the field holds (tenth review R10-9). */
export const movesCaret = (combo) => { const p = parseKey(combo); return !!p && ['left', 'right', 'up', 'down', 'home', 'end', 'pageup', 'pagedown'].includes(p.key); };
/** Text the hands tools type (act_in_app type, fill and set; draw's type): never a link to a file or a page's
 *  source, never a scheme a browser or the system acts on, and a path in it is checked like a read (F2). */
export function checkTyped(text, home) {
  // Invisible characters (a zero-width space before javascript:) and look-alike forms come off first (V8-4).
  const t = String(text ?? '').normalize('NFKC').replace(/\p{Cf}/gu, '');
  const lead = /^\s*([a-z][a-z0-9+.-]*):(?=\S)/i.exec(t)?.[1]?.toLowerCase();
  const port = /^\s*[a-z0-9.-]+:\d+(?:[/?#\s]|$)/i.test(t); // localhost:3000
  // A scheme that opens files or runs script, anywhere in the text (tenth review R10-9: "alert(1)" typed, Home pressed,
  // then "javascript:" leaves a javascript: link in the field), even with nothing after the colon yet.
  const inner = RUN_SCHEMES.exec(t)?.[1]?.toLowerCase();
  if ((lead && !port && !['http', 'https', 'mailto'].includes(lead)) || inner) {
    return verdict(BLOCK, `I only type web and mail addresses, not ${inner ? `${inner}:` : `${lead}:`} links: they open files or run things.`);
  }
  let worst = verdict(SAFE);
  // A path after = (--key=~/.ssh/id_rsa) is a token too; one without a leading ~ or / (.ssh/id_rsa) is checked from
  // the home folder, where Go to Folder and Open panels start (V8-4). Web addresses were checked above.
  for (const tok of t.split(/[\s"'`<>|;,()=]+/)) {
    if (!tok || /^[a-z][a-z0-9+.-]*:\/\//i.test(tok)) continue;
    if (!/^(~|\/|[a-z]:[\\/]|\$\{?HOME)/i.test(tok) && !/[\\/]/.test(tok)) continue;
    const v = readCheck(tok, home);
    if (v.level === BLOCK) return verdict(BLOCK, `I won't type ${tok}: ${v.reason}`);
    if (v.level === ASK) worst = { ...verdict(ASK, `Type the path ${v.path}? It's a hidden or app-data file, which can hold sign-ins.`), always: true };
  }
  return worst;
}

const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|0\.0\.0\.0|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|\[?::1\]?|\[?f[cd][0-9a-f:]*\]?|\[?fe80:[0-9a-f:]*\]?)$/i;

/** An IP address that isn't on the public internet: this computer, the local network, link-local (cloud metadata),
 *  carrier-grade NAT, multicast and reserved ranges, also written as IPv4 inside IPv6 (::ffff:127.0.0.1). */
export function isPrivateAddress(ip) {
  let a = String(ip ?? '').toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const mapped = a.match(/^(?:0*:)*:?ffff:(?:0+:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped) { const hi = parseInt(mapped[1], 16), lo = parseInt(mapped[2], 16); a = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`; }
  const v4 = a.match(/^(?:.*:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [b0, b1] = [Number(v4[1]), Number(v4[2])];
    return b0 === 0 || b0 === 10 || b0 === 127 || (b0 === 100 && b1 >= 64 && b1 <= 127) || (b0 === 169 && b1 === 254) || (b0 === 172 && b1 >= 16 && b1 <= 31)
      || (b0 === 192 && (b1 === 168 || (b1 === 0 && Number(v4[3]) === 0))) || (b0 === 198 && (b1 === 18 || b1 === 19)) || b0 >= 224;
  }
  if (!a.includes(':')) return false;
  return a === '::' || a === '::1' || /^f[cd]/.test(a) || /^fe[89ab]/.test(a) || /^ff/.test(a) || /^64:ff9b:/.test(a) || /^0*:/.test(a) && /^[0:]*(:1)?$/.test(a);
}

/** web_fetch: public web pages only, so a web page can't steer Sidekick into the user's router or local apps.
 *  checkFetch also checks the addresses a name resolves to, before each request and redirect hop. */
export function checkUrl(url) {
  let u;
  try { u = new URL(String(url)); } catch { return verdict(BLOCK, "That isn't a valid link."); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return verdict(BLOCK, 'I only fetch http and https pages.');
  if (u.username || u.password) return verdict(BLOCK, 'Links with passwords in them are blocked.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (PRIVATE_HOST.test(u.hostname) || ((/^[\d.]+$/.test(host) || host.includes(':')) && isPrivateAddress(host))) return verdict(BLOCK, `${u.hostname} is on your own computer or network, so I won't fetch it.`);
  return verdict(SAFE);
}

/** checkUrl, plus a refusal when the host resolves to this computer or the local network (a public name can point at
 *  127.0.0.1). A name that doesn't resolve is let through: the request itself then fails. lookup: dns.lookup's shape. */
export async function checkFetch(url, { lookup = dns.lookup } = {}) {
  const v = checkUrl(url);
  if (v.level === BLOCK) return v;
  const host = new URL(String(url)).hostname.replace(/^\[|\]$/g, '');
  const addrs = await Promise.resolve().then(() => lookup(host, { all: true })).catch(() => []);
  if ((Array.isArray(addrs) ? addrs : []).some((x) => isPrivateAddress(x?.address))) return verdict(BLOCK, `${host} leads to your own computer or network, so I won't fetch it.`);
  return verdict(SAFE);
}

/** A link the user clicked in a reply: opened in their browser, so web and mail links only (no file:, apps or scripts). */
export function checkLink(url) {
  let u;
  try { u = new URL(String(url)); } catch { return verdict(BLOCK, "That isn't a valid link."); }
  if (u.protocol === 'mailto:') return verdict(SAFE);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return verdict(BLOCK, 'Only web and email links open from a reply.');
  if (u.username || u.password) return verdict(BLOCK, 'Links with passwords in them are blocked.');
  return verdict(SAFE);
}

/** A yes from the user, typed or spoken. */
export const isYes = (text) => /^\s*(y|yes|yeah|yep|yup|ok|okay|sure|go|go ahead|do it|run it|allow|confirm)\b/i.test(String(text ?? ''));

// ---------- drawing on screen ----------

/** What a draw call may do beyond drawing. kind: 'open' (a page in the browser, like a link in a reply), 'photo' and
 *  'favicon' (fetched for a card, like web_fetch), 'type' (into a field, like act_in_app: only with actions allowed;
 *  the macOS helper still refuses the HANDS_OFF apps), 'copy' (to the clipboard), 'button' (a next-step button:
 *  ask sends its words as a new request, open and copy follow the rules above). */
export function checkDrawAction({ kind, url, text, action } = {}, { allowActions = false, home = os.homedir() } = {}) {
  switch (kind) {
    case 'open': return checkLink(url);
    case 'photo': case 'favicon': return checkUrl(url);
    case 'type':
      if (!allowActions) return verdict(BLOCK, 'Typing into apps is switched off (Allow File Edits & Commands).');
      if (!String(text ?? '').length || String(text).length > 2000) return verdict(BLOCK, 'Nothing (or far too much) to type.');
      { const v = checkTyped(text, home); return v.level === SAFE ? v : verdict(BLOCK, v.level === ASK ? `${v.reason.replace(/\?.*$/, '')}: a path like that is typed only with a yes (act_in_app).` : v.reason); }
    case 'copy': {
      if (!String(text ?? '').length || String(text).length > 10_000) return verdict(BLOCK, 'Nothing (or far too much) to copy.');
      // What's copied can be pasted into a file panel or an address bar: checked like typed text (V9-6).
      const v = checkTyped(text, home);
      return v.level === SAFE ? v : verdict(BLOCK, v.level === ASK ? `${v.reason.replace(/\?.*$/, '')}: a path like that isn't put on the clipboard.` : v.reason);
    }
    case 'button': {
      const a = action ?? {};
      if (a.do === 'ask') return String(a.value ?? '').trim() ? verdict(SAFE) : verdict(BLOCK, 'A button needs words to ask.');
      if (a.do === 'open') return checkLink(a.value);
      if (a.do === 'copy') return checkDrawAction({ kind: 'copy', text: a.value }, { home });
      return verdict(BLOCK, 'A button can only ask, open a link or copy.');
    }
    case 'handoff': return verdict(SAFE);
    default: return verdict(BLOCK, `${kind} isn't something a drawing can do.`);
  }
}

// ---------- learned skills ----------

// A skill is steps the Roamie follows later, so text that would turn it against the user never gets saved: reading
// secrets, keeping things from them, skipping their yes, or words dressed up as instructions from the app.
const SKILL_RULES = [
  [/(?:^|[\s"'`(/~])(?:\.ssh|\.gnupg|\.aws\/credentials|\.netrc|\.npmrc|\.git-credentials|\.password-store|\.env(?:\.[\w-]+)?|auth\.json|id_(?:rsa|ed25519|ecdsa|dsa)|cookies\.sqlite|key4\.db|login data)(?![\w.-])/i, 'it reads passwords, keys or sign-in files'],
  [/\b(?:keychain|credential manager|find-(?:generic|internet)-password|saved passwords?|browser cookies)\b/i, 'it reads passwords, keys or sign-in files'],
  [/\b(?:don'?t|do not|never|without)\s+(?:tell(?:ing)?|inform(?:ing)?|show(?:ing)?|mention(?:ing)?|alert(?:ing)?|notify(?:ing)?)\s+(?:the\s+)?(?:user|them|him|her|anyone|anybody)\b/i, 'it keeps things from the user'],
  [/\b(?:secretly|covertly|behind (?:their|the user'?s) back|without (?:the user|them) (?:knowing|noticing)|hide (?:it|this|that|them) from)\b/i, 'it keeps things from the user'],
  [/\b(?:skip|bypass|ignore|disable|turn off|avoid|suppress|auto-?approve|without)\b[^.\n]{0,40}\b(?:confirmations?|allow prompts?|approvals?|permissions? prompts?|the yes|asking (?:first|for permission)|safety (?:checks?|rules))\b/i, 'it skips the user\'s yes or the safety checks'],
  [/<\s*\/?\s*(?:important|system|instructions?|admin|override|developer)\b[^>]*>/i, 'it has text dressed up as instructions from the app'],
  [/\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+)?(?:(?:previous|prior|earlier|above|your|other)\s+)+(?:instructions|rules|prompts?|guidelines)\b/i, 'it has text dressed up as instructions from the app'],
];

/** A learned skill's whole text (name, description and steps): SAFE, or BLOCK with the reason. */
export function checkSkill(text) {
  const t = String(text ?? '');
  for (const [re, why] of SKILL_RULES) if (re.test(t)) return verdict(BLOCK, `That skill can't be saved: ${why}.`);
  return verdict(SAFE);
}

// ---------- MCP connections ----------

export const MCP_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/i;
// Programs that run whatever code they're given: never a connection's command.
const SHELLS = ['powershell', 'pwsh', 'cmd', 'sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh', 'python', 'python3', 'node', 'perl', 'ruby', 'php', 'osascript', 'swift', 'deno', 'bun', 'lua'];
const MCP_NO_RUN = new Set([...SHELLS, 'curl', 'wget', 'sudo', 'su', 'doas', 'env', 'xargs', 'eval', 'exec', 'nohup', 'open', 'start', 'rm', 'osascript']);
const INLINE_CODE = new Set(['-c', '-e', '--eval', '-p', '--print', '-command', '-encodedcommand', '/c', '/k']);
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[?::1\]?)$/i;

/** A server about to be added: { name, command, args } (runs on this computer) or { name, url } (a remote one).
 *  Never SAFE: adding one always asks, even with Allow prompts skipped. BLOCK for shells, inline code, a command line
 *  smuggled into the arguments, or an address that isn't https (http only on this computer) or carries a password. */
export function checkMcpServer({ name, command, args = [], url } = {}) {
  if (!MCP_NAME.test(String(name ?? ''))) return verdict(BLOCK, 'The name must be 1 to 32 letters, digits, dashes or underscores.');
  if (!!command === !!url) return verdict(BLOCK, 'A connection needs either a command (a server on this computer) or a url (a remote one), not both.');
  if (url) {
    let u;
    try { u = new URL(String(url)); } catch { return verdict(BLOCK, "That isn't a valid address."); }
    if (u.username || u.password) return verdict(BLOCK, 'Addresses with passwords in them are blocked; a key goes in its own field.');
    const local = LOCAL_HOST.test(u.hostname);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return verdict(BLOCK, 'A remote server needs an https address (plain http only on this computer).');
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (!local && (PRIVATE_HOST.test(u.hostname) || ((/^[\d.]+$/.test(host) || host.includes(':')) && isPrivateAddress(host)))) return verdict(BLOCK, `${u.hostname} is on your local network; only public servers or this computer.`);
    return verdict(ASK, `Connect to ${u.origin}${u.pathname === '/' ? '' : u.pathname}`);
  }
  const all = [String(command), ...(Array.isArray(args) ? args : []).map(String)];
  if (all.some((a) => /[;&|`$<>\n\r]|\$\(/.test(a))) return verdict(BLOCK, 'The command has shell symbols in it (; & | ` $ < >); give the program and its arguments plainly.');
  const prog = slash(command).split('/').pop().toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
  if (MCP_NO_RUN.has(prog)) return verdict(BLOCK, `${prog} can run anything, so it can't start a connection. Use the server's own command (npx, uvx, docker or its program).`);
  if (all.slice(1).some((a) => INLINE_CODE.has(a.toLowerCase()))) return verdict(BLOCK, 'Inline code in the arguments is blocked; use the server\'s own package or program.');
  return verdict(ASK, `Run ${all.join(' ')}`);
}

// Verbs that act on the world: a tool named like this always asks, whatever the server says about it.
const MCP_RISKY = /(?:^|_)(send|delete|remove|trash|destroy|erase|wipe|drop|purge|truncate|pay|payment|payments|purchase|buy|charge|transfer|withdraw|refund|publish|post|tweet|reply|forward|invite|share|cancel|revoke|unsubscribe|deploy|kill|terminate|execute|exec|sql|migration|migrate|reset|merge|archive)(?:_|$)/;
// Every string in a call's arguments at any depth, each line of it on its own too (V8-6: nothing is skipped). More than
// LIMIT strings, or one line longer than MAX_ARG, is too much to check: such a call is never SAFE.
const MAX_ARG = 4096, LIMIT = 2000;
const strings = (v) => {
  const out = [], stack = [v], seen = new Set();
  let over = false;
  while (stack.length) {
    const x = stack.pop();
    if (typeof x === 'string') {
      for (const line of [x, ...(/[\n\r\u2028\u2029]/.test(x) ? x.split(/[\n\r\u2028\u2029]+/) : [])]) {
        if (out.length >= LIMIT) { over = true; break; }
        out.push(line);
      }
    } else if (x && typeof x === 'object' && !seen.has(x)) { seen.add(x); stack.push(...Object.values(x)); if (stack.length > LIMIT * 4) { over = true; break; } }
    if (over) break;
  }
  return { list: out, over };
};
const snake = (s) => String(s ?? '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^a-z0-9]+/gi, '_').toLowerCase();

// Names that write, whatever the server says (a server's readOnlyHint is its own claim, so it's trusted only for a
// name that reads: get, list, search, read…).
const MCP_READS = new Set(['get', 'list', 'search', 'read', 'fetch', 'describe', 'find', 'lookup', 'show', 'count', 'view', 'browse', 'retrieve', 'inspect', 'status', 'info', 'details', 'stats', 'summary', 'check']);
const MCP_WRITES = /(?:^|_)(update|set|write|move|run|invoke|batch|apply|create|add|delete|remove|send|post|publish|execute|exec|sql|query|insert|upsert|patch|put|edit|modify|change|rename|upload|import|deploy|rent|buy|share|label|archive|merge|reset|trash|pay|transfer|request|call|trigger|start|stop|cancel|grant|revoke|invite|assign|close|open|submit|sync|mark|flag|pin|star|snooze|mute|follow|unfollow|like|react|vote|accept|reject|approve|deny|confirm|book|reserve|order|checkout|cart|purchase|subscribe|unsubscribe|enable|disable|toggle|save|block|ban|lock|unlock|schedule|notify|message|email|mail|dm|compose|draft|rm|del|unlink|kill|clear|empty|flush|push|commit|revert|rollback|restore|reply|forward|tweet|comment|review|rate|transfer|withdraw|refund|charge|tip|donate|claim|redeem|register|login|logout|signin|signout|replace|overwrite|quit|shutdown|reboot|restart|install|uninstall|prune|discard|cleanup|clean|evict|format|eval|spawn|nuke|runcmd|cmd|checkout|check_out|purge|drop|destroy|wipe|erase|terminate|truncate|expire|scrub|kill|remove|delete|exec|execute|launch|deploy|migrate)(?:_|$)/;
/** A call to a connected server's tool: { name, annotations }. A read-only tool (readOnlyHint, not destructive, not
 *  named like an action) is SAFE. Anything else ASKs; `always` (destructive, or named send/delete/pay…) means even
 *  only the owner answers it (an agent job's answer_agent can't say yes). */
export function checkMcpCall({ name, annotations, args, home = os.homedir() } = {}) {
  const a = annotations ?? {};
  // A server's file tools would read past every rule (seventh review F7): each string it's sent that could be a path
  // (from the home folder when it's relative) is checked like read_file. A secret never goes; a hidden or app-data
  // file asks.
  // A tool that searches or lists is checked as a recursive read: never the whole home folder, / or Library (V8-6).
  const recursive = /(?:^|_)(search|find|grep|glob|list|ls|tree|walk|scan|index|ripgrep|rg|browse|crawl|directory|dir)(?:_|$)/.test(snake(name));
  let pathAsk = null, tooBig = null;
  const { list, over } = strings(args);
  if (over) tooBig = 'It sends more than I can check.';
  for (const s of list) {
    let p = s.trim();
    // A web address is the web; any other scheme (file:, fs:, vscode-file:) names a file by its path.
    if (/^https?:\/\//i.test(p) || /^mailto:/i.test(p)) continue;
    const u = /^[a-z][a-z0-9+.-]*:\/\//i.test(p) ? (() => { try { return new URL(p); } catch { return null; } })() : null;
    if (u) { try { p = decodeURIComponent(`${u.host ? `/${u.host}` : ''}${u.pathname}`); } catch { p = u.pathname; } }
    if (!p) continue;
    // Checked after the server would normalize it (a/../ undone), so length alone never hides one (4663 chars of a/../).
    const n = path.normalize(slash(p).replace(/^~(?=\/|$)/, slash(home)));
    if (n.length > MAX_ARG) { tooBig = 'One of its values is too long to check.'; continue; }
    // A value that names a file (from / or ~, a drive, $HOME, or a file-like link) is read like read_file: outside
    // Documents, Desktop and Downloads it asks. Other words are only checked against the deny rules.
    // A relative path (Projects/notes.txt: one word with a slash) is read from home too (tenth review R10-3).
    const named = !!u || /^(~|\/|[a-z]:[\\/]|\$\{?HOME)/i.test(p) || /^[^\s/\\][^\s]*[\\/][^\s]*$/.test(p);
    const read = named ? checkRead : readCheck;
    const v = read(p, home, { recursive });
    const v2 = u && u.host ? read(decodeURIComponent(u.pathname), home, { recursive }) : null;
    if (v2?.level === BLOCK) return verdict(BLOCK, `It would send ${s}: ${v2.reason}`);
    if (v.level === BLOCK) return verdict(BLOCK, `It would send ${s}: ${v.reason}`);
    if (v.level === ASK) pathAsk = { ...verdict(ASK, `It reaches ${v.path}${named && v.reason.includes('outside') ? ', outside your Documents, Desktop and Downloads folders' : ', a hidden or app-data file that can hold sign-ins'}.`), always: true };
  }
  if (a.destructiveHint === true || MCP_RISKY.test(snake(name))) return { ...verdict(ASK, 'It can change, send or delete things.'), always: true };
  // An allowlist: readOnlyHint (the server's own claim) makes a call SAFE only when its name reads (a read verb in it)
  // and nothing in it writes. Everything else asks.
  const words = snake(name).split('_').filter(Boolean);
  if (a.readOnlyHint === true && words.some((w) => MCP_READS.has(w)) && !MCP_WRITES.test(snake(name))) {
    // What can't be checked never goes to it (V8-6: blocked, not skipped).
    if (tooBig) return verdict(BLOCK, `${tooBig} I don't send what I can't check.`);
    // Owner's rule (tenth review R10-3): only reads of his three folders and Hydra's own data are free. A connected
    // server's read sends its answer to the model (a password manager's item, a mail search), so it asks too.
    return pathAsk ?? { ...verdict(ASK, 'It only reads, but what it reads goes to the model.'), always: true };
  }
  // Owner: anything that might change, send or delete asks every time.
  return { ...verdict(ASK, "The server doesn't say it only reads."), always: true };
}
