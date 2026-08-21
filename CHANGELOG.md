# Changelog

## Since submission

I re-read the submission as an adversary rather than an author, and found one
habit running through it: **I kept building controls and then not making them
bind.** A locator confidence score written into every artifact and read by
nothing. A lease transition for aborting a run that nothing ever drove. A
version-bump helper never called. Two provenance fields recording who discovered
and who approved a capability, sitting next to each other, never compared. An
approval status that was a flag rather than a fact.

The structure was right in each case; the enforcement was missing. So the work
below is mostly not new features — it is making the mechanisms already there
actually do something, plus one measurement of the claim the whole design rests
on.

---

### The distiller was freezing run data into capabilities

`lookup_member_savings_balance@1.0.0` shipped with a member's name in a step
description, and with two identical steps.

Both came from the same root cause: **the distiller sanitised parameter values
and nothing else.** The model's reasoning becomes the step intent and can quote
anything it read on screen, so anything not passed as a parameter survived into
the contract. Intent text is now scrubbed against the same list the evidence
logger uses — a value the run judged unsafe to write to a log can no longer
reach a capability.

Locators were copied verbatim, which is a different problem wearing the same
clothes. A control labelled with the discovery member's own account number would
resolve for that member and for nobody else — a correctness bug, not a leak, and
one that verification structurally cannot catch, because being built out of the
data does not make a locator non-unique. It makes it unique *for the wrong
reason*. Tainted strategies are now dropped from the ladder, and only an emptied
ladder is fatal.

The duplicate step was the model re-entering a value it had already entered, and
the trajectory being recorded verbatim. Consecutive `type`/`select` repeats on
the same control now collapse — those *set* a value rather than trigger one. A
repeated click may be adding a second row, so clicks are never collapsed.

*`1625875`*

### A single transient API failure ended a discovery run

Both model clients threw on any non-OK response, so one 429 lost the browser
session, the trajectory and the tokens already spent. Requests now back off and
retry, sharing one policy rather than duplicating it per provider, and only for
statuses that will differ next time — a bad key rejected four times is still a
bad key. The final retriable response is handed back rather than thrown, so the
existing error paths still report what the API actually said. Retries warn on
stderr, because during a live run a silent eight-second pause looks like a hang.

The retry hook is injectable, which is also how an eval harness counts transport
noise separately instead of scoring it as a capability failure.

*`aec34bc`*

### An unanswered handoff killed the run outright

An intervention nobody took control of rejected after fifteen minutes and was
caught by nothing. No result, no failure bundle, and — during discovery — no
retrospective redaction pass, which only runs on a terminal result. The lease
was left paused and the request left waiting, so the console still advertised
work that no longer existed.

**Nobody arriving is an expected way for asking for help to end.** That is the
same argument the result contract already makes about business outcomes, and it
had been made for the caller-facing contract while an exception was still used
for the internal one. An expired request now comes back aborted, replay reports
a `timeout` failure with the usual bundle, and discovery finishes as escalated
with its evidence intact.

This is the first caller of `ControlLease.abort()`.

*`e38a66a`*

### Approval was a status flip

Nothing had ever replayed an artifact before it became runnable. Distillation
proved the model could do the job once, by hand, with one member's data, and the
file was trusted on that basis.

`approve` now runs a real validation replay through the same path a caller uses
and writes the approved status only if it succeeded. **The gate lives in the
store rather than the command**, so a second code path cannot approve without
evidence — the same reason the schema is strict and the allowlists are checked
twice.

Two checks make that evidence mean something, and both refuse rather than warn.
The invocation must differ from discovery's, because replaying the recorded
inputs only repeats the run already recorded; a different one is what shows the
artifact is a capability rather than a transcript of one member's data. And the
approver may not be the identity that recorded it.

Proving the inputs differed without returning them to the file means storing a
per-parameter fingerprint. The approval records which parameters were reused, so
a reviewer can see how thin the evidence was.

*`570df86`*

### The capability was re-recorded, and earned its approval

Versions were immutable and nothing could produce a successor, so re-recording
meant destroying the previous artifact. `--bump` claims the next version
instead — the first caller of `bumpVersion`.

Discovery was run again against Claude Sonnet 4.6 and published as `@1.1.0`,
approved by a validation replay against member `8832`. Approval with the
discovery invocation was refused first.

`@1.0.0` is kept deliberately, because the diff is the clearest statement of
what changed:

```
@1.0.0   4 steps, step s4 intent contains a member's name
@1.1.0   3 steps, no seed data anywhere in the file
```

*`16ddfbd`*

### The last two declared boundaries

Every capability was granted all seven action kinds, so the artifact allowlist
could catch a capability leaving its origin but not one performing an action
nobody approved. Capabilities now carry the actions they actually perform, plus
the entry navigation and recovery clicks the engine drives itself — a subtlety
worth noting, since computing the list from steps alone produces an artifact
that blocks its own entry URL.

The lint rule guarding replay named the LLM layer and never mentioned Playwright,
so "only one file knows a browser exists" was a convention. Both patterns are now
in the rule, and both are verified to fire.

*`ad2d3b9`*

### Locator telemetry recorded positions, not kinds

A tier is a position in one step's ladder. A step that captured four strategies
calls geometry `"4"`; a step that captured seven calls a healthy label match
`"4"`. So the aggregate could not be read.

