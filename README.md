# CorePoint Computer-Use Automation

An end-to-end computer-use system that uses an LLM to discover a workflow against a live legacy-style banking UI, distills the run into a typed capability artifact, and replays that artifact deterministically without a model in the decision loop.

The target is a fictional CorePoint teller console with iframes, table layouts, sparse semantics, two tenant variants, and deterministic runtime faults. All names, member records, credentials, and balances in this repository are test data.

## Requirements

- Node.js 20 or newer
- Chromium for Playwright
- An Anthropic or OpenAI API key only for live discovery

Install with pnpm:

```bash
pnpm install
pnpm exec playwright install chromium
```

Or use npm if Corepack/pnpm is unavailable:

```bash
npm install
npx playwright install chromium
```

Create the local environment file:

```bash
cp .env.example .env
```

For Anthropic discovery, set `ANTHROPIC_API_KEY` in `.env`. The default model is `claude-sonnet-4-6`; it can be changed with `ANTHROPIC_MODEL`. For OpenAI, set `OPENAI_API_KEY` and optionally `OPENAI_MODEL`. `.env` is ignored by Git. Deterministic replay needs no model key or external live service.

## Quick start

Start both fictional tenants in terminal 1:

```bash
npm run app
```

- Tenant A: <http://localhost:4478/desk>
- Tenant B: <http://localhost:4479/operations>
- Manual login: `teller1` / `training-only`

Run the committed discovered capability in terminal 2 with a member different from the discovery input:

```bash
npm run cli -- replay lookup_member_savings_balance@1.1.0 \
  --param member_id=8832 \
  --mock-auth
```

The browser is headed by default so you can watch it. Add `--headless` for unattended execution. A successful result contains `member_name`, `savings_balance`, locator-tier stability telemetry, and an evidence directory.

## Live LLM discovery

The following creates a separate manual artifact in `/tmp`, leaving the reviewed repository artifact unchanged. Omit `--headless` to watch Claude operate the UI.

```bash
npm run cli -- discover \
  --provider anthropic \
  --goal "Look up member 4521 and read their member name and regular savings balance." \
  --url http://localhost:4478/desk \
  --mock-auth \
  --capability-id manual_lookup_member_savings_balance \
  --title "Manual member savings lookup" \
  --description "Searches for a member and returns their name and regular savings balance." \
  --param member_id=4521 \
  --output member_name \
  --output savings_balance \
  --artifact-root /tmp/corepoint-artifacts \
  --run-root runs
```

Replay the artifact with a different invocation value and no LLM:

```bash
npm run cli -- replay manual_lookup_member_savings_balance@1.0.0 \
  --artifact-root /tmp/corepoint-artifacts \
  --param member_id=8832 \
  --mock-auth \
  --run-root runs
```

The declared `--output` names form the discovery completion contract: the runtime stops after the model visibly marks each required output. Adding `--handoff` (headed browser only) lets a stuck discovery pause into the same operator console used for replay handoff instead of ending the run.

Versions are immutable, so re-recording an existing capability claims the next one with `--bump patch|minor|major` rather than replacing the reviewed artifact it supersedes. `--overwrite-artifact` remains available for intentionally replacing a version in place.

## Approving a capability

A discovered artifact is a `draft`. Approval is earned rather than declared: `approve` runs a real validation replay through the same path a caller uses, and only writes the approved status if it succeeds.

```bash
npm run cli -- approve lookup_member_savings_balance@1.1.0 \
  --by "reviewer@example.test" \
  --param member_id=8832 \
  --mock-auth
```

Two things make that evidence mean something, and both refuse rather than warn:

- **The invocation must differ from discovery.** Replaying the recorded inputs only re-runs the run we already have; a different member is what shows the recording is a capability rather than a transcript of one member's data. The artifact stores a per-parameter fingerprint, so this is checked without the artifact ever holding an invocation value.
- **The approver cannot be the identity that recorded the capability.**

The outcome is written into `capability.provenance.validation` — which run, when, which parameters were reused, and which locator tiers matched — so a reviewer can see how thin or solid the evidence was.

A mutating capability genuinely performs its mutation during validation, so approve those against test data.

## Manual test checklist

Keep `npm run app` running, then execute these one at a time. They write local evidence to the ignored `/runs/` directory.

### 1. Successful deterministic replay

```bash
npm run cli -- replay lookup_member_savings_balance@1.1.0 \
  --param member_id=8832 --mock-auth --run-root runs --run-id manual_success
```

Expected: `status: "success"`, with a fictional member name and balance. The terminal returns raw outputs to the authorized caller; persisted logs redact them.

### 2. Expected business outcome

