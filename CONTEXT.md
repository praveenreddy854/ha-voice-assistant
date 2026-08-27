# HA Voice Assistant

A voice-controlled smart-home assistant. Wake-word detection runs on the React client; post-wake-word voice turns, agent reasoning, and Home Assistant control run through the Node.js service.

## Language

### Voice orchestration

**Realtime Voice Agent**:
The post-wake-word conversational agent that owns the live voice turn and delegates smart-home work to specialist agents or direct Home Assistant command execution.
_Avoid_: Main agent, Chat agent, Intent classifier.

**Specialist agent**:
An agent with ownership of a bounded smart-home capability, such as TV control or ScheduledTask handling, invoked by the Realtime Voice Agent.
_Avoid_: Sub-agent, Skill, Intent.

**TVAgent**:
The single Specialist agent that owns TV and streaming-app control through remote actions, screenshots, and TV skills.
_Avoid_: TV agents, AppleTVAgent, YouTubeAgent.

**Silent specialist run**:
A delegated Specialist agent run whose internal tool calls and progress are not spoken unless the agent needs user input or has a final user-facing result.
_Avoid_: Announced iteration, spoken tool progress.

**Blocking specialist run**:
A delegated Specialist agent run that completes within the active voice turn before the assistant gives the final spoken response.
_Avoid_: Synchronous intent handler.

**Async specialist run**:
A delegated Specialist agent run that continues after the voice turn has delegated the work, staying silent unless user input or a final result must be surfaced.
_Avoid_: Background intent, detached chat.

**Async acknowledgement**:
A command-only spoken confirmation that an Async specialist run has started before the assistant returns to silent progress. It is exactly "On it" or "Working on it"; "On it" is the default.
_Avoid_: Progress narration, tool-call narration.

**Follow-up voice turn**:
A short no-wake-word voice turn opened when the Realtime Voice Agent or a Specialist agent has a pending question or confirmation request. The microphone reopens only because of that pending prompt and stays open for at most 30 seconds. If the user does not answer within 30 seconds, the turn ends. A new follow-up question after the user answers gets its own fresh 30-second window.
_Avoid_: New wake-word session, UI-only prompt, idle listening window, unbounded follow-up.

**Scoped follow-up answer**:
User speech during a Follow-up voice turn interpreted only as an answer to the pending question. The Realtime Voice Agent forwards the answer to the right Specialist agent by re-invoking it with the original request plus the answer; there is no server-side session resume of a paused Specialist agent run.
_Avoid_: New command, topic switch, paused-session resume.

**Completion announcement**:
A routine command's spoken success result after user-requested work completes. It is exactly "Done" or an equally terse equivalent. Answers to user questions and responses requiring user action are not Completion announcements: they remain complete and understandable.
_Avoid_: Progress narration, detailed run summary.

**Direct Home Assistant command**:
An immediate smart-home control request executed through the existing Home Assistant command executor rather than a Specialist agent.
_Avoid_: HomeAssistantAgent, HA specialist agent.

**Direct Home Assistant state query**:
A read-only request for the current state or attributes of a smart-home entity.
_Avoid_: Status command, HomeAssistantAgent query, Service call.

**General chat**:
A conversational request the Realtime Voice Agent can answer directly without smart-home execution or Specialist agent delegation.
_Avoid_: Chat intent.

**Clarification request**:
A short question the Realtime Voice Agent asks before choosing a capability or action when the user's request is ambiguous.
_Avoid_: Guess, priority fallback.

**Bulk destructive action**:
A smart-home or ScheduledTask request that removes, cancels, or changes many things at once.
_Avoid_: Routine command.

**Protected opening action**:
A request to open or unlock the back door, front door, or garage door.
_Avoid_: Routine command.

**Action confirmation**:
A short question the Realtime Voice Agent asks before executing a Bulk destructive action or Protected opening action.
_Avoid_: Routine confirmation.

