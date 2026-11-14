import { describe, expect, it, vi } from "vitest";
import { access, readFile, stat } from "node:fs/promises";
import type { AgentStoreGatewayIdentity } from "@octogee/core/agent-store-credentials";
import type { KubectlSubprocess } from "../auth-secret-ensurer.js";
import { createGatewayCredentialEnsurers } from "../gateway-credential-ensurers.js";

const b64 = (value: string) => Buffer.from(value).toString("base64");
const secretJson = (data: Record<string, string>) =>
  JSON.stringify({ data: Object.fromEntries(Object.entries(data).map(([key, value]) => [key, b64(value)])) });
const agentStoreClientDsn = "postgresql://private/agents_test";

function harness(secret: Record<string, string> = { token: "synthetic-token" }) {
  const auth = { ensureAuthSecret: vi.fn(async () => {}) };
  const readGateway = vi.fn(async (): Promise<{ gatewayClass: "shared" | "isolated"; ownerUid: string | null; builderSlug: string | null; desiredStatus: string; retirementClaim?: unknown } | null> => null);
  const provisionAgentStore = vi.fn(async (_identity: AgentStoreGatewayIdentity, assertCurrent: () => Promise<void>) => { await assertCurrent?.(); return "postgresql://gateway:synthetic@private/agents_test"; });
  const runKubectl = vi.fn<KubectlSubprocess>(async args =>
    ({ code: 0, stdout: args[args.indexOf("-o") + 1] === "json" ? secretJson(secret) : b64(secret.token!), stderr: "" }));
  return { auth, readGateway, provisionAgentStore, runKubectl, stages: createGatewayCredentialEnsurers({ auth, readGateway, provisionAgentStore, runKubectl, agentStoreClientDsn }) };
}
const request = { namespace: "test", gatewayId: "fresh-user" };

function capturePublication(h: ReturnType<typeof harness>, secret: Record<string, string> = { token: "synthetic-token" }) {
  const captured = { args: [] as string[], patch: undefined as unknown, path: "", mode: 0 };
  h.runKubectl.mockImplementation(async args => {
    if (args[0] === "get") return { code: 0, stdout: args[args.indexOf("-o") + 1] === "json" ? secretJson(secret) : b64(secret.token!), stderr: "" };
    captured.args = args;
    const fileArg = args.find(arg => arg.startsWith("--patch-file="));
    if (!fileArg) throw new Error("Credential publication requires a private patch file");
    captured.path = fileArg.slice("--patch-file=".length);
    captured.patch = JSON.parse(await readFile(captured.path, "utf8"));
    captured.mode = (await stat(captured.path)).mode & 0o777;
    return { code: 0, stdout: "", stderr: "" };
  });
  return captured;
}

