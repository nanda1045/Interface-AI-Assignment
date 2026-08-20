// Browser-independent UI contract shared by discovery and replay. Neither engine
// imports Playwright; they observe and act only through the types and Surface
// interface in this file, which also makes fake-screen testing possible.

// Temporary identifier assigned during one observation. It is safe for the model
// to select but is never treated as a durable locator across page states.
export type ElementRef = string;

// Complete bounded action vocabulary that trusted Surface implementations may
// execute. Selectors, JavaScript, and arbitrary browser APIs are intentionally absent.
export type AbstractAction =
  | { kind: "navigate"; url: string }
  | { kind: "click" | "focus"; ref: ElementRef }
  | { kind: "type"; ref: ElementRef; text: string; sensitive?: boolean }
  | { kind: "select"; ref: ElementRef; value: string }
  | { kind: "press"; key: string }
  | { kind: "scroll"; direction: "up" | "down" };

// Text/semantic description of one visible UI element. Normalised geometry and
// nearby labels help locator capture without exposing the full DOM to the model.
export interface DigestElement {
  ref: ElementRef;
  frame: string;
  role: string;
  name: string;
  text?: string;
  value?: string;
  // Present only on selects: the submittable option values are not visible as
  // page text, and without them a model can only guess them from labels.
  options?: { value: string; label: string }[];
  state: { visible: boolean; enabled: boolean };
  bboxPct: [number, number, number, number];
  hints: { nearLabel?: string; sectionHeading?: string };
}

// Snapshot of the current UI state. Screenshots are optional evidence; discovery
// removes them before its model request. stateHash supports stuck-state detection.
export interface Observation {
  /** Where the top-level document is. On a framed application this is not
   *  where the work is happening, so it is not sufficient on its own to say
   *  what state the application is in - see `frames`. */
  url: string;
  title: string;
  /** Each frame's path and where that frame currently is. A single `url` assumed
   *  a single-document surface; a legacy app with a workspace frame has more
   *  than one location, and a session can be lost in one of them while the
   *  top-level document stays put. */
  frames: { path: string; url: string }[];
  elements: DigestElement[];
  screenshot?: string;
  stateHash: string;
}

// Every persisted strategy was verified as unique for the exact selected node at
// capture time. Confidence orders stronger semantic strategies before fallbacks.
interface LocatorStrategyBase {
  frame: string;
  unique: true;
  confidence: number;
}

// The seven durable ways this system can rediscover a recorded element. A target
// stores several in ranked order so replay can walk down a locator ladder.
export type LocatorStrategy =
  | (LocatorStrategyBase & { kind: "role_name"; role: string; name: string })
  | (LocatorStrategyBase & { kind: "label_proximity"; label: string; control: string })
  | (LocatorStrategyBase & { kind: "text"; value: string; control?: string })
  | (LocatorStrategyBase & { kind: "label_adjacent_cell"; label: string })
  | (LocatorStrategyBase & { kind: "attr_css"; value: string })
  | (LocatorStrategyBase & { kind: "structural"; value: string })
  | (LocatorStrategyBase & { kind: "geometry"; bboxPct: [number, number, number, number]; nearText?: string });

// Capture-time ladder saved for a selected action target or output location.
export interface LocatorBundle {
  capturedAt: string;
  strategies: LocatorStrategy[];
}

// Artifact form of a replay target. Strategies remain ordered from strongest to
// weakest and may be adapted by an approved tenant overlay.
export interface TargetSpec {
  frame?: string;
  strategies: LocatorStrategy[];
}

// One rung's replay result, retained so failures can show every attempted locator
// and successful runs can report tier/strategy drift telemetry.
export interface ResolutionAttempt {
  strategy: LocatorStrategy;
  matched: number;
  reason?: "frame_not_found" | "not_unique" | "not_visible" | "disabled" | "geometry_too_far";
}

// Successful resolution returns a fresh temporary ref plus the exact strategy
// and tier that worked. Failure returns the full exhausted-attempt history.
export interface ResolvedElement {
  ok: true;
  ref: ElementRef;
  frame: string;
  matchedStrategy: LocatorStrategy;
  tier: number;
  attempts: ResolutionAttempt[];
}

export interface ResolutionFailure {
  ok: false;
  reason: "target_not_found";
  attempts: ResolutionAttempt[];
}

export interface ActResult {
  ok: true;
  url: string;
}

// The only UI capabilities available to the engines. WebSurface implements this
// with Playwright; unit tests implement the same interface with controlled fakes.
export interface Surface {
  observe(options?: { screenshot?: boolean }): Promise<Observation>;
  act(action: AbstractAction): Promise<ActResult>;
  captureLocators(ref: ElementRef): Promise<LocatorBundle>;
  resolve(target: TargetSpec): Promise<ResolvedElement | ResolutionFailure>;
  read(ref: ElementRef): Promise<{ text: string; value?: string }>;
  /** Deterministic tabular read of a table element: header texts and body rows.
   *  This is how search results and share listings become structured outputs
   *  instead of model-parsed prose. */
  readTable(ref: ElementRef): Promise<{ headers: string[]; rows: string[][] }>;
  snapshotDom(): Promise<string>;
  close(): Promise<void>;
}
