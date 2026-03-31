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
| `AI_MODEL_NANO` | Nano | Intent classification, simple JSON extraction (reminders) |
| `AI_MODEL_MINI` | Mini | HA commands, vision helpers (TV detection, screenshot analysis) |
| `AI_MODEL_ADVANCED` | Advanced | Agent loops (TV agent, navigation agent, typing agent) |

Each tier falls back to the one below: `AI_MODEL_ADVANCED` → `AI_MODEL_MINI` → `AI_MODEL_NANO`.

### AI Service Layer (`src/ai.ts`)

Exports clean, composable functions:
- `azureProvider` — the `@ai-sdk/azure` provider instance
- `generateCompletion()` — text completion with retry
- `generateJsonCompletion()` — text → JSON with retry
- `generateVisionText()` — vision analysis with base64 image

### Agent System

Hierarchical multi-agent architecture for TV automation:

```
TV Agent (advanced model)
├── Navigation Agent (advanced model) — directional pad, home, back, search
└── Typing Agent (advanced model) — on-screen keyboard text input
```

The agent loop (`src/agents/tv/agentLoop.ts`) is session-based with external tool execution. Tools are defined without `execute` functions — the caller handles execution and returns results. A built-in `complete_task` tool signals loop completion.

### Key Directories

- `src/agents/tv/` — TV agent: loop, tools, constants, image processing, teaching mode
- `src/agents/navigation/` — Navigation sub-agent
- `src/agents/typing/` — Typing sub-agent
- `src/agents/common/` — Shared utilities
- `src/prompts/` — System prompt templates (INTENT.md, HOMEASSISTANT.md, REMINDER.md)

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
