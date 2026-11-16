import { beforeAll, describe, expect, it } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";
import { installDefaultUserEntitlements } from "@octogee/shared/types/user-entitlements";
import type { ChatOutputs, UserProvisioning } from "@octogee/shared/types/provisioning-service";
import { mirroredState, mmUpdateFromChatOutputs } from "./provisioning-mirror.js";
import { desiredUserProvisioningSpec } from "./provisioning-spec.js";
import { buildProvisioningContext, markProvisioningComplete, noProvisioningProjection } from "./provisionSteps.js";

const ACCOUNT = { username: "lin", email: "lin@example.test", displayName: "Lin Wu" };
const CHAT: ChatOutputs = { userId: "mm-user", teamId: "mm-team", channels: { general: "ch-general", agent: "ch-agent" }, agentBotUserId: "mm-bot" };

function resource(): UserProvisioning {
  return {
    uid: "u1",
    generation: 1,
    resourceVersion: "3",
    spec: desiredUserProvisioningSpec("u1", ACCOUNT),
    status: {
      observedGeneration: 1,
      conditions: [{ type: "ChatReady", status: "True", reason: "Converged", message: "", lastTransitionTime: "2026-11-15T18:00:00Z", observedGeneration: 1 }],
      outputs: { chat: CHAT, credentials: ["agent-chat-token", "user-chat-token"] },
      work: { state: "idle", attempts: 1, nextAttemptAt: null, lastAttemptAt: null },
    },
  };
}

function seeded() {
  const records = new Map<string, Record<string, unknown>>([
    ["users/u1", { username: "lin", onboardingStep: "complete", provisioning: { status: "in_progress" } }],
  ]);
  return createDocumentFixtureStore(records);
}

async function mirrorFully(store: ReturnType<typeof seeded>): Promise<void> {
  const provisioning = resource();
  const mmUpdate = mmUpdateFromChatOutputs({ slug: "lin", chat: CHAT, agentChannelName: "lin-coach", proxyUrl: null });
  await markProvisioningComplete(buildProvisioningContext("u1", ACCOUNT), mmUpdate, [...provisioning.spec.agentIds], noProvisioningProjection, store);
}

beforeAll(() => {
  installDefaultUserEntitlements();
});

describe("mirrored state", () => {
  it("is mirrored once every record the mirror writes matches the service's outputs", async () => {
    const store = seeded();
    await mirrorFully(store);

    await expect(mirroredState(store, resource(), CHAT)).resolves.toEqual({ state: "mirrored" });
  });

  it("is pending while only the user's chat account is written and the workspace, channels and agent identity are not", async () => {
    const store = seeded();
    await store.users.records.patch("u1", { mattermostUserId: "mm-user" });

    await expect(mirroredState(store, resource(), CHAT)).resolves.toEqual({ state: "pending" });
  });

  it("is refused for a user record that carries another slug", async () => {
    const store = seeded();
    await store.users.records.patch("u1", { slug: "other" });

    await expect(mirroredState(store, resource(), CHAT)).resolves.toEqual({
      state: "slug-mismatch", detail: "the user record carries slug other, the spec names lin",
    });
  });

  it("is refused for a user being erased", async () => {
    const store = seeded();
    const user = await store.users.records.get("u1");
    await store.users.records.patch("u1", { accountLifecycle: { ...user!.accountLifecycle, status: "erasing" } });

    await expect(mirroredState(store, resource(), CHAT)).resolves.toEqual({
      state: "being-erased", detail: "the user's account lifecycle is erasing",
    });
  });

  it("is refused when the user record or a held chat account names another chat user", async () => {
    const store = seeded();
    await store.users.records.patch("u1", { mattermostUserId: "mm-other" });

    await expect(mirroredState(store, resource(), CHAT)).resolves.toEqual({
      state: "chat-id-mismatch", detail: "the user record holds chat user mm-other, the provisioning service reports chat user mm-user",
    });
  });

  it("is refused for a user without a record", async () => {
    const store = seeded();
    await store.users.records.delete("u1");

    await expect(mirroredState(store, resource(), CHAT)).resolves.toEqual({ state: "user-missing", detail: "no user record exists for u1" });
  });
});
