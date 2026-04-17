/**
 * Deterministic Keyboard Layouts
 *
 * Hardcoded position maps for known on-screen keyboard layouts.
 * Used by the deterministic typing tool to compute exact navigation
 * commands without relying on LLM count calculations.
 */

export interface KeyboardLayoutMap {
  /** Display name for logging */
  name: string;
  /** Map of character → position index on the horizontal strip */
  positions: Record<string, number>;
  /** Default starting position when keyboard first opens */
  defaultPosition: number;
  /** Default starting character */
  defaultChar: string;
}

/**
 * YouTube Apple TV horizontal alphabetical strip.
 *
 * Layout:
 *   Position:  0             1      2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27     28
 *   Key:       #(mode key)  SPACE  a  b  c  d  e  f  g  h  i  j  k  l  m  n  o  p  q  r  s  t  u  v  w  x  y  z  DELETE
 *
 *   Position 0 is a mode toggle key:
 *     - 1st click: switches to numbers (0-9)
 *     - 2nd click: switches to special characters
 *     - 3rd click: returns to alphabets (a-z)
 */
export const YOUTUBE_APPLETV_KEYBOARD: KeyboardLayoutMap = {
  name: "YouTube Apple TV Horizontal Strip",
  defaultPosition: 2, // 'a'
  defaultChar: "a",
  positions: {
    "#": 0,
    " ": 1,
    a: 2,
    b: 3,
    c: 4,
    d: 5,
    e: 6,
    f: 7,
    g: 8,
    h: 9,
    i: 10,
    j: 11,
    k: 12,
    l: 13,
    m: 14,
    n: 15,
    o: 16,
    p: 17,
    q: 18,
    r: 19,
    s: 20,
    t: 21,
    u: 22,
    v: 23,
    w: 24,
    x: 25,
    y: 26,
    z: 27,
    delete: 28,
  },
};

/**
 * Resolve which keyboard layout to use based on app context.
 * Falls back to YouTube Apple TV layout as default (most common).
 */
export function resolveKeyboardLayout(
  appHint?: string
): KeyboardLayoutMap {
  // Currently only one layout — extend this when adding Samsung, Netflix, etc.
  return YOUTUBE_APPLETV_KEYBOARD;
}

export interface NavigationStep {
  action: "navigate" | "select";
  direction?: "left" | "right";
  count?: number;
  character: string;
}

/**
 * Compute the deterministic sequence of navigate + select actions
 * to type `text` starting from `currentPosition`.
 *
 * Returns the steps and the final cursor position.
 */
export function computeTypingSequence(
  text: string,
  currentPosition: number,
  layout: KeyboardLayoutMap
): { steps: NavigationStep[]; finalPosition: number } {
  const steps: NavigationStep[] = [];
  let pos = currentPosition;

  for (const char of text.toLowerCase()) {
    const targetPos = layout.positions[char];
    if (targetPos === undefined) {
      // Skip characters not in the layout (numbers, symbols, etc.)
      console.warn(
        `[Keyboard] Character '${char}' not in ${layout.name} layout, skipping`
      );
      continue;
    }

    const diff = targetPos - pos;
    if (diff !== 0) {
      steps.push({
        action: "navigate",
        direction: diff > 0 ? "right" : "left",
        count: Math.abs(diff),
        character: char,
      });
    }

    steps.push({
      action: "select",
      character: char,
    });

    pos = targetPos;
  }

  return { steps, finalPosition: pos };
}
