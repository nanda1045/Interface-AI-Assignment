# Design Report

## 1. Architecture

The system is a single TypeScript process with explicit module seams rather than services or queues. A CLI starts either discovery or replay. Both paths use the same `Surface`, `PolicyEngine`, `RunLogger`, and optional `RunController`; this makes policy and evidence behavior consistent without building infrastructure the exercise does not need.

Discovery follows observe → decide → policy-check → act. The LLM receives a semantic digest and tool definitions, chooses references from the current observation, and never authors selectors. Each selected element is converted immediately into a verified locator ladder. The successful trajectory is then distilled into a strict JSON capability. The genuine run in `evidence/discovery_anthropic/` used Claude Sonnet 4.6 against the live CorePoint iframe UI.

Replay loads that artifact and has no LLM dependency. It resolves each target, materializes parameterized actions, checks policy, acts, evaluates detectors and postconditions, verifies the capability checkpoint, and extracts declared outputs. `src/replay/` imports the `Surface` contract rather than Playwright. The concrete `WebSurface` is the only browser-control implementation.

CorePoint is intentionally local and fictional. A public shop demo would show navigation but would not let this submission deterministically trigger a session expiry, permission outcome, supervisor wall, slow response, or application error. The local target therefore provides a more realistic test of the production concerns while avoiding terms-of-service and PII risks.

## 2. Artifact schema

An artifact is a versioned capability contract, not a transcript. Its strict Zod schema contains capability metadata and provenance; typed object contracts for inputs and outputs; entry preconditions; ordered steps with human-readable intent; parameter bindings; ranked target strategies; waits and postconditions; a capability-level checkpoint; extraction rules; business outcomes; bounded recovery rules; and a policy summary.

Locator strategies carry `unique: true` and confidence because capture verifies that each candidate resolves to the selected node exactly once. The ladder prefers role/name, nearby static labels, and visible text; attribute selectors follow; structural XPath and normalized geometry are fallback tiers. This records both the target and the robustness reasoning. Replay reports which tier succeeded and flags steps rescued by lower tiers.

Distillation replaces invocation values with `value_from.param` and parameterizes sample values in intent text. It rejects unbound supplied parameters and undeclared outputs. Output locators are captured from visible values but prefer value-independent adjacent labels such as `Member Name` and `Regular Savings`. Unknown schema fields are rejected, leaving no place for screenshots, transcripts, credentials, or raw invocation values in the capability.

Semantic versioning and approval metadata make artifacts reviewable. Patch versions are intended for locator repair, minor versions for compatible flow changes, and major versions for input/output contract changes. Mutating drafts cannot run unattended unless explicitly confirmed; the included mutating demonstration artifact is reviewed and approved.

## 3. Determinism & error handling

Replay is deterministic because the artifact fixes the action order, parameter sources, locator ladder, waits, predicates, recovery limits, checkpoint, and extraction parse rules. No model chooses a replay action. Resolution requires a unique, visible, enabled element. Frame navigation is awaited explicitly so an iframe cannot expose a stale pre-navigation observation.

The result is a discriminated union: `success` with outputs and stability telemetry; `business_outcome` with a known code and optional data; or `failure` with class, step, intent, expected state, observed state, and debug-bundle paths. `MEMBER_NOT_FOUND` and `PERMISSION_DENIED` are caller-visible outcomes rather than crashes. A known session-expiry modal is dismissed by a bounded artifact recovery rule. Session loss and supervisor requirements can request human intervention. Application-error signatures, exhausted locator ladders, invalid inputs, timeouts, failed postconditions, and failed checkpoints stop with explicit failure classes.

The committed evidence demonstrates a successful replay using member `8832` after discovery used `4521`, proving parameterization; a not-found business outcome; modal recovery; an injected `app_error` with DOM and locator-attempt files; and reuse against Tenant B. The automated suite repeats the load-bearing paths against live ephemeral servers.

## 4. Heterogeneity & multi-tenant

