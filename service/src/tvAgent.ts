import axios from "axios";
import { AzureKeyCredential } from "@azure/core-auth";
import { randomUUID } from "crypto";
import {
  AZURE_AI_AGENT_ENDPOINT,
  AZURE_AI_AGENT_KEY,
  AZURE_AI_AGENT_MODEL,
  HOME_ASSISTANT_TOKEN,
  HOME_ASSISTANT_URL,
  TV_DEFAULT_WAIT_MS,
  TV_REMOTE_ENTITY_ID,
} from "./config";

// The Azure Agents SDK does not currently publish ESM typings, so we rely on a loose type.
type AgentsClientType = any; // eslint-disable-line @typescript-eslint/no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AgentSessionsClientType = any;

export type PerformActionType =
  | "press"
  | "scroll"
  | "type"
  | "wait"
  | "home"
  | "back";

export interface PerformActionArguments {
  actionType: PerformActionType;
  button?: string;
  direction?: "up" | "down" | "left" | "right";
  count?: number;
  text?: string;
  holdMs?: number;
  waitMs?: number;
  reason: string;
}

export interface TvAgentStep {
  index: number;
  actionSummary: string;
  reasoning: string;
  observation: string;
  toolArguments: PerformActionArguments;
  screenshotDataUrl?: string;
  screenshotBase64?: string;
  screenshotContentType?: string;
  screenshotError?: string;
}

export type TvAgenticFlowStatus =
  | "awaiting_screenshot"
  | "running"
  | "completed"
  | "error";

export interface TvAgenticFlowResult {
  success: boolean;
  message: string;
  steps: TvAgentStep[];
  finalCommand?: string;
  sessionId: string;
  status: TvAgenticFlowStatus;
  pendingStep?: TvAgentStep;
  screenshotRequest?: {
    prompt: string;
    reason: string;
    stepIndex: number;
  };
}

export interface RunTvAgenticFlowOptions {
  userPrompt?: string;
  sessionId?: string;
  maxSteps?: number;
  messageHistory?: Array<{ role: string; content: string }>;
  screenshotDataUrl?: string;
  screenshotBase64?: string;
  screenshotContentType?: string;
  screenshotError?: string;
}

interface PendingScreenshotState {
  toolCallId: string;
  args: PerformActionArguments;
  stepIndex: number;
  observation: string;
}

interface TvAgentSessionState {
  id: string;
  azureSessionId: string;
  steps: TvAgentStep[];
  pendingScreenshot?: PendingScreenshotState;
  completed: boolean;
  finalCommand?: string;
  iterations: number;
  maxSteps: number;
  userPrompt: string;
  additionalInstructions?: string;
  closed: boolean;
}

interface ScreenshotPayload {
  base64?: string;
  contentType?: string;
  dataUrl?: string;
  error?: string;
}

const sessionStore = new Map<string, TvAgentSessionState>();

const agentInstructions = `You are a home-theater automation agent that controls a TV by calling the perform_action tool. The tool sends remote control commands through Home Assistant. After each action, wait for the client to capture a fresh camera screenshot of the TV and include the base64 image in the tool output before continuing. If the client reports a capture error, gracefully recover by retrying or selecting a different strategy. Prefer batching scrolls with the count argument instead of repeating single scroll actions. Only finish when the user's goal is satisfied. When done, respond with {"status":"done","final_command":"<summary>"}.`;

