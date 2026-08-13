import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { redactString, redactValue } from "../policy/redact.js";
import type { RunEvent } from "./events.js";

export class RunLogger {
  public readonly directory: string;
  private readonly sensitiveValues = new Set<string>();

  public constructor(public readonly runId: string, root = "runs") {
    this.directory = path.resolve(root, runId);
  }

  public async initialize(): Promise<void> {
    await mkdir(path.join(this.directory, "steps"), { recursive: true });
    await mkdir(path.join(this.directory, "failure"), { recursive: true });
  }

  public markSensitive(value: string): void {
    if (value) this.sensitiveValues.add(value);
  }

  public async event(event: RunEvent): Promise<void> {
    const persisted = redactValue({ ...event, at: new Date().toISOString(), runId: this.runId }, [...this.sensitiveValues]);
    await appendFile(path.join(this.directory, "log.jsonl"), `${JSON.stringify(persisted)}\n`, "utf8");
  }

  public async transcript(record: unknown): Promise<void> {
    await appendFile(path.join(this.directory, "transcript.jsonl"), `${JSON.stringify(redactValue(record, [...this.sensitiveValues]))}\n`, "utf8");
  }

  public async screenshot(step: number, dataUrl: string): Promise<string> {
    const relative = `steps/${String(step).padStart(2, "0")}.png`;
    const encoded = dataUrl.replace(/^data:image\/png;base64,/, "");
    await writeFile(path.join(this.directory, relative), Buffer.from(encoded, "base64"));
    return relative;
  }

  public async result(value: unknown): Promise<void> {
    await writeFile(path.join(this.directory, "result.json"), `${JSON.stringify(redactValue(value, [...this.sensitiveValues]), null, 2)}\n`, "utf8");
  }

  public async artifact(value: unknown): Promise<void> {
    await writeFile(path.join(this.directory, "artifact.json"), `${JSON.stringify(redactValue(value, [...this.sensitiveValues]), null, 2)}\n`, "utf8");
  }

  public async finalizeRedaction(): Promise<void> {
    const targets: { filename: string; kind: "jsonl" | "json" }[] = [
      { filename: "log.jsonl", kind: "jsonl" },
      { filename: "transcript.jsonl", kind: "jsonl" },
      { filename: "result.json", kind: "json" },
      { filename: "artifact.json", kind: "json" }
    ];
    for (const { filename, kind } of targets) {
      const destination = path.join(this.directory, filename);
      let current: string;
      try {
        current = await readFile(destination, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const redacted = kind === "jsonl"
        ? current.split("\n").map((line) => (line.trim() ? this.redactSerialized(line, false) : line)).join("\n")
        : `${this.redactSerialized(current, true)}\n`;
      await writeFile(destination, redacted, "utf8");
    }
  }

  // Re-serializing through JSON keeps redaction scoped to string values; a raw
  // text substitution would also corrupt digit substrings inside numbers.
  private redactSerialized(serialized: string, pretty: boolean): string {
    const sensitiveValues = [...this.sensitiveValues];
    try {
      const parsed = JSON.parse(serialized) as unknown;
      return JSON.stringify(redactValue(parsed, sensitiveValues), null, pretty ? 2 : undefined);
    } catch {
      return redactString(serialized, sensitiveValues);
    }
  }

  public async failureBundle(options: { screenshot?: string; dom: string; attempts?: unknown }): Promise<{ screenshot?: string; domSnapshot: string; resolutionAttempts?: string }> {
    const output: { screenshot?: string; domSnapshot: string; resolutionAttempts?: string } = { domSnapshot: "failure/dom.html" };
    await writeFile(path.join(this.directory, output.domSnapshot), redactValue(options.dom, [...this.sensitiveValues]), "utf8");
    if (options.screenshot) {
      output.screenshot = "failure/final.png";
      await writeFile(path.join(this.directory, output.screenshot), Buffer.from(options.screenshot.replace(/^data:image\/png;base64,/, ""), "base64"));
    }
    if (options.attempts) {
      output.resolutionAttempts = "failure/resolution-attempts.json";
      await writeFile(path.join(this.directory, output.resolutionAttempts), `${JSON.stringify(redactValue(options.attempts, [...this.sensitiveValues]), null, 2)}\n`, "utf8");
    }
    return output;
  }
}

export function createRunId(prefix: "disc" | "replay", now = new Date()): string {
  return `${prefix}_${now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}`;
}
