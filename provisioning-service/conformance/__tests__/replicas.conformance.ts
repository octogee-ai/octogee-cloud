import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { condition, dsn, spec, startImplementation, type Implementation } from "./harness.js";

describe.skipIf(!dsn)("provisioning service conformance with several replicas", { timeout: 240_000 }, () => {
  let implementation: Implementation;

  beforeAll(async () => {
    implementation = await startImplementation({ replicas: 2 });
  }, 120_000);

  afterAll(async () => {
    await implementation?.stop();
  });

  it("loses no work when a replica is killed while attempts may be running", async () => {
    const uids = Array.from({ length: 60 }, (_, index) => `kill-${index}`);
    await Promise.all(uids.map((uid, index) => implementation.request("PUT", `/v1/users/${uid}/provisioning`, { body: { spec: spec(uid) }, replica: index % 2 })));
    implementation.replicas[1].process.kill("SIGKILL");

    for (const uid of uids) {
      const response = await implementation.request("GET", `/v1/users/${uid}/provisioning?waitForGeneration=1&timeoutSeconds=150`);
      expect(response.status).toBe(200);
      expect(response.body.status.observedGeneration).toBe(1);
      expect(condition(response.body, "Ready")).toMatchObject({ status: "True" });
    }
  });
});
