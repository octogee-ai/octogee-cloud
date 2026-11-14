import {
  resolveGatewayImageProfile,
  type GatewayDesiredState,
  type GatewayProfile,
} from "@octogee/shared/types/glm";

export const PROFILE_IMAGE_NAME: Record<Exclude<GatewayProfile, "standard">, string> = {
  isolated: "octogee-gateway-builder",
};

export function resolveGatewayImageRepository(
  d: Pick<GatewayDesiredState, "gatewayClass" | "imageProfile" | "profile" | "imageRepository">,
): string {
  const imageProfile = resolveGatewayImageProfile(d);
  if (imageProfile === "standard") return d.imageRepository;
  const base = d.imageRepository.replace(/\/[^/]+$/, "");
  return `${base}/${PROFILE_IMAGE_NAME[imageProfile]}`;
}
