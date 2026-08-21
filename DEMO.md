# MERIDIAN Demo Script

A run-it-top-to-bottom demo of the live MERIDIAN adaptation. For each step: the command, what appears,
and a line to say. Design write-up is in [`ADAPTATION.md`](ADAPTATION.md); this is the driving script.

**Prerequisites**

- `.env` with MERIDIAN credentials (`MERIDIAN_OPERATOR`, `MERIDIAN_PASSWORD`, `MERIDIAN_BRANCH`, and the
  `MERIDIAN_SUPERVISOR_*` pair) and `OPENAI_API_KEY` (the chatbot and `heal` use the model).
- `npm install && npx playwright install chromium` already run.
- Two terminals: **terminal 1** runs the server; **terminal 2** runs `curl` / CLI commands.

Everything is against the live hosted target, so runs leave real (test) data behind on a shared host.
If the host is unreachable, jump to [Fallback](#fallback-if-the-live-host-is-down) — the whole story is
provable offline.

---

## 0. Setup — terminal 1 (leave running)

```bash
lsof -ti :4599 | xargs kill -9 2>/dev/null; lsof -ti :4590 | xargs kill -9 2>/dev/null
npm run serve:meridian     # = serve --auth teller --demo
```

Open **http://127.0.0.1:4599** (hard-refresh with Cmd+Shift+R).

> **Say:** "An LLM discovers each flow against the live app *once*; I distill it into a typed, reviewed
> capability; then I replay it *deterministically — no model in the loop*. The model only picks *which*
> capability runs; the artifact decides *how*; anything irreversible stops at a human. I pointed that
> core at MERIDIAN through one config file, not a rewrite. Here's the dashboard — capabilities and any
> proposed repairs on the left, runs and a chatbot on the right."

---

## 1. The adapter and a contract — terminal 2

```bash
sed -n '1,40p' profiles/meridian.yaml
python3 -m json.tool artifacts/transfer_funds@1.0.0.json | sed -n '1,35p'
```

> **Say:** "Everything MERIDIAN-specific lives in this one profile — detectors, sign-on, the irreversible
> button labels. And this is a capability artifact: note `risk: irreversible`, a final `human_required`
> step, typed `sensitive` inputs — and no model referenced anywhere. Replay is pure code."

---

## 2. Chatbot — type each in the dashboard chat box, wait for the reply

| Message | Say while it runs |
|---|---|
| `find members with the last name Turing` | "The model chose the capability; the answer is formatted by *code* — it never sees the result, so it can't misread a balance. A run just appeared — click it." |
| `look up member 999999 by number` | "'No member matched' is a **business outcome** — a legitimate answer, not a crash." |
| `look up a member` | "It **asks for clarification** instead of inventing a member id." |
| `update member 103001 phone to 555-0175` | "A data change is **gated behind Confirm & run** — the model can't grant that itself." *(don't click Confirm unless you want the write)* |
| `transfer 5 dollars for member 103001` | "It **explains it pauses for a human** and refuses to do it from chat." |
| `reset the wifi password` | "Off-catalog request **fails closed** — unsupported." |

After the first query, click its run → point at **Inputs** (`«redacted»`), **Outputs** (real values),
**timings**, **events**, **evidence** links.

---

## 3. Generalization — same recipe, different members — terminal 2

```bash
curl -s http://127.0.0.1:4599/api/runs -H 'content-type: application/json' \
  -d '{"capability":"find_member_by_number","inputs":{"member_number":"100987"}}'
curl -s http://127.0.0.1:4599/api/runs -H 'content-type: application/json' \
  -d '{"capability":"find_member_by_number","inputs":{"member_number":"101555"}}'
```

Click both runs → each returns the **correct, different** member, same structured shape. Then:

```bash
python3 -c "import json;p=json.load(open('artifacts/find_member_by_number@1.0.0.json'))['capability']['provenance'];print('recorded with:',p['input_fingerprint']);print('approved via a DIFFERENT invocation:',p['validation']['run'])"
```

> **Say:** "One recording, not two. It was *recorded* with one member and *approved* by replaying with a
> **different** member — so it's parameterized, not memorizing one run."

---

## 4. Robustness — three outcomes from one endpoint — terminal 2

```bash
curl -s http://127.0.0.1:4599/api/runs -H 'content-type: application/json' \
  -d '{"capability":"find_member_by_number","inputs":{"member_number":"100987"},"fault_injection":"maintenance"}'

curl -s http://127.0.0.1:4599/api/runs -H 'content-type: application/json' \
  -d '{"capability":"find_member_by_number","inputs":{"member_number":"100987"},"fault_injection":"server"}'
```

> **Say:** "Same endpoint, two deliberately different outcomes. The first hit a maintenance page, ran a
> *bounded* recovery, and completed. The second is a server error — it stops cleanly as `app_error` with
> a `retry` disposition and a redacted DOM snapshot. With the not-found earlier, that's the whole
> taxonomy: business outcome, recoverable, hard failure — none is an unhandled crash."

---

## 5. Unattended irreversible is refused — terminal 2

```bash
curl -si http://127.0.0.1:4599/api/runs -H 'content-type: application/json' \
  -d '{"capability":"transfer_funds","inputs":{"member_number":"100987","from_share":"x","to_share":"y","amount":"1.00"}}' | head -20
```

> **Say:** "An irreversible action sent to the unattended API is refused outright — `409 requires_human`.
> It won't even enqueue a run the machine can't finish safely. The only way to run a transfer is
> attended, where a human completes the final click."

---

## 6. The showstopper — attended irreversible handoff

**6a.** In the chat box (do this live — shares drift on the shared host):

```
show the full record and shares for member 100987
```

Pick two shares whose status is `OPEN`.

**6b.** Terminal 2 (substitute your two OPEN shares):

```bash
curl -s http://127.0.0.1:4599/api/runs -H 'content-type: application/json' \
  -d '{"capability":"transfer_funds","inputs":{"member_number":"100987","from_share":"100987-MMKT-5","to_share":"100987-S0001-4","amount":"1.00"},"attended":true}'
```

> **Say (a Chromium window opens):** "`attended:true` is me acknowledging I'm here to complete it. The
> machine fills the form, reaches Post Transfer, and stops."

On the **dashboard**: the run flips to **"Escalated — waiting for human"** → **Interventions** panel →
**Take control** → in the **Chromium window** click **Post Transfer** → back on the dashboard **Hand back**
→ click the finished run for the confirmation + redacted evidence.

> **Say:** "The machine did everything up to the irreversible click — it *physically cannot* do that
> click; the format won't even save an irreversible capability the machine could finish alone. A person
> clicked; the trail records who and when."

*Place Hold is the same pattern under supervisor authority: restart with `--auth supervisor`, then POST an
attended `place_account_hold` run with `member_number`, `share`, `reason=LEGAL`.*

---

## 7. Drift detection and self-healing (detect → break → heal → approve → green)

The longest-term risk for a record-once system against a live legacy bank isn't load — it's the bank
quietly changing its UI. This runs the whole loop in ~2 minutes, in **terminal 2** (needs
`OPENAI_API_KEY`). Full design: [`ADAPTATION.md`](ADAPTATION.md) §10–11.

**7a. Baseline — the health sweep is green:**

```bash
npm run cli -- eval --manifest eval/meridian.yaml --headless
```

> **Say:** "This sweeps the catalog against the live bank and reports health on **two axes**: *locator*
> health (can it still find each element on its strongest locator) and *data-shape* health (does the
> results table still have the columns the recording expects). Read-only capabilities are exercised from
> a manifest of safe invocations; every mutating and irreversible one is **skipped** — an unattended
> sweep never touches member data."

**7b. Break a capability — simulate the bank renaming the Search button:**

```bash
node -e "const fs=require('fs');const p='artifacts/find_member_by_number@1.0.0.json';const a=JSON.parse(fs.readFileSync(p));const s=a.steps.find(x=>x.id==='s3');s.target.strategies=[{...s.target.strategies[0],name:'Search Members (renamed)'}];fs.writeFileSync(p,JSON.stringify(a,null,2)+'\n')"
```

**7c. Detection — the sweep catches it and names the fix:**

```bash
npm run cli -- eval --manifest eval/meridian.yaml --headless
```

> **Say:** "The sweep flips `find_member_by_number` to **FAIL** and prints it in the heal work-list. In
> production this is the alert — before a customer ever hits it."

**7d. Confirm the honest failure and grab the run id:**

```bash
npm run cli -- replay find_member_by_number@1.0.0 --param member_number=100987 --auth teller --headless
```

> **Say:** "A production replay of the broken capability fails cleanly as `target_not_found` /
> `fix_capability` — no guessing, no silent self-repair mid-run." Copy the run id from the `evidence`
> path (e.g. `runs/replay_2026...`).

**7e. Repair — heal re-discovers just that one step:**

```bash
npm run cli -- heal find_member_by_number@1.0.0 --step s3 --from-run <run-id> --param member_number=100987 --auth teller
```

> **Say (a browser opens):** "heal walks to the broken step with the real engine, uses the model to
> re-discover **only the Search button** on the live page, validates the new locator actually resolves,
> and writes a **draft** — 1.1.0. Here's the `ladder_before → ladder_after` diff. It's a *draft*: not
> runnable yet." *(If the dashboard is open, the draft also appears under **Proposed repairs**.)*

**7f. Approve — the human gate, with a different member:**

```bash
npm run cli -- approve find_member_by_number@1.1.0 --by "reviewer@example.test" --param member_number=101555 --auth teller --headless
```

> **Say:** "A **different person** approves it, and approval **replays with a different member** to prove
> it generalizes — not memorizes. Now 1.1.0 is live."

**7g. Green again:**

```bash
npm run cli -- eval --manifest eval/meridian.yaml --headless
```

> **Say:** "Detect drift, propose a repair, a human approves, back in service. No engineer edited an
> artifact, no rewrite. And replay stayed deterministic and model-free the whole time — the model only
> ever *proposed*, a person *approved*."

**7h. Restore after the demo (important):**

```bash
git checkout -- artifacts/find_member_by_number@1.0.0.json && rm -f artifacts/find_member_by_number@1.1.0.json
```

**Gentler variant — data-shape drift (an early warning, no hard break).** Drop one declared column so the
run still succeeds but the live table now has a column the recording no longer maps:

```bash
node -e "const fs=require('fs');const p='artifacts/find_member_by_number@1.0.0.json';const a=JSON.parse(fs.readFileSync(p));a.extract[0].columns=a.extract[0].columns.slice(0,-1);fs.writeFileSync(p,JSON.stringify(a,null,2)+'\n')"
npm run cli -- eval --manifest eval/meridian.yaml --headless   # find_member_by_number → DRIFT (shape)
git checkout -- artifacts/find_member_by_number@1.0.0.json     # restore
```

> **Say:** "Every locator matched perfectly — the run succeeded — but the results table grew a column the
> recording doesn't map. Locator health alone would call this green; shape drift catches that the app
> restructured the data underneath us. No member data is stored to do it — only the column labels are
> compared."

---

## 8. Opt-in debug screenshots — the data-minimization trade-off

Every run so far showed a **"screenshots withheld"** banner — the safe default. Restart the server in
capture mode (terminal 1, Ctrl-C first):

```bash
npm run serve -- --auth teller --demo --capture-screenshots
```

The startup line ends with **"(debug screenshots on, 24h retention)"**. Hard-refresh, then in the chat box:

```
look up member 100987 by number
```

Click the run → the **EVIDENCE** section now shows per-step screenshot links. Prove they're safe:

```bash
ls runs/*/steps/*.png | head   # exist — only on local disk under runs/
git check-ignore runs          # prints "runs" → git-ignored, never committed
```

> **Say:** "By default a sensitive run captures no screenshots — that's the withheld banner. But a human
> debugging a live legacy UI needs to see the screen, so there's an opt-in debug mode. These live only
> locally under `runs/`, they're git-ignored so they can never be committed, and a sweep auto-deletes
> them after 24 hours. Debuggability vs. data minimization, handled the way a regulated system would."

*Switch back to `npm run serve:meridian` afterwards for the withheld default.*

---

## 9. Proof it's real, not staged — terminal 2

```bash
python3 -m json.tool evidence/meridian/01_read_success/result.json   # outputs show «redacted»
npx vitest run tests/artifact/secret-scan.test.ts 2>&1 | tail -3     # no artifact ever leaks member data
npm run test:meridian 2>&1 | tail -4                                 # hidden per-form token never in artifact/log (live)
npm test 2>&1 | tail -3                                              # fully offline suite
```

> **Say:** "Normal tests are fully offline; there's an opt-in live suite; a secret scan guards every
> artifact. The interesting bugs in this project all came from recording against the *real* app — written
> up in `ADAPTATION.md` §6."

---

## Fallback if the live host is down

```bash
npm test 2>&1 | tail -3           # offline suite passes
cat evidence/meridian/README.md   # committed proof of every behaviour
```

The whole story is provable without the live host.

## Two things to get right on the day

- **Chat:** wait for the reply before pointing at the dashboard — the run finishes as the reply lands.
- **Step 6:** re-run 6a right before 6b — the shared host puts shares on hold as you use them.
- **Step 7:** always run the restore in 7h so the repo is left clean.
