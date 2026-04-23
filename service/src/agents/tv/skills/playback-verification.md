# Playback Verification

After selecting a video/song to play:

1. `wait` 2000ms for playback to start
2. `get_device_state` — check `media_title` and playback state
3. If `playing` and `media_title` matches expected content → success
4. If `paused` → `media_control` play, then re-check with `get_device_state`
5. If `media_title` unchanged or state is `idle` → selection missed. `get_latest_screenshot` to see what happened, then retry
6. **Never give up without trying `media_control play`** — Apple TV often loads videos in paused state
