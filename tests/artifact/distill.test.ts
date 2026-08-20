import { describe, expect, it } from "vitest";
import { distillDiscovery } from "../../src/artifact/distill.js";
import type { DiscoveryResult } from "../../src/agent/loop.js";

const locator = { capturedAt: "2026-08-13T00:00:00.000Z", strategies: [{ kind: "attr_css" as const, value: "input[name='f_mno']", frame: "workarea", unique: true as const, confidence: 0.7 }] };
const result: DiscoveryResult = {
  status: "success", runId: "disc_test", outputs: { savings_balance: { locators: locator } },
  steps: [{ step: 1, reasoning: "Enter member", action: { kind: "type", ref: "e1", text: "4521", sensitive: true }, locators: locator, beforeUrl: "http://localhost:4478/desk", afterUrl: "http://localhost:4478/desk" }]
};
const options = {
  id: "lookup_member_savings_balance", title: "Look up member savings balance", description: "Reads regular savings.", entryUrl: "http://localhost:4478/desk", model: "test", runId: "disc_test", params: { member_id: "4521" },
  inputs: { type: "object" as const, required: ["member_id"], properties: { member_id: { type: "string" as const, sensitive: true } } },
  outputs: { type: "object" as const, required: ["savings_balance"], properties: { savings_balance: { type: "string" as const, "x-format": "usd-currency" } } }
};

const roleName = (name: string) => ({ kind: "role_name" as const, role: "button", name, frame: "workarea", unique: true as const, confidence: 0.9 });
const bundle = (...strategies: { kind: string }[]) => ({ capturedAt: "2026-08-13T00:00:00.000Z", strategies }) as typeof locator;
const runWith = (overrides: { reasoning?: string; locators?: typeof locator; outputs?: DiscoveryResult["outputs"] }): DiscoveryResult => ({
  ...result,
  outputs: overrides.outputs ?? result.outputs,
  steps: [{
    step: 1,
    reasoning: overrides.reasoning ?? "Enter member",
    action: { kind: "type", ref: "e1", text: "4521", sensitive: true },
    locators: overrides.locators ?? locator,
    beforeUrl: "http://localhost:4478/desk",
    afterUrl: "http://localhost:4478/desk"
  }]
});

const step = (action: DiscoveryResult["steps"][number]["action"], locators = locator): DiscoveryResult["steps"][number] =>
  ({ step: 1, reasoning: "Work the form", action, locators, beforeUrl: "http://localhost:4478/desk", afterUrl: "http://localhost:4478/desk" });
const runSteps = (...steps: DiscoveryResult["steps"]): DiscoveryResult => ({ ...result, steps });

