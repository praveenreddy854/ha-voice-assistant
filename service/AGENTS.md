# Service Package - Agent Architecture Documentation

This document provides comprehensive documentation for the service package's agent architecture, which powers the intelligent automation features of the Home Assistant Voice Assistant.

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Core Components](#core-components)
- [Agents](#agents)
  - [TV Agent](#tv-agent)
- [Common Utilities](#common-utilities)
- [Teaching System](#teaching-system)
- [Custom Agent Loop](#custom-agent-loop)
- [Tracing & Observability](#tracing--observability)
- [Configuration](#configuration)
- [API Reference](#api-reference)

---

## Overview

The service package is a Node.js/Express backend that provides:

- **Realtime Voice Agent**: Handles post-wake-word voice turns, tool calls, and Specialist agent delegation
- **Home Assistant Integration**: Executes smart home commands via Home Assistant APIs
- **Multi-Agent System**: Orchestrates specialized AI agents for complex TV automation tasks
- **Persistent Agent Memory**: Stores scoped user preferences, stable facts, and reusable guidance for all agents
- **Teaching Mode**: Records and learns from manual demonstrations to improve agent performance
- **OpenTelemetry Tracing**: Comprehensive observability for debugging and monitoring

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Express API Server                            │
│                         (src/index.ts)                               │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │
│  │  Realtime    │  │     Home     │  │ ScheduledTask│              │
│  │ Voice Agent  │  │  Assistant   │  │    Agent     │              │
│  └──────────────┘  └──────────────┘  └──────────────┘              │
│                                                                      │
├─────────────────────────────────────────────────────────────────────┤
│                       Agent System                                   │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │                    Custom Agent Loop                           │ │
│  │                 (OpenAI Chat Completions)                      │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                              │                                       │
│                              │                                       │
│                              ▼                                       │
│                        ┌──────────┐                                  │
│                        │ TV Agent │                                  │
│                        │  + Skills│                                  │
│                        └──────────┘                                  │
│                                                                      │
├─────────────────────────────────────────────────────────────────────┤
│                    Supporting Systems                                │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │
│  │   Teaching   │  │    Image     │  │   Tracing    │              │
│  │    System    │  │  Processor   │  │   (OTEL)     │              │
│  └──────────────┘  └──────────────┘  └──────────────┘              │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

## Core Components

### Realtime Voice Agent (`src/realtimeChat.ts`)

Owns the post-wake-word voice turn, streams raw audio to Azure OpenAI Realtime, and selects direct Home Assistant tools or Specialist agents based on request meaning.

### Home Assistant Integration (`src/ha.ts`)

- Fetches device states from Home Assistant API
- Translates natural language commands to HA service calls
- Supports a wide range of domains: lights, switches, media players, remotes, etc.

### ScheduledTaskAgent (`src/agents/scheduled-task/`)

Handles ScheduledTask creation, listing, querying, update, cancellation, and server-side action-effect firing.

### Persistent Agent Memory (`src/memory.ts`)

Stores long-lived, scoped user preferences and facts in Cosmos DB. Realtime and Specialist agent runs receive compact memory context before answering, and all agents can retrieve, save, update, or delete memory. Memory partition keys are derived from the strongest resolved scope, such as device entity, device name, room, domain, app, person, or global. Background consolidation extracts only high-confidence durable preferences from recent interactions; raw device state, tool traces, and failed runs are not treated as memory.

---

## Agents

The agent system uses a single TV agent with on-demand skill loading:

### TV Agent

**Location**: `src/agents/tv/`

The TV Agent is the primary orchestrator for smart TV automation tasks.

#### Purpose
- Execute complex, multi-step TV control sequences
- Load device/app-specific skill instructions on demand
- Process visual feedback for intelligent decision-making

#### Tools

| Tool | Description |
|------|-------------|
| `click_power_button` | Turn TV on/off |
| `media_control` | Play, pause, volume, seek operations |
| `click_select_button` | Confirm selections |
| `go_back` | Go back to previous screen |
| `go_home` | Return to home screen |
| `navigate` | Move cursor in a direction (up/down/left/right) |
| `find_search` | Locate and activate search using vision AI |
| `deterministic_typing` | Type text on on-screen keyboard |
| `delete_typed_text` | Delete typed characters on keyboard |
| `get_latest_screenshot` | Capture current screen state |
| `get_device_state` | Query device status |
| `launch_app` | Open specific applications |
| `load_skill` | Load detailed skill instructions on demand |
| `retrieve_similar_flows` | Find similar past automation flows |
| `web_search` | Search for documentation or info |
| `wait` | Pause for UI transitions |

#### Configuration

```typescript
TV_AGENT_MAX_ITERATIONS_CAP = 8  // Max steps per task
MIN_RUN_CREATION_INTERVAL_MS = 3000  // Rate limiting
```

#### Usage

```typescript
import { runTvAgenticFlow } from "./tvAgent";

const result = await runTvAgenticFlow({
  userMessage: "Play the latest episode of Breaking Bad on Netflix",
  screenshotBase64: "...",
  screenshotContentType: "image/jpeg",
  maxIterations: 8,
});
```

#### Skill System

The TV agent discovers available skills at startup and shows summaries in its initial message. When the agent needs detailed guidance (e.g., keyboard layout before typing, app-specific navigation), it calls `load_skill` to load full instructions on demand.

Skill files are organized under `src/agents/tv/skills/`:

```
skills/
├── common.md                    # Always available (navigation best practices)
├── skillRegistry.ts             # Skill discovery and loading
└── appletv/
    ├── general.md               # Apple TV remote mapping, states, entities
    ├── typing.md                # Keyboard layout, deterministic typing guide
    └── youtube.md               # YouTube-specific navigation patterns
```

---

## Common Utilities

**Location**: `src/agents/common/`

Shared utilities across all agents:

### Utility Functions (`utils/index.ts`)

```typescript
// Safe JSON serialization
safeJsonStringify(value: unknown): string | undefined

// Normalize multiline strings
normalizeMultiline(value?: string | null): string

// Cap iteration counts
resolveMaxSteps(requested?: number, maxCap?: number): number

// Async delay
delay(ms: number): Promise<void>
```

### Error Handling (`errors/`)

Centralized error handling for Azure AI Agents and other integrations.

---

## Teaching System

**Location**: `src/agents/tv/teaching/`

The teaching system enables learning from manual demonstrations.

### Components

| Module | Purpose |
|--------|---------|
| `teachingRecorder.ts` | Session management and step recording |
| `storage.ts` | Persist recordings to filesystem |
| `blobStorage.ts` | Screenshot storage in Azure Blob |
| `embeddings.ts` | Generate embeddings for similarity search |
| `screenshotAnalyzer.ts` | AI analysis of screenshots |
| `types.ts` | Type definitions |

### Workflow

1. **Start Session**: User initiates teaching mode with a task description
2. **Record Steps**: Each manual action is captured with screenshots
3. **Complete Session**: Recording is saved with embeddings for retrieval
4. **Guidance Retrieval**: Similar tasks can retrieve past recordings for guidance

### API

```typescript
// Start a teaching session
startTeachingSession(taskDescription: string): TeachingSession

// Record a step
recordStep(sessionId: string, step: RecordedStep): void

// Add screenshot to step
addScreenshotCapture(sessionId: string, base64: string): void

// Complete and save
completeTeachingSession(sessionId: string): TeachingRecording

// Find guidance for similar tasks
findGuidanceForTask(task: string): Promise<GuidedInstructions | null>
```

### Teaching Triggers

Certain phrases automatically trigger teaching mode:
- "Let me show you how to..."
- "Watch how I do this..."
- "I'll teach you to..."

---

## Custom Agent Loop

**Location**: `src/agents/tv/customAgentLoop.ts`

A flexible, controllable agent loop implementation using OpenAI chat completions.

### Features

- **Session Management**: Create, manage, and delete agent sessions
- **Tool Execution**: Handle tool calls with proper result submission
- **Message History**: Maintain conversation context
- **Image Support**: Process screenshots in conversations
- **Rate Limiting**: Configurable intervals between API calls

### Architecture

```typescript
interface CustomAgentLoop {
  // Session management
  createSession(userPrompt: string, history?: Message[]): AgentLoopSession;
  deleteSession(sessionId: string): void;
  
  // Execution
  runStep(sessionId: string): Promise<AgentStepResult>;
  submitToolResults(sessionId: string, results: ToolExecutionResult[]): Promise<AgentStepResult>;
  
  // Message management
  addMessage(sessionId: string, role: string, content: string): AgentMessage | null;
  removeMessage(sessionId: string, messageId: string): boolean;
  removeLastNMessages(sessionId: string, count: number): number;
  getMessages(sessionId: string): AgentMessage[];
  clearMessages(sessionId: string, keepSystemMessage?: boolean): boolean;
}
```

### Step Result Types

| Type | Description |
|------|-------------|
| `tool_calls` | Agent requests tool execution |
| `message` | Agent provides text response |
| `complete` | Task finished successfully |
| `error` | An error occurred |

---

## Tracing & Observability

**Location**: `src/tracing/`

OpenTelemetry-based tracing for monitoring and debugging.

### Features

- File-based trace export to `logs/tv-agent-traces.jsonl`
- Prompt and response logging
- Span attributes for searchability
- Graceful shutdown handling

### Usage

```typescript
import { createTVAgentSpan, logPromptAndResponse } from "./tracing";

const span = createTVAgentSpan("tv-control-operation", {
  "device.id": "remote.loft_tv",
});

logPromptAndResponse(span, prompt, response);
span.end();
```

### Viewing Traces

```bash
# View all traces
npm run traces

# View prompts only
npm run traces:prompts

# View errors only
npm run traces:errors
```

---

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `AZURE_OPENAI_ENDPOINT` | Azure OpenAI endpoint | - |
| `AZURE_OPENAI_API_KEY` | API key | - |
| `HOME_ASSISTANT_URL` | Home Assistant URL | `http://homeassistant.local:8123` |
| `HOME_ASSISTANT_TOKEN` | HA long-lived token | - |
| `TV_REMOTE_ENTITY_ID` | Default TV remote entity | - |
| `TV_DEFAULT_WAIT_MS` | Wait time after actions | `1500` |
| `TV_AGENT_MAX_ITERATIONS` | Max TV agent steps | `8` |
| `TV_AGENT_DEVICES` | Comma-separated device list | - |
| `AZURE_COSMOS_MEMORY_CONTAINER` | Cosmos container for Persistent agent memory | `AgentMemory` |
| `MEMORY_RETRIEVAL_TIMEOUT_MS` | Max time to wait for pre-run memory context | `900` |
| `MEMORY_CONSOLIDATION_INTERVAL_MS` | Background memory consolidation cadence | `60000` |
| `AZURE_SPEECH_KEY` | Azure Speech Service key | - |
| `AZURE_SPEECH_REGION` | Speech Service region | `eastus` |

### Prompt Templates

Located in `src/prompts/`:

| File | Purpose |
|------|---------|
| `HOMEASSISTANT.md` | HA command generation prompt |
| `SCHEDULEDTASK.md` | ScheduledTaskAgent instructions |
| `TVAGENT.md` | TV Agent system instructions |

---

## API Reference

### Express Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Health check |
| `/api/realtime-chat` | WS | Realtime Voice Agent audio/tool proxy |
| `/api/agent/run` | POST | Run registered Specialist agents |
| `/api/teaching/*` | Various | Teaching mode endpoints |
| `/api/scheduled-tasks/*` | Various | ScheduledTask read/cancel endpoints |

### Request/Response Types

#### Agentic Flow Request

```typescript
interface TvAgenticRequest {
  userMessage: string;
  screenshotBase64?: string;
  screenshotContentType?: string;
  maxIterations?: number;
}
```

#### Agentic Flow Response

```typescript
interface TvAgenticFlowResult {
  success: boolean;
  message: string;
  steps: TvAgentStep[];
  sessionState?: TvAgentSessionState;
  error?: string;
}
```

---

## Development

### Scripts

```bash
# Development with hot reload
npm run dev

# Build TypeScript
npm run build

# Production start
npm start

# View traces
npm run traces
```

### Project Structure

```
service/
├── src/
│   ├── agents/
│   │   ├── common/         # Shared utilities (keyboards, errors, utils)
│   │   ├── core/           # Agent loop infrastructure
│   │   └── tv/             # TV agent
│   │       ├── skills/     # Skill files and registry
│   │       ├── teaching/   # Teaching system
│   │       └── tools/      # All TV control tools
│   ├── prompts/            # LLM prompt templates
│   ├── tracing/            # OpenTelemetry setup
│   ├── types/              # TypeScript type definitions
│   ├── config.ts           # Configuration
│   ├── ha.ts               # Home Assistant integration
│   ├── index.ts            # Express server entry point
│   ├── realtimeChat.ts     # Realtime Voice Agent proxy
│   ├── ai.ts               # Azure OpenAI service wrapper
│   └── tvJobManager.ts     # Server-owned async TV jobs
├── logs/                   # Trace output files
├── generated_data/         # Runtime generated data
└── package.json
```

---

## Best Practices

### Agent Development

1. **Use the Custom Agent Loop**: Provides better control than Azure AI Agents SDK
2. **Always Request Screenshots**: Visual feedback is essential for TV automation
3. **Implement Graceful Degradation**: Handle tool failures with alternative approaches
4. **Rate Limit API Calls**: Prevent overwhelming the OpenAI API
5. **Log Extensively**: Use tracing for debugging complex flows

### Tool Design

1. **Single Responsibility**: Each tool should do one thing well
2. **Clear Descriptions**: Help the LLM understand when to use each tool
3. **Explicit Parameters**: Make required inputs obvious
4. **Return Actionable Results**: Include next-step guidance in tool outputs

### Error Handling

1. **Catch at Boundaries**: Handle errors at agent/tool boundaries
2. **Provide Context**: Include relevant state in error messages
3. **Enable Recovery**: Allow agents to try alternative approaches
4. **Log for Debugging**: Capture enough context for post-mortem analysis
