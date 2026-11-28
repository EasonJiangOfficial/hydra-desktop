import { z } from "zod";

/*
 * The phone view of the Mac ("Computer", RV plan section 5): every shape the phone, the web routes and Hydra Desktop
 * share. Plain JavaScript in a .ts file (zod only, no type syntax): Hydra Desktop copies it byte for byte to
 * sidecar/remoteschema.mjs and pins its SHA-256, as relay-schema.ts is pinned.
 *
 * Transport: WebRTC, peer to peer. The web app carries only the two SDP texts (no trickle ICE: each side waits at most
 * ICE_WAIT_MS and sends one SDP). The phone makes two data channels, both ordered and reliable:
 *   ctl: JSON text, one message per send, at most CTL_MAX bytes.
 *   scr: binary. A SCR_HEADER-byte header, then JPEG bytes (at most CHUNK_MAX per message):
 *        u8 ver=1, u8 geomGen, u16 flags, u32 frameId, u16 x, u16 y, u16 w, u16 h (big endian).
 *        flags: SCR_FLAGS. A frame has 1 to MAX_PATCHES patches; the phone acks a frame after its last patch is drawn.
 * Coordinates of input are 0 to 1 of the viewed display. Scroll dx, dy are display points the finger moved: the Mac
 * scrolls so the content follows the finger.
 */

export const REMOTE_VERSION = 1;
export const SCR_HEADER = 16;
export const SCR_FLAGS = { lastChunk: 1, lastPatch: 2, key: 4, refine: 8 };
export const CHUNK_MAX = 48000;
export const MAX_PATCHES = 12;
export const CTL_MAX = 16384;
export const TEXT_MAX = 200;
export const ICE_WAIT_MS = 2000;
/** The Mac beats every BEAT_S; no beat for SWEEP_S ends the session ("timeout"). */
export const BEAT_S = 20;
export const SWEEP_S = 60;
/** A money click's yes counts only within ASK_MS. */
export const ASK_MS = 30000;
/** Online: relay_seen_at within ONLINE_S. Phone View on: remote_seen_at within ONLINE_S. */
export const ONLINE_S = 45;
export const OPENS_PER_MINUTE = 10;

export const END_REASONS = ["phone", "mac", "idle", "hidden", "replaced", "timeout", "limit", "error", "revoked"];
export const endReasonSchema = z.enum(END_REASONS);
export const STATUSES = ["requested", "answered", "live", "ended"];
export const statusSchema = z.enum(STATUSES);
export const REFUSED = ["secret", "credential", "card", "locked", "agent", "changed", "partial", "unknown"];

const uuid = z.string().uuid();
const sdp = z.string().min(1).max(20000);
const count = z.number().int().min(0).max(1e12);
const unit = z.number().min(0).max(1);
const px = z.number().int().min(0).max(65535);
const rect = z.tuple([px, px, px, px]);

/** What the Mac reports in each beat and at the end. Counts only, never typed text (the Activity summary reads them). */
export const statsSchema = z
  .object({
    clicks: count.optional(),
    chars: count.optional(),
    keys: count.optional(),
    scrolls: count.optional(),
    refused: count.optional(),
    asks: count.optional(),
    frames: count.optional(),
    bytes: count.optional(),
    fps: z.number().min(0).max(240).optional(),
    rttMs: z.number().min(0).max(60000).optional(),
    path: z.enum(["direct", "relay"]).optional(),
  })
  .strict()
  .refine((s) => JSON.stringify(s).length <= 2000);

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/** POST /api/agent/remote (owner session): open a view of one Mac with the phone's offer. */
export const openBodySchema = z.object({ deviceId: uuid, sdp }).strict();

/** POST /api/agent/remote/mac (the Mac's device key). */
export const macPostSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("answer"), sessionId: uuid, sdp }).strict(),
  z.object({ op: z.literal("beat"), sessionId: uuid, live: z.boolean(), stats: statsSchema.optional() }).strict(),
  z.object({ op: z.literal("end"), sessionId: uuid, reason: endReasonSchema, stats: statsSchema.optional() }).strict(),
]);

export const iceServerSchema = z.object({
  urls: z.union([z.string(), z.array(z.string())]),
  username: z.string().optional(),
  credential: z.string().optional(),
});

