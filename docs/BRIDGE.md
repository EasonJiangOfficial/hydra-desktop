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
  bands?: number[];    // version 3, added (W5): 24 values 0..1, Hydra's voice while it speaks, the mic while a take
                       // listens, at most 30 a second; all 0 when it stops. Absent from an older app.
  woke?: { at: number; from: 'clap' | 'phrase' }; // build 4, added: Hydra just woke to a double clap or the key phrase
                       // (at: Date.now() on the Mac). The snapshot keeps the last one, so play the wake burst once per
                       // new `at` (and skip one older than ~10 s on the first snapshot). Never sent for a web, orb or
                       // panel wake. Absent from an older app.
}
interface HydraDesktop {
  version: 3;
  readonly state: HydraDesktopState['state'];
  readonly micLevel: number;
  readonly outputLevel: number;
  readonly detached: boolean;
  snapshot(): HydraDesktopState;
  subscribe(fn: (s: HydraDesktopState) => void): () => void; // called at once, then on every change
  wake(): void; sleep(): void; attach(): void;
  detach(drag?: { x: number; y: number; dragging: true }): void; // build 4, added: drag (the pointer's screen point, in
                       // points, from a press-and-drag on the web orb past ~6 px) brings the desktop orb out under the
                       // cursor; it rides the cursor until the button is let go. An older app ignores drag (plain detach).
  listen?(): void;     // build 4, added: an orb tap. Asleep it wakes Hydra (which listens at once); during a take it sends
                       // what was heard (like a second tap on a mic button; Esc still drops a take); otherwise it opens
                       // one, with the listen chime. Absent from an older app (keep sleep()).
  stop(): void; pause(): void; resume(): void; setMuted(muted: boolean): void; // version 3: the card's buttons
  setup(): Promise<{ paired: boolean; claude: 'signed_in' | 'signed_out'; permissions: { mic: Perm; accessibility: Perm; screen: Perm }; version: string }>;
  pair(code: string): Promise<{ ok: true } | { ok: false; error: string }>; // the one-time code from POST /api/agent/devices/pair
  signInClaude(): Promise<{ ok: true } | { ok: false; error: string }>;
  requestPermission(kind: 'mic' | 'accessibility' | 'screen'): Promise<Perm>; // the prompt or Settings; the new state (2 min max)
  unpair(): Promise<void>; // forgets the device key here (the web revokes it on the server, after asking)
  refreshSettings?(): void; // version 3, added (W5): the agent settings changed (PATCH /api/agent/state); the Mac reads
                            // them again now instead of at its next 60 s read
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
- Drag to detach (build 4): `detach({ x, y, dragging: true })` sends `hydra-desktop://detach?drag=1&x=<x>&y=<y>`
  (whole points; a missing or non-finite point is a plain detach). The desktop orb appears under the cursor on the
  cursor's screen and follows it; the shell watches the left button and, when it is let go, the orb settles there and
  that spot is its new dock. Let go over the Hydra window (anywhere on it while it shows), it re-attaches. A click on
  the floating orb (moved less than 6 px) still acts: asleep it wakes Hydra, awake it is `listen()`.

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

## Voice (W5 voice contract)

- Settings: the Mac reads `GET /api/agent/state` (device key) at start, when `refreshSettings()` is called and every
  60 s: the wake phrase and sleep word go to the voice helper; the model and effort run its local voice turns and the
  turns relayed from the web, the phone and routines (effort_routine for a routine, effort_live otherwise).
- Wake: the phrase wakes it from sleep too, and its take goes on at once; after every spoken answer a follow-up window
  (about 8 s) listens without the phrase. The pill beside the cursor shows only for a take from the talk keys.
- Build 4: every wake listens at once, with no spoken greeting: a double clap, an orb tap, `wake()`, the panel or the
  menu bar plays the wake chime and opens a take within about 300 ms (it hears nothing for 8 s: Hydra stays awake and
  idle, no error). The phrase's own take opens with the listen chime. Chimes play in the Mac's voice helper, so
  mute-while-listening never silences them: the listen chime only for a take the owner started (clap, phrase, talk
  keys, an orb tap), never for an auto-listen follow-up, an area snap or barge-in. Nothing else makes a sound unless
  the owner caused it (heard, the sleep word, the end of his own tool turn, the sound switch, the pen snap).
- Build 4: while a spoken turn works (thinking or running tools) a soft pending sound loops (2.4 s, quiet), fading in
  after 0.6 s, ducking under the progress lines and fading out in 150 ms when the answer starts, an ask is said, the
  owner talks or the turn ends. The desktop orb then shows its pending look (a calm band orbiting on that pulse);
  listening it leans in and ripples with the owner's voice; talking it pushes out on Hydra's syllables. The web orb
  gets the same `state` values as before (Listening, Thinking, Speaking, Asleep).
- While Hydra works on a turn, every take (the phrase, a double clap, the talk keys, talking over it) adds its words to
  the running turn; its voice holds while the owner talks and goes on after, and a take that hears nothing leaves the
  turn as it was. Only Stop and sleep end a turn; while one runs, the sleep word needs its exact words. Talking over
  Hydra after the turn, while it still speaks, stops the voice at once; the next turn knows what was heard.
- A spoken turn says an opener at about 1.1 s, then a progress line each time about 5.5 s pass with nothing new (never
  the same twice in a row, never over the owner, an ask or the answer). The lines, which the web's `words.ts` keeps
  too: `Checking it now.`, `Looking at it now.`, `Almost there.`, `Still on it.`, `One more second.`,
  `Still checking.`, `Nearly there.`, `Still working on it.` (sidecar `speaker.mjs` PROGRESS).
- An Allow ask in a spoken turn is said aloud ("Can I open ui.elevenlabs.io? Say yes or no."); a clear spoken yes or no
  answers it. After 60 s with no answer Hydra says "I didn't hear a yes, so I skipped opening it." and the tool gets a
  no. A turn that ends without an answer says why in one short line, on screen always and aloud in a spoken turn.
- Hydra's voice on the Mac is Fish through `/api/voice/tts` (device key), played by the voice helper in the same
  voice-processing engine as the mic (the echo canceller's reference), with other audio never ducked and never muted
  by mute-while-listening.
- `reply.text` is only the final answer (words before a tool are left out), without emote tags like `[wave]`.

`wake` is additive: `state` keeps its four values, so a page that reads only `state` works as before. A page that
knows `wake` shows the idle Mac as waiting for the key phrase (Say "Hey Hydra") instead of listening.
