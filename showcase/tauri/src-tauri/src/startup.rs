// The startup sound's once-per-launch rule (owner, 2026-11-26: "there should be an audio when hydra starts up along
// with the loading animation"). Every launch is a startup, Open at Login and the setup guide's relaunch included.
// Std only, so it runs on its own: rustc --edition 2021 --test src/startup.rs -o <out> && <out>
use std::time::Duration;

/// The first startup cue inside this long after launch plays; a later one would sound random.
pub(crate) const WINDOW: Duration = Duration::from_secs(6);

/// Why a startup cue is dropped, or None when it plays: the first ask only, and only inside the window. A dropped
/// first ask still uses up the chance.
pub(crate) fn drop_reason(done: bool, since_launch: Duration) -> Option<&'static str> {
    if done {
        Some("again")
    } else if since_launch > WINDOW {
        Some("late")
    } else {
        None
    }
}

/// The app's log line for the tone it played itself, written after afplay exits: "played" only on a clean exit (a
/// missing startup.wav makes afplay exit non-zero). wait is afplay's exit code (None: killed by a signal).
pub(crate) fn afplay_line(ms: u128, wait: Result<Option<i32>, String>) -> String {
    match wait {
        Ok(Some(0)) => format!("startup cue: played by the app {ms} ms after launch"),
        Ok(Some(code)) => format!("startup cue: not played (afplay exit {code})"),
        Ok(None) => "startup cue: not played (afplay killed)".into(),
        Err(e) => format!("startup cue: not played (afplay: {e})"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_startup_sound_plays_once_per_launch_and_only_inside_the_window() {
        assert_eq!(drop_reason(false, Duration::from_millis(1500)), None);
        assert_eq!(drop_reason(false, WINDOW), None);
        assert_eq!(drop_reason(true, Duration::from_millis(1600)), Some("again"), "a second ask is dropped");
        assert_eq!(drop_reason(false, WINDOW + Duration::from_millis(1)), Some("late"));
        assert_eq!(drop_reason(true, Duration::from_millis(100)), Some("again"), "the late one used up the chance");
        assert_eq!(WINDOW, Duration::from_secs(6));
    }

    #[test]
    fn the_app_says_played_only_after_afplay_ran_clean() {
        assert_eq!(afplay_line(3120, Ok(Some(0))), "startup cue: played by the app 3120 ms after launch");
        assert_eq!(afplay_line(3120, Ok(Some(1))), "startup cue: not played (afplay exit 1)", "a missing file");
        assert_eq!(afplay_line(3120, Ok(None)), "startup cue: not played (afplay killed)");
        assert_eq!(afplay_line(3120, Err("boom".into())), "startup cue: not played (afplay: boom)");
    }
}
