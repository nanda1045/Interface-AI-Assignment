// In-memory run coordination for the API and dashboard. It owns nothing about
// how a capability executes - that stays in the runner - only the queue, the
// live state, and the merged view over completed evidence on disk.
//
// One capability runs at a time, chained on a promise: a single operator
// browser is the honest model of this deployment, and a queue position is a
// clearer answer than two Chromiums fighting over the same live target.
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ReplayResult } from "../replay/result.js";

export type RunState =
  | "queued"
  | "running"
  | "waiting_for_human"
  | "success"
  | "business_outcome"
  | "escalated"
  | "failed";

export interface RunRecord {
  runId: string;
  type: "replay" | "discovery" | "approval_validation" | "stress";
  capability: string;
  state: RunState;
  requestedAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** The terminal result for finished runs; absent while queued/running. */
  result?: ReplayResult;
  /** Present when the run could not execute at all (unknown capability, missing
   *  credentials) - distinct from a replay that ran and failed. */
  error?: string;
}

export interface RunJob {
  runId: string;
  capability: string;
  execute: () => Promise<{ result: ReplayResult; reference: string }>;
}

// Evidence directories are named <prefix>_<timestamp>; the prefix records what
// kind of work produced them, which is how history is classified without a
// database. disc_* are discovery runs, approval_* are the replays that earned
// an approval, stress_* are robustness runs.
function typeOf(runId: string): RunRecord["type"] {
  if (runId.startsWith("disc")) return "discovery";
  if (runId.startsWith("approval")) return "approval_validation";
  if (runId.startsWith("stress")) return "stress";
  return "replay";
}

interface RunStartedLine {
  type?: string;
  capability?: string;
  goal?: string;
  model?: string;
}

export class RunService {
  private readonly live = new Map<string, RunRecord>();
  private chain: Promise<void> = Promise.resolve();

  public constructor(private readonly runRoot = "runs") {}

  /** Accepts a job and returns immediately: the caller gets a queued record and
   *  polls for progress. Jobs execute strictly one at a time in arrival order. */
  public submit(job: RunJob): RunRecord {
    const record: RunRecord = {
      runId: job.runId,
      type: typeOf(job.runId),
      capability: job.capability,
      state: "queued",
      requestedAt: new Date().toISOString()
    };
    this.live.set(job.runId, record);
    this.chain = this.chain.then(async () => {
      record.state = "running";
      record.startedAt = new Date().toISOString();
      try {
        const { result, reference } = await job.execute();
        record.capability = reference;
        record.result = result;
        record.state = result.status === "success" ? "success" : result.status === "business_outcome" ? "business_outcome" : "failed";
      } catch (error) {
        record.state = "failed";
        record.error = error instanceof Error ? error.message : String(error);
      } finally {
        record.finishedAt = new Date().toISOString();
      }
    });
    return record;
  }

  /** Live signal from the handoff coordinator: a run waiting on a person is a
   *  different state from one that is executing, and the dashboard displays it
   *  as "Escalated — waiting for human". */
  public markWaitingForHuman(runId: string, waiting: boolean): void {
    const record = this.live.get(runId);
    if (record && record.state === (waiting ? "running" : "waiting_for_human")) {
      record.state = waiting ? "waiting_for_human" : "running";
    }
  }

  public get(runId: string): RunRecord | undefined {
    return this.live.get(runId);
  }

  /** Everything: live records first, then completed evidence rebuilt from the
   *  run directories, newest first. Discovery runs recorded before this service
   *  existed appear too - history is the disk, not this process's memory. */
  public async list(): Promise<RunRecord[]> {
    const seen = new Set(this.live.keys());
    const fromDisk = (await this.history()).filter((record) => !seen.has(record.runId));
    return [...this.live.values(), ...fromDisk].sort((left, right) => (right.requestedAt).localeCompare(left.requestedAt));
  }

  private async history(): Promise<RunRecord[]> {
    let directories: string[];
    try {
      directories = await readdir(this.runRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const records: RunRecord[] = [];
    for (const runId of directories) {
      const record = await this.recordFromDisk(runId);
      if (record) records.push(record);
    }
    return records;
  }

  private async recordFromDisk(runId: string): Promise<RunRecord | undefined> {
    const directory = path.join(this.runRoot, runId);
    let requestedAt: string;
    try {
      requestedAt = (await stat(directory)).mtime.toISOString();
    } catch {
      return undefined;
    }
    const record: RunRecord = { runId, type: typeOf(runId), capability: "", state: "failed", requestedAt, finishedAt: requestedAt };
    try {
      const firstLine = (await readFile(path.join(directory, "log.jsonl"), "utf8")).split("\n")[0] ?? "";
      const started = JSON.parse(firstLine) as RunStartedLine;
      record.capability = started.capability ?? started.goal ?? "";
    } catch {
      // A directory without a parseable log is still listed; the dashboard
      // links its evidence and the blanks say what is missing.
    }
    try {
      const result = JSON.parse(await readFile(path.join(directory, "result.json"), "utf8")) as { status: string };
      if (result.status === "success" || result.status === "business_outcome") {
        record.state = result.status;
        record.result = result as unknown as ReplayResult;
      } else if (result.status === "escalated") {
        // Discovery runs end as "escalated" when a human never resolved the
        // blocker; that is its own displayed status, not a failure.
        record.state = "escalated";
      } else {
        record.state = "failed";
        record.result = result as unknown as ReplayResult;
      }
    } catch {
      record.state = "failed";
      record.error = "No terminal result was recorded.";
    }
    return record;
  }
}
