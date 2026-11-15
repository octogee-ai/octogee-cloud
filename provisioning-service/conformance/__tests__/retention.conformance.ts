import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dsn, spec, startImplementation, type Implementation } from "./harness.js";

describe.skipIf(!dsn)("provisioning service change retention", { timeout: 120_000 }, () => {
  let implementation: Implementation;

  beforeAll(async () => {
    implementation = await startImplementation({ environment: { PROVISIONING_CHANGE_RETENTION_SECONDS: "2" } });
  }, 120_000);

  afterAll(async () => {
    await implementation?.stop();
  });

  it("answers 410 resource-version-expired for a version whose changes have left the retained window, and serves a version inside it", async () => {
    const from = (await implementation.request("GET", "/v1/provisionings")).body.resourceVersion;
    expect((await implementation.request("PUT", "/v1/users/old-1/provisioning", { body: { spec: spec("old-1") } })).status).toBe(201);
    let response = await implementation.request("GET", `/v1/provisionings?watch=true&resourceVersion=${from}&timeoutSeconds=0`);
    expect(response.status).toBe(200);
    for (let tries = 0; response.status === 200 && tries < 60; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      response = await implementation.request("GET", `/v1/provisionings?watch=true&resourceVersion=${from}&timeoutSeconds=0`);
    }
    expect(response.status).toBe(410);
    expect(response.body).toEqual({ code: "resource-version-expired", error: expect.any(String) });
    const current = (await implementation.request("GET", "/v1/provisionings")).body.resourceVersion;
    expect((await implementation.request("GET", `/v1/provisionings?watch=true&resourceVersion=${current}&timeoutSeconds=0`)).status).toBe(200);
  });
});
