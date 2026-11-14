import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildGatewayImages, gatewayBakePlan } from "../ci/gateway-bake.mjs";

const repository = "us-central1-docker.pkg.dev/octogee/octogee";
const sha = "a".repeat(40);
const base = `inputs-${"b".repeat(64)}`;
const isolatedBase = `${base}-builder-123456789abc`;
const toolchain = { lockSha256: "c".repeat(64), groupsSha256: "d".repeat(64) };
const images = ["gateway-edge", "octogee-gateway", "octogee-gateway-builder"];
const platformOnly = mkdtempSync(join(tmpdir(), "gateway-bake-"));
const plan = (build: { base: boolean; isolatedBase: boolean; images: string[] }, root = platformOnly) =>
  gatewayBakePlan({ repository, sha, base, isolatedBase, toolchain, build }, root);
const baseRef = `${repository}/octogee-gateway-base:${base}`;
const isolatedBaseRef = `${repository}/octogee-gateway-builder-base:${isolatedBase}`;

describe("gateway bake plan", () => {
  it("builds unpublished bases in the same run and links every dependent to them in-process", () => {
    const { group, target } = plan({ base: true, isolatedBase: true, images });
    expect(group.default.targets.sort()).toEqual([...images, "octogee-gateway-base", "octogee-gateway-builder-base"].sort());
    expect(target["octogee-gateway-base"]).toMatchObject({
      dockerfile: "infra/gateway/Dockerfile.base", target: "gateway-runtime", tags: [baseRef],
    });
    expect(target["octogee-gateway-builder-base"]).toMatchObject({
      dockerfile: "infra/gateway/Dockerfile.isolated-base", tags: [isolatedBaseRef],
      contexts: {
        "octogee-gateway-base": "target:octogee-gateway-base",
        "octogee-gateway-system": "target:octogee-gateway-system",
      },
      args: { BUILDER_TOOLCHAIN_LOCK_SHA256: toolchain.lockSha256, BUILDER_TOOL_GROUPS_SHA256: toolchain.groupsSha256 },
    });
    expect(target["octogee-gateway-system"]).toMatchObject({
      dockerfile: "infra/gateway/Dockerfile.base", target: "gateway-system", output: ["type=cacheonly"],
    });
    expect(target["octogee-gateway-system"]).not.toHaveProperty("tags");
    expect(target["octogee-gateway"].contexts).toEqual({
      "octogee-gateway-base": "target:octogee-gateway-base",
      "octogee-gateway-system": "target:octogee-gateway-system",
    });
    expect(target["octogee-gateway-builder"].contexts).toEqual({
      "octogee-gateway-base": "target:octogee-gateway-base",
      "octogee-gateway-builder-base": "target:octogee-gateway-builder-base",
      "octogee-gateway-system": "target:octogee-gateway-system",
    });
  });

  it("pulls published bases by their immutable tags and leaves them out of the run", () => {
    const { group, target } = plan({ base: false, isolatedBase: false, images: ["octogee-gateway-builder"] });
    expect(group.default.targets).toEqual(["octogee-gateway-builder"]);
    expect(target["octogee-gateway-builder"].contexts).toEqual({
      "octogee-gateway-base": `docker-image://${baseRef}`,
      "octogee-gateway-builder-base": `docker-image://${isolatedBaseRef}`,
      "octogee-gateway-system": "target:octogee-gateway-system",
    });
  });

  it("builds the gateway base from its packaged native dependencies", () => {
    const { group, target } = plan({ base: true, isolatedBase: false, images: [] });
    expect(group.default.targets).toEqual(["octogee-gateway-base"]);
    expect(target["octogee-gateway-base"]).not.toHaveProperty("contexts");
  });

  it("builds a new isolated base over a published gateway base", () => {
    const { group, target } = plan({ base: false, isolatedBase: true, images: [] });
    expect(group.default.targets).toEqual(["octogee-gateway-builder-base"]);
    expect(target["octogee-gateway-builder-base"].contexts).toEqual({
      "octogee-gateway-base": `docker-image://${baseRef}`,
      "octogee-gateway-system": "target:octogee-gateway-system",
    });
  });

  it("builds both gateway variants on the plain base and runs only the isolated image on the isolated base", () => {
    const { target } = plan({ base: false, isolatedBase: false, images });
    expect(target["octogee-gateway"].args).toEqual({
      BUILD_SHA: "aaaaaaa", OPENCLAW_RUNTIME_PLUGINS: "mattermost,parallel-plugin,codex", GATEWAY_SYSTEM_IMAGE: "octogee-gateway-system",
    });
    expect(target["octogee-gateway-builder"].args).toEqual({
      BUILD_SHA: "aaaaaaa", OPENCLAW_RUNTIME_PLUGINS: "mattermost,parallel-plugin,codex",
      GATEWAY_SYSTEM_IMAGE: "octogee-gateway-system", RUNTIME_BASE_IMAGE: "octogee-gateway-builder-base", IMAGE_PROFILE: "isolated",
    });
  });

  it("tags each image with the short SHA and stamps the full source revision", () => {
    const { target } = plan({ base: false, isolatedBase: false, images });
    for (const image of images) {
      expect(target[image].tags).toEqual([`${repository}/${image}:aaaaaaa`]);
      expect(target[image].labels).toEqual({ "org.opencontainers.image.revision": sha });
    }
  });

  it("imports and exports an independent registry cache for every built target", () => {
    const { target } = plan({ base: true, isolatedBase: true, images });
    for (const name of ["octogee-gateway-base", "octogee-gateway-builder-base", "octogee-gateway-system", ...images]) {
      expect(target[name]["cache-from"]).toEqual([`type=registry,ref=${repository}/cache/${name}:buildcache`]);
      expect(target[name]["cache-to"]).toEqual([`type=registry,ref=${repository}/cache/${name}:buildcache,mode=max`]);
    }
  });

  it("pushes every target for linux/amd64 without attestations", () => {
    const { target } = plan({ base: true, isolatedBase: true, images });
    for (const name of [...images, "octogee-gateway-base", "octogee-gateway-builder-base"]) {
      expect(target[name]).toMatchObject({
        context: "platform", platforms: ["linux/amd64"], output: ["type=registry"],
        attest: ["type=provenance,disabled=true", "type=sbom,disabled=true"],
      });
    }
  });

  it("passes the product overlay of gateway-edge and the product tree to the gateway images when they exist", () => {
    const root = mkdtempSync(join(tmpdir(), "gateway-bake-product-"));
    mkdirSync(join(root, "product/gateway-edge"), { recursive: true });
    const { target } = plan({ base: false, isolatedBase: false, images }, root);
    expect(target["gateway-edge"].contexts).toEqual({ product: "product", overlay: "product/gateway-edge" });
    expect(target["octogee-gateway"].contexts).toMatchObject({ product: "product" });
    expect(target["octogee-gateway-builder"].contexts).toMatchObject({ product: "product" });
    expect(plan({ base: false, isolatedBase: false, images }).target["gateway-edge"]).not.toHaveProperty("contexts");
  });

  it("passes the product libraries to gateway-edge while the product tree exists", () => {
    const root = mkdtempSync(join(tmpdir(), "gateway-bake-libraries-"));
    mkdirSync(join(root, "product/core"), { recursive: true });
    const { target } = plan({ base: true, isolatedBase: false, images }, root);
    expect(target["gateway-edge"].contexts).toEqual({ product: "product" });
    expect(target["octogee-gateway-base"]).not.toHaveProperty("contexts");
  });

  it("is empty when everything is already published", () => {
    expect(plan({ base: false, isolatedBase: false, images: [] })).toEqual({ group: { default: { targets: [] } }, target: {} });
  });

  it.each([
    ["a mutable gateway base", { base: "latest" }, "gateway base"],
    ["an isolated base over another gateway base", { isolatedBase: `inputs-${"e".repeat(64)}-builder-123456789abc` }, "isolated base"],
    ["a short SHA", { sha: "aaaaaaa" }, "full source SHA"],
  ])("rejects %s", (_, override, message) => {
    expect(() => gatewayBakePlan({ repository, sha, base, isolatedBase, toolchain, build: { base: true, isolatedBase: true, images }, ...override })).toThrow(message);
  });

  it("rejects an image outside the gateway family", () => {
    expect(() => plan({ base: false, isolatedBase: false, images: ["octogee-api"] })).toThrow("octogee-api");
  });
});