**ScheduledTask voice flow**:
A blocking Realtime voice turn where the ScheduledTaskAgent handles ScheduledTask creation, listing, querying, cancellation, clarification, or confirmation.
_Avoid_: Async ScheduledTask job.

**ScheduledTask firing flow**:
A server-side firing flow that runs when an Action effect fires. It performs a primitive device-availability check and then executes the stored Home Assistant command. It does not invoke the ScheduledTaskAgent — the agent's reasoning happened at create time when the entity was resolved.
_Avoid_: Realtime voice turn, client-side firing, fire-time agent loop.

**Firing exception announcement**:
A spoken message produced when a ScheduledTask firing flow skips, fails, or aborts an Action effect.
_Avoid_: Silent skip.

**Firing success announcement**:
A brief spoken message produced when a ScheduledTask firing flow successfully executes an Action effect.
_Avoid_: Detailed run summary.

**Replace conflicting TV run**:
The rule that a new TV command cancels the active TVAgent run and starts a new one. This is the only conflict rule that exists — there is no general cross-domain or per-device lock.
_Avoid_: Ask-to-cancel, queue TV command, generic domain lock.

**Realtime voice turn**:
A post-wake-word interaction where the user's live speech is handled directly by the Realtime Voice Agent until the turn is complete.
_Avoid_: Command transcript, text-only turn.

**Voice turn boundary**:
The moment a Realtime voice turn is considered complete. A turn ends when the assistant finishes its response, unless that response is a pending question or confirmation that opens a Follow-up voice turn.
_Avoid_: Browser silence timeout, command recording timeout, fixed listening window.

**Short conversational memory**:
Recent conversational context carried across wake-word sessions for interpreting follow-up requests.
_Avoid_: Long-term memory, source of device truth.

**Persistent agent memory**:
Long-lived assistant memory of user preferences, stable facts, and prior guidance that can inform future voice interactions.
_Avoid_: Short conversational memory, device truth, trace log.

**Scoped memory**:
A Persistent agent memory item tagged by where it applies, such as global, room, device, domain, app, person, or agent.
_Avoid_: Device-only memory, memory category.

**Memory consolidation**:
A background process that turns recent interactions and explicit memory requests into durable Persistent agent memory.
_Avoid_: L3 memory scan, trace summarization.

### Scheduled tasks

**ScheduledTask**:
A future-dated item the user creates by voice that fires an effect when due. Has exactly one effect: `announcement` or `action`. May be one-shot or recurring.
_Avoid_: Reminder, Cron, Schedule, Job. (Replaces the legacy "Reminder" naming.)

**Announcement effect**:
A `ScheduledTask` whose firing speaks a message — e.g. "take your medicine".

**Action effect**:
A `ScheduledTask` whose firing executes a Home Assistant command through a ScheduledTask firing flow — e.g. start the roborock vacuum. The stored command is a natural-language string scoped to a specific entity (e.g. `"start roborock vacuum"`, not `"start vacuuming"`); the agent resolves the entity at create time, not at fire time.

**Fire (verb)**:
The act of executing a `ScheduledTask`'s effect at its due time. Always happens server-side.

**ScheduledTaskRun**:
The audit record of a single fire. One row per fire, written to the history container. Includes outcome (`succeeded` / `failed` / `skipped` / `aborted_by_agent`), agent trace, and a snapshot of relevant device state at the moment of firing.

**Recurrence family**:
The lineage of `ScheduledTask` records produced by a single recurring instruction. Every occurrence — past, current, future — shares a `recurrenceFamilyId`. This is what "cancel all future tesla-charge tasks" operates on.

**ScheduledTaskAgent**:
The single Specialist agent that handles ScheduledTask voice flows: creation (parse, disambiguate device, ask user, save), list, query, update, and cancellation. It does not participate in firing — firing is a separate, primitive server-side flow.

## Relationships

