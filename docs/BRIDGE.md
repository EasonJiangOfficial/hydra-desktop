# window.hydraDesktop

Hydra Desktop's main window loads the Hydra web app. On Hydra's own origin (https://hydra-olive-one.vercel.app) the
app adds one object, so the web sidebar orb (Hydra PLAN U13) can mirror and drive the native Hydra Agent, and the window's Set up this Mac
screen can pair the Mac, sign in with Claude and ask for macOS permissions (version 3, W3 bridge v3). The page gets no other
access to the app: every Tauri command is refused from this window.

```ts
type Perm = 'granted' | 'denied' | 'not_determined';
type UiAction = { kind: 'navigate'; href: string } | { kind: 'openPanel'; param: string; value: string }
  | { kind: 'setScope'; scope: 'all' | 'personal' | 'ugc' } | { kind: 'highlight'; selector: string };
interface HydraDesktopState {
  state: 'Asleep' | 'Listening' | 'Thinking' | 'Speaking';
  wake: 'phrase' | 'off'; // version 3, added: 'phrase' while awake and idle, when only the key phrase listens (say
                          // "Hey Hydra" first; nothing else is answered); 'off' otherwise. A real take is
                          // state 'Listening' with wake 'off'. Absent from an older app: treat as 'off'.
  micLevel: number;    // 0..1, the owner's microphone while he talks (0 otherwise)
  outputLevel: number; // 0..1, Hydra's voice while it speaks (0 otherwise)
  detached: boolean;   // version 2: true when the orb floats on the desktop instead of living in this window
  muted: boolean;      // version 3: Hydra's voice is silent (replies still stream as text)
  paused: boolean;     // version 3: the voice holds where it is
  reply: { id: string; text: string; final: boolean } | null; // version 3: the reply being written and spoken (null once the owner talks again)
  heard: { text: string; final: boolean } | null;              // version 3: the owner's words as recognised
  ui: (UiAction & { at: number }) | null;                       // version 3: the Mac agent moves the window (check isSafePath)
}
interface HydraDesktop {
  version: 3;
  readonly state: HydraDesktopState['state'];
  readonly micLevel: number;
  readonly outputLevel: number;
  readonly detached: boolean;
  snapshot(): HydraDesktopState;
  subscribe(fn: (s: HydraDesktopState) => void): () => void; // called at once, then on every change
  wake(): void; sleep(): void; detach(): void; attach(): void;
  stop(): void; pause(): void; resume(): void; setMuted(muted: boolean): void; // version 3: the card's buttons
  setup(): Promise<{ paired: boolean; claude: 'signed_in' | 'signed_out'; permissions: { mic: Perm; accessibility: Perm; screen: Perm }; version: string }>;
  pair(code: string): Promise<{ ok: true } | { ok: false; error: string }>; // the one-time code from POST /api/agent/devices/pair
  signInClaude(): Promise<{ ok: true } | { ok: false; error: string }>;
  requestPermission(kind: 'mic' | 'accessibility' | 'screen'): Promise<Perm>; // the prompt or Settings; the new state (2 min max)
  unpair(): Promise<void>; // forgets the device key here (the web revokes it on the server, after asking)
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

Version 3: every call is still a top-level `location.href` navigation to `hydra-desktop://` (CSP doesn't govern
those; Hydra's `frame-src` would block a frame, so never add the scheme to any CSP). The calls go through a queue,
one at a time: the next only once the navigation handler has caught the last (it pushes `{ ack: id }`), or after
500 ms, so calls made one after another never replace each other. Every call carries the
per-launch token and a request id (`id=<n>`, starting at a random point on each page load); the answer comes back as `__hydraDesktopPush({ res: { id, result } })`, which resolves
that call and is not merged into the state. `setup` and `requestPermission` are answered by the shell (permissions)
and the sidecar (pairing, Claude); `pair`, `signInClaude` and `unpair` by the sidecar. The pairing code is letters,
digits and dashes (6 to 20); the device key it is traded for goes to the Keychain only and never to the page.

`wake` is additive: `state` keeps its four values, so a page that reads only `state` works as before. A page that
knows `wake` shows the idle Mac as waiting for the key phrase (Say "Hey Hydra") instead of listening.
