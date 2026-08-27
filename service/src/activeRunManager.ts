import { randomUUID } from "crypto";
import type { AgentPauseGate } from "./agents/core/types";

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

let activeRun: ManagedActiveRun | null = null;

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

export function getActiveRun(
  domain?: ActiveRunDomain
): ActiveRunSnapshot | null {
  return matchesDomain(activeRun, domain) ? snapshot(activeRun) : null;
}

/** Pause the active run at its next cooperative checkpoint. */
export function pauseActiveRun(
  domain?: ActiveRunDomain
): ActiveRunSnapshot | undefined {
  if (!matchesDomain(activeRun, domain)) return undefined;
  if (activeRun.status !== "paused") {
    activeRun.status = "paused";
    activeRun.pauseController.pause();
  }
  return snapshot(activeRun);
}

/** Resume the exact same run, promise, and specialist model session. */
export function resumeActiveRun(
  domain?: ActiveRunDomain
): ActiveRunSnapshot | undefined {
  if (!matchesDomain(activeRun, domain) || activeRun.status !== "paused") {
    return undefined;
  }
  activeRun.status = "running";
  activeRun.pauseController.resume();
  return snapshot(activeRun);
}

export function cancelActiveRun(
  domain?: ActiveRunDomain,
  reason = "Active run cancelled by the user or a replacement run"
): ActiveRunSnapshot | undefined {
  if (!matchesDomain(activeRun, domain)) return undefined;
  const cancelled = snapshot(activeRun);
  activeRun.status = "cancelled";
  activeRun.abortController.abort(new Error(reason));
  // Release a paused checkpoint so the AbortSignal is observed immediately.
  activeRun.pauseController.resume();
  return cancelled;
}

export function startActiveRun<T>(
  options: StartActiveRunOptions<T>
): StartActiveRunResult {
  const replacedRun = getActiveRun() ?? undefined;
  cancelActiveRun();

  const run: ManagedActiveRun = {
    id: randomUUID(),
    domain: options.domain,
    prompt: options.prompt,
    status: "running",
    abortController: new AbortController(),
    pauseController: new AgentPauseController(),
    startedAt: new Date().toISOString(),
  };
  activeRun = run;

  void executeManagedRun(run, options);
  return { jobId: run.id, replacedRun };
}

async function executeManagedRun<T>(
  run: ManagedActiveRun,
  options: StartActiveRunOptions<T>
): Promise<void> {
  try {
    const result = await options.execute({
      ...snapshot(run),
      abortSignal: run.abortController.signal,
      pauseGate: run.pauseController,
    });
    if (run.status !== "cancelled") {
      await options.onComplete?.(result, snapshot(run));
    }
  } catch (error) {
    if (run.status !== "cancelled") {
      const message = error instanceof Error ? error.message : String(error);
      await options.onError?.(message, snapshot(run));
    }
  } finally {
    try {
      await options.onFinally?.(run.id);
    } catch (error) {
      console.error(`[ActiveRun] Finalizer failed for ${run.id}:`, error);
    } finally {
      if (activeRun?.id === run.id) {
        activeRun = null;
      }
    }
  }
}
