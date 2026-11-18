# Controlled model comparisons

The live service's recent model samples have different requests and starting states, so their aggregate success counts cannot establish a model regression. Use the same controlled scenarios for both deployments:

```sh
cd service
npm run eval:compare -- scheduled_task baseline-deployment candidate-deployment timed-action-shutoff relative-delay-processing-latency expired-short-relative-deadline
npm run eval:compare -- tv baseline-deployment candidate-deployment youtube-launch-recovery telugu-fresh-search
```

This command makes paid calls to both assessed models and the configured offline judge. It runs only simulated adapters, installs the existing model-only network boundary, and acquires the shared offline worker/submission locks. It never replays real devices, starts a parallel offline worker, or resumes paid work after interruption.

Before model execution, both adapters must agree on their full fixture manifests, scenario versions, prompt/tool version and agent identity. Each run uses a fresh simulated environment. Judge grouping context is frozen across the comparison. Baseline/candidate execution order alternates by scenario; the exported `compareModels` API also supports 1–5 repetitions and alternates their order. A protocol-compatible reasoning deployment is required. Current Realtime comparisons use the production delegated AI SDK reasoning contract. Historical native Realtime results have a different adapter/prompt version and cannot establish a regression against this cohort.

`OFFLINE_EVAL_DIR/model-comparisons/<id>.json` links each pair to both retained runs and identifies its manifest, judge model and grader version. Independent simulator final-state assertions determine improved/regressed/unchanged fulfillment. Execution or grading errors produce incomplete pairs, never synthetic model failures. Intermediate results are retained; a later invocation marks an interrupted comparison incomplete rather than replaying it automatically.

A single paired run is a diagnostic smoke comparison. It is not a statistically established model ranking. Retain per-scenario evidence, repeat on a separately reviewed held-out set, and inspect handling/reporting and latency as well as fulfillment before changing deployments. No extra paid comparison runs were launched while implementing this command.
