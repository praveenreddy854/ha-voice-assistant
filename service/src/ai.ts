import { createAzure } from "@ai-sdk/azure";
import { generateText } from "ai";
import { outputTokenBudget, resolveModelSettings, reasoningSettings, samplingSettings, type ReasoningEffort } from "./modelSettings";
import {
  foundryConnectionFor,
  AZURE_OPENAI_API_VERSION,
} from "./config";

// ============================================================================
// Provider
// ============================================================================

function providerFor(model: string) {
  const { apiKey, resourceName } = foundryConnectionFor(model);
  return createAzure({ apiKey, resourceName, apiVersion: AZURE_OPENAI_API_VERSION });
}

export const azureProvider = (model: string) => providerFor(model)(model);
export const azureEmbeddingModel = (model: string) => providerFor(model).embeddingModel(model);

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
  baseDelay = 500,
  abortSignal?: AbortSignal
): Promise<T> {
  let lastError: any;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      abortSignal?.throwIfAborted();
      return await fn();
    } catch (error: any) {
      lastError = error;
      abortSignal?.throwIfAborted();
      if (attempt === maxRetries || !isRetryable(error)) break;
      const delay = Math.min(baseDelay * Math.pow(2, attempt) * (1 + Math.random() * 0.1), 5000);
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          clearTimeout(timer);
          reject(abortSignal?.reason ?? new Error("Operation aborted"));
        };
        const timer = setTimeout(() => {
          abortSignal?.removeEventListener("abort", onAbort);
          resolve();
        }, delay);
        if (abortSignal?.aborted) {
          onAbort();
          return;
        }
        abortSignal?.addEventListener("abort", onAbort, { once: true });
      });
    }
  }
  throw lastError;
}

// ============================================================================
// Core Functions
// ============================================================================

function completedText(result: { finishReason: string; text: string }): string {
  if (result.finishReason === "length") {
    throw new Error("Model response was truncated at the output token limit");
  }
  return result.text;
}

/**
 * Generate a plain text completion.
 */
export async function generateCompletion(params: {
  model: string;
  reasoningEffort?: ReasoningEffort;
  messages: Array<{ role: string; content: string }>;
  maxTokens?: number;
  temperature?: number;
  abortSignal?: AbortSignal;
}): Promise<string> {
  const { model = "", reasoningEffort } = resolveModelSettings(params.model, params.reasoningEffort) ?? {};
  return withRetry(async () => {
    const result = await generateText({
      model: azureProvider(model),
      messages: params.messages as any,
      abortSignal: params.abortSignal,
      maxOutputTokens: outputTokenBudget(model, params.maxTokens ?? 1000, reasoningEffort),
      ...reasoningSettings(reasoningEffort),
      ...samplingSettings(model, params.temperature, reasoningEffort),
    });
    return completedText(result);
  }, 2, 500, params.abortSignal);
}

/**
 * Generate a completion and parse the result as JSON.
 */
export async function generateJsonCompletion<T>(params: {
  model: string;
  reasoningEffort?: ReasoningEffort;
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
  reasoningEffort?: ReasoningEffort;
  prompt: string;
  imageBase64: string;
  imageContentType: string;
  maxTokens?: number;
  temperature?: number;
}): Promise<string> {
  const { model = "", reasoningEffort } = resolveModelSettings(params.model, params.reasoningEffort) ?? {};
  return withRetry(async () => {
    const result = await generateText({
      model: azureProvider(model),
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: params.prompt },
            {
              type: "file",
              data: { type: "data", data: params.imageBase64 },
              mediaType: params.imageContentType as
                | "image/jpeg"
                | "image/png"
                | "image/gif"
                | "image/webp",
            },
          ],
        },
      ],
      maxOutputTokens: outputTokenBudget(model, params.maxTokens ?? 500, reasoningEffort),
      ...reasoningSettings(reasoningEffort),
      ...samplingSettings(model, params.temperature, reasoningEffort),
    });
    return completedText(result);
  });
}
