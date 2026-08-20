# MERIDIAN CORE Adaptation

## What this is

The base system records a UI flow **once** with an LLM driving a real browser, distills that
trajectory into a strict, typed **capability artifact**, and then replays it **deterministically** —
no model in the loop. This adaptation points that engine at a live legacy target, **MERIDIAN CORE**
(`https://web-sample.interface-hiring.com`), records a capability for every function on its surface,
and exposes them as **capabilities → API → chatbot → dashboard** — while preserving every safety,
evidence, and escalation guarantee the base system had.

The model decides *which* approved capability to request. The reviewed artifact and the deterministic
replay engine decide *how* the browser work is performed. Irreversible actions stop at a
human-controlled boundary.

## The one architectural move

Target-specific knowledge lives in a strict **AppProfile** (`profiles/meridian.yaml`), never in the
engine. The MERIDIAN profile carries: detector signatures (text patterns, because MERIDIAN shows its
session timeout as a 440 page on the *same* URL and has no clean status codes), the sign-on
bootstrap, credential environment-variable names, the irreversible-action button labels
("Post Transfer", "Apply Hold"), business-outcome and bounded-recovery templates, and the
fault-injection allow-list. The profile is selected by the artifact's `app.id` at replay and by
origin at discovery — **never by a caller argument**, so a request can't select weaker detection than
the capability was recorded against. This adapter boundary is what let a second app land without
touching the original CorePoint path (its profile is pinned to the engine's built-in defaults).

## The eight capabilities

Each was recorded once against the live app and approved by replaying with a **different** invocation.

| Capability | Risk | Human boundary |
|---|---|---|
| `meridian_sign_on` | read-only | — |
| `find_member_by_number` | read-only | — |
| `find_members_by_last_name` | read-only | — |
| `get_member_record` | read-only | — |
| `open_new_share` | mutating | — (envelope confirmation) |
| `update_member_information` | mutating | — (envelope confirmation) |
| `transfer_funds` | **irreversible** | Post Transfer |
| `place_account_hold` | **irreversible** | Apply Hold (supervisor authority) |

## Safety preserved end to end

- **Irreversible human boundary.** The schema *refuses to save* an irreversible capability unless its
  final step is `human_required`, targeted, and last. At replay the machine walks to that button and
  stops; a person clicks it in the same browser via the operator console. The machine never posts a
  transfer or a hold itself — proven live for both.
- **Redaction.** Sensitive values are blacked out in all persisted evidence while real values are
  returned to the authorized caller. Sensitivity propagates: an input typed sensitively, or one whose
  value embeds a sensitive one (a share id carrying a member number), is redacted too. Discovery
  stops capturing screenshots once a sensitive value is on screen and records that it did.
- **No easier path.** The CLI, the API, and the chatbot all execute through the *one* capability
  runner. The API only resolves approved capabilities, rejects unknown/oversized/malformed requests
  before a browser launches, gates ordinary mutations behind an envelope confirmation, and refuses
  irreversible work unattended. The chatbot's model only *routes*; deterministic code executes and
  formats the answer, and it fails closed on anything unexpected.

## What adapting actually took

The interesting part was not the happy path — it was what recording against a *real* hostile app
surfaced that no fixture would have. Each was fixed with a permanent regression test:

- **A leaked/pinned member number** in synthesized URL postconditions (both a privacy leak and a
  correctness bug — replay for another member would fail). Fixed by wildcarding tainted values.
- **The model could click "Post Transfer" itself.** MERIDIAN's buttons are legacy
  `<input type="submit" value="Post Transfer">` — the label is in the value attribute, not text, so
  the risk classifier saw an empty name and the irreversible guard never fired.
- **Human-pause time counted against the run's wall-clock budget**, so a run resumed after a human
  posted a transfer and then instantly failed "exceeded max_duration_ms".
- **A transient model-API error crashed the whole run** with no finalized evidence — worst possible
  right after a human had just posted a real transaction.
- **A share id leaked the member number** it embeds, because only the member-number input was marked
  sensitive.
- **A confirmation details-panel was mis-parsed as a table**, freezing that run's confirmation number
  into the artifact as a column header — a leak that also broke every future replay.
- **The operator console's identity prompt was destroyed by its own auto-refresh**, so control could
  never be taken.
- **A no-match member search reported a technical failure** ("checkpoint did not match") instead of a
  clean `MEMBER_NOT_FOUND` business outcome, because the outcome pattern didn't match MERIDIAN's
  actual "No member records matched your search" text.
- **The chatbot was stateless** (a clarifying "1234" looped forever) and **asked for transfer details
  on an irreversible request** it could never complete.

Also proven, not just asserted: MERIDIAN protects each form with a hidden per-session `_token`. Our
replay carries whatever token is live because the *browser submits the real form* — the token appears
in neither the artifact nor any log. Two opt-in live tests assert this.

## Demo-data ledger (shared host, no reset)

Recording mutating and irreversible capabilities against a shared host with no reset left real data
behind, listed here for reviewers:

- **Shares opened:** a Money Market share on member 103001 and a Share Draft share on 102777 (plus an
  extra MMKT share on 103001 from a pre-fix recording).
- **Transfers posted:** several $1–$5 transfers among member 103001's Money Market/Regular shares, and
  $1 transfers on 100987 and 102777 during approvals.
- **Holds placed:** a LEGAL hold on 103001-MMKT-5 and on 100234-MMKT-4 (plus holds from earlier
  recon on various members' shares).
- **Contact info updated:** phone numbers on members 103001 and 102777.

## Demo path

See the "MERIDIAN adaptation demo" section of the README for exact commands. In short:

1. `npm run serve:meridian` — loopback API + operator dashboard on `http://127.0.0.1:4599`.
2. In the dashboard chat: a member lookup (answer), a last-name search (structured matches), a
   non-existent member (business outcome), an update (confirm-to-run), a transfer (explains the human
   boundary).
3. From the CLI, a transfer or hold with `--handoff`: the machine reaches the final button, pauses,
   the operator completes it in the browser and hands back — visible live on the dashboard as
   "Escalated — waiting for human", with redacted persisted evidence.

Normal tests (`npm test`) are fully offline. Live checks are opt-in: `npm run test:meridian`.
