import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSurface } from "../../src/surface/web-playwright.js";
import type { LocatorStrategy } from "../../src/surface/types.js";

let browser: Browser;
let page: Page;
let surface: WebSurface;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await page.setContent(`
    <h1>Legacy Core</h1>
    <button aria-label="Save record">Disk icon</button>
    <iframe name="workarea" title="Workspace" srcdoc="
      <html><body>
        <h2>Member Search</h2>
        <table><tr><td>Member No.</td><td><input name='f_mno'></td></tr></table>
        <table><tr><td>Regular Savings</td><td>$2,481.13</td></tr></table>
        <a href='#member'>Open Member</a>
        <button>Search</button>
      </body></html>
    "></iframe>
  `);
  await page.frame({ name: "workarea" })?.waitForLoadState();
  surface = new WebSurface(page, { browser });
});

afterAll(async () => {
  await surface.close();
});

describe("WebSurface", () => {
  it("builds a frame-aware digest with labels inferred from table proximity", async () => {
    const observation = await surface.observe({ screenshot: true });
    const field = observation.elements.find((element) => element.hints.nearLabel === "Member No.");
    // Frames carry where they are, not just what they are called: a framed app
    // can lose its session inside the workspace while the top document stays put.
    // This fixture uses a srcdoc frame, so its location is "about:srcdoc" - a
    // reminder that a frame URL is not always parseable and a detector reading
    // one must not throw. The live-app case is covered in the replay tests.
    expect(observation.frames.map((frame) => frame.path)).toContain("workarea");
    expect(typeof observation.frames.find((frame) => frame.path === "workarea")?.url).toBe("string");
    expect(field).toMatchObject({ frame: "workarea", role: "textbox", name: "Member No.", state: { visible: true, enabled: true } });
    expect(observation.screenshot).toMatch(/^data:image\/png;base64,/);
    expect(observation.stateHash).toHaveLength(20);
  });

  it("captures only unique, verified strategies in confidence order", async () => {
    const observation = await surface.observe();
    const field = observation.elements.find((element) => element.hints.nearLabel === "Member No.");
    expect(field).toBeDefined();
    const bundle = await surface.captureLocators(field!.ref);
    expect(bundle.strategies.map((strategy) => strategy.kind)).toEqual(["label_proximity", "attr_css", "structural", "geometry"]);
    expect(bundle.strategies.every((strategy) => strategy.unique)).toBe(true);
    expect(bundle.strategies.map((strategy) => strategy.confidence)).toEqual([...bundle.strategies.map((strategy) => strategy.confidence)].sort((a, b) => b - a));
  });

  it("observes table outputs and captures a value-independent adjacent-cell locator", async () => {
    const observation = await surface.observe();
    const balance = observation.elements.find((element) => element.role === "cell" && element.text === "$2,481.13");
    expect(balance).toBeDefined();
    const bundle = await surface.captureLocators(balance!.ref);
    expect(bundle.strategies[0]).toMatchObject({ kind: "label_adjacent_cell", label: "Regular Savings", frame: "workarea", unique: true });
  });

  it("resolves role, label, text, attribute, structural, and geometry tiers inside frames", async () => {
    const observation = await surface.observe();
    const save = observation.elements.find((element) => element.name === "Save record");
    const field = observation.elements.find((element) => element.hints.nearLabel === "Member No.");
    const link = observation.elements.find((element) => element.text === "Open Member");
    expect(save && field && link).toBeTruthy();

    const bundles = {
      save: await surface.captureLocators(save!.ref),
      field: await surface.captureLocators(field!.ref),
      link: await surface.captureLocators(link!.ref)
    };
    const byKind = (strategies: LocatorStrategy[], kind: LocatorStrategy["kind"]) => {
      const strategy = strategies.find((candidate) => candidate.kind === kind);
      if (!strategy) throw new Error(`Missing ${kind} test strategy`);
      return strategy;
    };
    const cases: [LocatorStrategy, string][] = [
      [byKind(bundles.save.strategies, "role_name"), "main"],
      [byKind(bundles.field.strategies, "label_proximity"), "workarea"],
      [byKind(bundles.link.strategies, "text"), "workarea"],
      [byKind(bundles.field.strategies, "attr_css"), "workarea"],
      [byKind(bundles.field.strategies, "structural"), "workarea"],
      [byKind(bundles.field.strategies, "geometry"), "workarea"]
    ];
    for (const [strategy, expectedFrame] of cases) {
      const resolution = await surface.resolve({ frame: strategy.frame, strategies: [strategy] });
      expect(resolution).toMatchObject({ ok: true, frame: expectedFrame, tier: 1 });
    }
  });

  it("walks the ladder after a failed strategy and reports tier telemetry", async () => {
    const observation = await surface.observe();
    const field = observation.elements.find((element) => element.hints.nearLabel === "Member No.")!;
    const bundle = await surface.captureLocators(field.ref);
    const valid = bundle.strategies.find((strategy) => strategy.kind === "attr_css")!;
    const broken: LocatorStrategy = { kind: "attr_css", value: "input[name='removed']", frame: "workarea", unique: true, confidence: 0.7 };
    const resolution = await surface.resolve({ frame: "workarea", strategies: [broken, valid] });
    expect(resolution).toMatchObject({ ok: true, tier: 2 });
    if (resolution.ok) expect(resolution.attempts[0]).toMatchObject({ matched: 0, reason: "not_unique" });
  });

  it("acts through observation refs inside the iframe", async () => {
    const observation = await surface.observe();
    const field = observation.elements.find((element) => element.hints.nearLabel === "Member No.")!;
    await surface.act({ kind: "type", ref: field.ref, text: "4521" });
    expect(await page.frame({ name: "workarea" })!.locator("input[name='f_mno']").inputValue()).toBe("4521");
  });
});
