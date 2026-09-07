import { TV_REMOTE_KEY_DELAY_MS } from "../../../config";
import { callHAServiceDirect } from "../../../ha";
import type { ToolExecutionContext } from "./types";

/** Keep command order on the device, with cancellation between small batches. */
export async function sendRemoteCommands(
  entityId: string,
  command: string | string[],
  context: ToolExecutionContext,
  repeats = 1,
) {
  await context.waitIfPaused?.();
  context.abortSignal?.throwIfAborted();
  const result = await callHAServiceDirect("remote", "send_command", entityId, {
    command,
    num_repeats: repeats,
    delay_secs: TV_REMOTE_KEY_DELAY_MS / 1000,
  }, { abortSignal: context.abortSignal });
  await context.waitIfPaused?.();
  context.abortSignal?.throwIfAborted();
  return result;
}