const performActionToolDefinition = {
  name: "perform_action",
  description:
    "Send remote control commands to the TV via Home Assistant. After each action, wait for the caller to provide a camera screenshot for analysis.",
  input_schema: {
    type: "object",
    properties: {
      actionType: {
        type: "string",
        enum: ["press", "scroll", "type", "wait", "home", "back"],
        description:
          "Type of action to perform. Use 'press' for remote buttons, 'scroll' for D-pad navigation with optional count, 'type' for entering text, 'wait' to pause, 'home' for the home button, and 'back' for the back button.",
      },
      button: {
        type: "string",
        description:
          "Remote button identifier for 'press' actions (for example 'select', 'play', 'pause', 'search').",
      },
      direction: {
        type: "string",
        enum: ["up", "down", "left", "right"],
        description: "Directional input for scroll actions.",
      },
      count: {
        type: "integer",
        minimum: 1,
        maximum: 10,
        description:
          "How many times to repeat a scroll action. Defaults to 1. Use this to avoid repeated tool calls.",
      },
      text: {
        type: "string",
        description: "Text to type into the focused input field when using the 'type' action.",
      },
      holdMs: {
        type: "integer",
        minimum: 100,
        maximum: 5000,
        description: "Optional hold duration for long-press actions.",
      },
      waitMs: {
        type: "integer",
        minimum: 250,
        maximum: 5000,
        description:
          "Optional extra wait after the action before receiving the screenshot (useful for animations).",
      },
      reason: {
        type: "string",
        description: "Short explanation of why this action is being executed.",
      },
    },
    required: ["actionType", "reason"],
  },
};

let cachedAgentId: string | null = null;
let cachedClients: { agentsClient: AgentsClientType; sessionsClient: AgentSessionsClientType } | null = null;

