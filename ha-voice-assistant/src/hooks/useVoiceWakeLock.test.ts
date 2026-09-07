import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useVoiceWakeLock } from "./useVoiceWakeLock";

afterEach(() => vi.unstubAllGlobals());

test("holds a wake lock only while enabled and reacquires it after returning to the page", async () => {
  const lock = { released: false, release: vi.fn(async () => { lock.released = true; }) };
  const request = vi.fn(async () => { lock.released = false; return lock; });
  vi.stubGlobal("navigator", { wakeLock: { request } });
  const { rerender, unmount } = renderHook(({ enabled }) => useVoiceWakeLock(enabled), { initialProps: { enabled: false } });
  expect(request).not.toHaveBeenCalled();
  await act(async () => rerender({ enabled: true }));
  expect(request).toHaveBeenCalledWith("screen");
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(request).toHaveBeenCalledTimes(1);
  lock.released = true;
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(request).toHaveBeenCalledTimes(2);
  await act(async () => rerender({ enabled: false }));
  expect(lock.release).toHaveBeenCalledTimes(1);
  document.dispatchEvent(new Event("visibilitychange"));
  expect(request).toHaveBeenCalledTimes(2);
  unmount();
});

test("a wake lock granted after Stop is released immediately", async () => {
  const lock = { released: false, release: vi.fn(async () => {}) };
  let grant!: (value: typeof lock) => void;
  const request = vi.fn(() => new Promise<typeof lock>((resolve) => { grant = resolve; }));
  vi.stubGlobal("navigator", { wakeLock: { request } });
  const { unmount } = renderHook(() => useVoiceWakeLock(true));
  unmount();
  await act(async () => grant(lock));
  expect(lock.release).toHaveBeenCalledTimes(1);
});

test("a denied wake lock does not crash the assistant", async () => {
  const request = vi.fn(async () => { throw new Error("Battery saver"); });
  vi.stubGlobal("navigator", { wakeLock: { request } });
  const { unmount } = renderHook(() => useVoiceWakeLock(true));
  await act(async () => {});
  expect(request).toHaveBeenCalledTimes(1);
  unmount();
});
