# Evidence index

All records use the fictional CorePoint application. Text evidence has been redacted; discovery screenshots contain only seeded fictional data.

| Directory | Demonstrates | Expected result |
|---|---|---|
| `discovery_anthropic/` | Genuine Claude Sonnet 4.6 observe/decide/act run, transcript, screenshots, and distilled artifact | `success` |
| `replay_success/` | Model-free replay with member `8832`, different from discovery input | `success` |
| `replay_business_outcome/` | Expected missing-member result | `business_outcome / MEMBER_NOT_FOUND` |
| `replay_recovered_session_modal/` | Bounded dismissal of a known session-expiry interstitial | `success` plus `recovery_applied` |
| `replay_hard_failure_error500/` | Injected application error with DOM and locator-attempt debug bundle | `failure / app_error` |
| `replay_handoff/` | Supervisor intervention, human lease, redacted human actions, hand-back, and resume | `success` plus intervention summary |
| `replay_tenant_b/` | Base artifact specialized through a Tenant B overlay | `success` |

The root artifact used by deterministic lookup replay is `../artifacts/lookup_member_savings_balance@1.0.0.json`; the exact artifact emitted by discovery is also saved as `discovery_anthropic/artifact.json`.

To reproduce these branches manually, follow the checklist in the repository `README.md`. Normal local runs write to ignored `/runs/`; the committed `/evidence/` directory is intentionally tracked.
