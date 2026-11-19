import dotenv from "dotenv";
import { modelSettingsIdentity } from "../../modelSettings";
import { setTimeout as delay } from "node:timers/promises";
import { EvalStore } from "../store";
import { installNetworkBoundary } from "../network";
import { onlineEvalConfig } from "./config";
import { OnlineEvalEngine, type OnlineJudges } from "./engine";
import { ONLINE_REVIEW_INSTRUCTIONS } from "./quality";

async function loadJudges(): Promise<OnlineJudges> {
  const settings = await import("../../config");
  const judgeOverride = process.env.ONLINE_EVAL_JUDGE_MODEL || process.env.OFFLINE_EVAL_JUDGE_MODEL;
  const judgeSetting = process.env.ONLINE_EVAL_JUDGE_MODEL ? "ONLINE_EVAL_JUDGE_MODEL"
    : judgeOverride ? "OFFLINE_EVAL_JUDGE_MODEL" : "AI_MODEL_ADVANCED";
  const judgeModel = judgeOverride || settings.AI_MODEL_ADVANCED;
  const reviewerOverride = process.env.ONLINE_EVAL_REVIEW_MODEL;
  const reviewerModel = reviewerOverride || judgeModel;
  const judgeReasoningEffort = judgeOverride ? undefined : settings.AI_MODEL_ADVANCED_REASONING_EFFORT;
  const reviewerReasoningEffort = reviewerOverride ? undefined : judgeReasoningEffort;
  const judgeIdentity = modelSettingsIdentity(judgeModel, judgeReasoningEffort, judgeSetting);
  const reviewerIdentity = reviewerOverride ? modelSettingsIdentity(reviewerOverride, undefined, "ONLINE_EVAL_REVIEW_MODEL") : judgeIdentity;
  if (!judgeModel || !reviewerModel || !judgeIdentity || !reviewerIdentity || !settings.AZURE_OPENAI_RESOURCE_NAME) throw new Error("Configure online eval judge models and the Azure model endpoint");
  // Model calls only. No live tools, web fetches, or historical device replays.
  installNetworkBoundary(`${settings.AZURE_OPENAI_RESOURCE_NAME}.openai.azure.com`);
  const { createLlmJudge } = await import("../judge");
  return {
    judgeModel: judgeIdentity, reviewerModel: reviewerIdentity, primary: await createLlmJudge(judgeModel, [], "", judgeReasoningEffort),
    reviewer: await createLlmJudge(reviewerModel, [], ONLINE_REVIEW_INSTRUCTIONS, reviewerReasoningEffort),
  };
}

export async function runOnlineWorker(signal: AbortSignal): Promise<void> {
  dotenv.config({ quiet: true });
  const config = onlineEvalConfig();
  if (!config.enabled) return;
  const store = new EvalStore(config.directory);
  const release = await store.acquire();
  if (!release) return;
  const heartbeat = (error?: string) => store.write("state", {
    id: "worker", pid: process.pid, updatedAt: new Date().toISOString(), error,
  });
  let timer: ReturnType<typeof setInterval> | undefined;
  let failure: string | undefined;
  try {
    const judges = await loadJudges();
    const engine = new OnlineEvalEngine(store, config, async () => judges);
    timer = setInterval(() => { void heartbeat().catch(error => console.error("[Online eval heartbeat]", error)); }, 10_000);
    const enrollment = await engine.enroll();
    await engine.recover();
    // Import only the read-side trace store; never initialize the agent or telemetry SDK here.
    const { getAllTraces } = await import("../../tracing/agentTraceStore");
    while (!signal.aborted) {
      try {
        await heartbeat();
        await engine.discover(getAllTraces(), enrollment.enabledAt);
        if (signal.aborted) break;
        if (await engine.runNext(signal)) continue;
      } catch (error) {
        if (signal.aborted) break;
        await heartbeat(error instanceof Error ? error.message : String(error));
        console.error("[Online eval worker]", error);
      }
      await delay(config.pollMs, undefined, { signal }).catch(error => { if (!signal.aborted) throw error; });
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    clearInterval(timer);
    try {
      await store.write("state", { id: "worker", pid: process.pid, updatedAt: new Date().toISOString(), stopped: true, error: failure });
    } finally { await release(); }
  }
}

if (require.main === module) {
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort(new Error("Online eval worker stopped")));
  process.once("SIGINT", () => controller.abort(new Error("Online eval worker stopped")));
  runOnlineWorker(controller.signal).catch(error => { console.error("[Online eval worker]", error); process.exitCode = 1; });
}
