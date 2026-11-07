import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  /** Server receipt of the complete request, before model, queue or tool latency. */
  receivedAt: string;
  jobId?: string;
  originSessionId?: string;
}
const requests = new AsyncLocalStorage<RequestContext>();
export const getRequestContext = () => requests.getStore();
export function withRequestContext<T>(receivedAt: string, callback: () => T, links: Omit<RequestContext, "receivedAt"> = {}): T {
  if (!Number.isFinite(Date.parse(receivedAt))) throw new Error("Invalid server request timestamp");
  return requests.run({ ...requests.getStore(), ...links, receivedAt }, callback);
}
