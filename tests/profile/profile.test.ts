import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { appProfileSchema, loadProfile, profileForApp, profileForOrigin, resolveCredentials } from "../../src/profile/profile.js";
import { corePointSignatures, detectEscalation, detectGlobalFailure } from "../../src/replay/detectors.js";
import type { Observation } from "../../src/surface/types.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function observing(text: string, url = "https://web-sample.interface-hiring.com/members/100234"): Observation {
  return {
    url, title: "Meridian Core", frames: [{ path: "main", url }],
    elements: [{ ref: "e1", frame: "main", role: "heading", name: text, text, state: { visible: true, enabled: true }, bboxPct: [0, 0, 1, 0.1], hints: {} }],
    stateHash: "x"
  };
}

describe("app profiles", () => {
  it("loads both shipped profiles through the strict schema", async () => {
    const corepoint = await loadProfile("profiles/corepoint.yaml");
    const meridian = await loadProfile("profiles/meridian.yaml");
    expect(corepoint.app.id).toBe("corepoint-teller");
    expect(meridian.app.id).toBe("meridian-core");
    expect(meridian.signon?.url).toContain("/signon");
  });

  it("rejects a profile with fields it does not understand", () => {
    expect(() => appProfileSchema.parse({ app: { id: "x", vendor: "v", ui_version_range: "1", origin: "https://x.test" }, policy: "p", detectors: corePointSignatures, outcome_templates: [], recovery_templates: [], surprise: true }))
      .toThrow();
  });

  it("selects a profile by the artifact's app id and by origin, not by guesswork", async () => {
    expect((await profileForApp("meridian-core"))?.app.origin).toBe("https://web-sample.interface-hiring.com");
    expect((await profileForOrigin("http://localhost:4478"))?.app.id).toBe("corepoint-teller");
    expect(await profileForApp("unknown-app")).toBeUndefined();
  });

  it("pins the corepoint profile to the engine's built-in defaults", async () => {
    // The engine falls back to these constants when no profile is supplied, so
    // the yaml and the code must be the same thing or behaviour would depend on
    // which path loaded the target.
    const corepoint = await loadProfile("profiles/corepoint.yaml");
    expect(corepoint.detectors).toEqual(corePointSignatures);
  });

  it("rejects a profile whose regex fields do not compile, before any browser launches", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "corepoint-profile-"));
    roots.push(root);
    const base = {
      app: { id: "broken-app", vendor: "V", ui_version_range: "1", origin: "https://broken.test" },
      policy: "policies/default.yaml",
      detectors: { session_lost: { paths: [], patterns: [] }, app_error: { patterns: ["ok"] }, escalation: { patterns: [] } },
      outcome_templates: [],
      recovery_templates: []
    };
    // A stray unclosed character class in each regex-bearing field in turn.
    const cases: [string, object][] = [
      ["irreversible_actions", { ...base, irreversible_actions: ["Post Transfer["] }],
      ["detectors.app_error", { ...base, detectors: { ...base.detectors, app_error: { patterns: ["oops("] } } }],
      ["signon.authenticated_pattern", { ...base, signon: { url: "https://broken.test/s", fields: { operator: "o", password: "p" }, authenticated_pattern: "OK[", failure_pattern: "no" } }],
      ["outcome_templates", { ...base, outcome_templates: [{ code: "X", when: [{ kind: "text_visible", pattern: "bad[" }] }] }]
    ];
    for (const [label, profile] of cases) {
      const file = path.join(root, `${label.replace(/\W+/g, "_")}.yaml`);
      await writeFile(file, YAML.stringify(profile));
      await expect(loadProfile(file), label).rejects.toThrow(/invalid regular expression/);
    }
  });

  it("resolves named credentials from the environment without echoing values", async () => {
    const meridian = await loadProfile("profiles/meridian.yaml");
    const env = { MERIDIAN_OPERATOR: "teller1", MERIDIAN_PASSWORD: "pw", MERIDIAN_BRANCH: "MAIN-001" };
    expect(resolveCredentials(meridian, "teller", env)).toEqual({ operator: "teller1", password: "pw", branch: "MAIN-001" });
    expect(() => resolveCredentials(meridian, "teller", {})).toThrow(/MERIDIAN_OPERATOR, MERIDIAN_PASSWORD/);
    expect(() => resolveCredentials(meridian, "nobody", env)).toThrow(/no credential set named "nobody"/);
  });
});

describe("meridian detector signatures", () => {
  it("detects the inline session-timeout page even though the URL never changes", async () => {
    // MERIDIAN renders YOUR SESSION HAS TIMED OUT as a 440 page on the SAME
    // url. Path-based detection alone can never fire on this target, which is
    // why signatures carry text patterns as well.
    const meridian = await loadProfile("profiles/meridian.yaml");
    const result = detectGlobalFailure(observing("YOUR SESSION HAS TIMED OUT"), meridian.detectors);
    expect(result).toMatchObject({ class: "session_lost" });
    expect(detectGlobalFailure(observing("YOUR SESSION HAS TIMED OUT"))).toBeUndefined();
  });

  it("detects MERIDIAN's application-error page", async () => {
    const meridian = await loadProfile("profiles/meridian.yaml");
    expect(detectGlobalFailure(observing("APPLICATION ERROR Reference: ERR-AE078DA1"), meridian.detectors))
      .toMatchObject({ class: "app_error" });
  });

  it("routes the supervisor wall to escalation, but not the hold form's static banner", async () => {
    const meridian = await loadProfile("profiles/meridian.yaml");
    // MERIDIAN phrases the wall two ways; the second exists only in its profile.
    expect(detectEscalation(observing("SUPERVISOR OVERRIDE REQUIRED"), meridian.detectors)).toBeDefined();
    expect(detectEscalation(observing("A supervisor must sign on to complete this request."), meridian.detectors)).toBeDefined();
    expect(detectEscalation(observing("A supervisor must sign on to complete this request."))).toBeUndefined();
    // The PLACE ACCOUNT HOLD form always shows this banner. Escalating on it
    // would pause every hold replay at every step, not just at the real wall.
    expect(detectEscalation(observing("RESTRICTED FUNCTION - SUPERVISOR OVERRIDE REQUIRED"), meridian.detectors)).toBeUndefined();
  });

  it("keeps the unknown-dialog rule regardless of profile", async () => {
    const meridian = await loadProfile("profiles/meridian.yaml");
    const withDialog: Observation = { ...observing("anything"), elements: [{ ref: "d1", frame: "main", role: "dialog", name: "Confirm", state: { visible: true, enabled: true }, bboxPct: [0, 0, 1, 1], hints: {} }] };
    expect(detectEscalation(withDialog, meridian.detectors)?.reason).toContain("Unrecognized dialog");
  });
});
