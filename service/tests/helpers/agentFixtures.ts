import assert from "node:assert/strict";

export function configureTestProviders(): void {
  process.env.AZURE_OPENAI_API_KEY_EUS = "test-key";
  process.env.AZURE_OPENAI_RESOURCE_NAME_EUS = "test-resource";
  process.env.AZURE_OPENAI_API_KEY_EUS2 = "second-test-key";
  process.env.AZURE_OPENAI_RESOURCE_NAME_EUS2 = "second-test-resource";
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
  // The SDK serializes system instructions as developer messages for reasoning models.
  const content = request.input.find(item => item.role === role || (role === "system" && item.role === "developer"))?.content;
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