describe("Gateway credential provisioning stages", () => {
  it("allocates the token before the desired root exists and provisions SQL credentials before runtime start", async () => {
    const h = harness();
    await h.stages.ensureGatewayAuthSecret(request);
    expect(h.auth.ensureAuthSecret).toHaveBeenCalledWith(request);
    expect(h.readGateway).not.toHaveBeenCalled();
    expect(h.provisionAgentStore).not.toHaveBeenCalled();
    h.readGateway.mockResolvedValue({ desiredStatus: "running", gatewayClass: "isolated", ownerUid: "uid-alice", builderSlug: "alice" });
    await h.stages.ensureGatewayCredentials(request);
    expect(h.provisionAgentStore).toHaveBeenCalledExactlyOnceWith({ gatewayId: request.gatewayId, gatewayClass: "isolated", token: "synthetic-token", user: { uid: "uid-alice", slug: "alice" } }, expect.any(Function));
  });

  it.each([{ desiredStatus: "retired" }, { retirementClaim: { operationId: "retire" } }, { retirementClaim: false }, { retirementClaim: "" }])("rejects issuance when retirement begins while waiting for SQL custody: %j", async retirement => {
    const h = harness();
    const gateway = { gatewayClass: "shared" as const, ownerUid: null, builderSlug: null, desiredStatus: "draining" };
    h.readGateway.mockResolvedValueOnce(gateway).mockResolvedValue({ ...gateway, ...retirement });
    await expect(h.stages.ensureGatewayCredentials(request)).rejects.toThrow("retired or changed");
    expect(h.runKubectl.mock.calls.every(([args]) => args[0] === "get")).toBe(true);
  });

  it("keeps draining Shared credential issuance available before a retirement claim", async () => {
    const h = harness();
    h.readGateway.mockResolvedValue({ gatewayClass: "shared", ownerUid: null, builderSlug: null, desiredStatus: "draining" });
    await expect(h.stages.ensureGatewayCredentials(request)).resolves.toBeUndefined();
  });

  it("does not publish credentials if custody changes after SQL issuance", async () => {
    const h = harness();
    h.readGateway.mockResolvedValue({ gatewayClass: "isolated", ownerUid: "uid-alice", builderSlug: "alice", desiredStatus: "running" });
    h.provisionAgentStore.mockImplementationOnce(async (_identity, assertCurrent) => {
      await assertCurrent();
      h.readGateway.mockResolvedValue({ gatewayClass: "isolated", ownerUid: "uid-bob", builderSlug: "bob", desiredStatus: "running" });
      return "postgresql://synthetic";
    });
    await expect(h.stages.ensureGatewayCredentials(request)).rejects.toThrow("retired or changed");
    expect(h.runKubectl.mock.calls.every(([args]) => args[0] === "get")).toBe(true);
  });

  it("rechecks custody after private patch preparation before publishing", async () => {
    const h = harness();
    const gateway = { gatewayClass: "shared" as const, ownerUid: null, builderSlug: null, desiredStatus: "running" };
    h.readGateway.mockResolvedValueOnce(gateway).mockResolvedValueOnce(gateway).mockResolvedValueOnce(gateway)
      .mockResolvedValue({ ...gateway, desiredStatus: "retired" });
    await expect(h.stages.ensureGatewayCredentials(request)).rejects.toThrow("retired or changed");
    expect(h.runKubectl.mock.calls.every(([args]) => args[0] === "get")).toBe(true);
  });

  it("publishes a token-fenced update through a private file and removes it afterward", async () => {
    const h = harness();
    const publication = capturePublication(h);
    h.readGateway.mockResolvedValue({ desiredStatus: "running", gatewayClass: "shared", ownerUid: null, builderSlug: null });
    await h.stages.ensureGatewayCredentials(request);
    expect(publication.args).toEqual(["patch", "secret", "gateway-auth-token-fresh-user", "-n", "test", "--type=json", `--patch-file=${publication.path}`]);
    expect(publication.patch).toEqual([
      { op: "test", path: "/data/token", value: b64("synthetic-token") },
      { op: "add", path: "/data/agent-store-dsn", value: b64("postgresql://gateway:synthetic@private/agents_test") },
      { op: "add", path: "/data/agent-store-owner", value: b64("shared") },
    ]);
    expect(publication.mode).toBe(0o600);
    await expect(access(publication.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses runtime credentials without a durable root", async () => {
    const h = harness();
    await expect(h.stages.ensureGatewayCredentials(request)).rejects.toThrow("desired owner");
    expect(h.provisionAgentStore).not.toHaveBeenCalled();
    expect(h.runKubectl).not.toHaveBeenCalled();
  });

  it("refuses incomplete desired ownership", async () => {
    const h = harness();
    h.readGateway.mockResolvedValue({ desiredStatus: "running", gatewayClass: "isolated", ownerUid: "uid-alice", builderSlug: null });
    await expect(h.stages.ensureGatewayCredentials(request)).rejects.toThrow("desired owner");
    expect(h.provisionAgentStore).not.toHaveBeenCalled();
  });

  it.each(["shared", "isolated"] as const)("keeps an unowned %s runtime unclaimed", async gatewayClass => {
    const h = harness();
    h.readGateway.mockResolvedValue({ desiredStatus: "running", gatewayClass, ownerUid: null, builderSlug: null });
    await h.stages.ensureGatewayCredentials(request);
    expect(h.provisionAgentStore).toHaveBeenCalledWith({ gatewayId: request.gatewayId, gatewayClass, token: "synthetic-token" }, expect.any(Function));
  });

  it("fails runtime preparation when scoped credentials cannot be published", async () => {
    const h = harness();
    h.readGateway.mockResolvedValue({ desiredStatus: "running", gatewayClass: "shared", ownerUid: null, builderSlug: null });
    h.runKubectl.mockResolvedValueOnce({ code: 0, stdout: secretJson({ token: "synthetic-token" }), stderr: "" }).mockResolvedValueOnce({ code: 1, stdout: "", stderr: "denied" });
    await expect(h.stages.ensureGatewayCredentials(request)).rejects.toThrow("publication failed");
    const fileArg = h.runKubectl.mock.calls.at(-1)![0].find(arg => arg.startsWith("--patch-file="))!;
    await expect(access(fileArg.slice("--patch-file=".length))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("Gateway credential reuse", () => {
  const alice = { desiredStatus: "running", gatewayClass: "isolated" as const, ownerUid: "uid-alice", builderSlug: "alice" };
  const published = {
    token: "synthetic-token",
    "agent-store-dsn": "postgresql://octogee_gateway_fresh:synthetic-token@private/agents_test",
    "agent-store-owner": "builder:uid-alice",
  };

  it("skips SQL provisioning when the secret already publishes credentials for the same token, endpoint and owner", async () => {
    const h = harness(published);
    h.readGateway.mockResolvedValue(alice);
    await h.stages.ensureGatewayCredentials(request);
    expect(h.provisionAgentStore).not.toHaveBeenCalled();
    expect(h.runKubectl.mock.calls.every(([args]) => args[0] === "get")).toBe(true);
  });

  it.each([
    ["the token rotated", { ...published, token: "rotated-token" }, alice],
    ["the endpoint moved", { ...published, "agent-store-dsn": "postgresql://octogee_gateway_fresh:synthetic-token@elsewhere/agents_test" }, alice],
    ["the runtime was claimed", { ...published, "agent-store-owner": "unclaimed" }, alice],
    ["no owner was recorded", { token: published.token, "agent-store-dsn": published["agent-store-dsn"] }, alice],
    ["the desired owner differs", published, { ...alice, ownerUid: "uid-bob", builderSlug: "bob" }],
    ["the published endpoint is unreadable", { ...published, "agent-store-dsn": "not a url" }, alice],
    ["the published password has a bad escape", { ...published, "agent-store-dsn": "postgresql://octogee_gateway_fresh:%E0%A4%A@private/agents_test" }, alice],
  ])("provisions again when %s", async (_reason, secret, gateway) => {
    const h = harness(secret);
    const publication = capturePublication(h, secret);
    h.readGateway.mockResolvedValue(gateway);
    await h.stages.ensureGatewayCredentials(request);
    expect(h.provisionAgentStore).toHaveBeenCalledOnce();
    expect(publication.patch).toContainEqual({ op: "add", path: "/data/agent-store-owner", value: b64(`builder:${gateway.ownerUid}`) });
  });

  it.each([
    { desiredStatus: "retired" },
    { retirementClaim: { operationId: "retire" } },
    { ownerUid: "uid-bob", builderSlug: "bob" },
    { gatewayClass: "shared" as const, ownerUid: null, builderSlug: null },
  ])("refuses reuse when the gateway changed during the secret read: %j", async change => {
    const h = harness(published);
    h.readGateway.mockResolvedValueOnce(alice).mockResolvedValue({ ...alice, ...change });
    await expect(h.stages.ensureGatewayCredentials(request)).rejects.toThrow("retired or changed");
    expect(h.provisionAgentStore).not.toHaveBeenCalled();
    expect(h.runKubectl.mock.calls.every(([args]) => args[0] === "get")).toBe(true);
  });

  it.each([{ desiredStatus: "retired" }, { retirementClaim: { operationId: "retire" } }])("refuses a retired runtime even when its credentials are already published: %j", async retirement => {
    const h = harness(published);
    h.readGateway.mockResolvedValue({ ...alice, ...retirement });
    await expect(h.stages.ensureGatewayCredentials(request)).rejects.toThrow("retired or changed");
    expect(h.provisionAgentStore).not.toHaveBeenCalled();
    expect(h.runKubectl.mock.calls.every(([args]) => args[0] === "get")).toBe(true);
  });
});
