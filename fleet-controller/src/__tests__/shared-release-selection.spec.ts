import { describe, expect, it } from "vitest";
import { gatewayUpsertOptsFromRelease } from "../converge-gateway.js";
import { createHelmSubprocessRunner, sharedRuntimeIntentForValues } from "../helm-runner.js";
import { installedSharedOptions, installedSharedReleaseReader } from "../shared-release-selection.js";

const tagged = (source: string, hash: string) => `${source}-oc2026.11.5@sha256:${hash.repeat(64)}`;
const before = {
  imageRepository: "registry/octogee-gateway", imageTag: tagged("1234567", "a"),
  gatewayEdgeImage: { imageRepository: "registry/gateway-edge", imageTag: tagged("1234567", "b") },
  openclawSourceSha: "c".repeat(40),
};
const after = { ...before, imageTag: tagged("7654321", "a"), gatewayEdgeImage: { ...before.gatewayEdgeImage, imageTag: tagged("7654321", "b") } };
const gateway = {
  gatewayId: "shared-aaaaaaaaaaaa", gatewayClass: "shared" as const, imageProfile: "standard" as const,
  desiredStatus: "running" as const, latestRelease: 2, liveRelease: 2, desiredRelease: 2, createdAt: 1, updatedAt: 2,
  configSchemaVersion: 1 as const, profile: null, sizingTier: null, gcpProject: null,
  gatewayContainerSecurityContext: null, serviceAccountName: null, serviceAccount: null, builderAccess: null, modelBrokerLimits: null,
  createdBy: "test", updatedBy: "test", ownerUid: null, builderSlug: null,
};
const settings = { namespace: "test", chartPath: "/chart", chartFingerprint: "d".repeat(64), valuesFile: "/values" };
const opts = gatewayUpsertOptsFromRelease({ ...settings, gateway, artifact: before, replicas: 1 });
const values = Buffer.from("computeClass: Balanced\n");
const instance = {
  enabled: true, gatewayClass: "shared" as const, gatewayId: gateway.gatewayId,
  image: { repository: before.imageRepository, tag: before.imageTag }, gatewayEdgeImage: before.gatewayEdgeImage,
  chartFingerprint: settings.chartFingerprint, deploymentIntentFingerprint: opts.deploymentIntentFingerprint,
  sharedRuntimeIntent: { helmRevision: 4, fingerprint: sharedRuntimeIntentForValues(opts, values)! },
};
describe("selecting the installed Shared release", () => {
  const input = { gateway, current: before, requested: after, instance, settings, values };
  it("keeps the accepted runtime across a build retag", () => {
    expect(installedSharedOptions(input)).toMatchObject({ imageTag: before.imageTag });
  });
  it("requires the receipt and the rendered manifest to agree in the live reader", async () => {
    const noFile = { ...settings, valuesFile: undefined };
    const immutable = gatewayUpsertOptsFromRelease({ ...noFile, gateway, artifact: before, replicas: 1 });
    const receipt = sharedRuntimeIntentForValues(immutable, null);
    const helm = createHelmSubprocessRunner({ log: () => {}, runHelm: async args => {
      let stdout: string;
      if (args[0] === "status") stdout = JSON.stringify({ info: { status: "deployed" }, version: 4 });
      else if (args[1] === "values") stdout = JSON.stringify({
        gatewayId: gateway.gatewayId, gatewayClass: "shared", imageTag: before.imageTag, image: { repository: before.imageRepository },
        gatewayEdge: { image: { repository: before.gatewayEdgeImage.imageRepository, tag: before.gatewayEdgeImage.imageTag } },
        chartFingerprint: settings.chartFingerprint, deploymentIntentFingerprint: immutable.deploymentIntentFingerprint, sharedRuntimeIntent: receipt,
      });
      else stdout = args[0] === "template" ? "expected resources" : "drifted resources";
      return { stdout, stderr: "", code: 0 };
    } });
    expect(await installedSharedReleaseReader(noFile, helm, () => {})(gateway, before, after)).toBe(false);
  });

  it.each([["same", true], ["different deployment", false]])("compares the actual installed manifest at the observed revision: %s", async (installed, expected) => {
    const commands: string[][] = [];
    const helm = createHelmSubprocessRunner({ log: () => {}, runHelm: async args => {
      commands.push(args);
      return { stdout: args[0] === "template" ? "same" : installed, stderr: "", code: 0 };
    } });

    expect(await helm.matchesDeployedManifest!({ ...opts, sharedRuntimeIntent: instance.sharedRuntimeIntent.fingerprint }, 4)).toBe(expected);
    expect(commands).toContainEqual(["get", "manifest", "octogee-gw-shared-aaaaaaaaaaaa", "-n", "test", "--revision", "4"]);
    expect(commands.find(args => args[0] === "template")).toEqual(expect.arrayContaining(["-f", "/values", `sharedRuntimeIntent=${instance.sharedRuntimeIntent.fingerprint}`]));
  });

  it.each([
    { values: Buffer.from("computeClass: Scale-Out\n") },
    { settings: { ...settings, chartFingerprint: "e".repeat(64) } },
    { settings: { ...settings, deploymentProjectId: "different" } },
    { instance: { ...instance, sharedRuntimeIntent: undefined } },
    { instance: { ...instance, gatewayEdgeImage: { ...before.gatewayEdgeImage, imageTag: tagged("1234567", "e") } } },
    { gateway: { ...gateway, liveRelease: 1 } },
    { requested: { ...after, openclawSourceSha: "e".repeat(40) } },
    { requested: { ...after, imageTag: tagged("7654321", "e") } },
    { requested: { ...after, imageTag: "7654321-main.1@sha256:" + "a".repeat(64) } },
  ])("takes the rollout path for changed or incomplete evidence %#", change => {
    expect(installedSharedOptions({ ...input, ...change })).toBeNull();
  });
});
