import { describe, it, expect, vi } from "vitest";
import {
  createAuthSecretEnsurer,
  readGatewayAuthSecret,
  type KubectlSubprocess,
} from "../auth-secret-ensurer";

function mockKubectl(
  responses: Array<{ stdout?: string; stderr?: string; code?: number }>,
): { runKubectl: KubectlSubprocess; calls: string[][] } {
  const calls: string[][] = [];
  let i = 0;
  const runKubectl: KubectlSubprocess = vi.fn(async (args: string[]) => {
    calls.push(args);
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return {
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      code: r.code ?? 0,
    };
  });
  return { runKubectl, calls };
}

// The platform owns OPENCLAW_GATEWAY_TOKEN via a per-gateway K8s secret threaded by
// the chart via secretKeyRef. The fleet controller ensures the secret exists with a
// random hex value before each upsertInstance — idempotent, no
// re-rotation on subsequent reconciles.
describe("createAuthSecretEnsurer", () => {
  it("no-ops when the secret already exists (idempotent: never rotates a live token)", async () => {
    const { runKubectl, calls } = mockKubectl([
      // get → exit 0, secret exists
      { stdout: "secret/gateway-auth-token-gw-test\n", code: 0 },
    ]);
    const ensurer = createAuthSecretEnsurer({
      runKubectl,
      randomTokenHex: () => "REROLLED_SHOULD_NOT_HAPPEN",
      log: vi.fn(),
    });

    await ensurer.ensureAuthSecret({
      namespace: "octogee-test",
      gatewayId: "gw-test",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].slice(0, 5)).toEqual([
      "get",
      "secret",
      "gateway-auth-token-gw-test",
      "-n",
      "octogee-test",
    ]);
  });

  it("creates the secret with a random token when missing (NotFound from kubectl get)", async () => {
    const generatedToken = "abc123def456".repeat(4);
    const { runKubectl, calls } = mockKubectl([
      // get → NotFound
      {
        stderr:
          'Error from server (NotFound): secrets "gateway-auth-token-gw-test" not found',
        code: 1,
      },
      // create → ok
      {
        stdout: "secret/gateway-auth-token-gw-test created\n",
        code: 0,
      },
    ]);
    const ensurer = createAuthSecretEnsurer({
      runKubectl,
      randomTokenHex: () => generatedToken,
      log: vi.fn(),
    });

    await ensurer.ensureAuthSecret({
      namespace: "octogee-test",
      gatewayId: "gw-test",
    });

    expect(calls).toHaveLength(2);
    expect(calls[1].slice(0, 4)).toEqual([
      "create",
      "secret",
      "generic",
      "gateway-auth-token-gw-test",
    ]);
    expect(calls[1]).toContain(`--from-literal=token=${generatedToken}`);
    expect(calls[1]).toContain("-n");
    expect(calls[1]).toContain("octogee-test");
  });

  it("throws on a non-NotFound get error (don't silently mask a real cluster failure)", async () => {
    const { runKubectl } = mockKubectl([
      // get → forbidden (NOT not-found)
      {
        stderr:
          'Error from server (Forbidden): secrets "gateway-auth-token-gw-test" is forbidden',
        code: 1,
      },
    ]);
    const ensurer = createAuthSecretEnsurer({
      runKubectl,
      randomTokenHex: () => "should-not-be-called",
      log: vi.fn(),
    });

    await expect(
      ensurer.ensureAuthSecret({ namespace: "octogee-test", gatewayId: "gw-test" }),
    ).rejects.toThrow(/Forbidden|kubectl get secret/);
  });

  it("throws when kubectl create fails (don't continue past a half-broken state)", async () => {
    const { runKubectl } = mockKubectl([
      { stderr: "NotFound", code: 1 },
      { stderr: "Error: connection refused", code: 1 },
    ]);
    const ensurer = createAuthSecretEnsurer({
      runKubectl,
      randomTokenHex: () => "abc".repeat(16),
      log: vi.fn(),
    });

    await expect(
      ensurer.ensureAuthSecret({ namespace: "octogee-test", gatewayId: "gw-test" }),
    ).rejects.toThrow(/connection refused|kubectl create secret/);
  });

  it("treats AlreadyExists from kubectl create as success (race with a concurrent ensurer — desired state still satisfied)", async () => {
    // Two reconcilers / two operation workers / a retry racing a peer can both
    // hit `get` → NotFound, both race to `create`, and one loses with
    // AlreadyExists. The desired end state is still satisfied, so this MUST
    // NOT crash the controller and block the helm upsert.
    const { runKubectl, calls } = mockKubectl([
      { stderr: "NotFound", code: 1 },
      {
        stderr:
          'Error from server (AlreadyExists): secrets "gateway-auth-token-gw-test" already exists',
        code: 1,
      },
    ]);
    const log = vi.fn();
    const ensurer = createAuthSecretEnsurer({
      runKubectl,
      randomTokenHex: () => "racing-loser-token",
      log,
    });

    await expect(
      ensurer.ensureAuthSecret({ namespace: "octogee-test", gatewayId: "gw-test" }),
    ).resolves.toBeUndefined();

    expect(calls).toHaveLength(2);
    expect(calls[1][0]).toBe("create");
    // Visible log breadcrumb so the operator can correlate with the peer's
    // successful create in the same ns/release window.
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/AlreadyExists|race|concurrent/i),
    );
  });

  it("namespaces the secret name by gatewayId so two gateways never share a token", async () => {
    const { runKubectl, calls } = mockKubectl([
      { stdout: "secret/gateway-auth-token-gw-walter\n", code: 0 },
    ]);
    const ensurer = createAuthSecretEnsurer({
      runKubectl,
      randomTokenHex: () => "unused",
      log: vi.fn(),
    });

    await ensurer.ensureAuthSecret({
      namespace: "octogee",
      gatewayId: "gw-walter",
    });

    expect(calls[0]).toContain("gateway-auth-token-gw-walter");
  });
});

