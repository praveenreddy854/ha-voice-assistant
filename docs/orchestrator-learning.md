# Orchestrator learning design

Design discussion in progress; this document records agreed direction and distinguishes it from proposals that still need resolution. Domain terms are defined in [CONTEXT.md](../CONTEXT.md#task-execution-learning).

## Agreed direction

- Improve assistant quality and task latency using relevant past conversations and execution history, with bounded context to limit irrelevant influence.
- A successful task needs observed evidence or explicit user feedback that the requested result occurred; a reported completion alone is insufficient.
- Multi-step agents, including TVAgent, should learn from alternative execution methods for individual task steps. Opening Disney+ directly and reaching it through camera-guided remote navigation are alternatives for the same objective.
- Future method selection should reflect observed latency and reliability across past attempts.
- Prefer lower latency over a modest improvement in reliability, using the advisory guidance below.
- The LLM chooses between applicable execution methods using prompt guidance; the illustrative reliability and latency numbers are not enforced thresholds or a fixed scoring formula.

## Agreed decision ownership

- The agent owns execution decisions throughout the task, including method choice, retries, recovery, trying unfamiliar methods, and whether more history is useful.
- The orchestrator supplies current observations, relevant historical evidence, and guidance for those decisions, and enforces the agreed context budget.
- Method-selection examples and retrieval recommendations inform agent judgment rather than prescribing a fixed sequence of actions.
- This decision concerns execution and learning within the user's request and the established assistant capability policy.

## Agreed method-selection guidance

The prompt should convey these preferences as examples for judgment:

- Favor the faster method when it is roughly 10% less reliable and the alternative takes twice as long or more.
- When a method's reliability is very low, around 80% or below, generally favor an available alternative around 90% reliability or above. The user's phrase "latency 90% or above" is interpreted as reliability here.
- Consider the faster method when a plausible retry or recovery can achieve the verified result within the time advantage over the slower alternative.
- Weigh these preferences together rather than treating any percentage or latency ratio as an absolute eligibility rule.

## Agreed history presentation

- Supply compact Execution history summaries of relevant prior attempts by default; retrieve original chat excerpts only when the model needs supporting detail.
- Summaries identify the method, applicable device and app state, verified successes and failures, attempt count, and observed time including verification and recovery.
- Include relevant user preferences and corrections alongside execution evidence.
- Preserve source references so the model can inspect retained original interactions when a summary leaves an uncertainty unresolved; indicate when a source has expired.

## Agreed context budget

- The orchestrator enforces a token budget for retrieved history, including summaries and source excerpts; the LLM chooses relevant material within that budget.
- Start with a small set of relevant summaries, and allow the model to request additional evidence to resolve a specific uncertainty.
- Replace less useful retrieved history as the task progresses rather than continually appending it. Once Disney+ is open, detailed launch history can make room for search guidance.
- Preserve the current request, verified progress, and relevant user corrections when replacing retrieved history.
- The budget size has not yet been selected. This enforced context limit is separate from the advisory method-selection percentages and latency ratios.

## Agreed retrieval timing

- Support task-history retrieval in the background so the agent can proceed from current state and available cached evidence when it judges that sufficient.
- Make late results available at the next decision point when they remain relevant to the current task and state.
- A request such as "play Mandalorian" can begin by inspecting the Apple TV while history loads.
- When missing history determines the user's intent, such as "repeat what we did yesterday," wait briefly or ask for clarification instead of guessing.

## Agreed unfamiliar methods

- The agent may choose a method with little or no recorded history during an ordinary request, using current evidence to judge its applicability and recovery options.
- Missing history represents uncertainty rather than demonstrated unreliability.
- Verify the outcome and record the full time, including recovery. Keep the number of attempts visible so a single fast success is not presented as established reliability.

## Agreed sharing scope

- Reusable execution evidence is shared across the household's devices and assistant entry channels, including browser voice and Siri.
- Each summary identifies its source device, app, starting state, and time so the agent can judge whether the experience applies to the current request.
- A successful execution method on one Apple TV may inform method selection for another Apple TV.
- Conversational references such as "do that again" remain tied to the current channel's conversation. Sharing reusable execution evidence preserves the existing separation between browser and Siri short conversational memory.

## Agreed evidence capture

- Preserve completed attempts through a compact durable execution record saved before the user receives the task result.
- Generate history summaries and embeddings in the background after capture, so expensive learning work does not delay the completion response.
- Retained execution records allow unfinished summarization and indexing to recover after a service restart.
- Storage technology, failure handling, and the time allowance for the durable save remain implementation details to resolve.

## Agreed retention

- Retain original chat excerpts and detailed execution traces for 90 days.
- Retain compact execution records and reusable summaries until explicitly deleted.
- Preserve provenance when source detail expires, and indicate that the original source is no longer available rather than implying it can still be retrieved.
- Storage retention is separate from prompt inclusion: all retrieved material remains subject to the agreed history context budget.

## Implementation sketch (proposed)

- Extend shared capability execution and specialist lifecycle capture to identify task steps and individual method attempts. Existing tool calls and model iterations do not define these domain boundaries.
- Add context preparation at each model decision, with replaceable history and valid tool-result message relationships. Channel adapters preserve their existing conversational scopes.
- Make background retrieval results available to the active task, checking their relevance to current progress before the next model decision.
- Persist compact execution records before reporting completion, with restartable summary and indexing work afterward. Expire source detail independently of compact records and summaries.
- Correlate existing latency and token telemetry with task steps, method attempts, selected historical evidence, and verified outcomes.

The initial history token allowance, storage plumbing, and statistical representation of evidence uncertainty remain implementation details to propose and validate. Visible attempt counts and distinguishing unverified outcomes are already agreed.

The [initial live TV pilot](./orchestrator-live-pilot.md) tested curated context with the existing runtime. Both arms timed out; it did not demonstrate an improvement. It identified lost tool history across screenshot continuations as a runtime defect to fix before further comparisons.

## Validation proposal

Compare current behavior with the new design on representative requests from comparable starting states. Measure time to verified task completion, including retrieval, verification, and recovery; also report final failures, unnecessary actions, and cases where historical context causes an incorrect decision. Check restart recovery, source expiry, channel-scoped follow-ups, and the enforced history budget.

## Workload evidence

The user requested actual frequent tasks from Cosmos and details through the service API. The [2026-09-05 history baseline](./orchestrator-history-baseline.md) identifies YouTube launch, Telugu-song playback, Smart STB launch, pause/resume, and Netflix launch as initial TV benchmark candidates, with the observed Tesla scheduling/list/update conversation for cross-agent coverage. The baseline also identifies historical outcome-label contradictions that must be accounted for before using stored success counts as reliability evidence.
