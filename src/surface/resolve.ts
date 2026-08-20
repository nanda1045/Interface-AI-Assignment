// Deterministic replay resolver. It translates each saved locator strategy back
// into Playwright, walks the ladder in stored order, and accepts only one visible,
// enabled match while retaining every attempt for telemetry and failure evidence.
import type { Frame, Locator, Page } from "playwright";
import { getFramePath } from "./digest.js";
import { locatorForAdjacentCell, locatorForNearbyLabel } from "./locators.js";
import type { LocatorStrategy, ResolutionAttempt, ResolutionFailure, ResolvedElement, TargetSpec } from "./types.js";

// Match an artifact's recorded logical frame path to the current live frame.
function findFrame(page: Page, path: string): Frame | undefined {
  return page.frames().find((frame) => getFramePath(frame) === path);
}

// For the weakest fallback, rank actionable elements by normalised distance and
// optional nearby-text agreement. Reject the best candidate when it moved too far.
async function geometryLocator(frame: Frame, strategy: Extract<LocatorStrategy, { kind: "geometry" }>): Promise<{ locator: Locator; tooFar: boolean }> {
  const candidates = frame.locator("a,button,input,select,textarea,[role],[onclick],[tabindex]");
  const ranked = await candidates.evaluateAll((elements, target) => {
    const targetCenter: [number, number] = [(target.bbox[0] ?? 0) + (target.bbox[2] ?? 0) / 2, (target.bbox[1] ?? 0) + (target.bbox[3] ?? 0) / 2];
    const clean = (value: string | null | undefined): string => (value ?? "").replace(/\s+/g, " ").trim();
    return elements.flatMap((element, index) => {
      const rect = (element as HTMLElement).getBoundingClientRect();
      const style = getComputedStyle(element as HTMLElement);
      if (style.display === "none" || style.visibility === "hidden" || rect.width === 0 || rect.height === 0) return [];
      const center: [number, number] = [(rect.x + rect.width / 2) / Math.max(innerWidth, 1), (rect.y + rect.height / 2) / Math.max(innerHeight, 1)];
      const distance = Math.hypot(center[0] - targetCenter[0], center[1] - targetCenter[1]);
      const nearbyText = clean(element.getAttribute("aria-label")) || clean(element.closest("label")?.textContent) || clean(element.closest("td")?.previousElementSibling?.textContent) || clean(element.textContent);
      const anchorPenalty = target.nearText && !nearbyText.includes(target.nearText) ? 0.2 : 0;
      return [{ index, distance, score: distance + anchorPenalty }];
    }).sort((left, right) => left.score - right.score);
  }, { bbox: strategy.bboxPct, nearText: strategy.nearText });
  const best = ranked[0];
  return { locator: candidates.nth(best?.index ?? -1), tooFar: !best || best.score > 0.12 };
}

// Convert one provider-neutral artifact strategy into its Playwright locator.
// Structural values are trusted-code-generated XPath saved during discovery.
async function strategyLocator(frame: Frame, strategy: LocatorStrategy): Promise<{ locator: Locator; tooFar?: boolean }> {
  switch (strategy.kind) {
    case "role_name":
      return { locator: frame.getByRole(strategy.role as Parameters<Frame["getByRole"]>[0], { name: strategy.name, exact: true }) };
    case "label_proximity":
      return { locator: await locatorForNearbyLabel(frame, strategy.label, strategy.control) };
    case "text":
      return { locator: strategy.control ? frame.locator(strategy.control).filter({ hasText: strategy.value }) : frame.getByText(strategy.value, { exact: true }) };
    case "label_adjacent_cell":
      return { locator: locatorForAdjacentCell(frame, strategy.label) };
    case "attr_css":
      return { locator: frame.locator(strategy.value) };
    case "structural":
      return { locator: frame.locator(`xpath=${strategy.value}`) };
    case "geometry":
      return geometryLocator(frame, strategy);
  }
}

// Walk strongest to weakest. A failed rung never throws away its diagnostic;
// replay either returns the first safe match or the complete exhausted ladder.
export async function resolveTarget(page: Page, target: TargetSpec, refFactory: () => string): Promise<ResolvedElement | ResolutionFailure> {
  const attempts: ResolutionAttempt[] = [];
  for (const [tier, strategy] of target.strategies.entries()) {
    const framePath = strategy.frame || target.frame || "main";
    const frame = findFrame(page, framePath);
    if (!frame) {
      attempts.push({ strategy, matched: 0, reason: "frame_not_found" });
      continue;
    }
    await frame.evaluate("globalThis.__name ||= ((target) => target)");
    const candidate = await strategyLocator(frame, strategy);

    // Geometry outside the capture tolerance is rejected rather than clicking
    // whichever element merely happens to be nearest.
    if (candidate.tooFar) {
      attempts.push({ strategy, matched: 0, reason: "geometry_too_far" });
      continue;
    }

    // Recheck uniqueness, visibility, and enabled state on the current page;
    // capture-time verification is not assumed to remain true forever.
    const matched = await candidate.locator.count();
    if (matched !== 1) {
      attempts.push({ strategy, matched, reason: "not_unique" });
      continue;
    }
    if (!(await candidate.locator.isVisible())) {
      attempts.push({ strategy, matched, reason: "not_visible" });
      continue;
    }
    if (!(await candidate.locator.isEnabled())) {
      attempts.push({ strategy, matched, reason: "disabled" });
      continue;
    }

    // Attach a fresh internal ref so Surface.act/read can use the resolved node.
    // Return both tier position and actual strategy kind for drift telemetry.
    const ref = refFactory();
    await candidate.locator.evaluate((element, value) => element.setAttribute("data-cu-ref", value), ref);
    attempts.push({ strategy, matched });
    return { ok: true, ref, frame: framePath, matchedStrategy: strategy, tier: tier + 1, attempts };
  }

  // No rung met all safety conditions. The caller returns target_not_found with
  // this attempt history in its redacted failure bundle.
  return { ok: false, reason: "target_not_found", attempts };
}
