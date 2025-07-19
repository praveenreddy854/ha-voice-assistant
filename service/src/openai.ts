import { AzureOpenAI } from "openai";
import {
  API_KEY,
  OPEN_AI_BASE_URL,
  OPENAI_RESPONSES_API_VERSION,
  AZURE_OPENAI_API_DEPLOYMENT_NAME,
  HA_COMMAND_PROCESS_MODEL,
} from "./config";
import { IntentClassificationResponse, IntentErrorResponse } from "./intent";

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

class OpenAIService {
  private client: AzureOpenAI;
  private defaultRetryOptions: Required<RetryOptions> = {
    maxRetries: 2,
    baseDelay: 500,
    maxDelay: 5000,
  };

  constructor() {
    if (!OPEN_AI_BASE_URL || !API_KEY) {
      throw new Error("OpenAI configuration missing required values");
    }

    this.client = new AzureOpenAI({
      baseURL: OPEN_AI_BASE_URL,
      apiKey: API_KEY,
      apiVersion: OPENAI_RESPONSES_API_VERSION,
    });
  }

  private async delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private calculateDelay(
    attempt: number,
    baseDelay: number,
    maxDelay: number
  ): number {
    const exponentialDelay = baseDelay * Math.pow(2, attempt);
    const jitter = Math.random() * 0.1 * exponentialDelay;
    return Math.min(exponentialDelay + jitter, maxDelay);
  }

  private shouldRetry(error: any): boolean {
    if (!error) return false;

    if (error.status) {
      return (
        error.status === 429 ||
        error.status === 500 ||
        error.status === 502 ||
        error.status === 503 ||
        error.status === 504
      );
    }

    return (
      error.code === "ECONNRESET" ||
      error.code === "ETIMEDOUT" ||
      error.message?.includes("timeout") ||
      error.message?.includes("network")
    );
  }

  async createCompletion<T>(
    options: OpenAIRequestOptions,
    retryOptions?: RetryOptions
  ): Promise<T> {
    const finalRetryOptions = { ...this.defaultRetryOptions, ...retryOptions };
    const { maxRetries, baseDelay, maxDelay } = finalRetryOptions;

    let lastError: any;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const model = options.model || AZURE_OPENAI_API_DEPLOYMENT_NAME;

        let response = await this.client.responses.create({
          model,
          input: JSON.stringify({
            messages: options.messages,
            max_tokens: options.max_tokens || 1000,
            temperature: options.temperature || 0.5,
          }),
        });

        while (
          response.status === "queued" ||
          response.status === "in_progress"
        ) {
          console.log(`OpenAI request status: ${response.status}`);
          await this.delay(50);
          response = await this.client.responses.retrieve(response.id);
        }

        if (response.status === "failed") {
          throw new Error(
            `OpenAI request failed: ${response.error || "Unknown error"}`
          );
        }

        if (response.output_text) {
          try {
            return JSON.parse(response.output_text) as T;
          } catch (parseError) {
            console.error("Failed to parse JSON response:", parseError);
            console.error("Response text:", response.output_text);
            throw new Error("Invalid JSON response format from OpenAI");
          }
        } else {
          throw new Error("No output_text in OpenAI response");
        }
      } catch (error: any) {
        lastError = error;
        console.error(
          `OpenAI request attempt ${attempt + 1} failed:`,
          error.message
        );

        if (attempt === maxRetries || !this.shouldRetry(error)) {
          break;
        }

        const delayMs = this.calculateDelay(attempt, baseDelay, maxDelay);
        console.log(`Retrying OpenAI request in ${delayMs}ms...`);
        await this.delay(delayMs);
      }
    }

    throw new Error(
      `OpenAI request failed after ${maxRetries + 1} attempts. Last error: ${
        lastError?.message || "Unknown error"
      }`
    );
  }

  async createCompletionWithJsonResponse<T>(
    options: OpenAIRequestOptions,
    retryOptions?: RetryOptions
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
    prompt: string,
    retryOptions?: RetryOptions
  ): Promise<string> {
    const finalRetryOptions = { ...this.defaultRetryOptions, ...retryOptions };
    const { maxRetries, baseDelay, maxDelay } = finalRetryOptions;

    let lastError: any;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        let response = await this.client.responses.create({
          model: HA_COMMAND_PROCESS_MODEL,
          input: JSON.stringify({
            messages: [{ role: "user", content: prompt }],
            max_tokens: 1000,
            temperature: 0.5,
          }),
        });

        while (
          response.status === "queued" ||
          response.status === "in_progress"
        ) {
          console.log(`OpenAI request status: ${response.status}`);
          await this.delay(50);
          response = await this.client.responses.retrieve(response.id);
        }

        if (response.status === "failed") {
          throw new Error(
            `OpenAI request failed: ${response.error || "Unknown error"}`
          );
        }

        return response.output_text || "";
      } catch (error: any) {
        lastError = error;
        console.error(
          `OpenAI request attempt ${attempt + 1} failed:`,
          error.message
        );

        if (attempt === maxRetries || !this.shouldRetry(error)) {
          break;
        }

        const delayMs = this.calculateDelay(attempt, baseDelay, maxDelay);
        console.log(`Retrying OpenAI request in ${delayMs}ms...`);
        await this.delay(delayMs);
      }
    }

    throw new Error(
      `OpenAI request failed after ${maxRetries + 1} attempts. Last error: ${
        lastError?.message || "Unknown error"
      }`
    );
  }

  async createIntentClassification(
    prompt: string,
    retryOptions?: RetryOptions
  ): Promise<IntentClassificationResponse | IntentErrorResponse> {
    return await this.createCompletion<
      IntentClassificationResponse | IntentErrorResponse
    >(
      {
        messages: [{ role: "user", content: prompt }],
        max_tokens: 1000,
        temperature: 0.5,
      },
      retryOptions
    );
  }

  async createReminderCompletion<T>(
    prompt: string,
    retryOptions?: RetryOptions
  ): Promise<T> {
    return await this.createCompletionWithJsonResponse<T>(
      {
        messages: [{ role: "user", content: prompt }],
        max_tokens: 1000,
        temperature: 0.5,
      },
      retryOptions
    );
  }
}

export const openAIService = new OpenAIService();
export default openAIService;
