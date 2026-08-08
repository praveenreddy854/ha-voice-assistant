import { randomUUID } from "crypto";
import { runAgent } from "./agents/core";
import {
  isRtspMode,
  startRtspCapture,
  stopRtspCapture,
} from "./agents/common/rtspCapture";
import type { AgentPauseGate } from "./agents/core/types";

interface TvJobCallbacks {
  onComplete?: (message: string) => void;
  onError?: (message: string) => void;
}

interface TvJob {
  id: string;
  prompt: string;
  status: "running" | "paused" | "cancelled";
  abortController: AbortController;
  pauseController: AgentPauseController;
  startedAt: string;
}

/** A reusable cooperative gate that preserves the promise waiting behind it. */
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

let activeTvJob: TvJob | null = null;

export interface StartTvJobResult {
  jobId: string;
  replacedJobId?: string;
}

export function getActiveTvJob(): {
  id: string;
  prompt: string;
  startedAt: string;
  status: "running" | "paused";
} | null {
  if (!activeTvJob || activeTvJob.status === "cancelled") return null;
  return {
    id: activeTvJob.id,
    prompt: activeTvJob.prompt,
    startedAt: activeTvJob.startedAt,
    status: activeTvJob.status,
  };
}

/** Pause the active job at its next cooperative checkpoint. */
export function pauseActiveTvJob(): string | undefined {
  if (!activeTvJob || activeTvJob.status === "cancelled") return undefined;
  if (activeTvJob.status === "paused") return activeTvJob.id;
  activeTvJob.status = "paused";
  activeTvJob.pauseController.pause();
  return activeTvJob.id;
}

/** Resume the exact same run, model session, and promise. */
export function resumeActiveTvJob(): string | undefined {
  if (!activeTvJob || activeTvJob.status !== "paused") return undefined;
  activeTvJob.status = "running";
  activeTvJob.pauseController.resume();
  return activeTvJob.id;
}

export function cancelActiveTvJob(): string | undefined {
  if (!activeTvJob || activeTvJob.status === "cancelled") return undefined;
  activeTvJob.status = "cancelled";
  activeTvJob.abortController.abort(
    new Error("TV agent run cancelled by the user or a replacement run")
  );
  // Release a paused checkpoint so the AbortSignal can be observed.
  activeTvJob.pauseController.resume();
  return activeTvJob.id;
}

export function startTvAgentJob(
  prompt: string,
  callbacks: TvJobCallbacks = {}
): StartTvJobResult {
  const replacedJobId = cancelActiveTvJob();
  const job: TvJob = {
    id: randomUUID(),
    prompt,
    status: "running",
    abortController: new AbortController(),
    pauseController: new AgentPauseController(),
    startedAt: new Date().toISOString(),
  };
  activeTvJob = job;

  // Pre-warm RTSP so ffmpeg has produced frames by the time the agent first
  // calls get_latest_screenshot. ffmpeg's first-frame latency is ~3-7s and
  // the orchestrator's poll-for-frame window is only a few seconds.
  if (isRtspMode()) {
    startRtspCapture(job.id).catch((err) => {
      console.error(`[TvJob] RTSP pre-warm failed for ${job.id}:`, err);
    });
  }

  void runTvJob(job, callbacks);

  return { jobId: job.id, replacedJobId };
}

async function runTvJob(job: TvJob, callbacks: TvJobCallbacks): Promise<void> {
  try {
    const result = await runAgent({
      agentType: "tv",
      userPrompt: job.prompt,
      maxSteps: 12,
      abortSignal: job.abortController.signal,
      pauseGate: job.pauseController,
    });

    if (job.status === "cancelled") return;

    if (result.status === "awaiting_external_input") {
      // Async TV jobs assume screenshots are auto-fulfilled (RTSP or browser).
      // Pausing here means the screenshot pipeline is misconfigured.
      callbacks.onError?.(
        "TV job stalled waiting for a screenshot. Check that RTSP or the camera client is running."
      );
      return;
    }

    if (result.status === "completed" && result.success) {
      callbacks.onComplete?.(result.message || "Done");
      return;
    }

    callbacks.onError?.(result.message || "TV job failed.");
  } catch (error) {
    if (job.status === "cancelled") return;
    const message = error instanceof Error ? error.message : String(error);
    callbacks.onError?.(message);
  } finally {
    if (isRtspMode()) {
      stopRtspCapture(job.id);
    }
    if (activeTvJob?.id === job.id) {
      activeTvJob = null;
    }
  }
}
