# Server-side firing for ScheduledTasks

ScheduledTasks fire on the Node service, not in the React client. The server holds an in-memory `setTimeout` per upcoming task (re-armed from Cosmos on startup and on every create/edit/delete) and invokes the ScheduledTaskAgent at fire time. The client subscribes to an SSE channel for announcement payloads and only owns TTS playback and the UI list (refreshed via hourly Cosmos poll).

## Considered Options

- **Client-side firing.** Initially considered viable because the deployment is a single Mac mini with a browser tab that never sleeps. Rejected once we decided the agent — which inspects HA device state and calls HA — runs server-side; splitting firing across client and server creates two paths that have to coordinate, with a real risk of double-execution.
- **Hybrid (server fires actions, client fires announcements).** Rejected for the same reason: two firing paths.

## Consequences

- The Mac mini's Node process is the single point of firing. If the service is down, nothing fires. (Acceptable given deployment.)
- The "client subscription to fire events" in the original spec became a client subscription to *announcement payloads* — a much smaller responsibility.
- Hourly client polling is a UI-cache concern only, not a correctness concern. Firing precision is sub-second via in-memory `setTimeout`.
