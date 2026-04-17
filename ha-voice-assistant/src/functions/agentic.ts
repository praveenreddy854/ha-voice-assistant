import { AgenticStep } from "../types/agentic";

// ============================================================================
// Unified Agent API types (matches AgentRunResult on the server)
// ============================================================================

interface AgentStep {
  index: number;
  toolName: string;
  toolCallId?: string;
  toolArgs: Record<string, unknown>;
  actionSummary: string;
  observation: string;
  toolSuccess?: boolean;
  awaitingExternalInput?: boolean;
  retryCount?: number;
  maxRetries?: number;
  metadata?: Record<string, unknown>;
}

export interface AgentRunResult {
  success: boolean;
  message: string;
  sessionId: string;
  status: "running" | "awaiting_external_input" | "completed" | "error";
  steps: AgentStep[];
  externalInputRequest?: {
    type: string;
    prompt: string;
    reason: string;
    stepIndex: number;
  };
  agentData?: Record<string, unknown>;
}

// ============================================================================
// Helpers
// ============================================================================

export function formatToolArgs(toolArgs: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(toolArgs)) {
    if (value === undefined) continue;
    parts.push(`${key}: ${typeof value === "string" ? `"${value}"` : value}`);
  }
  return `{ ${parts.join(", ")} }`;
}

export function logStepDelta(
  previousSteps: AgenticStep[],
  nextSteps: AgenticStep[]
): void {
  if (nextSteps.length <= previousSteps.length) return;

  const newSteps = nextSteps.slice(previousSteps.length);
  newSteps.forEach((step) => {
    const toolArgsStr = step.toolArguments ? formatToolArgs(step.toolArguments) : "N/A";
    console.info(
      `[Agent Flow] Step ${step.index}: ${step.actionSummary}\n` +
      `  Tool: ${step.toolName || "unknown"}\n` +
      `  Args: ${toolArgsStr}\n` +
      `  Reason: ${step.reasoning}\n` +
      `  Observation: ${step.observation}`
    );
  });
}
