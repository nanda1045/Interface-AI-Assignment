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

  // Every artifact is schema-validated again when read from disk.
  public async load(reference: string): Promise<CapabilityArtifact> {
    const filename = reference.endsWith(".json") ? reference : `${reference}.json`;
    let contents: string;
    try {
      contents = await readFile(path.resolve(this.root, filename), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const known = await this.list();
      throw new Error(`No capability ${reference} in ${this.root}. Available: ${known.length > 0 ? known.join(", ") : "none"}`);
    }
    return capabilityArtifactSchema.parse(JSON.parse(contents));
  }

  // Turn a validated draft into an approved artifact while enforcing a different
  // reviewer identity and a non-identical invocation fingerprint.
  public async approve(reference: string, approvedBy: string, validation: ApprovalEvidence, now = new Date()): Promise<CapabilityArtifact> {
    const artifact = await this.load(reference);
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
  public async latestVersion(id: string): Promise<string | undefined> {
    const pattern = new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}@(\\d+)\\.(\\d+)\\.(\\d+)\\.json$`);
    return (await this.list())
      .map((file) => pattern.exec(file))
      .filter((match): match is RegExpExecArray => match !== null)
      .sort((left, right) => left.slice(1, 4).reduce((order, part, index) => order || Number(part) - Number(right[index + 1]), 0))
      .at(-1)
      ?.slice(1, 4)
      .join(".");
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
