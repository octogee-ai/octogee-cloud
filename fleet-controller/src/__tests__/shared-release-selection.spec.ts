import { describe, expect, it, vi } from "vitest";
import { gatewayUpsertOptsFromRelease } from "../converge-gateway.js";
import { createHelmSubprocessRunner, sharedRuntimeIntentForValues } from "../helm-runner.js";
import { installedSharedOptions, installedSharedReleaseReader, SHARED_RELEASE_OBSERVATION_GRACE_MS } from "../shared-release-selection.js";

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
  it("bounds simultaneous inspections and reuses a match only for the same live revision", async () => {
    const noFile = { ...settings, valuesFile: undefined };
    let version = 4;
    let active = 0;
    let maximum = 0;
    const helm = createHelmSubprocessRunner({ log: () => {}, runHelm: async () => ({ stdout: "", stderr: "", code: 0 }) });
    helm.readSharedInstallation = async ({ gatewayId }) => {
      const immutable = gatewayUpsertOptsFromRelease({ ...noFile, gateway: { ...gateway, gatewayId }, artifact: before, replicas: 1 });
      maximum = Math.max(maximum, ++active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
      return { instance: { ...instance, gatewayId, deploymentIntentFingerprint: immutable.deploymentIntentFingerprint,
        sharedRuntimeIntent: { helmRevision: version, fingerprint: sharedRuntimeIntentForValues(immutable, null)! } }, manifestDigest: "digest" };
    };
    const matches = vi.fn(async () => true);
    helm.matchesDeployedManifest = matches;
    const read = installedSharedReleaseReader(noFile, helm, () => {});
    const roots = Array.from({ length: 9 }, (_, n) => ({ ...gateway, gatewayId: `shared-${String(n).padStart(12, "0")}` }));

    expect(await Promise.all(roots.map(root => read(root, before, after)))).toEqual(roots.map(() => true));
    expect(maximum).toBeLessThanOrEqual(4);
    expect(maximum).toBeGreaterThan(0);
    expect(matches).toHaveBeenCalledTimes(9);
    expect(await read(roots[0], before, after)).toBe(true);
    expect(matches).toHaveBeenCalledTimes(9);
    version++;
    expect(await read(roots[0], before, after)).toBe(true);
    expect(matches).toHaveBeenCalledTimes(10);
  });

  it.each([["expected resources", true], ["drifted resources", false]])("requires the receipt and manifest to agree in the live reader: %s", async (manifest, expected) => {
    const noFile = { ...settings, valuesFile: undefined };
    const immutable = gatewayUpsertOptsFromRelease({ ...noFile, gateway, artifact: before, replicas: 1 });
    const receipt = sharedRuntimeIntentForValues(immutable, null);
    const helm = createHelmSubprocessRunner({ log: () => {}, runHelm: async args => {
      const config = {
        gatewayId: gateway.gatewayId, gatewayClass: "shared", imageTag: before.imageTag, image: { repository: before.imageRepository },
        gatewayEdge: { image: { repository: before.gatewayEdgeImage.imageRepository, tag: before.gatewayEdgeImage.imageTag } },
        chartFingerprint: settings.chartFingerprint, deploymentIntentFingerprint: immutable.deploymentIntentFingerprint, sharedRuntimeIntent: receipt,
      };
      const stdout = args[0] === "status" ? JSON.stringify({ info: { status: "deployed" }, version: 4, manifest, config }) : "expected resources";
      return { stdout, stderr: "", code: 0 };
    } });
    expect(await installedSharedReleaseReader(noFile, helm, () => {})(gateway, before, after)).toBe(expected);
  });

  it.each([["same", 4, true], ["different deployment", 4, false], ["same", 5, false]])("compares the current manifest and revision: %s r%s", async (installed, version, expected) => {
    const commands: string[][] = [];
    const helm = createHelmSubprocessRunner({ log: () => {}, runHelm: async args => {
      commands.push(args);
      return { stdout: args[0] === "template" ? "same" : JSON.stringify({ info: { status: "deployed" }, version, manifest: installed }), stderr: "", code: 0 };
    } });

    expect(await helm.matchesDeployedManifest!({ ...opts, sharedRuntimeIntent: instance.sharedRuntimeIntent.fingerprint }, 4)).toBe(expected);
    expect(commands).toContainEqual(["status", "octogee-gw-shared-aaaaaaaaaaaa", "-n", "test", "-o", "json"]);
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
    { requested: { ...after, gatewayEdgeImage: { ...after.gatewayEdgeImage, imageTag: tagged("7654321", "e") } } },
    { requested: { ...after, imageTag: "7654321-main.1@sha256:" + "a".repeat(64) } },
  ])("takes the rollout path for changed or incomplete evidence %#", change => {
    expect(installedSharedOptions({ ...input, ...change })).toBeNull();
  });
});

