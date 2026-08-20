# MERIDIAN CORE Adaptation

> **What to read first.** This is the adaptation write-up. The core system records a UI flow **once**
> with an LLM driving a real browser, distills it into a strict typed **capability artifact**, then
> replays it **deterministically — no model in the loop**. The adaptation points that engine at a live
> hosted legacy target, **MERIDIAN CORE**, records a capability for every function on its surface, and
> exposes them as **capabilities → API → chatbot → dashboard**, preserving every safety, evidence, and
> escalation guarantee. The model decides *which* approved capability to run; the reviewed artifact and
> the replay engine decide *how*; irreversible actions stop at a human. Run it: `npm run serve:meridian`
> then open `http://127.0.0.1:4599` (demo path at the end).

## 1. Adaptation quality — a profile, not a rewrite

Target-specific knowledge lives in one strict **AppProfile** (`profiles/meridian.yaml`), never in the
engine. The MERIDIAN profile carries:

- **detector signatures** — text patterns, because MERIDIAN shows its session timeout as a 440 page on
  the *same* URL and gives no clean status codes; path-based detection alone can never fire on it;
- **sign-on bootstrap** and credential environment-variable names;
- **irreversible-action button labels** (`Post Transfer`, `Apply Hold`);
- **business-outcome and bounded-recovery templates**;
- the **fault-injection allow-list** (the six `?inject=` kinds).

The profile is selected by the artifact's `app.id` at replay and by origin at discovery — **never by a
caller argument**, so a request can't select weaker detection than the capability was recorded against.
The engine, schema, distiller, replay loop, policy, API, chatbot, and dashboard are all app-agnostic.
The original CorePoint target still runs, its profile pinned to the engine's built-in defaults, as a
regression check that the adaptation is a configuration change. **What was *not* just config** is
documented honestly in §6 — the legacy target forced real code changes, and understanding why is the
point.

## 2. Correctness of the core loop — the capability surface

Eight capabilities cover MERIDIAN's whole function set. Each was **recorded once** against the live app
and **approved by replaying with a different invocation** (a different member), proving the artifact
generalizes rather than memorizing one run. Inputs and outputs are typed; a list output is a typed,
column-mapped table.

| Capability | Typed inputs | Typed output | Risk |
|---|---|---|---|
| `meridian_sign_on` | operator, password, branch | signed_on_as | read-only |
| `find_member_by_number` | member_number | matches (table: member_no, name, shares) | read-only |
| `find_members_by_last_name` | last_name | matches (table) | read-only |
| `get_member_record` | member_id | member_name + shares (table: id, type, balance, status) | read-only |
| `open_new_share` | member_number, share_type, deposit | new_share_account | mutating |
| `update_member_information` | member_number, phone | member_update_status | mutating |
| `transfer_funds` | member_number, from_share, to_share, amount | transfer_confirmation | **irreversible** |
| `place_account_hold` | member_number, share, reason | hold_confirmation | **irreversible** |

## 3. Capability API / task contract

Every capability is a reviewed artifact with a strict Zod schema: typed inputs (with `sensitive` and
format hints), typed outputs, an entry precondition, verified locator ladders, postconditions, and its
risk tier. A **catalog** projects the approved set into tool definitions an agent invokes **by name**,
never touching the UI — `GET /api/capabilities` returns it, with `requires_human` on irreversible ones.
Callers arrive with different physics (CLI strings, JSON numbers); inputs are normalized against the
declared contract **losslessly only** — `"25.00"→25` but `"12.5"` is never truncated into an integer.
Unknown or missing parameters are rejected **before a browser launches**.

## 4. Robustness & error handling — how replay classifies what it sees

Replay draws three hard lines. Every non-success result is exactly one of:

- **Business outcome** — the application gave a *legitimate* answer, reported as fact, not an error.
  MERIDIAN cases, each a profile template matched during the steps: `MEMBER_NOT_FOUND` (a no-hit search
  shows "No member records matched your search"), `INSUFFICIENT_FUNDS`, `VALIDATION_REJECTED` (a form
  the app rejects), `SIGNON_REJECTED`.
- **Recoverable condition** — a known interruption with a *bounded* recovery, authored in the profile.
  A scheduled-maintenance interstitial triggers `maintenance_continue` (click Continue, restart from
  entry, **max 2 attempts**); a session timeout (the inline 440 page) pauses for re-authentication.
  Recovery that re-enters is **blocked once a record-changing action may have posted**, so nothing is
  done twice.
- **Hard failure** — a technical fault, classified with a **disposition** that tells the caller what to
  do: `retry` (a server 500 → `app_error`), `fix_request` (bad input), or `fix_capability` (a
  postcondition/checkpoint/locator failure a maintainer must repair). Every hard failure carries a
  redacted evidence bundle.

Permission denials are handled as **escalation** (§5), not failure. This taxonomy is exercised live in
the demo: not-found, an injected `maintenance` fault recovering to success, and an injected `server`
fault surfacing as a structured `app_error` are three different, correct results from the same run
endpoint.

## 5. Safety, data handling, and escalation

- **Irreversible human boundary.** The schema *refuses to save* an irreversible capability unless its
  final step is `human_required`, targeted, and last. At replay the machine walks to that button and
  **stops**; a person completes it in the same browser. Proven live for both transfer and hold.
