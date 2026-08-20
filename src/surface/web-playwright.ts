// Concrete Playwright implementation of the browser-independent Surface. This
// is the trusted adapter that turns bounded abstract actions into real browser
// operations and delegates digest, locator capture, and replay resolution.
import type { Browser, BrowserContext, Frame, Locator, Page } from "playwright";
import { digestFrame, getFramePath, stateHash } from "./digest.js";
import { captureLocatorBundle } from "./locators.js";
import { resolveTarget } from "./resolve.js";
import type { AbstractAction, ActResult, DigestElement, ElementRef, LocatorBundle, Observation, ResolutionFailure, ResolvedElement, Surface, TargetSpec } from "./types.js";

// Decide a marked table's shape from its raw rows. A genuine header row is one
// of column LABELS. Two legacy shapes lack a <th>: a data table (MERIDIAN's
// results grid) whose first row is still labels ("Member No.", "Name"), and a
// key:value details panel (a transfer confirmation) whose first row is already
// a VALUE ("Confirmation:", "CN480101"). The tell is the value - a header cell
// carries no data - so a first row with a digit-bearing cell is not a header,
// and the caller reads that table as scalar text instead of freezing a
// run-specific value into a column name.
export function shapeTable(rows: string[][], thIndex: number): { headers: string[]; rows: string[][]; hasHeaderRow: boolean } {
  if (rows.length === 0) return { headers: [], rows: [], hasHeaderRow: false };
  const firstRowIsLabels = (rows[0]?.length ?? 0) >= 2 && rows[0]!.every((cell) => !/\d/.test(cell));
  const hasHeaderRow = thIndex !== -1 || firstRowIsLabels;
  const headerIndex = thIndex !== -1 ? thIndex : 0;
  return {
    headers: rows[headerIndex] ?? [],
    rows: rows.filter((_, index) => index !== headerIndex),
    hasHeaderRow
  };
}

// Browser/context are optional so callers can choose resource ownership. The
// lease callback blocks agent actions while a human controls the same session.
export interface WebSurfaceOptions {
  browser?: Browser;
  context?: BrowserContext;
  canAgentAct?: () => boolean;
}

export class WebSurface implements Surface {
  // Observation refs and replay-resolution refs are unique within this surface.
  // Only elements from the latest observation remain valid for locator capture.
  private observationSequence = 0;
  private refSequence = 0;
  private readonly observedElements = new Map<ElementRef, DigestElement>();

  public constructor(
    private readonly page: Page,
    private readonly options: WebSurfaceOptions = {}
  ) {}

  // Generate trusted internal refs; the model never chooses their format.
  private nextRef(prefix = "e"): string {
    this.refSequence += 1;
    return `${prefix}${this.refSequence}`;
  }

  // Resolve a temporary data-cu-ref across every frame and require exactly one
  // match. The attribute is an internal bridge, not a persisted locator.
  private async locatorWithFrameForRef(ref: ElementRef): Promise<{ frame: Frame; locator: Locator }> {
    for (const frame of this.page.frames()) {
      const candidate = frame.locator(`[data-cu-ref="${ref}"]`);
      if (await candidate.count() === 1) return { frame, locator: candidate };
    }
    throw new Error(`Unknown or ambiguous element ref: ${ref}`);
  }

  private async locatorForRef(ref: ElementRef): Promise<Locator> {
    return (await this.locatorWithFrameForRef(ref)).locator;
  }

