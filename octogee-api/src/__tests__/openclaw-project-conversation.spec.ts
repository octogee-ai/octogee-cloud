import express from "express";
import request from "supertest";
import type { Firestore } from "firebase-admin/firestore";
import { expect, it } from "vitest";
import { createOpenClawRuntimeBrokerRoutes } from "../routes/openclaw-runtime-broker.js";
import { firestoreSizingKeyReader } from "@octogee/core/sizing-key";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";

const OWNER = "a".repeat(26);
const MEMBER = "b".repeat(26);
const PROJECT = "c".repeat(26);
const WORKSPACE = "d".repeat(26);
const THREAD = "e".repeat(26);
const docs: Record<string, Record<string, unknown>> = {
  "users/owner": { username: "bob", provisioning: { openclaw: { gatewayId: "builder-bob" } }, mattermost: { userId: OWNER } },
  "workspaces/bob": { id: "bob", ownerUid: "owner" },
  "workspaces/bob/channels/general": { kind: "general", mattermost: { channelId: WORKSPACE } },
  "workspaces/bob/projects/golf": { ownerUid: "owner" },
  "workspaces/bob/projects/golf/channels/general": { kind: "general", mattermost: { channelId: PROJECT } },
};
function app() {
  const server = express();
  server.use(express.json(), (req, _res, next) => {
    req.boundTenant = { kind: "gateway", gatewayId: "builder-bob" } as Express.Request["boundTenant"];
    next();
  });
  server.use(createOpenClawRuntimeBrokerRoutes({ store: createDocumentFixtureStore(docs), readSizingKey: firestoreSizingKeyReader({} as Firestore) }));
  return server;
}

it.each([OWNER, MEMBER])("rejects workspace-agent project dispatch from %s including threads", async (senderId) => {
  for (const suffix of ["", `:thread:${THREAD}`]) {
    await expect(request(app()).post("/activity/dispatch-context").send({
      agentId: "octogee-bob-coach", accountId: "bob-coach", conversationId: PROJECT, senderId,
      sessionKey: `agent:octogee-bob-coach:mattermost:channel:${PROJECT}${suffix}`,
    })).resolves.toMatchObject({ status: 403 });
  }
});
it("rejects secondary workspace-agent runs in projects while preserving workspace runs", async () => {
  for (const [channelId, status] of [[PROJECT, 403], [WORKSPACE, 200]] as const) {
    await expect(request(app()).post("/activity/session-context").send({
      agentId: "octogee-bob-coach", accountId: "bob-coach", channelId,
    })).resolves.toMatchObject({ status });
  }
});
it.each([OWNER, MEMBER])("allows the project agent to respond to project member %s", async (senderId) => {
  await expect(request(app()).post("/activity/dispatch-context").send({
    agentId: "octogee-bob-proj-golf-coach", accountId: "bob-proj-golf", conversationId: PROJECT, senderId,
    sessionKey: `agent:octogee-bob-proj-golf-coach:mattermost:channel:${PROJECT}`,
  })).resolves.toMatchObject({ status: 200, body: { authorized: true } });
  await expect(request(app()).post("/activity/session-context").send({
    agentId: "octogee-bob-proj-golf-coach", accountId: "bob-proj-golf", channelId: PROJECT,
  })).resolves.toMatchObject({ status: 200, body: { authorized: true } });
});
