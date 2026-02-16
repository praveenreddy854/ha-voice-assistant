import { generateText } from "ai";
import {
  buildAiSdkTools,
  convertLegacyResponsesInputToAiMessages,
  extractJsonObjectFromText,
  getAzureResponsesModel,
} from "./aiSdk";
import {
  AZURE_OPENAI_API_DEPLOYMENT_NAME,
  HA_COMMAND_PROCESS_MODEL,
} from "./config";
import { IntentClassificationResponse, IntentErrorResponse } from "./intent";
import {
  SpanKind,
  addStoryEvent,
  getTelemetryMetrics,
  recordSpanError,
  withSpan,
} from "./tracing";

interface OpenAIRequestOptions {
  model?: string;
  messages: Array<{ role: string; content: string }>;
  max_tokens?: number;
  temperature?: number;
}

interface RetryOptions {
  maxRetries?: number;
  baseDelay?: number;
  maxDelay?: number;
}

const INTENT_VALUES: Array<IntentClassificationResponse["intent"]> = [
  "HACommand",
  "Reminder",
  "Chat",
  "AgenticFlow",
  "TeachingMode",
];

class OpenAIService {
  private defaultRetryOptions: Required<RetryOptions> = {
    maxRetries: 2,
    baseDelay: 500,
    maxDelay: 5000,
  };

  private async delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private calculateDelay(
    attempt: number,
    baseDelay: number,
    maxDelay: number,
  ): number {
    const exponentialDelay = baseDelay * Math.pow(2, attempt);
    const jitter = Math.random() * 0.1 * exponentialDelay;
    return Math.min(exponentialDelay + jitter, maxDelay);
  }

  private shouldRetry(error: unknown): boolean {
    if (!error || typeof error !== "object") {
      return false;
    }

    const candidate = error as {
      status?: number;
      statusCode?: number;
      code?: string;
      message?: string;
    };
    const status = candidate.statusCode ?? candidate.status;
    if (status) {
      return (
        status === 429 ||
        status === 500 ||
        status === 502 ||
        status === 503 ||
        status === 504
      );
    }

    return (
      candidate.code === "ECONNRESET" ||
      candidate.code === "ETIMEDOUT" ||
      Boolean(candidate.message?.includes("timeout")) ||
      Boolean(candidate.message?.includes("network")) ||
      Boolean(candidate.message?.includes("ENOTFOUND"))
    );
  }

  private normalizeRole(role: string): "system" | "user" | "assistant" {
    if (role === "system" || role === "assistant" || role === "user") {
      return role;
    }
    return "user";
  }

  private supportsTemperature(model: string): boolean {
    const normalizedModel = model.toLowerCase();
    return !(
      normalizedModel.startsWith("gpt-5") ||
      normalizedModel.startsWith("o1") ||
      normalizedModel.startsWith("o3") ||
      normalizedModel.startsWith("o4")
    );
  }

  private temperatureOption(
    model: string,
    temperature: number | undefined,
  ): { temperature?: number } {
    if (temperature === undefined || !this.supportsTemperature(model)) {
      return {};
    }
    return { temperature };
  }

  private isIntentValue(value: unknown): value is IntentClassificationResponse["intent"] {
    return typeof value === "string" && INTENT_VALUES.includes(value as IntentClassificationResponse["intent"]);
  }

  private normalizeIntentResult(
    value: unknown,
  ): IntentClassificationResponse | IntentErrorResponse {
    if (value && typeof value === "object") {
      const candidate = value as { intent?: unknown; error?: unknown };
      if (this.isIntentValue(candidate.intent)) {
        return { intent: candidate.intent };
      }
      if (candidate.error === "no_match") {
        return { error: "no_match" };
      }
    }

    return this.parseIntentFromText(
      typeof value === "string" ? value : JSON.stringify(value),
    );
  }

