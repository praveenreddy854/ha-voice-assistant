# Samsung TV — General Navigation

## Official Integration Documentation
- Documentation: https://www.home-assistant.io/integrations/samsungtv/
- Home Assistant Core source: https://github.com/home-assistant/core/tree/dev/homeassistant/components/samsungtv
- Repository root: https://github.com/home-assistant/core/tree/dev/homeassistant/components
- If the command and service are clear from this skill, execute them directly without searching.
- If a command/service is unclear or fails, call `web_search` with the documentation or component-source URL and inspect the result before retrying.

## Mandatory State Guard
Before every command after the initial power action:
1. Check the remote with `get_device_state`. For this device the direct Home Assistant request is `GET /api/states/remote.samsungtv`.
2. If the returned state is `off`, call `POST /api/services/remote/turn_on` with:
   ```json
   { "entity_id": "remote.samsungtv" }
   ```
3. Only after the power-on call succeeds, execute the requested navigation, playback, or app command.

The server also enforces this check immediately before command tools so a TV that powers off mid-flow is turned on before the next action.

## Remote Button Mapping
- **go_home** sends `KEY_HOME` through `remote.send_command`.
- Other Samsung remote actions must use the supported `KEY_*` command names from the fetched integration documentation; do not substitute Apple TV command names.

Example Home command after the state guard:
```http
POST /api/services/remote/send_command
```

```json
{
  "entity_id": "remote.samsungtv",
  "command": "KEY_HOME"
}
```

## Home Assistant Entities
- **`remote.samsungtv`** — Power and Samsung remote-key commands.
- **`media_player.samsung_tv`** — Playback state, source/app attributes, and media-player services when available.

## Power and State Rules
- Treat `off` as requiring `remote.turn_on` before any subsequent command.
- Do not use a toggle for recovery: an explicit `turn_on` prevents accidentally turning an already-on TV off.
- Re-check state before each subsequent action because the TV may power off during a multi-step flow.
- HTTP/service acceptance is not success if the state remains `off`. If power or app state is unchanged, `PARTIAL`, `UNKNOWN`, or unverified, call `web_search` with the Samsung TV Home Assistant Core source URL before retrying any Samsung command.
- If Home Assistant reports `unavailable`, research the component behavior before retrying; if it remains unavailable, stop rather than sending blind key presses.

## General Tips
- Samsung remote commands use `KEY_*` names; Apple TV command names such as `home`, `menu`, and `select` are not interchangeable.
- After power-on, allow the TV time to become responsive before sending `KEY_HOME` or another navigation key.
- Use screenshots to verify UI position after navigation.
