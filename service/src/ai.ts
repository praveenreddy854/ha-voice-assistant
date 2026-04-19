import { createAzure } from "@ai-sdk/azure";
import { generateText } from "ai";
import {
  AZURE_OPENAI_API_KEY,
  AZURE_OPENAI_RESOURCE_NAME,
  AZURE_OPENAI_API_VERSION,
} from "./config";

// ============================================================================
// Provider
// ============================================================================

if (!AZURE_OPENAI_RESOURCE_NAME || !AZURE_OPENAI_API_KEY) {
  throw new Error("OpenAI configuration missing required values");
}

export const azureProvider = createAzure({
  apiKey: AZURE_OPENAI_API_KEY,
  resourceName: AZURE_OPENAI_RESOURCE_NAME,
  apiVersion: AZURE_OPENAI_API_VERSION,
});

// ============================================================================
// Retry Helper
// ============================================================================

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

function isRetryable(error: any): boolean {
  if (error?.status && RETRYABLE_STATUS_CODES.has(error.status)) return true;
  const msg = error?.message ?? "";
  return (
    error?.code === "ECONNRESET" ||
    error?.code === "ETIMEDOUT" ||
    msg.includes("timeout") ||
    msg.includes("network")
  );
}

async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 2,
  baseDelay = 500
): Promise<T> {
  let lastError: any;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;
      if (attempt === maxRetries || !isRetryable(error)) break;
      const delay = Math.min(baseDelay * Math.pow(2, attempt) * (1 + Math.random() * 0.1), 5000);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Generate a plain text completion.
 */
export async function generateCompletion(params: {
  model: string;
  messages: Array<{ role: string; content: string }>;
  maxTokens?: number;
  temperature?: number;
}): Promise<string> {
  return withRetry(async () => {
    const result = await generateText({
      model: azureProvider(params.model),
      messages: params.messages as any,
      maxOutputTokens: params.maxTokens ?? 1000,
      ...(params.temperature != null && { temperature: params.temperature }),
    });
    return result.text;
  });
}

/**
 * Generate a completion and parse the result as JSON.
 */
export async function generateJsonCompletion<T>(params: {
  model: string;
  messages: Array<{ role: string; content: string }>;
  maxTokens?: number;
  temperature?: number;
}): Promise<T> {
  const text = await generateCompletion(params);
  return JSON.parse(text) as T;
}

/**
 * Perform a vision analysis using a base64-encoded image.
 */
export async function generateVisionText(params: {
  model: string;
  prompt: string;
  imageBase64: string;
  imageContentType: string;
  maxTokens?: number;
  temperature?: number;
}): Promise<string> {
  return withRetry(async () => {
    const result = await generateText({
      model: azureProvider(params.model),
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: params.prompt },
            {
              type: "image",
              image: params.imageBase64,
              mediaType: params.imageContentType as
                | "image/jpeg"
                | "image/png"
                | "image/gif"
                | "image/webp",
            },
          ],
        },
      ],
      maxOutputTokens: params.maxTokens ?? 500,
      ...(params.temperature != null && { temperature: params.temperature }),
    });
    return result.text;
  });
}
