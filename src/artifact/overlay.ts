import { readFile } from "node:fs/promises";
import { z } from "zod";
import { capabilityArtifactSchema, targetSchema, type CapabilityArtifact } from "./schema.js";

export const tenantOverlaySchema = z.object({
  schema_version: z.literal("1.0"),
  capability: z.string(),
  tenant: z.string(),
  entry_url: z.string().url().optional(),
  step_targets: z.record(z.string(), targetSchema).optional(),
  extract_targets: z.record(z.string(), targetSchema).optional()
}).strict();

export type TenantOverlay = z.infer<typeof tenantOverlaySchema>;

export function applyOverlay(base: CapabilityArtifact, rawOverlay: TenantOverlay): CapabilityArtifact {
  const overlay = tenantOverlaySchema.parse(rawOverlay);
  if (overlay.capability !== base.capability.id) throw new Error(`Overlay ${overlay.tenant} targets ${overlay.capability}, not ${base.capability.id}.`);
  const steps = base.steps.map((step) => overlay.step_targets?.[step.id] ? { ...step, target: overlay.step_targets[step.id] } : step);
  const extract = base.extract.map((item) => overlay.extract_targets?.[item.output] ? { ...item, from: overlay.extract_targets[item.output] } : item);
  return capabilityArtifactSchema.parse({ ...base, entry: { ...base.entry, ...(overlay.entry_url ? { url: overlay.entry_url } : {}) }, steps, extract });
}

export async function loadOverlay(path: string): Promise<TenantOverlay> {
  return tenantOverlaySchema.parse(JSON.parse(await readFile(path, "utf8")));
}
