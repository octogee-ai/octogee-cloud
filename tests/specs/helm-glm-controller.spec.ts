import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import { parse, parseAllDocuments } from "yaml";

const REPO_ROOT = path.resolve(__dirname, "../..");
const CHART_PATH = path.join(REPO_ROOT, "helm/octogee/charts/glm-controller");
const REQUIRED_VALUES: Record<string, string> = {
  "global.ingressClassName": "gce",
  "global.deploymentTargetId": "test-central",
  "global.deploymentProjectId": "octogee-test",
  "image.repository": "registry.example/glm-controller",
  "image.tag": "abc1234",
  "image.digest": "sha256:" + "d".repeat(64),
  "platformRelease.sourceSha": "a".repeat(40),
  "platformRelease.gatewayImageRepository": "registry.example/octogee-gateway",
  "platformRelease.gatewayImageTag": "abc1234@sha256:" + "a".repeat(64),
  "platformRelease.builderImageTag": "abc1234@sha256:" + "c".repeat(64),
  "platformRelease.gatewayEdgeImageRepository": "registry.example/gateway-edge",
  "platformRelease.gatewayEdgeImageTag": "abc1234@sha256:" + "b".repeat(64),
  "sharedPool.minReplicas": "1",
  "sharedPool.maxReplicas": "8",
  gatewayServiceAccount: "octogee-gateway@octogee-test.iam.gserviceaccount.com",
  workloadIdentityProject: "octogee",
  kmsKeyName: "projects/octogee-test/locations/us-central1/keyRings/octogee-creds/cryptoKeys/integrations-at-rest",
};

beforeAll(() => {
  if (!fs.existsSync(CHART_PATH)) {
    throw new Error(`glm-controller chart not found at ${CHART_PATH}`);
  }
});

