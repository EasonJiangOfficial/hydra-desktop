// Hydra Desktop's main window: the Hydra web app (one codebase for every page), plus a small bridge so the web app's
// orb can mirror the Hydra Agent that runs here. The window only loads Hydra, its Supabase sign-in and Plaid Link (which
// Hydra embeds); any other page is blocked. wry asks about every frame's navigation, not just the top one, so a blocked
// load is never opened anywhere: only a link the owner opens in a new window (target=_blank) goes to the browser. The page gets no Tauri commands at all (main.rs refuses every invoke from this
// window): it talks to the app only through `hydra-desktop://<command>` navigations, which are caught here.
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};

pub const MAIN_LABEL: &str = "main";
pub const HYDRA_ORIGIN: &str = "https://hydra-olive-one.vercel.app";
pub const AUTH_ORIGIN: &str = "https://vtspmnippnixoqtomfxi.supabase.co";
const BRIDGE_SCHEME: &str = "hydra-desktop";

/// What to do with a navigation the window is about to make.
#[derive(Debug, PartialEq)]
pub enum Nav {
    /// Hydra, its sign-in, Plaid Link, or a page-internal document (about:blank, blob:, data:).
    Allow,
    /// A bridge call from the page: wake, sleep.
    Bridge(String),
    /// Anything else on the web: blocked in the window; from a new-window request the default browser opens it.
    External(String),
    /// Anything else (file:, javascript:, other apps' schemes): dropped.
    Block,
}

/// Hydra's own origin: the only page the bridge answers and the agent's state is sent to.
pub fn is_hydra(url: &Url) -> bool { url.origin().ascii_serialization() == HYDRA_ORIGIN }

/// Plaid Link (cdn.plaid.com and the other *.plaid.com hosts), which Hydra embeds to connect bank accounts.
fn is_plaid(url: &Url) -> bool {
    url.scheme() == "https" && url.port().is_none() && url.host_str().is_some_and(|h| h == "plaid.com" || h.ends_with(".plaid.com"))
}

pub fn route(url: &Url) -> Nav {
    match url.scheme() {
        "https" => {
            let origin = url.origin().ascii_serialization();
            if origin == HYDRA_ORIGIN || origin == AUTH_ORIGIN || is_plaid(url) { Nav::Allow } else { Nav::External(url.to_string()) }
        }
        "http" | "mailto" => Nav::External(url.to_string()),
        "about" | "blob" | "data" => Nav::Allow,
        // The app's own launch page (launch/index.html: the loading logo, then on to Hydra).
        "tauri" if url.host_str() == Some("localhost") => Nav::Allow,
        s if s == BRIDGE_SCHEME => Nav::Bridge(url.host_str().unwrap_or("").to_owned()),
        _ => Nav::Block,
    }
}

/// A random secret made at launch. Only the main frame gets it (the init script below is main-frame only on macOS:
/// tauri's `initialization_script`, a WKUserScript with forMainFrameOnly), so a call from an embedded frame (Plaid's
/// iframe, an ad) can't carry it, and is ignored.
pub fn bridge_token() -> &'static str {
    static T: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    T.get_or_init(|| {
        use std::io::Read;
        let mut b = [0u8; 16];
        let ok = std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut b)).is_ok();
        if !ok {
            // No /dev/urandom (never on a Mac): the clock and the process id, hashed.
            use std::hash::{BuildHasher, Hasher};
            let mut h = std::collections::hash_map::RandomState::new().build_hasher();
            h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
            h.write_u32(std::process::id());
            b[..8].copy_from_slice(&h.finish().to_le_bytes());
            b[8..].copy_from_slice(&std::collections::hash_map::RandomState::new().build_hasher().finish().to_le_bytes());
        }
        b.iter().map(|x| format!("{x:02x}")).collect()
    })
}

/// What a bridge call does: tell the sidecar something, open a link in the default browser, or (version 3, answered
/// through the push channel with the call's id) report setup or ask macOS for a permission.
#[derive(Debug, PartialEq)]
pub enum BridgeAct { Sidecar(Value), Open(String), Setup(u32), Permission(u32, String) }