```bash
npm run cli -- replay lookup_member_savings_balance@1.1.0 \
  --param member_id=9999 --mock-auth --run-root runs --run-id manual_not_found
```

Expected: `status: "business_outcome"` and `code: "MEMBER_NOT_FOUND"`, not a failure.

### 3. Recoverable session modal

```bash
npm run cli -- replay lookup_member_savings_balance@1.1.0 \
  --param member_id=1001 --chaos session_timeout --mock-auth \
  --run-root runs --run-id manual_recovery
```

Expected: the replay dismisses the modal and succeeds. `runs/manual_recovery/log.jsonl` contains a `recovery_applied` event.

### 4. Tenant B overlay

```bash
npm run cli -- replay lookup_member_savings_balance@1.1.0 \
  --param member_id=1002 \
  --overlay artifacts/overrides/lookup_member_savings_balance@b.json \
  --mock-auth --run-root runs --run-id manual_tenant_b
```

Expected: success against port 4479 despite the changed route, field label/name, branding, and account-column order.

### 5. Hard application failure

```bash
npm run cli -- replay open_sub_account@1.0.0 \
  --param member_id=4521 \
  --param account_type="Holiday Savings" \
  --param opening_deposit=25.00 \
  --chaos error500 --mock-auth --run-root runs --run-id manual_app_error
```

Expected: a non-zero process exit with `status: "failure"`, class `app_error`, step `s8`, and paths to a redacted DOM snapshot and locator-resolution attempts.

### 6. Same-session human handoff

```bash
npm run cli -- replay open_sub_account@1.0.0 \
  --param member_id=4521 \
  --param account_type="Holiday Savings" \
  --param opening_deposit=25.00 \
  --chaos supervisor --mock-auth --handoff \
  --run-root runs --run-id manual_handoff
```

When the run pauses:

1. Open <http://127.0.0.1:4590> and select **Take control**.
2. In the existing CorePoint browser window, enter fictional supervisor code `2468` and select **Confirm & Open Account**.
3. Return to the operator console and select **Hand back**.

Expected: the same run resumes at the satisfied checkpoint and returns success with an intervention summary. `runs/manual_handoff/log.jsonl` contains the intervention, lease transitions, and redacted human actions.

## Tests and quality checks

```bash
npm run typecheck
npm run lint
npm test
```

The suite covers the live hostile iframe surface, locator ladders, schema validation, parameter binding, policy checks, redaction, business outcomes, modal recovery, failure bundles, same-session handoff, and Tenant B reuse.

## Repository guide

- `src/agent/`: LLM clients, tool contract, prompting, and bounded discovery loop
- `src/artifact/`: strict schema, distillation, storage, approval, and tenant overlays
- `src/replay/`: model-free executor, detectors, recovery, extraction, and result union
- `src/control/`: control lease, intervention queue, operator console, and human recorder
- `src/surface/`: browser-independent interface plus frame-aware Playwright implementation
- `src/policy/`: configurable allowlist, risk checks, and redaction
- `src/eval/`: injected UI mutations and the scoring behind `stress`
- `apps/corepoint/`: fictional hostile target and deterministic chaos injection
- `artifacts/`: reviewed capability contracts and Tenant B overlay
- `evidence/`: committed discovery, replay, recovery, failure, handoff, and tenant examples
- `REPORT.md`: design decisions, trade-offs, limitations, and cuts
- `CHANGELOG.md`: what changed since submission, and why

See [evidence/README.md](evidence/README.md) for the committed evidence matrix.

## Measuring locator robustness

The claim that a ranked ladder survives UI change is checked rather than asserted. `stress` replays a capability under UI changes injected into the browser — restyling, extended wording, replaced wording, rewritten ids, an inserted table row, a layout wrapper, and a compound — and reports which strategy kind carried each run.

```bash
npm run cli -- stress lookup_member_savings_balance@1.1.0 \
  --param member_id=8832 \
  --expect member_name="Sam Example" \
  --expect savings_balance='$3,109.08' \
  --mock-auth
```

`--expect` is required, not optional: a run that completes having read the wrong cell has not survived, and that is the failure this system is least able to notice on its own. Mutations are injected into the page rather than built into the mock app, so the harness works against any target and the application under test stays the one the capability was recorded against.

## Troubleshooting

- If `corepack pnpm` reports a package-signature error, use the npm commands above; the project does not depend on Corepack behavior.
- If Chromium is missing, run `npx playwright install chromium`.
- If ports 4478, 4479, or 4590 are busy, stop the existing process. `--console-port` changes the handoff console port.
- Reuse a new `--run-id` for each manual run because evidence logs are append-only by design.
