import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunLogger } from "../../src/evidence/run-logger.js";
import { PolicyEngine, type PolicyConfig } from "../../src/policy/engine.js";
import { signOn } from "../../src/profile/bootstrap.js";
import type { AppProfile } from "../../src/profile/profile.js";
import type { AbstractAction, LocatorBundle, Observation, Surface, TargetSpec } from "../../src/surface/types.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const profile: AppProfile = {
  app: { id: "meridian-core", vendor: "Cornerstone", ui_version_range: ">=4 <5", origin: "https://target.test" },
  policy: "policies/meridian.yaml",
  signon: {
    url: "https://target.test/signon",
    fields: { operator: "operator", password: "password", branch: "branch" },
    authenticated_pattern: "OPR\\s+[A-Z0-9]+",
    failure_pattern: "Invalid operator ID or password"
  },
  detectors: { session_lost: { paths: [], patterns: [] }, app_error: { patterns: ["x"] }, escalation: { patterns: [] } },
  outcome_templates: [],
  recovery_templates: []
};

// A sign-on page that authenticates when the right password is typed.
class SignonSurface implements Surface {
  public readonly actions: AbstractAction[] = [];
  private typedPassword = "";
  public constructor(private readonly accept: string) {}

  public async observe(): Promise<Observation> {
    const authenticated = this.typedPassword === this.accept;
    const footer = authenticated ? "OPR TELLER1 | BR MAIN-001" : "NOT SIGNED ON Invalid operator ID or password.";
    return {
      url: "https://target.test/signon", title: "Sign On", frames: [{ path: "main", url: "https://target.test/signon" }],
      elements: [{ ref: "footer", frame: "main", role: "cell", name: footer, text: footer, state: { visible: true, enabled: true }, bboxPct: [0, 0.9, 1, 0.05], hints: {} }],
      stateHash: authenticated ? "in" : "out"
    };
  }

  public async act(action: AbstractAction) {
    this.actions.push(action);
    if (action.kind === "type" && action.ref === "password") this.typedPassword = action.text;
    return { ok: true as const, url: "https://target.test/signon" };
  }

  public async resolve(target: TargetSpec) {
    const value = target.strategies[0]?.kind === "attr_css" ? target.strategies[0].value : "";
    const ref = value.includes("operator") ? "operator" : value.includes("password") ? "password" : value.includes("branch") ? "branch" : "submit";
    return { ok: true as const, ref, frame: "main", matchedStrategy: target.strategies[0]!, tier: 1, attempts: [] };
  }

  public async captureLocators(): Promise<LocatorBundle> { throw new Error("not used"); }
  public async read() { return { text: "" }; }
  public async readTable() { return { headers: [], rows: [], hasHeaderRow: false }; }
  public async snapshotDom() { return "<html></html>"; }
  public async close() {}
}

const config: PolicyConfig = {
  allowed_origins: ["https://target.test"], allowed_path_patterns: ["^/signon$"],
  allowed_actions: ["navigate", "click", "type", "select"], max_steps: 10, max_duration_ms: 10_000,
  risk: { discovery_mutations: "block", irreversible: "escalate" }
};

async function loggerIn(rootList: string[]): Promise<RunLogger> {
  const root = await mkdtemp(path.join(os.tmpdir(), "corepoint-signon-"));
  rootList.push(root);
  const logger = new RunLogger("signon_test", root);
  await logger.initialize();
  return logger;
}

describe("profile sign-on bootstrap", () => {
  it("drives the form through Surface and verifies the authenticated footer", async () => {
    const surface = new SignonSurface("pw");
    const logger = await loggerIn(roots);
    await signOn({ surface, policy: new PolicyEngine(config), logger, profile, credentials: { operator: "teller1", password: "pw", branch: "MAIN-001" } });
    expect(surface.actions.map((action) => action.kind)).toEqual(["navigate", "type", "type", "select", "click"]);
    const log = await readFile(path.join(logger.directory, "log.jsonl"), "utf8");
    expect(log).toContain('"type":"signed_on"');
    // The password was registered as sensitive before any event was written.
    expect(log).not.toContain("pw\"");
  });

  it("refuses cleanly when the application rejects the credentials", async () => {
    const surface = new SignonSurface("other");
    const logger = await loggerIn(roots);
    await expect(signOn({ surface, policy: new PolicyEngine(config), logger, profile, credentials: { operator: "teller1", password: "wrong", branch: "MAIN-001" } }))
      .rejects.toThrow(/Sign-on was refused for operator "teller1"/);
  });

  it("never lets sign-on act outside policy", async () => {
    const surface = new SignonSurface("pw");
    const logger = await loggerIn(roots);
    const narrow = new PolicyEngine({ ...config, allowed_origins: ["https://elsewhere.test"] });
    await expect(signOn({ surface, policy: narrow, logger, profile, credentials: { operator: "teller1", password: "pw" } }))
      .rejects.toThrow(/Sign-on blocked by policy/);
    // Nothing was typed anywhere: the navigation was refused before any field.
    expect(surface.actions).toHaveLength(0);
  });
});
