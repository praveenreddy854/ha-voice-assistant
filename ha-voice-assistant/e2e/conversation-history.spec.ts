import { expect, test } from "@playwright/test";
import { mockBackend } from "./backendFixture";

test("follow-up context survives reloads and each message expires after five minutes", async ({ page }) => {
  await mockBackend(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  type HistoryItem = { role: string; content: string; createdAt: number };
  const connections: Array<Array<{ type: string; text?: string; history?: HistoryItem[] }>> = [];
  await page.routeWebSocket("**/api/realtime-chat", (socket) => {
    const messages: (typeof connections)[number] = [];
    connections.push(messages);
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      messages.push(message);
      if (message.type === "user_text") {
        socket.send(JSON.stringify({ type: "response_done", fullText: `Answer to: ${message.text}` }));
      }
    });
    socket.send(JSON.stringify({ type: "session_ready" }));
  });
  await page.clock.install();
  await page.goto("/");
  const send = async (text: string) => {
    await page.getByPlaceholder("Type a command...").fill(text);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByText(`Answer to: ${text}`, { exact: true })).toBeVisible();
  };

  await send("Turn on the bedroom light");
  const original = connections[0].at(-1)!.history!;
  expect(original.map((item) => item.content)).toEqual([
    "Turn on the bedroom light", "Answer to: Turn on the bedroom light",
  ]);
  await page.clock.fastForward(4 * 60_000);
  await page.reload();
  await send("Turn it off");
  expect(connections[1][0]).toEqual({ type: "conversation_history", history: original, sentAt: expect.any(Number) });
  expect(connections[1][1]).toEqual({ type: "user_text", text: "Turn it off" });

  await page.clock.fastForward(60_001);
  await page.reload();
  await send("Turn it back on");
  const restored = connections[2][0].history!;
  expect(restored.map((item) => item.content)).toEqual([
    "Turn it off", "Answer to: Turn it off",
  ]);
  expect(errors).toEqual([]);
});
