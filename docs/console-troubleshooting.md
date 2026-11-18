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
failure; response_parse identifies invalid command JSON or wait limits;
plan_validation identifies a stale/unconfigured entity, mismatched state-query
target, or unsupported current select option. These diagnostics
avoid retaining provider request objects and credentials. Inspect /telemetry
on the service for new traces; previously unrecorded errors cannot be
reconstructed retrospectively.

Reasoning-model text and vision calls omit unsupported temperature settings.
Sampling remains available for conventional chat models and custom deployment
names, using recognizable model families from the installed AI SDK.

### Living room camera presets and guard mode

The November 17 telemetry review found `{"error":"no_match"}` translation
responses for preset requests that also enabled guard mode. The translator's
filtered device list contained the preset selector and guard-position button,
but omitted `switch.living_room_guard_return`, although Home Assistant exposed
that switch with state `off`. A successful preset-only request on November 15
used the selector, a 15-second settling wait, and the guard-position button.

Include all required controls in the running service's `HOME_ASSISTANT_DEVICES`
list (preserve its other configured entries):

```env
HOME_ASSISTANT_DEVICES=select.living_room_ptz_preset,button.living_room_guard_set_current_position,switch.living_room_guard_return
```

Restart the service after updating its environment and deploying the code and
prompt. Saving a guard position does not enable automatic guard return; the
switch is a separate action. Device-specific sequencing and settling times
belong in [scoped persistent memory](home-assistant-memory.md), not in the
executor or shared translation prompt. Existing applicable preferences are
retrieved for each command; update their guidance with the required timing to
replace the former hardcoded 15-second delay.

The executor reports `no_match` as an unresolved device/action, validates the
entire generated plan against the current configured entities and select
options before executing its first step, supports explicit bounded local waits,
and stops at the first failed step. It does not infer or append device-specific
actions or delays. Partial execution is a failed request, not successful
completion. A wait does not verify the physical position.

## Deployment verification

After deploying the fixes and setting up the optional runtime, confirm the
gesture detector reports ready before capture begins. Use a read-only Shortcut
state query and inspect its corresponding Home Assistant execution trace.
Do not replay device actions just to validate log formatting or failure paths.
The automated tests use mocked providers, cameras, child processes, and HA APIs.
