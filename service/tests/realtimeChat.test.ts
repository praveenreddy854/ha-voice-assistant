import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import test from "node:test";

const requireModule = createRequire(__filename);
type Message = Record<string, any>;

/** Exercise the proxy's real event handlers without Azure or household devices. */
function proxyFixture(run = async (..._args: any[]): Promise<string> => "Done.") {
  class Socket extends EventEmitter {
    static OPEN = 1;
    static CONNECTING = 0;
    static azure: Socket;
    readyState = 1;
    sent: Message[] = [];
    constructor(public url?: string, public options?: { headers: Record<string, string> }) {
      super();
      if (url) Socket.azure = this;
    }
    send(raw: string) { this.sent.push(JSON.parse(raw)); }
    receive(event: Message) { this.emit("message", Buffer.from(JSON.stringify(event))); }
    close() { this.readyState = 3; }
  }
  class SocketServer extends EventEmitter {
    static instance: SocketServer;
    constructor() { super(); SocketServer.instance = this; }
  }
  let tvCallbacks: Message = {};
  const stubs: Record<string, unknown> = {
    ws: Object.assign(Socket, { WebSocketServer: SocketServer }),
    "../src/config": { AI_MODEL_LIVE: "test-live", AI_MODEL_ADVANCED: "test-advanced", GPT_LIVE_VOICE: "marin", AZURE_OPENAI_RESOURCE_NAME: "test-resource", AZURE_OPENAI_API_KEY: "test-key" },
    "../src/tvJobManager": { startTvAgentJob: (_prompt: string, callbacks: Message) => { tvCallbacks = callbacks; return { jobId: "tv-job" }; } },
    "../src/activeRunManager": { getActiveRun: () => undefined },
    "../src/tracing": { getTracer: () => ({ startSpan: () => ({ setAttribute() {}, end() {} }) }) },
    "../src/memory": { getPromptMemoryContext: async () => "", recordMemoryInteraction() {} },
    "../src/ha": {},
    "../src/agents/core": {},
    "../src/liveVoiceAgent": { runLiveVoiceAgent: run },
  };
  const previous = new Map<string, NodeModule | undefined>();
  const proxyPath = requireModule.resolve("../src/realtimeChat");
  previous.set(proxyPath, requireModule.cache[proxyPath]);
  delete requireModule.cache[proxyPath];
  try {
    for (const [name, exports] of Object.entries(stubs)) {
      const path = requireModule.resolve(name);
      previous.set(path, requireModule.cache[path]);
      requireModule.cache[path] = { id: path, filename: path, loaded: true, exports } as NodeModule;
    }
    const { setupRealtimeChatProxy } = requireModule("../src/realtimeChat");
    setupRealtimeChatProxy(new EventEmitter());
    const client = new Socket();
    SocketServer.instance.emit("connection", client);
    const azure = Socket.azure;
    azure.emit("open");
    azure.receive({ type: "session.started" });
    client.sent = [];
    return { client, azure, getTvCallbacks: () => tvCallbacks };
  } finally {
    for (const [path, cached] of previous) {
      if (cached) requireModule.cache[path] = cached;
      else delete requireModule.cache[path];
    }
  }
}

function cleanup(fixture: ReturnType<typeof proxyFixture>) {
  fixture.client.emit("close");
  fixture.azure.emit("close");
}

test("GPT Live starts with client delegation and no managed backend model", () => {
  const fixture = proxyFixture();
  const { azure } = fixture;
  assert.equal(new URL(azure.url!).pathname, "/openai/v1/live/sessions");
  assert.equal(new URL(azure.url!).search, "");
  const start = azure.sent[0];
  assert.equal(start.type, "session.start");
  assert.equal(start.session.model, "test-live");
  assert.deepEqual(start.session.audio, { output: { voice: "marin" } });
  assert.deepEqual(start.session.delegation, { type: "client" });
  assert.equal(start.session.tools, undefined);
  cleanup(fixture);
});

test("continuous audio and interleaved transcripts reach the browser", () => {
  const fixture = proxyFixture();
  const { client, azure } = fixture;
  azure.receive({ type: "session.output_audio.delta", delta: "audio", start_ms: 20, end_ms: 40 });
  azure.receive({ type: "session.input_transcript.delta", delta: "Hello" });
  azure.receive({ type: "session.output_transcript.delta", delta: "Hi" });
  assert.deepEqual(client.sent, [
    { type: "audio_delta", audio: "audio", startMs: 20, endMs: 40 },
    { type: "transcript_delta", text: "Hi" },
  ]);
  client.receive({ type: "input_audio", audio: "AA==" });
  assert.deepEqual(azure.sent.at(-1), { type: "session.input_audio.append", audio: "AA==" });
  cleanup(fixture);
});

test("client delegation runs one assembled request through the AI SDK adapter", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const requests: Message[] = [];
  const fixture = proxyFixture(async (request) => { requests.push(request); return "Done."; });
  const { azure } = fixture;
  azure.receive({ type: "session.input_transcript.delta", delta: "Turn on the lights" });
  azure.receive({ type: "session.delegation.created", delegation: { id: "d1", target: "client" } });
  t.mock.timers.tick(600);
  azure.receive({ type: "session.input_transcript.delta", delta: " actually only the bedroom" });
  t.mock.timers.tick(799);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 0);
  t.mock.timers.tick(1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].command, "Turn on the lights actually only the bedroom");
  azure.receive({ type: "session.delegation.created", delegation: { id: "d1", target: "client" } });
  assert.deepEqual(azure.sent.at(-1), { type: "session.commentary.append", delegation_id: "d1", content: "Done." });
  assert.ok(!azure.sent.some((event) => event.type.startsWith("response.")));
  cleanup(fixture);
});

