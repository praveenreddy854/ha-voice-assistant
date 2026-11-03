# Independent text assistant sessions for external voice channels

Finalized-text requests from external voice channels use independent server-owned Text Assistant sessions rather than being injected into the browser's singleton Realtime Voice Agent connection. The text and realtime entry paths share assistant policy and capability executors, but not conversation or transport lifecycle; this keeps Siri usable without an open browser and isolates concurrent conversations at the cost of maintaining a separate model-session adapter.

For the Apple Shortcut adapter, all local Shortcut calls share one bounded short-history scope. Active sessions are process-local, expire after two minutes, and are not resumed after service restart. The adapter is intentionally unauthenticated: its only supported v1 security boundary is operational deployment on the trusted home network. A local hostname or LAN IP is configured in the Shortcut, with no server-side CIDR enforcement and HTTP permitted on that network.

## Considered Options

- **Inject text into the active browser Realtime session.** Rejected because it makes external voice channels depend on an open browser and risks mixing simultaneous conversations.
- **Independent Text Assistant sessions with shared capability tooling.** Accepted because external channels need standalone lifecycle and conversation isolation without duplicating domain execution behavior.
