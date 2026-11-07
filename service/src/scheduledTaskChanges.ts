import { EventEmitter } from "node:events";

const changes = new EventEmitter();
export class ScheduledTaskMutationError extends Error {}
export function scheduledTasksChanged(): void { changes.emit("changed"); }
export function onScheduledTasksChanged(listener: () => void): () => void {
  changes.on("changed", listener);
  return () => { changes.off("changed", listener); };
}