/// A `hydra-desktop://<cmd>?t=<token>[&u=<link>]` call, or None: no token or the wrong one (another frame), a page that
/// isn't Hydra's own, an unknown call, or a link that isn't https, http or mailto.
pub fn bridge_action(url: &Url, token: &str, on_hydra: bool) -> Option<BridgeAct> {
    if !on_hydra || url.scheme() != BRIDGE_SCHEME { return None; }
    let param = |k: &str| url.query_pairs().find(|(n, _)| n == k).map(|(_, v)| v.into_owned());
    if param("t").as_deref() != Some(token) || token.is_empty() { return None; }
    // A promise call's id (version 3): the page's counter, echoed back in the answer.
    let id = || param("id").filter(|v| (1..=9).contains(&v.len()) && v.bytes().all(|b| b.is_ascii_digit())).and_then(|v| v.parse::<u32>().ok());
    let req = |cmd: &str, extra: Value| -> Option<BridgeAct> {
        let mut m = json!({ "type": "bridge_req", "id": id()?, "cmd": cmd });
        if let (Some(o), Value::Object(x)) = (m.as_object_mut(), extra) { o.extend(x); }
        Some(BridgeAct::Sidecar(m))
    };
    match url.host_str().unwrap_or("") {
        // Version 3: the web card's buttons drive the Mac's voice.
        "stop" => Some(BridgeAct::Sidecar(json!({ "type": "menu", "id": "stop", "via": "web" }))),
        "pause" => Some(BridgeAct::Sidecar(json!({ "type": "bridge_voice", "paused": true }))),
        "resume" => Some(BridgeAct::Sidecar(json!({ "type": "bridge_voice", "paused": false }))),
        "mute" => match param("on").as_deref() {
            Some("1") => Some(BridgeAct::Sidecar(json!({ "type": "bridge_voice", "muted": true }))),
            Some("0") => Some(BridgeAct::Sidecar(json!({ "type": "bridge_voice", "muted": false }))),
            _ => None,
        },
        // Version 3: one setup in the Hydra window.
        "setup" => id().map(BridgeAct::Setup),
        "perm" => {
            let kind = param("kind").filter(|k| ["mic", "accessibility", "screen"].contains(&k.as_str()))?;
            Some(BridgeAct::Permission(id()?, kind))
        }
        // The one-time pairing code: letters, digits and dashes only (the server's codes), never logged.
        "pair" => {
            let code = param("code").filter(|c| (6..=20).contains(&c.len()) && c.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'))?;
            req("pair", json!({ "code": code }))
        }
        "claude" => req("signInClaude", json!({})),
        "unpair" => req("unpair", json!({})),
        "wake" => Some(BridgeAct::Sidecar(json!({ "type": "agent_power", "on": true, "from": "web" }))),
        "sleep" => Some(BridgeAct::Sidecar(json!({ "type": "agent_power", "on": false, "from": "web" }))),
        "detach" => Some(BridgeAct::Sidecar(json!({ "type": "orb_set", "detached": true, "from": "web" }))),
        "attach" => Some(BridgeAct::Sidecar(json!({ "type": "orb_set", "detached": false, "from": "web" }))),
        // A link the owner clicked in Hydra that leaves Hydra: the default browser opens it (never in the window).
        "open" => {
            let link = param("u")?.parse::<Url>().ok()?;
            ["https", "http", "mailto"].contains(&link.scheme()).then(|| BridgeAct::Open(link.to_string()))
        }
        _ => None,
    }
}

/// window.hydraDesktop, for the Hydra web app (only on Hydra's own origin, main frame only). Documented in
/// docs/BRIDGE.md. It also sends a click on a link that leaves Hydra to the default browser.
pub fn bridge_js(token: &str) -> String {
    BRIDGE_JS.replace("__HYDRA_TOKEN__", token)
}
const BRIDGE_JS: &str = r#"(() => {
  if (location.origin !== 'https://hydra-olive-one.vercel.app' || window.hydraDesktop || window.top !== window) return;
  const T = '__HYDRA_TOKEN__';
  let snap = { state: 'Asleep', micLevel: 0, outputLevel: 0, detached: false, muted: false, paused: false, reply: null, heard: null, ui: null };
  const subs = new Set(), waiting = new Map();
  let n = 0;
  // Each call is its own hidden frame's navigation, caught and cancelled by the app (hydra.rs), so calls made one
  // right after another never replace each other the way two location changes in a row would.
  const call = (cmd, extra = '') => {
    const f = document.createElement('iframe');
    f.hidden = true;
    f.src = 'hydra-desktop://' + cmd + '?t=' + T + extra;
    (document.body || document.documentElement).appendChild(f);
    setTimeout(() => f.remove(), 3000);
  };
  // A call with an answer: the app replies through __hydraDesktopPush({ res: { id, result } }).
  const ask = (cmd, extra = '', ms = 180000) => new Promise((resolve, reject) => {
    const id = ++n;
    const t = setTimeout(() => { waiting.delete(id); reject(new Error('Hydra Desktop did not answer')); }, ms);
    waiting.set(id, (r) => { clearTimeout(t); resolve(r); });
    call(cmd, '&id=' + id + extra);
  });
  Object.defineProperty(window, 'hydraDesktop', { value: Object.freeze({
    version: 3,
    get state() { return snap.state; },
    get detached() { return snap.detached; },
    get micLevel() { return snap.micLevel; },
    get outputLevel() { return snap.outputLevel; },
    snapshot: () => ({ ...snap }),
    subscribe(fn) { subs.add(fn); try { fn({ ...snap }); } catch {} return () => subs.delete(fn); },
    wake: () => call('wake'),
    sleep: () => call('sleep'),
    detach: () => call('detach'),
    attach: () => call('attach'),
    stop: () => call('stop'),
    pause: () => call('pause'),
    resume: () => call('resume'),
    setMuted: (muted) => call('mute', '&on=' + (muted ? 1 : 0)),
    setup: () => ask('setup'),
    pair: (code) => ask('pair', '&code=' + encodeURIComponent(String(code))),
    signInClaude: () => ask('claude', '', 600000),
    requestPermission: (kind) => ask('perm', '&kind=' + encodeURIComponent(String(kind)), 150000),
    unpair: () => ask('unpair').then(() => undefined),
  }) });
  Object.defineProperty(window, '__hydraDesktopPush', { value: (m) => {
    if (m && m.res) { const done = waiting.get(m.res.id); if (done) { waiting.delete(m.res.id); done(m.res.result); } return; }
    snap = { ...snap, ...m };
    for (const fn of subs) { try { fn({ ...snap }); } catch {} }
    window.dispatchEvent(new CustomEvent('hydradesktop', { detail: { ...snap } }));
  } });
  // Links that leave Hydra (its sign-in and Plaid load in the window as usual): to the default browser.
  const stays = (u) => u.origin === location.origin || u.origin === 'https://vtspmnippnixoqtomfxi.supabase.co'
    || (u.protocol === 'https:' && !u.port && (u.hostname === 'plaid.com' || u.hostname.endsWith('.plaid.com')));
  document.addEventListener('click', (e) => {
    // Only a real click by the owner (a script's synthetic click can't open anything).
    if (!e.isTrusted || e.defaultPrevented || e.button !== 0) return;
    const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    let u; try { u = new URL(a.href, location.href); } catch { return; }
    if (!['https:', 'http:', 'mailto:'].includes(u.protocol) || stays(u)) return;
    e.preventDefault();
    call('open', '&u=' + encodeURIComponent(u.href));
  }, true);
})();"#;

