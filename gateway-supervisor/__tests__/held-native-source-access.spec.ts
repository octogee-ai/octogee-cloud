import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { requireHeldSourceMaintenance } from "../lib/held-native-source-reconcile.js";

describe("admission on a dedicated source under active maintenance", () => {
  it.each([
    ["POST", "/restore/owner-vm", true, false],
    ["POST", "/resume/owner-vm", true, false],
    ["POST", "/held-native-source-reconcile/other", true, false],
    ["POST", "/held-native-source-reconcile/owner-vm", true, true],
    ["GET", "/health", true, true],
    ["POST", "/resume/owner-vm", false, true],
  ])("%s %s during hold=%s", (method, path, held, allowed) => {
    const next = vi.fn(), json = vi.fn(), status = vi.fn(() => ({ json }));
    const handler = requireHeldSourceMaintenance("owner-vm", () => Boolean(held));
    handler({ method, path } as Request, { status } as unknown as Response, next);
    expect(next.mock.calls.length).toBe(allowed ? 1 : 0);
    if (!allowed) expect(status).toHaveBeenCalledWith(409);
  });
});
