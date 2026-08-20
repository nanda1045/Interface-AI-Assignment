import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDiscovery } from "../../src/agent/loop.js";
import type { AgentDecision, DecideRequest, LLMClient } from "../../src/agent/llm/client.js";
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
  public async readTable(): Promise<{ headers: string[]; rows: string[][]; hasHeaderRow: boolean }> { return { headers: [], rows: [], hasHeaderRow: false }; }
  public async snapshotDom() { return "<html></html>"; }
  public async close() {}
}

// Offers a final-action button by the given name so profile-driven
// irreversible detection can be exercised. `legacySubmit` mimics MERIDIAN's
// <input type="submit">: empty name and text, label only in value - the shape
// that once slipped a live Post Transfer click past the risk classifier.
class FinalActionSurface extends FakeSurface {
  public constructor(private readonly buttonName: string, private readonly legacySubmit = false) { super(); }
  public override async observe(): Promise<Observation> {
    const base = await super.observe();
    const button = this.legacySubmit
      ? { ref: "final", frame: "workarea", role: "button", name: "", value: this.buttonName, state: { visible: true, enabled: true }, bboxPct: [0, 0, 0.2, 0.1] as [number, number, number, number], hints: {} }
      : { ref: "final", frame: "workarea", role: "button", name: this.buttonName, text: this.buttonName, state: { visible: true, enabled: true }, bboxPct: [0, 0, 0.2, 0.1] as [number, number, number, number], hints: {} };
    return { ...base, elements: [button] };
  }
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

// Handoff that blocks longer than the entire wall-clock budget, to prove human
// pause time is excluded from it.
class SlowCoordinator extends FakeCoordinator {
  public constructor(private readonly waitMs: number) { super(); }
  public override async request(context: InterventionContext): Promise<InterventionRequest> {
    await new Promise((resolve) => setTimeout(resolve, this.waitMs));
    return super.request(context);
  }
}

class SequenceClient implements LLMClient {
  public readonly model = "test-model";
  public requests: DecideRequest[] = [];
  private index = 0;

  public constructor(private readonly decisions: AgentDecision[]) {}