describe("distillDiscovery", () => {
  it("binds concrete recorded values into typed parameters", () => {
    const artifact = distillDiscovery(result, options);
    expect(artifact.steps[0]?.action).toEqual({ kind: "type", value_from: { param: "member_id" }, sensitive: true });
    expect(JSON.stringify(artifact)).not.toContain("4521");
  });

  it("promotes an input to sensitive when its recorded typing was sensitive", () => {
    // A password named "code" would slip past every name heuristic; the model
    // marked the typing sensitive, and the contract must say so too or replay
    // would log the invocation value in the clear.
    const artifact = distillDiscovery(result, {
      ...options,
      params: { code: "4521" },
      inputs: { type: "object" as const, required: ["code"], properties: { code: { type: "string" as const, sensitive: false } } }
    });
    expect(artifact.inputs.properties.code).toMatchObject({ sensitive: true });
  });

  it("fails loudly when a supplied parameter never binds", () => {
    expect(() => distillDiscovery(result, { ...options, params: { member_id: "9999" } })).toThrow(/Could not uniquely bind/);
    expect(() => distillDiscovery(result, { ...options, params: { ...options.params, unused: "x" } })).toThrow(/never bound: unused/);
  });

  it("permits only the actions the capability performs", () => {
    const artifact = distillDiscovery(
      runSteps(step({ kind: "type", ref: "e1", text: "4521", sensitive: true }), step({ kind: "click", ref: "e1" })),
      options
    );
    // navigate for the entry, click for the recovery rule, type and click for the steps.
    expect([...artifact.policy.allowed_actions].sort()).toEqual(["click", "navigate", "type"]);
    expect(artifact.policy.allowed_actions).not.toContain("press");
    expect(artifact.policy.allowed_actions).not.toContain("scroll");
  });

  it("scrubs values the run marked sensitive out of the model's intent text", () => {
    const artifact = distillDiscovery(
      runWith({ reasoning: 'I can see member 4521 "Alex Testman" in the results.' }),
      { ...options, sensitiveValues: ["Alex Testman"] }
    );
    expect(artifact.steps[0]?.intent).toBe('I can see member {{member_id}} "«redacted»" in the results.');
    expect(JSON.stringify(artifact)).not.toContain("Alex Testman");
  });

  it("drops locator strategies built from run-specific data but keeps the rest of the ladder", () => {
    const artifact = distillDiscovery(
      runWith({ locators: bundle(roleName("View account 4521-01"), locator.strategies[0]!) }),
      options
    );
    expect(artifact.steps[0]?.target?.strategies).toHaveLength(1);
    expect(artifact.steps[0]?.target?.strategies[0]?.kind).toBe("attr_css");
    expect(JSON.stringify(artifact)).not.toContain("4521-01");
  });

  it("collapses a value the model re-entered into the same control", () => {
    const artifact = distillDiscovery(
      runSteps(step({ kind: "type", ref: "e1", text: "4521", sensitive: true }), step({ kind: "type", ref: "e1", text: "4521", sensitive: true })),
      options
    );
    expect(artifact.steps).toHaveLength(1);
    expect(artifact.steps[0]?.id).toBe("s1");
  });

  it("never collapses a repeated click, which may be doing work each time", () => {
    const artifact = distillDiscovery(
      runSteps(step({ kind: "type", ref: "e1", text: "4521", sensitive: true }), step({ kind: "click", ref: "e1" }), step({ kind: "click", ref: "e1" })),
      options
    );
    expect(artifact.steps).toHaveLength(3);
  });

  it("copies profile authoring templates into the artifact instead of CorePoint's", () => {
    // The profile informs authoring; the artifact carries the chosen rules, so
    // replay still follows a reviewable contract and never consults a profile.
    const artifact = distillDiscovery(result, {
      ...options,
      app: { id: "meridian-core", vendor: "Cornerstone Financial Systems", ui_version_range: ">=4.2 <5" },
      outcomeTemplates: [{ code: "RECORD_MISSING", when: [{ kind: "text_visible", pattern: "RECORD NOT FOUND" }] }],
      recoveryTemplates: []
    });
    expect(artifact.capability.app.id).toBe("meridian-core");
    expect(artifact.outcomes.map((outcome) => outcome.code)).toEqual(["RECORD_MISSING"]);
    expect(artifact.outcomes[0]?.at_steps).toEqual(artifact.steps.map((step) => step.id));
    expect(artifact.recovery).toEqual([]);
    // Defaults unchanged when no profile is involved.
    const plain = distillDiscovery(result, options);
    expect(plain.outcomes.map((outcome) => outcome.code)).toEqual(["MEMBER_NOT_FOUND", "PERMISSION_DENIED"]);
  });

  it("turns a marked table into a typed array output with column mapping", () => {
    const artifact = distillDiscovery(
      { ...result, outputs: { matches: { locators: locator, table: { headers: ["Member No.", "Name", "Shares"] } } } },
      { ...options, outputs: { type: "object", required: ["matches"], properties: { matches: { type: "string", sensitive: true } } } }
    );
    const declared = artifact.outputs.properties.matches;
    expect(declared).toMatchObject({ type: "array", sensitive: true });
    if (declared?.type !== "array") throw new Error("expected an array contract");
    expect(Object.keys(declared.items.properties)).toEqual(["member_no", "name", "shares"]);
    expect(artifact.extract[0]).toMatchObject({
      output: "matches",
      parse: "table",
      columns: [
        { header: "Member No.", property: "member_no" },
        { header: "Name", property: "name" },
        { header: "Shares", property: "shares" }
      ]
    });
  });

  it("marks member-data columns sensitive even under an innocuous output name", () => {
    const artifact = distillDiscovery(
      { ...result, outputs: { matches: { locators: locator, table: { headers: ["Member No.", "Name", "Shares"] } } } },
      { ...options, outputs: { type: "object", required: ["matches"], properties: { matches: { type: "string" } } } }
    );
    const declared = artifact.outputs.properties.matches;
    if (declared?.type !== "array") throw new Error("expected an array contract");
    expect(declared.items.properties.member_no?.sensitive).toBe(true);
    expect(declared.items.properties.name?.sensitive).toBe(true);
    // "shares" matches the share-id pattern too. The heuristic errs toward
    // privacy: the cost is redacting a harmless count, the alternative risks
    // persisting a raw share id.
    expect(declared.items.properties.shares?.sensitive).toBe(true);
  });

  it("gives a record-changing capability only recoveries that cannot re-run it", () => {
    // Re-entry recoveries are refused at runtime once a mutation may have been
    // attempted, so shipping them in a mutating capability only adds rules
    // that can never succeed.
    const templates = [
      { id: "dismiss", condition: { kind: "dialog_present" as const, textPattern: "x" }, action: { kind: "click" as const, target: { strategies: [locator.strategies[0]!] } }, max_attempts: 1 },
      { id: "reenter", condition: { kind: "text_visible" as const, pattern: "y" }, action: { kind: "click" as const, target: { strategies: [locator.strategies[0]!] } }, max_attempts: 1, effect: "restart_capability" as const }
    ];
    const mutating = distillDiscovery(result, { ...options, risk: "mutating", recoveryTemplates: templates });
    expect(mutating.recovery.map((rule) => rule.id)).toEqual(["dismiss"]);
    const readOnly = distillDiscovery(result, { ...options, recoveryTemplates: templates });
    expect(readOnly.recovery.map((rule) => rule.id)).toEqual(["dismiss", "reenter"]);
  });

  it("skips blank action-column headers in the table mapping", () => {
    // MERIDIAN's results table has a fourth, header-less column of Select
    // buttons. It cannot be matched by header text at replay, so it is simply
    // not data and not part of the mapping.
    const artifact = distillDiscovery(
      { ...result, outputs: { matches: { locators: locator, table: { headers: ["Member No.", "Name", "Shares", " "] } } } },
      { ...options, outputs: { type: "object", required: ["matches"], properties: { matches: { type: "string" } } } }
    );
    expect(artifact.extract[0]?.columns?.map((column) => column.property)).toEqual(["member_no", "name", "shares"]);
  });

  it("keeps only the final choice of consecutive selects on the same control", () => {
    // Selecting WEST-014 then MAIN-001 leaves the control holding MAIN-001;
    // replaying the intermediate pick would be noise frozen into the artifact.
    const artifact = distillDiscovery(
      runSteps(
        step({ kind: "type", ref: "e1", text: "4521", sensitive: true }),
        step({ kind: "select", ref: "e2", value: "WEST-014" }, { ...locator, strategies: [{ ...locator.strategies[0]!, value: "select[name='branch']" }] }),
        step({ kind: "select", ref: "e2", value: "MAIN-001" }, { ...locator, strategies: [{ ...locator.strategies[0]!, value: "select[name='branch']" }] })
      ),
      { ...options, params: { member_id: "4521", branch: "MAIN-001" }, inputs: { type: "object", required: ["member_id", "branch"], properties: { member_id: { type: "string", sensitive: true }, branch: { type: "string" } } } }
    );
    const selects = artifact.steps.filter((artifactStep) => artifactStep.action.kind === "select");
    expect(selects).toHaveLength(1);
    expect(selects[0]?.action).toMatchObject({ value_from: { param: "branch" } });
    expect(JSON.stringify(artifact)).not.toContain("WEST-014");
  });

  it("records a select that binds no parameter as the flow's own constant", () => {
    // "Search by Last Name" is a fixed choice, not invocation data. Typed text
    // gets no such fallback - unbound free text stays a loud error.
    const artifact = distillDiscovery(
      runSteps(
        step({ kind: "select", ref: "e1", value: "name" }),
        step({ kind: "type", ref: "e2", text: "4521", sensitive: true })
      ),
      options
    );
    expect(artifact.steps[0]?.action).toEqual({ kind: "select", value: "name" });
    expect(artifact.steps[0]?.postconditions).toEqual([]);
    expect(() => distillDiscovery(runSteps(step({ kind: "type", ref: "e1", text: "unbound-text" }), step({ kind: "type", ref: "e2", text: "4521", sensitive: true })), options))
      .toThrow(/Could not uniquely bind/);
  });

  it("generalises parameter values in a synthesized url postcondition", () => {
    // A navigation whose URL carries the member number must not pin the
    // postcondition to that member, or replay for anyone else would fail it -
    // and the raw value must not survive into the artifact.
    const navigated: DiscoveryResult = {
      ...result,
      steps: [
        { step: 1, reasoning: "Enter the member", action: { kind: "type", ref: "e1", text: "4521", sensitive: true }, locators: locator, beforeUrl: "https://app.test/members", afterUrl: "https://app.test/members" },
        { step: 2, reasoning: "Open the record", action: { kind: "click", ref: "e2" }, locators: locator, beforeUrl: "https://app.test/members?q=4521", afterUrl: "https://app.test/members/4521" }
      ]
    };
    const artifact = distillDiscovery(navigated, options);
    const url = artifact.steps[1]?.postconditions.find((p) => p.kind === "url_matches");
    expect(url?.kind === "url_matches" && url.pattern).toBe("^https://app\\.test/members/[^/?&#]+");
    expect(JSON.stringify(artifact)).not.toContain("4521");
    // And it still matches a different member's landing URL.
    if (url?.kind === "url_matches") expect(new RegExp(url.pattern).test("https://app.test/members/8832")).toBe(true);
  });

  it("demands --risk irreversible when discovery recorded a human boundary", () => {
    const withBoundary: DiscoveryResult = {
      ...result,
      steps: [...result.steps, { step: 2, reasoning: "Post it", action: { kind: "click", ref: "e2" }, locators: locator, beforeUrl: "http://localhost:4478/desk", afterUrl: "http://localhost:4478/desk", execution: "human_required" }]
    };
    expect(() => distillDiscovery(withBoundary, options)).toThrow(/Re-run with --risk irreversible/);
    expect(() => distillDiscovery(withBoundary, { ...options, risk: "irreversible" })).not.toThrow();
  });

  it("refuses the artifact when run data emptied a ladder", () => {
    expect(() => distillDiscovery(runWith({ locators: bundle(roleName("View account 4521-01")) }), options))
      .toThrow(/step 1 was built from run-specific data/);
    expect(() => distillDiscovery(runWith({ outputs: { savings_balance: { locators: bundle(roleName("Balance for Alex Testman")) } } }), { ...options, sensitiveValues: ["Alex Testman"] }))
      .toThrow(/extraction of savings_balance was built from run-specific data/);
  });
});
