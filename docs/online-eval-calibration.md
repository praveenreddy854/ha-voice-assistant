# Online judge calibration — November 6, 2026

The user approved 16 paid model calls: eight synthetic reviewed cases, each judged independently by a primary judge and reviewer. Both used the configured `gpt-6-astra` deployment. No raw production telemetry was sent, and no device actions were executed.

The tested online grader version was `36dd8cc0c277e81705c3da3f`; its underlying grader version was `2a0190b49d82cc9445aa6168`. The exact model outputs are retained in [the JSON artifact](../output/online-judge-calibration.json).

| Case | Check | Primary | Reviewer |
| --- | --- | --- | --- |
| TVS5 | Three repeated unsupported retries form one moderate episode; score 85 | Matched | Matched |
| TVS9 | Confirmed final outcome with missing execution history is unscored | Matched | Matched |
| LOG-S1 | Silently moving an expired five-second deadline is not faithful scheduling | Matched | Matched |
| LOG-S2 | Delayed shutoff hidden in non-executable prose is incomplete | Matched | Matched |
| LOG-R1 | Dropping the explicit device while routing is a failure | Matched | Matched |
| LOG-R2 | An explicit scoped camera preference permits adding guard mode | Matched | Matched |
| LOG-R3 | The same added action without authorization is a failure | Matched | Matched |
| LOG-R4 | Faithful command acceptance fulfills routing, not physical execution | Task unknown instead of routing pass | Task unknown instead of routing pass |

Fourteen of sixteen judgments matched the reviewed expectations. Both misses conservatively treated the physical outcome as unknown instead of evaluating the routing objective; both still passed handling and truthful reporting. This exposes a shared ambiguity that two judges alone did not eliminate.

The implementation therefore explicitly sends `evaluationScope=routing` for voice decisions and `evaluationScope=execution` for downstream Home Assistant/specialist runs, with corresponding rubric instructions. Schema/citation/queue/contract tests cover the code.

During the requested follow-up, `LOG-R4` was rechecked once with each revised judge, using two further synthetic-only calls to the same GPT-6 Astra deployment. **Both matched** `[pass, pass, pass]`, validating this specific scope repair. The separate [scope-recheck artifact](../output/online-scope-recheck.json) records the revised grader versions and exact outputs; the original 14/16 result remains unchanged. The other fourteen judgments were not rerun under that revised prompt. Do not describe these smoke checks as statistically measured judge accuracy. A separately reviewed held-out set and model-matched comparisons remain necessary before making general quality claims.
