import { describe, expect, it, vi } from "vitest";
import { startAfterSurgeReadiness } from "../lib/surge-reconcile-gate.js";

describe("surge reconcile gate", () => {
  it("does not start user reconcile until the pod handoff marker is released", async () => {
    let released = false;
    let retry: (() => void) | null = null;
    const stopInner = vi.fn();
    const start = vi.fn(() => stopInner);
    const stop = startAfterSurgeReadiness({
      released: async () => released,
      start,
      schedule: (callback) => {
        retry = callback;
        return vi.fn();
      },
      log: vi.fn(),
    });
    await vi.waitFor(() => expect(retry).not.toBeNull());
    expect(start).not.toHaveBeenCalled();

    released = true;
    retry?.();
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());

    stop();
    expect(stopInner).toHaveBeenCalledOnce();
  });

});
