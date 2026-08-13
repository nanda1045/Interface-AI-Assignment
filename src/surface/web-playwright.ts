import type { Browser, BrowserContext, Locator, Page } from "playwright";
import { digestFrame, getFramePath, stateHash } from "./digest.js";
import { captureLocatorBundle } from "./locators.js";
import { resolveTarget } from "./resolve.js";
import type { AbstractAction, ActResult, DigestElement, ElementRef, LocatorBundle, Observation, ResolutionFailure, ResolvedElement, Surface, TargetSpec } from "./types.js";

export interface WebSurfaceOptions {
  browser?: Browser;
  context?: BrowserContext;
  canAgentAct?: () => boolean;
}

export class WebSurface implements Surface {
  private observationSequence = 0;
  private refSequence = 0;
  private readonly observedElements = new Map<ElementRef, DigestElement>();

  public constructor(
    private readonly page: Page,
    private readonly options: WebSurfaceOptions = {}
  ) {}

  private nextRef(prefix = "e"): string {
    this.refSequence += 1;
    return `${prefix}${this.refSequence}`;
  }

  private async locatorForRef(ref: ElementRef): Promise<Locator> {
    for (const frame of this.page.frames()) {
      const candidate = frame.locator(`[data-cu-ref="${ref}"]`);
      if (await candidate.count() === 1) return candidate;
    }
    throw new Error(`Unknown or ambiguous element ref: ${ref}`);
  }

  public async observe(options: { screenshot?: boolean } = {}): Promise<Observation> {
    this.observationSequence += 1;
    const observationId = `o${this.observationSequence}`;
    const elements = (await Promise.all(this.page.frames().map((frame, index) => digestFrame(frame, `${observationId}f${index}`)))).flat();
    this.observedElements.clear();
    for (const element of elements) this.observedElements.set(element.ref, element);
    const screenshot = options.screenshot ? `data:image/png;base64,${(await this.page.screenshot()).toString("base64")}` : undefined;
    return {
      url: this.page.url(),
      title: await this.page.title(),
      frames: this.page.frames().map(getFramePath),
      elements,
      ...(screenshot ? { screenshot } : {}),
      stateHash: stateHash(elements, this.page.url())
    };
  }

  public async act(action: AbstractAction): Promise<ActResult> {
    if (this.options.canAgentAct && !this.options.canAgentAct()) throw new Error("NotLeaseHolder: agent does not hold the control lease");
    switch (action.kind) {
      case "navigate":
        await this.page.goto(action.url, { waitUntil: "domcontentloaded" });
        break;
      case "click":
        await (await this.locatorForRef(action.ref)).click();
        break;
      case "focus":
        await (await this.locatorForRef(action.ref)).focus();
        break;
      case "type":
        await (await this.locatorForRef(action.ref)).fill(action.text);
        break;
      case "select":
        await (await this.locatorForRef(action.ref)).selectOption(action.value);
        break;
      case "press":
        await this.page.keyboard.press(action.key);
        break;
      case "scroll":
        await this.page.mouse.wheel(0, action.direction === "down" ? 600 : -600);
        break;
    }
    return { ok: true, url: this.page.url() };
  }

  public async captureLocators(ref: ElementRef): Promise<LocatorBundle> {
    const observation = this.observedElements.get(ref);
    if (!observation) throw new Error(`Unknown or stale element ref: ${ref}`);
    for (const candidate of this.page.frames()) {
      const locator = candidate.locator(`[data-cu-ref="${ref}"]`);
      if (await locator.count() !== 1) continue;
      return captureLocatorBundle(candidate, observation);
    }
    throw new Error(`Element ref ${ref} is not attached to a known frame.`);
  }

  public resolve(target: TargetSpec): Promise<ResolvedElement | ResolutionFailure> {
    return resolveTarget(this.page, target, () => this.nextRef("r"));
  }

  public async snapshotDom(): Promise<string> {
    const snapshots = await Promise.all(this.page.frames().map(async (frame) => `<!-- frame:${getFramePath(frame)} url:${frame.url()} -->\n${await frame.content()}`));
    return snapshots.join("\n");
  }

  public async close(): Promise<void> {
    if (this.options.context) await this.options.context.close();
    if (this.options.browser) await this.options.browser.close();
  }
}
