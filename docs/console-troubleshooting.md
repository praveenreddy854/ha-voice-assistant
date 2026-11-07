# Service console troubleshooting

The November 6 console inspection found an unavailable LB1 switch, a gesture
process failing on a missing Python import, a camera connection timeout, and
sampling warnings for reasoning models. The RTSP error also exposed URL
credentials; diagnostics now redact URL user information and configured secrets.

## Gesture runtime

From service/, run npm run gesture:setup to create a local .venv and install
requirements-gesture.txt. This requires a Python version supported by the
installed MediaPipe release. Set GESTURE_SETUP_PYTHON to that interpreter when
creating the environment. The service uses .venv/bin/python automatically;
GESTURE_PYTHON overrides the runtime interpreter. Restart the service afterward.

GESTURE_ENABLED=false disables the optional monitor. Python must report ready
before its dedicated camera capture and polling begin. Detector failure,
startup timeout, response timeout, and camera failure release its timers and
processes. The browser voice assistant remains available.

A camera timeout still requires a reachable, correct RTSP_URL, credentials,
and camera configuration. Installing Python dependencies cannot repair it.
RTSP socket waits are bounded to 15 seconds. Restart the monitor/service after
correcting the network configuration. Never paste credential-bearing URLs into
an issue.

## Home Assistant failures

Read-only state queries can report unavailable. Control requests for offline
or restored switches, lights, and fans are rejected before posting a service
call. Restore the device/integration connection in Home Assistant before
retrying. An HTTP success or an empty service response alone does not prove a
physical action completed. Remote and TV wake paths remain available.

New Home Assistant execution traces retain ha.translation.failed events with
the translation stage, configured model, sanitized error message, and HTTP
status when supplied by the provider. model_request identifies a provider
failure; response_parse identifies invalid command JSON. These diagnostics
avoid retaining provider request objects and credentials. Inspect /telemetry
on the service for new traces; previously unrecorded errors cannot be
reconstructed retrospectively.

Reasoning-model text and vision calls omit unsupported temperature settings.
Sampling remains available for conventional chat models and custom deployment
names, using recognizable model families from the installed AI SDK.

## Deployment verification

After deploying the fixes and setting up the optional runtime, confirm the
gesture detector reports ready before capture begins. Use a read-only Shortcut
state query and inspect its corresponding Home Assistant execution trace.
Do not replay device actions just to validate log formatting or failure paths.
The automated tests use mocked providers, cameras, child processes, and HA APIs.
