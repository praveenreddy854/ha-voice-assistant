import { runAgent } from "./agents/core";
import type { AgentPauseGate } from "./agents/core/types";
import { executeHACommand } from "./ha";
import {
  cancelActiveTvJob,
  getActiveTvJob,
  startTvAgentJob,
} from "./tvJobManager";

export interface AssistantCapabilityOptions {
  abortSignal?: AbortSignal;
  pauseGate?: AgentPauseGate;
}

export async function executeHomeAssistantCapability(
  command: string,
  options: AssistantCapabilityOptions = {}
): Promise<{ success: boolean; message: string; data?: unknown }> {
  return executeHACommand(command, undefined, {
    abortSignal: options.abortSignal,
    pauseGate: options.pauseGate,
  });
}

export async function executeScheduledTaskCapability(
  prompt: string,
  options: AssistantCapabilityOptions = {}
): Promise<{ success: boolean; message: string }> {
  const result = await runAgent({
    agentType: "scheduled_task",
    userPrompt: prompt,
    maxSteps: 8,
    abortSignal: options.abortSignal,
    pauseGate: options.pauseGate,
  });
  return {
    success: result.status === "completed" && result.success,
    message:
      result.message ||
      (result.status === "awaiting_external_input"
        ? "The ScheduledTaskAgent needs more information."
        : "The ScheduledTaskAgent failed."),
  };
}

export function executeTvCapability(
  prompt: string,
  options: AssistantCapabilityOptions = {}
): Promise<{ success: boolean; message: string }> {
  return new Promise((resolve, reject) => {
    let jobId = "";
    let settled = false;

    const finish = (result: { success: boolean; message: string }) => {
      if (settled) return;
      settled = true;
      options.abortSignal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      options.abortSignal?.removeEventListener("abort", onAbort);
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const onAbort = () => {
      const activeJob = getActiveTvJob();
      if (activeJob?.id === jobId) cancelActiveTvJob();
      fail(options.abortSignal?.reason ?? new Error("TV command cancelled."));
    };

    const started = startTvAgentJob(prompt, {
      onComplete: (message) => finish({ success: true, message }),
      onError: (message) => finish({ success: false, message }),
      onCancelled: () => fail(new Error("TV command replaced or cancelled.")),
    });
    jobId = started.jobId;

    if (options.abortSignal?.aborted) {
      onAbort();
      return;
    }
    options.abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
}
