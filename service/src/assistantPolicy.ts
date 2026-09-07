export type ConfirmationDecision = "confirmed" | "declined" | "unclear";

export function needsActionConfirmation(command: string): boolean {
  const normalized = command.trim().toLowerCase();
  const stateQuestion = /^(?:is|are|was|were)\b/.test(normalized);
  const protectedOpening =
    !stateQuestion &&
    /\b(open|unlock)\b/.test(normalized) &&
    /\b(front door|back door|garage door|garage)\b/.test(normalized);
  const bulkDestructive =
    /\b(cancel|delete|remove|clear|turn off|shut off|disable)\b/.test(
      normalized
    ) && /\b(all|every|everything|entire|whole)\b/.test(normalized);
  return protectedOpening || bulkDestructive;
}

export function classifyConfirmationAnswer(answer: string): ConfirmationDecision {
  const normalized = answer.trim().toLowerCase();
  if (
    /^(?:yes|yeah|yep|confirm|confirmed|do it|go ahead|proceed|please do|open it|unlock it)[.!]?$/i.test(
      normalized
    )
  ) {
    return "confirmed";
  }
  if (
    /^(?:no|nope|cancel|stop|do not|don't|never mind|nevermind)[.!]?$/i.test(
      normalized
    )
  ) {
    return "declined";
  }
  return "unclear";
}