- The **Realtime Voice Agent** is the single post-wake-word voice entry point.
- A **Realtime voice turn** starts after wake-word detection and is handled as live audio, not as a finalized command transcript.
- The **Voice turn boundary** is owned by the realtime voice session, not by browser-side command recording.
- The **Realtime Voice Agent** may use **Short conversational memory**, but current device state and active specialist state remain authoritative.
- **Short conversational memory** keeps the last 10 user/assistant messages or about five minutes of interaction, whichever is smaller.
- The **Realtime Voice Agent** and **Specialist agent**s may use **Persistent agent memory**, but current device state and active specialist state remain authoritative.
- **Persistent agent memory** stores durable user-relevant facts and preferences, not transient chat, device state, tool traces, or failed agent runs.
- **Persistent agent memory** may be written from explicit user requests or conservatively inferred from high-confidence durable preferences and facts.
- Newer user instructions and current device state override **Persistent agent memory**.
- The user can inspect, delete, or correct **Persistent agent memory** by voice.
- **Scoped memory** may include device names, but device names are one retrieval facet rather than the only memory category.
- Device-related **Scoped memory** must identify a target device, room, domain, or app; if the target is ambiguous, the assistant asks a clarification request before saving.
- **Memory consolidation** creates or updates **Persistent agent memory** without treating raw device state or tool traces as memory.
- Agent runs should receive compact **Persistent agent memory** context before answering, with bounded waiting so unavailable memory does not block the voice turn indefinitely.
- The **Realtime Voice Agent** delegates ScheduledTask requests to the **ScheduledTaskAgent**.
- The **Realtime Voice Agent** delegates TV and streaming-app requests to the **TVAgent**.
- The **Realtime Voice Agent** handles a **Direct Home Assistant command** as a blocking tool call.
- The **Realtime Voice Agent** can answer **General chat** directly.
- **General chat**, **Direct Home Assistant command**, and Specialist agent delegation are capabilities selected by request meaning, not by a fixed priority order.
- The **Realtime Voice Agent** uses a **Clarification request** when the intended capability or action is ambiguous.
- Routine smart-home actions do not need confirmation.
- A **Bulk destructive action** requires an **Action confirmation**.
- A **Protected opening action** requires an **Action confirmation**.
- A **Specialist agent** owns its domain behavior rather than sharing that behavior with the **Realtime Voice Agent**.
- A **Silent specialist run** may update UI progress, but it does not produce spoken progress messages.
- A Specialist agent may run as a **Blocking specialist run** or an **Async specialist run** depending on expected duration and user involvement.
- **TVAgent** runs are async by default.
- **ScheduledTaskAgent** runs are blocking by default.
- The **Realtime Voice Agent** handles a **Direct Home Assistant state query** as a blocking tool call.
- A **Direct Home Assistant state query** may answer a status question, but it never changes device state.
- ScheduledTask creation, listing, querying, cancellation, clarification, and confirmation happen inside a **ScheduledTask voice flow**.
- An **Announcement effect** fires through the existing announcement/TTS path.
- An **Action effect** fires through a **ScheduledTask firing flow**.
- A **ScheduledTask firing flow** may skip, fail, or abort an Action effect based on current device state, and then produce a **Firing exception announcement**.
- A successful **Action effect** produces a terse **Firing success announcement**, normally "Done".
- A recurring **Action effect** produces a **Firing success announcement** for every successful occurrence.
- An **Async specialist run** handling a command starts with the **Async acknowledgement** "On it" by default.
- When a Specialist agent needs user input, the assistant opens a **Follow-up voice turn**.
- A **Follow-up voice turn** accepts only a **Scoped follow-up answer**.
- A routine command's **Completion announcement** is "Done" or an equally terse equivalent.
- Answers to user questions remain complete and understandable; they are not shortened into **Completion announcements**.
- Failures, clarification requests, action confirmations, and other responses requiring user action state the relevant detail and what the user needs to do.
- Async work may run alongside new commands. The only conflict rule is **Replace conflicting TV run**.
- A **ScheduledTask** has exactly one effect (`announcement` | `action`) and exactly one `recurrenceFamilyId`.
- A recurring **ScheduledTask** that fires produces one **ScheduledTaskRun** *and* a new **ScheduledTask** (the next occurrence) sharing the same `recurrenceFamilyId`.
- A one-shot **ScheduledTask** that fires produces one **ScheduledTaskRun** and is then deleted from the active container.
- Active and history live in **separate Cosmos containers**: `scheduled-tasks` (active upcoming only) and `scheduled-tasks-history` (all past runs).

