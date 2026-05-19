# Realtime Voice Agent for post-wake-word orchestration

After wake-word detection, live user audio streams directly to a Realtime Voice Agent instead of being captured as a finalized command transcript and routed through intent classification. The Realtime Voice Agent owns the voice turn boundary, chooses tools or Specialist agents, and delegates domain work to the existing TVAgent, ScheduledTaskAgent, or direct Home Assistant execution. This lowers command latency and centralizes spoken interaction at the cost of making realtime orchestration responsible for tool routing, follow-up turns, and domain-lock behavior.

## Considered Options

- **Keep intent classification after speech-to-text.** Rejected because the current path waits for command recording, transcription, classification, downstream execution, and separate response speech before the user hears progress.
- **Feature-flagged rollout before deletion.** Rejected because keeping both post-wake-word paths would preserve duplicate routing logic and make the cutover harder to reason about.
- **Clean cutover from intent classification to Realtime Voice Agent.** Accepted because the new architecture intentionally replaces the old post-wake-word pipeline and should keep the codebase clean, including deleting the intent classifier endpoint and implementation.
- **Realtime-owned wake-word detection.** Rejected to avoid always-on cloud audio streaming and unnecessary Realtime cost.
- **Browser-owned wake-word detection.** Accepted because Realtime should start only after the wake word.
- **Merge specialist behavior into the Realtime Voice Agent.** Rejected because TV control and ScheduledTask handling already have bounded domain agents with their own tools, context, and execution concerns.
- **Realtime Voice Agent with Specialist agent delegation.** Accepted because it removes the intent-classification hop while preserving specialist ownership.
- **Frontend-owned async TV loop.** Rejected because the Realtime Voice Agent needs the server to own async job lifecycle, cancellation, replacement, follow-up state, and final completion.
- **Server-owned async TV job.** Accepted because it keeps realtime delegation and TVAgent execution under one lifecycle owner while still allowing the frontend to provide screenshot data when needed.
- **Browser camera as primary TV screenshot source.** Rejected for server-owned async TV jobs because it couples job progress to an active browser tab.
- **Server-side RTSP as primary TV screenshot source.** Accepted because it lets the server-owned TVAgent job request visual feedback without depending on the frontend loop. Browser camera capture remains a fallback for setups without RTSP.
- **Frontend-owned speech for async job updates.** Rejected because spoken behavior belongs to the Realtime Voice Agent.
- **Server event back to the active Realtime Voice Agent session.** Accepted because async completion and follow-up prompts need to be spoken or listened for by the same voice layer that accepted the original request.
- **Reconnect or create a Realtime session for async completion.** Rejected because completion speech should not happen after the original voice/browser session is gone.
- **No disconnected completion announcement.** Accepted because completion announcements belong to the active interaction window.
- **Store disconnected async completion for UI/history.** Rejected because disconnected completion state has no user-facing value in the target voice-first flow.
- **Discard disconnected async completion state.** Accepted because async completion is only meaningful while the original voice/browser session is active.

## Consequences

- Specialist-agent iterations are silent by default; the assistant speaks only for an async acknowledgement, required user input, or a short completion announcement.
- The Realtime Voice Agent can answer general chat directly; chat, direct Home Assistant commands, and Specialist agent delegation are selected by request meaning rather than by fixed priority.
- Ambiguous capability or action selection is resolved by a short clarification question rather than by guessing.
- Routine smart-home actions execute without confirmation, but bulk destructive actions and protected opening actions for the front door, back door, or garage door require confirmation.
- Direct Home Assistant commands use the existing command executor as a blocking realtime tool; there is no separate HomeAssistantAgent.
- TVAgent runs are async by default. ScheduledTaskAgent runs are blocking by default.
- ScheduledTask creation, listing, querying, cancellation, clarification, and confirmation remain inside the active realtime voice turn; due-time firing remains server-side as described in ADR 0001.
- ScheduledTask announcement effects use the existing announcement/TTS path at fire time; ScheduledTask action effects use a primitive server-side firing flow (availability check + stored HA command), not the ScheduledTaskAgent and not the Realtime Voice Agent.
- ScheduledTask action-effect firing may skip, fail, or abort based on current device state, and those exceptions should be announced.
- Successful ScheduledTask action-effect firing should also announce briefly, typically in three or four words.
- Recurring ScheduledTask action effects announce every successful occurrence.
- Async TVAgent runs are server-owned jobs, not frontend-driven loops.
- Server-side RTSP capture is the primary screenshot source for async TVAgent jobs; browser camera capture is a fallback.
- Async TVAgent job completion and follow-up-input events are sent to the active Realtime Voice Agent session.
- If the original Realtime Voice Agent session is gone, async completion does not create a new voice session, speak later, or retain completion state for UI/history.
- Follow-up voice turns do not require the wake word and are scoped to the pending question or confirmation (from the Realtime Voice Agent or a Specialist agent). The mic reopens only because of a pending prompt and stays open for at most 30 seconds; if the user does not answer in that window the turn ends. There is no idle listening window after a plain response.
- Async work may run concurrently with unrelated commands, but Domain lock conflicts are guarded.
- A new TV command cancels and replaces the active TVAgent run.
- The old post-wake-word intent-classification path is removed when the Realtime Voice Agent path lands.
- `/api/classifyIntent` and the old intent classifier implementation are deleted as part of the cutover.
- The old Azure Speech command transcription path is removed for post-wake-word commands, while Azure Speech text-to-speech remains for announcement playback.
- Wake-word detection remains browser-based; only post-wake-word audio streams to the Realtime Voice Agent.
- The Realtime Voice Agent keeps short conversational memory across wake-word sessions: last 10 user/assistant messages or about five minutes, whichever is smaller. Current device state and active specialist state remain authoritative, and active specialist job summaries are tracked separately.
