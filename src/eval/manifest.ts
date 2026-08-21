// The eval sweep's manifest: a small, reviewed set of SAFE invocations for the
// read-only capabilities. Parameters live in config, not code, because the safe
// inputs are target-specific (which seed members exist) and must never be baked
// into the harness. Expected output values are deliberately NOT stored here - the
// sweep judges status and locator health, so no member data ever enters the repo.
import { readFile } from "node:fs/promises";
import YAML from "yaml";
import { z } from "zod";

export const evalManifestSchema = z.object({
  // Named credential set from the app profile used to sign on for the sweep.
  auth: z.string().optional(),
  // capability id -> a safe invocation (all string parameters).
  cases: z.record(z.string(), z.record(z.string(), z.string()))
}).strict();

export type EvalManifest = z.infer<typeof evalManifestSchema>;

export async function loadEvalManifest(path: string): Promise<EvalManifest> {
  return evalManifestSchema.parse(YAML.parse(await readFile(path, "utf8")));
}
