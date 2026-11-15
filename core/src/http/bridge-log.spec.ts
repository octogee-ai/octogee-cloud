import { describe, expect, it, vi } from "vitest";
import { createBridgeLog } from "./bridge-log.js";

describe("bridge lifecycle logging", () => {
  it.each([
    "[mm-proxy/ws] upstream open (mmUserId=user-1)",
    "[mm-proxy/ws] authenticated mmUserId=user-1",
  ])("emits normal lifecycle state at info severity: %s", (message) => {
    const info = vi.fn();
    const warn = vi.fn();
    const log = createBridgeLog({
      now: () => new Date("2026-08-12T12:00:00.000Z"),
      info,
      warn,
    });

    log(message);

    expect(info).toHaveBeenCalledWith(`2026-08-12T12:00:00.000Z ${message}`);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    "[mm-proxy/ws] upstream error: reset",
    "[mm-proxy/ws] invalid authentication frame",
    "[mm-proxy/ws] roll roster refused MM WS",
    "[activity-sink] durable write failed: boom",
  ])("keeps failures at warning severity: %s", (message) => {
    const info = vi.fn();
    const warn = vi.fn();
    const log = createBridgeLog({ info, warn });

    log(message, "warn");

    expect(warn).toHaveBeenCalledOnce();
    expect(info).not.toHaveBeenCalled();
  });
});
