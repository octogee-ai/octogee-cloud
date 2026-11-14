import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { checkpointUserStoreAnchors } from "../lib/user-store-anchor-checkpoint.js";
import { landAuxiliaryAnchors, readLocalAuxiliaryAnchors } from "../lib/user-auxiliary-anchors.js";
import { createAgentAnchorReporter, landAgentAnchors, landGatewayStateAnchor } from "../lib/agent-anchor-record.js";
import { runAgentAnchorRestore } from "../entrypoints/agent-anchor-restore.js";
import { withUserClaim } from "./helpers/user-claim.js";
import type { FleetBrokerAgentAnchors, FleetBrokerAuxiliaryAnchor } from "../../shared/types/fleet-broker.js";

const roots: string[] = [];
async function root() { const dir = await fs.mkdtemp(path.join(tmpdir(), "user-anchor-record-")); roots.push(dir); return dir; }
afterEach(async () => { await Promise.all(roots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))); });
const identity = { storeId: "92c817cc-770f-466d-b4a6-4e9b02998363", schema: "store_identity" };
const defaultAgent = { ...identity, agentId: "octogee-alice-coach" };
const auxiliary: FleetBrokerAuxiliaryAnchor[] = ["workboard", "logbook", "team-reports"].map(family => ({ ...identity, family: family as FleetBrokerAuxiliaryAnchor["family"] }));
const config = { agents: { entries: { [defaultAgent.agentId]: {} } } };
async function fixture() {
  const stateDir = await root();
  await landAgentAnchors(stateDir, [defaultAgent]); await landGatewayStateAnchor(stateDir, identity, async () => {});
  await landAuxiliaryAnchors(stateDir, auxiliary, async () => {});
  let recorded: FleetBrokerAgentAnchors = { anchors: [] };
  const broker = {
    reportAgentAnchors: vi.fn(async (input: FleetBrokerAgentAnchors) => { recorded = input; }),
    readAgentAnchors: vi.fn(async () => recorded),
  };
  const input = { stateDir, slug: "alice", gatewayId: "alice-source", config, broker,
    verifyState: vi.fn(async () => {}), verifyAgent: vi.fn(async () => {}), verifyAuxiliary: vi.fn(async () => {}) };
  return { input, broker };
}

it("records and reads back all five store families, then restores auxiliary identities on a replacement", async () => {
  const f = await fixture(); await checkpointUserStoreAnchors(f.input);
  expect(f.broker.reportAgentAnchors).toHaveBeenCalledExactlyOnceWith({ slug: "alice", anchors: [defaultAgent], state: identity, auxiliary, configuredAgentIds: [defaultAgent.agentId] });
  expect(f.input.verifyAuxiliary).toHaveBeenCalledTimes(3);
  const target = await root();
  await runAgentAnchorRestore({
    env: withUserClaim({ GATEWAY_CLASS: "isolated", GATEWAY_RUNTIME_KIND: "cluster", GATEWAY_ID: "alice-source", OPENCLAW_STATE_DIR: target }, "alice"),
    broker: f.broker, readConfig: () => config, verify: async () => {}, verifyState: async () => {}, verifyAuxiliary: async () => {}, initializeHost: async () => {}, log: () => {},
  });
  expect(await readLocalAuxiliaryAnchors(target)).toEqual(auxiliary);
});
it("rejects an older broker that acknowledges but drops auxiliary anchors", async () => {
  const f = await fixture(); f.broker.readAgentAnchors.mockResolvedValue({ anchors: [defaultAgent], state: identity });
  await expect(checkpointUserStoreAnchors(f.input)).rejects.toThrow("not durably recorded");
});
it("does not record unverifiable PostgreSQL identities", async () => {
  const f = await fixture(); f.input.verifyAuxiliary.mockRejectedValue(new Error("namespace missing"));
  await expect(checkpointUserStoreAnchors(f.input)).rejects.toThrow("namespace missing");
  expect(f.broker.reportAgentAnchors).not.toHaveBeenCalled();
});
it("reports newly created auxiliary anchors even when the agent roster has not changed", async () => {
  const dir = await root(); await landAgentAnchors(dir, [defaultAgent]);
  const broker = { reportAgentAnchors: vi.fn(async () => {}) };
  const report = createAgentAnchorReporter({ stateDir: dir, slug: "alice", broker, readAgentIds: () => [defaultAgent.agentId], log: () => {} });
  await report(); await report(); expect(broker.reportAgentAnchors).toHaveBeenCalledTimes(1);
  await landAuxiliaryAnchors(dir, auxiliary, async () => {}); await report(); await report();
  expect(broker.reportAgentAnchors).toHaveBeenCalledTimes(2);
  expect(broker.reportAgentAnchors).toHaveBeenLastCalledWith({ slug: "alice", anchors: [defaultAgent], configuredAgentIds: [defaultAgent.agentId], auxiliary });
});
