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

/// What a bridge call does: tell the sidecar something, or open a link in the default browser.
#[derive(Debug, PartialEq)]
pub enum BridgeAct { Sidecar(Value), Open(String) }

/// A `hydra-desktop://<cmd>?t=<token>[&u=<link>]` call, or None: no token or the wrong one (another frame), a page that
/// isn't Hydra's own, an unknown call, or a link that isn't https, http or mailto.
pub fn bridge_action(url: &Url, token: &str, on_hydra: bool) -> Option<BridgeAct> {
    if !on_hydra || url.scheme() != BRIDGE_SCHEME { return None; }
    let param = |k: &str| url.query_pairs().find(|(n, _)| n == k).map(|(_, v)| v.into_owned());
    if param("t").as_deref() != Some(token) || token.is_empty() { return None; }
    match url.host_str().unwrap_or("") {
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
  let snap = { state: 'Asleep', micLevel: 0, outputLevel: 0, detached: false };
  const subs = new Set();
  const call = (cmd, extra = '') => { location.href = 'hydra-desktop://' + cmd + '?t=' + T + extra; };
  Object.defineProperty(window, 'hydraDesktop', { value: Object.freeze({
    version: 2,
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
  }) });
  Object.defineProperty(window, '__hydraDesktopPush', { value: (m) => {
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

/// The agent's state for the web app's orb: { state, micLevel, outputLevel }, from the overlay (host.js).
pub fn push(app: &AppHandle, msg: &Value) {
    let Some(w) = app.get_webview_window(MAIN_LABEL) else { return };
    // Only into Hydra's own page (the sign-in or a blocked page never gets the agent's state).
    if !w.url().is_ok_and(|u| is_hydra(&u)) { return; }
    let state = msg.get("state").and_then(Value::as_str).filter(|s| ["Asleep", "Listening", "Thinking", "Speaking"].contains(s));
    let level = |k: &str| msg.get(k).and_then(Value::as_f64).map(|v| (v.clamp(0.0, 1.0) * 1000.0).round() / 1000.0);
    let mut out = serde_json::Map::new();
    if let Some(s) = state { out.insert("state".into(), json!(s)); }
    if let Some(v) = level("micLevel") { out.insert("micLevel".into(), json!(v)); }
    if let Some(v) = level("outputLevel") { out.insert("outputLevel".into(), json!(v)); }
    if let Some(d) = msg.get("detached").and_then(Value::as_bool) { out.insert("detached".into(), json!(d)); }
    if out.is_empty() { return; }
    let _ = w.eval(format!("window.__hydraDesktopPush&&__hydraDesktopPush({})", Value::Object(out)));
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
        // The page script: main frame and Hydra only, carries the secret, version 2.
        let js = bridge_js(t);
        assert!(js.contains(&format!("const T = '{t}'")) && !js.contains("__HYDRA_TOKEN__"));
        assert!(js.contains("!e.isTrusted"), "only real clicks open links");
        assert!(js.contains("window.top !== window") && js.contains("version: 2") && js.contains("detach: () => call('detach')") && js.contains("get detached()"));
        assert_eq!(bridge_token().len(), 32);
        assert_eq!(bridge_token(), bridge_token(), "one secret per launch");
    }
    fn url_escape(s: &str) -> String { s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect() }

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
