import { describe, it, expect, vi } from "vitest";
import {
  createGatewayServiceAccountEnsurer,
  serviceAccountManifest,
} from "../gateway-service-account-ensurer.js";
import type { KubectlSubprocess, KubectlSubprocessResult } from "../fleet-ingress.js";

function ok(stdout = ""): KubectlSubprocessResult {
  return { stdout, stderr: "", code: 0 };
}

const identity = {
  gatewayId: "default",
  deploymentTargetId: "prod-west",
  releaseName: "octogee-gw-default",
  lifecycleIdentity: "gateway-default",
};

describe("serviceAccountManifest", () => {
  it("always renders Helm's keep policy on the gateway-scoped ServiceAccount", () => {
    const m = serviceAccountManifest({ namespace: "octogee", serviceAccountName: "octogee-gw-default", identity });
    expect(JSON.parse(m)).toMatchObject({
      kind: "ServiceAccount",
      metadata: {
        name: "octogee-gw-default",
        namespace: "octogee",
        annotations: { "helm.sh/resource-policy": "keep" },
      },
    });
  });

  it("renders the Workload Identity annotation for isolated gateways", () => {
    const m = serviceAccountManifest({
      namespace: "octogee",
      serviceAccountName: "octogee-gw-walter",
      identity: { ...identity, gatewayId: "walter", releaseName: "octogee-gw-walter", lifecycleIdentity: "gateway-walter" },
      annotations: { "iam.gke.io/gcp-service-account": "gw@proj.iam.gserviceaccount.com" },
    });
    expect(JSON.parse(m).metadata.annotations).toMatchObject({
      "iam.gke.io/gcp-service-account": "gw@proj.iam.gserviceaccount.com",
      "helm.sh/resource-policy": "keep",
    });
  });

  it("stamps fleet controller lifecycle ownership onto every dynamic gateway KSA", () => {
    const m = serviceAccountManifest({
      namespace: "octogee-test-west",
      serviceAccountName: "octogee-gw-builder-a",
      identity: {
        gatewayId: "builder-a",
        deploymentTargetId: "test-west",
        releaseName: "octogee-gw-builder-a",
        lifecycleIdentity: "gateway-user-a",
      },
    });

    expect(JSON.parse(m).metadata.labels).toMatchObject({
      "app.kubernetes.io/managed-by": "glm-controller",
      "octogee.ai/controller": "cowboy",
      "octogee.ai/gateway-id": "builder-a",
      "octogee.ai/deployment-target": "test-west",
      "octogee.ai/release": "octogee-gw-builder-a",
      "octogee.ai/lifecycle-identity": "gateway-user-a",
    });
  });

  it("does not allow caller annotations to override reserved ownership metadata", () => {
    const m = serviceAccountManifest({
      namespace: "octogee-test-west",
      serviceAccountName: "octogee-gw-default",
      identity,
      annotations: {
        "helm.sh/resource-policy": "delete",
        "iam.gke.io/gcp-service-account": "gw@proj.iam.gserviceaccount.com",
        "octogee.ai/controller": "other-controller",
      },
    });

    const annotations = JSON.parse(m).metadata.annotations;
    expect(annotations).toMatchObject({
      "helm.sh/resource-policy": "keep",
      "iam.gke.io/gcp-service-account": "gw@proj.iam.gserviceaccount.com",
      "octogee.ai/controller": "cowboy",
    });
    expect(annotations["helm.sh/resource-policy"]).not.toBe("delete");
    expect(annotations["octogee.ai/controller"]).not.toBe("other-controller");
  });

  it("renders untrusted annotation strings as one JSON manifest", () => {
    const annotationValue = "gw@example.iam.gserviceaccount.com\n---\napiVersion: batch/v1\nkind: Job";
    const manifest = serviceAccountManifest({
      namespace: "octogee",
      serviceAccountName: "octogee-gw-default",
      identity,
      annotations: { "iam.gke.io/gcp-service-account": annotationValue },
    });

    expect(JSON.parse(manifest)).toMatchObject({
      apiVersion: "v1",
      kind: "ServiceAccount",
      metadata: {
        annotations: { "iam.gke.io/gcp-service-account": annotationValue },
      },
    });
  });
});

describe("createGatewayServiceAccountEnsurer", () => {
  it("applies the gateway-scoped KSA via kubectl apply -f - (idempotent create-or-update)", async () => {
    const runKubectl = vi.fn<KubectlSubprocess>(async () => ok());
    const log = vi.fn();
    const ensurer = createGatewayServiceAccountEnsurer({ runKubectl, log });

    await ensurer.ensureServiceAccount({
      namespace: "octogee",
      serviceAccountName: "octogee-gw-default",
      identity,
    });

    expect(runKubectl).toHaveBeenCalledTimes(1);
    const [args, opts] = runKubectl.mock.calls[0];
    expect(args).toEqual(["apply", "-n", "octogee", "-f", "-"]);
    expect(JSON.parse(opts?.stdin ?? "")).toMatchObject({ metadata: { name: "octogee-gw-default" } });
  });

  it("passes the operator Workload Identity annotation into the applied manifest", async () => {
    const runKubectl = vi.fn<KubectlSubprocess>(async () => ok());
    const ensurer = createGatewayServiceAccountEnsurer({ runKubectl, log: vi.fn() });

    await ensurer.ensureServiceAccount({
      namespace: "octogee",
      serviceAccountName: "octogee-gw-walter",
      identity: { ...identity, gatewayId: "walter", releaseName: "octogee-gw-walter", lifecycleIdentity: "gateway-walter" },
      annotations: { "iam.gke.io/gcp-service-account": "gw@proj.iam.gserviceaccount.com" },
    });

    const [, opts] = runKubectl.mock.calls[0];
    expect(JSON.parse(opts?.stdin ?? "")).toMatchObject({
      metadata: {
        annotations: { "iam.gke.io/gcp-service-account": "gw@proj.iam.gserviceaccount.com" },
      },
    });
  });

  it("throws (no silent failure) when kubectl apply fails", async () => {
    const runKubectl = vi.fn(async () => ({ stdout: "", stderr: "boom", code: 1 }));
    const ensurer = createGatewayServiceAccountEnsurer({ runKubectl, log: vi.fn() });

    await expect(
      ensurer.ensureServiceAccount({ namespace: "octogee", serviceAccountName: "octogee-gw-default", identity }),
    ).rejects.toThrow(/octogee-gw-default/);
  });
});
