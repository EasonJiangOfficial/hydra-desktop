// What Sidekick may do on its own, what needs a yes from the user first, and what it never does.
// Pure functions so every rule is tested (test/safety.test.mjs). When unsure, ask; never guess "safe".
import dns from 'node:dns/promises';
import fs from 'node:fs';
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
  /(^|\/)\.docker\/config\.json$/, /(^|\/)\.netrc$/, /(^|\/)\.npmrc$/, /(^|\/)\.pypirc$/, /(^|\/)\.git-credentials$/,
  /(^|\/)\.config\/gh(\/|$)/, /(^|\/)\.config\/gcloud(\/|$)/, /(^|\/)\.gg\/auth\.json$/, /(^|\/)(Roamies|HydraAgent)\/Data\/secrets\.json$/i, /(^|\/)\.tauri(\/|$)/,
  /(^|\/)Library\/Keychains(\/|$)/, /(^|\/)Library\/Cookies(\/|$)/, /\/(Cookies|Login Data|Web Data)(-journal)?$/,
  /(^|\/)\.env(\.[\w-]+)?$/, /\.(pem|p12|pfx|key|keystore|jks)$/i, /(^|\/)id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/,
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
// Writing here could let something run on its own later, or break the Mac.
const NO_WRITE = [
  // A repo's hooks, config and attributes (its own, a worktree's or a submodule's) run programs on the next git command.
  /(^|\/)\.git\/(.*\/)?hooks(\/|$)/i, /(^|\/)\.git\/(.*\/)?config(\.worktree)?$/i,
  /(^|\/)\.git\/(.*\/)?(info\/attributes|objects\/info\/alternates|commondir)$/i,
  /(^|\/)\.(zshrc|zprofile|zshenv|zlogin|bashrc|bash_profile|profile|login|inputrc)$/, /(^|\/)\.config\/fish(\/|$)/,
  /(^|\/)Library\/(LaunchAgents|LaunchDaemons|StartupItems|Preferences|Keychains|Application Support\/com\.apple)(\/|$)/,
  /(^|\/)\.gitconfig$/, /(^|\/)\.ssh(\/|$)/, /(^|\/)\.gg(\/|$)/, /(^|\/)(Roamies|HydraAgent)\/(Skills|Data)(\/|$)/i, /(^|\/)\.tauri(\/|$)/, /\.app(\/|$)/i, /(^|\/)crontab$/,
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
const CI = new Map([[SECRET, homeCase(SECRET)], [PRIVATE, homeCase(PRIVATE)], [NO_WRITE, homeCase(NO_WRITE)]]);
/** Whether a path (absolute, normalized) meets a rule list: as written anywhere, or without case from ~ down. */
const ruleHit = (list, a, home) => {
  const r = rel(a, home);
  return list.some((re) => re.test(r) || re.test(a)) || (!isAbs(r) && CI.get(list).some((re) => re.test(r)));
};
// A repo's own settings that make git run programs, or point it at others: asked for, whoever writes them.
const GIT_ASK = [/(^|\/)\.git$/, /(^|\/)\.gitattributes$/i, /(^|\/)\.gitmodules$/i];
const SYSTEM_ROOTS = ['/System', '/usr', '/bin', '/sbin', '/etc', '/private', '/Library', '/Applications', '/var', '/opt', '/cores'];

const norm = (p, home) => {
  const s = slash(p).trim().replace(/^["']|["']$/g, '').replace(/^\$\{?HOME\}?(?=\/|$)/, '~'), h = slash(home);
  const abs = s === '~' ? h : s.startsWith('~/') ? path.join(h, s.slice(2)) : isAbs(s) ? s : path.join(h, s);
  return path.normalize(abs).replace(/(.)\/$/, '$1');
};
const rel = (abs, home) => { const h = slash(home); return abs === h ? '' : abs.startsWith(h + '/') ? abs.slice(h.length + 1) : abs; };
// Where a path really leads once symlinks are followed (also a dangling link, or a path not made yet): a link in a
// harmless folder can point into ~/.ssh or a startup file.
function realOf(abs, depth = 0) {
  if (depth > 8) return abs;
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
// The same path and where it really leads: every rule is checked against both.
// Windows puts a drive on a /-path (/tmp → D:/tmp) and may change letter case: that's the same path, not a link.
const samePath = (a, b) => { const k = (p) => (process.platform === 'win32' ? p.replace(/^[a-z]:(?=\/)/i, '').toLowerCase() : p); return k(a) === k(b); };
const bothOf = (abs) => { const r = realOf(abs); return samePath(r, abs) ? [abs] : [abs, r]; };

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
  return null;
}

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

/** read_file / list_files / search_files. Returns { level, reason, path }. */
export function checkRead(p, home, { recursive = false } = {}) {
  home = slash(home);
  const abs = norm(p, home), all = bothOf(abs), hit = (list) => all.some((a) => list.some((re) => re.test(rel(a, home)) || re.test(a)));
  if (all.some((a) => ruleHit(SECRET, a, home))) return { ...verdict(BLOCK, `${p} holds passwords or keys, so I never read it.`), path: abs };
  if (all.some((a) => ruleHit(PRIVATE, a, home))) return { ...verdict(BLOCK, `${p} is another app's private data. Reading it sets off macOS privacy prompts.`), path: abs };
  if (recursive && (abs === home || abs === '/' || /^[a-z]:$/i.test(abs) || abs === path.join(home, 'Library') || abs === path.join(home, 'AppData') || /^(\/Users|\/Volumes|\/home|[a-z]:\/Users)$/i.test(abs))) {
    return { ...verdict(BLOCK, `Searching all of ${p} reaches into other apps' data and sets off macOS privacy prompts. Pick a specific folder, or use Spotlight (mdfind) to find files by name.`), path: abs };
  }
  return { ...verdict(SAFE), path: abs };
}

/** write_file. Existing files need a yes; secrets, startup files and system folders never. `own`: a folder that is
 *  the writer's own (an agent's folder), where overwriting needs no yes; only where the path really leads counts. */
export function checkWrite(p, home, { exists = false, own = null } = {}) {
  home = slash(home);
  const abs = norm(p, home), r = rel(abs, home), all = bothOf(abs);
  if (all.some((a) => ruleHit(SECRET, a, home) || ruleHit(NO_WRITE, a, home))) {
    return { ...verdict(BLOCK, `${p} is a protected file (keys, settings, startup scripts or an app), so I won't write to it.`), path: abs };
  }
  const realHome = realOf(home), inside = (a) => [home, realHome].some((h) => a.startsWith(h + '/')) || /^\/(private\/)?tmp\//.test(a);
  if (!all.every(inside)) {
    return { ...verdict(BLOCK, `I only write files inside your home folder, not ${p}.`), path: abs };
  }
  if (exists && own) {
    const o = norm(own, home), ro = realOf(o), within = (a) => [o, ro].some((d) => a === d || a.startsWith(d + '/'));
    if (all.every(within)) return { ...verdict(SAFE), path: abs };
  }
  if (exists) return { ...verdict(ASK, `Overwrite ${r || abs}?`), path: abs, always: true };
  if (all.some((a) => GIT_ASK.some((re) => re.test(rel(a, home)) || re.test(a)))) return { ...verdict(ASK, `${r || abs} tells git where its settings are, or which programs to run on files: write it?`), path: abs, always: true };
  return { ...verdict(SAFE), path: abs };
}

// ---------- shell commands ----------

// Split into simple commands on ; && || | & and newlines, outside quotes. Returns null if quoting is unbalanced.
export function splitCommand(cmd) {
  const parts = []; let cur = '', q = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) { cur += c; if (c === q) q = null; else if (c === '\\' && q === '"') cur += cmd[++i] ?? ''; continue; }
    if (c === '\\') { cur += c + (cmd[++i] ?? ''); continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    // 2>&1, <&3 and &>file are redirects, not "run in the background".
    if (c === '&' && (cmd[i - 1] === '>' || cmd[i - 1] === '<' || (cmd[i + 1] === '>' && cmd[i - 1] !== '&'))) { cur += c; continue; }
    // >| (write even with noclobber) is a redirect too, not a pipe.
    if (c === '|' && cmd[i - 1] === '>') { cur += c; continue; }
    if (c === ';' || c === '\n' || c === '|' || c === '&') {
      if (cur.trim()) parts.push({ text: cur.trim(), pipeIn: false });
      cur = '';
      if ((c === '|' || c === '&') && cmd[i + 1] === c) i++;
      else if (c === '|') parts.push({ pipe: true });
      continue;
    }
    cur += c;
  }
  if (q) return null;
  if (cur.trim()) parts.push({ text: cur.trim() });
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].pipe) { if (out.length && parts[i + 1] && !parts[i + 1].pipe) parts[i + 1].pipeIn = true; continue; }
    out.push(parts[i]);
  }
  return out;
}

