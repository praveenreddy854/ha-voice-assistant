import { afterEach, expect, test, vi } from "vitest";
import { cancelScheduledTask } from "./scheduledTasks";

afterEach(() => vi.unstubAllGlobals());
test("unsuccessful server cancellation remains visible as a failure", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: false }) }));
  const result = await cancelScheduledTask("phase-2", "family");
  expect(result.success).toBe(false); expect(result.errorMessage).toContain("could not be cancelled");
});
test("successful sequence cancellation uses only the server API", async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
  vi.stubGlobal("fetch", fetch);
  expect((await cancelScheduledTask("phase-2", "family")).success).toBe(true);
  expect(fetch).toHaveBeenCalledWith("http://localhost:3005/api/scheduled-tasks/phase-2?recurrenceFamilyId=family", { method: "DELETE" });
});
