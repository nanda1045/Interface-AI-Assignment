// Request-body contracts for the adaptation API. Every body is parsed here
// before any capability is resolved or a browser is launched, so a malformed or
// surprising request is rejected at the door with a clear message rather than
// deep inside the runner.
import { z } from "zod";

// A run id appears in URLs and is joined onto the evidence root. Constraining it
// to this alphabet is the first, cheapest defence against path traversal - a
// value with a slash or a dot-segment never reaches path.join.
export const runIdSchema = z.string().regex(/^[A-Za-z0-9_]+$/, "A run id is letters, digits and underscores only.");

// An evidence file name: a single path segment, no separators or dot-segments.
export const evidenceFileSchema = z.string().regex(/^[A-Za-z0-9_.-]+$/, "An evidence file is a single path segment.").refine((value) => value !== "." && value !== "..", "An evidence file cannot be a dot-segment.");

// POST /api/runs. `.strict()` rejects any envelope field we do not know, so a
// caller cannot smuggle an unexpected control field past validation. Per-input
// TYPE checking happens later against the capability's own declared contract,
// because that contract is dynamic; here inputs is only shape-checked.
export const runRequestSchema = z
  .object({
    // A capability name or an explicit id@version. Drafts are never resolvable
    // through the store, so a caller can only ever run approved work.
    capability: z.string().min(1),
    inputs: z.record(z.string(), z.unknown()).default({}),
    // A named credential set from the app profile (e.g. "teller", "supervisor").
    auth: z.string().min(1).optional(),
    // Ordinary mutations need this explicit acknowledgement in the envelope,
    // deliberately OUTSIDE the capability inputs a model controls.
    confirm_mutation: z.boolean().optional(),
    // Demo-only fault to force on the entry page; validated against the app
    // profile's allow-list by the runner, and only honoured in demo mode.
    fault_injection: z.string().min(1).optional(),
    // A duplicate request carrying the same key maps to the same run instead of
    // launching a second one - so a retried transfer never posts twice.
    idempotency_key: z.string().min(1).max(200).optional()
  })
  .strict();

export type RunRequest = z.infer<typeof runRequestSchema>;

// POST /api/interventions/:id/take
export const takeControlSchema = z.object({ operator: z.string().min(1) }).strict();

// POST /api/chat. A message, and an optional confirmation the user gives before
// a data-changing capability runs - deliberately its own envelope field, never
// something the model can set.
export const chatRequestSchema = z
  .object({
    message: z.string().min(1).max(2000),
    confirm: z.boolean().optional()
  })
  .strict();

export type ChatRequest = z.infer<typeof chatRequestSchema>;