const words = (s) => (s.match(/"(?:\\.|[^"])*"|'[^']*'|\S+/g) ?? []).map((w) => w.replace(/^(['"])([\s\S]*)\1$/, '$2'));
// Skip env assignments and wrappers to find the program that really runs. `assigns`: it sets environment variables
// for it (PAGER=, MANPAGER=, GIT_EXTERNAL_DIFF= and the like can make a read-only program run another one).
function program(ws) {
  let i = 0, assigns = false;
  while (i < ws.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(ws[i])) { i++; assigns = true; }
  while (i < ws.length && ['command', 'builtin', 'exec', 'nohup', 'time', 'nice', 'caffeinate', 'env', 'xargs', 'stdbuf'].includes(path.basename(ws[i]))) {
    i++; while (i < ws.length && ws[i].startsWith('-')) i++;
    while (i < ws.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(ws[i])) { i++; assigns = true; }
  }
  return { name: slash(ws[i] ?? '').split('/').pop().replace(/\.(exe|com|bat|cmd)$/i, ''), args: ws.slice(i + 1), assigns };
}
// "Read-only" programs that still write a file named in their arguments, or run another program they're given.
// Said why, or null when the arguments are harmless.
function sideEffect(name, args) {
  const plain = args.filter((a) => !a.startsWith('-')), flag = (re) => args.some((a) => re.test(a));
  if (name === 'sort' && flag(/^(-o.*|--output(=.*)?)$/)) return '`sort -o` writes a file.';
  if (name === 'uniq' && plain.length >= 2) return '`uniq` with two files writes the second one.';
  if (name === 'xxd' && (flag(/^-r/) || plain.length >= 2)) return '`xxd` here writes a file.';
  if (name === 'tree' && flag(/^-o/)) return '`tree -o` writes a file.';
  if (name === 'file' && flag(/^-C$/)) return '`file -C` writes a file.';
  if ((name === 'less' || name === 'more') && flag(/^(-[oO].*|--log-file(=.*)?|--LOG-FILE(=.*)?)$/)) return '`less` here writes a log file.';
  if ((name === 'less' || name === 'more') && flag(/^\+/)) return '`less +…` runs a command (+! runs a shell).';
  if (name === 'man' && flag(/^(-[PHt].*|--pager(=.*)?|--html(=.*)?)$/)) return '`man` here runs another program.';
  if ((name === 'rg' || name === 'ag') && flag(/^(--pre(-glob)?(=.*)?|--pager(=.*)?|--search-zip|-z)$/)) return `\`${name}\` here runs another program on each file.`;
  if (name === 'fd' && flag(/^(-x|-X|--exec(-batch)?(=.*)?)$/)) return '`fd` here runs a command on each file.';
  if (name === 'sysctl' && (flag(/^-w$/) || plain.some((a) => a.includes('=')))) return '`sysctl` here changes system settings.';
  if (name === 'git' && flag(/^--(output|ext-diff|textconv)(=.*)?$/)) return '`git` here writes a file or runs a diff program.';
  return null;
}

