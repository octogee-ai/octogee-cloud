import { agentIdsFromConfig } from "@octogee/core/byosub-restore";
import { readLocalAgentAnchors, readLocalGatewayStateAnchor, verifyAgentAnchorInPostgres, verifyGatewayStateAnchorInPostgres } from "./agent-anchor-record.js";
import { readLocalAuxiliaryAnchors, verifyAuxiliaryAnchorInPostgres } from "./user-auxiliary-anchors.js";
import { createFleetBrokerClient, type FleetBrokerClient } from "./fleet-broker-client.js";

export async function checkpointUserStoreAnchors(input: {
  stateDir: string; slug: string; gatewayId: string; config: unknown;
  broker?: Pick<FleetBrokerClient, "reportAgentAnchors" | "readAgentAnchors">;
  verifyAgent?: typeof verifyAgentAnchorInPostgres;
  verifyState?: typeof verifyGatewayStateAnchorInPostgres;
  verifyAuxiliary?: typeof verifyAuxiliaryAnchorInPostgres;
}): Promise<void> {
  const configuredAgentIds = agentIdsFromConfig(input.config);
  const anchors = await readLocalAgentAnchors(input.stateDir, configuredAgentIds);
  const state = readLocalGatewayStateAnchor(input.stateDir);
  const auxiliary = await readLocalAuxiliaryAnchors(input.stateDir);
  if (!state || !anchors.length) throw new Error("User migration requires native state and agent anchors before durable checkpoint");
  await (input.verifyState ?? verifyGatewayStateAnchorInPostgres)(state);
  for (const anchor of anchors) await (input.verifyAgent ?? verifyAgentAnchorInPostgres)(anchor);
  for (const anchor of auxiliary) await (input.verifyAuxiliary ?? verifyAuxiliaryAnchorInPostgres)(anchor);
  const broker = input.broker ?? createFleetBrokerClient(input.gatewayId);
  await broker.reportAgentAnchors({ slug: input.slug, anchors, configuredAgentIds, state, auxiliary });
  const recorded = await broker.readAgentAnchors({ slug: input.slug });
  const same = (left: { storeId: string; schema: string } | undefined, right: { storeId: string; schema: string }) => left?.storeId === right.storeId && left.schema === right.schema;
  if (!same(recorded.state, state) || anchors.some(anchor => !same(recorded.anchors.find(a => a.agentId === anchor.agentId), anchor)) ||
      auxiliary.some(anchor => !same(recorded.auxiliary?.find(a => a.family === anchor.family), anchor))) {
    throw new Error("User store anchors were not durably recorded; keep the source held and deploy the matching fleet broker before retrying");
  }
}