/// Opens the main window, or brings it back.
pub fn open_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN_LABEL) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let nav_app = app.clone();
    // The default WKWebView store is on disk (not incognito), so the sign-in cookie survives restarts.
    let built = WebviewWindowBuilder::new(app, MAIN_LABEL, WebviewUrl::App("launch/index.html".into()))
        .title("Hydra")
        .inner_size(1440.0, 900.0)
        .min_inner_size(900.0, 600.0)
        .center()
        .background_color(tauri::window::Color(255, 255, 255, 255))
        .initialization_script(bridge_js(bridge_token()))
        .on_navigation(move |url| match route(url) {
            Nav::Allow => true,
            Nav::Bridge(_) => {
                // Only while the window shows Hydra itself, and only with the main frame's secret.
                let on_hydra = nav_app.get_webview_window(MAIN_LABEL).and_then(|w| w.url().ok()).is_some_and(|u| is_hydra(&u));
                match bridge_action(url, bridge_token(), on_hydra) {
                    Some(BridgeAct::Sidecar(msg)) => crate::to_sidecar(&nav_app, &msg),
                    Some(BridgeAct::Open(link)) => open_in_browser(&link),
                    Some(BridgeAct::Setup(id)) => crate::bridge_setup(&nav_app, id),
                    Some(BridgeAct::Permission(id, kind)) => crate::bridge_permission(&nav_app, id, kind),
                    None => {}
                }
                false
            }
            // Blocked, and not opened anywhere: this fires for every frame (an ad or embed loading), not just clicks.
            Nav::External(_) | Nav::Block => false,
        })
        .on_new_window(|url, _| {
            // target=_blank and window.open: Hydra's own pages stay in the window's browser; the rest go out.
            match route(&url) {
                Nav::External(link) => open_in_browser(&link),
                Nav::Allow if url.scheme() == "https" => open_in_browser(url.as_str()),
                _ => {}
            }
            tauri::webview::NewWindowResponse::Deny
        })
        .build();
    match built {
        Ok(w) => {
            let w2 = w.clone();
            // Closing hides it, so the page (and the orb in it) is there again at once from the Dock or the menu.
            w.on_window_event(move |e| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = e {
                    api.prevent_close();
                    let _ = w2.hide();
                }
            });
        }
        Err(e) => eprintln!("main window failed to open: {e}"),
    }
}

