// Validated filesystem store for versioned capability artifacts. Normal saving is
// create-only; approval records reviewer and successful validation provenance.
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fingerprintParams } from "./distill.js";
import { capabilityArtifactSchema, type CapabilityArtifact } from "./schema.js";

// Evidence produced by the CLI's real validation replay and persisted on approval.
export interface ApprovalEvidence {
  run: string;
  params: Record<string, string>;
  matchedTiers: Record<string, number>;
}

export interface ResolveOptions {
  /** Approval is the act that reviews a draft, so it alone must be able to
   *  resolve one by range. Every other caller naming a capability gets a
   *  reviewed version or an error. */
  includeDrafts?: boolean;
}

export interface ResolvedReference {
  id: string;
  version: string;
  /** The concrete `id@version` actually selected, worth reporting back to a
   *  caller that asked for a range so the run record says what it ran. */
  reference: string;
}

type VersionParts = [number, number, number];

function parseVersion(version: string): VersionParts | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function compareVersions(left: VersionParts, right: VersionParts): number {
  return left.reduce((order, part, index) => order || part - right[index]!, 0);
}

// A bare id matches every version; `1` and `1.x` pin the major; `1.2` and `1.2.x`
// pin major and minor. A fully specified version never reaches here - it is an
// exact reference and is resolved without consulting the range rules.
function matchesRange(version: VersionParts, spec: string | undefined): boolean {
  if (!spec) return true;
  const wanted = spec.split(".").filter((part) => part !== "x" && part !== "*");
  return wanted.every((part, index) => Number(part) === version[index]);
}

export class ArtifactStore {
  public constructor(private readonly root = "artifacts") {}

  public pathFor(id: string, version: string): string {
    return path.resolve(this.root, `${id}@${version}.json`);
  }