  // Build one frame-aware semantic observation. Retry briefly when navigation
  // destroys an execution context while the page is being inspected.
  public async observe(options: { screenshot?: boolean } = {}): Promise<Observation> {
    this.observationSequence += 1;
    const observationId = `o${this.observationSequence}`;
    let elements: DigestElement[] | undefined;
    let frames = this.page.frames();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        frames = this.page.frames();
        elements = (await Promise.all(frames.map((frame, index) => digestFrame(frame, `${observationId}f${index}`)))).flat();
        break;
      } catch (error) {
        if (!/Execution context was destroyed|Frame was detached|Target page, context or browser has been closed/i.test(String(error)) || attempt === 4) throw error;
        await this.page.waitForTimeout(75);
      }
    }
    if (!elements) throw new Error("Could not observe a stable browser state.");

    // Replace the ref map on every observation so old model refs cannot be used
    // for later locator capture. Screenshots are opt-in evidence only.
    this.observedElements.clear();
    for (const element of elements) this.observedElements.set(element.ref, element);
    const screenshot = options.screenshot ? `data:image/png;base64,${(await this.page.screenshot()).toString("base64")}` : undefined;
    return {
      url: this.page.url(),
      title: await this.page.title(),
      frames: frames.map((frame) => ({ path: getFramePath(frame), url: frame.url() })),
      elements,
      ...(screenshot ? { screenshot } : {}),
      stateHash: stateHash(elements, this.page.url())
    };
  }

  // Enforce the human/agent control lease first, then translate one approved
  // AbstractAction into its Playwright operation.
  public async act(action: AbstractAction): Promise<ActResult> {
    if (this.options.canAgentAct && !this.options.canAgentAct()) throw new Error("NotLeaseHolder: agent does not hold the control lease");
    switch (action.kind) {
      case "navigate":
        await this.page.goto(action.url, { waitUntil: "domcontentloaded" });
        break;
      case "click":
        {
          const { frame, locator } = await this.locatorWithFrameForRef(action.ref);
          // For links and form controls, begin waiting before the click so a fast
          // frame navigation cannot be missed. AJAX-style clicks need no wait.
          const navigatesFrame = await locator.evaluate((element) => {
            const tag = element.tagName.toLowerCase();
            return Boolean((tag === "a" && element.hasAttribute("href")) || element.closest("form"));
          });
          if (navigatesFrame) {
            await Promise.all([
              frame.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 2_000 }).catch(() => undefined),
              locator.click()
            ]);
          } else {
            await locator.click();
          }
        }
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

  // Convert a currently observed ref into a ranked bundle of strategies. Reject
  // stale refs and require the selected node to remain uniquely attached.
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

  // Replay resolution is separate from capture: it walks the saved ladder and
  // assigns a fresh internal ref to the element that resolves uniquely.
  public resolve(target: TargetSpec): Promise<ResolvedElement | ResolutionFailure> {
    return resolveTarget(this.page, target, () => this.nextRef("r"));
  }

  // Read normalised visible text and, for form controls, the current input value.
  public async read(ref: ElementRef): Promise<{ text: string; value?: string }> {
    const locator = await this.locatorForRef(ref);
    const text = (await locator.textContent() ?? "").replace(/\s+/g, " ").trim();
    const value = await locator.evaluate((element) => "value" in element ? String((element as HTMLInputElement).value) : undefined);
    return { text, ...(value !== undefined ? { value } : {}) };
  }

  // Capture every frame's HTML for failure evidence. RunLogger performs the
  // retrospective sensitive-value redaction before the evidence is final.
  // The browser side only extracts raw cell text and the th-row index; the
  // header/shape decision is a pure function so it can be unit tested.
  public async readTable(ref: ElementRef): Promise<{ headers: string[]; rows: string[][]; hasHeaderRow: boolean }> {
    const locator = await this.locatorForRef(ref);
    const raw = await locator.evaluate((element) => {
      const clean = (value: string | null | undefined): string => (value ?? "").replace(/\s+/g, " ").trim();
      const table = element as HTMLTableElement;
      const allRows = [...table.rows];
      return {
        rows: allRows.map((row) => [...row.cells].map((cell) => clean(cell.textContent))),
        thIndex: allRows.findIndex((row) => row.querySelector("th") !== null)
      };
    });
    return shapeTable(raw.rows, raw.thIndex);
  }

  public async snapshotDom(): Promise<string> {
    const snapshots = await Promise.all(this.page.frames().map(async (frame) => `<!-- frame:${getFramePath(frame)} url:${frame.url()} -->\n${await frame.content()}`));
    return snapshots.join("\n");
  }

  // Close only resources supplied as owned options; useful for tests that manage
  // their page/browser lifecycle separately.
  public async close(): Promise<void> {
    if (this.options.context) await this.options.context.close();
    if (this.options.browser) await this.options.browser.close();
  }
}
