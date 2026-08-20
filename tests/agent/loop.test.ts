import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDiscovery } from "../../src/agent/loop.js";
import type { AgentDecision, LLMClient } from "../../src/agent/llm/client.js";
import type { HandoffCoordinator, InterventionContext, InterventionRequest } from "../../src/control/intervention.js";
import { RunLogger } from "../../src/evidence/run-logger.js";
import { PolicyEngine, type PolicyConfig } from "../../src/policy/engine.js";
import type { AbstractAction, LocatorBundle, Observation, Surface } from "../../src/surface/types.js";

const bundle: LocatorBundle = {
  capturedAt: "2026-08-13T00:00:00.000Z",
  strategies: [{ kind: "attr_css", value: "input[name='f_mno']", frame: "workarea", unique: true, confidence: 0.7 }]
};

class FakeSurface implements Surface {
  public actions: AbstractAction[] = [];
  private observationIndex = 0;

  public async observe(): Promise<Observation> {
    this.observationIndex += 1;
    const elements = this.observationIndex === 1
      ? [{ ref: "field", frame: "workarea", role: "textbox", name: "Member No.", state: { visible: true, enabled: true }, bboxPct: [0, 0, 0.2, 0.1] as [number, number, number, number], hints: { nearLabel: "Member No." } }]
      : this.observationIndex === 2
        ? [{ ref: "search", frame: "workarea", role: "button", name: "Search", text: "Search", state: { visible: true, enabled: true }, bboxPct: [0, 0, 0.2, 0.1] as [number, number, number, number], hints: {} }]
        : [{ ref: "balance", frame: "workarea", role: "text", name: "$2,481.13", text: "$2,481.13", state: { visible: true, enabled: true }, bboxPct: [0, 0, 0.2, 0.1] as [number, number, number, number], hints: {} }];
    return { url: "http://localhost:4478/desk", title: "CorePoint", frames: [{ path: "main", url: "http://localhost:4478/desk" }, { path: "workarea", url: "http://localhost:4478/workspace/search" }], elements, screenshot: "data:image/png;base64,iVBORw0KGgo=", stateHash: `state-${this.observationIndex}` };
  }

  public async act(action: AbstractAction) {
    this.actions.push(action);
    return { ok: true as const, url: "http://localhost:4478/desk" };
  }

  public async captureLocators(): Promise<LocatorBundle> { return bundle; }
  public async resolve() { return { ok: false as const, reason: "target_not_found" as const, attempts: [] }; }
  public async read() { return { text: "$2,481.13" }; }
  public async readTable() { return { headers: [], rows: [] }; }
  public async snapshotDom() { return "<html></html>"; }
  public async close() {}
}

class FakeCoordinator implements HandoffCoordinator {
  public requests: InterventionContext[] = [];

  public async request(context: InterventionContext): Promise<InterventionRequest> {
    this.requests.push(context);
    return { ...context, id: `int_${this.requests.length}`, status: "handed_back", requestedAt: "2026-08-13T00:00:00.000Z" };
  }

  public async resume(): Promise<void> {}
  public summary() { return { count: this.requests.length, requestIds: this.requests.map((_, index) => `int_${index + 1}`) }; }
}

class SequenceClient implements LLMClient {
  public readonly model = "test-model";
  private index = 0;

  public constructor(private readonly decisions: AgentDecision[]) {}

  public async decide() {
    const decision = this.decisions[this.index++];
    if (!decision) throw new Error("Test decision sequence exhausted");
    return { decision, raw: { decision } };
  }
}

