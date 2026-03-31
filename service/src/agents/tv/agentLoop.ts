/**
 * Agent Loop — session-based tool-calling loop using AI SDK
 *
 * Key design choices:
 * - External tool execution: tools have no `execute` fn; the caller handles execution
 * - Session-based: multiple concurrent sessions share one loop instance
 * - Image management: old images are stripped on each tool result to save tokens
 * - Completion signal: built-in `complete_task` tool lets the model end the loop
 */

import { randomUUID } from "crypto";
import { generateText, tool, jsonSchema } from "ai";
import { AI_MODEL_ADVANCED } from "../../config";
import { azureProvider } from "../../ai";

// ============================================================================
// Types
// ============================================================================

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export interface AgentToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ImageContent {
  type: "image_url";
  image_url: {
    url: string;
    detail?: "low" | "high" | "auto";
  };
}

export interface TextContent {
  type: "text";
  text: string;
}

export type MessageContent = string | null | Array<TextContent | ImageContent>;

export interface AgentMessage {
  id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: MessageContent;
  toolCalls?: AgentToolCall[];
  toolCallId?: string;
  toolName?: string;
  timestamp: Date;
}

export interface ToolExecutionResult {
  toolCallId: string;
  result: string;
  imageBase64?: string;
  imageContentType?: string;
}

export type AgentStepResultType =
  | "tool_calls"
  | "message"
  | "complete"
  | "error";

export interface AgentStepResult {
  type: AgentStepResultType;
  message?: string;
  toolCalls?: AgentToolCall[];
  error?: string;
}

export interface AgentLoopSession {
  id: string;
  messages: AgentMessage[];
  systemPrompt: string;
  tools: ToolDefinition[];
  maxIterations: number;
  currentIteration: number;
  isComplete: boolean;
  lastToolCalls?: AgentToolCall[];
}

export interface AgentLoopConfig {
  systemPrompt: string;
  tools: ToolDefinition[];
  maxIterations?: number;
  model?: string;
}

export interface AgentLoop {
  createSession(
    userPrompt: string,
    messageHistory?: Array<{ role: string; content: string }>
  ): AgentLoopSession;
  deleteSession(sessionId: string): void;
  runStep(sessionId: string): Promise<AgentStepResult>;
  submitToolResults(
    sessionId: string,
    results: ToolExecutionResult[]
  ): Promise<AgentStepResult>;
  addMessage(
    sessionId: string,
    role: "user" | "assistant",
    content: string
  ): AgentMessage | null;
  removeMessage(sessionId: string, messageId: string): boolean;
  removeLastNMessages(sessionId: string, count: number): number;
  getMessages(sessionId: string): AgentMessage[];
  clearMessages(sessionId: string, keepSystemMessage?: boolean): boolean;
}

// Keep backward-compat alias
export type CustomAgentLoop = AgentLoop;

// ============================================================================
// Message Conversion
// ============================================================================

/** Strip image content from a message, keeping only text. */
export function removeImagesFromMessage(msg: AgentMessage): void {
  if (!Array.isArray(msg.content)) return;

  const textParts = msg.content.filter(
    (part) => part.type === "text"
  ) as TextContent[];

  if (textParts.length === 1) {
    msg.content = textParts[0].text;
  } else if (textParts.length === 0) {
    msg.content = null;
  } else {
    msg.content = textParts;
  }
}

/** Convert internal AgentMessage[] to AI SDK CoreMessage[] format. */
function convertToCoreMessages(messages: AgentMessage[]): any[] {
  const coreMessages: any[] = [];

  for (const msg of messages) {
    switch (msg.role) {
      case "system":
        coreMessages.push({ role: "system", content: msg.content ?? "" });
        break;

      case "user":
        if (typeof msg.content === "string" || msg.content === null) {
          coreMessages.push({ role: "user", content: msg.content ?? "" });
        } else {
          coreMessages.push({
            role: "user",
            content: msg.content.map((part) => {
              if (part.type === "text") {
                return { type: "text" as const, text: part.text };
              }
              const match = part.image_url.url.match(
                /^data:([^;]+);base64,(.+)$/
              );
              if (match) {
                return {
                  type: "image" as const,
                  image: match[2],
                  mediaType: match[1],
                };
              }
              return {
                type: "image" as const,
                image: new URL(part.image_url.url),
              };
            }),
          });
        }
        break;

      case "assistant":
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          coreMessages.push({
            role: "assistant",
            content: msg.toolCalls.map((tc) => ({
              type: "tool-call" as const,
              toolCallId: tc.id,
              toolName: tc.function.name,
              input: JSON.parse(tc.function.arguments),
            })),
          });
        } else {
          coreMessages.push({
            role: "assistant",
            content: msg.content ?? "",
          });
        }
        break;

      case "tool": {
        let toolResult: string;
        const experimentalContent: any[] = [];

        if (Array.isArray(msg.content)) {
          const textParts = msg.content.filter(
            (p) => p.type === "text"
          ) as TextContent[];
          const imageParts = msg.content.filter(
            (p) => p.type === "image_url"
          ) as ImageContent[];
          toolResult = textParts.map((p) => p.text).join("\n");
          for (const img of imageParts) {
            const match = img.image_url.url.match(
              /^data:([^;]+);base64,(.+)$/
            );
            if (match) {
              experimentalContent.push({
                type: "image",
                image: match[2],
                mediaType: match[1],
              });
            }
          }
        } else {
          toolResult = (msg.content as string) ?? "";
        }

        const toolResultPart: any = {
          type: "tool-result",
          toolCallId: msg.toolCallId ?? "",
          toolName: msg.toolName ?? "unknown",
          output: { type: "text", value: toolResult },
        };
        if (experimentalContent.length > 0) {
          toolResultPart.experimental_content = experimentalContent;
        }

        coreMessages.push({ role: "tool", content: [toolResultPart] });
        break;
      }
    }
  }

  return coreMessages;
}

