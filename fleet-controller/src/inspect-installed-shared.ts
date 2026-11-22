import { readFileSync } from "node:fs";
import { deploymentSettingsForRuntime } from "@octogee/core/deployment-environment";
import { isReleasePayload, releasePayloadHash } from "@octogee/shared/types/gateway-releases";
import { asDurableGatewayRoot } from "@octogee/core/gateway-release-append";
import { computeChartFingerprint } from "./chart-fingerprint.js";
import { createHelmSubprocessRunner, spawnHelm } from "./helm-runner.js";
import { platformGatewayArtifactFromEnvironment } from "./platform-release.js";
import { gatewayDeploymentSettings, installedSharedReleaseReader } from "./shared-release-selection.js";

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
  if (!Array.isArray(rows)) throw new Error("Expected Shared gateway release inputs");
  const members = await Promise.all(rows.map(async (row) => {
    const root = asDurableGatewayRoot(row.gateway, row.gateway?.gatewayId);
    if (!root || root.gatewayClass !== "shared" || !isReleasePayload(row.payload)) throw new Error("Invalid Shared release input");
    return await readInstalled(root, row.payload, requested) ? root.gatewayId : null;
  }));
  process.stdout.write(JSON.stringify({ platformArtifactHash: releasePayloadHash(requested), gatewayIds: members.filter(id => id !== null) }));
}

inspectInstalledShared().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
