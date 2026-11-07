import { randomUUID } from "crypto";
import type { AgentPauseGate } from "./agents/core/types";
import { getRequestContext, withRequestContext } from "./requestContext";
import { addEvent, completeTrace, createTrace, getActiveSessionId, withTraceSession } from "./tracing/agentTraceStore";

function retain(callback: () => void): void {
  try { callback(); } catch { console.error("[ActiveRun] Job evidence capture failed"); }
}
const jobTraceId = (id: string) => `job-${id}`;
function resultMessage(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object" && "message" in result && typeof result.message === "string") return result.message;
  return "Background execution finished";
}

export type ActiveRunDomain = "tv" | "scheduled_task" | "home_assistant";
export type ActiveRunStatus = "running" | "paused" | "cancelled";

export interface ActiveRunSnapshot {
  id: string;
  domain: ActiveRunDomain;
  prompt: string;
  startedAt: string;
  status: Exclude<ActiveRunStatus, "cancelled">;
}

export interface ActiveRunContext extends ActiveRunSnapshot {
  abortSignal: AbortSignal;
  pauseGate: AgentPauseGate;
}

interface ManagedActiveRun {
  id: string;
  domain: ActiveRunDomain;
  prompt: string;
  startedAt: string;
  status: ActiveRunStatus;
  abortController: AbortController;
  pauseController: AgentPauseController;
}

export interface StartActiveRunOptions<T> {
  domain: ActiveRunDomain;
  prompt: string;
  execute: (context: ActiveRunContext) => Promise<T>;
  onComplete?: (result: T, run: ActiveRunSnapshot) => void | Promise<void>;
  onError?: (message: string, run: ActiveRunSnapshot) => void | Promise<void>;
  onCancelled?: (run: ActiveRunSnapshot) => void | Promise<void>;
  onFinally?: (runId: string) => void | Promise<void>;
}

export interface StartActiveRunResult {
  jobId: string;
  replacedRun?: ActiveRunSnapshot;
}

/** Cooperative pause gate shared by every server-owned realtime run. */
export class AgentPauseController implements AgentPauseGate {
  private paused = false;
  private waiters = new Set<() => void>();

  get isPaused(): boolean {
    return this.paused;
  }

  pause(): boolean {
    if (this.paused) return false;
    this.paused = true;
    return true;
  }

  resume(): boolean {
    if (!this.paused) return false;
    this.paused = false;
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
    return true;
  }

  waitIfPaused(): Promise<void> {
    if (!this.paused) return Promise.resolve();
    return new Promise((resolve) => this.waiters.add(resolve));
  }
}

const activeRuns = new Map<ActiveRunDomain, ManagedActiveRun>();

function snapshot(run: ManagedActiveRun): ActiveRunSnapshot {
  return {
    id: run.id,
    domain: run.domain,
    prompt: run.prompt,
    startedAt: run.startedAt,
    status: run.status === "paused" ? "paused" : "running",
  };
}

function matchesDomain(
  run: ManagedActiveRun | null,
  domain?: ActiveRunDomain
): run is ManagedActiveRun {
  return Boolean(
    run && run.status !== "cancelled" && (!domain || run.domain === domain)
  );
}

function latestActiveRun(): ManagedActiveRun | null {
  const candidates = Array.from(activeRuns.values()).filter(
    (run) => run.status !== "cancelled"
  );
  return (
    candidates.sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] ?? null
  );
}

export function getActiveRun(
  domain?: ActiveRunDomain
): ActiveRunSnapshot | null {
  const run = domain ? activeRuns.get(domain) ?? null : latestActiveRun();
  return matchesDomain(run, domain) ? snapshot(run) : null;
}

/** Pause the active run at its next cooperative checkpoint. */
export function pauseActiveRun(
  domain?: ActiveRunDomain
): ActiveRunSnapshot | undefined {
  const run = domain ? activeRuns.get(domain) ?? null : latestActiveRun();
  if (!matchesDomain(run, domain)) return undefined;
  if (run.status !== "paused") {
    run.status = "paused";
    run.pauseController.pause();
  }
  return snapshot(run);
}

