import http from "node:http";
import https from "node:https";

export function networkAllowed(url: URL, method: string, headers: Record<string, unknown>, modelHost: string, cosmosHost?: string): boolean {
  if (url.protocol !== "https:" || (url.port && url.port !== "443") || url.username || url.password) return false;
  if (url.hostname === modelHost && url.pathname.startsWith("/openai/")) return true;
  if (cosmosHost && url.hostname === cosmosHost) {
    if (["GET", "HEAD"].includes(method.toUpperCase())) return true;
    const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value).toLowerCase()]));
    // The Cosmos SDK requests a read-only query plan before executing cross-partition queries.
    // That POST uses a different marker from the query itself; neither permits document writes.
    return method.toUpperCase() === "POST" && /^\/dbs\/[^/]+\/colls\/[^/]+\/docs\/?$/.test(url.pathname) &&
      normalized["content-type"]?.split(";", 1)[0].trim() === "application/query+json" &&
      (normalized["x-ms-documentdb-isquery"] === "true" || normalized["x-ms-cosmos-is-query-plan-request"] === "true");
  }
  return false;
}
/** Install before importing live tool modules. Only the worker calls this. */
export function installNetworkBoundary(modelHost: string, cosmosHost?: string): void {
  const assert = (url: URL, method = "GET", headers: Record<string, unknown> = {}) => {
    if (!networkAllowed(url, method, headers, modelHost, cosmosHost)) throw new Error(`Offline eval blocked network access to ${url.origin}${url.pathname}`);
  };
  const fetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = Object.fromEntries(new Headers(init?.headers || (input instanceof Request ? input.headers : undefined)).entries());
    assert(url, init?.method || (input instanceof Request ? input.method : "GET"), headers);
    const response = await fetch(input, { ...init, redirect: "error" });
    return response;
  };
  for (const transport of [http, https]) {
    const request = transport.request;
    transport.request = ((...args: unknown[]) => {
      const first = args[0];
      const options = (typeof first === "object" && !(first instanceof URL) ? first : typeof args[1] === "object" ? args[1] : {}) as http.RequestOptions;
      const url = first instanceof URL ? new URL(first) : typeof first === "string" ? new URL(first) :
        new URL(`${options.protocol || (transport === https ? "https:" : "http:")}//${options.hostname || options.host}${options.port ? `:${options.port}` : ""}${options.path || "/"}`);
      assert(url, options.method, options.headers as Record<string, unknown>);
      return Reflect.apply(request, transport, args);
    }) as typeof transport.request;
    transport.get = ((...args: unknown[]) => { const result = Reflect.apply(transport.request, transport, args); result.end(); return result; }) as typeof transport.get;
  }
}
