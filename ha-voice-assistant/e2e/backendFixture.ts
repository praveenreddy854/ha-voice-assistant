import type { Page } from "@playwright/test";

export async function mockBackend(page: Page): Promise<void> {
  await page.route("**/api/**", async (route) => {
    if (route.request().url().includes("announcements/stream")) {
      await route.fulfill({ contentType: "text/event-stream", body: ": connected\n\n" });
    } else {
      await route.fulfill({ json: { tasks: [], success: true, data: {} } });
    }
  });
}
