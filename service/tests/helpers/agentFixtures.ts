import assert from "node:assert/strict";

export function configureTestProviders(): void {
  process.env.AZURE_OPENAI_API_KEY = "test-key";
  process.env.AZURE_OPENAI_RESOURCE_NAME = "test-resource";
  process.env.AI_MODEL_ADVANCED = "test-model";
  process.env.HOME_ASSISTANT_URL = "http://ha.invalid";
  process.env.HOME_ASSISTANT_TOKEN = "test-token";
  // Tests opt into a mocked Cosmos implementation explicitly when needed.
  process.env.AZURE_COSMOS_ENDPOINT = "";
  process.env.AZURE_COSMOS_KEY = "";
  process.env.AZURE_COSMOS_DATABASE = "";
  process.env.AZURE_COSMOS_CONTAINER = "";
}

export interface ModelRequest {
  input: Array<{ role?: string; content?: string | Array<{ text?: string }> }>;
}

export function readModelRequest(url: string | URL | Request, init?: RequestInit): ModelRequest {
  assert.match(String(url), /^https:\/\/test-resource\.openai\.azure\.com\//);
  return JSON.parse(String(init?.body)) as ModelRequest;
}

export function messageText(request: ModelRequest, role: string): string {
  const content = request.input.find((item) => item.role === role)?.content;
  return typeof content === "string" ? content : content?.map((part) => part.text ?? "").join("\n") ?? "";
}

export function toolResponse(name: string, args: unknown, id = "test-call"): Response {
  return Response.json({
    id: `response-${id}`,
    created_at: 1,
    model: "test-model",
    output: [{ type: "function_call", id: `item-${id}`, call_id: id, name, arguments: JSON.stringify(args) }],
    usage: { input_tokens: 10, output_tokens: 5 },
  });
}

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = () => done(); });
  return { promise, resolve };
}
