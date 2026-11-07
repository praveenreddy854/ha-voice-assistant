# Online evaluations

Online evaluations automatically grade completed production runs after first enablement. The backend starts a separate supervised worker; telemetry discovery, evidence processing, queue persistence, and both model calls run in that process. No eval call runs in the user's command or audio response path. The worker cannot execute device actions: its network boundary permits only the configured Azure model endpoint.

Open `/dashboards/evals/online` from the existing eval dashboard. It shows worker health, queue coverage, errors, disagreements, model/prompt/judge cohorts, both independent judgments, and the evidence snapshot. The read APIs are `GET /api/evals/online` (optional `agentId`) and `GET /api/evals/online/:id`. Summary responses never load images or complete evidence packets; detail explicitly loads the selected snapshot.

## Quality policy

- Reuse the evidence-grounded recorded-run rubric for TVAgent, ScheduledTaskAgent, Realtime Voice Agent, and downstream Home Assistant execution. Voice decisions and downstream execution are separate evaluations. Job acceptance never proves physical device completion. Audio delivery and recognition quality cannot be established from these text traces.
- Every model packet explicitly declares `evaluationScope`: `routing` for voice decisions, `execution` for specialist/device outcomes. An accepted faithful voice delegation can pass its routing task while the separate physical outcome remains unknown.
- Run a primary judge and an independent reviewer. The reviewer does not see the primary judgment. Both must satisfy runtime schema validation and cite actual retained evidence. Disagreements in task/handling/reporting/recovery become `unknown` for that dimension; differences in steps or scoring require review. Preserve both opinions and never average disagreements into success.
- TV task scores use the existing versioned rubric; only publish a numeric score when both judgments agree on the assessed progress, score, mistake severity and cited mistake actions. Other agents retain categorical judgments. Partial evidence remains partial even though capture was automatic.
- Preserve request qualifiers, scoped preferences, previous clarification, and the correct device. A saved guard-mode preference can justify a camera action; the same action without that preference may be wrong. Evaluate the entire requested timed sequence and its original deadline, not just a successful write.
- Snapshot retained evidence once, store its hash, and check integrity before grading. Repeated message/system snapshots refer to shared evidence instead of repeating the entire conversation at each model step. Distinct messages and images remain retained; they are not summarized by another model or silently truncated.
- Oversized evidence is an explicit `eval_error`, with no judge call. Timeout/provider/schema errors are evaluation errors, separate from an assessed assistant failure. Sampling and queue overflow are visible coverage gaps. Summary cohorts preserve assessed model, prompt version, grader version and both judge models; changing workload mix does not establish a causal model comparison.

The new `LOG-*` calibration fixtures are synthetic, reviewed cases derived from observed failure patterns, including expired relative deadlines, missing delayed phases, target loss, correct preference use, unrequested action expansion, and routing-only evidence. Existing nine TV scoring references still cover repeated ineffective methods, honest failure and insufficient execution evidence. Run the existing agent-scoped calibration commands against the actual judge deployment before treating its scores as reliable measurements. Reference agreement is a smoke check, not measured accuracy on a held-out production set.

The approved 16-call GPT-6 Astra smoke calibration matched 14 expectations and exposed a shared routing/execution ambiguity on `LOG-R4`. The final prompt adds explicit scope to address it. That revised prompt has local contract tests but has not had a further paid model calibration; the original result is preserved in [the calibration report](online-eval-calibration.md).

## Queue and recovery

`ONLINE_EVAL_DIR` contains private JSON files in `records`, `snapshots`, `results`, and `state`. The worker holds a process lock. Initial enrollment is persisted and does not backfill old history; disabling and reenabling retains that boundary. After a two-second terminal-evidence settling interval, supported completed/error traces enter an oldest-first queue. Discovery itself never calls the model. Stable per-session IDs prevent repeated polling or restart from duplicating an attempt. Terminal discovery also picks up missed notifications; it does not depend on request callbacks.

Restart resumes queued work that never started. A record left running becomes `eval_error`; it is never automatically charged again. A result published just before a crash is recovered into the completed summary. The supervisor restarts a stopped worker on its next 30-second tick. It sends SIGTERM on shutdown, then terminates it after five seconds if necessary.

Re-evaluate a retained snapshot explicitly from Details. `POST /api/evals/online/:id/retry` accepts `{ "requestId": "<UUID>" }`, returns 202, preserves the old attempt, and reuses that UUID after an uncertain response. A concurrent evaluation for the same source or a full queue returns 409. A run skipped before snapshot capture cannot be retried here; use recorded-run evaluation for an agent supported by the offline portal. There is no silent retry of paid grading. Original snapshots and attempts are retained until removed by the operator; this implementation does not delete history automatically.

Online history is stored separately from existing recorded/simulated eval history and does not enter synthetic regression baselines. The existing daily recorded schedule and manual recorded evaluations remain independently available; running both modes on the same session can incur additional grading calls.

## Configuration

| Setting | Default | Purpose |
| --- | --- | --- |
| `ONLINE_EVAL_ENABLED` | `true` | Set `false` to disable worker startup and new retry admission |
| `ONLINE_EVAL_DIR` | `service/generated_data/online-evals` | Shared local durable storage |
| `ONLINE_EVAL_JUDGE_MODEL` | `OFFLINE_EVAL_JUDGE_MODEL`, then `AI_MODEL_ADVANCED` | Primary judge deployment |
| `ONLINE_EVAL_REVIEW_MODEL` | Primary judge | Independent reviewer deployment; may use a different model |
| `ONLINE_EVAL_SAMPLE_RATE` | `1` | Stable deterministic fraction, 0–1 |
| `ONLINE_EVAL_MAX_PENDING` | `500` | Maximum queued/running records |
| `ONLINE_EVAL_TIMEOUT_MS` | `180000` | Total deadline across the two judgments |
| `ONLINE_EVAL_POLL_MS` | `5000` | Worker discovery polling interval |
| `ONLINE_EVAL_MAX_TEXT_BYTES` | `350000` | Maximum text packet size after factoring shared evidence |
| `ONLINE_EVAL_MAX_EVIDENCE_BYTES` | `16000000` | Maximum complete packet size including images |
| `AI_MODEL_HOME_ASSISTANT` | `AI_MODEL_ADVANCED` | Downstream HA translation deployment; set explicitly to use a different quality/latency tradeoff |

The operating service must run this code for new downstream execution traces to exist. Old voice records ending at a job ID cannot reconstruct missing HA outcomes. No live service restart or deployment is part of local development validation.