describe("readGatewayAuthSecret", () => {
  const b64 = (value: string) => Buffer.from(value).toString("base64");
  const request = { namespace: "octogee-test", gatewayId: "gw-test-op" };

  it("reads and base64-decodes the token and the published agent-store credentials from the K8s secret", async () => {
    const data = { token: b64("token-for-gw"), "agent-store-dsn": b64("postgresql://gw:token-for-gw@private/agents"), "agent-store-owner": b64("shared") };
    const { runKubectl, calls } = mockKubectl([{ stdout: JSON.stringify({ data }), code: 0 }]);

    await expect(readGatewayAuthSecret({ runKubectl }, request)).resolves.toEqual({
      token: "token-for-gw",
      agentStoreDsn: "postgresql://gw:token-for-gw@private/agents",
      agentStoreOwner: "shared",
    });

    expect(calls[0]).toEqual(["get", "secret", "gateway-auth-token-gw-test-op", "-n", "octogee-test", "-o", "json"]);
  });

  it("leaves unpublished agent-store credentials undefined", async () => {
    const { runKubectl } = mockKubectl([{ stdout: JSON.stringify({ data: { token: b64("token-for-gw") } }), code: 0 }]);
    await expect(readGatewayAuthSecret({ runKubectl }, request)).resolves.toEqual({ token: "token-for-gw", agentStoreDsn: undefined, agentStoreOwner: undefined });
  });

  it.each([
    ["an empty token", JSON.stringify({ data: { token: "" } }), "has no token data"],
    ["no data", JSON.stringify({ metadata: {} }), "has no token data"],
    ["unreadable output", "not json", "is not readable"],
  ])("refuses a secret with %s", async (_shape, stdout, message) => {
    const { runKubectl } = mockKubectl([{ stdout, code: 0 }]);
    await expect(readGatewayAuthSecret({ runKubectl }, request)).rejects.toThrow(message);
  });

  it("surfaces a failed secret read", async () => {
    const { runKubectl } = mockKubectl([{ stderr: "forbidden", code: 1 }]);
    await expect(readGatewayAuthSecret({ runKubectl }, request)).rejects.toThrow("failed (code=1): forbidden");
  });
});
