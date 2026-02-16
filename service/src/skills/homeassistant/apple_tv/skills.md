# Apple TV Integration Skill

Source: https://www.home-assistant.io/integrations/apple_tv/

## Entities
- `media_player.<name>`
- `remote.<name>`

## Media Player Usage
- Launch apps via `media_player.select_source`.
- Use `media_player.play_media` with deep links (`media_content_type: url`) to open specific content.

## Remote Usage
- Use `remote.send_command` for control and navigation.
- Supported commands include:
  - Power: `wakeup`, `suspend`
  - Navigation: `home`, `top_menu`, `menu`, `select`, `up`, `down`, `left`, `right`
  - Playback: `play`, `pause`, `next`, `previous`, `skip_forward`, `skip_backward`
  - Volume: `volume_up`, `volume_down`
- Service data options: `command`, `num_repeats`, `delay_secs`, `hold_secs`.

## Notes
- Some commands may not be supported on all Apple TV versions.