const config: PolicyConfig = {
  allowed_origins: ["http://localhost:4478"],
  allowed_path_patterns: ["^/(desk|workspace)(/.*)?$"],
  allowed_actions: ["navigate", "click", "focus", "type", "select", "press", "scroll"],
  max_steps: 10,
  max_duration_ms: 30_000,
  risk: { discovery_mutations: "block", irreversible: "escalate" }
};

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("runDiscovery", () => {
  it("executes model decisions through policy and redacts sensitive values before persistence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "corepoint-agent-"));
    temporaryDirectories.push(root);
    const surface = new FakeSurface();
    const llm = new SequenceClient([
      { kind: "type", ref: "field", text: "4521", sensitive: true, reasoning: "Enter the requested member ID." },
      { kind: "click", ref: "search", reasoning: "Run the read-only search." },
      { kind: "note_output", ref: "balance", name: "savings_balance", reasoning: "Record the visible balance." },
      { kind: "finish", reasoning: "The requested balance is visible and marked." }
    ]);
    const logger = new RunLogger("disc_test", root);
    const result = await runDiscovery({ goal: "Look up member 4521 balance", target: "http://localhost:4478/desk", surface, policy: new PolicyEngine(config), llm, logger });
    expect(result).toMatchObject({ status: "success", runId: "disc_test" });
    expect(result.outputs).toHaveProperty("savings_balance");
    expect(surface.actions.map((action) => action.kind)).toEqual(["navigate", "type", "click"]);

    const persisted = `${await readFile(path.join(logger.directory, "log.jsonl"), "utf8")}\n${await readFile(path.join(logger.directory, "transcript.jsonl"), "utf8")}\n${await readFile(path.join(logger.directory, "result.json"), "utf8")}`;
    expect(persisted).not.toContain("4521");
    expect(persisted).not.toContain("$2,481.13");
    expect(persisted).toContain("«redacted»");
  });

  it("ignores a duplicate output mark so the model can continue or finish", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "corepoint-agent-"));
    temporaryDirectories.push(root);
    const surface = new FakeSurface();
    const llm = new SequenceClient([
      { kind: "note_output", ref: "field", name: "member_name", reasoning: "Mark the member name." },
      { kind: "note_output", ref: "search", name: "member_name", reasoning: "Mark it again." },
      { kind: "finish", reasoning: "The requested output is already marked." }
    ]);

    const result = await runDiscovery({ goal: "Read the member name", target: "http://localhost:4478/desk", surface, policy: new PolicyEngine(config), llm, logger: new RunLogger("disc_duplicate", root) });

    expect(result).toMatchObject({ status: "success" });
    expect(Object.keys(result.outputs)).toEqual(["member_name"]);
  });

  it("finishes when every declared output has been visibly marked", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "corepoint-agent-"));
    temporaryDirectories.push(root);
    const result = await runDiscovery({
      goal: "Read the member name",
      target: "http://localhost:4478/desk",
      surface: new FakeSurface(),
      policy: new PolicyEngine(config),
      llm: new SequenceClient([{ kind: "note_output", ref: "field", name: "member_name", reasoning: "Mark the member name." }]),
      logger: new RunLogger("disc_expected", root),
      expectedOutputs: ["member_name"]
    });

    expect(result).toMatchObject({ status: "success", outputs: { member_name: { locators: bundle } } });
  });

  it("pauses a stuck discovery into human handoff and resumes the loop", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "corepoint-agent-"));
    temporaryDirectories.push(root);
    const coordinator = new FakeCoordinator();
    const result = await runDiscovery({
      goal: "Read the member name",
      target: "http://localhost:4478/desk",
      surface: new FakeSurface(),
      policy: new PolicyEngine(config),
      llm: new SequenceClient([
        { kind: "escalate", reason: "A blocking dialog needs an operator.", reasoning: "The state is ambiguous." },
        { kind: "note_output", ref: "search", name: "member_name", reasoning: "Mark the member name after the operator unblocked the flow." }
      ]),
      logger: new RunLogger("disc_handoff", root),
      expectedOutputs: ["member_name"],
      handoff: coordinator
    });

    expect(result).toMatchObject({ status: "success" });
    expect(coordinator.requests).toHaveLength(1);
    expect(coordinator.requests[0]).toMatchObject({ capability: "discovery", reason: "A blocking dialog needs an operator." });
  });
});
