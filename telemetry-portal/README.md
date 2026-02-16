# Telemetry Portal (Open Source)

This portal uses Grafana LGTM (`grafana/otel-lgtm`) to visualize OpenTelemetry traces and metrics.

OpenTelemetry itself does not provide a built-in dashboard UI. The portal here is the dashboard layer.

## What you get

- Traces: Tempo (with span timeline + events)
- Metrics: Prometheus-compatible querying in Grafana
- Single dashboard URL: `http://localhost:3300`

## Start portal

```bash
cd telemetry-portal
docker compose up -d
```

Grafana login:

- Username: `admin`
- Password: `admin`

## Wire service telemetry to portal

In `service/.env`:

```env
OTEL_EXPORT_MODE=both
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
# Optional headers for secured collectors:
# OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer <token>
```

Then restart the service.

## View telemetry story

1. Open `http://localhost:3300`
2. Go to `Explore`
3. Select traces and filter by service name: `ha-voice-assistant-service`
4. Open a trace and inspect span events (`tv.flow.*`, `openai.*`, `ha.*`, `request.*`)

For metrics, use `Explore` and search by metric name prefix:

- `http`
- `workflow`
- `external`
- `tv_agent`
- `errors`

## Stop portal

```bash
cd telemetry-portal
docker compose down
```
