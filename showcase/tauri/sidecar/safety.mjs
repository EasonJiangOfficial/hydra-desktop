// What Sidekick may do on its own, what needs a yes from the user first, and what it never does.
// Pure functions so every rule is tested (test/safety.test.mjs). When unsure, ask; never guess "safe".
import dns from 'node:dns/promises';
import fs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';
import { KEY_NAME, SECRET_FILE, WEB_SECRET_FILE, cardNumber, clearlyNotMoney, codeBox, credentialLabel, foldHard, hardMatch, inBrowser, moneyLabel, moneyStop, preciseTyped, showsAmount, typedCredential } from './hardlimits-core.mjs';
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
  /(^|\/)\.config\/(gh|gcloud|op|hydra|hub|github-copilot|doctl|heroku|stripe|vercel|netlify|gitlab|glab-cli|rclone|configstore|sops|age|1password|bitwarden|bw|anthropic|openai|claude)(\/|$)/i, /(^|\/)\.config\/.+\/(keys?|tokens?|api[_-]?keys?|secrets?|credentials?|auth|access[_-]?token)(\.(txt|json|ya?ml|toml|env|ini))?$/i, SECRET_FILE, /(^|\/)\.gg\/auth\.json$/, /(^|\/)(Roamies|HydraAgent)\/Data\/secrets\.json$/i, /(^|\/)\.tauri(\/|$)/,
  /(^|\/)Library\/Keychains(\/|$)/, /(^|\/)Library\/Cookies(\/|$)/, /\/(Cookies|Login Data[^/]*|Web Data)(-journal)?$/,
  // Any .env name (.env.production.local, .env.local.bak, .envrc), in any case, anywhere, but a template
  // (.env.example, .env.sample: hidden, so still asked); and Cloudflare's .dev.vars.
  /(^|\/)\.env(?![^/]*\.(example|sample|template|dist)(\.md|\.txt)?$)[^/]*$/i, /(^|\/)\.dev\.vars$/i, /\.(pem|p12|pfx|keystore|jks)$/i, /(^|\/)id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/,
  // Sign-ins other tools keep (seventh review F3): any auth.json or credentials file (Codex, Claude Code, Vercel, gem,
  // Terraform), tokens, database and cloud configs, service-account keys and Terraform state (it holds secrets).
  /(^|\/)auth\.json$/i, /(^|\/)\.?credentials(?![^/]*\.(md|markdown|mdx|rst|adoc|html?|pdf|docx?|pages|key|png|jpe?g|[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|cs|php|sh)$)[^/]*$/i, /(^|\/)\.claude\.json$/i, /(^|\/)(\.vault-token|\.pgpass|\.s3cfg|\.boto|\.my\.cnf|access-token|token)$/i,
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
// even if it was asked to "show" it. Kept in sync with RISKY in hands/main.swift (the money words too: the helper
// stops at a Sell, Swap or Subscribe it reaches by a spot or an id, and the sidecar asks with the label, B2).
export const RISKY_CLICK = /(?:^|[^\p{L}])(delete|remove|erase|destroy|wipe|reset|deactivate|close (my |your )?account|close without saving|quit anyway|quit|replace|trash|empty (the )?bin|shut down|restart|post|reply|tweet|don[’']?t save|do not save|move to (the )?(trash|bin)|force quit|overwrite|submit|cancel (my |your |the )?(subscription|plan|membership|account|order)|unsubscribe|pay|purchase|buy|place (the |your )?order|checkout|check out|confirm (payment|order|purchase|transfer)|confirm|send|transfer|withdraw|uninstall|empty trash|discard|sign out|log out|logout|format|revoke|publish|sell|trade|swap|subscribe|deposit|donate|tip|bid|wire|top up|add funds|redeem|stake|cash out|order now|submit order|complete order|book now|start (?:a )?(?:free )?trial|upgrade now|bestellen|verkaufen|vender|vendre|eliminar|borrar|pagar|comprar|enviar|cerrar sesi[oó]n|supprimer|effacer|payer|acheter|envoyer|se d[eé]connecter|d[eé]connexion|l[oö]schen|entfernen|bezahlen|kaufen|senden|abmelden|excluir|apagar|terminar sess[aã]o|elimina|cancella|paga|acquista|invia|esci|verwijderen|betalen|kopen|verzenden|uitloggen|afmelden|padam|hapus|bayar|beli|hantar|kirim|log keluar|nyahlanggan)(?![\p{L}])|删除|刪除|移除|清空|支付|付款|购买|購買|发送|發送|退出登录|登出|注销|削除|消去|支払|購入|送信|ログアウト|退会|삭제|결제|구매|전송|보내기|로그아웃|转账|轉帳|下单|下單|卖出|賣出|买入|買入|提现|提現|充值|注文|送金|入金|出金|売却|송금|이체|주문|충전|매수|매도|출금/iu;
/** A click the hands helper stops at for a yes: risky words (delete, send, pay, quit, sign out), or money words that
 *  pay in a money surface (moneyStop: a price button, Long, Short, Rent, PayPal, Kopen, 提交订单), so a click by a spot
 *  or an id is judged with its real label and the window it is in. Kept in sync with RISKY and MONEY in
 *  hands/main.swift. */
export const isRiskyClick = (label) => RISKY_CLICK.test(String(label ?? '')) || moneyStop(label);
/** Risky by its words alone (delete, send, pay, quit, sign out): asked about at a helper stop whatever the window. */
export const riskyWords = (label) => RISKY_CLICK.test(String(label ?? ''));
// Owner's hard limits (audit 2026-11-26 PLAN "Safety rule for Approve all"; fixed, not a setting), one classifier
// for web and Mac (hardlimits-core.mjs, a port of the web's hard-limits.ts):
// 1. typing a password, credential or card number into any field, and reading a password manager's or a secret file's
//    window: refused, never asked, whatever the owner says;
// 2. paying, buying, ordering, subscribing, transferring money or trading: always asked, Approve all too (hardAsk).
/** A control's label that pays (moneyLabel): ctx.surface (a bank, broker, wallet, checkout, app store, or a plan
 *  heading to checkout) and ctx.amount (the window shows a checkout's total) make a plain Confirm, Send or Continue pay
 *  too. */
// Round 4: in a money surface, a risky click that is not a delete, a sign-out, a quit or a post (Send, Submit, Transfer,
// Withdraw, "Send 1,000 DOGE", "Preview send") pays too.
const NOT_MONEY_RISKY = /(?:^|[^\p{L}])(delete|remove|erase|destroy|wipe|reset|deactivate|close|quit|replace|trash|bin|shut down|restart|post|reply|tweet|don[’']?t save|do not save|overwrite|cancel|unsubscribe|uninstall|discard|sign out|log out|logout|format|revoke|publish|eliminar|borrar|supprimer|effacer|l[oö]schen|entfernen|abmelden|excluir|apagar|elimina|cancella|verwijderen|uitloggen|afmelden|删除|刪除|移除|ログアウト|削除|삭제|로그아웃)(?![\p{L}])/iu;
export const isPayClick = (label, ctx) => !!moneyLabel(label, ctx) || (!!ctx?.surface && RISKY_CLICK.test(String(label ?? '')) && !NOT_MONEY_RISKY.test(String(label ?? '')) && !clearlyNotMoney(label));
// A connected server's tool that pays, buys, moves money or trades, by its name (one signal of moneyCall's).
const PAY_CALL = /(?:^|_)(pay|pays|payment|payments|payout|payouts|purchase|buy|sell|charge|capture|sale|transfer|transfers|withdraw|withdrawal|deposit|refund|trade|order|orders|checkout|swap|subscription|subscriptions|subscribe|sendmoney|wire|donate|donation|give|tip|topup|invest|bridge|stake|bid|bet|wager|renew|upgrade|remit|zelle|venmo|rent|rental|book|booking|position|payroll|exchange_currency|convert_currency|currency_convert|long|short|leverage|margin|pledge|tier|ride|register_domain|domains_register|budget|budgets|convert|liquidate|rebalance|supply|borrow|lend|wrap|unwrap)(?:_|$)|(?:^|_)(send_money|send_payment|send_funds|send_transaction|send_raw|sign_and_send|send_usdc|send_usdt|send_eth|send_btc|send_sol|send_crypto|send_tokens?|top_up|add_funds|cash_out|place_order|create_order|submit_order|submit_cart|market_open|limit_open|open_long|open_short|join_tier|approve_and_send|run_payroll|confirm_booking|gpu_rent|gpu_rental\w*|gpu_job_start|incoming_phone_numbers?_create|buy_phone_number|phone_numbers?_purchase|reload|recharge|add_credits?|buy_credits?|credits?_purchase|mint|sponsor|sponsorships?|stars|send_stars|gift|authorize_payment)(?:_|$)/;
const NOT_PAY = /(?:^|_)(sort_order|order_by|reorder|book_?mark\w*|bookmarks?|notebook\w*|facebook|book_?keeping|project_transfer|transfer_requests?|transfer_ownership|ownership_transfer|file_transfer|transfer_files?|transfer_repo\w*|feedback|planner|position_\w*cursor|cursor_position|book_(meeting|room|desk|slot|time|appointment|call|demo)\w*|swap_(component|instance|variant|columns?|rows?|layers?|panes?|tabs?)\w*)(?:_|$)/;
// Never money, whatever the server: feedback to it, an implementation planner.
const NEVER_PAY = /(?:^|_)(feedback|planner)$/;
export const paysCall = (name) => { const n = snake(name); return PAY_CALL.test(n) && !NOT_PAY.test(n) && !readsOnly(n); };
// Names that only read (L11: a read never asks, a money server's too): a read verb first (list_customers,
// get_balance), a read word last (stripe_api_read, stripe_analytics, *_planner, *_feedback), or no verb at all
// (coinbase.portfolio, alpaca.positions, wallet.address, plaid.sync_transactions reads them in).
const READ_CALL = /^(list|get|search|retrieve|read|fetch|find|show|describe|query|count|lookup|view|preview|estimate|quote|check|status|info|history|export|download|balance|inspect|browse|stats|summary|sync|analy[sz]e)(?:_|$)|(?:^|_)(read|reads|get|list|search|analytics|stats|report|reports|planner|feedback|lookup|preview|quote|estimate|status|info|history|balance|balances|summary)$/;
const WRITE_VERB = /(?:^|_)(create|add|new|make|setup|link|send|post|put|patch|update|set|write|edit|modify|delete|remove|cancel|submit|place|run|execute|exec|start|stop|open|close|approve|confirm|complete|capture|sale|charge|pay|buy|sell|transfer|withdraw|deposit|refund|trade|order|checkout|swap|subscribe|renew|upgrade|book|reserve|rent|request|register|join|give|donate|tip|bid|bet|sign|mint|bridge|stake|unstake|invest|redeem|claim|increase|decrease|raise|lower|top|fund|move|issue|void|finali[sz]e|apply|process|sql|query|call|invoke|trigger|import|mutate|convert|liquidate|rebalance|supply|borrow|lend|wrap|unwrap|simulate|authori[sz]e|authorization)(?:_|$)/;
const readsOnly = (n) => READ_CALL.test(n) && !/(?:^|_)(write|send|create|update|delete|submit|execute|place|recharge|reload|top|add|buy|pay|mint|transfer|withdraw|deposit)(?:_|$)/.test(n.replace(/_(read|get|list|search)$/, ''));
// Servers that move money: every write they have is a hard ask (B3): payment processors, banks, brokers, exchanges,
// wallets and chains, betting and prediction markets, and stores that charge on a write (ride, food, travel, domains).
const MONEY_SERVER = /(?:^|_)(stripe|lithic|marqeta|square|squareup|paypal|venmo|cash_?app|coinbase|kraken|binance|gemini|okx|bybit|bitget|kucoin|bitfinex|bitstamp|hyperliquid|dydx|jupiter|raydium|alpaca|robinhood|webull|tradier|etrade|schwab|fidelity|ibkr|interactive_brokers|wise|transferwise|revolut|monzo|starling|chime|sofi|ally|chase|amex|citi|wells_?fargo|capital_?one|bank|mybank|brex|ramp|mercury|plaid|shopify|app_?store|metamask|phantom|wallet|crypto|ledger|exodus|uniswap|evm|ethereum|solana|bitcoin|klarna|zelle|adyen|braintree|razorpay|paddle|mollie|checkout_com|gusto|bill_com|payoneer|polymarket|kalshi|doordash|instacart|ubereats|uber|lyft|expedia|booking|airbnb|namecheap|godaddy|patreon|gofundme|onchain|aave|compound|lido|cdp|defi|dex|apple_pay|google_pay|samsung_pay|opensea)(?:_|$)/;
// A write on a money server about something that moves no money: a customer, a product's words, a watchlist, a contact,
// a setting or a variable (stripe.create_customer, robinhood.add_to_watchlist, vercel.create_project_env "$5").
const NON_MONEY_OBJECT = /(?:^|_)(customers?|products?|product_description|description|watchlists?|contacts?|notes?|tags?|labels?|metadata|envs?|env_vars?|variables?|config|configs|settings?|webhooks?|profiles?|address_book|alerts?|prices?|coupons?|promotion_codes?|payment_links?|tax_rates?|shipping_rates?)(?:_|$)/;
// Round 6: a write of a catalog's words or a record's metadata moves no money, whatever it is on (a price, a coupon, a
// payment link, a subscription's metadata).
const META_WRITE = /(?:^|_)(metadata|description|tags?|labels?|notes?)$/;
// A contract call or a method by its function's name that moves tokens (onchain.write_contract {functionName: 'transfer'}).
const FUNCTION_KEY = /^(function_name|function|method|method_name|fn|abi_function)$/;
const PAY_FUNCTION = /^(transfer|transfer_from|transferfrom|safe_transfer_from|safetransferfrom|approve|swap\w*|deposit|withdraw|mint|buy|sell|send\w*|pay\w*|stake|unstake|borrow|repay|supply)$/i;
// Shopify and Plaid move money only through some of their writes.
const PARTLY = /(?:^|_)(shopify|plaid)(?:_|$)/;
const PARTLY_PAYS = /(?:^|_)(order|orders|checkout|refund|payment|payments|charge|payout|payouts|transfer|transfers|billing|gift_card)(?:_|$)/;
// Arguments that carry money: an amount with a currency or a payee, a budget, a payout, transfer, order or
// subscription endpoint, or SQL that changes balances or payments. Never a content write's words (a page, a draft, a
// note, an issue, a cell: "Amount due: $500" in a draft body, a "Q3 budget" page with amount and currency columns).
const MONEY_KEY = /^(amount|amount_\w+|\w+_amount|price|unit_amount|total|cost|qty|quantity|notional|sum|usd|eur|gbp|value|sz|size|shares|count|budget|daily_budget|\w+_budget|lifetime_budget|bid_amount)$/;
const CURRENCY_KEY = /^(currency|currency_code|asset|coin|symbol|ticker|token|denom|side|is_buy|order_type|inst_id|market)$/;
const PAYEE_KEY = /^(to|recipient|recipient_\w+|payee|payee_\w+|destination|beneficiary|account_to|to_account|iban|routing_number|charity|landlord|address_to)$/;
const MONEY_PATH = /(^(get|post|put|patch|delete)\s+\S+|^\/|^https?:\/\/)[^\s]*(?:^|[/_ .-])(payouts?|transfers?|orders?|subscriptions?|charges?|payment_intents?|payments?|checkout|refunds?|invoices?\/[^/]+\/pay|withdrawals?|deposits?|trades?)(?:$|[/_ .?-])/i;
// Round 6: balances, payments and the ledger only (an app's own orders or accounts table is its data).
const MONEY_SQL = /\b(update|insert\s+into|delete\s+from)\b[^;]*\b(balances?|payments?|transfers?|payouts?|charges?|ledgers?|wallets?)\b/i;
const CONTENT_WRITE = /(?:^|_)(page|pages|doc|docs|document|note|notes|draft|drafts|message|messages|email|mail|comment|comments|issue|issues|ticket|task|tasks|event|events|file|files|cell|cells|row|rows|record|records|item|items|entry|entries|transaction|transactions|sheet|block|blocks|post|card|deal|contact|product_description|description|title|component|meeting_room|label)(?:_|$)/;
function argsPay(args, content) {
  let amount = false, currency = false, payee = false, budget = false, shape = false, money = false, endpoint = false;
  const walk = (x, depth = 0) => {
    if (depth > 4 || x == null) return;
    if (Array.isArray(x)) { for (const v of x.slice(0, 50)) walk(v, depth + 1); return; }
    if (typeof x === 'object') {
      for (const [k, v] of Object.entries(x).slice(0, 100)) {
        const key = snake(k);
        const num = v != null && v !== '' && typeof v !== 'object' && !Number.isNaN(Number(String(v).replace(/[$€£¥,\s]/g, '').replace(/[a-z]+$/i, '')));
        if (MONEY_KEY.test(key) && num) { amount = true; if (/budget/.test(key)) budget = true; if (/^(usd|eur|gbp)$|_(usd|eur|gbp|cents)$/.test(key)) currency = true; }
        // Round 6: an amount, a price, a total, stars or credits on a write is money with no currency said too.
        if (/^(amount|\w+_amount|amount_\w+|price|total|cost|fee|tip|stars|credits?|unit_amount)$/.test(key) && num) money = true;
        // Instructions in words to a server that acts on them (Zapier, an agent): judged like the turn's own words.
        if (/^(instructions?|task|prompt|command|request|goal|action_text)$/.test(key) && typeof v === 'string' && hardMatch(null, v)?.kind === 'money') shape = true;
        if (CURRENCY_KEY.test(key) && v != null && v !== '') currency = true;
        if (PAYEE_KEY.test(key) && v != null && v !== '') payee = true;
        if (typeof v === 'string' && (MONEY_PATH.test(v.trim()) || MONEY_SQL.test(v))) { shape = true; if (/^(url|uri|endpoint|path|href|route|api_path)$/.test(key)) endpoint = true; }
        if (FUNCTION_KEY.test(key) && typeof v === 'string' && PAY_FUNCTION.test(v.trim())) shape = true;
        walk(v, depth + 1);
      }
      return;
    }
    // A short value that is an amount ("2 ETH", "$500"); a message's body that mentions one is not.
    if (typeof x === 'string' && x.trim().split(/\s+/).length <= 3 && showsAmount(x)) { amount = true; currency = true; }
    if (typeof x === 'string' && (MONEY_PATH.test(x.trim()) || MONEY_SQL.test(x))) shape = true;
  };
  walk(args);
  // A content write's words (an issue's "POST /v1/payouts", a draft's "$500") are its words, checked first (round 6).
  if (content && !endpoint) return false;
  return shape || money || budget || (amount && (currency || payee));
}
/** A connected server's call that pays, buys, moves money or trades (B3): never a read (L11: readOnlyHint, a read
 *  verb first, a read word last, or no verb at all); every write of a money server; any server's write named for
 *  money; any write whose arguments carry an amount with a currency or a payee, a budget, a money endpoint or SQL on
 *  balances (never a page's, a draft's or a cell's words). */
export function moneyCall({ server = '', name, args, annotations } = {}) {
  const n = snake(name), srv = snake(server).replace(/^claude_ai_/, '');
  if (annotations?.readOnlyHint === true || readsOnly(n) || NEVER_PAY.test(n)) return false;
  if (NOT_PAY.test(n) && !WRITE_VERB.test(n.replace(NOT_PAY, '_'))) return false;
  if (!WRITE_VERB.test(n) && !PAY_CALL.test(n)) return false;
  const other = (NON_MONEY_OBJECT.test(n) && !PAY_CALL.test(n.replace(new RegExp(NON_MONEY_OBJECT, 'g'), '_'))) || META_WRITE.test(n);
  if (MONEY_SERVER.test(srv) && !(PARTLY.test(srv) && !PARTLY_PAYS.test(n)) && !other) return true;
  return (!other && paysCall(n)) || argsPay(args, CONTENT_WRITE.test(n) || other);
}
// An argument named for a secret (password, api_key, private_key...), and a value next to a key's name ({key:
// 'API_KEY', value}, {STRIPE_SECRET_KEY: ...}): what it holds is a credential, whatever it looks like. A page's token
// (page_token, next_token) or a count (max_tokens) is not one.
// Round 4: by its name's end, in any case (db_password, X-Api-Key, auth.pass, pin, verification_code); a plain "token" only
// when its value is no ticker (token: 'USDC' is a currency).
const SECRET_ARG = /(^|_)(password|passwd|passphrase|passcode|pass|pwd|secret|client_secret|secret_key|api_key|apikey|access_key|access_token|refresh_token|auth_token|bearer_token|id_token|session_token|private_key|privatekey|seed_phrase|mnemonic|otp|totp|cvv|cvc|card_number|pin)$/;
const CODE_ARG = /(^|_)(verification|security|auth|otp|sms|mfa|2fa|one_time|confirmation|login|signin|sign_in|recovery|backup)_code$/;
const TICKER = /^[A-Z0-9]{2,10}([-/.][A-Z0-9]{2,10})?$|^0x[0-9a-fA-F]{40}$|^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
// A key's or variable's name that holds a secret: it ends in the secret's word (API_KEY, STRIPE_SECRET_KEY, DB_PASSWORD,
// GITHUB_TOKEN), not a limit or a count (TOKEN_LIMIT, MAX_TOKENS).
const SECRET_KEY_NAME = /(^|[_.-])(key|secret|token|password|passwd|pass|pwd|credentials?|private_?key|dsn|webhook(_url)?)$/i;
// Round 6: keys that are public by design (a publishable key, a public key, a site key, an anon key).
const PUBLIC_KEY_NAME = /(^|[_.-])(publishable|public|site|anon|pub)([_.-]|$)/i;
const namedSecret = (x, depth = 0) => {
  if (depth > 6 || x == null || typeof x !== 'object') return false;
  if (Array.isArray(x)) return x.slice(0, 50).some((v) => namedSecret(v, depth + 1));
  const has = (v) => typeof v === 'string' && v.trim().length >= 4;
  const entries = Object.entries(x).slice(0, 100);
  const named = entries.find(([k, v]) => /^(key|name)$/i.test(k) && typeof v === 'string' && SECRET_KEY_NAME.test(v.trim()) && !PUBLIC_KEY_NAME.test(v.trim()));
  if (named && entries.some(([k, v]) => /^(value|secret_value)$/i.test(k) && has(v))) return true;
  // Round 6: an Authorization header's Basic or Bearer value, and a user:password pair in an auth field, are secrets; a
  // pin that is no number ("top") and a pass that is a plain word ("through") are not.
  const secretValue = (k, v) => typeof v === 'string' && v.trim().length >= 3 && !/^(true|false|yes|no|on|off|null|none|undefined)$/i.test(v.trim()) && (/^(authorization|proxy_authorization)$/.test(snake(k)) ? /^(basic|bearer|token|digest)\s+\S{8,}/i.test(v.trim())
    : /^(auth|basic_auth|userpass|user_pass|credentials?)$/.test(snake(k)) ? /^[^:\s]+:[^:\s]{3,}$/.test(v.trim())
    : snake(k) === 'pin' ? /^\d{4,12}$/.test(v.trim())
    : snake(k) === 'pass' ? /[\d\W_]/.test(v.trim()) || v.trim().length >= 12
    : snake(k) === 'token' ? !TICKER.test(v.trim()) && v.trim().length >= 8
    : SECRET_ARG.test(snake(k)) || (CODE_ARG.test(snake(k)) && /^[a-z0-9-]{4,10}$/i.test(v.trim())) || (/^[A-Z0-9_]+$/.test(k) && /_/.test(k) && SECRET_KEY_NAME.test(k) && !PUBLIC_KEY_NAME.test(k) && v.trim().length >= 4));
  return entries.some(([k, v]) => secretValue(k, v) || namedSecret(v, depth + 1));
};
/** A typed credential in a call's arguments (a card number, a key or token, or a value named for a secret): such a call
 *  is refused, never sent. */
// Release round 2: an argument named for an ID, a page token, a cursor or an address (fileId, eventId, page_id,
// pageToken, nextPageToken, cursor, url) holds a machine-made value by design: only typedCredential's precise part
// (a card, a known key prefix) reads it, so a Drive file, a recurring event, a Notion page and page 2 of a list run.
const ID_ARG = /(^|_)(ids?|cursor|page_?token|next_?(page_)?token|sync_?token|continuation(_token)?|etag|urls?|uri|href|link)$/;
const splitIds = (x, ids, depth = 0) => {
  if (depth > 6 || !x || typeof x !== 'object') return x;
  if (Array.isArray(x)) return x.map((v) => splitIds(v, ids, depth + 1));
  const rest = {};
  for (const [k, v] of Object.entries(x)) if (ID_ARG.test(snake(k))) ids.push(v); else rest[k] = splitIds(v, ids, depth + 1);
  return rest;
};
export const credentialArgs = (args) => {
  const ids = [], rest = splitIds(args, ids);
  return strings(rest).list.some((x) => typedCredential(x) != null) || strings(ids).list.some((x) => preciseTyped(x) != null) || namedSecret(args);
};
/** An ask Approve all never answers: it pays (pay, hard 'money') or can show sign-ins (secret, hard 'credential').
 *  Checked before any Approve all yes: approveAllSays, a background agent's asks (agents.mjs), a relay approval. */
export const hardAsk = (opts) => opts?.pay === true || opts?.secret === true || opts?.hard === 'money' || opts?.hard === 'credential' || opts?.hard === true;
/** The relay's tag for a hard ask (relayschema hard): credential wins over money. */
// A plain secret ask (a hidden file, an app's data) is no credential: only a real credential is tagged so (the server
// refuses it), round 1 L12.
export const hardTag = (opts) => (opts?.hard === 'credential' || opts?.vault === true ? 'credential' : opts?.pay === true || opts?.hard === 'money' || opts?.hard === true ? 'money' : null);
export const NO_CREDENTIALS = "I never type passwords, credentials or card numbers, Approve all or not. Ask the user to type it in themselves.";
/** A control (from read_window: { role, label }) or a field's name that takes a password, a credential or a card
 *  number, in several languages (credentialLabel). ctx.cardForm: its form has a card field (an expiry field counts). */
export const credentialField = (c, ctx) => (typeof c === 'string' ? credentialLabel(c, ctx)
  : c?.role === 'password field' || c?.secure === true || /secure/i.test(String(c?.subrole ?? '')) || credentialLabel(String(c?.label ?? ''), ctx) || (c?.placeholder != null && credentialLabel(String(c.placeholder), ctx)));
/** A box called just "Code" that a code is typed into (codeBox): a sign-in code. */
export const codeField = (c, text, ctx) => codeBox(typeof c === 'string' ? c : String(c?.label ?? c?.placeholder ?? ''), text, ctx);
/** A card number in any common shape (cardNumber: every 13-19 digit window of a run, brand prefix and length, Luhn). */
export const hasCardNumber = (text) => cardNumber(text) != null;
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
// Approve all's one rule for a plan of steps (act_in_app, draw's typing): it runs unasked only when EVERY step is in
// this safe set. Any other step (a selection: cmd+a, shift or cmd+shift with a key, a "Select All" click; a delete key
// or chord: Backspace, Delete, ctrl+h, ctrl+d, ctrl+k; cut, copy, paste; fill, set, choose; any key or step kind not
// listed) makes the whole plan deletion-class, so it asks as with Approve all off. A whitelist, never a list of
// dangerous keys: what isn't known to be safe asks. Typing is safe only with no selection made before it in the plan
// (stepsLose): a step that may select (selects) makes any later typing a deletion.
const SAFE_KINDS = new Set(['click', 'click_text', 'click_at', 'hover', 'scroll', 'focus', 'wait', 'type', 'read_window', 'take_screenshot', 'screenshot']);
const ARROWS = new Set(['left', 'right', 'up', 'down']);
// A control clicked by its name that selects, moves or edits text (the Edit menu's items).
const EDIT_CLICK = /^\s*(?:select(?: all)?|cut|copy|paste(?: and match style)?|delete|clear|replace|undo|redo)\b/i;
// Typed characters that are keys, not text (the helper sends typed text as it is): C0 controls but a line break (Return,
// in the safe set), DEL and the Mac's function-key characters. In Cocoa 0x7F and 0x08 delete back, U+F728 forward,
// 0x0B kills the line, a tab moves to the next field (selecting its text).
const KEY_CHARS = /[\x00-\x09\x0B\x0C\x0E-\x1F\x7F\uF700-\uF8FF]/;
// A step after which typing can replace a selection it made: Tab or shift+Tab (focus moving into a field selects its
// whole text), a click at a spot or on a control with no name (it may be the Edit menu's Select All).
const selects = (s) => s?.do === 'click_at' || (['click', 'focus'].includes(s?.do) && !String(s.shown ?? s.label ?? '').trim())
  || (s?.do === 'key' && parseKey(s.key)?.key === 'tab');
function safeStep(s) {
  if (s?.do === 'type') return !KEY_CHARS.test(String(s.text ?? ''));
  if (!SAFE_KINDS.has(s?.do)) {
    if (s?.do !== 'key') return false;
    const p = parseKey(s.key);
    if (!p) return false;
    // Arrows move the caret (with cmd, opt or ctrl too); with shift they select.
    if (ARROWS.has(p.key)) return !p.mods.has('shift');
    // Return, Tab and Escape, alone or with shift (a new line, the field before).
    return ['return', 'tab', 'escape', 'esc'].includes(p.key) && [...p.mods].every((m) => m === 'shift');
  }
  return !['click', 'click_text', 'hover', 'focus'].includes(s.do) || !EDIT_CLICK.test(String(s.text ?? s.shown ?? s.label ?? ''));
}
/** A plan that can lose what's there (any step outside the safe set, or typing after a step that may select): its ask
 *  is a deletion. */
export function stepsLose(steps) {
  if (!Array.isArray(steps)) return true;
  let selected = false;
  for (const s of steps) {
    if (!safeStep(s) || (s?.do === 'type' && selected)) return true;
    if (selects(s)) selected = true;
  }
  return false;
}
/** Approve all's tag for a plan: a deletion when it can lose what's there (stepsLose) or runs in a password manager
 *  (its vault comes forward). The one place act_in_app and draw's typing take it from. */
export const planDeletion = (steps, apps = []) => stepsLose(steps) || apps.some(isPasswordApp);
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

/** A .key file that is a key (M7). A Keynote document is a .key too: a package folder or a zip (it starts PK), and
 *  that is a document. Any other .key (PEM, DER, or one that can't be read to say) is a key. */
function keyFile(a) {
  if (!/\.key$/i.test(a)) return false;
  try {
    if (fs.statSync(a).isDirectory()) return false;
    const fd = fs.openSync(a, 'r'), b = Buffer.alloc(4);
    try { fs.readSync(fd, b, 0, 4, 0); } finally { fs.closeSync(fd); }
    return !(b[0] === 0x50 && b[1] === 0x4b);
  } catch { return true; }
}
/** A path's read verdict by the deny rules alone (secrets, Hydra's data, other apps' data, hidden files): what typed
 *  text, a connection's non-path values and open are judged by. Returns { level, reason, path }. */
function readCheck(p, home, { recursive = false } = {}) {
  const { real, all } = pathsOf(p, home), homes = homesOf(home);
  if (rootDot(all)) return { ...verdict(BLOCK, `${p} names a file by a hidden name at the top of the disk, so I don't read it. Use its usual path.`), path: real };
  if (hits(SECRET, all, homes) || all.some(keyFile)) return { ...verdict(BLOCK, `${p} holds passwords or keys, so I never read it.`), path: real };
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
  // An ordinary ask (Approve all answers it): the files that really hold sign-ins are refused above (SECRET), so a
  // dotfile, a project's settings or app data is not a hard limit (round 1 L12: ~/.zshrc, .gitignore, .eslintrc).
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
 *  any other (Terminal, a password manager, Messages) asks, naming the app (tenth review R10-11). { level, reason }.
 *  viewers: false (a relay turn: the owner is not at this Mac, R11-1): a window with no file asks in every app, a browser
 *  or Hydra too, since only plain reads in the three folders run unasked. */
// Single-document apps only: a code editor's window shows its terminal panel, other tabs and an AI chat beside the
// file it reports (R11c-6), so it asks.
const DOC_APPS = /^(preview|textedit|pages|numbers|keynote|quicktime player|photos|microsoft (word|excel|powerpoint))$/i;
// Browsers by family (Chrome Canary, Firefox Developer Edition, Safari Technology Preview, Edge Beta, Dia, Comet).
const BROWSER_APPS = { test: inBrowser };
// The file names a title shows: ".env - Notepad", "*id_rsa - Notepad", "id_rsa — Edited", "● .env — shop — Code", and
// with a folder after the name, Vim's "id_rsa + (~/.ssh) - VIM" and Sublime's "C:\\keys\\id_rsa (keys) - Sublime Text"
// (R11h-2). Each piece with its marks (Vim's +, =, -, [+], [RO]) and folder taken off, its first word, the folder,
// and the name in that folder ("config (~/.ssh)" is ~/.ssh/config).
// Vim and Neovim put the file list's counter last when more than one file is open: "config (~/.ssh) (1 of 2) - VIM",
// "config + (~\\.kube) ((2) of 3) - GVIM" (R11i-2); it's taken off before the folder.
const MARKS = /(\s+(\[[^\]]*\]|[+=-]{1,2}))+$/u, ARGS = /\s*\(\(?\d+\)? of \d+\)$/u;
const titleNames = (t) => String(t ?? '').split(/\s+[-–—|]\s+/).flatMap((x) => {
  let name = x.replace(/^[*●•\s]+|[*●•\s]+$/gu, '').replace(MARKS, '').replace(ARGS, '').replace(MARKS, '').trim(), dir = '';
  const p = /\s*\(([^()]*)\)$/u.exec(name);
  if (p) { dir = p[1].trim(); name = name.slice(0, p.index).replace(MARKS, '').trim(); }
  const first = name.split(/\s+/)[0];
  return [name, first, dir, ...(dir && name ? [`${dir}/${name}`, `${dir}/${first}`] : [])].filter(Boolean);
});
// Password managers and 2FA code apps, with a Beta, Nightly, Desktop or version after the name ("1Password Beta",
// "Authy Desktop", "Secrets 4"). ponytail: names from memory, not read off a Mac; add any the owner uses.
const PASSWORD_APPS = /^(?:1password|bitwarden|lastpass|dashlane|keeper(?: password manager)?|keepass\w*|keeweb|macpass|kypass|minikeepass|strongbox|enpass|proton pass|nordpass|roboform|(?:apple )?passwords|keychain access|secrets|codebook|buttercup|padloc|psono|passbolt|sticky password|myki|elpass|safeincloud(?: password manager)?|msecure|minimalist(?: password manager)?|pass|qtpass|passforios|duo(?: mobile)?|zoho vault|authy|(?:google |microsoft |yubico )?authenticator|2fas(?: auth)?|ente auth|step two|otp auth|raivo(?: otp)?|aegis)(?:[ -](?:beta|nightly|desktop|\d+(?:\.\d+)*))*$/i;
// Any other name or bundle id with one of these in it ("Passwords Pro", com.agilebits.onepassword7, "OTP Manager").
const PASSWORD_WORDS = /password|vault|keychain|authenticator|(?:^|[^a-z0-9])otp|2fa/i;
// Round 4: the Passwords app and Keychain Access under their localized names (the helper reports an app's localized
// name), and password managers by their bundle ids.
const PASSWORD_APPS_LOCAL = /^(passw[oö]rter|mots de passe|contrase[nñ]as|contrasenyes|senhas|wachtwoorden|l[oö]senord|adgangskoder|passord|salasanat|has[lł]a|hesla|jelszavak|[sş]ifreler|kata sandi|m[aậ]t kh[aẩ]u|пароли|паролі|密码|密碼|パスワード|암호|비밀번호|كلمات السر|סיסמאות|รหัสผ่าน|schl[uü]sselbundverwaltung|trousseau d['’]acc[eè]s|acceso a llaveros|accesso portachiavi|sleutelhangertoegang|nyckelrings[aå]tkomst|acesso [aà]s chaves|nøgleringsadgang|nøkkelringtilgang|avainnippujen hallinta|dostęp do pęku kluczy|связка ключей|钥匙串访问|鑰匙圈存取|キーチェーンアクセス|키체인 접근)$/i;
const PASSWORD_BUNDLES = /^(com\.apple\.(passwords|keychainaccess)|com\.agilebits\.|com\.1password\.|com\.bitwarden\.|com\.8bit\.bitwarden|com\.lastpass\.|com\.dashlane\.|com\.callpod\.keeper|com\.keepersecurity\.|org\.keepassxc\.|com\.nordpass\.|me\.proton\.pass|ch\.protonmail\.pass|com\.enpass\.|in\.sinew\.enpass|com\.siber\.roboform|com\.authy\.|com\.twilio\.authy|com\.google\.authenticator|com\.yubico\.|io\.ente\.auth|com\.stepstwo\.|com\.strongbox\.|com\.markmcguill\.strongbox)/i;
const SETTINGS_APPS = /^(system settings|system preferences|systemeinstellungen|r[eé]glages syst[eè]me|pr[eé]f[eé]rences syst[eè]me|ajustes del sistema|configuraci[oó]n del sistema|impostazioni di sistema|configura[cç][oõ]es do sistema|ajustes do sistema|systeeminstellingen|systeminst[aä]llningar|systemindstillinger|systeminnstillinger|j[aä]rjestelm[aä]asetukset|ustawienia systemowe|syst[eé]mov[eé] nastaven[ií]|системные настройки|系统设置|系統設定|システム設定|시스템 설정)$/i;
const PASSWORDS_PANE = /^(passwords|passw[oö]rter|mots de passe|contrase[nñ]as|senhas|password|wachtwoorden|l[oö]senord|adgangskoder|passord|salasanat|has[lł]a|hesla|пароли|密码|密碼|パスワード|암호)$/i;
/** A password manager or 2FA app (its window shows sign-ins), by name or bundle id: bringing it forward asks under
 *  Approve all too (tools.mjs). */
export const isPasswordApp = (app) => { const a = String(app ?? '').trim().replace(/\.app$/i, ''); return PASSWORD_APPS.test(a) || PASSWORD_WORDS.test(a) || PASSWORD_APPS_LOCAL.test(a) || PASSWORD_BUNDLES.test(a); };
// A window that shows a real vault (M6): a web vault by its address (passwords.google.com, vault.bitwarden.com,
// my.1password.com, LastPass's, Keeper's, Dashlane's and Proton Pass's web vaults, a browser's own password pages),
// System Settings' Passwords pane, or, with no address read, a manager's name in a browser's title. Any other title
// with password, vault, 2FA or OTP in it ("Reset your password · GitHub", an Obsidian vault, "Enable 2FA") is an
// ordinary window.
const MANAGER = String.raw`1password|bitwarden|vaultwarden|lastpass|dashlane|keeper|nordpass|proton pass|roboform|enpass|keepass\w*|authy|passbolt|zoho vault|sticky password|elpass|safeincloud|msecure`;
// A browser's title that names a vault page: its first part is the manager (with "Web Vault", "Vault" or "Password
// Manager" after it), "Passwords", "Saved Passwords" or "Password Manager" ("LastPass - My Vault", "Bitwarden Web
// Vault", "Passwords — Mozilla Firefox"). A review or a list that names a manager is not ("Keeper Review 2026", "Best
// password managers 2026: Bitwarden, 1Password").
const VAULT_TITLE = new RegExp(String.raw`^((${MANAGER})( (web )?vault| online| password manager)?|(saved |google |my )?passwords|password manager|(my |web )?vault)$`, 'i');
const LOCAL_MANAGER = /(google[- ]?passwortmanager|passwortmanager|passwort-manager|gestionnaire de mots de passe|administrador de contraseñas|gestor de contraseñas|gestore (delle )?password|gerenciador de senhas|wachtwoordmanager|менеджер паролей|密码管理器|密碼管理|パスワード ?マネージャー|비밀번호 관리자)/i;
const firstPart = (t) => String(t ?? '').split(/\s+[-–—|·:]\s+|:\s+/)[0].replace(/[®™]/g, '').trim();
const VAULT_HOSTS = /^(passwords\.google\.com|vault\.bitwarden\.(com|eu)|my\.1password\.(com|eu|ca)|(?!(blog|support|developer|developers|www|status|community|releases|downloads|start|app-updates|cache|c|1password)\.)[\w-]+\.1password\.(com|eu|ca)|(www\.)?lastpass\.com|lastpass\.eu|keepersecurity\.(com|eu)|app\.dashlane\.com|vault\.dashlane\.com|pass\.proton\.me|app\.nordpass\.com|vault\.zoho\.(com|eu|in)|personal\.okta\.com|online\.roboform\.com|[\w-]+\.passbolt\.(com|io)|(www\.)?icloud\.com)$/i;
const VAULT_PATHS = { 'lastpass.com': /^\/vault/i, 'www.lastpass.com': /^\/vault/i, 'lastpass.eu': /^\/vault/i, 'keepersecurity.com': /^\/vault/i, 'keepersecurity.eu': /^\/vault/i, 'icloud.com': /^\/passwords/i, 'www.icloud.com': /^\/passwords/i };
const VAULT_PAGES = /^(chrome|edge|brave|opera|vivaldi|arc|dia|comet):\/\/(password-manager|passwords|settings\/passwords|settings\/autofill|settings\/payments|wallet\/passwords|wallet\/paymentMethods)|^about:logins/i;
// Password managers' browser extensions (Chrome Web Store and Edge ids): Bitwarden, 1Password, LastPass, Dashlane,
// Keeper, RoboForm, Proton Pass, Enpass, NordPass.
const VAULT_EXTENSIONS = /^(bhghoamapcdpbohphigoooaddinpkbai|nngceckbapebfimnlniiiahkandclblb|jbkfoedolllekgbhcbcoahefnbanhhlh|aeblfdkhhhdcdjpifhhbdiojplfjncoa|dppgmdbiimibapkepcbdbmkaabgiofem|khgocmkkpikpnmmkgmdnfckapcdkgfaf|hdokiejnpimakedhajhdlcegeplioahd|fdjamakpfbbddfjaooikfcpapjohcfmg|bfogiafebfohielmmehodmfbbebbbpei|pnlccmojcmeohlpggmfnbbiapkmbliob|ghmbeldphafepmbegfdlkpapadhbakde|kmcfomidfpdkfieipokbalgegidffkal|eiaeiblijfjekdanodkjadfinkhbfgcd|fooolghllnmhmmndgjiamiiodkpenpbb)$/i;
// A terminal whose title shows a command that prints a secret (round 6): 1Password's op with --reveal or op read, the
// keychain's find-*-password -w, pass, gopass, Bitwarden's and LastPass's CLIs.
const SECRET_CLI = /\bop (item get\b.*--reveal|read op:\/\/|item get\b.*--fields?\b.*(password|credential))|\bsecurity find-(generic|internet)-password\b.*-w\b|\b(pass|gopass) show\b|\bbw get (password|totp)\b|\blpass show\b/i;
const vaultShown = (win) => {
  const url = String(win?.url ?? '').trim(), app = String(win?.app ?? '').trim(), title = String(win?.title ?? '').trim();
  if (SETTINGS_APPS.test(app) && PASSWORDS_PANE.test(title)) return true;
  if (PASSWORD_BUNDLES.test(String(win?.bundle ?? ''))) return true;
  // Round 6: any part of the title ("Vaults | Bitwarden Web vault"), and the localized names ("Passwörter", "Contraseñas",
  // "Gestionnaire de mots de passe Google").
  const titleParts = title.split(/\s+[-–—|·:]\s+|\s*[|·•]\s*/).map((x) => x.replace(/[®™]/g, '').trim()).filter(Boolean);
  const titled = VAULT_TITLE.test(firstPart(title)) || VAULT_TITLE.test(title.replace(/[®™]/g, '')) || /google password manager|passwords\.google\.com/i.test(title)
    || titleParts.some((x) => VAULT_TITLE.test(x) || PASSWORD_APPS_LOCAL.test(x)) || LOCAL_MANAGER.test(title);
  // No address read: a browser whose title names a vault page (Safari's and Firefox's Passwords windows too).
  if (!url) return BROWSER_APPS.test(app) && titled;
  if (VAULT_PAGES.test(url)) return true;
  try {
    const u = new URL(url), h = u.hostname.toLowerCase();
    // A manager's extension page (its popup or vault), by its id or its title.
    if (/^(chrome|moz|safari-web|ms-browser)-extension:$|^extension:$/i.test(u.protocol)) return VAULT_EXTENSIONS.test(h) || new RegExp(String.raw`\b(${MANAGER})\b`, 'i').test(title);
    if (VAULT_HOSTS.test(h) && (!VAULT_PATHS[h] || VAULT_PATHS[h].test(u.pathname))) return true;
    // A self-hosted vault (Vaultwarden, Bitwarden, Passbolt): the manager's title on a vault, passwords or unlock page.
    return new RegExp(String.raw`^(${MANAGER})\b`, 'i').test(firstPart(title)) && /(^|[/#])(vault|passwords?|unlock|items)\b/i.test(`${u.pathname}${u.hash}`);
  } catch { return false; }
};
export function checkWindow(win, home, { viewers = true } = {}) {
  const app = String(win?.app ?? '').trim(), files = [];
  if (win?.document) files.push(String(win.document));
  if (win?.url) { try { const u = new URL(String(win.url).replace(/^view-source:/i, '')); if (u.protocol === 'file:') files.push(decodeURIComponent(u.pathname)); } catch { /* not a URL */ } }
  // No file or address said (hands-win never says one; some Mac editors set no document): a key file's name in the
  // title blocks it as the file itself would (R11g-3).
  if (!files.length && !win?.url) {
    // Its words are never quoted: a title is an email's subject, a page's name or a command (R11h-5).
    const homes = homesOf(home);
    if (titleNames(win?.title).some((n) => hits(SECRET, [norm(n, home)], homes)) || WEB_SECRET_FILE.test(foldHard(String(win?.title ?? ''))) || SECRET_CLI.test(String(win?.title ?? ''))) return verdict(BLOCK, `${app ? `${app}'s window title` : "That window's title"} names a file that holds passwords or keys, so I won't read it or look at it.`);
  }
  let worst = verdict(SAFE);
  for (const f of files) {
    // A Keynote document is a .key file too: in Keynote it is a slide deck, not a key (M7, by app and extension).
    const v = /^keynote$/i.test(app) && /\.key$/i.test(f) ? checkRead(f.replace(/\.key$/i, '.keynote'), home) : checkRead(f, home);
    if (v.level === BLOCK) return verdict(BLOCK, `${app || 'That window'} shows ${f}, so I won't read it or look at it. ${v.reason}`);
    if (v.level === ASK) worst = { ...verdict(ASK, `${v.reason} (${app || 'A window'} has it open.)`), ...(v.secret ? { secret: true } : {}) };
  }
  // A relay turn (viewers off, R11b-B): a file frees a window only in an app that just shows or edits it, never
  // Terminal, Finder, a browser or a chat app (their window shows more than the file).
  const plain = files.length ? viewers || DOC_APPS.test(app) : viewers && WINDOW_VIEWERS.test(app);
  if (!plain && worst.level === SAFE) {
    const title = String(win?.title ?? '').trim();
    const name = app ? `the ${app} window${title ? ` "${title}"` : ''}` : "a window I can't name";
    // A browser window with no address said: its address wasn't read, so it isn't said to have no file (R11g-2).
    const none = BROWSER_APPS.test(app) && !win?.url ? "I couldn't read which page or file it shows" : 'It has no file I can check';
    worst = { ...verdict(ASK, files.length ? `Look at ${name}? It shows ${files[0]}, but it could show more than that file.` : `Look at ${name}? ${none}, so it could show anything (a message, a document, a terminal).`), app };
  }
  // A password manager's window, or one showing a vault or a password page, shows sign-ins: tools.mjs refuses to read
  // it (vault, the owner's hard limit), and no earlier yes covers it.
  const vault = vaultShown(win);
  if (worst.level === SAFE && vault) {
    const title = String(win?.title ?? '').trim();
    worst = { ...verdict(ASK, `Look at ${app ? `the ${app} window` : 'that window'}${title ? ` "${title}"` : ''}? It looks like a password manager or a sign-in page, so it could show passwords.`), app };
  }
  // vault: a password manager's window (or one showing a real vault): reading it is refused (owner's hard limit,
  // tools.mjs). A file that holds sign-ins (SECRET: keys, sign-in stores under ~/.config, password exports, recovery
  // codes, seed phrases) is refused above, as read_file refuses it (M7); any other dotfile asks as an ordinary ask.
  if (worst.level === ASK && (isPasswordApp(app) || isPasswordApp(win?.bundle) || vault)) worst = { ...worst, secret: true, vault: true };
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
    // secret: a hidden or app-data one can hold sign-ins (readCheck), and on screen they're read: Approve all never answers.
    if (r.level === ASK || (!appBundle && hits(NO_WRITE, all, homes))) return { ...verdict(ASK, `Open ${r.path}${inApp ? ` in ${inApp}` : ''}? It's a settings, startup, hidden or app-data file.`), always: true, ...(r.secret ? { secret: true } : {}) };
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
export function checkTyped(text, home, { credentials = true } = {}) {
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
  // Owner's hard limit (fixed, not a setting): a card number or a key (sk_live_, ghp_, AKIA...) is never typed,
  // Approve all or not (M9).
  // credentials false: text joined from separate fields (a request's typing put together for its paths), whose pieces
  // were each checked on their own and whose join is no one value.
  if (credentials && typedCredential(t)) return { ...verdict(BLOCK, NO_CREDENTIALS), credential: true };
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
// Verbs that overwrite or take away what is there (a file written over, a draft or event changed, labels removed).
const MCP_OVERWRITE = /(?:^|_)(write|edit|update|overwrite|replace|clear|discard|modify|unlabel|patch|set|move|rename|batch)(?:_|$)/;
/** E2 approve-all: a connected server's call (an MCP tool or a claude.ai connector) that is deletion-class, so it asks
 *  even with Approve all on. A call the Mac can't classify is one (the contract: unknown is a deletion): only a server
 *  that says the tool only reads (readOnlyHint) or doesn't destroy (destructiveHint false) frees it, and never one named
 *  to delete, trash, send, pay (MCP_RISKY) or to overwrite (MCP_OVERWRITE). claude.ai's connectors send no hints, so
 *  every one of their asks is a deletion. A tag from the call itself, never from the question's words. */
export const deletesCall = ({ name, annotations } = {}) => annotations?.destructiveHint === true || MCP_RISKY.test(snake(name)) || MCP_OVERWRITE.test(snake(name))
  || !(annotations?.readOnlyHint === true || annotations?.destructiveHint === false);
/** Approve all says yes for every yes/no, including a deletion and a step the safe set called deletion-class.
 *  Never for a hard ask (hardAsk: pay or secret), checked first. A typed prompt (no choices, or a mask) still asks.
 *  A menu that is not a yes/no (the orb's Attach / Keep) still asks. Off: every ask asks. The deletion tag is ignored
 *  while Approve all is on. */
export const approveAllSays = (approveAll, opts) => {
  if (hardAsk(opts)) return false;
  if (approveAll !== true || !opts || opts.mask || opts.prompt != null) return false;
  const choices = opts.choices;
  if (!Array.isArray(choices) || choices.length === 0) return false;
  const text = choices.map((c) => String(c).trim());
  if (!text.some((c) => /^(allow|yes|install|remember)$/i.test(c))) return false;
  return text.length === 1 || text.some((c) => /^don['’]t\b/i.test(c) || /^no$/i.test(c));
};
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
    // secret: a hidden or app-data file can hold sign-ins, so Approve all never answers it (as read_file's).
    if (v.level === ASK) pathAsk = { ...verdict(ASK, `It reaches ${v.path}${named && v.reason.includes('outside') ? ', outside your Documents, Desktop and Downloads folders' : ', a hidden or app-data file that can hold sign-ins'}.`), always: true, ...(v.secret || pathAsk?.secret ? { secret: true } : {}) };
  }
  if (a.destructiveHint === true || MCP_RISKY.test(snake(name))) return { ...verdict(ASK, 'It can change, send or delete things.'), always: true, ...(pathAsk?.secret ? { secret: true } : {}) };
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
  return { ...verdict(ASK, "The server doesn't say it only reads."), always: true, ...(pathAsk?.secret ? { secret: true } : {}) };
}
