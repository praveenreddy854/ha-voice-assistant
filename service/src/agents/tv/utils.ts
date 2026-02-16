/**
 * TV Agent Utility Functions
 * TV-specific helper functions for parsing and formatting
 */

/**
 * Parse completion message from agent response to extract the final command
 * @param message - The agent's response message
 * @returns The final command string or undefined if not completed
 */
export function parseFinalCommand(message?: string): string | undefined {
  if (!message) {
    return undefined;
  }

  const trimmedMessage = message.trim();

  // Try to parse as JSON first
  try {
    const parsed = JSON.parse(trimmedMessage);
    if (parsed && typeof parsed === "object") {
      if (parsed.status === "done") {
        return (
          parsed.final_command ||
          parsed.finalCommand ||
          "Task completed successfully"
        );
      }
    }
  } catch (error) {
    // Not valid JSON, continue with other detection methods
  }

  // Look for JSON objects embedded in the message
  const jsonMatches = trimmedMessage.matchAll(
    /\{[^}]*"status"\s*:\s*"done"[^}]*\}/g
  );
  for (const match of jsonMatches) {
    try {
      const parsed = JSON.parse(match[0]);
      if (parsed && parsed.status === "done") {
        return (
          parsed.final_command ||
          parsed.finalCommand ||
          "Task completed successfully"
        );
      }
    } catch (error) {
      // Continue looking for other matches
    }
  }

  // Look for completion indicators in the message text
  const completionPhrases = [
    /task\s+(?:is\s+)?completed?/i,
    /goal\s+(?:is\s+)?(?:achieved|reached|accomplished)/i,
    /successfully\s+(?:completed|finished|done)/i,
    /playback\s+(?:has\s+)?started/i,
    /(?:is\s+)?now\s+playing/i,
  ];

  for (const pattern of completionPhrases) {
    if (pattern.test(trimmedMessage)) {
      return trimmedMessage;
    }
  }

  // If no completion detected, return undefined
  return undefined;
}

/**
 * Describe a pending TV remote action in human-readable format
 * @param args - The action arguments
 * @returns Human-readable description of the action
 */
export function describePendingAction(args: {
  actionType: string;
  button?: string;
  direction?: string;
  count?: number;
  text?: string;
  waitMs?: number;
}): string {
  const tvDefaultWaitMs = 1500;

  switch (args.actionType) {
    case "press":
      return args.button ? `Press ${args.button}` : "Press remote button";
    case "scroll": {
      const direction = args.direction || "direction";
      const count = Math.min(Math.max(args.count ?? 1, 1), 10);
      return count === 1
        ? `Scroll ${direction}`
        : `Scroll ${direction} ${count} times`;
    }
    case "type":
      return args.text ? `Type "${args.text}"` : "Type text";
    case "wait": {
      const duration =
        typeof args.waitMs === "number" && Number.isFinite(args.waitMs)
          ? Math.max(0, args.waitMs)
          : tvDefaultWaitMs;
      return `Wait ${duration}ms`;
    }
    case "home":
      return "Press home button";
    case "back":
      return "Press back button";
    default:
      return `Perform ${args.actionType}`;
  }
}