/** Build an AI SDK tools map from ToolDefinition[], including the complete_task tool. */
function buildToolsMap(tools: ToolDefinition[]): Record<string, any> {
  const allTools = [...tools, COMPLETE_TASK_TOOL];
  const map: Record<string, any> = {};
  for (const def of allTools) {
    map[def.function.name] = tool({
      description: def.function.description ?? "",
      inputSchema: jsonSchema(def.function.parameters as any),
    });
  }
  return map;
}

// ============================================================================
// Complete Task Tool
// ============================================================================

const COMPLETE_TASK_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "complete_task",
    description:
      "Call this tool when you have successfully completed the user's request. Provide a summary of what was accomplished.",
    parameters: {
      type: "object",
      properties: {
        success: {
          type: "boolean",
          description: "Whether the task was completed successfully.",
        },
        message: {
          type: "string",
          description:
            "A brief summary of what was accomplished or why the task could not be completed.",
        },
      },
      required: ["success", "message"],
    },
  },
};

// ============================================================================
// Agent Loop Implementation
// ============================================================================

export function createAgentLoop(config: AgentLoopConfig): AgentLoop {
  const sessions = new Map<string, AgentLoopSession>();
  const model = config.model || AI_MODEL_ADVANCED;

  function createSession(
    userPrompt: string,
    messageHistory?: Array<{ role: string; content: string }>
  ): AgentLoopSession {
    const sessionId = randomUUID();
    const messages: AgentMessage[] = [];

    messages.push({
      id: randomUUID(),
      role: "system",
      content: config.systemPrompt,
      timestamp: new Date(),
    });

    if (messageHistory && messageHistory.length > 0) {
      messages.push({
        id: randomUUID(),
        role: "user",
        content:
          "The following is the conversation history from our previous interactions:",
        timestamp: new Date(),
      });

      for (const msg of messageHistory) {
        const prefix = msg.role === "user" ? "[User]:" : "[Assistant]:";
        messages.push({
          id: randomUUID(),
          role: "assistant",
          content: `${prefix} ${msg.content}`,
          timestamp: new Date(),
        });
      }

      messages.push({
        id: randomUUID(),
        role: "assistant",
        content:
          "I understand the conversation history above. I'll continue from where we left off.",
        timestamp: new Date(),
      });
    }

    messages.push({
      id: randomUUID(),
      role: "user",
      content: userPrompt,
      timestamp: new Date(),
    });

    const session: AgentLoopSession = {
      id: sessionId,
      messages,
      systemPrompt: config.systemPrompt,
      tools: config.tools,
      maxIterations: config.maxIterations || 20,
      currentIteration: 0,
      isComplete: false,
    };

    sessions.set(sessionId, session);
    return session;
  }

  function deleteSession(sessionId: string): void {
    sessions.delete(sessionId);
  }

  async function runStep(sessionId: string): Promise<AgentStepResult> {
    const session = sessions.get(sessionId);
    if (!session) {
      return { type: "error", error: `Session ${sessionId} not found` };
    }

    if (session.isComplete) {
      return { type: "complete", message: "Session already completed" };
    }

    if (session.currentIteration >= session.maxIterations) {
      session.isComplete = true;
      return {
        type: "error",
        error: `Max iterations (${session.maxIterations}) reached`,
      };
    }

    session.currentIteration++;

    try {
      const coreMessages = convertToCoreMessages(session.messages);
      const aiSdkTools = buildToolsMap(session.tools);

      const result = await generateText({
        model: azureProvider(model ?? ""),
        messages: coreMessages,
        tools: aiSdkTools,
      });

      const outputText = result.text || null;
      const sdkToolCalls = result.toolCalls ?? [];

      if (sdkToolCalls.length > 0) {
        const toolCalls: AgentToolCall[] = sdkToolCalls.map((tc) => ({
          id: tc.toolCallId,
          type: "function" as const,
          function: {
            name: tc.toolName,
            arguments: JSON.stringify(tc.input),
          },
        }));

        // Check for completion signal
        const completeTaskCall = toolCalls.find(
          (tc) => tc.function.name === "complete_task"
        );

        if (completeTaskCall) {
          try {
            const args = JSON.parse(completeTaskCall.function.arguments);
            session.isComplete = true;
            session.messages.push({
              id: randomUUID(),
              role: "assistant",
              content: null,
              toolCalls,
              timestamp: new Date(),
            });
            return {
              type: "complete",
              message: args.message || "Task completed",
            };
          } catch {
            return {
              type: "error",
              error: "Failed to parse complete_task arguments",
            };
          }
        }

        const filteredToolCalls = toolCalls.filter(
          (tc) => tc.function.name !== "complete_task"
        );

        session.messages.push({
          id: randomUUID(),
          role: "assistant",
          content: null,
          toolCalls,
          timestamp: new Date(),
        });

        session.lastToolCalls = filteredToolCalls;

        if (filteredToolCalls.length === 0) {
          session.isComplete = true;
          return { type: "complete", message: outputText || "Task completed" };
        }

        return { type: "tool_calls", toolCalls: filteredToolCalls };
      }

      // Regular message (no tool calls)
      const content = outputText || "";
      session.messages.push({
        id: randomUUID(),
        role: "assistant",
        content,
        timestamp: new Date(),
      });

      return { type: "message", message: content };
    } catch (error) {
      console.error("[AgentLoop] Error in runStep:", error);
      return {
        type: "error",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async function submitToolResults(
    sessionId: string,
    results: ToolExecutionResult[]
  ): Promise<AgentStepResult> {
    const session = sessions.get(sessionId);
    if (!session) {
      return { type: "error", error: `Session ${sessionId} not found` };
    }

    // Strip images from previous messages to save tokens
    for (const msg of session.messages) {
      removeImagesFromMessage(msg);
    }

    for (const result of results) {
      let content: MessageContent = result.result;

      if (result.imageBase64 && result.imageContentType) {
        content = [
          { type: "text", text: result.result },
          {
            type: "image_url",
            image_url: {
              url: `data:${result.imageContentType};base64,${result.imageBase64}`,
              detail: "high",
            },
          },
        ];
      }

      const toolName = session.lastToolCalls?.find(
        (tc) => tc.id === result.toolCallId
      )?.function.name;

      session.messages.push({
        id: randomUUID(),
        role: "tool",
        content,
        toolCallId: result.toolCallId,
        toolName,
        timestamp: new Date(),
      });
    }

    return runStep(sessionId);
  }

  function addMessage(
    sessionId: string,
    role: "user" | "assistant",
    content: string
  ): AgentMessage | null {
    const session = sessions.get(sessionId);
    if (!session) return null;

    const message: AgentMessage = {
      id: randomUUID(),
      role,
      content,
      timestamp: new Date(),
    };

    session.messages.push(message);
    return message;
  }

  function removeMessage(sessionId: string, messageId: string): boolean {
    const session = sessions.get(sessionId);
    if (!session) return false;

    const index = session.messages.findIndex((m) => m.id === messageId);
    if (index === -1 || session.messages[index].role === "system") return false;

    session.messages.splice(index, 1);
    return true;
  }

  function removeLastNMessages(sessionId: string, count: number): number {
    const session = sessions.get(sessionId);
    if (!session || count <= 0) return 0;

    let removed = 0;
    for (let i = session.messages.length - 1; i >= 0 && removed < count; i--) {
      if (session.messages[i].role !== "system") {
        session.messages.splice(i, 1);
        removed++;
      }
    }
    return removed;
  }

  function getMessages(sessionId: string): AgentMessage[] {
    const session = sessions.get(sessionId);
    return session ? [...session.messages] : [];
  }

  function clearMessages(
    sessionId: string,
    keepSystemMessage: boolean = true
  ): boolean {
    const session = sessions.get(sessionId);
    if (!session) return false;

    if (keepSystemMessage) {
      const systemMessage = session.messages.find((m) => m.role === "system");
      session.messages = systemMessage ? [systemMessage] : [];
    } else {
      session.messages = [];
    }

    session.currentIteration = 0;
    session.isComplete = false;
    session.lastToolCalls = undefined;
    return true;
  }

  return {
    createSession,
    deleteSession,
    runStep,
    submitToolResults,
    addMessage,
    removeMessage,
    removeLastNMessages,
    getMessages,
    clearMessages,
  };
}