fn open_in_browser(link: &str) {
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").arg(link).spawn();
    #[cfg(not(target_os = "macos"))]
    let _ = link;
}

/// Takes the window to a Hydra or sign-in page (a pasted email sign-in link). Anything else is ignored.
pub fn navigate(app: &AppHandle, link: &str) {
    let Ok(url) = link.parse::<Url>() else { return };
    if !is_hydra(&url) && url.origin().ascii_serialization() != AUTH_ORIGIN { return; }
    if let Some(w) = app.get_webview_window(MAIN_LABEL) {
        let _ = w.navigate(url);
    }
}

/// What may go to the page from the app: the orb's state and levels, attached or not (version 2); muted, paused, the
/// reply being spoken, the words heard, a UI action and a promise call's answer (version 3). Anything else is dropped.
pub fn clean_push(msg: &Value) -> Option<Value> {
    let state = msg.get("state").and_then(Value::as_str).filter(|s| ["Asleep", "Listening", "Thinking", "Speaking"].contains(s));
    let level = |k: &str| msg.get(k).and_then(Value::as_f64).map(|v| (v.clamp(0.0, 1.0) * 1000.0).round() / 1000.0);
    let text = |v: &Value| v.as_str().map(|t| t.chars().take(20_000).collect::<String>());
    let mut out = serde_json::Map::new();
    if let Some(s) = state { out.insert("state".into(), json!(s)); }
    if let Some(v) = level("micLevel") { out.insert("micLevel".into(), json!(v)); }
    if let Some(v) = level("outputLevel") { out.insert("outputLevel".into(), json!(v)); }
    for k in ["detached", "muted", "paused"] {
        if let Some(d) = msg.get(k).and_then(Value::as_bool) { out.insert(k.into(), json!(d)); }
    }
    match msg.get("reply") {
        Some(Value::Null) => { out.insert("reply".into(), Value::Null); }
        Some(r) => if let (Some(id), Some(t)) = (r.get("id").filter(|v| v.is_string() || v.is_u64()), r.get("text").and_then(text)) {
            out.insert("reply".into(), json!({ "id": id, "text": t, "final": r.get("final").and_then(Value::as_bool).unwrap_or(false) }));
        },
        None => {}
    }
    match msg.get("heard") {
        Some(Value::Null) => { out.insert("heard".into(), Value::Null); }
        Some(h) => if let Some(t) = h.get("text").and_then(text) {
            out.insert("heard".into(), json!({ "text": t, "final": h.get("final").and_then(Value::as_bool).unwrap_or(false) }));
        },
        None => {}
    }
    // A UI action (the server's UiAction shape); the page checks every path again before acting on it.
    if let Some(a) = msg.get("ui").filter(|a| a.is_object()) {
        let s = |k: &str| a.get(k).and_then(Value::as_str).filter(|v| v.len() <= 2000);
        let ok = match s("kind") {
            Some("navigate") => s("href").is_some_and(|h| h.starts_with('/') && !h.starts_with("//")).then(|| json!({ "kind": "navigate", "href": s("href") })),
            Some("openPanel") => s("param").zip(s("value")).map(|(p, v)| json!({ "kind": "openPanel", "param": p, "value": v })),
            Some("setScope") => s("scope").filter(|v| ["all", "personal", "ugc"].contains(v)).map(|v| json!({ "kind": "setScope", "scope": v })),
            Some("highlight") => s("selector").map(|v| json!({ "kind": "highlight", "selector": v })),
            _ => None,
        };
        if let Some(mut v) = ok {
            // Each action is new, even when it repeats the last one.
            v["at"] = a.get("at").filter(|x| x.is_u64()).cloned().unwrap_or(json!(0));
            out.insert("ui".into(), v);
        }
    }
    // A promise call's answer. Only these keys reach the page; the sidecar never puts a key or code in one.
    if let Some(r) = msg.get("res") {
        if let Some(id) = r.get("id").and_then(Value::as_u64) {
            return Some(json!({ "res": { "id": id, "result": r.get("result").cloned().unwrap_or(Value::Null) } }));
        }
    }
    (!out.is_empty()).then(|| Value::Object(out))
}

