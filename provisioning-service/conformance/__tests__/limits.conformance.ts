import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dsn, spec, startImplementation, TOKENS, type Implementation } from "./harness.js";

describe.skipIf(!dsn)("provisioning service per-caller limits", { timeout: 120_000 }, () => {
  let implementation: Implementation;

  beforeAll(async () => {
    implementation = await startImplementation({ environment: { PROVISIONING_CALLER_REQUESTS_PER_MINUTE: "2" } });
  }, 120_000);

  afterAll(async () => {
    await implementation?.stop();
  });

  it("answers 429 rate-limited with Retry-After to the caller over its limit, writes nothing, and keeps serving other callers and probes", async () => {
    expect((await implementation.request("GET", "/v1/provisionings")).status).toBe(200);
    expect((await implementation.request("GET", "/v1/provisionings")).status).toBe(200);
    const refused = await implementation.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
    expect(refused.status).toBe(429);
    expect(refused.body).toEqual({ code: "rate-limited", error: expect.any(String) });
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await implementation.request("GET", "/v1/users/u1/provisioning", { token: TOKENS.platformApi })).status).toBe(404);
    for (const path of ["/healthz", "/readyz", "/readyz"]) {
      expect((await fetch(`${implementation.url}${path}`)).status).toBe(200);
    }
  });
});
