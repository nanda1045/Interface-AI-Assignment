import type { Page } from "playwright";
import type { RunLogger } from "../evidence/run-logger.js";
import { REDACTED } from "../policy/redact.js";
import type { RunController } from "./controller.js";

interface HumanBrowserEvent { kind: "click" | "key" | "input" | "navigation"; control?: string; value?: string; url?: string }

const installListeners = () => {
  if ((globalThis as typeof globalThis & { __cuHumanRecorder?: boolean }).__cuHumanRecorder) return;
  (globalThis as typeof globalThis & { __cuHumanRecorder?: boolean }).__cuHumanRecorder = true;
  const describe = (target: EventTarget | null): string => {
    const element = target instanceof Element ? target : null;
    if (!element) return "unknown";
    return element.getAttribute("aria-label") || element.getAttribute("name") || element.textContent?.replace(/\s+/g, " ").trim().slice(0, 80) || element.tagName.toLowerCase();
  };
  const sensitive = (target: EventTarget | null): boolean => {
    const element = target instanceof HTMLInputElement ? target : null;
    return Boolean(element && (element.type === "password" || /pass|code|ssn|token|secret/i.test(`${element.name} ${element.getAttribute("aria-label") ?? ""}`)));
  };
  document.addEventListener("click", (event) => void (globalThis as unknown as { __recordHuman: (event: HumanBrowserEvent) => Promise<void> }).__recordHuman({ kind: "click", control: describe(event.target) }), true);
  document.addEventListener("keydown", (event) => void (globalThis as unknown as { __recordHuman: (event: HumanBrowserEvent) => Promise<void> }).__recordHuman({ kind: "key", control: describe(event.target), value: sensitive(event.target) ? "«redacted»" : event.key }), true);
  document.addEventListener("change", (event) => void (globalThis as unknown as { __recordHuman: (event: HumanBrowserEvent) => Promise<void> }).__recordHuman({ kind: "input", control: describe(event.target), value: "«redacted»" }), true);
};

export async function installHumanRecorder(page: Page, controller: RunController, logger: RunLogger): Promise<void> {
  await page.exposeBinding("__recordHuman", async (_source, event: HumanBrowserEvent) => {
    if (controller.lease.current().phase !== "human_control") return;
    await logger.event({ type: "human_action", action: { ...event, ...(event.value === REDACTED ? { value: REDACTED } : {}) } });
  });
  await page.addInitScript(installListeners);
  for (const frame of page.frames()) await frame.evaluate(installListeners).catch(() => undefined);
  page.on("framenavigated", async (frame) => {
    if (controller.lease.current().phase !== "human_control") return;
    await logger.event({ type: "human_action", action: { kind: "navigation", url: frame.url() } });
  });
}
