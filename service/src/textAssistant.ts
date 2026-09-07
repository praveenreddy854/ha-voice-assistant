import { z } from "zod";
import { AI_MODEL_ADVANCED, USER_ADDRESS } from "./config";
import {
  executeHomeAssistantCapability,
  executeScheduledTaskCapability,
  executeTvCapability,
} from "./assistantCapabilities";
import {
  classifyConfirmationAnswer,
  needsActionConfirmation,
} from "./assistantPolicy";
import {
  createAgentLoop,
  type ToolDefinition,
} from "./agents/core/agentLoop";
import { buildMemoryToolDefinitions } from "./agents/core/memoryTools";
import {
  AGENT_MEMORY_SYSTEM_INSTRUCTIONS,
  getPromptMemoryContext,
} from "./memory";
import { executeWebSearch } from "./webSearch";

export interface TextAssistantHistoryItem {
  role: "user" | "assistant";
  content: string;
}

export interface TextAssistantRunOptions {
  command: string;
  history: TextAssistantHistoryItem[];
  abortSignal: AbortSignal;
  requestInput(prompt: string, reason: string): Promise<string>;
}

export interface TextAssistantRunResult {
  success: boolean;
  message: string;
}

const textAssistantInstructions = `You are the Text Assistant for a Home Assistant voice assistant. You receive finalized text from an external voice channel and expose the same capabilities as the Realtime Voice Agent.

Capabilities:
- Answer General chat directly.
- Use execute_home_assistant_command for immediate smart-home commands and read-only device-state questions.
- Use run_scheduled_task_agent for ScheduledTask creation, listing, querying, updating, and cancellation.
- Use run_tv_agent for TV and streaming-app navigation, remote actions, app launch, search, typing, and playback.
- Use web_search when live or current information is needed.
- Use the memory tools for explicit remember, recall, correct, and forget requests.

Interaction policy:
- Select capabilities by meaning, not a fixed priority.
- Call ask_user when the request or a Specialist result needs clarification. The answer returned by the tool belongs only to that question.
- Protected opening and Bulk destructive confirmations are enforced inside execute_home_assistant_command. Never claim that an action ran when its tool says it was cancelled or failed.
- Do not narrate tools or internal Specialist steps.
- A routine successful command completes with exactly "Done." Questions and General chat receive a complete, understandable answer.
- Failures and user-action requests include the relevant detail and what the user needs to do.
- Always finish by calling complete_task with the exact message the user should hear.
- Always respond in English unless the user explicitly requests another language.
${USER_ADDRESS ? `- The user's address is ${USER_ADDRESS}. Use it for location-based requests.` : ""}

${AGENT_MEMORY_SYSTEM_INSTRUCTIONS}`;

function confirmationPrompt(command: string): string {
  return `Please confirm: should I ${command.replace(/[?.!]+$/g, "")}?`;
}

async function obtainConfirmation(
  command: string,
  requestInput: TextAssistantRunOptions["requestInput"]
): Promise<boolean> {
  let prompt = confirmationPrompt(command);
  for (let attempt = 0; attempt < 3; attempt++) {
    const answer = await requestInput(prompt, "action_confirmation");
    const decision = classifyConfirmationAnswer(answer);
    if (decision === "confirmed") return true;
    if (decision === "declined") return false;
    prompt = "Please answer yes to confirm or no to cancel.";
  }
  return false;
}

function buildTools(options: TextAssistantRunOptions): ToolDefinition[] {
  const commandSchema = z.object({
    command: z
      .string()
      .min(1)
      .describe("The complete plain-English smart-home command or state question."),
  });
  const promptSchema = z.object({
    prompt: z.string().min(1).describe("The user's complete request."),
  });
  const askSchema = z.object({
    prompt: z.string().min(1).describe("The short question to ask the user."),
    reason: z
      .string()
      .min(1)
      .describe("Why input is required, such as clarification or confirmation."),
  });
  const searchSchema = z.object({
    query: z.string().min(1).describe("The focused web search query."),
  });

  return [
    {
      type: "function",
      function: {
        name: "execute_home_assistant_command",
        description:
          "Execute an immediate Home Assistant command or read-only state question. Protected opening and bulk destructive confirmation is handled by this tool.",
        parameters: {},
        inputSchema: commandSchema,
      },
      execute: async (args) => {
        const { command } = commandSchema.parse(args);
        if (
          needsActionConfirmation(command) &&
          !(await obtainConfirmation(command, options.requestInput))
        ) {
          return {
            success: false,
            cancelled: true,
            message: "The action was cancelled because it was not confirmed.",
          };
        }
        return executeHomeAssistantCapability(command, {
          abortSignal: options.abortSignal,
        });
      },
    },
    {
      type: "function",
      function: {
        name: "run_scheduled_task_agent",
        description:
          "Run the ScheduledTaskAgent for creation, listing, querying, updating, or cancellation.",
        parameters: {},
        inputSchema: promptSchema,
      },
      execute: async (args) => {
        const { prompt } = promptSchema.parse(args);
        return executeScheduledTaskCapability(prompt, {
          abortSignal: options.abortSignal,
        });
      },
    },
    {
      type: "function",
      function: {
        name: "run_tv_agent",
        description:
          "Run TVAgent for TV or streaming-app navigation, remote actions, search, typing, app launch, or playback.",
        parameters: {},
        inputSchema: promptSchema,
      },
      execute: async (args) => {
        const { prompt } = promptSchema.parse(args);
        return executeTvCapability(prompt, {
          abortSignal: options.abortSignal,
        });
      },
    },
    {
      type: "function",
      function: {
        name: "ask_user",
        description:
          "Ask one clarification question and wait for the answer inside the current Shortcut voice turn.",
        parameters: {},
        inputSchema: askSchema,
      },
      execute: async (args) => {
        const { prompt, reason } = askSchema.parse(args);
        const answer = await options.requestInput(prompt, reason);
        return { answer };
      },
    },
    {
      type: "function",
      function: {
        name: "web_search",
        description: "Search the web for current or live information.",
        parameters: {},
        inputSchema: searchSchema,
      },
      execute: async (args) => {
        const { query } = searchSchema.parse(args);
        return { result: await executeWebSearch(query) };
      },
    },
    ...buildMemoryToolDefinitions("text_assistant"),
  ];
}

export async function runTextAssistant(
  options: TextAssistantRunOptions
): Promise<TextAssistantRunResult> {
  const memoryContext = await getPromptMemoryContext({
    query: options.command,
    agentType: "text_assistant",
  });
  options.abortSignal.throwIfAborted();

  const loop = createAgentLoop({
    systemPrompt: textAssistantInstructions,
    tools: buildTools(options),
    maxIterations: 16,
    model: AI_MODEL_ADVANCED,
  });
  const session = loop.createSession(
    options.command,
    options.history,
    memoryContext ? [memoryContext] : []
  );

  try {
    const result = await loop.run(session.id, options.abortSignal);
    if (result.type === "complete") {
      return {
        success: result.success !== false,
        message: result.message || "Done.",
      };
    }
    if (result.type === "tool_calls") {
      return {
        success: false,
        message: `The Text Assistant stopped on an unsupported tool: ${
          result.toolCalls?.[0]?.function.name || "unknown"
        }.`,
      };
    }
    return {
      success: false,
      message: result.error || "The Text Assistant failed.",
    };
  } finally {
    loop.deleteSession(session.id);
  }
}