/// Sends what clean_push lets through into the main window, only while it shows Hydra's own page (the sign-in or a
/// blocked page never gets the agent's state).
pub fn push(app: &AppHandle, msg: &Value) {
    let Some(w) = app.get_webview_window(MAIN_LABEL) else { return };
    if !w.url().is_ok_and(|u| is_hydra(&u)) { return; }
    let Some(out) = clean_push(msg) else { return };
    let _ = w.eval(format!("window.__hydraDesktopPush&&__hydraDesktopPush({out})"));
}

/// A promise call's answer.
pub fn answer(app: &AppHandle, id: u32, result: Value) {
    push(app, &json!({ "res": { "id": id, "result": result } }));
}

#[cfg(test)]
mod tests {
    use super::*;
    fn r(s: &str) -> Nav { route(&s.parse().unwrap()) }

    #[test]
    fn the_window_only_goes_to_hydra_and_its_sign_in() {
        assert_eq!(r("https://hydra-olive-one.vercel.app/dashboard?x=1"), Nav::Allow);
        assert_eq!(r("https://vtspmnippnixoqtomfxi.supabase.co/auth/v1/authorize"), Nav::Allow);
        assert_eq!(r("about:blank"), Nav::Allow);
        assert!(matches!(r("https://example.com/"), Nav::External(_)));
        assert_eq!(r("https://cdn.plaid.com/link/v2/stable/link-initialize.js"), Nav::Allow, "Plaid Link");
        assert_eq!(r("https://production.plaid.com/link/"), Nav::Allow, "Plaid's other hosts");
        assert!(matches!(r("https://plaid.com.evil.com/"), Nav::External(_)), "look-alike Plaid");
        assert!(matches!(r("https://evilplaid.com/"), Nav::External(_)), "not a Plaid subdomain");
        assert!(matches!(r("http://cdn.plaid.com/"), Nav::External(_)), "plain http is not Plaid");
        assert!(matches!(r("https://hydra-olive-one.vercel.app.evil.com/"), Nav::External(_)), "look-alike host");
        assert!(matches!(r("https://hydra-olive-one.vercel.app:8443/"), Nav::External(_)), "another port is another origin");
        assert!(matches!(r("http://hydra-olive-one.vercel.app/"), Nav::External(_)), "plain http is not Hydra");
        assert!(matches!(r("mailto:a@b.c"), Nav::External(_)));
        assert_eq!(r("file:///etc/passwd"), Nav::Block);
        assert_eq!(r("tauri://localhost/launch/index.html"), Nav::Allow, "the launch page");
        assert_eq!(r("tauri://evil/x"), Nav::Block);
        assert_eq!(r("javascript:alert(1)"), Nav::Block);
        assert_eq!(r("hydra-desktop://wake"), Nav::Bridge("wake".into()));
        assert_eq!(r("hydra-desktop://sleep"), Nav::Bridge("sleep".into()));
    }

