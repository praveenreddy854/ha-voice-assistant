import { expect, test } from "@playwright/test";
import { mockBackend } from "./backendFixture";

test("loads the assistant and scheduled-task views without browser errors", async ({
  page,
}) => {
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await mockBackend(page);
  const response = await page.goto("/", { waitUntil: "networkidle" });
  expect(response?.ok()).toBe(true);
  await expect(page).toHaveTitle("HA Voice Assistant");
  expect(browserErrors).toEqual([]);
  await expect(page.getByText("🏠 HA Voice Assistant")).toBeVisible();
  await expect(page.getByText("Voice Assistant Chat")).toBeVisible();
  await expect(
    page.getByText('Say "Hey Assistant" or type a command below')
  ).toBeVisible();

  await page.getByRole("button", { name: "Scheduled Tasks" }).click();
  await expect(
    page.getByRole("heading", { name: "Scheduled Tasks" })
  ).toBeVisible();
  await expect(page.getByText("No scheduled tasks.")).toBeVisible();

  await page.getByRole("button", { name: "Assistant" }).click();
  await expect(page.getByText("Voice Assistant Chat")).toBeVisible();

  if (process.env.E2E_SCREENSHOT_PATH) {
    await page.screenshot({
      path: process.env.E2E_SCREENSHOT_PATH,
      fullPage: true,
    });
  }

  expect(browserErrors).toEqual([]);
});