A real run makes the point — `matched_tiers {"1": 5}` looks like one thing and is
three: `label_proximity` for the search input, `role_name` for the buttons,
`label_adjacent_cell` for both extractions. Strategy kinds are now counted
alongside positions, because kinds compare across steps and across runs.

*`505339e`*

### The central claim is now measured

The project argues that seven ways of finding an element mean a UI change
probably will not break a capability. **That had never been tested.**

`cli stress` replays a capability under UI changes injected into the browser and
reports what survived and which rung carried it:

```
mutation           outcome                   result   resolved by
─────────────────  ────────────────────────  ───────  ──────────────────────────
none               survived                  correct  label_proximity role_name label_adjacent_cell
rewrite_classes    survived                  correct  label_proximity role_name label_adjacent_cell
extend_labels      survived                  correct  attr_css text label_adjacent_cell
rename_labels      survived                  correct  attr_css structural×4
mangle_ids         survived                  correct  label_proximity role_name label_adjacent_cell
insert_table_row   survived                  correct  label_proximity role_name label_adjacent_cell
rename_and_reflow  BROKE (target_not_found)  failure  —
wrap_layout        survived                  correct  label_proximity role_name label_adjacent_cell
```

Replacing every label costs all four wording-based strategies at once, because
`role_name`, `label_proximity`, `text` and `label_adjacent_cell` rest on the same
signal. The ladder dropped to CSS and XPath and still returned the right values —
which is the design working, measured rather than asserted.

Three decisions the numbers depend on:

**Mutations run in the browser, not in the application.** The harness then works
against any surface rather than the one app it was written beside, and the
application stays exactly the one the capability was recorded against, so the
mutation is the only variable.

**A mutation may change how an element is found and must not change what the
application does.** Stripping a form control's `name` breaks the POST, so every
capability would fail for a reason unrelated to locators. A test asserts no
mutation touches `name`.

**Survival requires the right answer, not a green status.** A run that completes
having read the wrong cell is the failure this system is least able to notice on
its own, so `--expect` is required.

And 7/8 was a finding, not a result. A detector that has never shown a failure is
not obviously working — the compound mutation exists because a mutation only
tests the rungs the ladder actually falls through to.

*`c2aca75`*

---

## What I would do next, in order

1. **Gate approval on locator quality, not just success.** A capability resolving
   by geometry on the day it is approved is already fragile. The strategy kind is
   now recorded, so the check is available; it is not yet wired in.
2. **Aggregate telemetry across runs.** Drift is a change over time and nothing
   compares two runs, so detecting it still means a human reading two
   directories.
3. **Let the model propose business outcomes into a draft for human approval.**
   The templates are CorePoint constants today. A single happy run could not have
   discovered the sad paths either — they have to be harvested deliberately or
   promoted from production failures, which is the review gate this system has
   and does not feed.
4. **Close the `press` gap in risk inference.** A form submitted with Enter never
   reaches the per-control heuristic.
5. **Either enforce `confidence` and `ui_version_range` or delete them.** Both are
   still declared and read by nothing — the same shape of mistake as everything
   above.

---

## Expansion round — building the drift→repair loop

Asked to expand the project, I built the next two items on the list above, because
they are the same idea from two directions: **the telemetry the system records
about how it finds an element is only worth recording if something acts on it.**
Item 2 (aggregate telemetry to detect drift) becomes a *signal*; item 1 (act on
locator quality) becomes a *repair*. Together they close a loop the base system
left open: **detect drift → propose a repair → a human approves → back in
service** — with no model ever entering a real run's decision path.

### `eval` — drift is now measured across the catalog, not read from two directories

The base system recorded which locator tier matched each step and then compared
nothing. `eval` replays the approved read-only capabilities against the live app
and turns that telemetry into a health verdict: **healthy** (every step matched its
strongest locator), **drifting** (still succeeds, but a step fell to a weaker
fallback — the early warning), or **failed**. The report ends with an explicit
heal work-list and exits non-zero, so a schedule can call it.

It also grew a second, orthogonal signal the base design had no answer for:
**data-shape drift.** A capability can match every locator perfectly and still be
slipping because the app renamed or added a results column. The sweep captures the
live table headers (labels only — never cell values) and compares them to the
recorded columns. Only read-only capabilities run, from a manifest of safe
invocations; mutating and irreversible ones are reported skipped, because an
unattended sweep must never change member data.

*`2a5d4a4`, `c5fe3d3`*

### `heal` — the recording repairs itself, but only a human makes it live

When a step's locator drifts, `heal` walks the capability to that step with the
real replay engine, uses the model to re-discover *only that one element* on the
live page, validates the new ladder actually resolves, and writes a **draft** that
changes just that step. The invariant that keeps it honest: **healing never runs
during replay.** A drifted locator in a real run stays a `fix_capability` failure;
`heal` is a separate, operator-initiated step whose only output is a draft that
still has to pass the existing approval gate (approver ≠ discoverer, a different
invocation). The system proposes its own fix; a person signs it off; replay stays
model-free. Healed drafts surface on the dashboard under **Proposed repairs**.

This is the first thing that consumes the drift signal `eval` produces and the
approval gate `approve` enforces — the two mechanisms the base round built and left
standing next to each other, now wired together.

*`df8e5bb`, `b64e1bc`, `f389547`*
