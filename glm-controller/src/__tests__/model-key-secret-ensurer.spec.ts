import { describe, expect, it, vi } from "vitest";
import {
  GATEWAY_MODEL_KEY_DATA_KEY,
  createGatewayModelKeySecretEnsurer,
  gatewayModelKeySecretName,
  type GatewayModelKeySourceSecret,
} from "../model-key-secret-ensurer";
import type { KubectlSubprocess } from "../fleet-ingress";

function encoded(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function source(
  value = "sk-ant-gateway-key",
  labels: Record<string, string> = {
    octogee_kind: "gateway_model_key",
    gateway_id: "jack",
    provider: "anthropic",
    capped: "true",
  },
): GatewayModelKeySourceSecret {
  return { value, labels };
}

function existingSecretJson(value: string, gatewayId = "jack"): string {
  return JSON.stringify({
    metadata: {
      labels: {
        "app.kubernetes.io/managed-by": "glm-controller",
        "octogee.ai/secret-kind": "gateway-model-key",
        "octogee.ai/gateway-id": gatewayId,
        "octogee.ai/provider": "anthropic",
      },
      annotations: {
        "octogee.ai/source-secret": gatewayModelKeySecretName(gatewayId),
        "octogee.ai/source-contract":
          "Secret Manager labels octogee_kind=gateway_model_key,gateway_id=<gateway>,provider=anthropic,capped=true",
      },
    },
    data: { [GATEWAY_MODEL_KEY_DATA_KEY]: encoded(value) },
  });
}

function mockKubectl(
  responses: Array<{ stdout?: string; stderr?: string; code?: number }>,
): {
  runKubectl: KubectlSubprocess;
  calls: Array<{ args: string[]; stdin?: string }>;
} {
  const calls: Array<{ args: string[]; stdin?: string }> = [];
  let i = 0;
  const runKubectl: KubectlSubprocess = vi.fn(async (args, opts) => {
    calls.push({ args, stdin: opts?.stdin });
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

describe("createGatewayModelKeySecretEnsurer", () => {
  it("deletes the K8s model key secret for non-isolated gateways", async () => {
    const { runKubectl, calls } = mockKubectl([
      { stdout: "secret/gateway-model-key-jack\n" },
      { stdout: "secret \"gateway-model-key-jack\" deleted\n" },
    ]);
    const readSourceSecret = vi.fn();
    const ensurer = createGatewayModelKeySecretEnsurer({
      runKubectl,
      readSourceSecret,
      log: vi.fn(),
    });

    const result = await ensurer.syncGatewayModelKeySecret({
      namespace: "octogee-test",
      gatewayId: "jack",
      gatewayClass: "shared",
    });

    expect(result).toMatchObject({
      action: "deleted",
      changed: true,
      reason: "non_builder",
    });
    expect(readSourceSecret).not.toHaveBeenCalled();
    expect(calls[1].args).toEqual([
      "delete",
      "secret/gateway-model-key-jack",
      "-n",
      "octogee-test",
      "--ignore-not-found=true",
    ]);
  });

  it("applies a broker token secret for isolated gateways", async () => {
    const { runKubectl, calls } = mockKubectl([
      {
        stderr:
          'Error from server (NotFound): secrets "gateway-model-key-walter" not found',
        code: 1,
      },
      { stdout: "secret/gateway-model-key-walter configured\n" },
    ]);
    const ensurer = createGatewayModelKeySecretEnsurer({
      runKubectl,
      readSourceSecret: vi.fn(async () =>
        source("ogk_walter_token", {
          octogee_kind: "gateway_model_key",
          gateway_id: "walter",
          provider: "anthropic",
          capped: "true",
        }),
      ),
      log: vi.fn(),
    });

    const result = await ensurer.syncGatewayModelKeySecret({
      namespace: "octogee-test",
      gatewayId: "walter",
      gatewayClass: "isolated",
    });

    expect(result).toMatchObject({ action: "upserted", changed: true });
    expect(calls[1].args).toEqual(["apply", "-f", "-"]);
    const manifest = JSON.parse(calls[1].stdin ?? "{}");
    expect(manifest).toMatchObject({
      metadata: {
        name: "gateway-model-key-walter",
        labels: {
          "octogee.ai/gateway-id": "walter",
          "octogee.ai/provider": "anthropic",
        },
      },
      stringData: { anthropic_api_key: "ogk_walter_token" },
    });
  });

  it("does not create a user key when the Secret Manager source is missing", async () => {
    const { runKubectl } = mockKubectl([
      {
        stderr:
          'Error from server (NotFound): secrets "gateway-model-key-jack" not found',
        code: 1,
      },
    ]);
    const ensurer = createGatewayModelKeySecretEnsurer({
      runKubectl,
      readSourceSecret: vi.fn(async () => null),
      log: vi.fn(),
    });

    const result = await ensurer.syncGatewayModelKeySecret({
      namespace: "octogee-test",
      gatewayId: "jack",
      gatewayClass: "isolated",
    });

    expect(result).toMatchObject({
      action: "skipped",
      changed: false,
      reason: "missing_source",
    });
  });

  it("refuses an unlabeled source secret and removes any mounted fallback", async () => {
    const { runKubectl } = mockKubectl([
      { stdout: "secret/gateway-model-key-jack\n" },
      { stdout: "secret \"gateway-model-key-jack\" deleted\n" },
    ]);
    const log = vi.fn();
    const ensurer = createGatewayModelKeySecretEnsurer({
      runKubectl,
      readSourceSecret: vi.fn(async () => source("sk-ant", {})),
      log,
    });

    const result = await ensurer.syncGatewayModelKeySecret({
      namespace: "octogee-test",
      gatewayId: "jack",
      gatewayClass: "isolated",
    });

    expect(result).toMatchObject({
      action: "deleted",
      changed: true,
      reason: "invalid_source_labels",
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("missing required label"));
  });

  it("applies a labeled capped source secret into the gateway-scoped K8s secret", async () => {
    const { runKubectl, calls } = mockKubectl([
      {
        stderr:
          'Error from server (NotFound): secrets "gateway-model-key-jack" not found',
        code: 1,
      },
      { stdout: "secret/gateway-model-key-jack configured\n" },
    ]);
    const ensurer = createGatewayModelKeySecretEnsurer({
      runKubectl,
      readSourceSecret: vi.fn(async () => source("sk-ant-capped")),
      log: vi.fn(),
    });

    const result = await ensurer.syncGatewayModelKeySecret({
      namespace: "octogee-test",
      gatewayId: "jack",
      gatewayClass: "isolated",
    });

    expect(result).toMatchObject({ action: "upserted", changed: true });
    expect(calls[1].args).toEqual(["apply", "-f", "-"]);
    const manifest = JSON.parse(calls[1].stdin ?? "{}");
    expect(manifest).toMatchObject({
      kind: "Secret",
      metadata: {
        name: "gateway-model-key-jack",
        namespace: "octogee-test",
        labels: {
          "octogee.ai/secret-kind": "gateway-model-key",
          "octogee.ai/gateway-id": "jack",
          "octogee.ai/provider": "anthropic",
        },
      },
      stringData: { anthropic_api_key: "sk-ant-capped" },
    });
  });

  it("no-ops when the K8s secret already matches the labeled source", async () => {
    const { runKubectl, calls } = mockKubectl([
      { stdout: existingSecretJson("sk-ant-capped") },
    ]);
    const ensurer = createGatewayModelKeySecretEnsurer({
      runKubectl,
      readSourceSecret: vi.fn(async () => source("sk-ant-capped")),
      log: vi.fn(),
    });

    const result = await ensurer.syncGatewayModelKeySecret({
      namespace: "octogee-test",
      gatewayId: "jack",
      gatewayClass: "isolated",
    });

    expect(result).toMatchObject({ action: "unchanged", changed: false });
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0]).toBe("get");
  });
});
