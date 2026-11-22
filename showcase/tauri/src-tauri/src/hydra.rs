// Hydra Desktop's main window: the Hydra web app (one codebase for every page), plus a small bridge so the web app's
// orb can mirror the Hydra Agent that runs here. The window only goes to Hydra and its Supabase sign-in; every other
// link opens in the default browser. The page gets no Tauri commands at all (main.rs refuses every invoke from this
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
    /// Hydra, its sign-in, or a page-internal document (about:blank, blob:, data:).
    Allow,
    /// A bridge call from the page: wake, sleep.
    Bridge(String),
    /// Anything else on the web: the default browser opens it; the window stays put.
    External(String),
    /// Anything else (file:, javascript:, other apps' schemes): dropped.
    Block,
}

pub fn route(url: &Url) -> Nav {
    match url.scheme() {
        "https" => {
            let origin = url.origin().ascii_serialization();
            if origin == HYDRA_ORIGIN || origin == AUTH_ORIGIN { Nav::Allow } else { Nav::External(url.to_string()) }
        }
        "http" | "mailto" => Nav::External(url.to_string()),
        "about" | "blob" | "data" => Nav::Allow,
        // The app's own launch page (launch/index.html: the loading logo, then on to Hydra).
        "tauri" if url.host_str() == Some("localhost") => Nav::Allow,
        s if s == BRIDGE_SCHEME => Nav::Bridge(url.host_str().unwrap_or("").to_owned()),
        _ => Nav::Block,
    }
}

/// window.hydraDesktop, for the Hydra web app (only on Hydra's own origin). Documented in docs/BRIDGE.md.
const BRIDGE_JS: &str = r#"(() => {
  if (location.origin !== 'https://hydra-olive-one.vercel.app' || window.hydraDesktop) return;
  let snap = { state: 'Asleep', micLevel: 0, outputLevel: 0 };
  const subs = new Set();
  const call = (cmd) => { location.href = 'hydra-desktop://' + cmd; };
  Object.defineProperty(window, 'hydraDesktop', { value: Object.freeze({
    version: 1,
    get state() { return snap.state; },
    get micLevel() { return snap.micLevel; },
    get outputLevel() { return snap.outputLevel; },
    snapshot: () => ({ ...snap }),
    subscribe(fn) { subs.add(fn); try { fn({ ...snap }); } catch {} return () => subs.delete(fn); },
    wake: () => call('wake'),
    sleep: () => call('sleep'),
  }) });
  Object.defineProperty(window, '__hydraDesktopPush', { value: (m) => {
    snap = { ...snap, ...m };
    for (const fn of subs) { try { fn({ ...snap }); } catch {} }
    window.dispatchEvent(new CustomEvent('hydradesktop', { detail: { ...snap } }));
  } });
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
        .initialization_script(BRIDGE_JS)
        .on_navigation(move |url| match route(url) {
            Nav::Allow => true,
            Nav::Bridge(cmd) => {
                match cmd.as_str() {
                    "wake" | "sleep" => crate::to_sidecar(&nav_app, &json!({ "type": "agent_power", "on": cmd == "wake", "from": "web" })),
                    _ => {}
                }
                false
            }
            Nav::External(link) => {
                open_in_browser(&link);
                false
            }
            Nav::Block => false,
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
    if url.scheme() != "https" || route(&url) != Nav::Allow { return; }
    if let Some(w) = app.get_webview_window(MAIN_LABEL) {
        let _ = w.navigate(url);
    }
}

/// The agent's state for the web app's orb: { state, micLevel, outputLevel }, from the overlay (host.js).
pub fn push(app: &AppHandle, msg: &Value) {
    let Some(w) = app.get_webview_window(MAIN_LABEL) else { return };
    let state = msg.get("state").and_then(Value::as_str).filter(|s| ["Asleep", "Listening", "Thinking", "Speaking"].contains(s));
    let level = |k: &str| msg.get(k).and_then(Value::as_f64).map(|v| (v.clamp(0.0, 1.0) * 1000.0).round() / 1000.0);
    let mut out = serde_json::Map::new();
    if let Some(s) = state { out.insert("state".into(), json!(s)); }
    if let Some(v) = level("micLevel") { out.insert("micLevel".into(), json!(v)); }
    if let Some(v) = level("outputLevel") { out.insert("outputLevel".into(), json!(v)); }
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
}
