/**
 * Common Agent Utilities
 * General-purpose utility functions shared across all agents
 */

/**
 * Safely stringify a value to JSON, returning undefined if it fails or is undefined
 * @param value - The value to stringify
 * @returns JSON string or undefined
 */
export function safeJsonStringify(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/**
 * Normalize multiline strings by converting CRLF to LF and trimming whitespace
 * @param value - The string to normalize
 * @returns Normalized string
 */
export function normalizeMultiline(value?: string | null): string {
  return (value ?? "").replace(/\r\n/g, "\n").trim();
}

/**
 * Resolve the maximum number of steps/iterations for an agent, capping at a maximum value
 * @param requested - The requested number of steps
 * @param maxCap - The maximum allowed steps (default: 20)
 * @returns The resolved number of steps, capped at maxCap
 */
export function resolveMaxSteps(
  requested?: number,
  maxCap: number = 20
): number {
  if (!Number.isFinite(requested) || (requested ?? 0) <= 0) {
    return maxCap;
  }
  return Math.min(maxCap, Math.max(1, Math.trunc(requested as number)));
}

/**
 * Delay execution for a specified number of milliseconds
 * @param ms - Milliseconds to delay
 * @param abortSignal - Optional signal that cancels the delay immediately
 * @returns Promise that resolves after the delay
 */
export async function delay(
  ms: number,
  abortSignal?: AbortSignal
): Promise<void> {
  abortSignal?.throwIfAborted();
  if (ms <= 0) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortSignal?.reason ?? new Error("Operation aborted"));
    };
    const timer = setTimeout(() => {
      abortSignal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
}
