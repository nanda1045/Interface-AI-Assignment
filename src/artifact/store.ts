import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { capabilityArtifactSchema, type CapabilityArtifact } from "./schema.js";

export class ArtifactStore {
  public constructor(private readonly root = "artifacts") {}

  public pathFor(id: string, version: string): string {
    return path.resolve(this.root, `${id}@${version}.json`);
  }

  public async save(artifact: CapabilityArtifact): Promise<string> {
    const validated = capabilityArtifactSchema.parse(artifact);
    await mkdir(this.root, { recursive: true });
    const destination = this.pathFor(validated.capability.id, validated.capability.version);
    await writeFile(destination, `${JSON.stringify(validated, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return destination;
  }

  public async write(artifact: CapabilityArtifact): Promise<string> {
    const validated = capabilityArtifactSchema.parse(artifact);
    await mkdir(this.root, { recursive: true });
    const destination = this.pathFor(validated.capability.id, validated.capability.version);
    await writeFile(destination, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
    return destination;
  }

  public async load(reference: string): Promise<CapabilityArtifact> {
    const filename = reference.endsWith(".json") ? reference : `${reference}.json`;
    const contents = await readFile(path.resolve(this.root, filename), "utf8");
    return capabilityArtifactSchema.parse(JSON.parse(contents));
  }

  public async approve(reference: string, approvedBy: string, now = new Date()): Promise<CapabilityArtifact> {
    const artifact = await this.load(reference);
    const approved: CapabilityArtifact = {
      ...artifact,
      capability: {
        ...artifact.capability,
        status: "approved",
        provenance: { ...artifact.capability.provenance, approved_by: approvedBy, approved_at: now.toISOString() }
      }
    };
    await this.write(approved);
    return approved;
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
