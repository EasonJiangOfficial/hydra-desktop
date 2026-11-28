#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::{io, path::Path};

/// This directory belongs to one helper. Dropping it retires even an image whose result never reached the shell.
pub(crate) struct VoiceArea(tempfile::TempDir);

impl VoiceArea {
    pub(crate) fn new() -> io::Result<Self> {
        Self::in_dir(&std::env::temp_dir())
    }

    fn in_dir(parent: &Path) -> io::Result<Self> {
        let mut builder = tempfile::Builder::new();
        builder.prefix("sidekick-voice-").rand_bytes(16);
        #[cfg(unix)]
        builder.permissions(std::fs::Permissions::from_mode(0o700));
        builder.tempdir_in(parent).map(Self)
    }

    pub(crate) fn path(&self) -> &Path {
        self.0.path()
    }

    pub(crate) fn owns_image(&self, path: &Path) -> bool {
        path.parent() == Some(self.path())
            && path
                .file_name()
                .and_then(|file| file.to_str())
                .and_then(|file| file.strip_prefix("sidekick-marked-"))
                .and_then(|file| file.strip_suffix(".png"))
                .is_some_and(|stamp| {
                    !stamp.is_empty() && stamp.bytes().all(|byte| byte.is_ascii_digit())
                })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn retirement_removes_a_never_forwarded_image_without_touching_other_workers() -> io::Result<()>
    {
        let fixture = tempfile::tempdir()?;
        let old = VoiceArea::in_dir(fixture.path())?;
        let next = VoiceArea::in_dir(fixture.path())?;
        #[cfg(unix)]
        assert_eq!(
            fs::metadata(old.path())?.permissions().mode() & 0o777,
            0o700
        );
        let old_image = old.path().join("sidekick-marked-101.png");
        let next_image = next.path().join("sidekick-marked-102.png");
        let sibling = fixture.path().join("sidekick-marked-103.png");
        for image in [&old_image, &next_image, &sibling] {
            fs::write(image, b"synthetic image")?;
        }
        assert!(old.owns_image(&old_image));
        assert!(!old.owns_image(&next_image));
        assert!(!old.owns_image(&sibling));
        assert!(!old.owns_image(&old.path().join("sidekick-marked-private.png")));
        drop(old);
        assert!(!old_image.exists());
        assert!(fs::write(&old_image, b"late writer").is_err());
        assert!(next_image.exists());
        drop(next);
        assert!(!next_image.exists());
        assert!(sibling.exists());
        Ok(())
    }
}
