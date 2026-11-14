import { describe, expect, it } from "vitest";

import type { ReleaseDoc, ReleasePayload } from "@octogee/shared/types/gateway-releases";
import { projectReleaseHistory } from "./gateway-release-history.js";

function payload(imageTag: string): ReleasePayload {
  return {
    imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/gateway",
    imageTag,
  };
}

function release(n: number, opts: { sourceRelease: number | null; imageTag?: string; note?: string | null }): ReleaseDoc {
  return {
    gatewayId: "default",
    release: n,
    createdAt: 1_700_000_000_000 + n,
    createdBy: `op-${n}`,
    sourceRelease: opts.sourceRelease,
    note: opts.note ?? null,
    payloadHash: `hash-${opts.imageTag ?? n}`,
    payload: payload(opts.imageTag ?? `tag-${n}`),
  };
}

describe("projectReleaseHistory", () => {
  it("marks the live and desired releases, newest first, with core fields", () => {
    const history = projectReleaseHistory({
      gateway: { liveRelease: 2, desiredRelease: 3 },
      releases: [
        release(1, { sourceRelease: null }),
        release(2, { sourceRelease: 1 }),
        release(3, { sourceRelease: 2 }),
      ],
    });
    expect(history.map((h) => h.release)).toEqual([3, 2, 1]);
    const byRelease = new Map(history.map((h) => [h.release, h]));
    expect(byRelease.get(3)).toMatchObject({ desired: true, live: false });
    expect(byRelease.get(2)).toMatchObject({ desired: false, live: true });
    expect(byRelease.get(1)).toMatchObject({ desired: false, live: false });
    expect(byRelease.get(2)!.imageTag).toBe("tag-2");
    expect(byRelease.get(2)!.createdBy).toBe("op-2");
    expect(byRelease.get(2)!.payloadHash).toBe("hash-2");
    expect(typeof byRelease.get(2)!.createdAt).toBe("string"); // ISO
  });

  it("flags a rollback release with the release it restored", () => {
    // 1,2,3 are normal cuts (source = n-1). Release 4 is a rollback to release 2
    // (source = 2, not 3), so it is a rollback release.
    const history = projectReleaseHistory({
      gateway: { liveRelease: 4, desiredRelease: 4 },
      releases: [
        release(1, { sourceRelease: null }),
        release(2, { sourceRelease: 1 }),
        release(3, { sourceRelease: 2 }),
        release(4, { sourceRelease: 2, note: "rollback to release 2" }),
      ],
    });
    const byRelease = new Map(history.map((h) => [h.release, h]));
    expect(byRelease.get(4)!.rolledBackFrom).toBe(2);
    // Normal cuts are never flagged.
    expect(byRelease.get(3)!.rolledBackFrom).toBeNull();
    expect(byRelease.get(2)!.rolledBackFrom).toBeNull();
    expect(byRelease.get(1)!.rolledBackFrom).toBeNull();
  });

  it("does not flag release 1 (no source) as a rollback", () => {
    const history = projectReleaseHistory({
      gateway: { liveRelease: 1, desiredRelease: 1 },
      releases: [release(1, { sourceRelease: null })],
    });
    expect(history[0].rolledBackFrom).toBeNull();
  });

  describe("for a build that carries a shared image and an isolated image", () => {
    const REPOSITORY = "registry.example/platform";
    const build: ReleaseDoc = {
      ...release(1, { sourceRelease: null }),
      payload: {
        imageRepository: `${REPOSITORY}/octogee-gateway`,
        imageTag: `ec9d092-oc2026.11.3@sha256:${"6".repeat(64)}`,
        profileImages: {
          builder: {
            imageRepository: `${REPOSITORY}/octogee-gateway-builder`,
            imageTag: `ec9d092-oc2026.11.3@sha256:${"4".repeat(64)}`,
          },
        },
      },
    };

    it("shows an isolated gateway the image it runs from that build", () => {
      const [entry] = projectReleaseHistory({
        gateway: { liveRelease: 1, desiredRelease: 1, gatewayClass: "isolated", imageProfile: "isolated" },
        releases: [build],
      });

      expect(entry).toMatchObject({
        imageRepository: `${REPOSITORY}/octogee-gateway-builder`,
        imageTag: `ec9d092-oc2026.11.3@sha256:${"4".repeat(64)}`,
      });
    });

    it("shows a shared gateway the shared image", () => {
      const [entry] = projectReleaseHistory({
        gateway: { liveRelease: 1, desiredRelease: 1, gatewayClass: "shared", imageProfile: "standard" },
        releases: [build],
      });

      expect(entry).toMatchObject({
        imageRepository: `${REPOSITORY}/octogee-gateway`,
        imageTag: `ec9d092-oc2026.11.3@sha256:${"6".repeat(64)}`,
      });
    });
  });
});
