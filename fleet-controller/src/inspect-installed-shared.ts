import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { deploymentSettingsForRuntime } from "@octogee/core/deployment-environment";
import { isReleasePayload, releasePayloadHash, type ReleasePayload } from "@octogee/shared/types/gateway-releases";
import { asDurableGatewayRoot, type DurableGatewayRoot } from "@octogee/core/gateway-release-append";
import { computeChartFingerprint } from "./chart-fingerprint.js";
import { createHelmSubprocessRunner, spawnHelm } from "./helm-runner.js";
import { platformGatewayArtifactFromEnvironment } from "./platform-release.js";
import { gatewayDeploymentSettings, installedSharedReleaseReader } from "./shared-release-selection.js";

function sharedInput(value: unknown) {
  if (!value || typeof value !== "object" || !("gateway" in value) || !("payload" in value)) throw new Error("Expected a gateway and release payload");
  const gateway = value.gateway;
  if (!gateway || typeof gateway !== "object" || !("gatewayId" in gateway) || typeof gateway.gatewayId !== "string") {
    throw new Error("Expected a durable gateway identity");
  }
  const root = asDurableGatewayRoot(gateway, gateway.gatewayId);
  if (root?.gatewayClass !== "shared" || !isReleasePayload(value.payload)) throw new Error("Invalid Shared release input");
  if (!Number.isSafeInteger(root.latestRelease) || root.latestRelease < 1) throw new Error("Invalid Shared release number");
  return { root, payload: value.payload };
}

export async function inspectSharedReleaseInputs(
  rows: unknown, requested: ReleasePayload,
  readInstalled: (root: DurableGatewayRoot, current: ReleasePayload, requested: ReleasePayload) => Promise<boolean>,
) {
  if (!Array.isArray(rows)) throw new Error("Expected Shared gateway release inputs");
  const candidates = rows.map(sharedInput);
  const members = await Promise.all(candidates.map(async ({ root, payload }) =>
    await readInstalled(root, payload, requested) ? root.gatewayId : null));
  return { platformArtifactHash: releasePayloadHash(requested), gatewayIds: members.filter(id => id !== null) };
}

async function inspectInstalledShared() {
  const namespace = process.env.K8S_NAMESPACE;
  if (!namespace) throw new Error("K8S_NAMESPACE is required");
  const environment = deploymentSettingsForRuntime({ namespace, targetId: process.env.DEPLOYMENT_TARGET_ID });
  const chartPath = process.env.GATEWAY_CHART ?? "/charts/octogee-gateway";
  const settings = gatewayDeploymentSettings({
    namespace, environment, chartPath, chartFingerprint: computeChartFingerprint(chartPath),
    valuesFile: process.env.GATEWAY_VALUES_FILE || `${chartPath}/${environment.gatewayValuesFile}`,
  });
  const log = (message: string) => process.stderr.write(`${message}\n`);
  const readInstalled = installedSharedReleaseReader(settings, createHelmSubprocessRunner({ runHelm: spawnHelm, log }), log);
  const requested = platformGatewayArtifactFromEnvironment();
  const rows: unknown = JSON.parse(readFileSync(0, "utf8"));
  process.stdout.write(JSON.stringify(await inspectSharedReleaseInputs(rows, requested, readInstalled)));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  inspectInstalledShared().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
