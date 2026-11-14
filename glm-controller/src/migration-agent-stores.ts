import type { AgentStoresRepository } from "@octogee/core/platform-state";

type User = { uid: string; slug: string };
type Gateway = { gatewayClass: "shared" | "isolated"; ownerUid: string | null; builderSlug: string | null };

export interface AgentStoreHandoffAuthority {
  expectedUserUid: string;
  assertCurrent(): Promise<void>;
}

export type PrepareMigrationAgentStores = (gatewayId: string, slug: string, authority?: AgentStoreHandoffAuthority) => Promise<void>;

function assertUserIdentity(user: User, slug: string, expectedUid?: string): void {
  if (!user.uid || user.slug !== slug || expectedUid !== undefined && user.uid !== expectedUid) {
    throw new Error("Agent-store handoff user identity changed");
  }
}

function assertGatewayOwner(gateway: Gateway, gatewayId: string, user: User): void {
  if (gateway.gatewayClass === "isolated" && (gateway.ownerUid !== user.uid || gateway.builderSlug !== user.slug)) {
    throw new Error(`Agent-store handoff owner differs on Gateway ${gatewayId}`);
  }
  if (gateway.gatewayClass === "shared" && (gateway.ownerUid || gateway.builderSlug)) {
    throw new Error(`Shared Gateway ${gatewayId} has a user identity`);
  }
}

function assertGatewayUnchanged(current: Gateway | null, expected: Gateway): void {
  if (!current || current.gatewayClass !== expected.gatewayClass ||
      current.ownerUid !== expected.ownerUid || current.builderSlug !== expected.builderSlug) {
    throw new Error("Agent-store handoff Gateway identity changed during credential preparation");
  }
}

function isPostgresHandoffTimeout(error: unknown): boolean {
  const pg = error as { code?: unknown; message?: unknown };
  return pg?.code === "55P03" || pg?.code === "57014" && typeof pg.message === "string" && /statement timeout/i.test(pg.message);
}

export function createMigrationAgentStorePreparer(deps: {
  readGateway(gatewayId: string): Promise<Gateway | null>;
  readUserBySlug(slug: string): Promise<User>;
  ensureCredentials(gatewayId: string): Promise<void>;
  transferOwnership(user: User, target: "shared" | "isolated", assertCurrent?: () => Promise<void>): Promise<void>;
}): PrepareMigrationAgentStores {
  return async (gatewayId, slug, authority) => {
    if (authority && !authority.expectedUserUid) throw new Error("Agent-store handoff requires the claimed user identity");
    await authority?.assertCurrent();
    const gateway = await deps.readGateway(gatewayId);
    if (!gateway) throw new Error(`Agent-store handoff requires the desired Gateway ${gatewayId}`);
    const user = await deps.readUserBySlug(slug);
    assertUserIdentity(user, slug, authority?.expectedUserUid);
    assertGatewayOwner(gateway, gatewayId, user);
    await authority?.assertCurrent();
    await deps.ensureCredentials(gatewayId);
    if (authority) {
      const currentGateway = await deps.readGateway(gatewayId);
      const currentUser = await deps.readUserBySlug(slug);
      assertGatewayUnchanged(currentGateway, gateway);
      assertUserIdentity(currentUser, slug, user.uid);
      await authority.assertCurrent();
    }
    try {
      if (authority) await deps.transferOwnership(user, gateway.gatewayClass, authority.assertCurrent);
      else await deps.transferOwnership(user, gateway.gatewayClass);
    } catch (error) {
      if (isPostgresHandoffTimeout(error)) {
        throw new Error(`agent-store handoff timeout: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
      throw error;
    }
    await authority?.assertCurrent();
  };
}

export async function readUserAgentStoreInventory(stores: Pick<AgentStoresRepository, "list">, uid: string) {
  return (await stores.list(uid)).flatMap(record =>
    record.kind === "agent" && record.agentId !== "octogee-unmatched-route"
      ? [{ agentId: record.agentId, storeId: record.storeId, schema: record.schema }] : []);
}