  // Default immutable write: `wx` fails when that exact version already exists.
  public async save(artifact: CapabilityArtifact): Promise<string> {
    const validated = capabilityArtifactSchema.parse(artifact);
    await mkdir(this.root, { recursive: true });
    const destination = this.pathFor(validated.capability.id, validated.capability.version);
    await writeFile(destination, `${JSON.stringify(validated, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return destination;
  }

  // Explicit replacement path used for approval metadata and intentional overwrite.
  public async write(artifact: CapabilityArtifact): Promise<string> {
    const validated = capabilityArtifactSchema.parse(artifact);
    await mkdir(this.root, { recursive: true });
    const destination = this.pathFor(validated.capability.id, validated.capability.version);
    await writeFile(destination, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
    return destination;
  }

  /** The newest approved version of every capability, and nothing else.
   *
   *  A draft is invisible here for the same reason a bare name will not resolve
   *  to one: anything reading this list is choosing what to run, and that choice
   *  must be limited to capabilities a human signed off. */
  public async approved(): Promise<CapabilityArtifact[]> {
    const found: CapabilityArtifact[] = [];
    for (const id of await this.capabilityIds()) {
      for (const candidate of await this.versionsOf(id)) {
        const artifact = await this.readExact(id, candidate.version);
        if (artifact.capability.status === "approved") {
          found.push(artifact);
          break;
        }
      }
    }
    return found;
  }

  /** Every draft version across all capabilities. This is for review surfaces
   *  (the dashboard's proposed-repairs panel) - it is explicitly NOT a way to
   *  choose what to run, which stays limited to approved() and exact pins. */
  public async drafts(): Promise<CapabilityArtifact[]> {
    const found: CapabilityArtifact[] = [];
    for (const id of await this.capabilityIds()) {
      for (const candidate of await this.versionsOf(id)) {
        const artifact = await this.readExact(id, candidate.version);
        if (artifact.capability.status === "draft") found.push(artifact);
      }
    }
    return found;
  }

  // Distinct capability names, which is what someone naming one without a
  // version needs to see when they get it wrong.
  public async capabilityIds(): Promise<string[]> {
    const ids = (await this.list()).flatMap((file) => {
      const separator = file.lastIndexOf("@");
      return separator > 0 ? [file.slice(0, separator)] : [];
    });
    return [...new Set(ids)].sort();
  }

  // Every version of one capability, newest first.
  public async versionsOf(id: string): Promise<{ version: string; parts: VersionParts }[]> {
    const prefix = `${id}@`;
    return (await this.list())
      .filter((file) => file.startsWith(prefix))
      .map((file) => file.slice(prefix.length, -".json".length))
      .flatMap((version) => {
        const parts = parseVersion(version);
        return parts ? [{ version, parts }] : [];
      })
      .sort((left, right) => compareVersions(right.parts, left.parts));
  }

  /** Turn a reference into the concrete version it names.
   *
   *  `id@1.2.3` is exact and resolves to that file whatever its status - you
   *  have to be able to replay the draft you just recorded. A bare `id`, or a
   *  range like `id@1` or `id@1.2.x`, resolves to the newest **approved**
   *  match, so a caller that asks for a capability by name can never be handed
   *  something nobody reviewed. */
  public async resolve(reference: string, options: ResolveOptions = {}): Promise<ResolvedReference> {
    const separator = reference.lastIndexOf("@");
    const id = separator > 0 ? reference.slice(0, separator) : reference;
    const spec = separator > 0 ? reference.slice(separator + 1) : undefined;
    const versions = await this.versionsOf(id);

    if (spec && parseVersion(spec)) {
      if (!versions.some((candidate) => candidate.version === spec)) {
        throw new Error(`No capability ${id}@${spec} in ${this.root}. ${this.describeVersions(id, versions)}`);
      }
      return { id, version: spec, reference: `${id}@${spec}` };
    }

    if (versions.length === 0) {
      const known = await this.capabilityIds();
      throw new Error(`No capability named ${id} in ${this.root}. Available: ${known.length > 0 ? known.join(", ") : "none"}`);
    }
    const matching = versions.filter((candidate) => matchesRange(candidate.parts, spec));
    if (matching.length === 0) {
      throw new Error(`No version of ${id} matching ${spec}. ${this.describeVersions(id, versions)}`);
    }
    for (const candidate of matching) {
      if (options.includeDrafts) return { id, version: candidate.version, reference: `${id}@${candidate.version}` };
      const artifact = await this.readExact(id, candidate.version);
      if (artifact.capability.status === "approved") {
        return { id, version: candidate.version, reference: `${id}@${candidate.version}` };
      }
    }
    // Naming a capability is a request for something reviewed, so an unapproved
    // match is refused rather than silently run.
    throw new Error(
      `No approved version of ${id}${spec ? ` matching ${spec}` : ""}. Present: ${matching.map((candidate) => candidate.version).join(", ")}. ` +
      `Approve one, or pin an exact version to run a draft deliberately.`
    );
  }

  // Every artifact is schema-validated again when read from disk.
  public async load(reference: string, options: ResolveOptions = {}): Promise<CapabilityArtifact> {
    if (reference.endsWith(".json")) return this.readFileAt(path.resolve(this.root, reference), reference);
    const resolved = await this.resolve(reference, options);
    return this.readExact(resolved.id, resolved.version);
  }

  private describeVersions(id: string, versions: { version: string }[]): string {
    return versions.length > 0
      ? `Versions of ${id}: ${versions.map((candidate) => candidate.version).join(", ")}.`
      : `No versions of ${id} are present.`;
  }

  private readExact(id: string, version: string): Promise<CapabilityArtifact> {
    return this.readFileAt(this.pathFor(id, version), `${id}@${version}`);
  }

  private async readFileAt(location: string, describe: string): Promise<CapabilityArtifact> {
    let contents: string;
    try {
      contents = await readFile(location, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const known = await this.list();
      throw new Error(`No capability ${describe} in ${this.root}. Available: ${known.length > 0 ? known.join(", ") : "none"}`);
    }
    return capabilityArtifactSchema.parse(JSON.parse(contents));
  }

  // Turn a validated draft into an approved artifact while enforcing a different
  // reviewer identity and a non-identical invocation fingerprint.
  public async approve(reference: string, approvedBy: string, validation: ApprovalEvidence, now = new Date()): Promise<CapabilityArtifact> {
    // The one caller allowed to resolve a draft by name - refusing here would
    // mean a capability could never reach its first approval.
    const artifact = await this.load(reference, { includeDrafts: true });
    if (artifact.capability.provenance.discovered_by === approvedBy) {
      throw new Error("The approver cannot be the identity that recorded the capability.");
    }
    const fingerprint = artifact.capability.provenance.input_fingerprint;
    const validated = fingerprintParams(validation.params);
    const reusedParams = fingerprint
      ? Object.keys(validated).filter((name) => fingerprint[name] === validated[name])
      : [];
    // Reusing every discovery input proves only the original transcript; at least
    // one invocation value must differ before approval can proceed.
    if (fingerprint && reusedParams.length === Object.keys(validated).length) {
      throw new Error("Validation replayed the discovery inputs; approval needs a different invocation.");
    }
    const approved: CapabilityArtifact = {
      ...artifact,
      capability: {
        ...artifact.capability,
        status: "approved",
        provenance: {
          ...artifact.capability.provenance,
          approved_by: approvedBy,
          approved_at: now.toISOString(),
          validation: {
            run: validation.run,
            validated_at: now.toISOString(),
            outcome: "success",
            reused_params: reusedParams,
            matched_tiers: validation.matchedTiers
          }
        }
      }
    };
    await this.write(approved);
    return approved;
  }

  // Find the highest semantic version so CLI --bump can create its successor.
  // Status is irrelevant here: a draft still occupies its version number.
  public async latestVersion(id: string): Promise<string | undefined> {
    return (await this.versionsOf(id))[0]?.version;
  }

  public async list(): Promise<string[]> {
    try {
      return (await readdir(this.root)).filter((file) => file.endsWith(".json")).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}
