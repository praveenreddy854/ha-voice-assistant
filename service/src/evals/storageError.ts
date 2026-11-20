/** Public eval diagnostics must never copy provider request/header dumps. */
export function summarizeStorageError(error: unknown): string {
  const value = error as { message?: unknown; code?: unknown; statusCode?: unknown } | null;
  const message = typeof value?.message === "string" ? value.message : "";
  const code = value?.statusCode ?? value?.code;
  const status = typeof code === "number" ? code :
    typeof code === "string" && /^[45]\d{2}$/.test(code) ? Number(code) : undefined;
  const suffix = status !== undefined && Number.isInteger(status) && status >= 400 && status <= 599
    ? ` (HTTP ${status})` : "";
  // Recognize this operational signal, but never forward any part of its message.
  if (/subscription owning the database account is disabled/i.test(message)) {
    return `Storage subscription is disabled${suffix}. Restore subscription access before retrying.`;
  }
  if (/^Source read timed out after \d+ ms; incomplete history was not returned$/.test(message)) {
    return "Source read timed out; incomplete history was not returned";
  }
  return `Storage read failed${suffix}; check service availability and credentials.`;
}
