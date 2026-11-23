// Voice helper (macOS: Apple speech; Windows: Parakeet on the PC) and the global shortcuts.

use super::*;
use std::cell::RefCell;
use std::io::{BufRead, BufReader, Write};
use std::process::Child;
use std::sync::atomic::AtomicU32;

/// Id of the registered show/hide hotkey, read by the hotkey event handler.
static SUMMON_ID: AtomicU32 = AtomicU32::new(0);
/// Id of the registered "ask about an area" hotkey.
static SNAP_ID: AtomicU32 = AtomicU32::new(0);
static LIST_ID: AtomicU32 = AtomicU32::new(0);
/// Id of the Esc hotkey, held only while the Roamie is on screen (0 when it isn't).
static ESC_ID: AtomicU32 = AtomicU32::new(0);

thread_local! {
    // The hotkey manager must live on the main thread; it also owns the current show/hide hotkey.
    static HOTKEYS: RefCell<Option<(global_hotkey::GlobalHotKeyManager, [Option<global_hotkey::hotkey::HotKey>; 3])>> = const { RefCell::new(None) };
    // The overlays that have the Roamie (or its card, or its ask field) on screen right now.
    static ESC_UP: RefCell<std::collections::HashSet<String>> = RefCell::new(std::collections::HashSet::new());
}

/// How the voice helper last ended on its own, and how many times it has, for diagnostics.
static VOICE_EXIT: std::sync::Mutex<Option<(Value, u32)>> = std::sync::Mutex::new(None);

pub(crate) fn last_voice_exit() -> Value {
    VOICE_EXIT.lock().ok().and_then(|e| e.clone()).map(|(how, times)| json!({ "last": how, "times": times })).unwrap_or(Value::Null)
}

pub(crate) fn voice_binary() -> Option<PathBuf> {
    helper_binary("roamies-voice")
}

pub(crate) fn start_voice(app: &AppHandle) {
    let state = app.state::<Voice>();
    if state.0.lock().unwrap().is_some() {
        return;
    }
    let Some(bin) = voice_binary() else {
        eprintln!("voice helper not found next to the app binary");
        return;
    };
    let chord = app.state::<TalkChord>().0.lock().unwrap().join(",");
    let mut cmd = Command::new(bin);
    cmd.arg("--chord").arg(chord);
    if let Some(dir) = app.state::<VoiceModel>().0.lock().unwrap().clone() {
        cmd.arg("--model").arg(dir);
    }
    // Microsoft's ONNX Runtime, bundled as a resource (fetch-onnxruntime.sh); the helper loads it at run time.
    #[cfg(any(windows, target_os = "linux"))]
    if let Ok(dir) = app.path().resource_dir() {
        cmd.arg("--ort").arg(dir.join(if cfg!(windows) { "onnxruntime.dll" } else { "libonnxruntime.so" }));
    }
    // Hydra's cues (voice/cue.swift): the overlay's rendered chimes, bundled as a resource (tauri.macos.conf.json).
    #[cfg(target_os = "macos")]
    if let Ok(dir) = app.path().resource_dir() {
        cmd.arg("--sounds").arg(dir.join("sounds"));
    }
    // Debug builds: ROAMIES_TEST_AUDIO=<wav> stands in for the microphone, to test talking with no mic (CI, Docker).
    #[cfg(debug_assertions)]
    if let Some(wav) = std::env::var_os("ROAMIES_TEST_AUDIO") {
        cmd.arg("--test-audio").arg(wav);
    }
    let mut child = match hide_console(&mut cmd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(log_stdio("sidekick-voice.log")).spawn() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("voice helper failed to start: {e}");
            return;
        }
    };
    let stdout = child.stdout.take().expect("piped stdout");
    let pid = child.id();
    *state.0.lock().unwrap() = Some(child);
    let app = app.clone();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
            let app2 = app.clone();
            let _ = app.run_on_main_thread(move || handle_voice(&app2, msg));
        }
        // Exited: anything it was drawing is gone, so the page draws the sidekick again.
        {
            let app2 = app.clone();
            let _ = app.run_on_main_thread(move || to_sidekick_buddy(&app2, &json!({ "state": "gone" })));
        }
        // If it is still the wanted helper, it died on its own: retry a few times.
        let state = app.state::<Voice>();
        let ours = {
            let mut slot = state.0.lock().unwrap();
            let ours = slot.as_ref().map(Child::id) == Some(pid);
            if ours {
                if let Some(mut c) = slot.take() {
                    if let Ok(status) = c.wait() {
                        let how = exit_info(status);
                        eprintln!("voice helper exited: {how}");
                        if let Ok(mut e) = VOICE_EXIT.lock() {
                            let times = e.as_ref().map_or(0, |(_, n)| *n) + 1;
                            *e = Some((how, times));
                        }
                    }
                }
            }
            ours
        };
        if ours && state.1.fetch_add(1, Ordering::Relaxed) < 3 {
            thread::sleep(Duration::from_secs(1));
            let app2 = app.clone();
            let _ = app.run_on_main_thread(move || start_voice(&app2));
        }
    });
}

