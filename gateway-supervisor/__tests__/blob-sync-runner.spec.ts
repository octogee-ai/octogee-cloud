import { afterEach, expect, it, vi } from "vitest";
import { startBlobSyncLoop } from "../lib/blob-sync-runner.js";
afterEach(() => vi.useRealTimers());
it("persists blobs without a Git timer and logs failures before retrying", async () => {
  vi.useFakeTimers();
  const syncBlobs = vi.fn().mockRejectedValueOnce(new Error("upload failed")).mockResolvedValue(undefined);
  const log = vi.fn();
  const timer = startBlobSyncLoop({ syncBlobs, log }, 100);
  await vi.advanceTimersByTimeAsync(200);
  expect(syncBlobs).toHaveBeenCalledTimes(2);
  expect(log).toHaveBeenCalledWith("[blob-sync] Error: upload failed");
  clearInterval(timer);
});
it("does not overlap an unfinished blob upload", async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  const syncBlobs = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  const timer = startBlobSyncLoop({ syncBlobs, log: vi.fn() }, 100);
  await vi.advanceTimersByTimeAsync(300);
  expect(syncBlobs).toHaveBeenCalledTimes(1);
  finish();
  await vi.advanceTimersByTimeAsync(100);
  expect(syncBlobs).toHaveBeenCalledTimes(2);
  finish(); clearInterval(timer);
});
