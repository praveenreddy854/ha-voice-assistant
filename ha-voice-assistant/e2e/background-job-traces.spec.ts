import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";

test("job acceptance packets link to lifecycle traces and deep links select the requested session", async ({ page }) => {
  const script = await readFile(path.resolve(__dirname, "../../service/dist/evals/telemetryBrowser.js"), "utf8");
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("telemetry.js")) return route.fulfill({ contentType: "application/javascript", body: script });
    if (url.pathname.startsWith("/api/")) return route.fulfill({ json: { statuses: {}, agents: [], busy: false } });
    return route.fulfill({ contentType: "text/html", body: '<html><body><div class="dialog-mono">{"success":true,"jobId":"background-123"}</div><script>window.loadTraceDetail=async id=>{window.chosenSession=id;};</script><script src="/dashboards/evals/telemetry.js" defer></script></body></html>' });
  });
  await page.goto("http://127.0.0.1:4174/telemetry?sessionId=job-background-123");
  await expect(page.getByRole("link", { name: "Open background job trace" })).toHaveAttribute("href", "/telemetry?sessionId=job-background-123");
  expect(await page.evaluate(() => (window as any).chosenSession)).toBe("job-background-123");
});
