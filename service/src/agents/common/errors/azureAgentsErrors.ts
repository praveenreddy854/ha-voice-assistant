/**
 * Azure Agents Error Handling Utilities
 * Common error handling functions for Azure AI Agents SDK
 */

/**
 * Safely stringify a value to JSON, returning undefined if it fails or is undefined
 */
function safeJsonStringify(value: unknown): string | undefined {
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
 * Extract a user-friendly error message from Azure Agents REST errors
 * @param error - The error object from Azure Agents SDK
 * @returns A formatted error message or undefined if not a REST error
 */
export function extractRestErrorMessage(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const restError = error as {
    statusCode?: number;
    message?: string;
    response?: {
      bodyAsText?: string;
      parsedBody?: unknown;
    };
    details?: unknown;
  };

  const segments: string[] = [];
  if (typeof restError.message === "string" && restError.message.length > 0) {
    segments.push(restError.message);
  }

  const bodyText = restError.response?.bodyAsText;
  if (typeof bodyText === "string" && bodyText.length > 0) {
    segments.push(bodyText);
  }

  const details =
    restError.details ?? restError.response?.parsedBody ?? undefined;
  const detailString = safeJsonStringify(details);
  if (detailString) {
    segments.push(detailString);
  }

  if (segments.length === 0) {
    return undefined;
  }

  const status = restError.statusCode;
  const statusPart = status ? ` (status ${status})` : "";
  return `Azure Agents request failed${statusPart}: ${segments.join(" | ")}`;
}

/**
 * Log detailed information about Azure Agents REST errors to the console
 * @param error - The error object from Azure Agents SDK
 */
export function logRestErrorDetails(error: unknown): void {
  if (!error || typeof error !== "object") {
    return;
  }

  const restError = error as {
    statusCode?: number;
    message?: string;
    details?: unknown;
    response?: {
      bodyAsText?: string;
      parsedBody?: unknown;
      headers?: Record<string, unknown>;
    };
  };

  const payload = {
    statusCode: restError.statusCode,
    message:
      restError.message || (error instanceof Error ? error.message : undefined),
    bodyText: restError.response?.bodyAsText,
    parsedBody: restError.response?.parsedBody,
    details: restError.details,
    headers: restError.response?.headers,
  };

  console.error("Azure Agents REST error", payload);
}
