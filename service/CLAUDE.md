# Service (Backend)

Node.js + TypeScript backend for the voice assistant.

## Run

```bash
npm i
npm --filter server dev
```

## Architecture

### Three-Tier Model System

All AI calls use the Vercel AI SDK (`ai` + `@ai-sdk/azure`). Models are configured via three environment variables:

| Env Var | Tier | Used For |
|---|---|---|
| `AI_MODEL_NANO` | Nano | Simple JSON extraction |
| `AI_MODEL_MINI` | Mini | HA commands, vision helpers (TV detection, screenshot analysis) |
| `AI_MODEL_ADVANCED` | Advanced | Agent loops (TV agent) |

Each tier falls back to the one below: `AI_MODEL_ADVANCED` → `AI_MODEL_MINI` → `AI_MODEL_NANO`.

### AI Service Layer (`src/ai.ts`)

Exports clean, composable functions:
- `azureProvider` — the `@ai-sdk/azure` provider instance
- `generateCompletion()` — text completion with retry
- `generateJsonCompletion()` — text → JSON with retry
- `generateVisionText()` — vision analysis with base64 image

### Agent System

Generic agent infrastructure with pluggable agent definitions:

```
Core Infrastructure (src/agents/core/)
├── agentLoop.ts      — session-based LLM tool-calling loop (AI SDK)
├── orchestrator.ts   — generic run engine: sessions, tool dispatch, external-input pause/resume
├── registry.ts       — register/lookup agent definitions by ID
└── types.ts          — AgentDefinition, AgentSession, AgentStep, AgentRunResult, etc.

TV Agent (src/agents/tv/)          — implements AgentDefinition
├── definition.ts                  — buildInitialMessage, executeTool, processExternalInput, onComplete
├── tvAgent.ts                     — backward-compat public API (wraps orchestrator)
├── tools/                         — all TV control tools (navigate, type, search, etc.)
├── skills/                        — on-demand skill files + registry
└── constants.ts                   — system prompt, tool schemas
```

**Adding a new agent:** Implement `AgentDefinition` (system prompt, tools, executeTool, buildInitialMessage) and call `registerAgent(def)`. The orchestrator handles session lifecycle, tool dispatch, and external-input pause/resume automatically.

**API endpoints:**
- `POST /api/agent/run` — generic endpoint for any registered agent
- `POST /api/runTvAgenticFlow` — backward-compat TV-specific endpoint
- `GET /api/agent/list` — list registered agent IDs

The agent loop (`src/agents/core/agentLoop.ts`) is session-based with external tool execution. Tools are defined without `execute` functions — the caller handles execution and returns results. A built-in `complete_task` tool signals loop completion.

### Key Directories

- `src/agents/core/` — Generic agent infrastructure: loop, orchestrator, registry, types
- `src/agents/tv/` — TV agent: definition, tools, skills, constants, image processing, teaching mode
- `src/agents/common/` — Shared utilities (keyboards, errors, screenshot store)
- `src/prompts/` — System prompt templates (HOMEASSISTANT.md, SCHEDULEDTASK.md, TVAGENT.md)

### Telemetry Logs

Agent telemetry is written to daily JSONL files in `service/logs/`:
- Filename format: `service-telemetry-YYYY-MM-DD.jsonl` (e.g., `service-telemetry-2026-04-14.jsonl`)
- Each line is a JSON object with `timestamp`, `traceId`, `spanId`, `name`, `attributes`, etc.
- Key span types: `agent.step.llm` (LLM steps with tool calls), `agent.tool.execute` (tool executions), `telemetry.event` (lifecycle events)
- Tool calls are in `attributes["agent.step.tool_calls"]` as a JSON string array
- To inspect recent agent behavior, read the latest daily log file in `service/logs/`

## Required Environment Variables

```
AZURE_OPENAI_API_KEY=
AZURE_OPENAI_RESOURCE_NAME=       # or AZURE_OPENAI_ENDPOINT (resource name extracted)
AI_MODEL_NANO=                     # e.g. gpt-4o-mini
AI_MODEL_MINI=                     # e.g. gpt-4o-mini
AI_MODEL_ADVANCED=                 # e.g. gpt-4o
HOME_ASSISTANT_URL=
HOME_ASSISTANT_TOKEN=
HOME_ASSISTANT_DEVICES=            # comma-separated device prefixes
AZURE_SPEECH_KEY=
AZURE_SPEECH_REGION=
```