describe("an installed Shared release observation that fails", () => {
  const noFile = { ...settings, valuesFile: undefined };
  const immutable = gatewayUpsertOptsFromRelease({ ...noFile, gateway, artifact: before, replicas: 1 });
  const observed = { instance: { ...instance, deploymentIntentFingerprint: immutable.deploymentIntentFingerprint,
    sharedRuntimeIntent: { helmRevision: 4, fingerprint: sharedRuntimeIntentForValues(immutable, null)! } }, manifestDigest: "digest" };

  function reader(clock: { now: number }) {
    const outcome: { observation: "installed" | "unreadable"; manifestMatches: boolean } = { observation: "installed", manifestMatches: true };
    const lines: string[] = [];
    const helm = createHelmSubprocessRunner({ log: () => {}, runHelm: async () => ({ stdout: "", stderr: "", code: 0 }) });
    helm.readSharedInstallation = async () => {
      if (outcome.observation === "unreadable") throw new Error("helm status octogee-gw-shared-aaaaaaaaaaaa (ns=test) failed (code=128): helm terminated by signal SIGTERM");
      return observed;
    };
    helm.matchesDeployedManifest = async () => outcome.manifestMatches;
    const read = installedSharedReleaseReader(noFile, helm, line => lines.push(line), () => clock.now);
    return { read, outcome, lines };
  }

  it("keeps a verified release current and names the failure", async () => {
    const clock = { now: 1_000 };
    const { read, outcome, lines } = reader(clock);
    expect(await read(gateway, before, after)).toBe(true);
    outcome.observation = "unreadable";
    clock.now += 60_000;

    expect(await read(gateway, before, after)).toBe(true);
    expect(lines.join("\n")).toContain("failed (code=128): helm terminated by signal SIGTERM");
  });

  it("is not current before any verification", async () => {
    const { read, outcome, lines } = reader({ now: 1_000 });
    outcome.observation = "unreadable";

    expect(await read(gateway, before, after)).toBe(false);
    expect(lines.join("\n")).toContain("failed (code=128)");
  });

  it.each([
    ["a new release", { gateway: { ...gateway, latestRelease: 3, desiredRelease: 3 }, requested: after }],
    ["a different requested build", { gateway, requested: { ...after, imageTag: tagged("1111111", "a") } }],
  ])("is not current after %s", async (_change, next) => {
    const { read, outcome } = reader({ now: 1_000 });
    expect(await read(gateway, before, after)).toBe(true);
    outcome.observation = "unreadable";

    expect(await read(next.gateway, before, next.requested)).toBe(false);
  });

  it("is not current once the verification is older than the grace window", async () => {
    const clock = { now: 1_000 };
    const { read, outcome } = reader(clock);
    expect(await read(gateway, before, after)).toBe(true);
    outcome.observation = "unreadable";
    clock.now += SHARED_RELEASE_OBSERVATION_GRACE_MS + 1;

    expect(await read(gateway, before, after)).toBe(false);
  });

  it("is not current after a mismatch replaced the verification", async () => {
    const { read, outcome } = reader({ now: 1_000 });
    expect(await read(gateway, before, after)).toBe(true);
    outcome.manifestMatches = false;
    observed.instance.sharedRuntimeIntent.helmRevision = 5;
    try {
      expect(await read(gateway, before, after)).toBe(false);
      outcome.observation = "unreadable";

      expect(await read(gateway, before, after)).toBe(false);
    } finally {
      observed.instance.sharedRuntimeIntent.helmRevision = 4;
    }
  });
});
