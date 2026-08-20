# MERIDIAN demo evidence

Same-day evidence captured against the live MERIDIAN CORE host, one directory per
acceptance behavior. Each holds the run's `log.jsonl` (redacted event stream) and
`result.json` (redacted terminal result). Screenshots and provider transcripts
are omitted — screenshots are withheld once a sensitive value is on screen, and
transcripts are the model's own I/O.

| Directory | Shows |
|---|---|
| `01_read_success` | a member lookup returning a typed, **redacted** matches table |
| `02_member_not_found_business_outcome` | a no-match search reported as `MEMBER_NOT_FOUND`, a business outcome — not a failure |
| `03_maintenance_bounded_recovery` | injected maintenance, the `maintenance_continue` recovery firing (bounded), and the run completing |
| `04_server_error_technical_failure` | injected server error surfaced as a structured `app_error` technical failure with a retry disposition |
| `05_transfer_human_boundary` | a transfer approval that pauses at the human boundary (`intervention_requested`) before Post Transfer |
| `06_place_hold_supervisor_escalation` | a supervisor-authority hold approval that pauses for a human before Apply Hold |

**On redaction:** member names, numbers, share ids, balances, and confirmation
numbers are blacked out as `«redacted»` in all persisted evidence; the real
values are returned only to the authorized caller. The `operator` field in
`signed_on` events is intentional — an audit trail records **who** performed each
action — and the demo credentials there (`teller1`, `super1`) are test data, with
passwords never logged.

Regenerate any of these with `npm run serve:meridian` and the demo path in the
[README](../../README.md#meridian-adaptation-demo).
