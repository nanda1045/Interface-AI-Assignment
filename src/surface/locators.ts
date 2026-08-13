import type { Frame, Locator } from "playwright";
import { getFramePath } from "./digest.js";
import type { DigestElement, LocatorBundle, LocatorStrategy } from "./types.js";

export function cssAttributeSelector(tag: string, attribute: "id" | "name", value: string): string {
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return attribute === "id" ? `${tag}[id="${escaped}"]` : `${tag}[name="${escaped}"]`;
}

async function sameNode(candidate: Locator, localRef: string): Promise<boolean> {
  if (await candidate.count() !== 1) return false;
  return candidate.evaluate((element, expected) => element.getAttribute("data-cu-ref") === expected, localRef);
}

async function absoluteXPath(locator: Locator): Promise<string> {
  return locator.evaluate((element) => {
    const segments: string[] = [];
    let current: Element | null = element;
    while (current && current.nodeType === Node.ELEMENT_NODE) {
      const tag = current.tagName.toLowerCase();
      const siblings = current.parentElement ? [...current.parentElement.children].filter((sibling) => sibling.tagName === current?.tagName) : [];
      const position = siblings.length > 1 ? `[${siblings.indexOf(current) + 1}]` : "";
      segments.unshift(`${tag}${position}`);
      current = current.parentElement;
    }
    return `/${segments.join("/")}`;
  });
}

async function geometryIsUnique(frame: Frame, element: DigestElement): Promise<boolean> {
  const candidates = frame.locator("a,button,input,select,textarea,[role],[onclick],[tabindex]");
  const ranked = await candidates.evaluateAll((nodes, target) => {
    const clean = (value: string | null | undefined): string => (value ?? "").replace(/\s+/g, " ").trim();
    const center: [number, number] = [
      (target.bbox[0] ?? 0) + (target.bbox[2] ?? 0) / 2,
      (target.bbox[1] ?? 0) + (target.bbox[3] ?? 0) / 2
    ];
    return nodes.flatMap((node) => {
      const htmlNode = node as HTMLElement;
      const rect = htmlNode.getBoundingClientRect();
      const style = getComputedStyle(htmlNode);
      if (style.display === "none" || style.visibility === "hidden" || rect.width === 0 || rect.height === 0) return [];
      const candidateCenter: [number, number] = [
        (rect.x + rect.width / 2) / Math.max(innerWidth, 1),
        (rect.y + rect.height / 2) / Math.max(innerHeight, 1)
      ];
      const distance = Math.hypot(candidateCenter[0] - center[0], candidateCenter[1] - center[1]);
      const nearbyText = clean(node.getAttribute("aria-label")) || clean(node.closest("label")?.textContent) || clean(node.closest("td")?.previousElementSibling?.textContent) || clean(node.textContent);
      const anchorPenalty = target.nearText && !nearbyText.includes(target.nearText) ? 0.2 : 0;
      return [{ ref: node.getAttribute("data-cu-ref"), score: distance + anchorPenalty }];
    }).sort((left, right) => left.score - right.score);
  }, { bbox: element.bboxPct, nearText: element.hints.nearLabel ?? element.text });
  const best = ranked[0];
  const runnerUp = ranked[1];
  return Boolean(best && best.ref === element.ref && best.score <= 0.12 && (!runnerUp || runnerUp.score - best.score > 0.005));
}

export async function locatorForNearbyLabel(frame: Frame, label: string, control: string): Promise<Locator> {
  const candidates = frame.locator(control);
  const matches = await candidates.evaluateAll((elements, expected) => {
    const clean = (value: string | null | undefined): string => (value ?? "").replace(/\s+/g, " ").trim();
    return elements.flatMap((element, index) => {
      const htmlElement = element as HTMLElement;
      const explicit = htmlElement.id ? document.querySelector(`label[for="${CSS.escape(htmlElement.id)}"]`) : null;
      const actual = clean(element.getAttribute("aria-label")) || clean(explicit?.textContent) || clean(element.closest("label")?.textContent) || clean(element.closest("td")?.previousElementSibling?.textContent) || clean(element.getAttribute("placeholder"));
      return actual === expected ? [index] : [];
    });
  }, label);
  return matches.length === 1 ? candidates.nth(matches[0] ?? -1) : candidates.filter({ has: frame.locator(":scope:not(*)") });
}

export function locatorForAdjacentCell(frame: Frame, label: string): Locator {
  return frame.locator("td").filter({ hasText: label }).locator("xpath=following-sibling::td[1]");
}

export async function captureLocatorBundle(frame: Frame, element: DigestElement): Promise<LocatorBundle> {
  const localRef = element.ref;
  const source = frame.locator(`[data-cu-ref="${localRef}"]`);
  if (await source.count() !== 1) throw new Error(`Element ref ${localRef} is stale; observe again before capturing locators.`);
  const framePath = getFramePath(frame);
  const strategies: LocatorStrategy[] = [];
  const tag = await source.evaluate((node) => node.tagName.toLowerCase());
  const attributes = await source.evaluate((node) => ({ id: node.getAttribute("id"), name: node.getAttribute("name") }));

  if (element.role && element.name && !["cell", "columnheader", "text"].includes(element.role)) {
    const candidate = frame.getByRole(element.role as Parameters<Frame["getByRole"]>[0], { name: element.name, exact: true });
    if (await sameNode(candidate, localRef)) strategies.push({ kind: "role_name", role: element.role, name: element.name, frame: framePath, unique: true, confidence: 0.9 });
  }

  if (element.hints.nearLabel && ["input", "select", "textarea", "button"].includes(tag)) {
    const candidate = await locatorForNearbyLabel(frame, element.hints.nearLabel, tag);
    if (await sameNode(candidate, localRef)) strategies.push({ kind: "label_proximity", label: element.hints.nearLabel, control: tag, frame: framePath, unique: true, confidence: 0.85 });
  }

  if (element.text && ["a", "button"].includes(tag)) {
    const candidate = frame.locator(tag).filter({ hasText: element.text });
    if (await sameNode(candidate, localRef)) strategies.push({ kind: "text", value: element.text, control: tag, frame: framePath, unique: true, confidence: 0.8 });
  }

  if (tag === "td") {
    const previousText = await source.evaluate((node) => node.previousElementSibling?.textContent?.replace(/\s+/g, " ").trim() ?? "");
    if (previousText && await sameNode(locatorForAdjacentCell(frame, previousText), localRef)) {
      strategies.push({ kind: "label_adjacent_cell", label: previousText, frame: framePath, unique: true, confidence: 0.85 });
    }
  }

  for (const attribute of ["name", "id"] as const) {
    const value = attributes[attribute];
    if (!value) continue;
    const selector = cssAttributeSelector(tag, attribute, value);
    if (await sameNode(frame.locator(selector), localRef)) {
      strategies.push({ kind: "attr_css", value: selector, frame: framePath, unique: true, confidence: attribute === "id" ? 0.75 : 0.7 });
      break;
    }
  }

  const xpath = await absoluteXPath(source);
  if (await sameNode(frame.locator(`xpath=${xpath}`), localRef)) strategies.push({ kind: "structural", value: xpath, frame: framePath, unique: true, confidence: 0.5 });
  if (await geometryIsUnique(frame, element)) {
    strategies.push({ kind: "geometry", bboxPct: element.bboxPct, nearText: element.hints.nearLabel ?? element.text, frame: framePath, unique: true, confidence: 0.35 });
  }

  return { capturedAt: new Date().toISOString(), strategies };
}