  public async decide(request: DecideRequest) {
    this.requests.push(request);
    const decision = this.decisions[this.index++];
    if (!decision) throw new Error("Test decision sequence exhausted");
    return { decision, raw: { decision } };
  }
}

// Throws on the Nth decide, standing in for an Anthropic API error that
// survived the client's own retries.
class ThrowingClient implements LLMClient {
  public readonly model = "test-model";
  private index = 0;
  public constructor(private readonly throwOn: number) {}
  public async decide(_request: DecideRequest) {
    this.index += 1;
    if (this.index === this.throwOn) throw new Error("529 Overloaded\nservice temporarily unavailable");
    return { decision: { kind: "click", ref: "field", reasoning: "act" } as AgentDecision, raw: {} };
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

  it("names the acted-on element in history, without the typed value", async () => {
    // "type completed" alone loses the thread on a multi-field form: the model
    // cannot tell which field it already filled and re-fills one instead of
    // moving on - the exact loop the MERIDIAN sign-on recording died in.
    const root = await mkdtemp(path.join(os.tmpdir(), "corepoint-agent-"));
    temporaryDirectories.push(root);
    const llm = new SequenceClient([
      { kind: "type", ref: "field", text: "4521", sensitive: true, reasoning: "Enter the requested member ID." },
      { kind: "click", ref: "search", reasoning: "Run the read-only search." },
      { kind: "note_output", ref: "balance", name: "savings_balance", reasoning: "Record the visible balance." },
      { kind: "finish", reasoning: "Done." }
    ]);
    await runDiscovery({ goal: "Look up member 4521 balance", target: "http://localhost:4478/desk", surface: new FakeSurface(), policy: new PolicyEngine(config), llm, logger: new RunLogger("disc_history", root) });

    // The loop mutates one shared history array, so inspect the final request.
    const history = llm.requests[llm.requests.length - 1]?.history ?? [];
    expect(history[0]?.result).toContain('type on "Member No." completed');
    expect(history[1]?.result).toContain('click on "Search" completed');
  });

  it("names the chosen option value for select actions in history", async () => {
    class SelectSurface extends FakeSurface {
      private observations = 0;
      public override async observe(): Promise<Observation> {
        this.observations += 1;
        return {
          url: "http://localhost:4478/desk", title: "CorePoint", frames: [{ path: "main", url: "http://localhost:4478/desk" }],
          elements: [{ ref: "mode", frame: "main", role: "combobox", name: "Search by", state: { visible: true, enabled: true }, bboxPct: [0, 0, 0.2, 0.1], hints: { nearLabel: "Search by" }, options: [{ value: "number", label: "Member Number" }, { value: "name", label: "Last Name" }] }],
          stateHash: `select-${this.observations}`
        };
      }
    }
    const root = await mkdtemp(path.join(os.tmpdir(), "corepoint-agent-"));
    temporaryDirectories.push(root);
    const llm = new SequenceClient([
      { kind: "select", ref: "mode", value: "name", reasoning: "Switch to last-name search." },
      { kind: "finish", reasoning: "Done." }
    ]);
    await runDiscovery({ goal: "Switch the search mode", target: "http://localhost:4478/desk", surface: new SelectSurface(), policy: new PolicyEngine(config), llm, logger: new RunLogger("disc_selecthist", root) });
    const history = llm.requests[llm.requests.length - 1]?.history ?? [];
    expect(history[0]?.result).toContain('select on "Search by" = "name" completed');
    expect(JSON.stringify(llm.requests.map((request) => request.history))).not.toContain("4521");
  });

  it("feeds a failed browser action back to the model instead of crashing", async () => {
    // A wrong select option value used to throw out of surface.act and kill the
    // whole discovery process with no result.json at all.
    class FlakySurface extends FakeSurface {
      private observations = 0;
      public override async observe(): Promise<Observation> {
        this.observations += 1;
        return {
          url: "http://localhost:4478/desk", title: "CorePoint", frames: [{ path: "main", url: "http://localhost:4478/desk" }],
          elements: [{ ref: "field", frame: "main", role: "combobox", name: "Search by", state: { visible: true, enabled: true }, bboxPct: [0, 0, 0.2, 0.1], hints: {} }],
          stateHash: `flaky-${this.observations}`
        };
      }

      public override async act(action: AbstractAction) {
        if (action.kind === "select") throw new Error("did not find some options");
        return super.act(action);
      }
    }
    const root = await mkdtemp(path.join(os.tmpdir(), "corepoint-agent-"));
    temporaryDirectories.push(root);
    const surface = new FlakySurface();
    const llm = new SequenceClient([
      { kind: "select", ref: "field", value: "wrong", reasoning: "Guess an option value." },
      { kind: "type", ref: "field", text: "4521", sensitive: true, reasoning: "Recover with a supported action." },
      { kind: "finish", reasoning: "Done." }
    ]);
    const result = await runDiscovery({ goal: "Pick a search mode", target: "http://localhost:4478/desk", surface, policy: new PolicyEngine(config), llm, logger: new RunLogger("disc_actfail", root) });
    expect(result.status).toBe("success");
    const history = llm.requests[llm.requests.length - 1]?.history ?? [];
    expect(history[0]?.result).toContain("FAILED");
    expect(result.steps.map((step) => step.action.kind)).toEqual(["type"]);
  });

  it("ends discovery as a controlled failure after three consecutive action failures", async () => {
    class AlwaysFailingSurface extends FakeSurface {
      private observations = 0;
      public override async observe(): Promise<Observation> {
        this.observations += 1;
        return {
          url: "http://localhost:4478/desk", title: "CorePoint", frames: [{ path: "main", url: "http://localhost:4478/desk" }],
          elements: [{ ref: "field", frame: "main", role: "combobox", name: "Search by", state: { visible: true, enabled: true }, bboxPct: [0, 0, 0.2, 0.1], hints: {} }],
          stateHash: `broken-${this.observations}`
        };
      }

      public override async act(action: AbstractAction) {
        if (action.kind === "select") throw new Error("did not find some options");
        return super.act(action);
      }
    }
    const root = await mkdtemp(path.join(os.tmpdir(), "corepoint-agent-"));
    temporaryDirectories.push(root);
    const llm = new SequenceClient(Array.from({ length: 3 }, () => ({ kind: "select" as const, ref: "field", value: "wrong", reasoning: "Guess again." })));
    const result = await runDiscovery({ goal: "Pick a search mode", target: "http://localhost:4478/desk", surface: new AlwaysFailingSurface(), policy: new PolicyEngine(config), llm, logger: new RunLogger("disc_actfail3", root) });
    expect(result.status).toBe("failure");
    expect(result.reason).toContain("Three consecutive browser actions failed");
  });

  it("finalizes evidence when the model call fails after its own retries", async () => {
    // Before this fix an API error at any step threw out of the loop and the
    // process died with no result.json - catastrophic right after an
    // irreversible human step, whose transaction has already posted.
    const root = await mkdtemp(path.join(os.tmpdir(), "corepoint-agent-"));
    temporaryDirectories.push(root);
    const logger = new RunLogger("disc_llmfail", root);
    const result = await runDiscovery({ goal: "Look up member 4521 balance", target: "http://localhost:4478/desk", surface: new FakeSurface(), policy: new PolicyEngine(config), llm: new ThrowingClient(1), logger });
    expect(result.status).toBe("failure");
    expect(result.reason).toContain("model call failed after retries");
    // The run still wrote its result and finalized redaction.
    const resultJson = await readFile(path.join(logger.directory, "result.json"), "utf8");
    expect(JSON.parse(resultJson)).toMatchObject({ status: "failure" });
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

  it("captures a headerless details panel as scalar text, not a mis-parsed table", async () => {
    // MERIDIAN's TRANSFER POSTED screen is an HTML table with no th header row:
    // its first row is "Confirmation:" / "CN480101" - values, not headers.
    // Treating them as columns froze this run's confirmation number into the
    // artifact as a column name and broke every later replay.
    class DetailsPanelSurface extends FakeSurface {
      public override async observe(): Promise<Observation> {
        return {
          url: "http://localhost:4478/desk", title: "CorePoint", frames: [{ path: "main", url: "http://localhost:4478/desk" }],
          elements: [{ ref: "panel", frame: "main", role: "table", name: "Confirmation: CN480101", text: "Confirmation: CN480101", state: { visible: true, enabled: true }, bboxPct: [0, 0, 0.5, 0.3], hints: {} }],
          stateHash: "posted"
        };
      }
      public override async readTable() { return { headers: ["Confirmation:", "CN480101"], rows: [], hasHeaderRow: false }; }
      public override async read() { return { text: "Confirmation: CN480101 Amount: $1.00" }; }
    }
    const root = await mkdtemp(path.join(os.tmpdir(), "corepoint-agent-"));
    temporaryDirectories.push(root);
    const llm = new SequenceClient([
      { kind: "note_output", ref: "panel", name: "confirmation", reasoning: "Mark the confirmation." },
      { kind: "finish", reasoning: "Done." }
    ]);
    const result = await runDiscovery({ goal: "Read the confirmation", target: "http://localhost:4478/desk", surface: new DetailsPanelSurface(), policy: new PolicyEngine(config), llm, logger: new RunLogger("disc_panel", root) });
    expect(result.status).toBe("success");
    // Scalar: no frozen table headers.
    expect(result.outputs.confirmation?.table).toBeUndefined();
    expect(result.outputs.confirmation?.locators).toBeDefined();
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

  it.each(["Post Transfer", "Apply Hold"])("records '%s' as a human boundary the model never executes", async (buttonName) => {
    // The generic risk heuristic has no idea these names are irreversible on
    // MERIDIAN; the profile's irreversible_actions patterns are what stop the
    // model. The step is recorded with its verified target BEFORE control
    // transfers, and the click never appears among the agent's actions.
    const root = await mkdtemp(path.join(os.tmpdir(), "corepoint-agent-"));
    temporaryDirectories.push(root);
    const surface = new FinalActionSurface(buttonName);
    const coordinator = new FakeCoordinator();
    const result = await runDiscovery({
      goal: "Complete the posting",
      target: "http://localhost:4478/desk",
      surface,
      policy: new PolicyEngine(config),
      llm: new SequenceClient([
        { kind: "click", ref: "final", reasoning: "Post it." },
        { kind: "note_output", ref: "final", name: "confirmation", reasoning: "Record the confirmation." },
        { kind: "finish", reasoning: "Done." }
      ]),
      logger: new RunLogger(`disc_${buttonName.replace(/\W+/g, "_")}`, root),
      irreversibleActions: ["Post Transfer", "Apply Hold"],
      handoff: coordinator
    });
    expect(result.status).toBe("success");
    const humanStep = result.steps.find((step) => step.execution === "human_required");
    expect(humanStep).toBeDefined();
    expect(humanStep?.locators).toBeDefined();
    // The model clicked nothing: only the entry navigation was executed.
    expect(surface.actions.map((action) => action.kind)).toEqual(["navigate"]);
    expect(coordinator.requests).toHaveLength(1);
  });

  it.each(["Post Transfer", "Apply Hold"])("stops '%s' on a legacy submit button whose label is only its value", async (buttonName) => {
    // MERIDIAN's real buttons are <input type="submit" value="Post Transfer">:
    // empty name, empty text. The risk label must fall through to value, and
    // must use || - an empty-string name short-circuits ?? and once let the
    // model post a live transfer itself.
    const root = await mkdtemp(path.join(os.tmpdir(), "corepoint-agent-"));
    temporaryDirectories.push(root);
    const surface = new FinalActionSurface(buttonName, true);
    const coordinator = new FakeCoordinator();
    const result = await runDiscovery({
      goal: "Complete the posting",
      target: "http://localhost:4478/desk",
      surface,
      policy: new PolicyEngine(config),
      llm: new SequenceClient([
        { kind: "click", ref: "final", reasoning: "Post it." },
        { kind: "note_output", ref: "final", name: "confirmation", reasoning: "Record the confirmation." },
        { kind: "finish", reasoning: "Done." }
      ]),
      logger: new RunLogger(`disc_legacy_${buttonName.replace(/\W+/g, "_")}`, root),
      irreversibleActions: ["Post Transfer", "Apply Hold"],
      handoff: coordinator
    });
    expect(result.status).toBe("success");
    expect(result.steps.find((step) => step.execution === "human_required")).toBeDefined();
    expect(surface.actions.map((action) => action.kind)).toEqual(["navigate"]);
    expect(coordinator.requests).toHaveLength(1);
  });

  it("excludes human-pause time from the wall-clock duration budget", async () => {
    // An operator taking longer than max_duration_ms at an irreversible
    // boundary is the system working as designed. Before this fix the run
    // resumed and immediately failed "exceeded max_duration_ms" - which is
    // exactly what killed the first live transfer recording.
    const root = await mkdtemp(path.join(os.tmpdir(), "corepoint-agent-"));
    temporaryDirectories.push(root);
    const surface = new FinalActionSurface("Post Transfer", true);
    const coordinator = new SlowCoordinator(120);
    const result = await runDiscovery({
      goal: "Complete the posting",
      target: "http://localhost:4478/desk",
      surface,
      policy: new PolicyEngine({ ...config, max_duration_ms: 50 }),
      llm: new SequenceClient([
        { kind: "click", ref: "final", reasoning: "Post it." },
        { kind: "note_output", ref: "final", name: "confirmation", reasoning: "Record the confirmation." },
        { kind: "finish", reasoning: "Done." }
      ]),
      logger: new RunLogger("disc_pausebudget", root),
      irreversibleActions: ["Post Transfer"],
      handoff: coordinator
    });
    expect(result.status).toBe("success");
    expect(result.steps.find((step) => step.execution === "human_required")).toBeDefined();
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
