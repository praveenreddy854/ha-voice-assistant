# Android TV Remote Integration Skill

Source: https://www.home-assistant.io/integrations/androidtv_remote/

## Entities
- `remote.<name>`

## Remote Usage
- Use `remote.send_command` with Android key codes.
- Common commands include:
  - Navigation: `DPAD_UP`, `DPAD_DOWN`, `DPAD_LEFT`, `DPAD_RIGHT`, `DPAD_CENTER`
  - Back/Home: `BACK`, `HOME`
  - Playback: `MEDIA_PREVIOUS`, `MEDIA_REWIND`, `MEDIA_PLAY_PAUSE`, `MEDIA_STOP`, `MEDIA_NEXT`
  - Volume: `VOLUME_UP`, `VOLUME_DOWN`, `VOLUME_MUTE`

## App Launching
- Use `remote.turn_on` with an `activity` to open an app or URL.

## Notes
- Command support depends on the device and Android TV implementation.
