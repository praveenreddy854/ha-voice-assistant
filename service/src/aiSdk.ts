import { createAzure } from "@ai-sdk/azure";
import { jsonSchema, tool } from "ai";
import {
  API_KEY,
  OPEN_AI_BASE_URL,
  OPENAI_RESPONSES_API_VERSION,
} from "./config";

export type LegacyFunctionToolDefinition = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
};

export type LegacyToolChoice =
  | "auto"
  | "none"
  | { type: "function"; function: { name: string } };

type AzureProvider = ReturnType<typeof createAzure>;

const DEFAULT_API_VERSION = "preview";
let azureProvider: AzureProvider | null = null;

export function isAzureAiSdkConfigured(): boolean {
  return Boolean(OPEN_AI_BASE_URL && API_KEY);
}

function extractResourceName(baseUrl: string): string | null {
  try {
    const parsed = new URL(baseUrl);
    const hostnameMatch = parsed.hostname.match(/^([^.]+)\.openai\.azure\.com$/i);
    return hostnameMatch?.[1] ?? null;
  } catch {
    return null;
  }
}

function normalizeAzureBaseUrl(baseUrl: string): string {
  try {
    const parsed = new URL(baseUrl);
    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");

    if (parsed.pathname.endsWith("/openai/v1")) {
      parsed.pathname = parsed.pathname.slice(0, -3);
    } else if (parsed.pathname.length === 0 || parsed.pathname === "/") {
      parsed.pathname = "/openai";
    }

    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return baseUrl.replace(/\/+$/, "");
  }
}

function createAzureProvider(): AzureProvider {
  if (!isAzureAiSdkConfigured()) {
    throw new Error("Azure AI SDK configuration missing required values");
  }

  const apiVersion = OPENAI_RESPONSES_API_VERSION || DEFAULT_API_VERSION;
  const resourceName = extractResourceName(OPEN_AI_BASE_URL!);

  if (resourceName) {
    return createAzure({
      resourceName,
      apiKey: API_KEY!,
      apiVersion,
    });
  }

  return createAzure({
    baseURL: normalizeAzureBaseUrl(OPEN_AI_BASE_URL!),
    apiKey: API_KEY!,
    apiVersion,
    useDeploymentBasedUrls: false,
  });
}

export function getAzureProvider(): AzureProvider {
  if (!azureProvider) {
    azureProvider = createAzureProvider();
  }
  return azureProvider;
}

export function getAzureResponsesModel(model: string) {
  return getAzureProvider().responses(model);
}

export function getAzureEmbeddingModel(model: string) {
  return getAzureProvider().textEmbeddingModel(model);
}

function normalizeToolParameters(
  parameters: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!parameters || typeof parameters !== "object") {
    return { type: "object", properties: {} };
  }

  if ("type" in parameters) {
    return parameters;
  }

  return {
    ...parameters,
    type: "object",
  };
}

export function buildAiSdkTools(
  tools: LegacyFunctionToolDefinition[] | undefined,
  toolChoice: LegacyToolChoice | undefined,
): Record<string, unknown> | undefined {
  if (!tools?.length || toolChoice === "none") {
    return undefined;
  }

  let selectedTools = tools;
  if (toolChoice && typeof toolChoice === "object") {
    selectedTools = tools.filter(
      (candidate) => candidate.function.name === toolChoice.function.name,
    );
  }

  if (!selectedTools.length) {
    return undefined;
  }

  const toolSet: Record<string, unknown> = {};
  for (const candidate of selectedTools) {
    toolSet[candidate.function.name] = tool({
      description: candidate.function.description,
      inputSchema: jsonSchema(
        normalizeToolParameters(candidate.function.parameters),
      ),
    });
  }

  return toolSet;
}

function normalizeRole(role: string): "system" | "user" | "assistant" {
  if (role === "system" || role === "assistant" || role === "user") {
    return role;
  }
  return "user";
}

function toAiSdkContentPart(part: unknown): Record<string, unknown> {
  if (!part || typeof part !== "object") {
    return { type: "text", text: String(part ?? "") };
  }

  const candidate = part as Record<string, unknown>;
  const type = String(candidate.type || "");

  if (type === "input_text" || type === "text") {
    return { type: "text", text: String(candidate.text ?? "") };
  }

  if (type === "input_image") {
    return { type: "image", image: String(candidate.image_url ?? "") };
  }

  if (type === "image_url") {
    const imageUrl = candidate.image_url;
    if (typeof imageUrl === "string") {
      return { type: "image", image: imageUrl };
    }
    if (imageUrl && typeof imageUrl === "object") {
      return {
        type: "image",
        image: String((imageUrl as { url?: string }).url ?? ""),
      };
    }
  }

  if (type === "image") {
    return { type: "image", image: String(candidate.image ?? "") };
  }

  return { type: "text", text: JSON.stringify(candidate) };
}

function parseJsonIfPossible(raw: unknown): unknown {
  if (typeof raw !== "string") {
    return raw;
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return raw;
  }
}

function parseToolInput(raw: unknown): Record<string, unknown> {
  const parsed = parseJsonIfPossible(raw);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return {};
}

export function convertLegacyResponsesInputToAiMessages(
  messages: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const aiMessages: Array<Record<string, unknown>> = [];
  const toolNameByCallId = new Map<string, string>();

  for (const message of messages) {
    if (!message) {
      continue;
    }

    const messageType = message.type;
    if (messageType === "function_call") {
      const toolCallId = String(message.call_id || message.id || "");
      const toolName = String(message.name || "");

      if (!toolCallId || !toolName) {
        continue;
      }

      toolNameByCallId.set(toolCallId, toolName);
      aiMessages.push({
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId,
            toolName,
            input: parseToolInput(message.arguments),
          },
        ],
      });
      continue;
    }

    if (messageType === "function_call_output") {
      const toolCallId = String(message.call_id || "");
      if (!toolCallId) {
        continue;
      }

      const toolName = toolNameByCallId.get(toolCallId) || "tool";
      aiMessages.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId,
            toolName,
            output: parseJsonIfPossible(message.output),
          },
        ],
      });
      continue;
    }

    const role = message.role;
    if (typeof role !== "string") {
      continue;
    }

    const normalizedRole = normalizeRole(role);
    const content = message.content;

    if (typeof content === "string") {
      aiMessages.push({ role: normalizedRole, content });
      continue;
    }

    if (Array.isArray(content)) {
      aiMessages.push({
        role: normalizedRole,
        content: content.map((part) => toAiSdkContentPart(part)),
      });
      continue;
    }

    if (content === null || content === undefined) {
      aiMessages.push({ role: normalizedRole, content: "" });
      continue;
    }

    aiMessages.push({
      role: normalizedRole,
      content: JSON.stringify(content),
    });
  }

  return aiMessages;
}

export function extractJsonObjectFromText(text: string): string {
  const withoutCodeFences = text
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();

  const objectMatch = withoutCodeFences.match(/\{[\s\S]*\}/);
  return objectMatch ? objectMatch[0] : withoutCodeFences;
}