function loadAzureClients(): {
  agentsClient: AgentsClientType;
  sessionsClient: AgentSessionsClientType;
} {
  if (cachedClients) {
    return cachedClients;
  }

  if (!AZURE_AI_AGENT_ENDPOINT || !AZURE_AI_AGENT_KEY) {
    throw new Error(
      "Azure AI Agent endpoint or key missing. Please configure AZURE_AI_AGENT_ENDPOINT and AZURE_AI_AGENT_KEY."
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const azureAgents = require("@azure/ai-agents");
  const AgentsClient =
    azureAgents?.AgentsClient ||
    azureAgents?.AgentClient ||
    azureAgents?.AzureAgentClient;
  const AgentSessionsClient =
    azureAgents?.AgentSessionsClient ||
    azureAgents?.SessionsClient ||
    azureAgents?.AzureAgentSessionsClient;

  if (!AgentsClient || !AgentSessionsClient) {
    throw new Error(
      "Unable to locate AgentsClient/AgentSessionsClient in @azure/ai-agents. Update the SDK or adjust the imports."
    );
  }

  const credential = new AzureKeyCredential(AZURE_AI_AGENT_KEY);
  const agentsClient = new AgentsClient(AZURE_AI_AGENT_ENDPOINT, credential);
  const sessionsClient = new AgentSessionsClient(
    AZURE_AI_AGENT_ENDPOINT,
    credential
  );

  cachedClients = { agentsClient, sessionsClient };
  return cachedClients;
}

async function ensureAgent(agentsClient: AgentsClientType): Promise<string> {
  if (cachedAgentId) {
    return cachedAgentId;
  }

  const model = AZURE_AI_AGENT_MODEL || "gpt-4o-mini";
  const agent = await agentsClient.createAgent?.({
    model,
    name: "tv-ui-automation-agent",
    description:
      "Agent that drives a smart TV UI through Home Assistant remote commands and a live camera feed provided by the client.",
    instructions: agentInstructions,
    tools: [performActionToolDefinition],
  });

  if (!agent?.id) {
    throw new Error("Failed to create Azure AI Agent instance for TV automation.");
  }

  cachedAgentId = agent.id;
  return agent.id;
}

async function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendRemoteCommands(commands: string[], holdSeconds?: number) {
  if (!HOME_ASSISTANT_URL || !HOME_ASSISTANT_TOKEN) {
    throw new Error(
      "Home Assistant connection is not configured. Set HOME_ASSISTANT_URL and HOME_ASSISTANT_TOKEN."
    );
  }
  if (!TV_REMOTE_ENTITY_ID) {
    throw new Error(
      "TV remote entity ID is not configured. Set TV_REMOTE_ENTITY_ID environment variable."
    );
  }

  const payload: Record<string, unknown> = {
    entity_id: TV_REMOTE_ENTITY_ID,
    command: commands,
  };

  if (holdSeconds && holdSeconds > 0) {
    payload["hold_secs"] = Math.round(holdSeconds * 10) / 10;
  }

  await axios.post(
    `${HOME_ASSISTANT_URL}/api/services/remote/send_command`,
    payload,
    {
      headers: {
        Authorization: `Bearer ${HOME_ASSISTANT_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
}

async function sendRemoteText(text: string) {
  if (!HOME_ASSISTANT_URL || !HOME_ASSISTANT_TOKEN) {
    throw new Error(
      "Home Assistant connection is not configured. Set HOME_ASSISTANT_URL and HOME_ASSISTANT_TOKEN."
    );
  }
  if (!TV_REMOTE_ENTITY_ID) {
    throw new Error(
      "TV remote entity ID is not configured. Set TV_REMOTE_ENTITY_ID environment variable."
    );
  }

  await axios.post(
    `${HOME_ASSISTANT_URL}/api/services/remote/send_command`,
    {
      entity_id: TV_REMOTE_ENTITY_ID,
      command: text,
      command_type: "send_text",
    },
    {
      headers: {
        Authorization: `Bearer ${HOME_ASSISTANT_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
}

async function executePerformAction(
  args: PerformActionArguments
): Promise<{ observation: string }> {
  const defaultWait = Number.isFinite(TV_DEFAULT_WAIT_MS)
    ? Math.max(250, TV_DEFAULT_WAIT_MS)
    : 1500;
  const waitAfter = args.waitMs ?? defaultWait;

  let observation = "";

  switch (args.actionType) {
    case "press": {
      if (!args.button) {
        throw new Error("Missing 'button' for press action.");
      }
      await sendRemoteCommands(
        [args.button],
        args.holdMs ? args.holdMs / 1000 : undefined
      );
      observation = `Pressed ${args.button}`;
      break;
    }
    case "home": {
      await sendRemoteCommands(["home"]);
      observation = "Pressed home button";
      break;
    }
    case "back": {
      await sendRemoteCommands(["back"]);
      observation = "Pressed back button";
      break;
    }
    case "scroll": {
      if (!args.direction) {
        throw new Error("Missing 'direction' for scroll action.");
      }
      const count = Math.min(Math.max(args.count ?? 1, 1), 10);
      const commands = Array.from({ length: count }, () => args.direction as string);
      await sendRemoteCommands(commands);
      observation = `Scrolled ${args.direction} ${count} time(s)`;
      break;
    }
    case "type": {
      if (!args.text) {
        throw new Error("Missing 'text' for type action.");
      }
      await sendRemoteText(args.text);
      observation = `Typed text: ${args.text}`;
      break;
    }
    case "wait": {
      observation = `Waited ${waitAfter}ms`;
      break;
    }
    default: {
      throw new Error(`Unsupported action type: ${args.actionType}`);
    }
  }

  await delay(waitAfter);

  return { observation };
}

function parseFinalCommand(message?: string): string | undefined {
  if (!message) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(message);
    if (parsed && typeof parsed === "object" && parsed.status === "done") {
      return parsed.final_command || parsed.finalCommand;
    }
  } catch (error) {
    // ignore parse error; return raw message below
  }

  return message.trim() || undefined;
}

async function createAgentSession(
  userPrompt: string,
  options?: { maxSteps?: number; messageHistory?: Array<{ role: string; content: string }> }
): Promise<TvAgentSessionState> {
  const { agentsClient, sessionsClient } = loadAzureClients();
  const agentId = await ensureAgent(agentsClient);
  const maxSteps = options?.maxSteps ?? 12;

  const session = await sessionsClient.createSession?.({
    agentId,
    name: `tv-agent-session-${Date.now()}`,
    metadata: {
      userPrompt,
    },
    additional_instructions: options?.messageHistory
      ? `Here is the relevant conversation history for context: ${JSON.stringify(
          options.messageHistory
        )}`
      : undefined,
  });

  if (!session?.id) {
    throw new Error("Failed to create agent session for TV automation.");
  }

  await sessionsClient.addMessage?.(session.id, {
    role: "user",
    content: [
      {
        type: "input_text",
        text: `The user asked: ${userPrompt}. Use the perform_action tool to complete the request. Wait for a screenshot after each action before continuing. Do not provide the final answer until the goal is reached.`,
      },
    ],
  });

  const sessionState: TvAgentSessionState = {
    id: randomUUID(),
    azureSessionId: session.id,
    steps: [],
    pendingScreenshot: undefined,
    completed: false,
    finalCommand: undefined,
    iterations: 0,
    maxSteps,
    userPrompt,
    additionalInstructions: options?.messageHistory
      ? `Context: ${JSON.stringify(options.messageHistory)}`
      : undefined,
    closed: false,
  };

  sessionStore.set(sessionState.id, sessionState);
  return sessionState;
}

function buildAwaitingScreenshotResult(
  session: TvAgentSessionState,
  step: TvAgentStep
): TvAgenticFlowResult {
  return {
    success: true,
    message: `Waiting for a camera screenshot after completing step ${step.index}.`,
    steps: session.steps,
    finalCommand: session.finalCommand,
    sessionId: session.id,
    status: "awaiting_screenshot",
    pendingStep: step,
    screenshotRequest: {
      prompt: `Capture the TV screen so the agent can analyze the result of step ${step.index}.`,
      reason: step.reasoning,
      stepIndex: step.index,
    },
  };
}

function extractScreenshotPayload(options: RunTvAgenticFlowOptions): ScreenshotPayload {
  if (options.screenshotError) {
    return { error: options.screenshotError };
  }

  if (options.screenshotBase64) {
    return {
      base64: options.screenshotBase64,
      contentType: options.screenshotContentType || "image/jpeg",
      dataUrl: options.screenshotDataUrl,
    };
  }

  if (!options.screenshotDataUrl) {
    return {};
  }

  const dataUrl = options.screenshotDataUrl;
  if (!dataUrl.startsWith("data:")) {
    return {
      error: "Invalid screenshot data URL provided. Expected data:<content-type>;base64,<data> format.",
    };
  }

  const base64Marker = ";base64,";
  const base64Index = dataUrl.indexOf(base64Marker);
  if (base64Index === -1) {
    return {
      error: "Invalid screenshot data URL provided. Expected base64 encoding.",
    };
  }

  const contentType = dataUrl.substring("data:".length, base64Index);
  const base64 = dataUrl.substring(base64Index + base64Marker.length);

  if (!contentType || !base64) {
    return {
      error: "Screenshot data URL is missing the content type or base64 payload.",
    };
  }

  return {
    base64,
    contentType,
    dataUrl,
  };
}

async function submitScreenshot(
  session: TvAgentSessionState,
  screenshot: ScreenshotPayload
): Promise<void> {
  const pending = session.pendingScreenshot;
  if (!pending) {
    throw new Error("No pending screenshot request for this session.");
  }

  const { sessionsClient } = loadAzureClients();
  const step = session.steps.find((item) => item.index === pending.stepIndex);
  if (!step) {
    throw new Error(`Unable to locate step ${pending.stepIndex} for screenshot submission.`);
  }

  let observation = pending.observation;
  let screenshotError: string | undefined;
  let screenshotBase64: string | undefined;
  let screenshotContentType: string | undefined;
  let screenshotDataUrl: string | undefined;

  if (screenshot.error) {
    screenshotError = screenshot.error;
    observation = `${observation}. Failed to capture screenshot: ${screenshot.error}.`;
  } else if (screenshot.base64 && screenshot.contentType) {
    screenshotBase64 = screenshot.base64;
    screenshotContentType = screenshot.contentType;
    screenshotDataUrl =
      screenshot.dataUrl || `data:${screenshotContentType};base64,${screenshotBase64}`;
    observation = `${observation}. Captured a fresh TV screenshot for analysis.`;
  } else {
    screenshotError =
      "Screenshot data missing. Provide a data URL or base64 payload when submitting the capture.";
    observation = `${observation}. Failed to capture screenshot: ${screenshotError}.`;
  }

  step.observation = observation;
  step.screenshotBase64 = screenshotBase64;
  step.screenshotContentType = screenshotContentType;
  step.screenshotDataUrl = screenshotDataUrl;
  step.screenshotError = screenshotError;

  const toolOutput: Record<string, unknown> = {
    success: true,
    observation,
    status: screenshotError ? "screenshot_failed" : "screenshot_captured",
  };

  if (screenshotBase64 && screenshotContentType) {
    toolOutput["screenshot_base64"] = screenshotBase64;
    toolOutput["screenshot_content_type"] = screenshotContentType;
  }

  if (screenshotError) {
    toolOutput["screenshot_error"] = screenshotError;
  }

  await sessionsClient.submitToolOutputs?.(session.azureSessionId, [
    {
      toolCallId: pending.toolCallId,
      output: JSON.stringify(toolOutput),
    },
  ]);

  session.pendingScreenshot = undefined;
}

async function processAgentUntilBreakpoint(
  session: TvAgentSessionState
): Promise<TvAgenticFlowResult> {
  const { sessionsClient } = loadAzureClients();

  while (!session.completed && session.iterations < session.maxSteps) {
    session.iterations += 1;

    const abortController = new AbortController();
    const eventStream = sessionsClient.listMessageEvents?.(session.azureSessionId, {
      abortSignal: abortController.signal,
    });

    if (!eventStream || typeof eventStream[Symbol.asyncIterator] !== "function") {
      throw new Error("Session event stream is not iterable. Check the SDK version.");
    }

    let pendingToolCall: { id?: string; name?: string; arguments: string } | null = null;

    try {
      for await (const event of eventStream) {
        if (!event) continue;

        if (event.type === "session.message.completed" && event.message?.content) {
          const textChunks: string[] = [];
          for (const part of event.message.content) {
            if (part.type === "output_text" && part.text) {
              textChunks.push(part.text);
            }
          }

          const assistantMessage = textChunks.join(" ");
          session.finalCommand = parseFinalCommand(assistantMessage);
          session.completed = true;

          abortController.abort();
          await cleanupSession(session);

          return {
            success: true,
            message:
              session.finalCommand ||
              `Completed agentic flow for request: ${session.userPrompt}. The agent responded: ${assistantMessage}`,
            steps: session.steps,
            finalCommand: session.finalCommand,
            sessionId: session.id,
            status: "completed",
          };
        }

        if (event.type === "response.error") {
          throw new Error(event.error?.message || "Agent session response error");
        }

        if (event.type === "session.tool_call.delta") {
          pendingToolCall = pendingToolCall || { arguments: "" };
          pendingToolCall.id = event.tool_call?.id || pendingToolCall.id;
          pendingToolCall.name = event.tool_call?.name || pendingToolCall.name;
          if (event.tool_call?.arguments_delta) {
            pendingToolCall.arguments += event.tool_call.arguments_delta;
          }
          continue;
        }

        if (event.type === "session.tool_call.completed") {
          const toolInvocation = pendingToolCall;
          pendingToolCall = null;

          if (!toolInvocation?.name) {
            throw new Error("Received a tool completion event without name.");
          }

          if (toolInvocation.name !== "perform_action") {
            throw new Error(`Unsupported tool requested: ${toolInvocation.name}`);
          }

          let parsedArgs: PerformActionArguments;
          try {
            parsedArgs = JSON.parse(toolInvocation.arguments || "{}");
          } catch (error) {
            throw new Error(`Failed to parse tool arguments: ${toolInvocation.arguments}`);
          }

          const { observation } = await executePerformAction(parsedArgs);
          const step: TvAgentStep = {
            index: session.steps.length + 1,
            actionSummary: observation,
            reasoning: parsedArgs.reason,
            observation,
            toolArguments: parsedArgs,
          };
          session.steps.push(step);
          session.pendingScreenshot = {
            toolCallId: toolInvocation.id as string,
            args: parsedArgs,
            stepIndex: step.index,
            observation,
          };

          abortController.abort();
          return buildAwaitingScreenshotResult(session, step);
        }
      }
    } catch (error) {
      if ((error as Error)?.name === "AbortError") {
        // Expected when we abort after processing a breakpoint.
      } else {
        throw error;
      }
    }
  }

  if (!session.completed && session.iterations >= session.maxSteps) {
    await cleanupSession(session);
    return {
      success: false,
      message:
        "Agentic TV flow reached the maximum allowed steps without completing the task. Consider refining the instructions.",
      steps: session.steps,
      finalCommand: session.finalCommand,
      sessionId: session.id,
      status: "error",
    };
  }

  return {
    success: true,
    message: "Agentic flow is running.",
    steps: session.steps,
    finalCommand: session.finalCommand,
    sessionId: session.id,
    status: "running",
  };
}

async function cleanupSession(session: TvAgentSessionState): Promise<void> {
  if (session.closed) {
    sessionStore.delete(session.id);
    return;
  }

  const { sessionsClient } = loadAzureClients();
  session.closed = true;
  sessionStore.delete(session.id);

  try {
    await sessionsClient.closeSession?.(session.azureSessionId);
  } catch (error) {
    console.warn("Failed to close Azure agent session", error);
  }
}

export async function runTvAgenticFlow(
  options: RunTvAgenticFlowOptions
): Promise<TvAgenticFlowResult> {
  let session: TvAgentSessionState | undefined;

  try {

    if (options.sessionId) {
      session = sessionStore.get(options.sessionId);
      if (!session) {
        throw new Error(
          `No active TV agent session found for sessionId ${options.sessionId}. Start a new session by omitting sessionId.`
        );
      }
    }

    if (!session) {
      if (!options.userPrompt) {
        throw new Error("userPrompt is required when starting a new agentic flow session.");
      }
      session = await createAgentSession(options.userPrompt, {
        maxSteps: options.maxSteps,
        messageHistory: options.messageHistory,
      });
    }

    if (!session) {
      throw new Error("Failed to initialize the TV agent session.");
    }

    const currentSession = session;

    if (currentSession.pendingScreenshot) {
      const screenshotPayload = extractScreenshotPayload(options);
      if (screenshotPayload.base64 || screenshotPayload.error) {
        await submitScreenshot(currentSession, screenshotPayload);
      } else {
        const pendingStep = currentSession.steps.find(
          (step) => step.index === currentSession.pendingScreenshot?.stepIndex
        );
        if (pendingStep) {
          return buildAwaitingScreenshotResult(currentSession, pendingStep);
        }
        // If we get here the pending state is inconsistent; clear it and continue.
        currentSession.pendingScreenshot = undefined;
      }
    }

    const result = await processAgentUntilBreakpoint(currentSession);

    if (result.status === "completed" || result.status === "error") {
      await cleanupSession(currentSession);
    }

    return result;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown error executing TV agentic flow.";
    console.error("runTvAgenticFlow error:", error);

    if (session) {
      await cleanupSession(session);
    }

    return {
      success: false,
      message,
      steps: session?.steps ?? [],
      finalCommand: session?.finalCommand,
      sessionId: session?.id || options.sessionId || "",
      status: "error",
    };
  }
}
