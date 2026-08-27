import { runAgent } from "./agents/core";
import {
  isRtspMode,
  startRtspCapture,
  stopRtspCapture,
} from "./agents/common/rtspCapture";
import {
  AgentPauseController,
  cancelActiveRun,
  getActiveRun,
  pauseActiveRun,
  resumeActiveRun,
  startActiveRun,
} from "./activeRunManager";

interface TvJobCallbacks {
  onComplete?: (message: string) => void;
  onError?: (message: string) => void;
}

export { AgentPauseController };

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
  const activeTvJob = getActiveRun("tv");
  if (!activeTvJob) return null;
  return {
    id: activeTvJob.id,
    prompt: activeTvJob.prompt,
    startedAt: activeTvJob.startedAt,
    status: activeTvJob.status,
  };
}

/** Pause the active job at its next cooperative checkpoint. */
export function pauseActiveTvJob(): string | undefined {
  return pauseActiveRun("tv")?.id;
}

/** Resume the exact same run, model session, and promise. */
export function resumeActiveTvJob(): string | undefined {
  return resumeActiveRun("tv")?.id;
}

export function cancelActiveTvJob(): string | undefined {
  return cancelActiveRun(
    "tv",
    "TV agent run cancelled by the user or a replacement run"
  )?.id;
}

export function startTvAgentJob(
  prompt: string,
  callbacks: TvJobCallbacks = {}
): StartTvJobResult {
  const started = startActiveRun({
    domain: "tv",
    prompt,
    execute: async (job) => {
      // Pre-warm RTSP so ffmpeg has produced frames by the time the agent first
      // calls get_latest_screenshot. ffmpeg's first-frame latency is ~3-7s and
      // the orchestrator's poll-for-frame window is only a few seconds.
      if (isRtspMode()) {
        startRtspCapture(job.id).catch((err) => {
          console.error(`[TvJob] RTSP pre-warm failed for ${job.id}:`, err);
        });
      }

      const result = await runAgent({
        agentType: "tv",
        userPrompt: job.prompt,
        maxSteps: 12,
        abortSignal: job.abortSignal,
        pauseGate: job.pauseGate,
      });

      if (result.status === "awaiting_external_input") {
        // Async TV jobs assume screenshots are auto-fulfilled (RTSP or browser).
        // Pausing here means the screenshot pipeline is misconfigured.
        throw new Error(
          "TV job stalled waiting for a screenshot. Check that RTSP or the camera client is running."
        );
      }

      if (result.status === "completed" && result.success) {
        return result.message || "Done";
      }

      throw new Error(result.message || "TV job failed.");
    },
    onComplete: (message) => callbacks.onComplete?.(message),
    onError: (message) => callbacks.onError?.(message),
    onFinally: (jobId) => {
      if (isRtspMode()) stopRtspCapture(jobId);
    },
  });

  return {
    jobId: started.jobId,
    replacedJobId:
      started.replacedRun?.domain === "tv"
        ? started.replacedRun.id
        : undefined,
  };
}
