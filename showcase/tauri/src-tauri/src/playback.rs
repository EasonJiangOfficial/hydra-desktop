use objc2::rc::{Retained, Weak};
use objc2::runtime::{AnyObject, NSObject, NSObjectProtocol, ProtocolObject, Sel};
use objc2::{define_class, msg_send, sel, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2_web_kit::{
    WKNavigationAction, WKNavigationActionPolicy, WKNavigationDelegate, WKWebView,
};
use tauri::{Url, WebviewWindow};

type NavigationDelegate = ProtocolObject<dyn WKNavigationDelegate>;

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = Weak<NavigationDelegate>]
    struct PlaybackNavigationDelegate;

    unsafe impl NSObjectProtocol for PlaybackNavigationDelegate {
        #[unsafe(method(respondsToSelector:))]
        fn responds_to_selector(&self, selector: Sel) -> bool {
            let responds: objc2::runtime::Bool =
                unsafe { msg_send![super(self), respondsToSelector: selector] };
            responds.as_bool()
                || self.ivars().load().is_some_and(|original| original.respondsToSelector(selector))
        }
    }

    impl PlaybackNavigationDelegate {
        // WebKit detects optional delegate callbacks through respondsToSelector. Forward unhandled
        // callbacks to Wry, including its response policy, load lifecycle, and process recovery.
        #[unsafe(method_id(forwardingTargetForSelector:))]
        fn forwarding_target_for_selector(&self, selector: Sel) -> Option<Retained<NavigationDelegate>> {
            self.ivars().load().filter(|original| original.respondsToSelector(selector))
        }
    }

    unsafe impl WKNavigationDelegate for PlaybackNavigationDelegate {
        #[unsafe(method(webView:decidePolicyForNavigationAction:decisionHandler:))]
        fn decide_policy(
            &self,
            webview: &WKWebView,
            action: &WKNavigationAction,
            handler: &block2::Block<dyn Fn(WKNavigationActionPolicy)>,
        ) {
            let Some(original) = self.ivars().load() else {
                handler.call((WKNavigationActionPolicy::Cancel,));
                return;
            };
            if allows_action(webview, action) {
                handler.call((WKNavigationActionPolicy::Allow,));
            } else {
                unsafe { original.webView_decidePolicyForNavigationAction_decisionHandler(webview, action, handler) };
            }
        }
    }
);

pub(super) fn install(window: &WebviewWindow) {
    if let Err(error) = window.with_webview(|platform_webview| {
        // with_webview runs on the main thread. On macOS its inner handle is a WKWebView subclass.
        let Some(main_thread) = MainThreadMarker::new() else {
            return;
        };
        let webview = unsafe { &*platform_webview.inner().cast::<WKWebView>() };
        install_delegate(webview, main_thread);
    }) {
        eprintln!("playback navigation policy could not be installed: {error}");
    }
}

fn install_delegate(webview: &WKWebView, main_thread: MainThreadMarker) {
    let Some(original) = (unsafe { webview.navigationDelegate() }) else {
        return;
    };
    // The pinned Wry delegate uses the callback without preferences. If its policy changes,
    // leave Wry in place rather than installing a proxy over a different policy entry point.
    if !original.respondsToSelector(sel!(webView:decidePolicyForNavigationAction:decisionHandler:))
        || original.respondsToSelector(
            sel!(webView:decidePolicyForNavigationAction:preferences:decisionHandler:),
        )
    {
        return;
    }
    let proxy = main_thread
        .alloc::<PlaybackNavigationDelegate>()
        .set_ivars(Weak::new(&original));
    let proxy: Retained<PlaybackNavigationDelegate> = unsafe { msg_send![super(proxy), init] };
    // WKWebView's delegate property is weak. Tie the proxy to this WebView, while Wry owns
    // the original delegate. The proxy holds only a zeroing weak reference back to Wry.
    static PLAYBACK_DELEGATE_KEY: u8 = 0;
    unsafe {
        objc2::ffi::objc_setAssociatedObject(
            (webview as *const WKWebView).cast_mut().cast::<AnyObject>(),
            (&PLAYBACK_DELEGATE_KEY as *const u8).cast(),
            Retained::as_ptr(&proxy).cast_mut().cast::<AnyObject>(),
            objc2::ffi::OBJC_ASSOCIATION_RETAIN_NONATOMIC,
        );
        webview.setNavigationDelegate(Some(ProtocolObject::from_ref(&*proxy)));
    }
}

