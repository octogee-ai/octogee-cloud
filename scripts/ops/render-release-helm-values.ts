import { centralGatewayReleasePayload, createCentralReleaseAuthority, type CentralReleaseAuthority } from "@octogee/core/artifact-registry";
import { deploymentEnvironmentSettings } from "@octogee/core/deployment-environment";
import { dualReadIsolatedProfileImage } from "@octogee/shared/types/gateway-releases";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function renderReleaseHelmValues(sourceSha: string, authority?: Pick<CentralReleaseAuthority, "resolveManifest">): Promise<string> {
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error("selected release requires a full 40-character source SHA");
  const settings = deploymentEnvironmentSettings("test");
  const resolver = authority ?? createCentralReleaseAuthority({
    project: settings.artifactRegistryProjectId,
    location: settings.artifactRegistryLocation,
    repository: settings.artifactRegistryName,
  });
  const manifest = await resolver.resolveManifest(sourceSha);
  if (manifest.sourceSha !== sourceSha) throw new Error("resolved release differs from the selected source SHA");
  if (!/^[a-f0-9]{40}$/.test(manifest.openclawSourceSha ?? "")) throw new Error("selected release is missing its OpenClaw source SHA");
  const tag = sourceSha.slice(0, 7);
  const gatewayPayload = centralGatewayReleasePayload(manifest);
  const image = (surface: "platform" | "gateway", name: string) => {
    const digest = manifest.surfaces[surface][name];
    if (!/^sha256:[a-f0-9]{64}$/.test(digest ?? "")) throw new Error(`selected release is missing ${name}`);
    return { repository: `${manifest.repository}/${name}`, tag, digest };
  };
  const edge = image("gateway", "gateway-edge");
  const platformImages = Object.fromEntries(Object.keys(manifest.surfaces.platform).sort().map((name) => [name, image("platform", name)]));
  return JSON.stringify({
    releaseImages: platformImages,
    global: { projectRunnerImage: image("platform", "octogee-project-runner") },
    "octogee-api": { image: image("platform", "octogee-api") },
    llmBroker: { image: image("platform", "octogee-api") },
    artifactWorker: { image: image("platform", "artifact-worker") },
    opsAgent: { image: image("platform", "octogee-ops-agent") },
    "gateway-edge": { image: edge },
    ...("provisioning-service" in manifest.surfaces.platform ? { provisioningService: { image: image("platform", "provisioning-service") } } : {}),
    "glm-controller": {
      image: image("platform", "glm-controller"),
      platformRelease: {
        sourceSha,
        gatewayImageRepository: gatewayPayload.imageRepository,
        gatewayImageTag: gatewayPayload.imageTag,
        builderImageTag: dualReadIsolatedProfileImage(gatewayPayload.profileImages!).imageTag,
        gatewayEdgeImageRepository: gatewayPayload.gatewayEdgeImage!.imageRepository,
        gatewayEdgeImageTag: gatewayPayload.gatewayEdgeImage!.imageTag,
        openclawSourceSha: manifest.openclawSourceSha,
      },
    },
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    if (process.argv.length !== 3) throw new Error("usage: render-release-helm-values.ts <full-source-sha>");
    process.stdout.write(await renderReleaseHelmValues(process.argv[2]));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
