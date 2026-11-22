# window.hydraDesktop

Hydra Desktop's main window loads the Hydra web app. On Hydra's own origin (https://hydra-olive-one.vercel.app) the
app adds one object, so the web sidebar orb (Hydra PLAN U13) can mirror the native Hydra Agent. The page gets no other
access to the app: every Tauri command is refused from this window.

```ts
interface HydraDesktopState {
  state: 'Asleep' | 'Listening' | 'Thinking' | 'Speaking';
  micLevel: number;    // 0..1, the owner's microphone while he talks (0 otherwise)
  outputLevel: number; // 0..1, Hydra's voice while it speaks (0 otherwise)
  detached: boolean;   // version 2: true when the orb floats on the desktop instead of living in this window
}
interface HydraDesktop {
  version: 2;
  readonly state: HydraDesktopState['state'];
  readonly micLevel: number;
  readonly outputLevel: number;
  readonly detached: boolean; // version 2
  snapshot(): HydraDesktopState;
  subscribe(fn: (s: HydraDesktopState) => void): () => void; // called at once, then on every change (up to ~15 times a second)
  wake(): void;   // wake the agent (as a double clap does); it greets and listens
  sleep(): void;  // put it to sleep (as the sleep word does)
  detach(): void; // version 2: the orb leaves this window and floats on the desktop (docked bottom right)
  attach(): void; // version 2: the orb comes back into this window; none floats on the desktop
}
declare global { interface Window { hydraDesktop?: HydraDesktop } }
```

The same updates also fire as a `hydradesktop` event on `window` (`event.detail` is the state). Detect it with
`if (window.hydraDesktop)`; in a normal browser (the phone) it is absent.

## Attached and detached (version 2)

- **Attached** (the default, remembered across restarts): no orb floats on the desktop. The web app draws the orb in
  its sidebar from this state. Voice, the triggers (double clap, the key phrase), interrupting by talking and Mac
  control all keep working. While the Hydra window is hidden or minimised, the menu bar icon shows the state in one
  ink: asleep the rings are faint, thinking they are dashed, speaking they are bolder; listening is the plain mark.
  Drawings that point at things on the screen still use the transparent overlay.
- **Detached**: the desktop orb, docked bottom right (48 px by default), draggable, never following the cursor.
- Switch with `detach()` / `attach()`, the menu bar icon's menu (Detach Orb / Attach Orb), the panel's Agent page
  (Detached orb), or a right-click on the floating orb (Attach to Hydra). `detached` follows every switch.

## How it works

The overlay (`showcase/roamies/host.js`) sends the state to the shell (`orb_state`), which evaluates
`__hydraDesktopPush(state)` in the main window (`showcase/tauri/src-tauri/src/hydra.rs`), only while that window shows
Hydra's own origin. `wake()`, `sleep()`, `detach()` and `attach()` navigate to `hydra-desktop://<command>`, which the
window's navigation handler catches and cancels; it acts only while the window's top page is Hydra's own origin.
