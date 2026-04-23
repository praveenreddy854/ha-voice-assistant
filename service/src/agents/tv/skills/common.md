# Common Operations

## Screenshot Analysis

After `get_latest_screenshot`, look for:
- Current app and screen type (home, search, video player, browse)
- Whether content is playing (fullscreen video = must `go_back` before navigating)
- Selected/highlighted item position
- Keyboard visibility (required before typing)

Use stable UI structure (layout, position, landmarks), not dynamic content titles.

## Standby Recovery

If the observation says "device went to STANDBY" or screenshot is black:
1. `wait` 2000ms for wake
2. `get_latest_screenshot` for a fresh image
3. Then proceed

If `get_device_state` returns `standby` mid-flow, `click_power_button` first.
Never interpret a black screenshot as valid — always re-capture.

## Waiting Strategy

- 1500–2000ms after power on / wakeup
- 2000–3000ms after app launch
- 1000–1500ms after typing
- 1000ms after navigation before screenshot

## Navigation Tips

- If content is playing, `go_back` first — navigation won't work during playback.
- If lost, `go_home` to reset to home screen and start over.
- Use `retrieve_similar_flows` when stuck or repeating failed actions.

## Search & Typing Workflow

1. Navigate to search icon → `click_select_button`
2. `get_latest_screenshot` — confirm keyboard appeared
3. `load_skill` for typing — get keyboard layout and cursor position
4. `deterministic_typing` with text and cursor position from screenshot
5. If keyboard not visible: `click_select_button` again, re-check with screenshot
