# OpenTelemetry Observability

This service uses OpenTelemetry for traces + metrics. Azure Application Insights telemetry SDK is not used.

OpenTelemetry is instrumentation and transport, not a dashboard UI. For a portal, use the open-source stack in:

- `../telemetry-portal` (Grafana LGTM)

## Export modes

Set `OTEL_EXPORT_MODE` in `service/.env`:

- `file`: write JSONL files only (default)
- `otlp`: send to OTLP collector/portal only
- `both`: write files and send to OTLP

## File output (when mode includes `file`)

Telemetry is written to:

- `logs/telemetry-spans.jsonl`
- `logs/telemetry-metrics.jsonl`

Each line is one exported record.

## Portal output (when mode includes `otlp`)

Configure:

- `OTEL_EXPORTER_OTLP_ENDPOINT` (default `http://localhost:4318`)
- `OTEL_EXPORTER_OTLP_HEADERS` (optional comma-separated headers)

To run the portal:

```bash
cd ../telemetry-portal
docker compose up -d
```

Then open `http://localhost:3300`.

## What is instrumented

### HTTP lifecycle

- Request accepted/completed events
- Route handler spans
- Status code, route, duration, request id

### Workflow story traces

- TV flow session creation/reuse
- Loop iteration transitions and result types
- Tool call execution + screenshot request/processing branches
- Home Assistant plan creation + command execution path
- OpenAI request attempts, retries, polling, success/failure outcomes

### Metrics

- HTTP request counters/histograms/in-flight gauge
- Workflow run/step counters
- Tool call counters
- External dependency call counters + latency histograms
- Retry + error counters
- Active TV session up/down counter
- Screenshot event counters

## Environment knobs

- `OTEL_SERVICE_NAME` (default: `ha-voice-assistant-service`)
- `OTEL_EXPORT_MODE` (default: `file`)
- `OTEL_EXPORTER_OTLP_ENDPOINT` (default: `http://localhost:4318`)
- `OTEL_EXPORTER_OTLP_HEADERS` (default: empty)
- `OTEL_METRIC_EXPORT_INTERVAL_MS` (default: `10000`)
- `OTEL_METRIC_EXPORT_TIMEOUT_MS` (default: `5000`)

## Quick inspection examples

```bash
# Tail spans
tail -f logs/telemetry-spans.jsonl

# Tail metrics
tail -f logs/telemetry-metrics.jsonl

# See TV flow events
grep "tv.flow" logs/telemetry-spans.jsonl

# See OpenAI retries
grep "openai.retry" logs/telemetry-spans.jsonl
```
