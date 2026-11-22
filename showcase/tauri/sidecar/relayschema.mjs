import { z } from "zod";

/**
 * The relay wire contract (W3 contract and its fixes, 2026-11-22): the ONE source of every shape and
 * limit the Mac posts. The server validates with these; Hydra Desktop copies this file verbatim into
 * its tests (and its event validation), so a shape mismatch fails a test on both sides.
 * Keep it plain JavaScript inside a .ts file (only `zod`, no type syntax) so it runs as .mjs too.
 */

export const LIMITS = Object.freeze({
  textDelta: 8000,
  toolName: 64,
  toolSummary: 500,
  confirmSummary: 500,
  errorMessage: 1000,
  errorCode: 64,
  panelValue: 100,
  selector: 200,
  href: 500,
  batch: 500,
});

/** The URL params the shared kit DetailDrawer reads (DESIGN.md section 7). */
export const panelParamSchema = z.enum(["tx", "day", "account", "task", "goal", "deal", "category", "routine", "taxline"]);
export const PANEL_PARAMS = panelParamSchema.options;
export const scopeSchema = z.enum(["all", "personal", "ugc"]);
export const SCOPES = scopeSchema.options;

/** A path inside Hydra: one leading slash, no host, no whitespace, backslash or control character. */
export const internalHref = z
  .string()
  .max(LIMITS.href)
  .regex(/^\/(?![/\\])[^\\\s\x00-\x1f\x7f]*$/, "A path inside Hydra, like /transactions?tx=...");

export const uiActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("navigate"), href: internalHref }).strict(),
  z
    .object({ kind: z.literal("openPanel"), param: panelParamSchema, value: z.string().min(1).max(LIMITS.panelValue).regex(/^[\w-]+$/) })
    .strict(),
  z.object({ kind: z.literal("setScope"), scope: scopeSchema }).strict(),
  z.object({ kind: z.literal("highlight"), selector: z.string().min(1).max(LIMITS.selector) }).strict(),
]);

/** Usage is optional and lenient: snake_case counts are kept, anything else (other keys, bad values) is dropped. */
const count = z.number().int().min(0).optional().catch(undefined);
export const usageSchema = z.preprocess(
  (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : undefined),
  z.object({ input_tokens: count, output_tokens: count, cache_read_input_tokens: count, cache_creation_input_tokens: count }).optional(),
);

/** The events a Mac may post: the SSE contract minus `thread` (the server owns threads). */
export const relayEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), delta: z.string().max(LIMITS.textDelta) }).strict(),
  z
    .object({
      type: z.literal("tool"),
      name: z.string().min(1).max(LIMITS.toolName),
      status: z.enum(["start", "done", "error"]),
      summary: z.string().max(LIMITS.toolSummary),
    })
    .strict(),
  z.object({ type: z.literal("ui"), action: uiActionSchema }).strict(),
  z.object({ type: z.literal("confirm"), id: z.uuid(), summary: z.string().min(1).max(LIMITS.confirmSummary), danger: z.boolean() }).strict(),
  z.object({ type: z.literal("done"), usage: usageSchema }).strict(),
  z.object({ type: z.literal("error"), message: z.string().min(1).max(LIMITS.errorMessage), code: z.string().max(LIMITS.errorCode).optional() }).strict(),
]);

/**
 * POST /api/agent/relay/events body. claimId: the claim /relay/next handed out (409 stale_claim once
 * it is not the turn's current claim). seq (optional): this claim's number of the batch's first event
 * (1, 2, ...), so a retried post is stored once. events: at most 500; done or error only last;
 * an empty list is the heartbeat that renews the 60 s lease.
 */
export const relayBatchSchema = z
  .object({ turnId: z.uuid(), claimId: z.uuid(), seq: z.number().int().min(1).optional(), events: z.array(relayEventSchema).max(LIMITS.batch) })
  .refine((b) => b.events.every((e, i) => (e.type !== "done" && e.type !== "error") || i === b.events.length - 1), { message: "done or error must be the last event" });

/** POST /api/agent/relay/approval body: an ask the Mac would show locally becomes the owner's approval. */
export const relayApprovalSchema = z
  .object({ turnId: z.uuid(), claimId: z.uuid(), summary: z.string().trim().min(1).max(LIMITS.confirmSummary), danger: z.boolean() });

/** GET /api/agent/relay/next?slot=: the Mac serves one live turn and one routine turn at a time. */
export const slotSchema = z.enum(["live", "routine"]);
