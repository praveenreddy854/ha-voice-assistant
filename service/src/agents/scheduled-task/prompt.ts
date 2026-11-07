/** Rendering is shared with offline fixtures; the caller owns the clock and timezone. */
export function renderScheduledTaskSystemPrompt(template: string, now: Date, timeZone: string, receivedAt = now): string {
  return template
    .replace("{{{CurrentDateTime}}}", now.toISOString())
    .replace("{{{RequestReceivedAt}}}", receivedAt.toISOString())
    .replace("{{{UserTimezone}}}", timeZone);
}
