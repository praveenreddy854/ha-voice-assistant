# Scoped Persistent Agent Memory

Persistent agent memory is stored as scoped Cosmos documents that can apply globally or to rooms, devices, domains, apps, people, or agents. The Cosmos partition key is derived from the strongest resolved scope, so device-specific memories partition by device/entity instead of a generic memory bucket. Realtime and Specialist agent runs receive a compact, bounded memory context before answering, while deeper lookup and user-driven remember/forget/correct flows use shared memory tools. Device names are retrieval facets rather than the primary memory category because many useful preferences are broader than one device; ambiguous device-related memory requests become clarification questions instead of unscoped writes; automatic memory writes happen through conservative background consolidation so raw chat, device state, tool traces, and failed runs do not become durable user memory.

## Considered Options

- **Device-only memory.** Rejected because preferences such as default media app, night lighting behavior, or household routines often span rooms, domains, or people.
- **Always wait for full memory retrieval.** Rejected because voice turns need bounded latency; if memory retrieval exceeds the deadline, the agent continues without blocking indefinitely.
- **Scan raw traces into memory.** Rejected because traces contain transient device state and failed attempts; consolidation only considers recent interaction summaries and explicit memory requests.
