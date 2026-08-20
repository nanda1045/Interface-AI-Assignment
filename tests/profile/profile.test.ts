import { describe, expect, it } from "vitest";
import { appProfileSchema, loadProfile, profileForApp, profileForOrigin, resolveCredentials } from "../../src/profile/profile.js";
import { corePointSignatures, detectEscalation, detectGlobalFailure } from "../../src/replay/detectors.js";
import type { Observation } from "../../src/surface/types.js";

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

  it("routes the supervisor wall to escalation", async () => {
    const meridian = await loadProfile("profiles/meridian.yaml");
    // MERIDIAN phrases the wall two ways; the second exists only in its profile.
    expect(detectEscalation(observing("SUPERVISOR OVERRIDE REQUIRED"), meridian.detectors)).toBeDefined();
    expect(detectEscalation(observing("A supervisor must sign on to complete this request."), meridian.detectors)).toBeDefined();
    expect(detectEscalation(observing("A supervisor must sign on to complete this request."))).toBeUndefined();
  });

  it("keeps the unknown-dialog rule regardless of profile", async () => {
    const meridian = await loadProfile("profiles/meridian.yaml");
    const withDialog: Observation = { ...observing("anything"), elements: [{ ref: "d1", frame: "main", role: "dialog", name: "Confirm", state: { visible: true, enabled: true }, bboxPct: [0, 0, 1, 1], hints: {} }] };
    expect(detectEscalation(withDialog, meridian.detectors)?.reason).toContain("Unrecognized dialog");
  });
});
