# YouTube on Apple TV — Navigation Skills

## Starting Position (Fresh App Launch)
When YouTube is freshly launched (from a turned-off state or via `launch_app`):
1. YouTube shows a **profile selection** screen first. Press **`click_select_button`** to select the default profile, then `wait` 2000ms for the home feed to load.
2. After profile selection, the **first content item** in the main content grid is selected/highlighted.
3. Press **Left** once to move focus to the **Home** icon in the sidebar.
4. From the Home icon, use the sidebar navigation below (e.g., Up 1x to reach Search).

**Navigation from fresh launch to Search:**
1. `click_select_button` → select YouTube profile
2. `wait` 2000ms → home feed loads
3. Press **Left** 1x → Home icon in sidebar
4. Press **Up** 1x → Search icon
5. Press **select** → Search keyboard appears

## Exiting Video Playback
- When a video is playing, press **go_back** (Menu) to exit the player and return to the browse UI.
- Navigation buttons (up/down/left/right) do NOT work while a video is playing. You must exit first.

## Sidebar (Left Navigation Rail)
YouTube on Apple TV uses a collapsible left sidebar. The icons from top to bottom are:

1. **Profile** (profile image with user name)
2. **Search** (magnifying glass icon)
3. **Home** (house icon): This what usually selected when navigated left from media content area.
4. **Music**
5. **Movies & TV**
6. **Podcasts**
7. **Library**
8. **Subscriptions**
9. **More**
10. **Settings** (at the bottom)

The sidebar is collapsed by default (only icons visible). Pressing **Left** from the content area expands it to show labels.

## How to Reach Search

**From a fresh launch** (you just called `launch_app`):
Use the Starting Position steps above — Left 1x → Up 1x → select. Only 1 Left press needed.

**From the browse UI** (after exiting a video with go_back, or general navigation):
1. Press **Left** repeatedly (3-5 times) until the sidebar expands and an item is highlighted.
2. The **Home** icon is typically selected by default when entering the sidebar.
3. Press **Up 1 time** to move from Home to the **Search** icon (Search is directly above Home).
4. Press **select** to activate Search. The search input field and keyboard will appear.

If you are deeper in the sidebar (e.g., on Library), press **Up** multiple times to reach Search at the top.

## Search & Keyboard
- After activating Search, YouTube shows a horizontal letter strip across the top of the screen (not a grid keyboard).
- Layout: `#(mode) SPACE a b c d e f g h i j k l m n o p q r s t u v w x y z DELETE`
- 'a' is selected on the keyboard by default. Other alphabets will be in sequence on the right.
- To the left of 'a': SPACE, then mode toggle key. To the right of 'z': DELETE key.
- Mode toggle key (far left): 1st click → numbers, 2nd click → special chars, 3rd click → back to alphabets.
- Search suggestions appear below as you type — you can navigate Down to select a suggestion and press select.
- Use the `deterministic_typing` tool for typing — it handles navigation automatically.

## Content Grid Navigation
- The main content area is a grid of video thumbnails arranged in rows.
- Navigate Up/Down to move between rows, Left/Right to move between videos in a row.
- Press select on a video thumbnail to start playing it.

## Common Workflows

### "Search for X on YouTube"
1. If video is playing → go_back to exit player
2. Press Left (3-5x) to expand sidebar
3. Press Up until Search icon is highlighted
4. Press select to open search
5. Verify keyboard appeared with screenshot
6. Use `deterministic_typing` to type the search query
7. Navigate Down to results and select

### "Play something from subscriptions"
1. If video is playing → go_back to exit player
2. Press Left to expand sidebar
3. Navigate to Subscriptions (below Library)
4. Press select or Right to enter subscriptions feed
5. Navigate the content grid and select a video

### "Go to YouTube home"
1. If video is playing → go_back to exit player
2. Press Left to expand sidebar
3. Navigate to Home icon (third from top, below Search)
4. Press select or Right to enter home feed
