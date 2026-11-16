import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dsn, spec, startImplementation, TOKENS, untilReady, type Implementation } from "./harness.js";

const ADOPTED = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA gateway-a";
const LEFT_ALONE = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB gateway-a";
const ADDED = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC gateway-a";
const OTHER_USERS = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD gateway-x";

describe.skipIf(!dsn)("provisioning service conformance: git keys the hosts already hold", { timeout: 120_000 }, () => {
  let implementation: Implementation;

  beforeAll(async () => {
    implementation = await startImplementation({
      environment: {
        PROVISIONING_FAKE_GIT_KEYS: JSON.stringify({
          "adopt-one": [{ publicKey: ADOPTED, holder: "gw-1/pod-1" }],
          "add-one": [{ publicKey: LEFT_ALONE, holder: "gw-1/pod-1" }],
          "someone-else": [{ publicKey: OTHER_USERS, holder: "gw-9/pod-1" }],
        }),
      },
    });
  }, 120_000);

  afterAll(async () => {
    await implementation?.stop();
  });

  async function registered(uid: string, publicKey: string): Promise<{ status: string; reason: string }> {
    let found: { status: string; reason: string; observedGeneration: number } | undefined;
    for (let poll = 0; poll < 50; poll += 1) {
      const key = await implementation.request("PUT", `/v1/users/${uid}/git-keys/gw-1%2Fpod-a`, { token: TOKENS.platformApi, body: { spec: { publicKey } } });
      found = key.body.status.conditions.find((entry: { type: string }) => entry.type === "Registered");
      if (found && found.observedGeneration >= key.body.generation && found.reason !== "Pending") break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return found!;
  }

  async function provisionedWithKey(uid: string, slug: string, publicKey: string): Promise<void> {
    await implementation.request("PUT", `/v1/users/${uid}/provisioning`, { body: { spec: spec(slug) } });
    await untilReady(implementation, uid, 1);
    await implementation.request("PUT", `/v1/users/${uid}/git-keys/gw-1%2Fpod-a`, { token: TOKENS.platformApi, body: { spec: { publicKey } } });
  }

  it("adopts the identical public key the user's account already holds under a title it does not manage", async () => {
    await provisionedWithKey("adopt-1", "adopt-one", ADOPTED);
    expect(await registered("adopt-1", ADOPTED)).toMatchObject({ status: "True" });
  });

  it("registers a different public key beside a key it does not manage", async () => {
    await provisionedWithKey("add-1", "add-one", ADDED);
    expect(await registered("add-1", ADDED)).toMatchObject({ status: "True" });
  });

  it("refuses a public key another user's account holds, with its own reason", async () => {
    await provisionedWithKey("cross-1", "cross-one", OTHER_USERS);
    expect(await registered("cross-1", OTHER_USERS)).toMatchObject({ status: "False", reason: "GitKeyHeldElsewhere" });
  });
});
