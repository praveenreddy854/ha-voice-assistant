# A single ScheduledTaskAgent owns every ScheduledTask flow

After intent classification labels a prompt `scheduled_task`, all subsequent reasoning — creation parsing, device disambiguation, listing, querying, and firing — runs through one agent registered in `service/src/agents/`. The intent classifier emits a single label; it does **not** sub-classify into CREATE/LIST/QUERY.

## Considered Options

- **Single LLM call for parsing + agent only at fire time.** This was the recommended path: cheaper and faster for trivial create/list/query operations. Rejected by the user in favor of a single unified agent entry point so that future capabilities (cross-task reasoning, conditional schedules, multi-device orchestration) have one place to live.
- **Sub-classified intents (CREATE / LIST / QUERY) with the agent only on CREATE.** Rejected for the same reason — the user wanted one agent surface, not three call sites.

## Consequences

- LIST and QUERY voice commands ("what tasks do I have today?") run a multi-step agent loop instead of a single LLM call. Expect noticeably higher latency and token cost than the legacy reminder LIST/QUERY paths. Accepted trade-off in exchange for unification and future-proofing.
- The intent classifier stays small and rarely needs to change when scheduled-task capabilities grow.
- Adding new ScheduledTask features means extending the agent's tool set, not adding new endpoints or LLM call sites.