    #[test]
    fn bridge_calls_need_hydra_and_the_main_frames_secret() {
        let u = |s: &str| s.parse::<Url>().unwrap();
        let t = "0123456789abcdef0123456789abcdef";
        assert_eq!(r("hydra-desktop://detach?t=x"), Nav::Bridge("detach".into()));
        assert_eq!(bridge_action(&u(&format!("hydra-desktop://detach?t={t}")), t, true), Some(BridgeAct::Sidecar(json!({ "type": "orb_set", "detached": true, "from": "web" }))));
        assert_eq!(bridge_action(&u(&format!("hydra-desktop://attach?t={t}")), t, true), Some(BridgeAct::Sidecar(json!({ "type": "orb_set", "detached": false, "from": "web" }))));
        assert_eq!(bridge_action(&u(&format!("hydra-desktop://wake?t={t}")), t, true), Some(BridgeAct::Sidecar(json!({ "type": "agent_power", "on": true, "from": "web" }))));
        assert_eq!(bridge_action(&u(&format!("hydra-desktop://sleep?t={t}")), t, true), Some(BridgeAct::Sidecar(json!({ "type": "agent_power", "on": false, "from": "web" }))));
        // An embedded frame (Plaid's iframe) has no secret, or guesses one.
        for c in ["wake", "sleep", "detach", "attach"] {
            assert_eq!(bridge_action(&u(&format!("hydra-desktop://{c}")), t, true), None, "{c} without the secret");
            assert_eq!(bridge_action(&u(&format!("hydra-desktop://{c}?t=guess")), t, true), None, "{c} with a wrong secret");
            assert_eq!(bridge_action(&u(&format!("hydra-desktop://{c}?t={t}")), t, false), None, "{c} from a page that isn't Hydra");
        }
        assert_eq!(bridge_action(&u(&format!("hydra-desktop://quit?t={t}")), t, true), None, "unknown calls do nothing");
        assert_eq!(bridge_action(&u("hydra-desktop://wake?t="), "", true), None, "an empty secret never matches");
        // Links that leave Hydra: https, http and mailto go to the browser; nothing else.
        let open = |link: &str| bridge_action(&u(&format!("hydra-desktop://open?t={t}&u={}", url_escape(link))), t, true);
        assert_eq!(open("https://example.com/a?b=1"), Some(BridgeAct::Open("https://example.com/a?b=1".into())));
        assert_eq!(open("http://example.com/"), Some(BridgeAct::Open("http://example.com/".into())));
        assert_eq!(open("mailto:a@b.c"), Some(BridgeAct::Open("mailto:a@b.c".into())));
        assert_eq!(open("javascript:alert(1)"), None);
        assert_eq!(open("file:///etc/passwd"), None);
        assert_eq!(open("x-apple.systempreferences:com.apple.preference.security"), None);
        // The page script: main frame and Hydra only, carries the secret, version 3.
        let js = bridge_js(t);
        assert!(js.contains(&format!("const T = '{t}'")) && !js.contains("__HYDRA_TOKEN__"));
        assert!(js.contains("!e.isTrusted"), "only real clicks open links");
        assert!(js.contains("window.top !== window") && js.contains("version: 3") && js.contains("detach: () => call('detach')") && js.contains("get detached()"));
        assert_eq!(bridge_token().len(), 32);
        assert_eq!(bridge_token(), bridge_token(), "one secret per launch");
    }
    fn url_escape(s: &str) -> String { s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect() }

