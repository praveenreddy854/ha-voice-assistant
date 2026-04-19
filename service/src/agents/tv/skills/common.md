# Common Navigation Tips (All Devices)

## Before Navigating
- If content is currently playing (video, movie, show), you MUST press back button to exit the player BEFORE navigation will work. Navigation buttons do nothing during active playback.
- Always check device state first to know what app is open and whether media is playing.

## Navigation Best Practices
- Take small steps (1-3 button presses) and verify with a screenshot after each move.
- Wait for the UI to settle after actions: 1500-2000ms after power on, 2000-3000ms after app launch, 1000ms after navigation.
- If you get lost or the UI is unrecognizable, press go_home to reset to the home screen and start over.

## Search Workflow
1. Navigate to the search icon and press select to activate the search field.
2. Request a screenshot to confirm the on-screen keyboard appeared.
3. Only use `deterministic_typing` AFTER verifying the keyboard is visible.
4. If no keyboard appears, press select again or navigate to the input field first.

## App Launch
- After launching an app, wait 2-3 seconds for it to fully load before taking any action.
- Verify the app loaded by requesting a screenshot — don't assume it opened.
