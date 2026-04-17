# Apple TV On-Screen Keyboard — Typing Skills

## Keyboard Layout (YouTube Search Strip)

```
Position:  0             1      2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27     28
Key:       #(mode key)   SPACE  a  b  c  d  e  f  g  h  i  j  k  l  m  n  o  p  q  r  s  t  u  v  w  x  y  z  DELETE
```

- Position 0: Mode toggle key — cycles through keyboard modes:
  - **1st click**: switches to numbers (0–9)
  - **2nd click**: switches to special characters
  - **3rd click**: returns to alphabets (a–z)
- Position 1: SPACE
- Positions 2–27: Letters a–z
- Position 28: DELETE (backspace)
- Default cursor position when keyboard first appears: **'a' (position 2)**

## Deterministic Typing with `deterministic_typing`

ALWAYS use `deterministic_typing` for this keyboard layout. Pass the **full text** in one call.

### What you need to do:
1. Look at the screenshot and identify which character the cursor is currently on.
2. Call `deterministic_typing` with the **complete text** and the current cursor position.
3. The tool types word by word, validates each word via background screenshots, and stops if something goes wrong.

### Example:
```
deterministic_typing(text="latest telugu songs", current_cursor_position="a")
```

### If the tool reports an error:
1. It tells you what it expected vs what it actually saw on screen.
2. Use `go_back` to delete the incorrect characters.
3. Call `deterministic_typing` again with the remaining text and current cursor position.