const BLOCKED_PROGRAMS = {
  sudo: 'needs admin rights', doas: 'needs admin rights', su: 'switches user', mkfs: 'erases disks', newfs_apfs: 'erases disks',
  newfs_hfs: 'erases disks', fdisk: 'edits disk partitions', gpt: 'edits disk partitions', csrutil: 'changes Mac security',
  nvram: 'changes firmware settings', bless: 'changes how the Mac boots', shutdown: 'shuts the Mac down', reboot: 'restarts the Mac',
  halt: 'shuts the Mac down', launchctl: 'installs or stops background services', crontab: 'schedules commands to run on their own',
  tccutil: 'resets privacy permissions', systemsetup: 'changes system settings', dscl: 'edits user accounts', sysadminctl: 'edits user accounts',
  passwd: 'changes passwords', chflags: 'changes protected file flags', kextload: 'loads kernel code', spctl: 'changes app security checks',
  srm: 'shreds files', shred: 'shreds files', wipefs: 'erases disks', fsck: 'repairs disks', mount: 'mounts disks', umount: 'unmounts disks',
  // Windows
  format: 'erases disks', diskpart: 'edits disks', bcdedit: 'changes how Windows boots', vssadmin: 'deletes backups', wbadmin: 'deletes backups',
  schtasks: 'schedules commands to run on their own', takeown: 'takes over protected files', runas: 'needs admin rights', cipher: 'can wipe disk space',
  sc: 'installs or stops services', netsh: 'changes network and firewall settings', setx: 'changes system settings for good',
  // Linux
  pkexec: 'needs admin rights', 'systemd-run': 'starts programs as background services', at: 'schedules commands to run on their own',
  batch: 'schedules commands to run on their own', 'kwallet-query': 'reads your saved passwords',
};
const SHELLS = new Set(['powershell', 'pwsh', 'cmd', 'sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh', 'python', 'python3', 'node', 'perl', 'ruby', 'php', 'osascript', 'swift', 'deno', 'bun', 'lua']);
// Read-only programs that are fine to run without asking (paths still checked).
const READ_ONLY = new Set([
  'ls', 'cd', 'pwd', 'date', 'cal', 'whoami', 'id', 'uname', 'sw_vers', 'hostname', 'uptime', 'which', 'type', 'whereis', 'echo', 'printf',
  'cat', 'head', 'tail', 'less', 'more', 'wc', 'file', 'stat', 'du', 'df', 'tree', 'basename', 'dirname', 'realpath', 'readlink',
  'grep', 'egrep', 'fgrep', 'rg', 'ag', 'find', 'fd', 'mdfind', 'mdls', 'locate', 'sort', 'uniq', 'cut', 'tr', 'column', 'jq', 'diff', 'cmp',
  'ps', 'pgrep', 'top', 'vm_stat', 'sysctl', 'system_profiler', 'ioreg', 'pmset', 'defaults', 'networksetup', 'scutil', 'ifconfig',
  'sw_vers', 'arch', 'nproc', 'env', 'printenv', 'true', 'false', 'test', 'seq', 'expr', 'bc', 'md5', 'shasum', 'cksum', 'xxd', 'od',
  'man', 'tldr', 'git', 'npm', 'node', 'python3', 'python', 'brew', 'cargo', 'rustc', 'go', 'java', 'ruby', 'pip', 'pip3',
]);
// For tools that change things depending on the subcommand, these subcommands only look.
const READ_ONLY_SUB = {
  // Only the looking forms: `git branch -D`, `git tag -d`, `git remote add` change the repo. diff, show, blame and
  // log -p can run a program a downloaded repo's own settings name (textconv), so they ask.
  // Not status, ls-files or describe: they read the working files, and a repo's .gitattributes can name a filter
  // program its .git/config runs on them (no setting turns every filter off), so those ask.
  git: /^(rev-parse|shortlog|config\s+--get\b|stash\s+list|--version|-v)\b|^log\b(?!.*\s(-p|-u|--patch|-L|--ext-diff|--textconv)\b)|^branch(\s+(-a|-r|-v|-vv|--list|--all|--remotes|--show-current|--merged|--no-merged|--contains))*\s*$|^tag(\s+(-l|--list)(\s+[^-\s]\S*)?)?\s*$|^remote(\s+-v)?\s*$|^remote\s+(show|get-url)\s+\S+\s*$/,
  // Exactly these, and never with fix (npm audit fix changes packages).
  npm: /^(?!.*(^|\s)(--)?fix(\s|=|$))(ls|list|view|info|outdated|audit|--version|-v|-h|help|config\s+get|root|prefix|bin|search|explain|why)(\s|$)/,
  // scutil only reads with these (scutil --set renames the Mac).
  scutil: /^(--get|-r|--dns|--proxy|--nwi|--nc\s+list)(\s|$)/,
  brew: /^(list|ls|info|search|outdated|deps|leaves|config|doctor|--version|--prefix|home)\b/,
  cargo: /^(--version|-V|tree|metadata|search)\b/, pip: /^(list|show|freeze|--version|search)\b/, pip3: /^(list|show|freeze|--version)\b/,
  defaults: /^(read|domains|find|read-type)\b/, networksetup: /^-(list|get)/, pmset: /^-g\b/,
  node: /^(-v|--version)$/, python3: /^(-V|--version)$/, python: /^(-V|--version)$/, ruby: /^(-v|--version)$/, go: /^(version|env)\b/,
  java: /^(-version|--version)$/, rustc: /^(-V|--version)$/, env: /^$/, printenv: /^$/,
};

