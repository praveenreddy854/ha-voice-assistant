# Apple TV — General Navigation

## Official Integration Documentation
- Documentation: https://www.home-assistant.io/integrations/apple_tv/
- Home Assistant Core source: https://github.com/home-assistant/core/tree/dev/homeassistant/components/apple_tv
- If the command and service are clear from this skill, execute them directly without searching.
- If a command/service is unclear or fails, call `web_search` with the documentation or component-source URL and inspect the result before retrying.

## Mandatory State Guard
Before every command after the initial power action:
1. Check `remote.appletv` with `get_device_state` (Home Assistant `GET /api/states/remote.appletv`).
2. If its state is `off`, power it on with `remote.send_command` and command `wakeup`.
3. Only then execute the requested navigation, playback, typing, or app command.

The server also enforces this check immediately before command tools so a device that powers off mid-flow is woken before the next action.

If a power, playback, or app command is accepted but the expected state does not change, or a result is `PARTIAL`/`UNKNOWN`, call `web_search` with the Apple TV Home Assistant Core source URL before retrying another Apple TV command.

## Remote Button Mapping
- **go_back** = Menu button (`menu` remote command). Exits current view, backs out of menus, pauses/exits video player.
- **go_home** = Home button (`home` remote command). Returns to the Apple TV home screen.
- **click_select_button** = Center tap (`select` remote command). Confirms selections, enters menus, activates items.
- **navigate up/down/left/right** = D-pad directions on the touch surface.
- **media_control play/pause** = Play/Pause button on the remote.
- **media_control volume_up/volume_down** = Volume control. Full `volume_set` only works with HomePod audio output; HDMI CEC supports only up/down.
- **media_control next/previous** = Next/previous track.
- **media_control skip_forward/skip_backward** = Skip forward/backward within current media.

## Additional Remote Commands (via `remote.send_command`)
These commands are available through the Apple TV HA integration:
- **wakeup** — Wake the Apple TV from sleep.
- **suspend** — Put the Apple TV to sleep.
- **top_menu** — Open the top menu (tvOS control center).
- **num_repeats** parameter — Repeat a command N times (e.g., press down 5 times in one call).
- **delay_secs** parameter — Interval between repeated sends.
- **hold_secs** parameter — 0 = tap, 1+ = long-press (e.g., long-press Menu to force-quit an app).

## Home Assistant Entities
Each Apple TV creates three entities:
- **`media_player.<device>`** — Media playback control, state, and attributes.
- **`remote.<device>`** — Remote control command sending.
- **`binary_sensor.<device>_keyboard_focused`** — Reports `on` when an on-screen keyboard input field has focus. Useful for knowing when to invoke the typing agent.

## Media Player States
| State | Meaning |
|---|---|
| `playing` | Active media playback — must `go_back` before navigation works |
| `paused` | Media loaded but playback suspended |
| `idle` | Powered on, no active playback, ready for commands |
| `standby` | Low-power mode |
| `off` | Powered down |

## Key Attributes (on `media_player` entity)
- **app_name** / **app_id** — Currently active app (used by skill loader to select app-specific tips).
- **media_title**, **media_artist**, **media_album_name** — Currently playing media info.
- **media_content_type** — music, tvshow, video, episode, channel, playlist.
- **source_list** — List of available apps that can be launched via `launch_app`.

## App Launching
- Use the **launch_app** tool which calls `media_player.select_source` to open an app by name.
- For direct content playback, `media_player.play_media` supports deep link URLs (e.g., `youtube://www.youtube.com/watch?v=VIDEO_ID`).
- After launching an app, wait 2-3 seconds for it to fully load before taking any action.

## Keyboard Detection
- The `binary_sensor.<device>_keyboard_focused` entity turns `on` when a text input field has focus.
- The `apple_tv.clear_search_text` service clears any existing text in a focused search field.
- Use keyboard detection as an additional signal alongside screenshots to confirm when to invoke the typing agent.

## Home Screen
- The Apple TV home screen shows a grid of app icons.
- The top row often has suggested/featured content.
- Apps are arranged in a grid; navigate with directional buttons.

## General Tips
- Pressing Home always returns to the Apple TV home screen regardless of what app is open.
- Long-press Menu (hold_secs=1) to force-quit an unresponsive app back to the home screen.
- Apple TV remembers the last position within apps — reopening an app resumes where you left off.
- Power on with `wakeup` command; power off with `suspend` command.
