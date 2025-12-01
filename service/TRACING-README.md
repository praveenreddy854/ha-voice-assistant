# OpenTelemetry Tracing Implementation for TV Agent

This implementation adds comprehensive OpenTelemetry tracing to the TV Agent service, logging all input prompts and output responses to local files in the `logs` folder.

## Features Implemented

### 1. **File-based Trace Export**

- Custom `FileSpanExporter` that writes traces to `logs/tv-agent-traces.jsonl`
- Each line is a JSON object representing a complete trace span
- Immediate export using `SimpleSpanProcessor` for real-time logging

### 2. **Comprehensive TV Agent Tracing**

The following operations are traced:

#### **Main Agent Flow (`tv-agent.runAgenticFlow`)**

- Session ID and configuration
- User prompt and screenshot availability
- Final result status and step count
- Error handling and cleanup

#### **Session Creation (`tv-agent.createSession`)**

- Initial prompt construction with device state and context
- Session configuration (max steps, message history)
- Azure thread creation and session storage

#### **Tool Execution (`tv-agent.tool-execution`)**

- Tool name and arguments
- Execution results and observations
- Screenshot requirements
- Success/failure status

#### **Flow Completion (`tv-agent.run-completed`)**

- Final response from the agent
- Total steps executed
- Final command summary

### 3. **Detailed Logging of Prompts and Responses**

Each trace contains:

- **Input Prompts**: Complete prompts sent to Azure AI Agents
- **Output Responses**: Tool calls, observations, and final responses
- **Metadata**: Timestamps, content length, hash for identification
- **Context**: Session IDs, step indices, tool names

### 4. **Trace Structure**

Each trace span includes:

```json
{
  "timestamp": "2025-11-02T21:04:45.650Z",
  "traceId": "unique-trace-id",
  "spanId": "unique-span-id",
  "name": "operation-name",
  "attributes": {
    "service.name": "tv-agent",
    "operation.type": "tv-control",
    "session.id": "session-123"
    // ... operation-specific attributes
  },
  "events": [
    {
      "name": "prompt.input",
      "attributes": {
        "prompt.content": "full prompt text",
        "prompt.timestamp": 1762117485618,
        "prompt.length": 474,
        "prompt.type": "initial-session-prompt"
      }
    },
    {
      "name": "response.output",
      "attributes": {
        "response.content": "full response text",
        "response.type": "tool-call",
        "tool.name": "send_remote_button"
      }
    }
  ]
}
```

## Files Modified/Created

### New Files

1. **`src/tracing/fileExporter.ts`** - Custom file exporter for OpenTelemetry
2. **`src/tracing/index.ts`** - OpenTelemetry configuration and utilities
3. **`test-tracing.ts`** - Test script demonstrating tracing functionality

### Modified Files

1. **`src/index.ts`** - Initialize tracing on server startup
2. **`src/agents/tv/tvAgent.ts`** - Added comprehensive tracing to TV agent operations
3. **`package.json`** - Added OpenTelemetry dependencies

## Usage

### Automatic Tracing

Tracing is automatically initialized when the server starts. All TV Agent operations are traced without any additional code changes needed.

### Viewing Traces

Traces are written to `logs/tv-agent-traces.jsonl`. Each line is a complete trace span in JSON format.

### Example Trace Analysis

```bash
# View recent traces
tail -f logs/tv-agent-traces.jsonl

# Count traces by operation
grep -o '"name":"[^"]*"' logs/tv-agent-traces.jsonl | sort | uniq -c

# Search for specific sessions
grep "session-123" logs/tv-agent-traces.jsonl

# Extract prompts only
jq -r 'select(.events[]?.name == "prompt.input") | .events[] | select(.name == "prompt.input") | .attributes."prompt.content"' logs/tv-agent-traces.jsonl
```

### Error Traces

Failed operations include:

- Exception details in `recordException()`
- Error status codes and messages
- Stack traces and error context

## Dependencies Added

```json
{
  "@opentelemetry/api": "^1.x.x",
  "@opentelemetry/sdk-node": "^0.x.x",
  "@opentelemetry/exporter-trace-otlp-http": "^0.x.x",
  "@opentelemetry/instrumentation-http": "^0.x.x",
  "@opentelemetry/instrumentation-fs": "^0.x.x"
}
```

## Configuration

The tracing configuration can be customized in `src/tracing/index.ts`:

- Change log directory path
- Modify trace filename
- Adjust span processor settings
- Add additional attributes or events

## Production Considerations

1. **Log Rotation**: Consider implementing log rotation for the trace files
2. **Performance**: SimpleSpanProcessor provides immediate export but may impact performance under high load
3. **Storage**: Monitor trace file sizes in production environments
4. **Privacy**: Ensure sensitive information in prompts/responses meets compliance requirements
