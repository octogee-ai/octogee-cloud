import { describe, expect, it, vi, type Mock } from "vitest";

const h = vi.hoisted(() => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock("./logging.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./logging.js")>(),
  logger: h.logger,
}));

const { errorHandler } = await import("./errors.js");

interface RecordingResponse {
  status: Mock<(code: number) => RecordingResponse>;
  json: Mock<(body: unknown) => RecordingResponse>;
}

function response(): RecordingResponse {
  const res: RecordingResponse = {
    status: vi.fn<(code: number) => RecordingResponse>(() => res),
    json: vi.fn<(body: unknown) => RecordingResponse>(() => res),
  };
  return res;
}

describe("errorHandler", () => {
  it("maps known auth and authorization errors to their HTTP status", () => {
    const res = response();

    errorHandler(
      new Error("Admin access required"),
      { path: "/admin", method: "POST" } as never,
      res as never,
      vi.fn(),
    );

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: "Admin access required" });
    expect(h.logger.error).not.toHaveBeenCalled();
  });

  it("logs unexpected errors and returns 500", () => {
    const res = response();
    const err = new Error("database unavailable");

    errorHandler(
      err,
      { path: "/api/probe", method: "GET" } as never,
      res as never,
      vi.fn(),
    );

    expect(h.logger.error).toHaveBeenCalledWith("Unhandled error: database unavailable", {
      path: "/api/probe",
      method: "GET",
      stack: expect.any(String),
    });
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "database unavailable" });
  });

  it("redacts an unconsumed OpenClaw launch ticket when its broker fails", () => {
    const res = response();
    const ticket = "a".repeat(43);
    const err = new Error("OpenClaw Control ticket broker returned 409");

    errorHandler(
      err,
      { path: `/api/g/walter/openclaw/launch/${ticket}`, method: "GET" } as never,
      res as never,
      vi.fn(),
    );

    expect(h.logger.error).toHaveBeenLastCalledWith(
      "Unhandled error: OpenClaw Control ticket broker returned 409",
      {
        path: "/api/g/walter/openclaw/launch/<redacted>",
        method: "GET",
        stack: expect.any(String),
      },
    );
    expect(JSON.stringify(h.logger.error.mock.calls)).not.toContain(ticket);
  });
});