test("input mute and explicit shutdown use Live lifecycle events", () => {
  const fixture = proxyFixture();
  const { client, azure } = fixture;
  client.receive({ type: "input_end" });
  assert.equal(azure.sent.at(-1)?.type, "session.input_audio.mute");
  client.receive({ type: "input_start" });
  assert.equal(azure.sent.at(-1)?.type, "session.input_audio.unmute");
  client.emit("close");
  assert.equal(azure.sent.at(-1)?.type, "session.close");
  azure.emit("close");
});

test("wake-word text uses the AI SDK adapter and a general context result", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const commands: string[] = [];
  const fixture = proxyFixture(async (request) => { commands.push(request.command); return "On it."; });
  fixture.client.receive({ type: "user_text", text: "turn on the light" });
  t.mock.timers.tick(800);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(commands, ["turn on the light"]);
  assert.equal(fixture.azure.sent.at(-1)?.type, "session.commentary.append");
  assert.equal(fixture.azure.sent.at(-1)?.delegation_id, null);
  assert.ok(!fixture.azure.sent.some((event) => event.type.startsWith("response.")));
  cleanup(fixture);
});

test("Live startup errors reach the browser", () => {
  const fixture = proxyFixture();
  fixture.azure.receive({ type: "error", error: { message: "Deployment not found" } });
  assert.deepEqual(fixture.client.sent, [{ type: "error", message: "Deployment not found" }]);
  cleanup(fixture);
});

test("input transcript fragments are grouped for display rather than treated as commands", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fixture = proxyFixture();
  fixture.azure.receive({ type: "session.input_transcript.delta", delta: "Turn on " });
  fixture.azure.receive({ type: "session.input_transcript.delta", delta: "the light" });
  assert.deepEqual(fixture.client.sent, []);
  t.mock.timers.tick(800);
  assert.deepEqual(fixture.client.sent, [{ type: "user_transcript", text: "Turn on the light" }]);
  assert.ok(!fixture.azure.sent.some((event) => event.type === "response.create"));
  cleanup(fixture);
});

test("async job completion keeps its delegation ID and follows the acceptance acknowledgement", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let fixture!: ReturnType<typeof proxyFixture>;
  fixture = proxyFixture(async (_request, _instructions, _tools, execute) => {
    await execute("start_tv_agent", { prompt: "Play Netflix" });
    fixture.getTvCallbacks().onComplete("Done.");
    return "On it.";
  });
  fixture.azure.receive({ type: "session.input_transcript.delta", delta: "Play Netflix" });
  fixture.azure.receive({ type: "session.delegation.created", delegation: { id: "tv-delegation", target: "client" } });
  t.mock.timers.tick(800);
  await new Promise((resolve) => setImmediate(resolve));
  const commentary = fixture.azure.sent.filter((event) => event.type === "session.commentary.append");
  assert.equal(commentary[0].content, "On it.");
  assert.ok(commentary.length > 1);
  assert.ok(commentary.every((event) => event.delegation_id === "tv-delegation"));
  cleanup(fixture);
});

test("a protected opening still requires confirmation before a job is started", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let output = "";
  const fixture = proxyFixture(async (_request, _instructions, _tools, execute) => {
    output = await execute("execute_home_assistant_command", { command: "open the garage" });
    return "Please confirm: open the garage?";
  });
  fixture.client.receive({ type: "user_text", text: "open the garage" });
  t.mock.timers.tick(800);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(output, /confirmation_required/);
  assert.ok(!fixture.client.sent.some((event) => event.type === "async_job_started"));
  cleanup(fixture);
});

test("a disconnected session cannot speak a late async result into the next session", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fixture = proxyFixture(async (_request, _instructions, _tools, execute) => {
    await execute("start_tv_agent", { prompt: "Play Netflix" });
    return "On it.";
  });
  fixture.client.receive({ type: "user_text", text: "Play Netflix" });
  t.mock.timers.tick(800);
  await new Promise((resolve) => setImmediate(resolve));
  const callbacks = fixture.getTvCallbacks();
  cleanup(fixture);
  fixture.azure.sent = [];
  fixture.client.sent = [];
  callbacks.onComplete("Late result");
  assert.deepEqual(fixture.azure.sent, []);
  assert.deepEqual(fixture.client.sent, []);
});

test("muted sessions stay open while live output is still streaming", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fixture = proxyFixture();
  fixture.azure.receive({ type: "session.output_audio.delta", delta: "audio" });
  fixture.client.receive({ type: "input_end" });
  // Continue output past the backend's five-second idle-close deadline.
  for (let elapsed = 0; elapsed < 7000; elapsed += 1000) {
    t.mock.timers.tick(1000);
    fixture.azure.receive({ type: "session.output_audio.delta", delta: "more audio" });
  }
  assert.ok(!fixture.azure.sent.some((event) => event.type === "session.close"));
  t.mock.timers.tick(1200);
  assert.ok(fixture.client.sent.some((event) => event.type === "response_done"));
  t.mock.timers.tick(5000);
  assert.equal(fixture.azure.sent.at(-1)?.type, "session.close");
  cleanup(fixture);
});
