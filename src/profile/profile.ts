// The application profile is the adaptation seam: everything this system knows
// about one target application that is not part of a recorded capability.
// Detector signatures, sign-on shape, credential sources and authoring
// templates live here as validated data, so pointing the core at a new target
// is a profile file rather than an engine change. Profiles are selected by the
// artifact's own app id - never by an API argument that could choose weaker
// detection than the capability was recorded against.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { predicateSchema, targetSchema } from "../artifact/schema.js";

const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

// Patterns are regular expressions matched case-insensitively against digest
// text, mirroring how artifact predicates already behave.
const detectorSignaturesSchema = strict({
  session_lost: strict({
    // Some applications bounce to a sign-on route; others (MERIDIAN) render an
    // inline timed-out page on the same URL, so both signals are needed.
    paths: z.array(z.string()),
    patterns: z.array(z.string())
  }),
  app_error: strict({ patterns: z.array(z.string()).min(1) }),
  escalation: strict({ patterns: z.array(z.string()) })
});

const outcomeTemplateSchema = strict({
  code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  when: z.array(predicateSchema).min(1),
  returns: z.record(z.string(), z.unknown()).optional()
});

const recoveryTemplateSchema = strict({
  id: z.string(),
  condition: predicateSchema,
  action: strict({ kind: z.literal("click"), target: targetSchema }),
  max_attempts: z.number().int().positive(),
  effect: z.enum(["continue", "retry_current_step", "restart_capability"]).optional()
});

export const appProfileSchema = strict({
  app: strict({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    vendor: z.string(),
    ui_version_range: z.string(),
    origin: z.string().url()
  }),
  policy: z.string(),
  // Absent for targets that have no interactive sign-on we may drive (the
  // CorePoint mock uses a training-session cookie instead).
  signon: strict({
    url: z.string().url(),
    fields: strict({
      operator: z.string(),
      password: z.string(),
      branch: z.string().optional()
    }),
    authenticated_pattern: z.string(),
    failure_pattern: z.string()
  }).optional(),
  // Named credential sets resolve to environment variables at run time, so a
  // password can never appear in a profile, an artifact, or a CLI argument.
  credentials: z.record(z.string(), strict({
    operator_env: z.string(),
    password_env: z.string(),
    branch_env: z.string().optional()
  })).optional(),
  // Button/link names whose activation is irreversible on this application.
  // The generic risk heuristic cannot know that "Post Transfer" moves money;
  // the profile can, and discovery uses this to stop the model and record a
  // human_required boundary instead of executing the action.
  irreversible_actions: z.array(z.string()).optional(),
  detectors: detectorSignaturesSchema,
  outcome_templates: z.array(outcomeTemplateSchema),
  recovery_templates: z.array(recoveryTemplateSchema)
});

export type AppProfile = z.infer<typeof appProfileSchema>;
export type DetectorSignatures = z.infer<typeof detectorSignaturesSchema>;

export interface ResolvedCredentials {
  operator: string;
  password: string;
  branch?: string;
}

export async function loadProfile(filePath: string): Promise<AppProfile> {
  return appProfileSchema.parse(YAML.parse(await readFile(filePath, "utf8")));
}

/** Find the profile owning an app id. Returns undefined when no profile claims
 *  it, which callers treat as "no profile-driven behaviour" rather than an
 *  error, so artifacts for unprofiled targets keep replaying with defaults. */
export async function profileForApp(appId: string, root = "profiles"): Promise<AppProfile | undefined> {
  let files: string[];
  try {
    files = (await readdir(root)).filter((file) => file.endsWith(".yaml") || file.endsWith(".yml"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  for (const file of files.sort()) {
    const profile = await loadProfile(path.join(root, file));
    if (profile.app.id === appId) return profile;
  }
  return undefined;
}

/** Discovery selects a profile by where it is pointed, before any artifact
 *  exists to carry an app id. */
export async function profileForOrigin(origin: string, root = "profiles"): Promise<AppProfile | undefined> {
  let files: string[];
  try {
    files = (await readdir(root)).filter((file) => file.endsWith(".yaml") || file.endsWith(".yml"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  for (const file of files.sort()) {
    const profile = await loadProfile(path.join(root, file));
    if (profile.app.origin === origin) return profile;
  }
  return undefined;
}

/** Resolve a named credential set from the environment. Throws with the names
 *  of the missing variables and never echoes any value. */
export function resolveCredentials(profile: AppProfile, name: string, env: NodeJS.ProcessEnv = process.env): ResolvedCredentials {
  const source = profile.credentials?.[name];
  if (!source) {
    const known = Object.keys(profile.credentials ?? {});
    throw new Error(`Profile ${profile.app.id} has no credential set named "${name}". Available: ${known.length > 0 ? known.join(", ") : "none"}`);
  }
  const operator = env[source.operator_env];
  const password = env[source.password_env];
  const missing = [
    ...(operator ? [] : [source.operator_env]),
    ...(password ? [] : [source.password_env])
  ];
  if (missing.length > 0) throw new Error(`Credential set "${name}" needs environment variables: ${missing.join(", ")}`);
  const branch = source.branch_env ? env[source.branch_env] : undefined;
  return { operator: operator!, password: password!, ...(branch ? { branch } : {}) };
}