pub(crate) fn stop_voice(app: &AppHandle) {
    let state = app.state::<Voice>();
    let child = state.0.lock().unwrap().take();
    if let Some(mut c) = child {
        let _ = c.kill();
        let _ = c.wait();
    }
    to_overlays(app, &json!({ "kind": "voice", "type": "state", "state": "idle" }));
}

pub(crate) fn to_voice(app: &AppHandle, msg: &Value) {
    if let Some(child) = app.state::<Voice>().0.lock().unwrap().as_mut() {
        if let Some(stdin) = child.stdin.as_mut() {
            let _ = writeln!(stdin, "{msg}");
        }
    }
}

/// Tell the voice helper to drop a talk-chord press that turned out to be the show/hide shortcut.
fn cancel_voice(app: &AppHandle) {
    to_voice(app, &json!({ "cmd": "cancel" }));
}

/// Show/hide shortcut (default ⌃⌥S): brings the sidekick forward, or sends it away if it's out.
/// Must run on the main thread.
pub(crate) fn init_hotkeys(app: &AppHandle) {
    use global_hotkey::{GlobalHotKeyEvent, GlobalHotKeyManager, HotKeyState};
    match GlobalHotKeyManager::new() {
        Ok(m) => HOTKEYS.with(|h| *h.borrow_mut() = Some((m, [None, None, None]))),
        Err(e) => return eprintln!("hotkeys unavailable: {e}"),
    }
    let app = app.clone();
    GlobalHotKeyEvent::set_event_handler(Some(move |e: GlobalHotKeyEvent| {
        if e.state() != HotKeyState::Pressed {
            return;
        }
        let summon = e.id() == SUMMON_ID.load(Ordering::Relaxed);
        let snap = e.id() == SNAP_ID.load(Ordering::Relaxed);
        let list = e.id() == LIST_ID.load(Ordering::Relaxed);
        let esc = e.id() != 0 && e.id() == ESC_ID.load(Ordering::Relaxed);
        if esc {
            // The panel has the keyboard: Esc closes it, as it would without this hotkey.
            let app2 = app.clone();
            let _ = app.run_on_main_thread(move || {
                let panel = app2.get_webview_window(PANEL_LABEL).filter(|w| w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false));
                if panel.is_some() {
                    hide_panel(&app2, "esc");
                } else {
                    to_overlays(&app2, &json!({ "kind": "esc" }));
                }
            });
            return;
        }
        if !summon && !snap && !list {
            return;
        }
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || {
            // Both shortcuts share modifiers with the talk chord; that press wasn't a request to talk.
            cancel_voice(&app2);
            if summon {
                to_overlays(&app2, &json!({ "kind": "summon" }));
            } else if list {
                to_sidecar(&app2, &json!({ "type": "show_list" }));
            } else {
                to_sidecar(&app2, &json!({ "type": "snap" }));
            }
        });
    }));
}

