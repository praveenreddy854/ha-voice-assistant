/**
 * Custom Agent Loop Implementation
 * A simple, controllable agent loop using OpenAI chat completions
 * Replaces Azure AI Agents framework with a more flexible approach
 */

import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { AZURE_OPENAI_MODEL_ADVANCED } from "../../config";
import { openAIService } from "../../openai";

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
  type: "input_image";
  image_url: string;
}

export interface TextContent {
  type: "input_text";
  text: string;
}

export type MessageContent = string | null | Array<TextContent | ImageContent>;

export interface AgentMessage {
  id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: MessageContent;
  toolCalls?: AgentToolCall[];
  toolCallId?: string;
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
  | "error"
  | "awaiting_screenshot";

export interface AgentStepResult {
  type: AgentStepResultType;
  message?: string;
  toolCalls?: AgentToolCall[];
  error?: string;
  /** Tool call ID for the request_screenshot call when type is "awaiting_screenshot" */
  screenshotToolCallId?: string;
  /** Arguments passed to request_screenshot when type is "awaiting_screenshot" */
  screenshotArgs?: Record<string, unknown>;
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

export interface ScreenshotInput {
  imageBase64: string;
  imageContentType: string;
}

export interface CustomAgentLoop {
  createSession(
    userPrompt: string,
    messageHistory?: Array<{ role: string; content: string }>,
  ): AgentLoopSession;
  deleteSession(sessionId: string): void;
  runStep(
    sessionId: string,
    screenshot?: ScreenshotInput,
  ): Promise<AgentStepResult>;
  submitToolResults(
    sessionId: string,
    results: ToolExecutionResult[],
  ): Promise<AgentStepResult>;
  addMessage(
    sessionId: string,
    role: "user" | "assistant",
    content: string,
  ): AgentMessage | null;
  removeMessage(sessionId: string, messageId: string): boolean;
  removeLastNMessages(sessionId: string, count: number): number;
  getMessages(sessionId: string): AgentMessage[];
  clearMessages(sessionId: string, keepSystemMessage?: boolean): boolean;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Removes image content from a message, keeping only text.
 * If the message has array content with images, filters them out.
 * Simplifies back to string if only one text part remains.
 */
export function removeImagesFromMessage(msg: AgentMessage): void {
  if (Array.isArray(msg.content)) {
    // Filter out image content, keep only text
    const textParts = msg.content.filter(
      (part) => part.type === "input_text",
    ) as Array<TextContent>;

    // If only one text part remains, convert back to string
    if (textParts.length === 1) {
      msg.content = textParts[0].text;
    } else if (textParts.length === 0) {
      msg.content = null;
    } else {
      msg.content = textParts;
    }
  }
}

/**
 * Logs messages to a file organized by date and session ID.
 * Path: out/log/{YYYY-MM-DD}/{sessionId}/stepLog.log
 */
function logMessagesToFile(
  sessionId: string,
  stepNumber: number,
  messages: any[],
): void {
  try {
    const now = new Date();
    const dateStr = now.toISOString().split("T")[0]; // YYYY-MM-DD
    const timestamp = now.toISOString();

    // Create directory path: out/log/{date}/{sessionId}
    const logDir = path.join(process.cwd(), "out", "log", dateStr, sessionId);

    // Ensure directory exists
    fs.mkdirSync(logDir, { recursive: true });

    const logFilePath = path.join(logDir, "stepLog.log");

    // Format log entry
    const logEntry = {
      timestamp,
      sessionId,
      stepNumber,
      messagesCount: messages.length,
      messages,
    };

    const logLine = `\n${"-".repeat(80)}\n${JSON.stringify(
      logEntry,
      null,
      2,
    )}\n`;

    // Append to log file
    fs.appendFileSync(logFilePath, logLine, "utf-8");
  } catch (error) {
    console.error("[CustomAgentLoop] Failed to log messages to file:", error);
  }
}

// ============================================================================
// Agent Loop Implementation
// ============================================================================

// Internal tool for signaling task completion
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

export function createAgentLoop(config: AgentLoopConfig): CustomAgentLoop {
  const sessions = new Map<string, AgentLoopSession>();
  const model = config.model || AZURE_OPENAI_MODEL_ADVANCED;

  function createSession(
    userPrompt: string,
    messageHistory?: Array<{ role: string; content: string }>,
  ): AgentLoopSession {
    const sessionId = randomUUID();

    const messages: AgentMessage[] = [];

    // Add system message
    messages.push({
      id: randomUUID(),
      role: "system",
      content: config.systemPrompt,
      timestamp: new Date(),
    });

    // Add message history if provided - clearly mark it as historical context
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

    // Add the current user prompt
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

  async function runStep(
    sessionId: string,
    screenshot?: ScreenshotInput,
  ): Promise<AgentStepResult> {
    const session = sessions.get(sessionId);
    if (!session) {
      return { type: "error", error: `Session ${sessionId} not found` };
    }

    if (session.isComplete) {
      return {
        type: "complete",
        message: "Session already completed",
      };
    }

    if (session.currentIteration >= session.maxIterations) {
      session.isComplete = true;
      return {
        type: "error",
        error: `Max iterations (${session.maxIterations}) reached`,
      };
    }

    session.currentIteration++;

    let requestSummary: Array<Record<string, unknown>> = [];
    try {
      // Helper to normalize content for OpenAI format
      const normalizeContent = (
        content: MessageContent,
      ): string | Array<TextContent | ImageContent> => {
        if (content === null) return "";
        if (typeof content === "string") return content;
        return content;
      };

      // Convert messages to Responses API format
      // Responses API uses different format than Chat Completions:
      // - User/System messages: { role: "user"|"system", content: "..." }
      // - Assistant messages with tool calls: multiple { type: "function_call", call_id, name, arguments } items
      // - Tool results: { type: "function_call_output", call_id, output: "..." }
      const responsesApiMessages: any[] = [];

      for (const msg of session.messages) {
        if (msg.role === "tool") {
          // Tool result -> function_call_output
          const toolContent = Array.isArray(msg.content)
            ? JSON.stringify(msg.content)
            : typeof msg.content === "string"
              ? msg.content
              : JSON.stringify(msg.content || "");
          responsesApiMessages.push({
            type: "function_call_output",
            call_id: msg.toolCallId || "",
            output: toolContent,
          });
        } else if (
          msg.role === "assistant" &&
          msg.toolCalls &&
          msg.toolCalls.length > 0
        ) {
          // Assistant with tool calls -> function_call items
          for (const tc of msg.toolCalls) {
            responsesApiMessages.push({
              type: "function_call",
              call_id: tc.id,
              name: tc.function.name,
              arguments: tc.function.arguments,
            });
          }
        } else if (
          msg.role === "user" ||
          msg.role === "system" ||
          msg.role === "assistant"
        ) {
          // Regular messages
          responsesApiMessages.push({
            role: msg.role,
            content: normalizeContent(msg.content),
          });
        }
      }

      // If a screenshot is provided, add it as a user message with image content
      if (screenshot) {
        responsesApiMessages.push({
          role: "user",
          content: [
            { type: "input_text", text: "Current TV screen:" },
            {
              type: "input_image",
              image_url: `data:${screenshot.imageContentType};base64,${screenshot.imageBase64}`,
            },
          ],
        });
      }

      // Make chat completion request - include complete_task tool
      const allTools = [...session.tools, COMPLETE_TASK_TOOL];

      requestSummary = responsesApiMessages.map((msg, index) => {
        if (msg.role) {
          const contentTypes = Array.isArray(msg.content)
            ? msg.content.map((part: any) => part.type)
            : typeof msg.content;
          return {
            index,
            role: msg.role,
            contentTypes,
          };
        }
        if (msg.type) {
          return {
            index,
            type: msg.type,
            name: msg.name,
          };
        }
        return { index, type: "unknown" };
      });

      // Log responsesApiMessages before calling the API
      logMessagesToFile(
        sessionId,
        session.currentIteration,
        responsesApiMessages,
      );

      // Use the openAIService for the request
      const response = await openAIService.createCompletionWithTools({
        model: model || "gpt-4o",
        messages: responsesApiMessages,
        tools:
          allTools.length > 0
            ? allTools.map((t) => ({
                type: "function" as const,
                function: {
                  name: t.function.name,
                  description: t.function.description,
                  parameters: t.function.parameters,
                },
              }))
            : undefined,
        tool_choice: allTools.length > 0 ? "auto" : undefined,
      });

      // Parse the response - responses API returns output in different format
      const outputText = response.output_text;

      // Check if the response contains tool calls
      // The Responses API returns tool calls with type: "function_call" in the output array
      const responseOutput = response.output as any;

      // Handle tool calls if present in the response
      if (responseOutput && Array.isArray(responseOutput)) {
        // Look for function_call items in the output array (Responses API format)
        const functionCalls = responseOutput.filter(
          (item: any) => item.type === "function_call",
        );

        if (functionCalls.length > 0) {
          // Handle tool calls from Responses API format
          const toolCalls: AgentToolCall[] = functionCalls.map((tc: any) => ({
            id: tc.call_id || tc.id || randomUUID(),
            type: "function" as const,
            function: {
              name: tc.name,
              arguments: tc.arguments || JSON.stringify(tc.input || {}),
            },
          }));

          // Check if complete_task was called
          const completeTaskCall = toolCalls.find(
            (tc) => tc.function.name === "complete_task",
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

          // Check if request_screenshot was called - return immediately to client
          const screenshotCall = toolCalls.find(
            (tc) => tc.function.name === "request_screenshot",
          );

          if (screenshotCall) {
            // Add the assistant message with tool calls to the session
            session.messages.push({
              id: randomUUID(),
              role: "assistant",
              content: null,
              toolCalls,
              timestamp: new Date(),
            });

            session.lastToolCalls = toolCalls;

            let screenshotArgs: Record<string, unknown> = {};
            try {
              screenshotArgs = JSON.parse(screenshotCall.function.arguments);
            } catch {
              // Ignore parse errors for args
            }

            return {
              type: "awaiting_screenshot",
              message: "Screenshot requested - waiting for client to capture",
              screenshotToolCallId: screenshotCall.id,
              screenshotArgs,
              toolCalls,
            };
          }

          // Filter out complete_task from tool calls returned to caller
          const filteredToolCalls = toolCalls.filter(
            (tc) => tc.function.name !== "complete_task",
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
            return {
              type: "complete",
              message: outputText || "Task completed",
            };
          }

          return {
            type: "tool_calls",
            toolCalls: filteredToolCalls,
          };
        }

        // Fallback: Check for assistant message with tool_use content (alternative format)
        const assistantOutput = responseOutput.find(
          (item: any) => item.type === "message" && item.role === "assistant",
        );

        if (assistantOutput?.content) {
          const toolCallContent = assistantOutput.content.find(
            (c: any) => c.type === "tool_use",
          );

          if (toolCallContent) {
            // Handle tool calls from responses API format
            const toolCalls: AgentToolCall[] = assistantOutput.content
              .filter((c: any) => c.type === "tool_use")
              .map((tc: any) => ({
                id: tc.id || randomUUID(),
                type: "function" as const,
                function: {
                  name: tc.name,
                  arguments: JSON.stringify(tc.input || {}),
                },
              }));

            // Check if complete_task was called
            const completeTaskCall = toolCalls.find(
              (tc) => tc.function.name === "complete_task",
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

            // Check if request_screenshot was called - return immediately to client
            const screenshotCall = toolCalls.find(
              (tc) => tc.function.name === "request_screenshot",
            );

            if (screenshotCall) {
              session.messages.push({
                id: randomUUID(),
                role: "assistant",
                content: null,
                toolCalls,
                timestamp: new Date(),
              });

              session.lastToolCalls = toolCalls;

              let screenshotArgs: Record<string, unknown> = {};
              try {
                screenshotArgs = JSON.parse(screenshotCall.function.arguments);
              } catch {
                // Ignore parse errors for args
              }

              return {
                type: "awaiting_screenshot",
                message: "Screenshot requested - waiting for client to capture",
                screenshotToolCallId: screenshotCall.id,
                screenshotArgs,
                toolCalls,
              };
            }

            // Filter out complete_task from tool calls returned to caller
            const filteredToolCalls = toolCalls.filter(
              (tc) => tc.function.name !== "complete_task",
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
              return {
                type: "complete",
                message: outputText || "Task completed",
              };
            }

            return {
              type: "tool_calls",
              toolCalls: filteredToolCalls,
            };
          }
        }
      }

      // Check for function_call in legacy format (some Azure deployments)
      if (responseOutput?.function_call || responseOutput?.tool_calls) {
        const rawToolCalls = responseOutput.tool_calls || [
          {
            id: randomUUID(),
            type: "function",
            function: responseOutput.function_call,
          },
        ];

        const toolCalls: AgentToolCall[] = rawToolCalls.map((tc: any) => ({
          id: tc.id || randomUUID(),
          type: "function" as const,
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments,
          },
        }));

        // Check if complete_task was called
        const completeTaskCall = toolCalls.find(
          (tc) => tc.function.name === "complete_task",
        );

        if (completeTaskCall) {
          try {
            const args = JSON.parse(completeTaskCall.function.arguments);
            session.isComplete = true;

            session.messages.push({
              id: randomUUID(),
              role: "assistant",
              content: outputText,
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

        // Check if request_screenshot was called - return immediately to client
        const screenshotCall = toolCalls.find(
          (tc) => tc.function.name === "request_screenshot",
        );

        if (screenshotCall) {
          session.messages.push({
            id: randomUUID(),
            role: "assistant",
            content: outputText,
            toolCalls,
            timestamp: new Date(),
          });

          session.lastToolCalls = toolCalls;

          let screenshotArgs: Record<string, unknown> = {};
          try {
            screenshotArgs = JSON.parse(screenshotCall.function.arguments);
          } catch {
            // Ignore parse errors for args
          }

          return {
            type: "awaiting_screenshot",
            message: "Screenshot requested - waiting for client to capture",
            screenshotToolCallId: screenshotCall.id,
            screenshotArgs,
            toolCalls,
          };
        }

        // Filter out complete_task from tool calls returned to caller
        const filteredToolCalls = toolCalls.filter(
          (tc) => tc.function.name !== "complete_task",
        );

        session.messages.push({
          id: randomUUID(),
          role: "assistant",
          content: outputText,
          toolCalls,
          timestamp: new Date(),
        });

        session.lastToolCalls = filteredToolCalls;

        if (filteredToolCalls.length === 0) {
          session.isComplete = true;
          return {
            type: "complete",
            message: outputText || "Task completed",
          };
        }

        return {
          type: "tool_calls",
          toolCalls: filteredToolCalls,
        };
      }

      // Regular message response (no tool calls)
      const content = outputText || "";

      session.messages.push({
        id: randomUUID(),
        role: "assistant",
        content,
        timestamp: new Date(),
      });

      return {
        type: "message",
        message: content,
      };
    } catch (error) {
      console.error("[CustomAgentLoop] Error in runStep:", {
        error,
        requestSummary,
      });
      return {
        type: "error",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async function submitToolResults(
    sessionId: string,
    results: ToolExecutionResult[],
  ): Promise<AgentStepResult> {
    const session = sessions.get(sessionId);
    if (!session) {
      return { type: "error", error: `Session ${sessionId} not found` };
    }

    // Remove images from all previous messages to save tokens
    // Only keep the current image in the new tool result
    for (const msg of session.messages) {
      removeImagesFromMessage(msg);
    }

    // Add tool result messages
    for (const result of results) {
      let content: MessageContent = result.result;

      // If there's an image, create multipart content
      if (result.imageBase64 && result.imageContentType) {
        content = [
          { type: "input_text", text: result.result },
          {
            type: "input_image",
            image_url: `data:${result.imageContentType};base64,${result.imageBase64}`,
          },
        ];
      }

      session.messages.push({
        id: randomUUID(),
        role: "tool",
        content,
        toolCallId: result.toolCallId,
        timestamp: new Date(),
      });
    }

    // Continue the conversation
    return runStep(sessionId);
  }

  function addMessage(
    sessionId: string,
    role: "user" | "assistant",
    content: string,
  ): AgentMessage | null {
    const session = sessions.get(sessionId);
    if (!session) {
      return null;
    }

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
    if (!session) {
      return false;
    }

    const index = session.messages.findIndex((m) => m.id === messageId);
    if (index === -1) {
      return false;
    }

    // Don't allow removing system message
    if (session.messages[index].role === "system") {
      return false;
    }

    session.messages.splice(index, 1);
    return true;
  }

  function removeLastNMessages(sessionId: string, count: number): number {
    const session = sessions.get(sessionId);
    if (!session || count <= 0) {
      return 0;
    }

    // Find non-system messages from the end
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
    if (!session) {
      return [];
    }
    return [...session.messages];
  }

  function clearMessages(
    sessionId: string,
    keepSystemMessage: boolean = true,
  ): boolean {
    const session = sessions.get(sessionId);
    if (!session) {
      return false;
    }

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
