# window.hydraDesktop

Hydra Desktop's main window loads the Hydra web app. On Hydra's own origin (https://hydra-olive-one.vercel.app) the
app adds one object, so the web sidebar orb (Hydra PLAN U13) can mirror the native Hydra Agent. The page gets no other
access to the app: every Tauri command is refused from this window.

```ts
interface HydraDesktopState {
  state: 'Asleep' | 'Listening' | 'Thinking' | 'Speaking';
  micLevel: number;    // 0..1, the owner's microphone while he talks (0 otherwise)
  outputLevel: number; // 0..1, Hydra's voice while it speaks (0 otherwise)
}
interface HydraDesktop {
  version: 1;
  readonly state: HydraDesktopState['state'];
  readonly micLevel: number;
  readonly outputLevel: number;
  snapshot(): HydraDesktopState;
  subscribe(fn: (s: HydraDesktopState) => void): () => void; // called at once, then on every change (up to ~15 times a second)
  wake(): void;  // wake the agent (as a double clap does); it greets and listens
  sleep(): void; // put it to sleep (as the sleep word does)
}
declare global { interface Window { hydraDesktop?: HydraDesktop } }
```

The same updates also fire as a `hydradesktop` event on `window` (`event.detail` is the state). Detect it with
`if (window.hydraDesktop)`; in a normal browser (the phone) it is absent.

How it works: the overlay (`showcase/roamies/host.js`) sends the state to the shell (`orb_state`), which evaluates
`__hydraDesktopPush(state)` in the main window (`showcase/tauri/src-tauri/src/hydra.rs`). `wake()` and `sleep()`
navigate to `hydra-desktop://wake` or `hydra-desktop://sleep`, which the window's navigation handler catches and
cancels.
