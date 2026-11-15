import { describe, expect, it } from "vitest";
import { HostError, hostErrorKind, hostErrorKindForStatus } from "./host-error.js";

describe("host error classification", () => {
  it("treats 429 and 5xx as transient and other 4xx as terminal", () => {
    expect([429, 500, 502, 503].map(hostErrorKindForStatus)).toEqual(["transient", "transient", "transient", "transient"]);
    expect([400, 403, 404, 409, 422].map(hostErrorKindForStatus)).toEqual(["terminal", "terminal", "terminal", "terminal", "terminal"]);
  });

  it("treats an error that is not a HostError, such as a connection reset, as transient", () => {
    expect(hostErrorKind(new Error("ECONNRESET"))).toBe("transient");
    expect(hostErrorKind(new HostError("terminal", "username rejected"))).toBe("terminal");
  });
});
