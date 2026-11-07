import dotenv from "dotenv";
import { setTimeout as delay } from "node:timers/promises";
import { EvalStore } from "../store";
import { installNetworkBoundary } from "../network";
import { onlineEvalConfig } from "./config";
import { OnlineEvalEngine, type OnlineJudges } from "./engine";
import { ONLINE_REVIEW_INSTRUCTIONS } from "./quality";

export async function runOnlineWorker(signal: AbortSignal): Promise<void> {
  dotenv.config({ quiet: true });
  const config = onlineEvalConfig();
  if (!config.enabled) return;
  const store = new EvalStore(config.directory);
  const release = await store.acquire();
  if (!release) return;
  let judges: Promise<OnlineJudges> | undefined;
  const engine = new OnlineEvalEngine(store, config, () => judges ??= (async () => {
    const settings = await import("../../config");
    const judgeModel = process.env.ONLINE_EVAL_JUDGE_MODEL || process.env.OFFLINE_EVAL_JUDGE_MODEL || settings.AI_MODEL_ADVANCED;
    const reviewerModel = process.env.ONLINE_EVAL_REVIEW_MODEL || judgeModel;
    if (!judgeModel || !reviewerModel || !settings.AZURE_OPENAI_RESOURCE_NAME) throw new Error("Configure online eval judge models and the Azure model endpoint");
    // Model calls only. No live tools, web fetches, or historical device replays.
    installNetworkBoundary(`${settings.AZURE_OPENAI_RESOURCE_NAME}.openai.azure.com`);
    const { createLlmJudge } = await import("../judge");
    return {
      judgeModel, reviewerModel, primary: await createLlmJudge(judgeModel),
      reviewer: await createLlmJudge(reviewerModel, [], ONLINE_REVIEW_INSTRUCTIONS),
    };
  })());
  const heartbeat = (error?: string) => store.write("state", {
    id: "worker", pid: process.pid, updatedAt: new Date().toISOString(), error,
  });
  const timer = setInterval(() => { void heartbeat().catch(error => console.error("[Online eval heartbeat]", error)); }, 10_000);
  try {
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
  } finally {
    clearInterval(timer);
    await store.write("state", { id: "worker", pid: process.pid, updatedAt: new Date().toISOString(), stopped: true });
    await release();
  }
}

if (require.main === module) {
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort(new Error("Online eval worker stopped")));
  process.once("SIGINT", () => controller.abort(new Error("Online eval worker stopped")));
  runOnlineWorker(controller.signal).catch(error => { console.error("[Online eval worker]", error); process.exitCode = 1; });
}