/// Swaps one global shortcut (0 = show/hide, 1 = ask about an area, 2 = show the list). On failure (bad format, or
/// another app owns it) the old one stays.
pub(crate) fn set_hotkey(slot: usize, accel: &str) -> Result<(), String> {
    use global_hotkey::hotkey::HotKey;
    let new: HotKey = accel.parse().map_err(|e| format!("{e}"))?;
    let id_slot = [&SUMMON_ID, &SNAP_ID, &LIST_ID][slot];
    HOTKEYS.with(|h| {
        let mut h = h.borrow_mut();
        let Some((manager, keys)) = h.as_mut() else { return Err("hotkeys unavailable".to_string()) };
        let current = keys[slot];
        if current.map(|c| c.id()) == Some(new.id()) {
            return Ok(());
        }
        if keys.iter().enumerate().any(|(i, k)| i != slot && k.map(|c| c.id()) == Some(new.id())) {
            return Err("already used by the other Hydra shortcut".to_string());
        }
        if let Some(old) = current {
            let _ = manager.unregister(old);
        }
        match manager.register(new) {
            Ok(()) => {
                keys[slot] = Some(new);
                id_slot.store(new.id(), Ordering::Relaxed);
                Ok(())
            }
            Err(e) => {
                if let Some(old) = current {
                    let _ = manager.register(old);
                }
                Err(format!("{e}"))
            }
        }
    })
}

/// Esc stops the Roamie's answer, or sends it away when it's idle (overlay host.js decides which). Global, so it
/// works without clicking the Roamie first; that means other apps don't get Esc meanwhile, so it's held only
/// while some overlay has the Roamie on screen. Must run on the main thread.
pub(crate) fn set_esc(app: &AppHandle, label: &str, on: bool) {
    use global_hotkey::hotkey::{Code, HotKey};
    let any = ESC_UP.with(|up| {
        let mut up = up.borrow_mut();
        if on {
            up.insert(label.to_owned());
        } else {
            up.remove(label);
        }
        // An overlay that closed (its screen went away) can't say it's done.
        up.retain(|l| app.get_webview_window(l).is_some());
        !up.is_empty()
    });
    HOTKEYS.with(|h| {
        let mut h = h.borrow_mut();
        let Some((manager, _)) = h.as_mut() else { return };
        let key = HotKey::new(None, Code::Escape);
        let held = ESC_ID.load(Ordering::Relaxed) != 0;
        if any && !held {
            match manager.register(key) {
                Ok(()) => ESC_ID.store(key.id(), Ordering::Relaxed),
                Err(e) => eprintln!("esc hotkey: {e}"),
            }
        } else if !any && held {
            let _ = manager.unregister(key);
            ESC_ID.store(0, Ordering::Relaxed);
            // global-hotkey's X11 backend queues the ungrab without sending it, so Esc stayed grabbed from every app
            // until the next registration grabbed it again (#67). Registering anything sends the queue: a combo no one
            // presses (it stays registered, so later calls only send the queue and report it's already there).
            #[cfg(target_os = "linux")]
            {
                use global_hotkey::hotkey::Modifiers;
                let _ = manager.register(HotKey::new(Some(Modifiers::CONTROL | Modifiers::ALT | Modifiers::SHIFT | Modifiers::SUPER), Code::F12));
            }
        }
    });
}

/// Hydra's own voice through the voice helper (W5 contract 6): the sidecar's speech messages as the helper's commands.
/// A chunk of 16-bit mono PCM (base64) plays; stop, pause and volume go along. Anything else is not for the helper.
pub(crate) fn play_cmd(msg: &Value) -> Option<Value> {
    if msg.get("stop").and_then(Value::as_bool) == Some(true) { return Some(json!({ "cmd": "play_stop" })); }
    if let Some(on) = msg.get("paused").and_then(Value::as_bool) { return Some(json!({ "cmd": "play_pause", "on": on })); }
    if let Some(v) = msg.get("volume").and_then(Value::as_f64) { return Some(json!({ "cmd": "play_volume", "v": v.clamp(0.0, 1.0) })); }
    let id = msg.get("id").and_then(Value::as_str).filter(|i| (1..=64).contains(&i.len()))?;
    let pcm = msg.get("pcm").and_then(Value::as_str).filter(|p| !p.is_empty() && p.len() <= 16_000_000)?;
    let rate = msg.get("rate").and_then(Value::as_f64).filter(|r| (8000.0..=96000.0).contains(r)).unwrap_or(44100.0);
    Some(json!({ "cmd": "play", "id": id, "pcm": pcm, "rate": rate }))
}

