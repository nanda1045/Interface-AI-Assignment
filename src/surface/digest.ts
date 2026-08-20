// Converts a live Playwright frame into the compact semantic element list used
// by discovery. It assigns temporary refs, infers accessible meaning and nearby
// context, and builds a layout-insensitive state hash for stuck-loop detection.
import { createHash } from "node:crypto";
import type { Frame } from "playwright";
import type { DigestElement } from "./types.js";

interface RawDigestElement extends Omit<DigestElement, "ref" | "frame"> {
  localRef: string;
}

// Inspect interactive controls plus headings, table cells, and status regions
// that may contain navigation context, business outcomes, or requested outputs.
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
  // Tables are observable as whole elements so a model can mark one as an
  // output; their cells stay individually observable for label heuristics.
  "table",
  "th",
  "td",
  "[aria-live]",
  ".notice"
].join(",");

// Give each nested iframe a stable, human-readable path using its name or URL
// path. The main document is always called "main".
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

// Evaluate trusted extraction code inside one frame. The model never supplies
// this code and receives only the returned DigestElement objects.
export async function digestFrame(frame: Frame, observationId: string): Promise<DigestElement[]> {
  // Supply a small helper needed when tsx/esbuild serializes named callbacks for
  // execution inside the browser rather than the Node.js module environment.
  await frame.evaluate("globalThis.__name ||= ((target) => target)");
  const raw = await frame.locator(digestSelector).evaluateAll((nodes, prefix) => {
    // Normalise whitespace so names, logs, and state hashes remain stable across
    // formatting-only HTML changes.
    const clean = (value: string | null | undefined): string => (value ?? "").replace(/\s+/g, " ").trim();

    // Infer common accessibility roles when legacy HTML does not declare them.
    const implicitRole = (element: Element): string => {
      const tag = element.tagName.toLowerCase();
      if (tag === "a" && element.hasAttribute("href")) return "link";
      if (tag === "button") return "button";
      if (tag === "select") return "combobox";
      if (tag === "textarea") return "textbox";
      if (tag === "h1" || tag === "h2" || tag === "h3") return "heading";
      if (tag === "table") return "table";
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

    // Find a useful field label through ARIA, label[for], wrapping labels, legacy
    // adjacent table cells, and finally placeholders.
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

    // Add the nearest heading above an element as optional semantic context.
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

      // Attach an observation-scoped ref so later trusted code can map a model
      // choice back to this exact DOM node. It is never saved as a replay locator.
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
      // A select's option VALUES are not visible as text ("Last Name" may
      // submit as "name"); without them the model can only guess.
      const options = element.tagName.toLowerCase() === "select"
        ? [...(element as HTMLSelectElement).options].map((option) => ({ value: option.value, label: clean(option.textContent) }))
        : undefined;
      return [{
        localRef,
        role,
        name: semanticName,
        ...(text ? { text } : {}),
        ...(typeof control.value === "string" && control.value ? { value: control.value } : {}),
        ...(options ? { options } : {}),
        state: { visible, enabled: !(control.disabled ?? false) },
        // Viewport-relative geometry is more portable than raw pixel coordinates
        // and is used only as the weakest locator fallback.
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

  // Resolve the frame path after extraction so an iframe swap cannot give the
  // digest and its later locator bundle two different frame names.
  const framePath = getFramePath(frame);
  return raw.map(({ localRef, ...element }) => ({ ...element, ref: localRef, frame: framePath }));
}

// Hash meaningful UI state but exclude temporary refs, bounding boxes, and hints.
// This detects repeated logical screens without treating layout movement or a
// newly generated observation ID as progress.
export function stateHash(elements: DigestElement[], url: string): string {
  const stableState = elements.map(({ role, name, text, value, state, frame }) => ({ role, name, text, value, state, frame }));
  return createHash("sha256").update(JSON.stringify({ url, elements: stableState })).digest("hex").slice(0, 20);
}
