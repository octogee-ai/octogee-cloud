import type { PlatformStateRepositories } from "@octogee/core/platform-state";

export type UserMigrationDirection = "inbound" | "outbound";

export async function hasRunningUserMigration(
  store: Pick<PlatformStateRepositories, "journal">,
  uid: string,
  gatewayId: string,
  direction: UserMigrationDirection,
): Promise<boolean> {
  const operations = await store.journal.operations.listForUid(uid, { kind: "migrate-user", statuses: ["running"] });
  return operations.some(({ input }) =>
    input.uid === uid && (direction === "inbound" ? input.toGatewayId : input.fromGatewayId) === gatewayId);
}
