import { GATEWAY_VM_IMAGE_SERVICES, isGatewayVmImageSample, type GatewayVmImageSample } from "@octogee/shared/types/glm";
import { inspectContainer, inspectImageDigests, type DockerEngine } from "./docker-engine.js";

export async function observeVmImages(engine: DockerEngine): Promise<GatewayVmImageSample> {
  const signal = AbortSignal.timeout(5_000);
  const containers = await Promise.all(GATEWAY_VM_IMAGE_SERVICES.map(async (name) => {
    const container = await inspectContainer(engine, `octogee-${name}`, signal);
    if (!container) return { name, imageReference: "", digests: [], running: false };
    if (!container.Image || !/^sha256:[a-f0-9]{64}$/.test(container.Image) || !container.Config?.Image) {
      throw new Error(`image inspection incomplete for ${name}`);
    }
    return {
      name,
      imageReference: container.Config.Image,
      digests: [...new Set(await inspectImageDigests(engine, container.Image, signal))].sort(),
      running: container.State?.Running === true && container.State.Paused !== true,
    };
  }));
  const sample = { containers };
  if (!isGatewayVmImageSample(sample)) throw new Error("invalid Docker image observation");
  return sample;
}
