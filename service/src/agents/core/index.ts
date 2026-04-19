/**
 * Core Agent Infrastructure
 *
 * Usage:
 *   import { registerAgent, runAgent, AgentDefinition } from "../core";
 */

export type {
  AgentType,
  AgentDefinition,
  AgentSession,
  AgentStep,
  AgentRunOptions,
  AgentRunResult,
  AgentSessionStatus,
  ExternalInputRequest,
  ExternalInputData,
  PendingExternalInput,
  ToolExecutor,
  ToolExecutionContext,
  ToolExecutionResult,
} from "./types";

export { registerAgent, getAgent, getRegisteredAgentTypes, getAllAgents } from "./registry";
export { runAgent, getSession, getAgentLoop, getSessionMessages, addMessageToSession } from "./orchestrator";

export type {
  ToolDefinition,
  AgentToolCall,
  AgentStepResult,
  AgentLoopSession,
  AgentLoopConfig,
  AgentLoop,
  ToolResultInput,
  StepEvent,
} from "./agentLoop";

export { createAgentLoop } from "./agentLoop";