describe("gateway image family build", () => {
  const short = sha.slice(0, 7);
  const harness = ({ existing = [] as string[], reusable = [] as string[], bakeError = undefined as Error | undefined } = {}) => {
    const calls: string[][] = [];
    const bakes: ReturnType<typeof gatewayBakePlan>[] = [];
    let clock = 0;
    return {
      calls,
      bakes,
      run: () => buildGatewayImages({ repository, sha, base, isolatedBase, toolchain, root: platformOnly }, {
        exists: async (ref: string) => existing.includes(ref),
        script: async (file: string, args: string[]) => {
          calls.push([file, ...args]);
          return args[0] === "check" ? `fingerprint=f-${args[1]}\nexists=${reusable.includes(args[1])}\n` : "";
        },
        prepareBase: async () => { calls.push(["prepare-base"]); },
        bake: async (plan: ReturnType<typeof gatewayBakePlan>) => {
          calls.push(["bake"]);
          bakes.push(plan);
          if (bakeError) throw bakeError;
        },
        now: () => (clock += 60_000),
      }),
    };
  };
  const scriptCalls = (calls: string[][], script: string) => calls.filter(call => call[0] === `platform/scripts/lib/${script}`);
  const sizeCheck = ["platform/scripts/lib/assert-artifact-image-size.sh", `${repository}/octogee-gateway-builder:${short}`, "3100000000", "octogee"];

  it("builds the whole unpublished chain in one bake, then checks size, records fingerprints and publishes full-SHA tags", async () => {
    const { calls, bakes, run } = harness();
    const rows = await run();
    expect(bakes).toHaveLength(1);
    expect(bakes[0].group.default.targets).toHaveLength(5);
    expect(calls.indexOf(calls.find(call => call[0] === "prepare-base")!)).toBeLessThan(calls.findIndex(call => call[0] === "bake"));
    const afterBake = calls.slice(calls.findIndex(call => call[0] === "bake") + 1);
    expect(afterBake[0]).toEqual(sizeCheck);
    expect(scriptCalls(afterBake, "image-fingerprint-reuse.sh").map(call => call.slice(1))).toEqual(images.map(image => ["record", image, repository, short, `f-${image}`]));
    expect(scriptCalls(afterBake, "publish-full-sha-image-tag.sh").map(call => call[1])).toEqual(images);
    expect(rows).toEqual([
      { image: "octogee-gateway-base", tag: base, result: "built", seconds: 60 },
      { image: "octogee-gateway-builder-base", tag: isolatedBase, result: "built", seconds: 60 },
      ...images.map(image => ({ image, tag: short, result: "built", seconds: 60 })),
    ]);
  });

  it("skips the bake, the tarballs and the size check when everything already has its full-SHA tag", async () => {
    const { calls, bakes, run } = harness({ existing: [baseRef, isolatedBaseRef, ...images.map(image => `${repository}/${image}:${sha}`)] });
    const rows = await run();
    expect(bakes).toEqual([]);
    expect(calls).toEqual([]);
    expect(rows.map(row => row.result)).toEqual(["found", "found", ...images.map(() => "reused (full-SHA tag)")]);
  });

  it("prepares the gateway inputs before rebuilding only the isolated base", async () => {
    const { calls, bakes, run } = harness({ existing: [baseRef, ...images.map(image => `${repository}/${image}:${sha}`)] });
    await run();
    expect(bakes[0].group.default.targets).toEqual(["octogee-gateway-builder-base"]);
    expect(calls.slice(0, 2)).toEqual([["prepare-base"], ["bake"]]);
  });

  it("publishes reused images without baking them", async () => {
    const { calls, bakes, run } = harness({ existing: [baseRef, isolatedBaseRef, `${repository}/gateway-edge:${sha}`], reusable: ["octogee-gateway", "octogee-gateway-builder"] });
    const rows = await run();
    expect(bakes).toEqual([]);
    expect(calls.some(call => call[0] === "prepare-base" || call[1] === "record")).toBe(false);
    expect(scriptCalls(calls, "publish-full-sha-image-tag.sh").map(call => call[1])).toEqual(["octogee-gateway", "octogee-gateway-builder"]);
    expect(rows.map(row => row.result)).toEqual(["found", "found", "reused (full-SHA tag)", "reused (fingerprint)", "reused (fingerprint)"]);
  });

  it.each([
    ["fingerprint", { reusable: ["octogee-gateway-builder"] }],
    ["short tag", { existing: [`${repository}/octogee-gateway-builder:${short}`] }],
  ])("size-checks an isolated image reused by %s before promoting it to its full-SHA tag", async (_, state) => {
    const { calls, bakes, run } = harness({ existing: [baseRef, isolatedBaseRef, `${repository}/gateway-edge:${sha}`, `${repository}/octogee-gateway:${sha}`, ...(state.existing ?? [])], reusable: state.reusable });
    await run();
    expect(bakes).toEqual([]);
    expect(calls.findIndex(call => call.join(" ") === sizeCheck.join(" "))).toBeLessThan(
      calls.findIndex(call => call[0] === "platform/scripts/lib/publish-full-sha-image-tag.sh" && call[1] === "octogee-gateway-builder"),
    );
    expect(scriptCalls(calls, "assert-artifact-image-size.sh")).toEqual([sizeCheck]);
  });

  it("bakes only what changed over published bases", async () => {
    const { calls, bakes, run } = harness({ existing: [baseRef, isolatedBaseRef, `${repository}/octogee-gateway-builder:${sha}`], reusable: ["gateway-edge"] });
    await run();
    expect(bakes[0].group.default.targets).toEqual(["octogee-gateway"]);
    expect(bakes[0].target["octogee-gateway"].contexts).toEqual({
      "octogee-gateway-base": `docker-image://${baseRef}`,
      "octogee-gateway-system": "target:octogee-gateway-system",
    });
    expect(calls.findIndex(call => call[0] === "prepare-base")).toBeLessThan(calls.findIndex(call => call[0] === "bake"));
    expect(scriptCalls(calls, "assert-artifact-image-size.sh")).toEqual([]);
  });

  it("builds a standalone gateway-edge image without preparing the OpenClaw inputs", async () => {
    const { calls, bakes, run } = harness({ existing: [baseRef, isolatedBaseRef, ...images.slice(1).map(image => `${repository}/${image}:${sha}`)] });
    await run();
    expect(bakes[0].group.default.targets).toEqual(["gateway-edge"]);
    expect(bakes[0].target).not.toHaveProperty("octogee-gateway-system");
    expect(calls).not.toContainEqual(["prepare-base"]);
  });

  it("salts each gateway fingerprint with the base it runs on", async () => {
    const { calls, run } = harness({ existing: [baseRef, isolatedBaseRef] });
    await run();
    expect(scriptCalls(calls, "image-fingerprint-reuse.sh").filter(call => call[1] === "check").map(call => [call[2], call.at(-1)])).toEqual([
      ["gateway-edge", ""], ["octogee-gateway", base], ["octogee-gateway-builder", isolatedBase],
    ]);
  });

  it("records and publishes nothing when the bake fails", async () => {
    const { calls, run } = harness({ bakeError: new Error("bake failed") });
    await expect(run()).rejects.toThrow("bake failed");
    expect(calls.at(-1)).toEqual(["bake"]);
  });
});