    #[test]
    fn version_3_calls() {
        let u = |s: &str| s.parse::<Url>().unwrap();
        let t = "0123456789abcdef0123456789abcdef";
        let b = |s: &str| bridge_action(&u(&format!("hydra-desktop://{s}")), t, true);
        let sc = |v: Value| Some(BridgeAct::Sidecar(v));
        assert_eq!(b(&format!("stop?t={t}")), sc(json!({ "type": "menu", "id": "stop", "via": "web" })));
        assert_eq!(b(&format!("pause?t={t}")), sc(json!({ "type": "bridge_voice", "paused": true })));
        assert_eq!(b(&format!("resume?t={t}")), sc(json!({ "type": "bridge_voice", "paused": false })));
        assert_eq!(b(&format!("mute?t={t}&on=1")), sc(json!({ "type": "bridge_voice", "muted": true })));
        assert_eq!(b(&format!("mute?t={t}&on=0")), sc(json!({ "type": "bridge_voice", "muted": false })));
        assert_eq!(b(&format!("mute?t={t}&on=yes")), None, "mute needs 1 or 0");
        assert_eq!(b(&format!("setup?t={t}&id=7")), Some(BridgeAct::Setup(7)));
        assert_eq!(b(&format!("setup?t={t}")), None, "a promise call needs its id");
        assert_eq!(b(&format!("setup?t={t}&id=-1")), None);
        assert_eq!(b(&format!("setup?t={t}&id=1234567890")), None, "ids are short counters");
        assert_eq!(b(&format!("perm?t={t}&id=3&kind=mic")), Some(BridgeAct::Permission(3, "mic".into())));
        assert_eq!(b(&format!("perm?t={t}&id=3&kind=accessibility")), Some(BridgeAct::Permission(3, "accessibility".into())));
        assert_eq!(b(&format!("perm?t={t}&id=3&kind=screen")), Some(BridgeAct::Permission(3, "screen".into())));
        assert_eq!(b(&format!("perm?t={t}&id=3&kind=camera")), None, "only the three permissions");
        assert_eq!(b(&format!("pair?t={t}&id=4&code=AB12-CD34")), sc(json!({ "type": "bridge_req", "id": 4, "cmd": "pair", "code": "AB12-CD34" })));
        assert_eq!(b(&format!("pair?t={t}&id=4&code=a%22b%3Bc%3Cd")), None, "codes are letters, digits and dashes");
        assert_eq!(b(&format!("pair?t={t}&id=4&code=abc")), None, "too short");
        assert_eq!(b(&format!("pair?t={t}&code=AB12CD34")), None, "no id");
        assert_eq!(b(&format!("claude?t={t}&id=5")), sc(json!({ "type": "bridge_req", "id": 5, "cmd": "signInClaude" })));
        assert_eq!(b(&format!("unpair?t={t}&id=6")), sc(json!({ "type": "bridge_req", "id": 6, "cmd": "unpair" })));
        // The secret and Hydra's own page, as for every call.
        for c in ["stop", "pause", "resume", "mute?on=1&", "setup?id=1&", "perm?id=1&kind=mic&", "pair?id=1&code=AB12CD34&", "claude?id=1&", "unpair?id=1&"] {
            let (host, q) = c.split_once('?').map(|(h, q)| (h, q.to_owned())).unwrap_or((c, String::new()));
            assert_eq!(bridge_action(&u(&format!("hydra-desktop://{host}?{q}t=guess")), t, true), None, "{c} with a wrong secret");
            assert_eq!(bridge_action(&u(&format!("hydra-desktop://{host}?{q}t={t}")), t, false), None, "{c} from a page that isn't Hydra");
        }
        let js = bridge_js(t);
        for f in ["stop: () => call('stop')", "pause: () => call('pause')", "resume: () => call('resume')", "setMuted: (muted)", "setup: () => ask('setup')",
            "pair: (code)", "signInClaude: ()", "requestPermission: (kind)", "unpair: ()", "if (m && m.res)", "muted: false, paused: false, reply: null, heard: null, ui: null"] {
            assert!(js.contains(f), "the page script has {f}");
        }
    }

