# Evidence index

All records use the fictional CorePoint application. Text evidence has been redacted; discovery screenshots contain only seeded fictional data.

| Directory | Demonstrates | Expected result |
|---|---|---|
| `discovery_anthropic/` | Genuine Claude Sonnet 4.6 observe/decide/act run, transcript, screenshots, and distilled artifact | `success` |
| `approval_validation/` | The replay that earned approval, run against a member the recording never saw | `success` |
| `replay_success/` | Model-free replay with member `8832`, different from discovery input | `success` |
| `replay_business_outcome/` | Expected missing-member result | `business_outcome / MEMBER_NOT_FOUND` |
| `replay_recovered_session_modal/` | Bounded dismissal of a known session-expiry interstitial | `success` plus `recovery_applied` |
| `replay_hard_failure_error500/` | Injected application error with DOM and locator-attempt debug bundle | `failure / app_error` |
| `replay_handoff/` | Supervisor intervention, human lease, redacted human actions, hand-back, and resume | `success` plus intervention summary |
| `replay_tenant_b/` | Base artifact specialized through a Tenant B overlay | `success` |

The lookup evidence replays `../artifacts/lookup_member_savings_balance@1.1.0.json`; the exact artifact emitted by discovery is also saved as `discovery_anthropic/artifact.json`. The `replay_hard_failure_error500/` and `replay_handoff/` records exercise the mutating `open_sub_account@1.0.0` capability.

## Why there are two versions of the lookup capability

`@1.0.0` is retained deliberately. Versions are immutable, and the diff between the two is the clearest record of what the distiller stopped doing:

- **`@1.0.0` step `s4` contains a member's name in its intent text.** The model's reasoning becomes the step description, and only *parameter* values were ever templated out — anything the model quoted from the screen survived into the contract.
- **`@1.0.0` has four steps; `@1.1.0` has three.** Steps `s1` and `s2` were the same action on the same control, because the model re-entered a value it had already entered and the trajectory was recorded verbatim.

`@1.1.0` also carries a per-parameter `input_fingerprint`, which is how approval proves it replayed a different invocation without the artifact holding the invocation.

## How `@1.1.0` was approved

Approval is not a status flip. `approve` runs a real replay through the same path a caller uses and only writes the approved status if it succeeded:

```
approve … --param member_id=4521   → refused: "Validation replayed the discovery inputs"
approve … --param member_id=8832   → approved, recording run, outcome and matched tiers
```

The resulting record is in `capability.provenance.validation`, and the run itself is `approval_validation/`.

To reproduce these branches manually, follow the checklist in the repository `README.md`. Normal local runs write to ignored `/runs/`; the committed `/evidence/` directory is intentionally tracked.
