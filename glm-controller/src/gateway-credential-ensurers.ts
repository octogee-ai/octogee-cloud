import type { AgentStoreGatewayIdentity } from "@octogee/core/agent-store-credentials";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGatewayAuthSecret, type AuthSecretEnsurer, type GatewayAuthSecret, type KubectlSubprocess } from "./auth-secret-ensurer.js";

type GatewayIdentity = { gatewayClass: "shared" | "isolated"; ownerUid: string | null; builderSlug: string | null; desiredStatus: string; retirementClaim?: unknown };

function retirementBegan(gateway: GatewayIdentity): boolean {
  return gateway.desiredStatus === "retired" || gateway.retirementClaim != null;
}

function agentStoreOwner(gateway: GatewayIdentity): string {
  if (gateway.gatewayClass === "shared") return "shared";
  return gateway.ownerUid ? `builder:${gateway.ownerUid}` : "unclaimed";
}

function readDsn(dsn: string): { endpoint: string; password: string } | null {
  try {
    const url = new URL(dsn);
    const password = decodeURIComponent(url.password);
    url.username = "";
    url.password = "";
    return { endpoint: url.href, password };
  } catch {
    return null;
  }
}

function credentialsPublished(secret: GatewayAuthSecret, clientDsn: string, owner: string): boolean {
  if (!secret.agentStoreDsn || secret.agentStoreOwner !== owner) return false;
  const published = readDsn(secret.agentStoreDsn);
  return published !== null && published.password === secret.token && published.endpoint === readDsn(clientDsn)?.endpoint;
}

export function createGatewayCredentialEnsurers(deps: {
  auth: AuthSecretEnsurer;
  readGateway(gatewayId: string): Promise<GatewayIdentity | null>;
  provisionAgentStore(identity: AgentStoreGatewayIdentity, assertCurrent: () => Promise<void>): Promise<string>;
  runKubectl: KubectlSubprocess;
  agentStoreClientDsn: string;
}) {
  const ensureGatewayCredentials: AuthSecretEnsurer["ensureAuthSecret"] = async (input) => {
    await deps.auth.ensureAuthSecret(input);
    const gateway = await deps.readGateway(input.gatewayId);
    if (!gateway || Boolean(gateway.ownerUid) !== Boolean(gateway.builderSlug)) {
      throw new Error(`Agent-store credentials require the desired owner of Gateway ${input.gatewayId}`);
    }
    const refuse = () => new Error(`Agent-store Gateway ${input.gatewayId} retired or changed while issuing credentials`);
    if (retirementBegan(gateway)) throw refuse();
    const assertCurrent = async () => {
      const current = await deps.readGateway(input.gatewayId);
      if (!current || retirementBegan(current)
        || current.gatewayClass !== gateway.gatewayClass || current.ownerUid !== gateway.ownerUid
        || current.builderSlug !== gateway.builderSlug) {
        throw refuse();
      }
    };
    const secret = await readGatewayAuthSecret(deps, input);
    const owner = agentStoreOwner(gateway);
    if (credentialsPublished(secret, deps.agentStoreClientDsn, owner)) {
      await assertCurrent();
      return;
    }
    const dsn = await deps.provisionAgentStore({
      gatewayId: input.gatewayId, gatewayClass: gateway.gatewayClass, token: secret.token,
      ...(gateway.gatewayClass === "isolated" && gateway.ownerUid && gateway.builderSlug
        ? { user: { uid: gateway.ownerUid, slug: gateway.builderSlug } } : {}),
    }, assertCurrent);
    await assertCurrent();
    const directory = await mkdtemp(join(tmpdir(), "octogee-agent-store-secret-"));
    try {
      const patchFile = join(directory, "patch.json");
      await writeFile(patchFile, JSON.stringify([
        { op: "test", path: "/data/token", value: Buffer.from(secret.token).toString("base64") },
        { op: "add", path: "/data/agent-store-dsn", value: Buffer.from(dsn).toString("base64") },
        { op: "add", path: "/data/agent-store-owner", value: Buffer.from(owner).toString("base64") },
      ]), { mode: 0o600 });
      await assertCurrent();
      const result = await deps.runKubectl(["patch", "secret", `gateway-auth-token-${input.gatewayId}`, "-n", input.namespace, "--type=json", `--patch-file=${patchFile}`]);
      if (result.code !== 0) throw new Error(`Agent-store credential publication failed for ${input.gatewayId} (code=${result.code})`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
  return { ensureGatewayAuthSecret: deps.auth.ensureAuthSecret, ensureGatewayCredentials };
}
