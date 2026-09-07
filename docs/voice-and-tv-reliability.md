# Voice and TV reliability

## TV typing and short searches

Known Apple TV and Samsung directional commands go directly to Home Assistant,
without translating each press through a language model. Typing sends one ordered
batch per character and verifies the completed field with a screenshot. It no
longer waits for a screenshot and vision-model suggestion check after each word.
Pause and cancellation checkpoints remain between character batches. If a batch
fails, inspect the field and cursor before retrying; some keys may have executed.

`TV_REMOTE_KEY_DELAY_MS` in the service defaults to `0`. This explicitly overrides
Home Assistant's default 400 ms delay, which the Apple TV integration applies
after every key, including repeated navigation keys. If a particular device misses
rapid key presses, set a small positive value and restart the service.
See the [HA remote defaults](https://github.com/home-assistant/core/blob/dev/homeassistant/components/remote/__init__.py)
and [Apple TV command implementation](https://github.com/home-assistant/core/blob/dev/homeassistant/components/apple_tv/remote.py).

The TV agent is instructed to use the fewest words preserving the request:
"Play latest telugu songs" → `latest telugu songs`. It must not add "music video",
"official", or "HD" unless requested. Exact titles, artists, languages, dates,
and requested qualifiers remain meaningful. Query choice is still model-driven.

## Microphone lifecycle

Wake-word listening uses the native browser speech-recognition lifecycle. Clearing
the displayed transcript does not abort or restart recognition. A `start` event
confirms listening; unexpected `end`, network, and capture errors trigger a fresh
recognizer with backoff capped at 30 seconds. Permission denial is shown in the UI
and requires explicitly starting again after access is restored.

A five-second health check recovers missing start/end events and renews idle
recognizers after five minutes. Recent speech defers renewal. Returning from
sleep, restoring the page, or regaining network connectivity also checks recovery.
Stopping a recognizer waits at most one second for the browser's `end` event.
Generation checks prevent late callbacks, socket events, and microphone streams
from restarting a stopped or replaced interaction.

The command microphone retains its 30-second cap. A failed socket or a 15-second
session-setup timeout resolves the current turn so wake-word detection can resume.
Only wake-word recognition is renewed during idle time; the command audio service
is not kept streaming.

While the assistant is enabled, visible pages request a screen wake lock where
supported and release it on Stop. Browsers can still suspend hidden/discarded tabs
or deny wake locks, and the app cannot listen while the OS is asleep. Recovery
runs when execution resumes. See [speech-recognition end events](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition/end_event)
and [screen wake locks](https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API).

Automated coverage simulates eight hours of idle recognition, permission/network
failures, missing browser events, Stop races, late media streams, and dropped
sockets. Playwright covers the real React UI with mocked speech and backend APIs.
These checks do not substitute for a physical microphone/TV soak test.
