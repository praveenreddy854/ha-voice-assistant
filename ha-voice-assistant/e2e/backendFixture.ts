import type { Page } from "@playwright/test";

export async function mockBackend(page: Page): Promise<void> {
  await page.route("**/api/**", async (route) => {
    if (route.request().url().includes("announcements/stream")) {
      await route.fulfill({ contentType: "text/event-stream", body: ": connected\n\n" });
    } else if (route.request().url().includes("vacuum-status")) {
      await route.fulfill({ json: { state: "docked", attributes: { status: "Charging" } } });
    } else {
      await route.fulfill({ json: { tasks: [], success: true, data: {} } });
    }
  });
}