- **Escalation — stuck → stop → escalate with context.** MERIDIAN gates Place Hold behind a supervisor
  wall (`teller1 is not authorized… a supervisor must sign on`). Replay detects that wall and pauses
  with the screen context for a human, rather than guessing or failing. The same pause path covers a
  lost session and an unrecognized dialog. Handoff carries the run id, step, reason, and a screenshot.
- **Redaction of regulated data.** Member names, numbers, share ids, balances, and confirmation numbers
  are `«redacted»` in all persisted evidence; real values go only to the authorized caller. Sensitivity
  **propagates**: a value typed sensitively, or one that *embeds* a sensitive value (a share id
  carrying a member number), is redacted too. Discovery stops capturing screenshots once a sensitive
  value is on screen and records that it did. An automated secret scan fails the build if any artifact
  ever carries member data.
- **Allowlist / no easier path.** CLI, API, and chatbot all execute through the *one* runner. The API
  resolves only approved capabilities, rejects malformed requests before launch, gates mutations behind
  an envelope confirmation, refuses irreversible work unless explicitly attended, contains evidence
  downloads to the run directory, and binds to loopback. The chatbot's model only *routes*;
  deterministic code executes and formats, and it fails closed on anything unexpected.

## 6. What adapting actually took (where it wasn't just config)

Recording against a *real* hostile app surfaced things no fixture would. Each was fixed with a
permanent regression test — this is the honest core of the adaptation:

- **The model could click "Post Transfer" itself.** MERIDIAN's buttons are legacy
  `<input type="submit" value="Post Transfer">`; the label is in the value attribute, so the risk
  classifier saw an empty name and the irreversible guard never fired.
- **Human-pause time counted against the wall-clock budget**, so a run failed the instant a human
  handed back after posting a transfer.
- **A transient model-API error crashed the run** with no finalized evidence — worst possible right
  after a human posted a real transaction.
- **A share id leaked the member number** it embeds; **synthesized URL postconditions pinned a member
  number**; **a confirmation details-panel was mis-parsed as a table**, freezing a run's confirmation
  number as a column header (a leak that also broke replay). *And, candidly:* fixing that panel later
  mis-classified the real results grid and **leaked member data into evidence** — caught only by
  scanning the demo evidence, then fixed by distinguishing a label header row from a value row.
- **A no-match search reported a technical failure** instead of `MEMBER_NOT_FOUND`; **fault injection
  re-triggered on every recovery restart**; **run ids collided within a second**; **the operator
  console's identity prompt was destroyed by its own auto-refresh**; **the chatbot was stateless** and
  **asked for transfer details on an irreversible request** it could never complete.

Also proven, not asserted: MERIDIAN protects each form with a hidden per-session `_token`. Replay
carries whatever token is live because the *browser submits the real form* — the token is in neither
artifact nor log. Two opt-in live tests assert this.

## 7. Trade-offs and what I cut

Following the brief's "cut depth, not capabilities":

- **Polling, not WebSockets.** The dashboard polls every ~1.5s. Simpler; fine for one operator.
- **Single-worker in-memory queue, no database.** One live browser is the honest model; run history is
  rebuilt from the evidence directories on disk. A production version would persist the queue and
  idempotency map so they survive a restart.
- **No concurrent browsers, no multi-capability planning.** The chatbot routes to exactly one
  capability per turn; chaining (a single-match search → open record) is deliberately *not* automatic,
  to stay predictable. No automatic locator healing — a locator failure is an honest
  `fix_capability` failure with evidence, not a silent self-repair.
- **Minimal styling and no screen recording.** Effort went to correctness and safety, not polish.
- **Chatbot fluency traded for correctness.** The model never phrases the answer, so replies always
  reflect real data — less chatty, never wrong.
- **Left on the demo host:** because it has no reset, the mutating/irreversible recordings left real
  data behind — the ledger below is the honest accounting.

## 8. Demo-data ledger (shared host, no reset)

- **Shares opened:** a Money Market share on member 103001 and a Share Draft on 102777 (plus an extra
  MMKT share on 103001 from a pre-fix recording).
- **Transfers posted:** several $1–$5 transfers among 103001's shares; $1 transfers on 100987/102777
  during approvals.
- **Holds placed:** LEGAL holds on 103001-MMKT-5 and 100234-MMKT-4 (plus earlier recon holds).
- **Contact info updated:** phone numbers on members 103001 and 102777.

## 9. Demo path

`npm run serve:meridian`, then `http://127.0.0.1:4599`:

1. **Chat** (each shows a different guarantee): `find members with the last name Turing` (structured
   redacted matches) · `look up member 999999 by number` (business outcome) · `look up a member`
   (clarification) · `update member 103001 phone to 555-0175` (confirm-to-run) · `transfer 5 dollars for
   member 103001` (explains the human boundary) · `reset the wifi password` (fails closed).
2. **Fault injection** via `POST /api/runs` with `fault_injection: "maintenance"` (recovers to success)
   and `"server"` (structured `app_error` failure).
3. **Attended irreversible handoff:** `POST /api/runs` with `attended: true` for `transfer_funds`; the
   dashboard shows **"Escalated — waiting for human,"** you Take control, click **Post Transfer** in the
   headed browser, Hand back — captured confirmation, redacted evidence. `place_account_hold` is the
   same pattern under supervisor authority.

Normal tests (`npm test`) are fully offline; live checks are opt-in (`npm run test:meridian`). Committed
proof of each behavior is in [`evidence/meridian/`](evidence/meridian/).