function helmTemplate(setValues: Record<string, string> = {}, chartPath = CHART_PATH): string {
  const args = [
    "template",
    "octogee-glm-controller",
    chartPath,
    "--set",
    "global.publicAppOrigins[0]=https://app-test.octogee.com",
    "--namespace=octogee-test",
  ];
  for (const [k, v] of Object.entries({ ...REQUIRED_VALUES, ...setValues })) {
    args.push("--set", `${k}=${v}`);
  }
  const result = spawnSync("helm", args, { encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(
      `helm template failed (status=${result.status}):\n--- stderr ---\n${result.stderr}\n--- stdout ---\n${result.stdout}`,
    );
  }
  return result.stdout;
}

function findDoc(out: string, kind: string, name: string): string | null {
  const docs = out.split(/^---\s*$/m);
  return (
    docs.find(
      (d) =>
        new RegExp(`^kind:\\s*${kind}\\s*$`, "m").test(d) &&
        new RegExp(`^\\s*name:\\s*${name}\\s*$`, "m").test(d),
    ) ?? null
  );
}

describe("glm-controller chart", () => {
  it("renders PostgreSQL credentials and migrations without the umbrella chart", () => {
    const out = helmTemplate({});
    const deployment = findDoc(out, "Deployment", "glm-controller");
    const migration = findDoc(out, "Job", "platform-state-migrate");

    expect(deployment).toContain("name: PLATFORM_DB_HOST");
    expect(deployment).toContain("key: runtime-user");
    expect(deployment).not.toContain("key: migration-user");
    expect(migration).toContain("key: migration-user");
    expect(migration).toContain("key: migration-password");
  });

  it("keeps GCE disposal off independently of runtime selection and renders the reviewed contract", () => {
    const vm = {
      "global.computer.enabled": "true",
      "global.computer.projectId": "octogee-test",
      "global.computer.vmSpec.machineType": "n2-standard-2",
      "global.computer.kubernetesApiHost": "10.0.0.1",
    };
    const defaultOutput = helmTemplate(vm);
    expect(defaultOutput).toMatch(/name: GATEWAY_BUILDER_DISPOSABLE_PARKING\s+value: "false"/);
    expect(defaultOutput).toMatch(/name: GATEWAY_BUILDER_DISPOSABLE_STATE_CONTRACT\s+value: "unverified"/);
    const enabled = helmTemplate({ ...vm, "computerParking.disposable": "true", "computerParking.stateContract": "checkpointed-home-only-v2" });
    expect(enabled).toMatch(/name: GATEWAY_BUILDER_DISPOSABLE_PARKING\s+value: "true"/);
    expect(enabled).toMatch(/name: GATEWAY_BUILDER_DISPOSABLE_STATE_CONTRACT\s+value: "checkpointed-home-only-v2"/);
  });

  it("renders a ServiceAccount named glm-controller", () => {
    const out = helmTemplate();
    const sa = findDoc(out, "ServiceAccount", "glm-controller");
    expect(sa).not.toBeNull();
  });

  it("renders a NEG-backed Service with a long-lived BackendConfig for admin event streams", () => {
    const out = helmTemplate();
    const svc = findDoc(out, "Service", "glm-controller");
    expect(svc).not.toBeNull();
    expect(svc).toMatch(/cloud\.google\.com\/neg:\s*'?\{"ingress":true\}'?/);
    expect(svc).toMatch(/cloud\.google\.com\/backend-config:\s*'?\{"default":"glm-controller-backend"\}'?/);

    const backend = findDoc(out, "BackendConfig", "glm-controller-backend");
    expect(backend).not.toBeNull();
    expect(backend).toMatch(/timeoutSec:\s*3600/);
  });

  it("annotates the ServiceAccount with iam.gke.io/gcp-service-account for Workload Identity", () => {
    const out = helmTemplate({
      "gcpServiceAccount": "glm-controller@octogee-test.iam.gserviceaccount.com",
    });
    const sa = findDoc(out, "ServiceAccount", "glm-controller");
    expect(sa).toMatch(
      /iam\.gke\.io\/gcp-service-account:\s*"?glm-controller@octogee-test\.iam\.gserviceaccount\.com"?/,
    );
  });

  it("renders a namespace-scoped Role with the resource permissions the reconciler needs", () => {
    const out = helmTemplate();
    const role = findDoc(out, "Role", "glm-controller");
    expect(role).not.toBeNull();
    expect(role).toMatch(/resources:[\s\S]*?deployments/);
    expect(role).toMatch(/resources:[\s\S]*?services/);
    expect(role).toMatch(/resources:[\s\S]*?poddisruptionbudgets/);
    expect(role).toMatch(/resources:[\s\S]*?ingresses/);
    expect(role).toMatch(/resources:[\s\S]*?managedcertificates/);
    expect(role).toMatch(/resources:[\s\S]*?backendconfigs/);
    expect(role).toMatch(/resources:[\s\S]*?secrets/);
  });

  it("Role grants patch on deployments/scale — kubectl scale (pause/resume) hits the scale subresource, which RBAC does NOT cover via the bare deployments grant", () => {
    const out = helmTemplate();
    const role = findDoc(out, "Role", "glm-controller");
    expect(role).not.toBeNull();
    // The scale subresource is a distinct RBAC resource. Without it, the SA
    // can patch a Deployment's spec but `kubectl scale deploy/X` 403s with
    // "cannot patch resource deployments/scale" — the exact failure that
    // blocked pause/resume in TEST after the kubectl-primitives switch.
    const rule = role!.match(
      /- apiGroups:[^\n]*"apps"[\s\S]*?resources:[^\n]*deployments\/scale[\s\S]*?verbs:\s*\[(.*?)\]/,
    );
    expect(rule, "expected an apps rule listing deployments/scale").not.toBeNull();
    expect(rule![1], "deployments/scale verbs").toMatch(/patch/);
  });

  it("Role grants create on pods/exec — the restart-gateway op runs `kubectl exec ... openclaw gateway restart` (in-process restart), which RBAC does NOT cover via the bare pods get/list/watch grant", () => {
    const out = helmTemplate();
    const role = findDoc(out, "Role", "glm-controller");
    expect(role).not.toBeNull();
    // pods/exec is a distinct create-only RBAC subresource. Without it the SA
    // can read pods but `kubectl exec deploy/X -- ...` 403s with "cannot create
    // resource pods/exec". The restart-gateway handler switched from
    // `kubectl rollout restart` (covered by the deployments patch grant) to an
    // in-process OpenClaw restart via exec, so this grant is now load-bearing.
    const rule = role!.match(
      /- apiGroups:[^\n]*\n\s*resources:[^\n]*pods\/exec[\s\S]*?verbs:\s*\[(.*?)\]/,
    );
    expect(rule, "expected a rule listing pods/exec").not.toBeNull();
    expect(rule![1], "pods/exec verbs").toMatch(/create/);
  });

  it("Role can create, clean up, and read logs from Helm test hook pods", () => {
    const role = findDoc(helmTemplate(), "Role", "glm-controller");
    expect(role).not.toBeNull();
    const podRule = role!.match(
      /- apiGroups:[^\n]*\n\s*resources:\s*\["pods",\s*"events"\][\s\S]*?verbs:\s*\[(.*?)\]/,
    );
    expect(podRule, "expected the pods rule used by Helm test hooks").not.toBeNull();
    expect(podRule![1]).toMatch(/create/);
    expect(podRule![1]).toMatch(/delete/);

    const logRule = role!.match(
      /- apiGroups:[^\n]*\n\s*resources:\s*\["pods\/log"\][\s\S]*?verbs:\s*\[(.*?)\]/,
    );
    expect(logRule, "expected a pods/log rule for helm test --logs").not.toBeNull();
    expect(logRule![1]).toMatch(/get/);
  });

  it("Role grants CRUD on every namespace-scoped kind helm patches on every revision — including configmaps, serviceaccounts, cronjobs, statefulsets, RBAC", () => {
    const out = helmTemplate();
    const role = findDoc(out, "Role", "glm-controller");
    expect(role).not.toBeNull();

    const requireCrud = (resource: string) => {
      const rule = role!.match(
        new RegExp(
          `- apiGroups:[^\\n]*\\n\\s*resources:[^\\n]*${resource}[\\s\\S]*?verbs:\\s*\\[(.*?)\\]`,
        ),
      );
      expect(rule, `expected a rule for ${resource}`).not.toBeNull();
      expect(rule![1], `${resource} verbs`).toMatch(/patch/);
      expect(rule![1], `${resource} verbs`).toMatch(/create/);
      expect(rule![1], `${resource} verbs`).toMatch(/delete/);
    };

    for (const kind of [
      "configmaps",
      "serviceaccounts",
      "cronjobs",
      "statefulsets",
      "roles",
      "rolebindings",
    ]) {
      requireCrud(kind);
    }
  });

  it("Role grants CRUD on gateway-instance PVCs rendered by controller-owned releases", () => {
    const out = helmTemplate();
    const role = findDoc(out, "Role", "glm-controller");
    expect(role).not.toBeNull();
    const pvcRule = role!.match(
      /- apiGroups:[^\n]*\n\s*resources:[^\n]*persistentvolumeclaims[\s\S]*?verbs:\s*\[(.*?)\]/,
    );
    expect(pvcRule).not.toBeNull();
    expect(pvcRule![1]).toMatch(/create/);
    expect(pvcRule![1]).toMatch(/update/);
    expect(pvcRule![1]).toMatch(/patch/);
    expect(pvcRule![1]).toMatch(/delete/);
  });

  it("grants the namespace controller no cluster-scoped access", () => {
    const kinds = parseAllDocuments(helmTemplate()).map(document => document.toJSON()?.kind);
    expect(kinds).not.toContain("ClusterRole");
    expect(kinds).not.toContain("ClusterRoleBinding");
  });

  it("renders a RoleBinding wiring the SA to the Role", () => {
    const out = helmTemplate();
    const binding = findDoc(out, "RoleBinding", "glm-controller");
    expect(binding).not.toBeNull();
    expect(binding).toMatch(/kind:\s*Role/);
    expect(binding).toMatch(/name:\s*glm-controller/);
  });

  it("renders a single-replica Deployment using the configured image", () => {
    const out = helmTemplate({
      "image.repository": "ghcr.io/octogee-ai/octogee-cloud/glm-controller",
      "image.tag": "abc1234",
    });
    const dep = findDoc(out, "Deployment", "glm-controller");
    expect(dep).not.toBeNull();
    expect(dep).toMatch(/replicas:\s*1/);
    expect(dep).toMatch(
      /image:\s*"ghcr\.io\/octogee-ai\/octogee-cloud\/glm-controller:abc1234@sha256:d{64}"/,
    );
    
    expect(dep).toMatch(/strategy:[\s\S]*?type:\s*Recreate/);
  });

  it("Deployment uses the glm-controller ServiceAccount", () => {
    const out = helmTemplate();
    const dep = findDoc(out, "Deployment", "glm-controller");
    expect(dep).toMatch(/serviceAccountName:\s*glm-controller/);
  });

  it("Deployment passes K8S_NAMESPACE via downward API", () => {
    const out = helmTemplate();
    const dep = findDoc(out, "Deployment", "glm-controller");
    expect(dep).toMatch(/name:\s*K8S_NAMESPACE[\s\S]*?fieldPath:\s*metadata\.namespace/);
  });

  it("Deployment has no retired activation or idle-sleep sweep controls", () => {
    const dep = findDoc(helmTemplate(), "Deployment", "glm-controller");
    expect(dep).not.toMatch(/ACTIVATION_LEASE_SWEEP_MS/);
    expect(dep).not.toMatch(/DEDICATED_GATEWAY_IDLE_(?:MS|SWEEP_MS)/);
  });

  it("Deployment passes the exact deployment target and data project", () => {
    const dep = findDoc(helmTemplate(), "Deployment", "glm-controller");
    expect(dep).toMatch(/name:\s*DEPLOYMENT_TARGET_ID\s*\n\s*value:\s*"test-central"/);
    expect(dep).toMatch(/name:\s*GOOGLE_CLOUD_PROJECT\s*\n\s*value:\s*"octogee-test"/);
  });

  it("Deployment passes the selected platform build and separate OpenClaw source SHA to the fleet controller", () => {
    const sourceSha = "a".repeat(40);
    const openclawSourceSha = "f".repeat(40);
    const dep = findDoc(helmTemplate({
      "platformRelease.sourceSha": sourceSha,
      "platformRelease.openclawSourceSha": openclawSourceSha,
    }), "Deployment", "glm-controller");
    expect(dep).toMatch(new RegExp(`name:\\s*BUILD_SHA\\s*\\n\\s*value:\\s*"${sourceSha}"`));
    expect(dep).toMatch(new RegExp(`name:\\s*OPENCLAW_FORK_SHA\\s*\\n\\s*value:\\s*"${openclawSourceSha}"`));
  });

  it.each(["", "abc1234", "g".repeat(40)])("rejects an omitted or invalid platform build identity before a Helm upgrade: %s", sourceSha => {
    expect(() => helmTemplate({ "platformRelease.sourceSha": sourceSha })).toThrow("full 40-character immutable build SHA");
  });

  it("Deployment passes the explicit GKE Workload Identity pool project", () => {
    const out = helmTemplate();
    const dep = findDoc(out, "Deployment", "glm-controller");
    expect(dep).toMatch(/name:\s*GKE_WORKLOAD_IDENTITY_PROJECT\s*\n\s*value:\s*"octogee"/);
    expect(dep).toMatch(/name:\s*GATEWAY_SERVICE_ACCOUNT\s*\n\s*value:\s*"octogee-gateway@octogee-test\.iam\.gserviceaccount\.com"/);
  });

  it("passes the root key from a Secret when Cloud KMS is unset", () => {
    const rendered = helmTemplate({ kmsKeyName: "", "global.encryptionRootKeySecretName": "factory-root-key" });
    const deployment = findDoc(rendered, "Deployment", "glm-controller");
    expect(deployment).toMatch(/name:\s*ENCRYPTION_ROOT_KEY\s*\n\s*valueFrom:\s*\n\s*secretKeyRef:\s*\n\s*name:\s*"factory-root-key"\s*\n\s*key:\s*root-key/);
    expect(deployment).not.toContain("OCTOGEE_KMS_KEY_NAME");
  });

  it("Deployment passes the integration KMS key needed for account-deletion revocation", () => {
    const dep = findDoc(helmTemplate(), "Deployment", "glm-controller");
    expect(dep).toMatch(
      /name:\s*OCTOGEE_KMS_KEY_NAME\s*\n\s*value:\s*"projects\/octogee-test\/locations\/us-central1\/keyRings\/octogee-creds\/cryptoKeys\/integrations-at-rest"/,
    );
  });

  it("Deployment injects only the fleet controller private key", () => {
    const out = helmTemplate();
    const dep = findDoc(out, "Deployment", "glm-controller");
    expect(dep).toMatch(
      /name:\s*FLEET_CONTROLLER_PRIVATE_KEY[\s\S]*?secretKeyRef:[\s\S]*?name:\s*octogee-fleet-controller[\s\S]*?key:\s*private-key/,
    );
    expect(dep).not.toMatch(/name:\s*FLEET_CONTROLLER_SECRET\b/);
    expect(dep).not.toMatch(/name:\s*FLEET_CONTROLLER_PUBLIC_KEY\b/);
  });

  it("mounts no secret env entries without the chart's secret-env files", () => {
    const dep = findDoc(helmTemplate(), "Deployment", "glm-controller") ?? "";
    expect(dep).toContain("FLEET_CONTROLLER_PRIVATE_KEY");
    expect(dep).not.toContain("STRIPE");
  });

  it("Deployment wires the model-key issuer over a dedicated bearer secret", () => {
    const out = helmTemplate();
    const dep = findDoc(out, "Deployment", "glm-controller") ?? "";
    expect(dep).toMatch(
      /name:\s*GATEWAY_MODEL_KEY_ISSUER_URL[\s\S]*?value:\s*"http:\/\/octogee-api\.octogee-test\.svc\.cluster\.local:3001\/internal\/model-keys\/issue"/,
    );
    expect(dep).toMatch(
      /name:\s*GATEWAY_MODEL_KEY_REVOKE_URL[\s\S]*?value:\s*"http:\/\/octogee-api\.octogee-test\.svc\.cluster\.local:3001\/internal\/model-keys\/revoke"/,
    );
    expect(dep).toMatch(
      /name:\s*GATEWAY_MODEL_KEY_ISSUER_BEARER_TOKEN[\s\S]*?secretKeyRef:[\s\S]*?name:\s*gateway-model-key-issuer[\s\S]*?key:\s*bearer_token/,
    );
    expect(dep).not.toMatch(/name:\s*INTERNAL_SERVICE_KEY\b/);
  });

  it("passes Google sign-in settings to the controller only when they are set", () => {
    expect(findDoc(helmTemplate(), "Deployment", "glm-controller")).not.toContain("FLEET_GOOGLE_CLIENT_ID");
    const dep = findDoc(helmTemplate({
      "fleetIdentity.googleClientId": "client-id",
      "fleetIdentity.operatorEmails[0]": "ada@example.com",
      "fleetIdentity.operatorEmails[1]": "grace@example.com",
    }), "Deployment", "glm-controller") ?? "";
    expect(dep).toMatch(/name:\s*FLEET_GOOGLE_CLIENT_ID\s*\n\s*value:\s*"client-id"/);
    expect(dep).toMatch(/name:\s*FLEET_OPERATOR_EMAILS\s*\n\s*value:\s*"ada@example\.com,grace@example\.com"/);
  });

  it("passes the operator public key from its Secret only when one is named", () => {
    expect(findDoc(helmTemplate(), "Deployment", "glm-controller")).not.toContain("FLEET_OPERATOR_PUBLIC_KEY");
    const dep = findDoc(helmTemplate({ "fleetIdentity.operatorKeySecretName": "fleet-operator-key" }), "Deployment", "glm-controller") ?? "";
    expect(dep).toMatch(
      /name:\s*FLEET_OPERATOR_PUBLIC_KEY\s*\n\s*valueFrom:\s*\n\s*secretKeyRef:\s*\n\s*name:\s*"fleet-operator-key"\s*\n\s*key:\s*public-key/,
    );
  });

  it("reads the bundled deployment targets and gateway values unless the installation supplies its own", () => {
    const bundled = helmTemplate();
    expect(findDoc(bundled, "ConfigMap", "glm-controller-configuration")).toBeNull();
    const bundledDeployment = findDoc(bundled, "Deployment", "glm-controller") ?? "";
    expect(bundledDeployment).not.toContain("OCTOGEE_DEPLOYMENT_TARGETS");
    expect(bundledDeployment).not.toContain("GATEWAY_VALUES_FILE");

    const rendered = helmTemplate({
      "deploymentTargets.activeTargets.kind": "kind",
      "gatewayValues.runtimeClassName": "runc",
    });
    const configuration = parseAllDocuments(rendered)
      .map(document => document.toJSON())
      .find(document => document?.kind === "ConfigMap" && document.metadata?.name === "glm-controller-configuration");
    expect(JSON.parse(configuration.data["deployment-targets.json"])).toEqual({ activeTargets: { kind: "kind" } });
    expect(parse(configuration.data["gateway-values.yaml"])).toEqual({ runtimeClassName: "runc" });
    const dep = findDoc(rendered, "Deployment", "glm-controller") ?? "";
    expect(dep).toMatch(/name:\s*OCTOGEE_DEPLOYMENT_TARGETS\s*\n\s*value:\s*\/etc\/octogee\/configuration\/deployment-targets\.json/);
    expect(dep).toMatch(/name:\s*GATEWAY_VALUES_FILE\s*\n\s*value:\s*\/etc\/octogee\/configuration\/gateway-values\.yaml/);
    expect(dep).toMatch(/name:\s*configuration\s*\n\s*mountPath:\s*\/etc\/octogee\/configuration\s*\n\s*readOnly:\s*true/);
    expect(dep).toMatch(/name:\s*configuration\s*\n\s*configMap:\s*\n\s*name:\s*glm-controller-configuration/);
  });

  it("restarts the controller when the installation's deployment targets or gateway values change", () => {
    const checksum = (values: Record<string, string>) =>
      parse(findDoc(helmTemplate(values), "Deployment", "glm-controller") ?? "").spec.template.metadata.annotations?.["checksum/configuration"];
    const targets = { "deploymentTargets.activeTargets.kind": "kind" };

    expect(checksum({})).toBeUndefined();
    expect(checksum(targets)).toMatch(/^[0-9a-f]{16}$/);
    expect(checksum(targets)).toBe(checksum(targets));
    expect(checksum({ "deploymentTargets.activeTargets.kind": "other" })).not.toBe(checksum(targets));
    expect(checksum({ ...targets, "gatewayValues.runtimeClassName": "runc" })).not.toBe(checksum(targets));
  });

  it("leaves account retirement to the product chart", () => {
    const platform = findDoc(helmTemplate(), "Deployment", "glm-controller") ?? "";
    expect(platform).not.toContain("PROJECT_HOSTING_RETIREMENT_URL");
    expect(platform).not.toContain("project-hosting-retirement");
  });
  it("names the GCS blob bucket only for a GCS backend and refuses a GCS backend without one", () => {
    const gcs = findDoc(helmTemplate({ "global.blobStoreBackend": "gcs", "global.blobStore.gcsBucket": "blobs.example" }), "Deployment", "glm-controller");
    expect(gcs).toMatch(/name: BLOB_GCS_BUCKET\s+value: "blobs\.example"/);
    expect(() => helmTemplate({ "global.blobStoreBackend": "gcs" })).toThrow("global.blobStore.gcsBucket is required");
    expect(findDoc(helmTemplate(), "Deployment", "glm-controller")).not.toContain("BLOB_GCS_BUCKET");
  });
});
