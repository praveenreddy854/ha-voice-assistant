import { z } from "zod";

// Require a real calendar date and explicit timezone, avoiding Date.parse's
// permissive rollover of invalid dates or dependence on the server timezone.
export const dueDateSchema = z.iso.datetime({ offset: true }).describe(
  "Absolute ISO-8601 timestamp with Z or an explicit timezone offset, strictly in the future. Convert relative phrases against the current date/time in the system prompt."
);

/** No past-time grace: an expired command must be reconsidered before saving. */
export function dueDateError(dueDate: string, now = new Date()): string | undefined {
  if (!dueDateSchema.safeParse(dueDate).success) {
    return "dueDate must be a valid ISO-8601 timestamp with Z or an explicit timezone offset.";
  }
  if (Date.parse(dueDate) <= now.getTime()) {
    return `dueDate must be strictly in the future. Current time is ${now.toISOString()}. The requested deadline has passed; do not silently restart its delay or move it forward. Ask the user for a new time. Nothing was saved.`;
  }
  return undefined;
}