  private parseIntentFromText(text: string): IntentClassificationResponse | IntentErrorResponse {
    if (!text) {
      return { intent: "Chat" };
    }

    const cleaned = text.trim();
    try {
      const parsed = JSON.parse(extractJsonObjectFromText(cleaned));
      if (parsed && typeof parsed === "object") {
        const candidate = parsed as { intent?: unknown; error?: unknown };
        if (this.isIntentValue(candidate.intent)) {
          return { intent: candidate.intent };
        }
        if (candidate.error === "no_match") {
          return { error: "no_match" };
        }
      }
    } catch {
      // Fall through to text-based inference.
    }

    const normalized = cleaned.toLowerCase();

    if (normalized.includes("no_match") || normalized.includes("no match")) {
      return { error: "no_match" };
    }
    if (
      normalized.includes("teachingmode") ||
      normalized.includes("teaching mode")
    ) {
      return { intent: "TeachingMode" };
    }
    if (
      normalized.includes("agenticflow") ||
      normalized.includes("agentic flow")
    ) {
      return { intent: "AgenticFlow" };
    }
    if (
      normalized.includes("hacommand") ||
      normalized.includes("ha command")
    ) {
      return { intent: "HACommand" };
    }
    if (normalized.includes("reminder")) {
      return { intent: "Reminder" };
    }
    if (normalized.includes("chat")) {
      return { intent: "Chat" };
    }

    return { intent: "Chat" };
  }

