import { describe, test, expect } from "vitest";
import { classifyHttp } from "../model-credentials/anthropic-probe.js";

describe("classifyHttp", () => {
  test("401 Unauthorized = user (bad/revoked key)", () => {
    expect(classifyHttp(401)).toBe("user");
  });

  test("403 Forbidden = user (no permission for this account)", () => {
    expect(classifyHttp(403)).toBe("user");
  });

  test("429 Too Many Requests = transient (don't blame the user)", () => {
    expect(classifyHttp(429)).toBe("transient");
  });

  test("500 Internal Server Error = transient", () => {
    expect(classifyHttp(500)).toBe("transient");
  });

  test("502, 503, 504 = transient", () => {
    expect(classifyHttp(502)).toBe("transient");
    expect(classifyHttp(503)).toBe("transient");
    expect(classifyHttp(504)).toBe("transient");
  });

  test("400 Bad Request = user (we sent something we shouldn't, but the user-facing surface should still 4xx)", () => {
    expect(classifyHttp(400)).toBe("user");
  });

  test("404 = user (model name typo, etc.)", () => {
    expect(classifyHttp(404)).toBe("user");
  });

  test("any 5xx (e.g. 599) = transient (defensive default)", () => {
    expect(classifyHttp(599)).toBe("transient");
  });
});