/** GET /api/agent/remote/mac answer: the waiting request. */
export const macSessionSchema = z.object({ session: z.object({ id: uuid, sdp, iceServers: z.array(iceServerSchema) }) });

// ---------------------------------------------------------------------------
// ctl, Mac to phone
// ---------------------------------------------------------------------------

const display = z.object({ id: z.number().int(), name: z.string().max(120), w: px, h: px, main: z.boolean() });
const agentState = { busy: z.boolean(), paused: z.boolean() };

export const macMessageSchema = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("hello"),
    v: z.literal(REMOTE_VERSION),
    mac: z.object({ name: z.string().max(120) }),
    displays: z.array(display).min(1).max(16),
    display: z.number().int(),
    locked: z.boolean(),
    agent: z.object(agentState),
  }),
  z.object({ t: z.literal("geom"), gen: z.number().int().min(0).max(255), display: z.number().int(), w: px, h: px }),
  z.object({ t: z.literal("shield"), rects: z.array(rect).max(64) }),
  z.object({ t: z.literal("focus"), rect: rect.nullable(), secure: z.boolean() }),
  z.object({
    t: z.literal("agent"),
    ...agentState,
    // true once Take over is done: the running helper call ended and the owner's input is accepted. Until then the
    // phone shows "Taking over" (the gate closes at once, the running call does not stop).
    control: z.boolean().optional(),
    caption: z.string().max(200).optional(),
    step: z.object({ rect, kind: z.string().max(32), display: z.number().int() }).optional(),
  }),
  z.object({ t: z.literal("ask"), id: z.string().min(1).max(64), label: z.string().max(200), app: z.string().max(120), why: z.literal("money") }),
  z.object({ t: z.literal("refused"), n: count, why: z.enum(REFUSED) }),
  // The Mac locked or unlocked during the session (hello carries the state at the start).
  z.object({ t: z.literal("locked"), locked: z.boolean() }),
  // at: the Mac clock (epoch ms) when it answered the ping, for the clock offset.
  z.object({ t: z.literal("pong"), id: z.number().int(), at: z.number() }),
  // "Still there?": no touch and no agent turn for 5 min. The session ends ms later unless the phone answers "here".
  z.object({ t: z.literal("idle"), ms: z.number().int().min(0).max(600000) }),
  z.object({ t: z.literal("bye"), reason: endReasonSchema }),
]);

// ---------------------------------------------------------------------------
// ctl, phone to Mac
// ---------------------------------------------------------------------------

const n = count;
export const phoneMessageSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("hello"), v: z.literal(REMOTE_VERSION), w: px, h: px, dpr: z.number().min(0.5).max(5) }),
  z.object({ t: z.literal("ack"), f: count, ms: z.number().min(0).max(60000) }),
  z.object({ t: z.literal("pause") }),
  z.object({ t: z.literal("resume") }),
  z.object({ t: z.literal("display"), id: z.number().int() }),
  z.object({ t: z.literal("click"), n, x: unit, y: unit, b: z.enum(["l", "r"]), c: z.union([z.literal(1), z.literal(2)]) }),
  z.object({ t: z.literal("down"), n, x: unit, y: unit }),
  z.object({ t: z.literal("move"), n, x: unit, y: unit }),
  z.object({ t: z.literal("up"), n, x: unit, y: unit }),
  z.object({ t: z.literal("scroll"), n, x: unit, y: unit, dx: z.number().min(-20000).max(20000), dy: z.number().min(-20000).max(20000) }),
  // One key with all its modifiers ("cmd+shift+z", "return"). The Mac holds no modifier state.
  z.object({ t: z.literal("key"), n, k: z.string().min(1).max(40).regex(/^((cmd|opt|ctrl|shift)\+)*[a-z0-9]+$|^((cmd|opt|ctrl|shift)\+)*.$/) }),
  z.object({ t: z.literal("text"), n, s: z.string().min(1).max(TEXT_MAX) }),
  z.object({ t: z.literal("answer"), id: z.string().min(1).max(64), yes: z.boolean() }),
  z.object({ t: z.literal("takeover") }),
  z.object({ t: z.literal("handback") }),
  z.object({ t: z.literal("stop") }),
  z.object({ t: z.literal("ping"), id: z.number().int() }),
  // The answer to "Still there?": a touch for the idle timer, nothing on the screen.
  z.object({ t: z.literal("here") }),
  z.object({ t: z.literal("bye") }),
]);
