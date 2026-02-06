# Samsung Smart TV Integration Skill

Source: https://www.home-assistant.io/integrations/samsungtv/

## Entities
- `media_player.<name>`
- `remote.<name>` (remote commands)

## Remote Usage
- Use `remote.send_command` with Samsung key codes.
- The integration provides a list of supported keys; examples include:
  - `KEY_MENU`, `KEY_HOME`, `KEY_TOPMENU`, `KEY_CONTENTS`, `KEY_GUIDE`, `KEY_INFO`
  - `KEY_RED`, `KEY_GREEN`, `KEY_YELLOW`, `KEY_BLUE`
  - `KEY_EXIT`, `KEY_SEARCH`
  - `KEY_PIP_ONOFF`, `KEY_PIP_CHUP`, `KEY_PIP_CHDOWN`, `KEY_PIP_SCAN`

## Notes
- Supported keys vary by TV model and firmware; rely on the integration’s key list for the device.
