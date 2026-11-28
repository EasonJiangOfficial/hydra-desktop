use std::sync::atomic::{AtomicUsize, Ordering};

/// A helper's queued stdout can reach the main thread after the child was stopped.
#[derive(Default)]
pub(crate) struct VoiceEpoch(AtomicUsize);

impl VoiceEpoch {
    pub(crate) fn advance(&self) -> usize {
        self.0.fetch_add(1, Ordering::AcqRel) + 1
    }

    pub(crate) fn owns(&self, epoch: usize) -> bool {
        self.0.load(Ordering::Acquire) == epoch
    }
}

pub(crate) fn setup_only(onboarding: bool, kind: Option<&str>) -> bool {
    onboarding && !matches!(kind, Some("take_started" | "state" | "partial" | "final"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retirement_fences_pending_output_and_start_replaces_the_worker() {
        let epoch = VoiceEpoch::default();
        let old_worker = epoch.advance();
        assert!(epoch.owns(old_worker));
        let retired = epoch.advance();
        assert!(!epoch.owns(old_worker));
        let replacement = epoch.advance();
        assert!(!epoch.owns(old_worker));
        assert!(!epoch.owns(retired));
        assert!(epoch.owns(replacement));
    }

    #[test]
    fn setup_transcripts_and_take_events_still_pass_through_the_pairing_gate() {
        for kind in ["take_started", "state", "partial", "final"] {
            assert!(!setup_only(true, Some(kind)));
        }
        assert!(setup_only(true, Some("level")));
        assert!(!setup_only(false, Some("level")));
    }
}
