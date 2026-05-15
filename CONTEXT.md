# HA Voice Assistant

A voice-controlled smart-home assistant. Wake-word + speech recognition on the React client; intent classification, agent reasoning, and Home Assistant control on the Node.js service.

## Language

### Scheduled tasks

**ScheduledTask**:
A future-dated item the user creates by voice that fires an effect when due. Has exactly one effect: `announcement` or `action`. May be one-shot or recurring.
_Avoid_: Reminder, Cron, Schedule, Job. (Replaces the legacy "Reminder" naming.)

**Announcement effect**:
A `ScheduledTask` whose firing speaks a message — e.g. "take your medicine".

**Action effect**:
A `ScheduledTask` whose firing executes a Home Assistant command — e.g. start the roborock vacuum. The stored command is a natural-language string scoped to a specific entity (e.g. `"start roborock vacuum"`, not `"start vacuuming"`); the agent resolves the entity at create time, not at fire time.

**Fire (verb)**:
The act of executing a `ScheduledTask`'s effect at its due time. Always happens server-side.

**ScheduledTaskRun**:
The audit record of a single fire. One row per fire, written to the history container. Includes outcome (`succeeded` / `failed` / `skipped` / `aborted_by_agent`), agent trace, and a snapshot of relevant device state at the moment of firing.

**Recurrence family**:
The lineage of `ScheduledTask` records produced by a single recurring instruction. Every occurrence — past, current, future — shares a `recurrenceFamilyId`. This is what "cancel all future tesla-charge tasks" operates on.

**ScheduledTaskAgent**:
The single agent (registered in `service/src/agents/`) that handles every `scheduled_task` voice command after intent classification. Handles creation (parse, disambiguate device, ask user, save), list/query, and firing (inspect device state, decide, execute, speak).

## Relationships

- A **ScheduledTask** has exactly one effect (`announcement` | `action`) and exactly one `recurrenceFamilyId`.
- A recurring **ScheduledTask** that fires produces one **ScheduledTaskRun** *and* a new **ScheduledTask** (the next occurrence) sharing the same `recurrenceFamilyId`.
- A one-shot **ScheduledTask** that fires produces one **ScheduledTaskRun** and is then deleted from the active container.
- Active and history live in **separate Cosmos containers**: `scheduled-tasks` (active upcoming only) and `scheduled-tasks-history` (all past runs).

## Example dialogue

> **Dev:** "If a user says 'remind me to take medicine at 9 AM', is that the same kind of thing as 'start vacuuming at 9 AM'?"
> **Domain expert:** "Yes — both are **ScheduledTask**s. The medicine one has an announcement effect; the vacuum one has an action effect. The latter gets disambiguated at create time — 'vacuuming' becomes 'start roborock vacuum' once the agent has confirmed the entity."

> **Dev:** "If I cancel today's tesla-charge task, does next week's also get cancelled?"
> **Domain expert:** "No — cancelling a single occurrence only deletes that **ScheduledTask** row. To stop the whole recurring instruction you cancel the **recurrence family**."

## Flagged ambiguities

- "Reminder" was the legacy name for the announcement-only concept. Resolved: unify under **ScheduledTask** with two effect kinds. The legacy `Reminder` code (`service/src/reminder.ts`, `ha-voice-assistant/src/skills/reminders/`, `service/src/prompts/REMINDER.md`, `reminders.json` files, `/api/processReminder`/`/api/reminders`/`/api/processed-reminders` endpoints) is being deleted in the cutover, not preserved.
- "Cron" was proposed and rejected — Unix-daemon/crontab connotations don't match a user-facing, voice-created concept.
- "Schedule" is reserved for the user-facing verb ("schedule the vacuum") and the page name; the noun is always **ScheduledTask**.
