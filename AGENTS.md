# AGENTS.md

Roamies: a Tauri 2 desktop app (Rust shell in `showcase/tauri/src-tauri`), a Node sidecar that runs the
agent (`showcase/tauri/sidecar`), shared browser JS in `showcase/roamies`, macOS Swift helpers built by
`src-tauri/build.rs`, and two Windows helpers built by `build.sh` for Windows targets: voice
(`src-tauri/voice-win`, Rust + Parakeet; `--transcribe <wav>` and `--test-audio <wav>` test speech without a
Windows PC, see the top of its `main.rs`) and hands (`src-tauri/hands-win`, the twin of `hands/main.swift`: same
commands and JSON, over Win32, UI Automation and Windows OCR). Only hands-win's `logic.rs` builds off Windows, so
`cargo test` there runs its checks anywhere; `roamies-hands --smoke` drives Notepad on a real Windows desktop (CI).
From a Mac, `cargo xwin check --target x86_64-pc-windows-msvc` type-checks the Windows code with the real SDK.

Linux (beta) uses the same voice helper (`voice-win` builds for Linux too: ALSA mic, talk keys over X11, and a
`toggle` command for `roamies --talk` on Wayland) and no hands helper. Its shell code is `src-tauri/src/linux.rs`:
every window is an X11 window (`GDK_BACKEND=x11` on Wayland, through XWayland), the overlay lets clicks through by
region (the page reports its click areas, `host.js` → `set_hit_rects`) instead of following the cursor, and
screenshots, copying, Open at Login and AppImage-only updates live there. Debug aids: `ROAMIES_TRACE=1` prints the
overlay's click areas, and in debug builds `ROAMIES_TEST_AUDIO=<wav>` stands in for the microphone.

## Commands

```sh
cd showcase/tauri/sidecar && npm ci     # install sidecar deps
npm test                                # sidecar tests (reply stream, storage, pointing, safety, voice model download)
npm run build                           # bundle the sidecar into dist/
cd .. && ./build.sh dev                 # web files + sidecar + debug `cargo build`
./build.sh                              # release bundle for this OS (signs on macOS if a Developer ID is in the keychain)
```

There is no linter configured yet.

Releases: push a `v*` tag (or run `.github/workflows/release.yml` by hand). It builds a signed, notarized
macOS DMG (Apple silicon and Intel), an unsigned Windows installer and the Linux beta (AppImage, .deb, .rpm, built on
Ubuntu 24.04 because ONNX Runtime needs glibc 2.38) into a draft GitHub release. The Linux leg may fail without
stopping the release; `latest.json` lists Linux only when its AppImage is there.

## Rules

- Every tool that touches files, commands, URLs or other apps goes through `showcase/tauri/sidecar/safety.mjs`
  (tested in `test/safety.test.mjs`); the hands helpers also refuse to type or click in the apps in `HANDS_OFF`
  (by bundle id in `hands/main.swift`, by program name in `hands-win/src/logic.rs`).
  Add a test case with every rule change.
- In-app updates read `latest.json` from the newest published release, signed with the key in the
  `TAURI_SIGNING_PRIVATE_KEY` secret. Keep `plugins.updater.pubkey` in `tauri.conf.json` matching it.
  When GitHub's release links fail, the updater falls back to the copy on the `updates` branch, which
  `.github/workflows/update-feed.yml` writes whenever a release is published; downloads go through the API.

- CI lives in `.github/workflows/ci.yml` and must stay green.
- Never commit with `--no-verify`.
- Never commit experiments (prototypes, test pages, design tools). They stay local and are listed in `.git/info/exclude`; check `git status` before every commit.
- Never commit secrets (Apple ID passwords, certificates, `~/.gg/auth.json`); signing credentials go in GitHub Actions secrets.

## Build it right the first time

Most review rounds on Hydra fix the same kinds of bugs. This list comes from 1,254 review findings across the web app
and Hydra Desktop (2026-11-21 to 2026-11-27). The number is how many high or medium bugs each line would have stopped.
Work through every line before you ask for review, and say in the commit or PR which lines applied and how you met them.

1. **(139) Cover every path into a rule.** For each guard, list every way to reach the guarded action and every input
   shape: click, Return, Space, a newline in typed text, press-and-drag, every modifier combo (Shift+Cmd+V is still
   paste), quotes, Unicode, other languages, empty and null. One test per path. Safety rules (passwords, card numbers,
   money, Approve all) hold 26% of the serious bugs: be most careful there.
2. **(39) Error, cancel and Stop paths.** For every async flow, test the stored state after an error, a timeout, Stop,
   a decline and a restart. Cleanup goes in `finally`. Stop must stop every running turn, not only the local one.
3. **(38) Nothing ships unwired.** Every new function, job, route, dependency or write needs a real call site and one
   real run: a test that actually imports it or hits the route. A dependency must be in the lockfile and the bundle.
4. **(35) One source for shared shapes.** Anything both the web app and the Mac app use (message schemas, safety
   rules, voice lines) has one source of truth, or a byte/fixture test against the other side. Never a hand copy.
5. **(35) One attacker test per route and permission.** Try it as another user, signed out, and with a forged or
   replayed id. One approval covers exactly one action.
6. **(34) Thresholds against real data.** When you change a heuristic or a threshold (clap detection, word lists,
   limits), report the old and new pass rate on real recorded data and on a held-out set.
7. **(32) Races.** For every state change, test a double fire, two at once, and the world changing between the check
   and the act. Name the guard: a unique index, `FOR UPDATE`, compare-and-set, or an idempotency key.
8. **(32) Every UI state.** Screenshots with 0, 1 and many items and the longest value, at phone size (390x844) and the
   Mac app window size. Include loading, empty and error. Look at them before you say done.
9. **(29) Tests must prove something.** Show the test failing on the old code. Test fakes replay real captured payloads,
   including repeats and delays, not only the happy path.
10. **(24) Global changes.** If you touch something shared (shell CSS, a header, a policy, a key, audio routing),
    prove one unrelated feature still works.

Reviews stop when a round finds only low-severity bugs. Every finding goes into the bug ledger with a pattern and an
area, so this list can be re-ranked as the numbers change.
