import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { condition, dsn, spec, startImplementation, type Implementation } from "./harness.js";

async function gauge(url: string, name: string): Promise<number> {
  const text = await (await fetch(`${url}/metrics`)).text();
  const line = text.split("\n").find((candidate) => candidate.startsWith(`${name} `));
  if (!line) throw new Error(`metric ${name} is missing`);
  return Number(line.slice(name.length + 1));
}

describe.skipIf(!dsn)("provisioning service conformance with several replicas", { timeout: 240_000 }, () => {
  let implementation: Implementation;

  beforeAll(async () => {
    implementation = await startImplementation({ replicas: 2, environment: { PROVISIONING_FAKE_HOST_DELAY_MS: "100" } });
  }, 120_000);

  afterAll(async () => {
    await implementation?.stop();
  });

  it("loses no work when a replica holding leases is killed, and another replica takes them over", async () => {
    const uids = Array.from({ length: 60 }, (_, index) => `kill-${index}`);
    await Promise.all(uids.map((uid, index) => implementation.request("PUT", `/v1/users/${uid}/provisioning`, { body: { spec: spec(uid) }, replica: index % 2 })));
    let held = 0;
    for (let tries = 0; held === 0 && tries < 200; tries += 1) {
      held = await gauge(implementation.replicas[1].url, "provisioning_leases_held");
      if (held === 0) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(held).toBeGreaterThan(0);
    implementation.replicas[1].process.kill("SIGKILL");

    for (const uid of uids) {
      const response = await implementation.request("GET", `/v1/users/${uid}/provisioning?waitForGeneration=1&timeoutSeconds=150`);
      expect(response.status).toBe(200);
      expect(response.body.status.observedGeneration).toBe(1);
      expect(condition(response.body, "Ready")).toMatchObject({ status: "True" });
    }
    expect(await gauge(implementation.replicas[0].url, "provisioning_lease_expired_total")).toBeGreaterThan(0);
  });
});