  async createCompletion<T>(
    options: OpenAIRequestOptions,
    retryOptions?: RetryOptions,
  ): Promise<T> {
    const model = options.model || AZURE_OPENAI_API_DEPLOYMENT_NAME || "";

    return withSpan<T>(
      "openai.responses.create_completion",
      {
        kind: SpanKind.CLIENT,
        attributes: {
          "llm.operation": "create_completion",
          "llm.model": model,
          "llm.messages.count": options.messages.length,
        },
      },
      async (span) => {
        const metrics = getTelemetryMetrics();
        const finalRetryOptions = {
          ...this.defaultRetryOptions,
          ...retryOptions,
        };
        const { maxRetries, baseDelay, maxDelay } = finalRetryOptions;
        let lastError: unknown;

        metrics.externalCallsTotal.add(1, {
          "dependency.name": "azure_openai",
          "dependency.operation": "create_completion",
          "llm.model": model,
        });

        for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
          const attemptStart = Date.now();
          addStoryEvent(span, "openai.attempt.start", {
            "openai.attempt.index": attempt + 1,
            "openai.attempt.max": maxRetries + 1,
          });

          try {
            const response = await generateText({
              model: getAzureResponsesModel(model),
              messages: options.messages.map((message) => ({
                role: this.normalizeRole(message.role),
                content: message.content,
              })),
              maxOutputTokens: options.max_tokens || 1000,
              ...this.temperatureOption(model, options.temperature),
            });

            if (!response.text) {
              throw new Error("No output text in AI SDK response");
            }

            let parsed: T;
            try {
              parsed = JSON.parse(extractJsonObjectFromText(response.text)) as T;
            } catch {
              addStoryEvent(span, "openai.response.parse_failed", {
                "openai.response.length": response.text.length,
              });
              throw new Error("Invalid JSON response format from model");
            }

            const durationMs = Date.now() - attemptStart;
            metrics.externalCallDurationMs.record(durationMs, {
              "dependency.name": "azure_openai",
              "dependency.operation": "create_completion",
              "dependency.outcome": "success",
              "llm.model": model,
            });

            addStoryEvent(span, "openai.attempt.success", {
              "openai.attempt.index": attempt + 1,
              "openai.response.status": response.finishReason || "",
              "openai.response.length": response.text.length,
              "openai.attempt.duration_ms": durationMs,
            });
            return parsed;
          } catch (error: unknown) {
            lastError = error;
            const durationMs = Date.now() - attemptStart;
            metrics.externalCallDurationMs.record(durationMs, {
              "dependency.name": "azure_openai",
              "dependency.operation": "create_completion",
              "dependency.outcome": "error",
              "llm.model": model,
            });

            addStoryEvent(span, "openai.attempt.failed", {
              "openai.attempt.index": attempt + 1,
              "openai.attempt.duration_ms": durationMs,
              "openai.error.message":
                error instanceof Error ? error.message : String(error),
            });

            if (attempt === maxRetries || !this.shouldRetry(error)) {
              break;
            }

            const delayMs = this.calculateDelay(attempt, baseDelay, maxDelay);
            metrics.retriesTotal.add(1, {
              "dependency.name": "azure_openai",
              "dependency.operation": "create_completion",
              "llm.model": model,
            });
            addStoryEvent(span, "openai.retry.scheduled", {
              "openai.retry.delay_ms": delayMs,
              "openai.retry.attempt": attempt + 2,
            });
            await this.delay(delayMs);
          }
        }

        const finalError = new Error(
          `OpenAI request failed after ${maxRetries + 1} attempts. Last error: ${
            lastError instanceof Error ? lastError.message : String(lastError)
          }`,
        );
        metrics.errorsTotal.add(1, {
          "error.source": "openai.create_completion",
          "llm.model": model,
        });
        recordSpanError(span, finalError, {
          "openai.attempts": maxRetries + 1,
        });
        throw finalError;
      },
    );
  }

  async createCompletionWithJsonResponse<T>(
    options: OpenAIRequestOptions,
    retryOptions?: RetryOptions,
  ): Promise<T> {
    const response = await this.createCompletion<T>(options, retryOptions);

    try {
      return response;
    } catch (error) {
      console.error("Failed to parse OpenAI response as JSON:", error);
      console.error("Response text:", JSON.stringify(response));
      throw new Error("Invalid JSON response format from OpenAI");
    }
  }

  async createHomeAssistantCompletion(
    messages: Array<{ role: string; content: string }>,
    retryOptions?: RetryOptions,
  ): Promise<string> {
    const model = HA_COMMAND_PROCESS_MODEL || "";

    return withSpan<string>(
      "openai.responses.create_home_assistant_completion",
      {
        kind: SpanKind.CLIENT,
        attributes: {
          "llm.operation": "create_home_assistant_completion",
          "llm.model": model,
          "llm.messages.count": messages.length,
        },
      },
      async (span) => {
        const metrics = getTelemetryMetrics();
        const finalRetryOptions = {
          ...this.defaultRetryOptions,
          ...retryOptions,
        };
        const { maxRetries, baseDelay, maxDelay } = finalRetryOptions;
        let lastError: unknown;

        metrics.externalCallsTotal.add(1, {
          "dependency.name": "azure_openai",
          "dependency.operation": "create_home_assistant_completion",
          "llm.model": model,
        });

        for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
          const attemptStart = Date.now();
          addStoryEvent(span, "openai.attempt.start", {
            "openai.attempt.index": attempt + 1,
            "openai.attempt.max": maxRetries + 1,
          });

          try {
            const response = await generateText({
              model: getAzureResponsesModel(model),
              messages: messages.map((message) => ({
                role: this.normalizeRole(message.role),
                content: message.content,
              })),
              maxOutputTokens: 1000,
            });

            const durationMs = Date.now() - attemptStart;
            metrics.externalCallDurationMs.record(durationMs, {
              "dependency.name": "azure_openai",
              "dependency.operation": "create_home_assistant_completion",
              "dependency.outcome": "success",
              "llm.model": model,
            });

            addStoryEvent(span, "openai.attempt.success", {
              "openai.attempt.index": attempt + 1,
              "openai.response.status": response.finishReason || "",
              "openai.response.length": response.text?.length || 0,
              "openai.attempt.duration_ms": durationMs,
            });

            return response.text || "";
          } catch (error: unknown) {
            lastError = error;
            const durationMs = Date.now() - attemptStart;
            metrics.externalCallDurationMs.record(durationMs, {
              "dependency.name": "azure_openai",
              "dependency.operation": "create_home_assistant_completion",
              "dependency.outcome": "error",
              "llm.model": model,
            });

            addStoryEvent(span, "openai.attempt.failed", {
              "openai.attempt.index": attempt + 1,
              "openai.attempt.duration_ms": durationMs,
              "openai.error.message":
                error instanceof Error ? error.message : String(error),
            });

            if (attempt === maxRetries || !this.shouldRetry(error)) {
              break;
            }

            const delayMs = this.calculateDelay(attempt, baseDelay, maxDelay);
            metrics.retriesTotal.add(1, {
              "dependency.name": "azure_openai",
              "dependency.operation": "create_home_assistant_completion",
              "llm.model": model,
            });
            addStoryEvent(span, "openai.retry.scheduled", {
              "openai.retry.delay_ms": delayMs,
              "openai.retry.attempt": attempt + 2,
            });
            await this.delay(delayMs);
          }
        }

        const finalError = new Error(
          `OpenAI request failed after ${maxRetries + 1} attempts. Last error: ${
            lastError instanceof Error ? lastError.message : String(lastError)
          }`,
        );
        metrics.errorsTotal.add(1, {
          "error.source": "openai.create_home_assistant_completion",
          "llm.model": model,
        });
        recordSpanError(span, finalError, {
          "openai.attempts": maxRetries + 1,
        });
        throw finalError;
      },
    );
  }

  async createIntentClassification(
    messages: Array<{ role: string; content: string }>,
    retryOptions?: RetryOptions,
  ): Promise<IntentClassificationResponse | IntentErrorResponse> {
    const model =
      AZURE_OPENAI_API_DEPLOYMENT_NAME || HA_COMMAND_PROCESS_MODEL || "";

    try {
      const structuredResult = await this.createCompletion<
        IntentClassificationResponse | IntentErrorResponse
      >(
        {
          model,
          messages,
          max_tokens: 400,
        },
        retryOptions,
      );
      return this.normalizeIntentResult(structuredResult);
    } catch (error) {
      console.warn(
        "[Intent] Structured JSON parse failed, falling back to text parsing:",
        error instanceof Error ? error.message : String(error),
      );
    }

    try {
      const response = await generateText({
        model: getAzureResponsesModel(model),
        messages: messages.map((message) => ({
          role: this.normalizeRole(message.role),
          content: message.content,
        })),
        maxOutputTokens: 400,
      });
      return this.parseIntentFromText(response.text || "");
    } catch (error) {
      console.error("[Intent] Fallback intent classification failed:", error);
      return { intent: "Chat" };
    }
  }

  async createReminderCompletion<T>(
    messages: Array<{ role: string; content: string }>,
    retryOptions?: RetryOptions,
  ): Promise<T> {
    return await this.createCompletionWithJsonResponse<T>(
      {
        messages,
        max_tokens: 1000,
      },
      retryOptions,
    );
  }

  /**
   * Creates a completion with tool/function calling support.
   * Returns the raw response for custom handling of tool calls.
   */
  async createCompletionWithTools(
    options: {
      model?: string;
      messages: Array<{ role: string; content: unknown } | Record<string, unknown>>;
      tools?: Array<{
        type: "function";
        function: {
          name: string;
          description?: string;
          parameters: Record<string, unknown>;
        };
      }>;
      tool_choice?:
        | "auto"
        | "none"
        | { type: "function"; function: { name: string } };
      max_tokens?: number;
      temperature?: number;
    },
    retryOptions?: RetryOptions,
  ): Promise<{
    output_text: string | null;
    output: Array<Record<string, unknown>>;
    status: string | undefined;
  }> {
    const model = options.model || AZURE_OPENAI_API_DEPLOYMENT_NAME || "";

    return withSpan<{
      output_text: string | null;
      output: Array<Record<string, unknown>>;
      status: string | undefined;
    }>(
      "openai.responses.create_completion_with_tools",
      {
        kind: SpanKind.CLIENT,
        attributes: {
          "llm.operation": "create_completion_with_tools",
          "llm.model": model,
          "llm.messages.count": options.messages.length,
          "llm.tools.count": options.tools?.length || 0,
        },
      },
      async (span) => {
        const metrics = getTelemetryMetrics();
        const finalRetryOptions = {
          ...this.defaultRetryOptions,
          ...retryOptions,
        };
        const { maxRetries, baseDelay, maxDelay } = finalRetryOptions;
        let lastError: unknown;

        metrics.externalCallsTotal.add(1, {
          "dependency.name": "azure_openai",
          "dependency.operation": "create_completion_with_tools",
          "llm.model": model,
        });

        for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
          const attemptStart = Date.now();
          addStoryEvent(span, "openai.attempt.start", {
            "openai.attempt.index": attempt + 1,
            "openai.attempt.max": maxRetries + 1,
          });

          try {
            const aiSdkTools = buildAiSdkTools(options.tools, options.tool_choice);
            const aiSdkMessages = convertLegacyResponsesInputToAiMessages(
              options.messages as Array<Record<string, unknown>>,
            );

            const response = await generateText({
              model: getAzureResponsesModel(model),
              messages: aiSdkMessages as any,
              tools: aiSdkTools as any,
              maxOutputTokens: options.max_tokens,
              ...this.temperatureOption(model, options.temperature),
            });

            const toolCalls = Array.isArray((response as any).toolCalls)
              ? ((response as any).toolCalls as Array<Record<string, unknown>>)
              : [];

            const output = toolCalls.map((toolCall) => {
              const toolCallId = String(toolCall.toolCallId || "");
              const toolName = String(toolCall.toolName || "");
              return {
                type: "function_call",
                id: toolCallId,
                call_id: toolCallId,
                name: toolName,
                arguments: JSON.stringify(toolCall.input || {}),
              };
            });

            const durationMs = Date.now() - attemptStart;
            metrics.externalCallDurationMs.record(durationMs, {
              "dependency.name": "azure_openai",
              "dependency.operation": "create_completion_with_tools",
              "dependency.outcome": "success",
              "llm.model": model,
            });

            addStoryEvent(span, "openai.attempt.success", {
              "openai.attempt.index": attempt + 1,
              "openai.attempt.duration_ms": durationMs,
              "openai.response.status": response.finishReason || "",
              "openai.response.has_output_text": !!response.text,
            });

            return {
              output_text: response.text || null,
              output,
              status: response.finishReason || undefined,
            };
          } catch (error: unknown) {
            lastError = error;
            const durationMs = Date.now() - attemptStart;
            metrics.externalCallDurationMs.record(durationMs, {
              "dependency.name": "azure_openai",
              "dependency.operation": "create_completion_with_tools",
              "dependency.outcome": "error",
              "llm.model": model,
            });

            addStoryEvent(span, "openai.attempt.failed", {
              "openai.attempt.index": attempt + 1,
              "openai.attempt.duration_ms": durationMs,
              "openai.error.message":
                error instanceof Error ? error.message : String(error),
            });

            if (attempt === maxRetries || !this.shouldRetry(error)) {
              break;
            }

            const delayMs = this.calculateDelay(attempt, baseDelay, maxDelay);
            metrics.retriesTotal.add(1, {
              "dependency.name": "azure_openai",
              "dependency.operation": "create_completion_with_tools",
              "llm.model": model,
            });
            addStoryEvent(span, "openai.retry.scheduled", {
              "openai.retry.delay_ms": delayMs,
              "openai.retry.attempt": attempt + 2,
            });
            await this.delay(delayMs);
          }
        }

        const finalError = new Error(
          `OpenAI request failed after ${maxRetries + 1} attempts. Last error: ${
            lastError instanceof Error ? lastError.message : String(lastError)
          }`,
        );
        metrics.errorsTotal.add(1, {
          "error.source": "openai.create_completion_with_tools",
          "llm.model": model,
        });
        recordSpanError(span, finalError, {
          "openai.attempts": maxRetries + 1,
        });
        throw finalError;
      },
    );
  }
}

export const openAIService = new OpenAIService();
export default openAIService;
