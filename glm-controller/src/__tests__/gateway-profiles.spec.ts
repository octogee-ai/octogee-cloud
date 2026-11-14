import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveGatewayImageRepository, PROFILE_IMAGE_NAME } from "../gateway-profiles";
import { buildInstancesMap, buildHelmTargetMap, diffInstancesMap } from "../reconcile-plan";
import type { GatewayDesiredState } from "@octogee/shared/types/glm";

const STD_REPO = "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway";
const USER_REPO = "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway-builder";
const ORIGINAL_GATEWAY_SERVICE_ACCOUNT = process.env.GATEWAY_SERVICE_ACCOUNT;

beforeEach(() => {
  process.env.GATEWAY_SERVICE_ACCOUNT = "octogee-gateway@octogee-test.iam.gserviceaccount.com";
});

afterEach(() => {
  if (ORIGINAL_GATEWAY_SERVICE_ACCOUNT === undefined) {
    delete process.env.GATEWAY_SERVICE_ACCOUNT;
  } else {
    process.env.GATEWAY_SERVICE_ACCOUNT = ORIGINAL_GATEWAY_SERVICE_ACCOUNT;
  }
});

function mkDesired(o: Partial<GatewayDesiredState>): GatewayDesiredState {
  return {
    gatewayId: "x",
    imageRepository: STD_REPO,
    imageTag: "abc1234",
    desiredStatus: "running",
    createdBy: "ci:abc1234",
    ...o,
  };
}

describe("resolveGatewayImageRepository", () => {
  it("profile unset ⇒ the literal imageRepository (zero regression for the cattle fleet)", () => {
    expect(resolveGatewayImageRepository(mkDesired({}))).toBe(STD_REPO);
  });

  it("profile 'standard' ⇒ the literal imageRepository", () => {
    expect(resolveGatewayImageRepository(mkDesired({ profile: "standard" }))).toBe(STD_REPO);
  });

  it("isolated profile selects the isolated image in the same registry and project", () => {
    expect(resolveGatewayImageRepository(mkDesired({ imageProfile: "isolated" }))).toBe(USER_REPO);
    expect(PROFILE_IMAGE_NAME.isolated).toBe("octogee-gateway-builder");
  });

  it("derivation follows the instance's own registry — no hardcoded AR host/project", () => {

expect(
      resolveGatewayImageRepository(
        mkDesired({ imageProfile: "isolated", imageRepository: "europe-docker.pkg.dev/acme/reg/octogee-gateway" }),
      ),
    ).toBe("europe-docker.pkg.dev/acme/reg/octogee-gateway-builder");
  });
});

describe("The fleet controller resolves profile in the helm maps (image name, NOT the tag)", () => {
  it("buildInstancesMap: user profile selects the user repository with the fleet SHA", () => {
    const map = buildInstancesMap([
      mkDesired({ gatewayId: "walter", imageProfile: "isolated" }),
    ]);
    expect(map.walter.image.repository).toBe(USER_REPO);
    expect(map.walter.image.tag).toBe("abc1234");
  });

  it("buildInstancesMap: no profile → repo is byte-unchanged (regression guard)", () => {
    const map = buildInstancesMap([mkDesired({ gatewayId: "default" })]);
    expect(map.default.image.repository).toBe(STD_REPO);
  });

  it("buildHelmTargetMap: User profile resolves the same way", () => {
    const map = buildHelmTargetMap([
      mkDesired({ gatewayId: "walter", imageProfile: "isolated" }),
    ], {});
    expect(map.walter.image.repository).toBe(USER_REPO);
  });

  it("changing profile is a reconcile `update` (the fleet controller rolls the instance onto the profile image)", () => {
    const actual = buildInstancesMap([mkDesired({ gatewayId: "walter" })]);
    const desired = buildInstancesMap([
      mkDesired({ gatewayId: "walter", imageProfile: "isolated" }),
    ]);
    const changes = diffInstancesMap(actual, desired);
    expect(changes).toEqual([
      { kind: "update", gatewayId: "walter", from: actual.walter, to: desired.walter },
    ]);
  });
});