/// The orb's spectrum from the helper (24 bands, 0..1) for the Hydra window: cleaned, or None.
pub(crate) fn bands_push(msg: &Value) -> Option<Value> {
    let b = msg.get("b").and_then(Value::as_array)?;
    if b.len() != 24 { return None; }
    let v: Option<Vec<f64>> = b.iter().map(|x| x.as_f64().map(|f| (f.clamp(0.0, 1.0) * 1000.0).round() / 1000.0)).collect();
    Some(json!({ "bands": v? }))
}

fn handle_voice(app: &AppHandle, msg: Value) {
    let mut ui = msg.clone();
    ui["kind"] = json!("voice");
    if msg.get("type").and_then(Value::as_str) == Some("buddy") {
        to_sidekick_buddy(app, &msg);
        return;
    }
    // A click in another app while a drawing is up (see watch_clicks); not one on Roamies' own cards.
    if msg.get("type").and_then(Value::as_str) == Some("click") {
        if !crate::OVERLAY_HOT.load(Ordering::Relaxed) {
            to_sidecar(app, &json!({ "type": "user_click", "x": msg.get("x"), "y": msg.get("y"), "role": msg.get("role"), "app": msg.get("app"), "acts": msg.get("acts") }));
        }
        return;
    }
    if msg.get("type").and_then(Value::as_str) == Some("ready") {
        app.state::<Voice>().1.store(0, Ordering::Relaxed);
        // A started (or restarted) helper doesn't know the picked mic yet: the sidecar sends it again.
        to_sidecar(app, &json!({ "type": "voice_ready" }));
        return;
    }
    // Windows: the pen trail while circling something (voice-win/src/ink.rs); the overlays draw it, also during setup.
    if msg.get("type").and_then(Value::as_str) == Some("ink") {
        to_overlays(app, &ui);
        return;
    }
    // While the setup guide is open, talking is just the "try it" test: it never reaches the agent.
    if ONBOARDING.load(Ordering::Relaxed) {
        // Nothing answers here, so the listening pill goes as soon as the words are in.
        if msg.get("type").and_then(Value::as_str) == Some("final") {
            to_voice(app, &json!({ "cmd": "handoff" }));
        }
        to_onboarding(app, &ui);
        return;
    }
    match msg.get("type").and_then(Value::as_str) {
        Some("state") => {
            to_overlays(app, &ui);
            // mode: what opened a take (hold, handsfree, wake): a phrase take while Hydra thinks adds to the turn.
            // ask: the take an ask opened (listen via ask), so only that one is closed when the ask ends.
            to_sidecar(app, &json!({ "type": "voice_state", "state": msg.get("state"), "mode": msg.get("mode"), "ask": msg.get("ask") }));
        }
        // The orb's spectrum (W5 contract 5), straight to the Hydra window (at most 30 a second, from the helper).
        Some("bands") => { if let Some(p) = bands_push(&msg) { hydra::push(app, &p); } }
        // The helper couldn't play Hydra's voice: the overlay plays it again.
        Some("play_failed") => to_sidecar(app, &json!({ "type": "voice_play_failed", "why": msg.get("why").cloned().unwrap_or(Value::Null) })),
        Some("level") => to_overlays(app, &ui),
        // The words as they're recognised, for the Hydra window's orb card too (bridge v3: heard).
        Some("partial") => {
            to_overlays(app, &ui);
            // The owner talks again: a new turn, so the last reply clears (W3 contract-fixes 10).
            hydra::push(app, &json!({ "heard": { "text": msg.get("text").cloned().unwrap_or(Value::Null), "final": false }, "reply": Value::Null }));
        }
        Some("final") => {
            to_overlays(app, &ui);
            hydra::push(app, &json!({ "heard": { "text": msg.get("text").cloned().unwrap_or(Value::Null), "final": true }, "reply": Value::Null }));
            // area: the part of the screen marked with the pen while talking (a PNG, its rect and the strokes).
            to_sidecar(app, &json!({ "type": "voice", "text": msg.get("text"), "area": msg.get("area"), "ms": msg.get("ms"), "via": msg.get("via") }));
        }
        Some("error") => {
            let mut m = msg.clone();
            m["type"] = json!("voice_error");
            to_sidecar(app, &m);
        }
        // The speech language the helper settled on: its engine, and whether Apple's servers do the recognising.
        Some("lang") => {
            let mut m = msg.clone();
            m["type"] = json!("voice_lang");
            to_sidecar(app, &m);
        }
        // Hydra's sleep and wake: a double clap while it sleeps, or the sleep word while it listens.
        Some("clap") => to_sidecar(app, &json!({ "type": "agent_power", "on": true, "from": "clap" })),
        // The wake phrase while it sleeps: it wakes, and the take the phrase opened goes on (W5 contract 4).
        Some("phrase_wake") => to_sidecar(app, &json!({ "type": "agent_power", "on": true, "from": "phrase" })),
        // A take a clap, the key phrase or talking over Hydra started: it counts as talking (the 5-minute timer).
        // No echo cancellation on this Mac: barge-in is off for this session (the panel says why).
        Some("barge_unavailable") => to_sidecar(app, &json!({ "type": "voice_barge_unavailable" })),
        Some("barge_available") => to_sidecar(app, &json!({ "type": "voice_barge_available" })),
        Some("trigger") => to_sidecar(app, &json!({ "type": "voice_trigger", "via": msg.get("via").cloned().unwrap_or(Value::Null) })),
        Some("sleep_word") => to_sidecar(app, &json!({ "type": "agent_power", "on": false, "from": "sleep_word" })),
        // "Clap twice" heard the owner's claps (or not), and the live clap level for the panel.
        Some("clap_calibrated") | Some("clap_level") => {
            let mut m = msg.clone();
            m["type"] = json!(format!("voice_{}", msg.get("type").and_then(Value::as_str).unwrap_or("")));
            to_sidecar(app, &m);
        }
        // The mic list, for the panel's picker.
        Some("mics") => {
            let mut m = msg.clone();
            m["type"] = json!("voice_mics");
            to_sidecar(app, &m);
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hydras_voice_goes_to_the_helper() {
        assert_eq!(play_cmd(&json!({ "kind": "speech", "id": "s1", "pcm": "AAAB", "rate": 22050 })), Some(json!({ "cmd": "play", "id": "s1", "pcm": "AAAB", "rate": 22050.0 })));
        assert_eq!(play_cmd(&json!({ "kind": "speech", "id": "s1", "pcm": "AAAB" })).unwrap()["rate"], json!(44100.0), "Fish's rate by default");
        assert_eq!(play_cmd(&json!({ "kind": "speech", "stop": true })), Some(json!({ "cmd": "play_stop" })));
        assert_eq!(play_cmd(&json!({ "paused": true })), Some(json!({ "cmd": "play_pause", "on": true })));
        assert_eq!(play_cmd(&json!({ "volume": 3.0 })), Some(json!({ "cmd": "play_volume", "v": 1.0 })));
        assert_eq!(play_cmd(&json!({ "kind": "speech", "id": "s1", "end": true })), None, "the end needs nothing");
        assert_eq!(play_cmd(&json!({ "kind": "speech", "id": "s1", "feel": "happy", "at": 3 })), None);
        assert_eq!(play_cmd(&json!({ "kind": "speech", "id": "s1", "pcm": "AAAB", "rate": 1.0 })).unwrap()["rate"], json!(44100.0), "a rate out of range");
    }
    #[test]
    fn the_spectrum_is_24_bands_between_0_and_1() {
        let b: Vec<f64> = (0..24).map(|i| i as f64 / 10.0 - 0.5).collect();
        let p = bands_push(&json!({ "type": "bands", "b": b })).unwrap();
        let out = p["bands"].as_array().unwrap();
        assert_eq!(out.len(), 24);
        assert!(out.iter().all(|v| (0.0..=1.0).contains(&v.as_f64().unwrap())));
        assert_eq!(bands_push(&json!({ "b": [0.1, 0.2] })), None, "only 24");
        assert_eq!(bands_push(&json!({ "b": vec![json!("x"); 24] })), None);
    }
}