/** Resume the exact same run, promise, and specialist model session. */
export function resumeActiveRun(
  domain?: ActiveRunDomain
): ActiveRunSnapshot | undefined {
  const run = domain ? activeRuns.get(domain) ?? null : latestActiveRun();
  if (!matchesDomain(run, domain) || run.status !== "paused") {
    return undefined;
  }
  run.status = "running";
  run.pauseController.resume();
  return snapshot(run);
}

export function cancelActiveRun(
  domain?: ActiveRunDomain,
  reason = "Active run cancelled by the user or a replacement run"
): ActiveRunSnapshot | undefined {
  const run = domain ? activeRuns.get(domain) ?? null : latestActiveRun();
  if (!matchesDomain(run, domain)) return undefined;
  const cancelled = snapshot(run);
  run.status = "cancelled";
  run.abortController.abort(new Error(reason));
  // Release a paused checkpoint so the AbortSignal is observed immediately.
  run.pauseController.resume();
  return cancelled;
}

export function startActiveRun<T>(
  options: StartActiveRunOptions<T>
): StartActiveRunResult {
  const replacedRun = getActiveRun(options.domain) ?? undefined;
  cancelActiveRun(options.domain);

  const run: ManagedActiveRun = {
    id: randomUUID(),
    domain: options.domain,
    prompt: options.prompt,
    status: "running",
    abortController: new AbortController(),
    pauseController: new AgentPauseController(),
    startedAt: new Date().toISOString(),
  };
  activeRuns.set(run.domain, run);
  const originSessionId = getRequestContext()?.originSessionId || getActiveSessionId() || undefined;
  retain(() => {
    createTrace(jobTraceId(run.id), "async_job", run.prompt);
    addEvent(jobTraceId(run.id), "job.accepted", "Server-owned background job accepted", {
      jobId: run.id, domain: run.domain, originSessionId,
      requestReceivedAt: getRequestContext()?.receivedAt || run.startedAt,
      evidenceScope: "Backend execution and notification callbacks only; no inferred audio playback or physical completion",
    });
  });
  void withRequestContext(getRequestContext()?.receivedAt || run.startedAt,
    () => withTraceSession(jobTraceId(run.id), () => executeManagedRun(run, options)),
    { jobId: run.id, originSessionId });
  return { jobId: run.id, replacedRun };
}

async function executeManagedRun<T>(
  run: ManagedActiveRun,
  options: StartActiveRunOptions<T>
): Promise<void> {
  let cancellationNotified = false;
  let success = false, finalMessage = "Background job interrupted";
  const notifyCancellation = async () => {
    if (cancellationNotified) return;
    cancellationNotified = true;
    finalMessage = "Background run cancelled; its device effects may be incomplete";
    retain(() => addEvent(jobTraceId(run.id), "job.cancelled", finalMessage));
    try {
      await options.onCancelled?.(snapshot(run));
    } catch (error) {
      console.error(`[ActiveRun] Cancellation callback failed for ${run.id}:`, error);
    }
  };
  try {
    const result = await options.execute({
      ...snapshot(run),
      abortSignal: run.abortController.signal,
      pauseGate: run.pauseController,
    });
    if (run.status !== "cancelled") {
      retain(() => addEvent(jobTraceId(run.id), "job.execution.completed", resultMessage(result)));
      await options.onComplete?.(result, snapshot(run));
      retain(() => addEvent(jobTraceId(run.id), "job.notification.callback_completed", "Completion callback returned; this does not establish that speech played"));
      success = true; finalMessage = resultMessage(result);
    } else {
      await notifyCancellation();
    }
  } catch (error) {
    if (run.status === "cancelled") {
      await notifyCancellation();
    } else {
      const message = error instanceof Error ? error.message : String(error);
      finalMessage = message;
      retain(() => addEvent(jobTraceId(run.id), "job.execution.failed", message));
      await options.onError?.(message, snapshot(run));
    }
  } finally {
    try {
      if (run.status === "cancelled" && !cancellationNotified) {
        await notifyCancellation();
      }
      await options.onFinally?.(run.id);
    } catch (error) {
      console.error(`[ActiveRun] Finalizer failed for ${run.id}:`, error);
    } finally {
      retain(() => completeTrace(jobTraceId(run.id), success, finalMessage, success ? "completed" : "error"));
      if (activeRuns.get(run.domain)?.id === run.id) {
        activeRuns.delete(run.domain);
      }
    }
  }
}
