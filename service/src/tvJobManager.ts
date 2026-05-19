import { randomUUID } from "crypto";
import { runAgent } from "./agents/core";
import {
  isRtspMode,
  startRtspCapture,
  stopRtspCapture,
} from "./agents/common/rtspCapture";

interface TvJobCallbacks {
  onComplete?: (message: string) => void;
  onError?: (message: string) => void;
}

interface TvJob {
  id: string;
  prompt: string;
  cancelled: boolean;
  startedAt: string;
}

let activeTvJob: TvJob | null = null;

export interface StartTvJobResult {
  jobId: string;
  replacedJobId?: string;
}

export function getActiveTvJob(): { id: string; prompt: string; startedAt: string } | null {
  if (!activeTvJob || activeTvJob.cancelled) return null;
  return {
    id: activeTvJob.id,
    prompt: activeTvJob.prompt,
    startedAt: activeTvJob.startedAt,
  };
}

export function cancelActiveTvJob(): string | undefined {
  if (!activeTvJob || activeTvJob.cancelled) return undefined;
  activeTvJob.cancelled = true;
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
    cancelled: false,
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
    });

    if (job.cancelled) return;

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
    if (job.cancelled) return;
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
