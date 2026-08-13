import { createHash } from "node:crypto";
import type { Frame } from "playwright";
import type { DigestElement } from "./types.js";

interface RawDigestElement extends Omit<DigestElement, "ref" | "frame"> {
  localRef: string;
}

const digestSelector = [
  "a",
  "button",
  "input",
  "select",
  "textarea",
  "[role]",
  "[onclick]",
  "[tabindex]",
  "h1",
  "h2",
  "h3",
  "th",
  "td",
  "[aria-live]",
  ".notice"
].join(",");

export function getFramePath(frame: Frame): string {
  const segments: string[] = [];
  let current: Frame | null = frame;
  while (current?.parentFrame()) {
    let urlPath = "";
    try { urlPath = new URL(current.url()).pathname; } catch { urlPath = ""; }
    segments.unshift(current.name() || urlPath || "anonymous-frame");
    current = current.parentFrame();
  }
  return segments.length === 0 ? "main" : segments.join(" > ");
}

export async function digestFrame(frame: Frame, observationId: string): Promise<DigestElement[]> {
  const framePath = getFramePath(frame);
  // tsx/esbuild may preserve callback names with this helper. Browser-evaluated
  // callbacks are serialized without the module prelude, so provide the tiny
  // identity helper inside each frame before evaluating the digest function.
  await frame.evaluate("globalThis.__name ||= ((target) => target)");
  const raw = await frame.locator(digestSelector).evaluateAll((nodes, prefix) => {
    const clean = (value: string | null | undefined): string => (value ?? "").replace(/\s+/g, " ").trim();
    const implicitRole = (element: Element): string => {
      const tag = element.tagName.toLowerCase();
      if (tag === "a" && element.hasAttribute("href")) return "link";
      if (tag === "button") return "button";
      if (tag === "select") return "combobox";
      if (tag === "textarea") return "textbox";
      if (tag === "h1" || tag === "h2" || tag === "h3") return "heading";
      if (tag === "th") return "columnheader";
      if (tag === "td") return "cell";
      if (tag === "input") {
        const type = (element.getAttribute("type") ?? "text").toLowerCase();
        if (["button", "submit", "reset"].includes(type)) return "button";
        if (type === "checkbox") return "checkbox";
        if (type === "radio") return "radio";
        return "textbox";
      }
      return element.getAttribute("role") ?? "text";
    };
    const nearbyLabel = (element: Element): string => {
      const htmlElement = element as HTMLElement;
      const ariaLabel = clean(element.getAttribute("aria-label"));
      if (ariaLabel) return ariaLabel;
      const labelledBy = element.getAttribute("aria-labelledby");
      if (labelledBy) {
        const labelledText = clean(labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent).join(" "));
        if (labelledText) return labelledText;
      }
      if (htmlElement.id) {
        const explicit = document.querySelector(`label[for="${CSS.escape(htmlElement.id)}"]`);
        if (explicit) return clean(explicit.textContent);
      }
      const wrapping = element.closest("label");
      if (wrapping) return clean(wrapping.textContent);
      const cell = element.closest("td");
      const previousCell = cell?.previousElementSibling;
      if (previousCell) return clean(previousCell.textContent);
      return clean(element.getAttribute("placeholder"));
    };
    const sectionHeading = (element: Element): string => {
      const candidates = [...document.querySelectorAll("h1,h2,h3")];
      const top = element.getBoundingClientRect().top;
      return clean(candidates.filter((heading) => heading.getBoundingClientRect().top <= top).at(-1)?.textContent);
    };

    return nodes.flatMap((element, index): RawDigestElement[] => {
      const htmlElement = element as HTMLElement;
      const style = getComputedStyle(htmlElement);
      const rect = htmlElement.getBoundingClientRect();
      const visible = style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      if (!visible) return [];
      const localRef = `${prefix}-${index}`;
      htmlElement.setAttribute("data-cu-ref", localRef);
      const role = element.getAttribute("role") ?? implicitRole(element);
      const text = clean(element.textContent);
      const nearLabel = ["input", "select", "textarea", "button"].includes(element.tagName.toLowerCase()) ? nearbyLabel(element) : "";
      const semanticName = clean(element.getAttribute("aria-label")) ||
        clean(element.getAttribute("title")) ||
        (role === "textbox" || role === "combobox" ? nearLabel : text) ||
        clean(element.getAttribute("name"));
      const control = element as HTMLInputElement;
      return [{
        localRef,
        role,
        name: semanticName,
        ...(text ? { text } : {}),
        ...(typeof control.value === "string" && control.value ? { value: control.value } : {}),
        state: { visible, enabled: !(control.disabled ?? false) },
        bboxPct: [
          rect.x / Math.max(window.innerWidth, 1),
          rect.y / Math.max(window.innerHeight, 1),
          rect.width / Math.max(window.innerWidth, 1),
          rect.height / Math.max(window.innerHeight, 1)
        ],
        hints: {
          ...(nearLabel ? { nearLabel } : {}),
          ...(sectionHeading(element) ? { sectionHeading: sectionHeading(element) } : {})
        }
      }];
    });
  }, observationId);

  return raw.map(({ localRef, ...element }) => ({ ...element, ref: localRef, frame: framePath }));
}

export function stateHash(elements: DigestElement[], url: string): string {
  const stableState = elements.map(({ role, name, text, value, state, frame }) => ({ role, name, text, value, state, frame }));
  return createHash("sha256").update(JSON.stringify({ url, elements: stableState })).digest("hex").slice(0, 20);
}