    #[test]
    fn pushes_carry_only_known_fields() {
        let p = |v: Value| clean_push(&v);
        assert_eq!(p(json!({ "state": "Speaking", "outputLevel": 1.7, "token": "x" })), Some(json!({ "state": "Speaking", "outputLevel": 1.0 })));
        assert_eq!(p(json!({ "state": "Dancing" })), None);
        assert_eq!(p(json!({ "muted": true, "paused": false })), Some(json!({ "muted": true, "paused": false })));
        assert_eq!(p(json!({ "reply": { "id": "r1", "text": "Hello", "final": true, "extra": 1 } })), Some(json!({ "reply": { "id": "r1", "text": "Hello", "final": true } })));
        assert_eq!(p(json!({ "reply": null })), Some(json!({ "reply": null })));
        assert_eq!(p(json!({ "reply": { "text": "no id" } })), None);
        assert_eq!(p(json!({ "heard": { "text": "what's my balance" } })), Some(json!({ "heard": { "text": "what's my balance", "final": false } })));
        let long = "a".repeat(30_000);
        assert_eq!(p(json!({ "heard": { "text": long, "final": true } })).unwrap()["heard"]["text"].as_str().unwrap().len(), 20_000);
        assert_eq!(p(json!({ "ui": { "kind": "navigate", "href": "/money?tx=1", "at": 3 } })), Some(json!({ "ui": { "kind": "navigate", "href": "/money?tx=1", "at": 3 } })));
        assert_eq!(p(json!({ "ui": { "kind": "navigate", "href": "//evil.com/" } })), None, "never another site");
        assert_eq!(p(json!({ "ui": { "kind": "navigate", "href": "https://evil.com/" } })), None);
        assert_eq!(p(json!({ "ui": { "kind": "setScope", "scope": "ugc" } })), Some(json!({ "ui": { "kind": "setScope", "scope": "ugc", "at": 0 } })));
        assert_eq!(p(json!({ "ui": { "kind": "setScope", "scope": "work" } })), None);
        assert_eq!(p(json!({ "ui": { "kind": "openPanel", "param": "tx", "value": "abc" } })), Some(json!({ "ui": { "kind": "openPanel", "param": "tx", "value": "abc", "at": 0 } })));
        assert_eq!(p(json!({ "ui": { "kind": "eval", "code": "x" } })), None);
        assert_eq!(p(json!({ "res": { "id": 9, "result": { "ok": true } }, "state": "Asleep" })), Some(json!({ "res": { "id": 9, "result": { "ok": true } } })), "an answer goes alone");
        assert_eq!(p(json!({ "res": { "id": "9" } })), None);
    }

    #[test]
    fn the_bridge_and_pushes_only_answer_hydra() {
        let u = |s: &str| s.parse::<Url>().unwrap();
        assert!(is_hydra(&u("https://hydra-olive-one.vercel.app/dashboard")));
        assert!(!is_hydra(&u("https://vtspmnippnixoqtomfxi.supabase.co/auth/v1/authorize")), "the sign-in page is not Hydra");
        assert!(!is_hydra(&u("https://cdn.plaid.com/link/")), "Plaid is allowed in the window, but is not Hydra");
        assert!(!is_hydra(&u("https://hydra-olive-one.vercel.app.evil.com/")));
        assert!(!is_hydra(&u("tauri://localhost/launch/index.html")));
    }
}