`Surface` is the seam between a recorded flow and a concrete computer interface. It exposes observation, abstract action, locator capture, target resolution, reading, and debug snapshot operations. A desktop implementation could produce the same digest from UI Automation/accessibility nodes and implement strategies using automation IDs, names, hierarchy, OCR anchors, or normalized geometry. Discovery, policy, artifact distillation, replay classification, and control transfer would remain unchanged.

The browser implementation already exercises legacy constraints: nested tables, sparse labels, server-rendered pages, iframe navigation, and no test IDs. Accessibility-style role/name data is enriched with DOM heuristics and nearby table labels; geometry remains a deterministic last resort rather than requiring a model during replay.

For tenant reuse, a base artifact stays vendor/product-oriented. A small validated overlay can change the entry URL plus individual step and extraction targets. Tenant B changes branding, route, input label/name, and account-column order. The committed overlay patches only what differs, and the integration evidence shows the same base capability succeeding. Locator-tier telemetry is the drift signal: increasing fallback-tier use can trigger review before hard failure. At production scale, overlays would be selected by tenant/app/version metadata and promoted through replay-based validation.

## 5. Escalation & handoff

Control is represented by a lease with agent-running, paused, human-control, resuming, and terminal semantics. `WebSurface.act()` rejects agent actions when the agent does not hold the lease. On an escalatable state, replay creates an intervention containing run and capability IDs, goal, current step and intent, reason, requested action, current state context, and a screenshot when the run is not sensitive.

The localhost operator console is deliberately a signaling plane, not a remote desktop. The human selects **Take control**, operates the same headed browser context, then selects **Hand back**. Page listeners record clicks, navigation, and redacted key/input events into the same log. No browser state is copied and no fresh session is created.

After hand-back, replay re-observes and decides from explicit conditions: a satisfied capability checkpoint completes the run; a satisfied step postcondition advances; a resolvable current target retries; otherwise the run fails as a divergent post-handoff state. The committed handoff evidence is produced by the integration harness using the same live page, lease, recorder, supervisor wall, and resume logic. The README provides the exact manual headed-browser procedure.

## 6. Safety

Both discovery and replay pass actions through one configurable policy engine. It enforces allowed origins, route patterns, action types, duration, and step limits. Off-origin navigation is denied. Discovery mutations require an explicit flag. Mutating replay requires an approved artifact or explicit confirmation. Heuristic per-control risk inference is a second check against a mislabeled artifact, and irreversible actions require human control.

Secrets come only from `.env`, which is ignored. Credentials are never included in artifacts. Parameters and outputs marked sensitive are registered with the logger before persistence. Structured values, model transcripts, results, human actions, and failure bundles are scrubbed; discovery performs a final retrospective pass after visible outputs are identified so earlier observations are also redacted. Sensitive replay runs omit screenshots. The repository evidence uses fictional records and its text files are scanned for the seeded raw identifiers, names, balances, supervisor code, and account numbers.

Limits are intentional and documented. Screenshot pixel redaction is not implemented; committed discovery screenshots contain only fictional seeded data. The local operator console has no authentication and is bound to loopback. A human holding the lease can perform actions outside the declared flow; the prototype records rather than constrains those actions. Policy is origin/action/risk-level, not a full data-loss-prevention system.

## 7. Cuts

This submission does not implement desktop/UIA or OCR/vision surfaces, remote co-browsing, operator authentication, databases, queues, distributed scheduling, automatic locator repair, or open-ended LLM fallback during replay. Those are clean extensions, not requirements for the vertical slice.

The distiller intentionally uses deterministic parameter binding and predicate construction rather than a second LLM metadata pass. Business-outcome and recovery templates are currently CorePoint-oriented and would become a reviewed vendor library. Login is represented as an authenticated precondition with a fictional `--mock-auth` helper rather than a composable credential capability. Stability telemetry reports ladder-tier use but does not yet aggregate reliability over many production runs.

Next steps would be authenticated intervention routing, an OS accessibility `DesktopSurface`, encrypted evidence retention with role-based access, tenant/version selection and drift dashboards, and a multi-run stability gate before artifact approval. Those additions should follow the current boundaries rather than change the artifact/replay contract.
