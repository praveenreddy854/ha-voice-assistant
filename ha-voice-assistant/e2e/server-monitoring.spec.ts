import { expect, test } from "@playwright/test";
import { mockBackend } from "./backendFixture";

test("dashboard no longer installs device-specific browser monitoring", async ({ page }) => {
  await mockBackend(page);
  const deviceRequests: string[] = [];
  page.on("request", request => {
    if (/\/(laundry|vacuum)-status/.test(request.url())) deviceRequests.push(request.url());
  });
  await page.clock.install();
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Open Teaching Mode" })).toBeVisible();
  await expect(page.getByText("Laundry Monitor", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Vacuum Monitor", { exact: true })).toHaveCount(0);
  await page.clock.fastForward(60 * 60_000);
  expect(deviceRequests).toEqual([]);
});