## Example dialogue

> **Dev:** "If a user says 'remind me to take medicine at 9 AM', is that the same kind of thing as 'start vacuuming at 9 AM'?"
> **Domain expert:** "Yes — both are **ScheduledTask**s. The medicine one has an announcement effect; the vacuum one has an action effect. The latter gets disambiguated at create time — 'vacuuming' becomes 'start roborock vacuum' once the agent has confirmed the entity."

> **Dev:** "If I cancel today's tesla-charge task, does next week's also get cancelled?"
> **Domain expert:** "No — cancelling a single occurrence only deletes that **ScheduledTask** row. To stop the whole recurring instruction you cancel the **recurrence family**."

> **Dev:** "Should the post-wake-word voice agent contain the TV and ScheduledTask logic itself?"
> **Domain expert:** "No — the **Realtime Voice Agent** owns the live voice turn and delegates the domain work to the right **Specialist agent**."

> **Dev:** "Should direct smart-home commands go through a HomeAssistantAgent?"
> **Domain expert:** "No — a **Direct Home Assistant command** uses the existing command executor as a blocking tool."

> **Dev:** "If the user asks 'is the laundry switch on?', is that a **Direct Home Assistant command**?"
> **Domain expert:** "No — that is a **Direct Home Assistant state query** because it reads device state without changing anything."

> **Dev:** "Does the **Realtime Voice Agent** only handle smart-home requests?"
> **Domain expert:** "No — it can answer **General chat** directly and use tools or Specialist agents when the request calls for smart-home behavior."

> **Dev:** "If the request could mean two different things, should the assistant guess?"
> **Domain expert:** "No — ask a **Clarification request** before acting."

> **Dev:** "Should every smart-home command require confirmation?"
> **Domain expert:** "No — routine smart-home actions execute directly, but a **Bulk destructive action** needs an **Action confirmation**."

> **Dev:** "Should opening the front door, back door, or garage door execute immediately?"
> **Domain expert:** "No — that is a **Protected opening action** and needs an **Action confirmation**."

> **Dev:** "Should Apple TV, YouTube, typing, and playback be separate agents?"
> **Domain expert:** "No — those are skills and tools inside the single **TVAgent**."

> **Dev:** "When the **TVAgent** asks for a screenshot, should the voice assistant say that out loud?"
> **Domain expert:** "No — that is a **Silent specialist run** step. Speak only when user input is required or when there is a final result."

> **Dev:** "After the wake word, should the assistant wait for a completed transcript before routing the command?"
> **Domain expert:** "No — the command is a **Realtime voice turn**, so live speech goes directly to the **Realtime Voice Agent**."

> **Dev:** "Can the assistant use the previous exchange to understand 'do that again tomorrow'?"
> **Domain expert:** "Yes — use **Short conversational memory**, but never as the source of current device state."

> **Dev:** "Does every delegated agent have to finish before the voice turn can end?"
> **Domain expert:** "No — short work can be a **Blocking specialist run**, while longer work can be an **Async specialist run**."

> **Dev:** "Which delegated work should become async by default?"
> **Domain expert:** "**TVAgent** runs are async by default. **ScheduledTaskAgent** runs are blocking by default."

> **Dev:** "Should creating or cancelling a **ScheduledTask** become an async job?"
> **Domain expert:** "No — that happens in a **ScheduledTask voice flow**. Due-time firing is separate server-side behavior."

> **Dev:** "Should a due-time Home Assistant action create a **Realtime voice turn**?"
> **Domain expert:** "No — an **Action effect** uses a server-side **ScheduledTask firing flow**."

