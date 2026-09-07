import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { createAppleShortcutRouter } from "../src/appleShortcutRouter";
import {
  TextAssistantSessionManager,
  type TextAssistantSessionService,
  type TextAssistantSessionSnapshot,
} from "../src/textAssistantSessions";

function snapshot(
  conversationId: string,
  status: TextAssistantSessionSnapshot["status"] = "running"
): TextAssistantSessionSnapshot {
  return {
    conversationId,
    status,
    message: status === "running" ? "On it." : "Done.",
    createdAt: new Date(0).toISOString(),
    expiresAt: new Date(120_000).toISOString(),
    pollAfterMs: status === "running" ? 2_000 : undefined,
  };
}

function fakeSessions(): TextAssistantSessionService {
  const sessions = new Set<string>();
  return {
    start() {
      sessions.add("conversation-1");
      return snapshot("conversation-1");
    },
    get(_scopeId, conversationId) {
      return sessions.has(conversationId)
        ? snapshot(conversationId)
        : undefined;
    },
    submitInput(_scopeId, conversationId) {
      return sessions.has(conversationId)
        ? snapshot(conversationId)
        : undefined;
    },
    cancel(_scopeId, conversationId) {
      return sessions.has(conversationId)
        ? snapshot(conversationId, "cancelled")
        : undefined;
    },
  };
}

async function withServer(
  run: (baseUrl: string) => Promise<void>,
  rateLimitPerMinute = 120,
  sessions: TextAssistantSessionService = fakeSessions()
): Promise<void> {
  const app = express();
  app.use(createAppleShortcutRouter({ sessions, rateLimitPerMinute }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
}

test("starts, polls, answers, and cancels without authentication", async () => {
  await withServer(async (baseUrl) => {
    const headers = { "content-type": "application/json" };
    const created = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ command: "turn on the bathroom light" }),
    });
    assert.equal(created.status, 202);
    const body = (await created.json()) as TextAssistantSessionSnapshot;
    assert.equal(body.conversationId, "conversation-1");
    assert.equal(created.headers.get("cache-control"), "no-store");

    const polled = await fetch(
      `${baseUrl}/sessions/${body.conversationId}`
    );
    assert.equal(polled.status, 200);

    const answered = await fetch(
      `${baseUrl}/sessions/${body.conversationId}/input`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ answer: "yes" }),
      }
    );
    assert.equal(answered.status, 202);

    const cancelled = await fetch(
      `${baseUrl}/sessions/${body.conversationId}`,
      { method: "DELETE" }
    );
    assert.equal(cancelled.status, 200);
    assert.equal(
      ((await cancelled.json()) as TextAssistantSessionSnapshot).status,
      "cancelled"
    );
  });
});

test("rejects malformed input and rate-limit excess", async () => {
  await withServer(
    async (baseUrl) => {
      const headers = { "content-type": "application/json" };
      const malformed = await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers,
        body: "{",
      });
      assert.equal(malformed.status, 400);

      const limited = await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ command: "test" }),
      });
      assert.equal(limited.status, 429);
      assert.equal(limited.headers.get("retry-after"), "60");
    },
    1
  );
});

test("rejects oversized commands and request bodies", async () => {
  await withServer(async (baseUrl) => {
    const headers = { "content-type": "application/json" };
    const commandTooLong = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ command: "x".repeat(2_001) }),
    });
    assert.equal(commandTooLong.status, 400);

    const bodyTooLarge = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ command: "x".repeat(20_000) }),
    });
    assert.equal(bodyTooLarge.status, 413);
  });
});

test("routes a command through a mocked Text Assistant executor", async () => {
  const commands: string[] = [];
  const sessions = new TextAssistantSessionManager({
    executor: async (options) => {
      commands.push(options.command);
      return { success: false, message: "Mock execution complete." };
    },
    sessionTtlMs: 1_000,
  });

  await withServer(
    async (baseUrl) => {
      const headers = { "content-type": "application/json" };
      const created = await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ command: "turn on the bathroom light" }),
      });
      const body = (await created.json()) as TextAssistantSessionSnapshot;

      let result: TextAssistantSessionSnapshot | undefined;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const response = await fetch(
          `${baseUrl}/sessions/${body.conversationId}`
        );
        result = (await response.json()) as TextAssistantSessionSnapshot;
        if (result.status === "failed") break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      assert.deepEqual(commands, ["turn on the bathroom light"]);
      assert.equal(result?.status, "failed");
      assert.equal(result?.message, "Mock execution complete.");
    },
    120,
    sessions
  );
});
