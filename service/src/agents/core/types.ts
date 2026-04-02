/**
 * Core Agent Infrastructure Types
 *
 * Generic types for the agent system. Any agent (TV, navigation, typing,
 * or future agents) implements AgentDefinition and the orchestrator
 * handles the rest: session management, tool dispatch, external-input
 * pause/resume, and step tracking.
 */

import { ToolDefinition } from "./agentLoop";

// ============================================================================
// Agent Type
// ============================================================================

/**
 * Known agent type identifiers. Extend this union when adding new agents.
 */
export type AgentType = "tv";

// ============================================================================
// Tool Execution
// ============================================================================

/**
 * Context passed to every tool executor call.
 * Contains shared runtime state the tool may need.
 */
export interface ToolExecutionContext {
  /** Arbitrary key-value bag agents can populate with domain-specific data. */
  [key: string]: unknown;
}

/**
 * Result returned by a tool executor.
 */
export interface ToolExecutionResult {
  /** Human-readable observation fed back to the LLM. */
  observation: string;
  /** If true the orchestrator pauses and asks the client for external input. */
  needsExternalInput?: boolean;
  /** Describes what external input is needed (only when needsExternalInput is true). */
  externalInputRequest?: ExternalInputRequest;
  /** Whether the tool itself succeeded (distinct from the overall flow). */
  toolSuccess?: boolean;
  /** Arbitrary metadata the agent definition can attach to the step. */
  metadata?: Record<string, unknown>;
}

/**
 * A function that executes a single tool.
 * The orchestrator calls this with parsed args and shared context.
 */
export type ToolExecutor = (
  args: Record<string, unknown>,
  context: ToolExecutionContext
) => Promise<ToolExecutionResult>;

// ============================================================================
// External Input (pause/resume)
// ============================================================================

/**
 * Describes what external data the agent needs from the client.
 * For example: a screenshot captured by a camera, user confirmation, etc.
 */
export interface ExternalInputRequest {
  /** Discriminator, e.g. "screenshot", "user_confirmation". */
  type: string;
  /** Human-readable prompt shown to the client. */
  prompt: string;
  /** Why this input is needed (for logging/display). */
  reason: string;
  /** Extra data the client may need to fulfill the request. */
  metadata?: Record<string, unknown>;
}

/**
 * Data the client sends back to satisfy an ExternalInputRequest.
 */
export interface ExternalInputData {
  /** Must match the type from the corresponding ExternalInputRequest. */
  type: string;
  /** The actual payload, e.g. { base64, contentType } for screenshots. */
  data: Record<string, unknown>;
  /** If the client failed to provide the input. */
  error?: string;
}

// ============================================================================
// Agent Step
// ============================================================================

/**
 * One tracked step in an agent run.
 * Each tool execution produces one step.
 */
export interface AgentStep {
  index: number;
  toolName: string;
  toolCallId?: string;
  toolArgs: Record<string, unknown>;
  actionSummary: string;
  observation: string;
  toolSuccess?: boolean;
  /** Whether this step is waiting for external input. */
  awaitingExternalInput?: boolean;
  /** Retry count for external input (e.g. screenshot retries). */
  retryCount?: number;
  maxRetries?: number;
  /** Agent-specific metadata. */
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Agent Session
// ============================================================================

export type AgentSessionStatus =
  | "running"
  | "awaiting_external_input"
  | "completed"
  | "error";

/**
 * Pending external input state stored on the session.
 */
export interface PendingExternalInput {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  stepIndex: number;
  observation: string;
  request: ExternalInputRequest;
  retryCount: number;
}

/**
 * Runtime state for a single agent session.
 * Managed by the orchestrator; agents should not mutate this directly.
 */
export interface AgentSession {
  id: string;
  agentType: AgentType;
  agentLoopSessionId: string;
  steps: AgentStep[];
  pendingExternalInput?: PendingExternalInput;
  completed: boolean;
  iterations: number;
  maxSteps: number;
  userPrompt: string;
  closed: boolean;
  /** Agent-specific session data (e.g. TV agent stores finalCommand here). */
  agentData: Record<string, unknown>;
}

// ============================================================================
// Agent Run Options / Result (client ↔ server protocol)
// ============================================================================

/**
 * Input from the client to run (or continue) an agent.
 */
export interface AgentRunOptions {
  /** Which agent to run. */
  agentType: AgentType;
  /** The user's request. Required for new sessions. */
  userPrompt?: string;
  /** Resume an existing session. */
  sessionId?: string;
  /** Override the default max steps. */
  maxSteps?: number;
  /** Conversation history for context. */
  messageHistory?: Array<{ role: string; content: string }>;
  /** External input data when resuming after a pause. */
  externalInput?: ExternalInputData;
}

/**
 * Output from the orchestrator back to the client.
 */
export interface AgentRunResult {
  success: boolean;
  message: string;
  sessionId: string;
  status: AgentSessionStatus;
  steps: AgentStep[];
  /** Present when status is "awaiting_external_input". */
  externalInputRequest?: ExternalInputRequest & { stepIndex: number };
  /** Agent-specific data the client may need. */
  agentData?: Record<string, unknown>;
}

// ============================================================================
// Agent Definition
// ============================================================================

/**
 * Everything the orchestrator needs to know about an agent.
 *
 * To add a new agent, implement this interface and register it
 * with the agent registry.
 */
export interface AgentDefinition {
  /** Unique identifier, e.g. "tv". */
  id: AgentType;
  /** Human-readable name. */
  name: string;
  /** What this agent does. */
  description: string;
  /** System prompt for the LLM. */
  systemPrompt: string;
  /** Tools the agent can call (without execute functions). */
  tools: ToolDefinition[];
  /** Azure OpenAI deployment name to use. Falls back to AI_MODEL_ADVANCED. */
  model?: string;
  /** Maximum iterations before the orchestrator aborts. */
  maxIterations: number;

  /**
   * Build the initial user message sent to the LLM when creating a new session.
   * This is where domain-specific context (device states, etc.) gets injected.
   */
  buildInitialMessage(
    userPrompt: string,
    options: AgentRunOptions
  ): Promise<string>;

  /**
   * Execute a tool call. Maps tool name → domain-specific executor.
   * Return the observation + whether external input is needed.
   */
  executeTool(
    toolName: string,
    args: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult>;

  /**
   * Build a human-readable summary of what a tool call does.
   * Used for step.actionSummary.
   */
  getToolActionSummary(
    toolName: string,
    args: Record<string, unknown>
  ): string;

  /**
   * Build the ToolExecutionContext for this agent.
   * Called once per processLoop cycle.
   */
  buildToolContext(
    session: AgentSession,
    externalInputData?: Record<string, unknown>
  ): ToolExecutionContext;

  /**
   * Process external input (e.g. crop a screenshot) before submitting
   * it back to the agent loop. Optional — if not provided, the raw
   * observation is used.
   */
  processExternalInput?(
    session: AgentSession,
    input: ExternalInputData
  ): Promise<{
    observation: string;
    /** Optional image to include in the tool result message. */
    imageBase64?: string;
    imageContentType?: string;
  }>;

  /**
   * Called when the session completes successfully or with error.
   * Use for cleanup, memory persistence, etc.
   */
  onComplete?(
    session: AgentSession,
    result: AgentRunResult
  ): Promise<void>;
}