function checkSimple(text, pipeIn, home, cwd = home, opts = {}) {
  const ws = words(text);
  const prog = program(ws), args = prog.args;
  // Path checks see relative arguments from the folder a cd moved to.
  const at = (a) => (cwd !== home && !a.startsWith('-') && !/^[~/$]/.test(a) && !/^[a-z]:[\\/]/i.test(a) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(a) ? path.join(cwd, slash(a)) : a);
  const pathArgs = args.map(at);
  const name = prog.name.replace(/^(mkfs|newfs|fsck)[._].*$/, '$1').toLowerCase();
  const joined = args.join(' ');
  if (!name) return verdict(SAFE);
  if (BLOCKED_PROGRAMS[name]) return verdict(BLOCK, `\`${name}\` ${BLOCKED_PROGRAMS[name]}.`);
  if (name === 'diskutil' && /\b(erase\w*|partition\w*|zero\w*|secureErase|reformat|apfs\s+(delete|erase)\w*|unmount\w*|eject)\b/i.test(joined)) return verdict(BLOCK, '`diskutil` would erase or change a disk.');
  if (name === 'dd' && /\bof=/.test(joined)) return verdict(BLOCK, '`dd` writing to a file or disk can wipe it.');
  if (name === 'security' && /\b(find-(generic|internet)-password|dump-keychain|export|delete-keychain|unlock-keychain|set-keychain|add-trusted-cert|authorizationdb)\b/.test(joined)) return verdict(BLOCK, '`security` would read or change your saved passwords and certificates.');
  if (name === 'reg' && /^(delete|add|import|restore|load|copy)\b/i.test(joined)) return verdict(BLOCK, '`reg` would change the Windows registry.');
  // Linux: the desktop's keyring, background services and the D-Bus calls that reach either.
  if (name === 'secret-tool') return verdict(BLOCK, '`secret-tool` reads or changes your saved passwords.');
  if (name === 'systemctl' && /\b(enable|disable|reenable|preset|start|stop|restart|reload|try-restart|kill|mask|unmask|link|edit|revert|set-default|isolate|daemon-reload|reboot|poweroff|halt|suspend|hibernate|set-environment|import-environment)\b/.test(joined)) return verdict(BLOCK, '`systemctl` here installs, starts or stops background services.');
  if (['gdbus', 'dbus-send', 'busctl', 'qdbus', 'qdbus6'].includes(name) && /org\.freedesktop\.(secrets|impl\.portal\.Secret)|org\.kde\.kwalletd|org\.gnome\.keyring|org\.freedesktop\.systemd1/i.test(joined)) return verdict(BLOCK, `\`${name}\` here would reach your saved passwords or background services.`);
  if ((name === 'powershell' || name === 'pwsh') && /(-e(nc(odedcommand)?)?\s|iex\b|invoke-expression|downloadstring|downloadfile|invoke-webrequest|\biwr\b|start-bitstransfer|set-executionpolicy|remove-item\b.*-recurse)/i.test(joined)) return verdict(BLOCK, 'that PowerShell command downloads and runs code, or deletes whole folders.');
  if (['rd', 'rmdir', 'del', 'erase'].includes(name) && /\/s\b/i.test(joined)) {
    const t = args.filter((a) => !a.startsWith('/'));
    if (!t.length || t.some((x) => { const a = norm(x.replace(/[\\/]\*(\.\*)?$/, ''), home); return a === home || /^[a-z]:\/?$/i.test(a) || path.dirname(a) === path.dirname(home) || /\/(Desktop|Documents|Downloads)$/i.test(a); })) return verdict(BLOCK, 'that would delete a whole folder like your home, Desktop or Documents.');
    return verdict(ASK, 'This deletes folders and everything inside them.');
  }
  if (pipeIn && SHELLS.has(name)) return verdict(BLOCK, `piping into \`${name}\` runs code that hasn't been checked (like a downloaded script).`);
  if (SHELLS.has(name) && /(^|\s)-(c|e)\b/.test(joined) && !READ_ONLY_SUB[name]?.test(joined)) {
    const inner = joined.replace(/^.*?-(c|e)\s+/, '');
    const v = classifyCommand(inner, home, { cwd, own: opts.own });
    return v.level === SAFE ? verdict(ASK) : v;
  }
  if (['eval', 'source', '.'].includes(name)) return verdict(ASK);
  if ((name === 'killall' || name === 'pkill') && /\b(WindowServer|loginwindow|launchd|kernel_task|Finder|Dock|SystemUIServer|coreaudiod)\b/i.test(joined)) return verdict(BLOCK, `stopping ${joined} would break the Mac until a restart.`);
  if (name === 'kill' && /(^|\s)(-\d+\s+)?(1|-1)$/.test(joined)) return verdict(BLOCK, '`kill` on every process would crash the Mac.');
  if (name === 'rm' || name === 'rmdir' || name === 'unlink' || name === 'trash') {
    const recursive = /(^|\s)-[a-zA-Z]*[rR]|--recursive/.test(joined);
    const targets = args.filter((a) => !a.startsWith('-'));
    const broad = targets.some((t) => {
      const abs = /[*?]/.test(t) && path.dirname(t) === '.' ? home : norm(t.replace(/\/\*$/, ''), home);
      return abs === '/' || abs === home || path.dirname(abs) === '/' || abs === path.join(home, 'Library') || abs === path.join(home, 'Desktop') || abs === path.join(home, 'Documents') || abs === path.join(home, 'Downloads') || /^\$(HOME|\{HOME\})\/?$/.test(t) || t === '..' || t === '../' || t === '~/' || t === '*';
    });
    if (broad || (recursive && targets.some((t) => t.includes('*')))) return verdict(BLOCK, '`rm` on a whole folder like your home, Desktop or Documents would delete too much.');
    return verdict(ASK, recursive ? 'This deletes folders and everything inside them.' : 'This deletes files.');
  }
  if ((name === 'chmod' || name === 'chown') && /(^|\s)-[a-zA-Z]*R/.test(joined)) {
    const t = args.filter((a) => !a.startsWith('-')).slice(1);
    if (t.some((x) => { const a = norm(x, home); return a === '/' || a === home || path.dirname(a) === '/'; })) return verdict(BLOCK, `changing permissions on all of ${t.join(' ')} could lock you out of your files.`);
  }
  if (name === 'mv' && args.filter((a) => !a.startsWith('-')).some((t) => { const a = norm(t, home); return a === home || a === '/' || path.dirname(a) === '/'; })) return verdict(BLOCK, '`mv` of your whole home folder or a system folder would break the Mac.');
  if (name === 'git' && /\bpush\b.*(\s--force\b|\s-f\b|\s\+)/.test(joined)) return verdict(ASK, 'Force-pushing can erase work on the remote.');
  if (name === 'npm' && /\b(publish|unpublish|deprecate|owner|token|adduser|login)\b/.test(joined)) return verdict(ASK);
  // Walking the whole home folder (find ~, grep -r ~, du ~) trips macOS privacy prompts for Music, Photos, iCloud and other apps.
  if (['find', 'fd', 'grep', 'egrep', 'rg', 'ag', 'du', 'tree', 'ls'].includes(name)) {
    const recursive = name === 'find' || name === 'fd' || name === 'rg' || name === 'ag' || name === 'tree' || name === 'du' || /(^|\s)-[a-zA-Z]*[rR]/.test(joined);
    for (const a of pathArgs.filter((x) => !x.startsWith('-'))) {
      if (/^\$(HOME|\{HOME\})/.test(a)) { const v = checkRead(a.replace(/^\$\{?HOME\}?/, '~'), home, { recursive }); if (v.level !== SAFE) return verdict(v.level, v.reason); continue; }
      if (!/^[~/.]/.test(a)) continue;
      const v = checkRead(a, home, { recursive });
      if (v.level !== SAFE) return verdict(v.level, v.reason);
    }
    if (name === 'find' && /\s-(delete|exec|execdir|ok|okdir|fprint\w*|fls)\b/.test(' ' + joined)) return verdict(ASK, '`find` here also changes, writes or runs things.');
  }
  // Any path that looks like a secret, in any command, means no: also where a symlink leads, and every file a
  // wildcard would match (~/.ss*/id_* matches no rule as written, but the shell turns it into ~/.ssh/id_rsa).
  for (const a of pathArgs) {
    if (!/[/~.]/.test(a) || a.startsWith('-') && !a.includes('=')) continue;
    const t = a.includes('=') ? a.split('=').slice(1).join('=') : a;
    if (/^[a-z]+:\/\//i.test(t)) continue;
    const isSecret = (x) => bothOf(norm(x, home)).some((n) => ruleHit(SECRET, n, home)) || SECRET.some((re) => re.test(x));
    if (isSecret(t)) return verdict(BLOCK, `${t} holds passwords or keys, so I never touch it.`);
    if (/[*?[]/.test(t)) {
      const hits = globHits(t, home, cwd);
      if (hits === null) return verdict(ASK, `I can't tell which files ${t} would match.`);
      if (hits.some(isSecret)) return verdict(BLOCK, `${t} matches files with passwords or keys, so I never touch it.`);
    }
  }
  // Making folders is like write_file making a new file: fine where writing is, a yes elsewhere, never where it's blocked.
  if (name === 'mkdir') {
    for (const a of pathArgs.filter((x) => !x.startsWith('-'))) {
      const w = checkWrite(a, home, { own: opts.own });
      if (w.level === BLOCK) return w.path.startsWith(slash(home) + '/') || /^\/(private\/)?tmp\//.test(w.path) ? verdict(BLOCK, w.reason) : verdict(ASK, w.reason);
    }
    return verdict(SAFE);
  }
  // sed -n '120,140p' file (or /word/p) only prints lines: read-only. Any other sed script (s///, w, e, -i) still asks.
  if (name === 'sed') {
    const flags = args.filter((a) => a.startsWith('-')), rest = args.filter((a) => !a.startsWith('-'));
    if (flags.length && flags.every((f) => f === '-n') && rest.length >= 1 && /^((\d+|\$)(,(\d+|\$))?|\/[^/;{}]*\/)p$/.test(rest[0])) return verdict(SAFE);
    return verdict(ASK);
  }
  if (READ_ONLY.has(name)) {
    const sub = READ_ONLY_SUB[name];
    if (sub && !sub.test(joined.trim())) return verdict(ASK);
    const side = sideEffect(name, args);
    if (side) return verdict(ASK, side);
    if (prog.assigns) return verdict(ASK, 'Setting environment variables can change what that program runs.');
    return verdict(SAFE);
  }
  return verdict(ASK);
}

// The files a wildcard argument would match (at most a few thousand), or null when that can't be worked out
// (** over whole trees, or no glob support): then it asks.
function globHits(t, home, cwd) {
  if (/\*\*/.test(t) || typeof fs.globSync !== 'function') return null;
  const pattern = t.startsWith('~/') ? path.join(slash(home), t.slice(2)) : t;
  try {
    const hits = fs.globSync(pattern, { cwd: slash(cwd ?? home) }).slice(0, 5000).map((h) => (isAbs(slash(h)) ? slash(h) : path.join(slash(cwd ?? home), slash(h))));
    return hits;
  } catch { return null; }
}

// Files a command writes with > >> &>, quotes removed; /dev/null and 2>&1 style copies left out.
// A whole shell word after > or >>: "$HOME"/.zshrc is one word (quotes glued to the rest), with its quotes taken off.
const redirectTargets = (text) => [...text.matchAll(/(?:^|[^>])>{1,2}\|?(?!&)\s*((?:"[^"]*"|'[^']*'|[^\s;&|<>"'])+)/g)]
  .map((m) => m[1].replace(/["']/g, '')).filter((t) => t && t !== '/dev/null');

/** run_command. SAFE runs, ASK needs the user's yes, BLOCK never runs. `exists(path)`, if given, lets a redirect
 *  that makes a new file run like write_file making one; without it every redirect asks. */
// "for i in 1 2 3; do echo $i > n$i.txt; done" (also with seq 1 N): a plain loop that only writes new files.
// It's run like the same commands written out one by one (so each file is checked like write_file making a new
// one); anything else in a loop still asks.
function unrollLoop(s) {
  const m = s.match(/^((?:(?:cd|mkdir(?:\s+-p)?)\s+[^;&|`$()]+?\s*&&\s*)*)for\s+([a-z_]\w*)\s+in\s+((?:[\w.-]+\s*)+|\$\(\s*seq\s+(\d+)\s+(\d+)\s*\))\s*;\s*do\s+([^;`$()]*?(?:\$\{?\2\}?[^;`$()]*?)*)\s*;?\s*done((?:\s*&&\s*[^;`$()|]+)?)$/);
  if (!m) return null;
  const [, pre, v, list, a, b, body, post] = m;
  const vals = a != null ? (Number(b) - Number(a) >= 0 && Number(b) - Number(a) < 100 ? Array.from({ length: Number(b) - Number(a) + 1 }, (_, i) => String(Number(a) + i)) : null) : list.trim().split(/\s+/);
  if (!vals || vals.length > 100 || !/^(echo|printf)\b/.test(body.trim()) || !/>/.test(body)) return null;
  return pre + vals.map((x) => body.replace(new RegExp(`\\$\\{?${v}\\}?(?!\\w)`, 'g'), x)).join(' && ') + post;
}

// The files a copying or writing program writes to, checked like write_file: the reason it's refused, or null.
// A destination as the shell will see it: quotes gone, $HOME and ${HOME} as ~, relative ones from the folder it runs in.
const destPath = (d, cwd) => {
  const t = String(d ?? '').replace(/["']/g, '').replace(/^\$\{?HOME\}?(?=\/|$)/, '~');
  return /^~/.test(t) || isAbs(slash(t)) ? t : path.join(cwd, slash(t));
};
// Protected places in the home folder. A folder's contents copied or unpacked into the home folder itself, or into a
// folder above one of these (~/Library above ~/Library/LaunchAgents), could drop something there: that is blocked.
// Any other folder (a project, a backup) is an ordinary ask: startup-file names only matter in the home folder.
const HOME_PLACES = ['.ssh', '.gnupg', '.aws', '.config/fish', '.config/autostart', '.config/gh', '.kube', '.docker', '.gg', '.tauri',
  'Library/LaunchAgents', 'Library/LaunchDaemons', 'Library/StartupItems', 'Library/Preferences', 'Library/Keychains', 'Library/Cookies',
  'Library/Application Support/com.apple', 'HydraAgent/Skills', 'HydraAgent/Data', 'Roamies/Skills', 'Roamies/Data', 'Applications'];
function protectedTree(dir, home) {
  const abs = norm(dir, home), r = rel(abs, home);
  if (abs === slash(home) || r === '') return true; // into ~ itself: startup files, keys, everything
  if (isAbs(r)) return false; // outside home: write_file's own rules (and an ask)
  const lr = r.toLowerCase();
  return HOME_PLACES.some((p) => { const lp = p.toLowerCase(); return lp === lr || lp.startsWith(lr + '/') || lr.startsWith(lp + '/'); });
}

/** The files a copying, unpacking or writing program writes to, checked like write_file: the reason it's refused, or
 *  null. One list of destinations per program, then one check. */
function writeTargets(text, home, cwd) {
  const prog = program(words(text)), name = prog.name.toLowerCase(), args = prog.args;
  const plain = args.filter((a) => !a.startsWith('-'));
  const opt = (short, long) => {
    const out = [];
    args.forEach((a, i) => {
      if (short && a === short && args[i + 1]) out.push(args[i + 1]);
      else if (short && a.startsWith(short) && a.length > short.length && !a.startsWith('--')) out.push(a.slice(short.length));
      else if (long && a.startsWith(`${long}=`)) out.push(a.slice(long.length + 1));
      else if (long && a === long && args[i + 1]) out.push(args[i + 1]);
    });
    return out;
  };
  let dests = [], trees = [];
  const recursive = /(^|\s)-[a-zA-Z]*[rRa]|--recursive|--archive/.test(args.join(' '));
  const inPlace = (a) => a.some((x) => /^--in-place(=|$)/.test(x) || /^-[a-zA-Z0-9]*i/.test(x));
  if (['cp', 'ditto', 'mv', 'install', 'rsync', 'ln', 'scp'].includes(name)) {
    const target = opt('-t', '--target-directory');
    const srcs = target.length ? plain : plain.slice(0, -1);
    const d = target[0] ?? (plain.length >= 2 ? plain[plain.length - 1] : null);
    if (d) {
      // The destination, and each source's name inside it (when it is a folder).
      dests = [d, ...srcs.map((src) => path.join(d, path.basename(slash(src))))];
      // A folder's contents (ditto, -R/-a, rsync, "src/." or "src/") land inside the destination's tree.
      if (name === 'ditto' || recursive || srcs.some((x) => /\/\.?$/.test(x))) trees.push(d);
    }
  } else if (['tee', 'touch', 'truncate'].includes(name)) dests = plain;
  else if (name === 'git' && /^clone\b/.test(args.join(' '))) { const rest = plain.slice(1); if (rest.length >= 2) { dests = [rest[rest.length - 1]]; trees = dests; } }
  else if (name === 'git') dests = [...opt(null, '--output')];
  else if (name === 'curl') { dests = [...opt('-o', '--output')]; trees = [...opt(null, '--output-dir')]; }
  else if (name === 'wget') { dests = [...opt('-O', '--output-document')]; trees = [...opt('-P', '--directory-prefix')]; }
  // Unpacking with no folder given unpacks where the command runs.
  else if (['tar', 'bsdtar', 'gtar'].includes(name) && (/^-?[a-wyzA-Z]*x[a-zA-Z]*$/.test(args[0] ?? '') || args.some((x) => /^-[a-zA-Z]*x[a-zA-Z]*$|^--(extract|get)$/.test(x)))) { const c = opt('-C', '--directory'); trees = c.length ? c : [cwd]; }
  else if (name === 'unzip' || name === 'ditto' && args.includes('-x')) { const d = opt('-d', null); trees = d.length ? d : [cwd]; }
  else if (name === '7z' || name === '7za' || name === '7zz') { const o = opt('-o', null); trees = o.length ? o : [cwd]; }
  else if (name === 'cpio') trees = [cwd];
  else if (name === 'sed' || name === 'perl') { if (inPlace(args)) dests = args.some((a) => a === '-e' || /^-[a-zA-Z0-9]*e$/.test(a)) ? plain.filter((x, i2) => !/^-[a-zA-Z0-9]*e$/.test(args[args.indexOf(x) - 1] ?? '')) : plain.slice(1); }
  else if (name === 'patch') dests = [...plain.slice(0, 1), ...opt('-o', '--output')];
  for (const d of dests) {
    const w = checkWrite(destPath(d, cwd), home, {});
    if (w.level === BLOCK && w.reason && !/only write files inside your home/.test(w.reason)) return w.reason;
  }
  for (const d of trees) if (protectedTree(destPath(d, cwd), home)) return `${d} holds protected places (startup files, keys, apps or skills), so I won't copy or unpack a folder into it.`;
  return null;
}

// Owner's rule: every deletion of anything is confirmed, no exceptions; kill, quit, force quit, send, pay, overwrite and
// move to the Trash always ask too (with a reason that says so).
// Says why, or null.
const ALWAYS_PROGRAMS = {
  rm: 'This deletes files.', rmdir: 'This deletes folders.', unlink: 'This deletes files.', trash: 'This moves files to the Trash.',
  del: 'This deletes files.', erase: 'This deletes files.', rd: 'This deletes folders.', truncate: 'This empties files.',
  kill: 'This stops a running program.', pkill: 'This stops running apps.', killall: 'This stops running apps.',
  osascript: 'AppleScript can quit apps, send messages or delete things.', mail: 'This sends email.', mailx: 'This sends email.', sendmail: 'This sends email.',
};
function alwaysAsk(text, home, cwd) {
  const prog = program(words(text)), args = prog.args, joined = args.join(' ');
  const name = prog.name.toLowerCase();
  if (ALWAYS_PROGRAMS[name]) return ALWAYS_PROGRAMS[name];
  // A shell running a command line: what that line does.
  if (SHELLS.has(name) && /(^|\s)-(c|e)\b/.test(joined)) {
    for (const p of splitCommand(joined.replace(/^.*?-(c|e)\s+/, '')) ?? []) { const why = alwaysAsk(p.text, home, cwd); if (why) return why; }
  }
  const plain = args.filter((a) => !a.startsWith('-')), abs = (t) => norm(/^~/.test(t) || isAbs(slash(t)) ? t : path.join(cwd, slash(t)), home);
  if (['mv', 'cp', 'ditto', 'rsync', 'install', 'ln'].includes(name)) {
    if (plain.some((t) => /(^|\/)\.Trash(\/|$)/.test(slash(t)))) return 'This moves files to the Trash.';
    if (name === 'rsync' && /--(delete|remove-source-files)/.test(joined)) return 'This deletes files.';
    if (name === 'mv' && plain.length >= 2) {
      // mv takes its sources away; onto a file that's there, it replaces it.
      const dest = abs(plain[plain.length - 1]);
      const there = (f) => { try { return fs.statSync(f); } catch { return null; } };
      const d = there(dest);
      if (d && !d.isDirectory()) return 'This replaces a file that is already there.';
      if (d && plain.slice(0, -1).some((src) => there(path.join(dest, path.basename(slash(src)))))) return 'This replaces a file that is already there.';
    }
    if (name !== 'mv' && plain.length >= 2) {
      const dest = abs(plain[plain.length - 1]);
      try { if (!fs.statSync(dest).isDirectory()) return 'This overwrites a file that is already there.'; } catch {}
    }
  }
  if (name === 'find' && /(^|\s)-(delete|exec|execdir|ok|okdir)\b/.test(joined) && /-delete|\brm\b|\bmv\b|\bunlink\b/.test(joined)) return 'This deletes files.';
  if (name === 'git' && (/\bpush\b.*(\s--force\b|\s-f\b|\s\+)/.test(' ' + joined) || /^(reset\s+.*--hard|clean\b|checkout\s+(--\s|\.)|restore\b|branch\s+.*-D\b|stash\s+(drop|clear)\b)/.test(joined))) return 'This can erase work.';
  if ((name === 'sed' || name === 'perl') && /(^|\s)-[a-zA-Z]*i/.test(joined)) return 'This overwrites files in place.';
  if (['curl', 'wget'].includes(name) && /(^|\s)(-X\s*(POST|PUT|PATCH|DELETE)|-d|--data\S*|-F|--form\S*|-T|--upload-file|--json|--post-(data|file))\b/i.test(' ' + joined)) return 'This sends data.';
  if (['npm', 'pnpm', 'yarn'].includes(name) && /^(publish|unpublish)\b/.test(joined)) return 'This publishes a package.';
  if (['brew', 'npm', 'pnpm', 'yarn', 'pip', 'pip3'].includes(name) && /^(uninstall|remove|rm|un)\b/.test(joined)) return 'This deletes installed software.';
  return null;
}

// The pure-read allowlist (see the last gate in classifyCommand). Per program: which arguments are fine. No
// environment assignments, no redirect except into /dev/null.
const PURE_READ = {
  ls: () => true, cat: () => true, head: () => true, tail: () => true, wc: () => true, stat: () => true, file: (a) => !a.includes('-C'),
  du: () => true, df: () => true, pwd: () => true, echo: () => true, date: (a) => !a.some((x) => !x.startsWith('+') && !x.startsWith('-')) && !a.includes('-s'),
  which: () => true, whoami: () => true, uname: () => true, sw_vers: () => true, cd: () => true, true: () => true,
  // find: tests and printing only; any action, exec or write primary asks.
  find: (a) => !a.some((x) => /^-(exec|execdir|ok|okdir|delete|fls|fprint\w*|fprintf)$/.test(x)),
  // grep and rg on the paths given: never a preprocessor, pager or config file of the project's.
  grep: (a) => !a.some((x) => /^--?(include-from|exclude-from)/.test(x)), egrep: () => true, fgrep: () => true,
  rg: (a) => !a.some((x) => /^(--pre(-glob)?|--search-zip|-z|--hostname-bin)(=|$)/.test(x)) && a.includes('--no-config'),
  sort: (a) => !a.some((x) => /^(-o|--output|-T|--temporary-directory|--compress-program)/.test(x)), uniq: (a) => a.filter((x) => !x.startsWith('-')).length < 2,
  cut: () => true,
  // scutil: every argument must be part of a read form (so "--get X --set Y" asks).
  scutil: (a) => /^(--get\s+\w+|-r\s+\S+|--dns|--proxy|--nwi|--nc\s+list)$/.test(a.join(' ')),
};
function pureRead(text) {
  if (/(^|[^>&0-9])\d?>{1,2}(?!\s*\/dev\/null\b)|<|>&?\s*(?!\/dev\/null)\S/.test(text.replace(/\d?>{1,2}\s*\/dev\/null\b|\d?>&\d/g, ''))) return false;
  const ws = words(text), prog = program(ws);
  if (prog.assigns || /^(command|builtin|exec|nohup|time|nice|caffeinate|env|xargs|stdbuf)$/.test(ws[0] ?? '')) return false;
  const ok = PURE_READ[prog.name.toLowerCase()];
  return !!ok && ok(prog.args);
}

/** `cwd`: the folder the command starts in (default home); `own`: the runner's own folder (see checkWrite). */
export function classifyCommand(cmd, home, { exists, cwd: start = null, own = null } = {}) {
  home = slash(home);
  const s0 = String(cmd ?? '').trim();
  const s = unrollLoop(s0) ?? s0;
  if (!s) return verdict(BLOCK, 'That command is empty.');
  if (/:\s*\(\s*\)\s*\{.*:\s*\|\s*:.*\}/.test(s)) return verdict(BLOCK, 'That is a fork bomb.');
  if (/\b(curl|wget|fetch)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|da|k|fi)?sh\b/.test(s) || /\bbase64\s+(-d|--decode|-D)\b[^|]*\|\s*(ba|z)?sh\b/.test(s)) return verdict(BLOCK, 'Downloading a script and running it straight away skips every check.');
  const parts = splitCommand(s);
  if (!parts) return verdict(ASK, "I couldn't read that command clearly.");
  let level = SAFE, reason = '', always = false;
  // The folder each part runs in, so relative paths after a cd are checked where they really point. null: unknown.
  let cwd = start ? norm(start, home) : home;
  for (const p of parts) {
    let v = checkSimple(p.text, p.pipeIn, home, cwd ?? home, { own });
    if (cwd == null && v.level === SAFE) v = verdict(ASK, "I can't tell which folder that runs in.");
    if (v.level !== BLOCK) { const why = alwaysAsk(p.text, home, cwd ?? home); if (why) { always = true; if (v.level === SAFE) v = verdict(ASK, why); } }
    // Where a copy, move, link, clone or tee writes: a protected place (startup items, shell files, keys, Hydra's own
    // skills and data, app bundles) is never written, whichever program does it.
    if (v.level !== BLOCK) { const w = writeTargets(p.text, home, cwd ?? home); if (w) return verdict(BLOCK, w); }
    for (const r of redirectTargets(p.text)) {
      const t = destPath(r, cwd ?? home);
      const w = checkWrite(t, home, { exists: !exists || !!exists(norm(t, home)), own });
      if (w.level === BLOCK) return verdict(BLOCK, w.reason);
      if (w.always) always = true; // into a file that's already there (>> too: it changes the file)
      if ((w.level === ASK || cwd == null || /[$`*?{]/.test(r)) && v.level === SAFE) v = verdict(ASK, w.reason);
    }
    const ws = words(p.text);
    if (ws[0] === 'cd') {
      const t = ws[1];
      if (!t || t === '~') cwd = home;
      else if (cwd == null || /[$`*?]/.test(t) || t === '-') cwd = null;
      else cwd = norm(/^~/.test(t) || isAbs(slash(t)) ? t : path.join(cwd, slash(t)), home);
    }
    if (v.level === BLOCK) return v;
    if (v.level === ASK && level === SAFE) { level = ASK; reason = v.reason; }
  }
  // Command substitution and background jobs change things in ways the parts don't show.
  if (level === SAFE && (/\$\(|`/.test(s) || /(^|\s)&\s*$/.test(s))) level = ASK;
  // The last gate: only a few plain reading tools run without a yes, and only in forms that can't run other code,
  // read a repo's or project's own settings, or write anything. Everything else asks (git, npm, brew, pip, cargo,
  // make, interpreters, curl, open…), whatever the rules above made of it.
  if (level === SAFE && !parts.every((p) => pureRead(p.text))) { level = ASK; reason = reason || 'Only plain reading runs without a yes.'; }
  // Owner: "for deletion of everything have the agent confirm before doing ... for everything". Every ASK asks the
  // owner, every time (there is no setting that skips it); `always` stays on the verdict for the code that reads it.
  if (level === ASK) return { ...verdict(level, reason), always: true };
  return verdict(level, reason);
}


// ---------- opening things and fetching pages ----------

const RUNNABLE = /\.(app|command|sh|bash|zsh|tool|terminal|scpt|scptd|applescript|workflow|action|pkg|mpkg|dmg|jar|py|rb|pl|js|mjs|exe|bat|cmd|ps1|shortcut|mobileconfig|kext|plugin|prefPane|saver|desktop|appimage|deb|rpm|run|flatpakref|flatpak|snap)\/?$/i;
// Where installed apps live: opening one there just starts it. Linux lists them as .desktop files.
const APP_DIRS = ['/Applications/', '/System/Applications/', '/System/Library/CoreServices/', '/usr/share/applications/', '/usr/local/share/applications/', '/var/lib/flatpak/exports/share/applications/', '/var/lib/snapd/desktop/applications/'];

/** open: websites and mail, documents and folders, and apps by name. Not scripts, installers or odd links. */
export function checkOpen(target, home, { executable = false } = {}) {
  home = slash(home);
  const t = String(target ?? '').trim();
  if (!t) return verdict(BLOCK, 'Nothing to open.');
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(t)?.[1]?.toLowerCase();
  if (scheme && !/^[a-z]:\\/i.test(t)) {
    if (scheme === 'http' || scheme === 'https' || scheme === 'mailto') return verdict(SAFE);
    if (scheme === 'ms-settings') return verdict(SAFE); // a page of Windows Settings, nothing that runs (#81)
    return verdict(BLOCK, `I only open web and mail links, not ${scheme}: links.`);
  }
  if (/^[~/.]/.test(t) || /^[a-z]:\\/i.test(t)) {
    const abs = norm(t, home);
    const r = checkRead(abs, home);
    if (r.level === BLOCK) return verdict(BLOCK, r.reason);
    const inApps = APP_DIRS.some((d) => abs.startsWith(d));
    if ((RUNNABLE.test(abs) || executable) && !inApps) return verdict(BLOCK, `${t} is a script, installer or app that would run, so I won't open it. Open it yourself if you trust it.`);
    if (!inApps && SYSTEM_ROOTS.some((d) => abs === d || abs.startsWith(d + '/'))) return verdict(BLOCK, `${t} is a system file, so I won't open it.`);
    return verdict(SAFE);
  }
  if (/[/\\]|\.\./.test(t)) return verdict(BLOCK, `"${t}" isn't an app name.`);
  return verdict(SAFE);
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
export function checkDrawAction({ kind, url, text, action } = {}, { allowActions = false } = {}) {
  switch (kind) {
    case 'open': return checkLink(url);
    case 'photo': case 'favicon': return checkUrl(url);
    case 'type':
      if (!allowActions) return verdict(BLOCK, 'Typing into apps is switched off (Allow File Edits & Commands).');
      if (!String(text ?? '').length || String(text).length > 2000) return verdict(BLOCK, 'Nothing (or far too much) to type.');
      return verdict(SAFE);
    case 'copy': return String(text ?? '').length && String(text).length <= 10_000 ? verdict(SAFE) : verdict(BLOCK, 'Nothing (or far too much) to copy.');
    case 'button': {
      const a = action ?? {};
      if (a.do === 'ask') return String(a.value ?? '').trim() ? verdict(SAFE) : verdict(BLOCK, 'A button needs words to ask.');
      if (a.do === 'open') return checkLink(a.value);
      if (a.do === 'copy') return checkDrawAction({ kind: 'copy', text: a.value });
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
  return verdict(ASK, `Run ${all.join(' ').slice(0, 300)}`);
}

// Verbs that act on the world: a tool named like this always asks, whatever the server says about it.
const MCP_RISKY = /(?:^|_)(send|delete|remove|trash|destroy|erase|wipe|drop|purge|truncate|pay|payment|payments|purchase|buy|charge|transfer|withdraw|refund|publish|post|tweet|reply|forward|invite|share|cancel|revoke|unsubscribe|deploy|kill|terminate|execute|exec|sql|migration|migrate|reset|merge|archive)(?:_|$)/;
const snake = (s) => String(s ?? '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^a-z0-9]+/gi, '_').toLowerCase();

// Names that write, whatever the server says (a server's readOnlyHint is its own claim, so it's trusted only for a
// name that reads: get, list, search, read…).
const MCP_READS = new Set(['get', 'list', 'search', 'read', 'fetch', 'describe', 'find', 'lookup', 'show', 'count', 'view', 'browse', 'retrieve', 'inspect', 'status', 'info', 'details', 'stats', 'summary', 'check']);
const MCP_WRITES = /(?:^|_)(update|set|write|move|run|invoke|batch|apply|create|add|delete|remove|send|post|publish|execute|exec|sql|query|insert|upsert|patch|put|edit|modify|change|rename|upload|import|deploy|rent|buy|share|label|archive|merge|reset|trash|pay|transfer|request|call|trigger|start|stop|cancel|grant|revoke|invite|assign|close|open|submit|sync|mark|flag|pin|star|snooze|mute|follow|unfollow|like|react|vote|accept|reject|approve|deny|confirm|book|reserve|order|checkout|cart|purchase|subscribe|unsubscribe|enable|disable|toggle|save|block|ban|lock|unlock|schedule|notify|message|email|mail|dm|compose|draft|rm|del|unlink|kill|clear|empty|flush|push|commit|revert|rollback|restore|reply|forward|tweet|comment|review|rate|transfer|withdraw|refund|charge|tip|donate|claim|redeem|register|login|logout|signin|signout|replace|overwrite|quit|shutdown|reboot|restart|install|uninstall|prune|discard|cleanup|clean|evict|format|eval|spawn|nuke|runcmd|cmd|checkout|check_out|purge|drop|destroy|wipe|erase|terminate|truncate|expire|scrub|kill|remove|delete|exec|execute|launch|deploy|migrate)(?:_|$)/;
/** A call to a connected server's tool: { name, annotations }. A read-only tool (readOnlyHint, not destructive, not
 *  named like an action) is SAFE. Anything else ASKs; `always` (destructive, or named send/delete/pay…) means even
 *  only the owner answers it (an agent job's answer_agent can't say yes). */
export function checkMcpCall({ name, annotations } = {}) {
  const a = annotations ?? {};
  if (a.destructiveHint === true || MCP_RISKY.test(snake(name))) return { ...verdict(ASK, 'It can change, send or delete things.'), always: true };
  // An allowlist: readOnlyHint (the server's own claim) makes a call SAFE only when its name reads (a read verb in it)
  // and nothing in it writes. Everything else asks.
  const words = snake(name).split('_').filter(Boolean);
  if (a.readOnlyHint === true && words.some((w) => MCP_READS.has(w)) && !MCP_WRITES.test(snake(name))) return verdict(SAFE);
  // Owner: anything that might change, send or delete asks every time.
  return { ...verdict(ASK, "The server doesn't say it only reads."), always: true };
}