fn allows_action(webview: &WKWebView, action: &WKNavigationAction) -> bool {
    unsafe {
        if action.shouldPerformDownload()
            || !action
                .targetFrame()
                .is_some_and(|frame| !frame.isMainFrame())
        {
            return false;
        }
        let top_url = webview.URL().and_then(|url| url.absoluteString());
        let embed_url = action.request().URL().and_then(|url| url.absoluteString());
        top_url
            .zip(embed_url)
            .is_some_and(|(top, embed)| allows_playback_urls(&top.to_string(), &embed.to_string()))
    }
}

fn allows_playback_urls(top: &str, embed: &str) -> bool {
    let (Ok(top), Ok(embed)) = (Url::parse(top), Url::parse(embed)) else {
        return false;
    };
    if !super::is_hydra(&top)
        || !top.username().is_empty()
        || top.password().is_some()
        || embed.scheme() != "https"
        || embed.host_str() != Some("embed.vidrift.net")
        || embed.port().is_some()
        || !embed.username().is_empty()
        || embed.password().is_some()
    {
        return false;
    }

    // Compare positive numeric IDs, and accept episode changes only for the active TV title.
    let number = |segment: &str| {
        if !segment.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        segment.parse::<u64>().ok()
    };
    let top_segments: Vec<_> = top.path().split('/').collect();
    let embed_segments: Vec<_> = embed.path().split('/').collect();
    let ["", "entertainment", "play", media, top_id] = top_segments.as_slice() else {
        return false;
    };
    let Some(top_id) = number(top_id).filter(|id| *id > 0) else {
        return false;
    };
    match (*media, embed_segments.as_slice()) {
        ("movie", ["", "embed", "movie", id]) => number(id) == Some(top_id),
        ("tv", ["", "embed", "tv", id, season, episode]) => {
            number(id) == Some(top_id)
                && number(season).is_some()
                && number(episode).is_some_and(|episode| episode > 0)
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::super::HYDRA_ORIGIN;
    use super::*;

    #[test]
    fn permits_only_the_active_title_on_the_player_origin() {
        let movie = format!("{HYDRA_ORIGIN}/entertainment/play/movie/42");
        let tv = format!("{HYDRA_ORIGIN}/entertainment/play/tv/42?season=1&episode=1");
        assert!(allows_playback_urls(
            &movie,
            "https://embed.vidrift.net:443/embed/movie/42"
        ));
        assert!(allows_playback_urls(
            &tv,
            "https://embed.vidrift.net/embed/tv/42/2/3"
        ));
        assert!(allows_playback_urls(
            &tv,
            "https://embed.vidrift.net/embed/tv/42/0/1"
        ));
        for url in [
            "http://embed.vidrift.net/embed/movie/42",
            "https://embed.vidrift.net:8443/embed/movie/42",
            "https://player@embed.vidrift.net/embed/movie/42",
            "https://embed.vidrift.net.evil.test/embed/movie/42",
            "https://embed.vidrift.net/embed/tv/42/1/1",
            "https://embed.vidrift.net/embed/movie/41",
            "https://embed.vidrift.net/embed/movie/+42",
            "https://embed.vidrift.net/embed/movie/42/",
            "https://embed.vidrift.net/embed/movie/42/extra",
        ] {
            assert!(!allows_playback_urls(&movie, url), "{url}");
        }
        for url in [
            "https://embed.vidrift.net/embed/tv/41/1/1",
            "https://embed.vidrift.net/embed/tv/42/1/0",
            "https://embed.vidrift.net/embed/tv/42/1/-1",
            "https://embed.vidrift.net/embed/tv/42/1",
        ] {
            assert!(!allows_playback_urls(&tv, url), "{url}");
        }
        for top in [
            format!("{HYDRA_ORIGIN}/entertainment"),
            format!("{HYDRA_ORIGIN}/entertainment/play/movie/0"),
            format!("{HYDRA_ORIGIN}/entertainment/play/movie/42/extra"),
            "https://evil.test/entertainment/play/movie/42".into(),
        ] {
            assert!(
                !allows_playback_urls(&top, "https://embed.vidrift.net/embed/movie/42"),
                "{top}"
            );
        }
        assert!(matches!(
            super::super::route(&"https://embed.vidrift.net/embed/movie/42".parse().unwrap()),
            super::super::Nav::External(_)
        ));
    }
}