> **Dev:** "If the vacuum task fires but the vacuum is already cleaning, should the system still run the command?"
> **Domain expert:** "No — the **ScheduledTask firing flow** may skip or abort and produce a **Firing exception announcement**."

> **Dev:** "Should a successful scheduled action stay silent?"
> **Domain expert:** "No — use a terse **Firing success announcement**, normally 'Done'."

> **Dev:** "Should a recurring scheduled action announce only the first success?"
> **Domain expert:** "No — every successful occurrence produces a **Firing success announcement**."

> **Dev:** "Should an async TV request be completely silent from the moment it starts?"
> **Domain expert:** "No — the assistant should say 'On it' as its **Async acknowledgement**, then continue silently."

> **Dev:** "If the **TVAgent** gets blocked after the original command, does the user need to say the wake word again?"
> **Domain expert:** "No — the assistant asks briefly and opens a **Follow-up voice turn** for the answer."

> **Dev:** "Can the user give a brand-new smart-home command during a **Follow-up voice turn**?"
> **Domain expert:** "No — follow-up speech is a **Scoped follow-up answer** to the pending Specialist agent question."

> **Dev:** "Does one async TV request block unrelated commands like turning on a light?"
> **Domain expert:** "No — unrelated commands can run concurrently. The only conflict rule is for TV: a new TV command replaces the active TVAgent run."

> **Dev:** "If the user gives a new TV command while the **TVAgent** is still working, should we ask before canceling?"
> **Domain expert:** "No — use **Replace conflicting TV run** because the new TV command is treated as the latest intent."

> **Dev:** "How much should the assistant say after the work finishes?"
> **Domain expert:** "For a routine successful command, use the **Completion announcement** 'Done'. Give full answers to questions, and explain anything the user must do."

## Flagged ambiguities

- "Main agent" means **Realtime Voice Agent** when discussing the post-wake-word voice entry point.
- "Sub-agent" means **Specialist agent** when discussing delegated TV or ScheduledTask behavior.
- "TV agents" was a typo. The resolved term is one **TVAgent** with skills and tools, not multiple TV-specific agents.
- Specialist-agent iterations are not user-facing speech events. They are silent by default.
- "HomeAssistantAgent" was considered and rejected for immediate device commands; use **Direct Home Assistant command**.
- "Getting states" means a read-only **Direct Home Assistant state query**, not a **Direct Home Assistant command** or service call.
- "Chat intent" is legacy intent-classification language; use **General chat** for direct conversational answers.
- Capability selection is not a fixed priority order.
- Ambiguous requests are resolved with a **Clarification request**, not a guessed capability.
- "No confirmation needed" applies to routine actions, not a **Bulk destructive action**.
- Opening or unlocking the front door, back door, or garage door is a **Protected opening action**, not a routine command.
- "Raw audio" means a **Realtime voice turn**, not the existing finalized transcript path.
- Wake-word detection remains browser-based; only post-wake-word audio becomes a **Realtime voice turn**.
- Azure Speech text-to-speech remains the announcement playback path; Azure Speech command transcription is replaced by **Realtime voice turn** handling.
- "Hybrid delegation" means choosing between **Blocking specialist run** and **Async specialist run** per delegated request.
- "Reminder" was the legacy name for the announcement-only concept. Resolved: unify under **ScheduledTask** with two effect kinds. The legacy `Reminder` code (`service/src/reminder.ts`, `ha-voice-assistant/src/skills/reminders/`, `service/src/prompts/REMINDER.md`, `reminders.json` files, `/api/processReminder`/`/api/reminders`/`/api/processed-reminders` endpoints) is being deleted in the cutover, not preserved.
- "Cron" was proposed and rejected — Unix-daemon/crontab connotations don't match a user-facing, voice-created concept.
- "Schedule" is reserved for the user-facing verb ("schedule the vacuum") and the page name; the noun is always **ScheduledTask**.
