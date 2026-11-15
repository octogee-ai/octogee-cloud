import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  IMAGE_BUILDS, PLATFORM_CONTEXT, buildImage, buildSummary, isolatedBaseRecipe, ensureImage, gatewayBaseRecipe, imagePlan,
} from "../ci/image-build.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");

const repository = "us-central1-docker.pkg.dev/octogee/octogee";
const sha = "a".repeat(40);
const base = `inputs-${"b".repeat(64)}`;

describe("runner image builds", () => {
  it("builds the isolated runner from its own Docker target", () => {
    const plan = imagePlan("octogee-project-runner", { repository, sha });
    expect(plan.dockerfile).toBe("platform/platform-api/Dockerfile");
    expect(plan.context).toBe("platform");
    expect(plan.target).toBe("project-runner");
    expect(plan.tag).toBe(`${repository}/octogee-project-runner:${sha.slice(0, 7)}`);
  });

  it("pushes with registry caching", async () => {
    const run = vi.fn(async () => {});
    const exists = vi.fn(async () => true);
    const plan = imagePlan("octogee-api", { repository, sha });
    await buildImage(plan, { run, exists });
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0][0]).toBe("docker");
    expect(run.mock.calls[0][1]).toEqual(expect.arrayContaining([
      "buildx", "build", "--platform=linux/amd64", "--push", `--label=org.opencontainers.image.revision=${sha}`,
      `--cache-from=type=registry,ref=${repository}/cache/octogee-api:buildcache`,
    ]));
  });

  it("builds platform images from the platform context and passes their product overlay when it exists", async () => {
    const platformOnly = mkdtempSync(resolve(tmpdir(), "image-plan-"));
    expect(imagePlan("glm-controller", { repository, sha }, platformOnly).contexts).toEqual({});
    expect(imagePlan("octogee-api", { repository, sha }, platformOnly).contexts).toEqual({ "packed-package": "obsidian-connect" });
    const withProduct = mkdtempSync(resolve(tmpdir(), "image-plan-product-"));
    mkdirSync(resolve(withProduct, "product/fleet-controller"), { recursive: true });
    const plan = imagePlan("glm-controller", { repository, sha }, withProduct);
    expect(plan.contexts).toEqual({ product: "product", overlay: "product/fleet-controller" });
    const run = vi.fn(async () => {});
    await buildImage(plan, { run, exists: async () => false });
    const args = run.mock.calls[0][1] as string[];
    expect(args).toContain("--file=platform/fleet-controller/Dockerfile");
    expect(args).toContain("--build-context=overlay=product/fleet-controller");
    expect(args.at(-1)).toBe("platform");
  });

  it("passes the product overlay of every platform package the API image compiles", () => {
    const root = mkdtempSync(resolve(tmpdir(), "image-plan-api-"));
    mkdirSync(resolve(root, "product/gateway-edge"), { recursive: true });
    expect(imagePlan("octogee-api", { repository, sha }, root).contexts)
      .toEqual({ "packed-package": "obsidian-connect", product: "product", "gateway-edge-overlay": "product/gateway-edge" });
    mkdirSync(resolve(root, "product/platform-api"), { recursive: true });
    expect(imagePlan("octogee-project-runner", { repository, sha }, root).contexts).toEqual({
      product: "product", overlay: "product/platform-api", "gateway-edge-overlay": "product/gateway-edge",
    });
  });

  it("gives each default overlay stage content so its build cache follows the overlay it copies", () => {
    const stages = Object.values(IMAGE_BUILDS).filter(build => "overlays" in build).flatMap(({ dockerfile, overlays }) => {
      const source = readFileSync(resolve(repoRoot, relative(PLATFORM_CONTEXT, dockerfile)), "utf8").split(/^FROM /m);
      return Object.keys(overlays).flatMap(name => source.filter(stage => stage.startsWith(`scratch AS ${name}\n`)));
    });
    expect(stages).not.toHaveLength(0);
    for (const stage of stages) expect(stage).toMatch(/^COPY /m);
  });

  it("passes the product libraries to every platform-context image while the product tree exists", () => {
    const root = mkdtempSync(resolve(tmpdir(), "image-plan-libraries-"));
    mkdirSync(resolve(root, "product/core"), { recursive: true });
    expect(imagePlan("glm-controller", { repository, sha }, root).contexts).toEqual({ product: "product" });
    expect(imagePlan("octogee-api", { repository, sha }, root).contexts).toEqual({ "packed-package": "obsidian-connect", product: "product" });
    expect(imagePlan("octogee-project-runner", { repository, sha }, root).contexts).toEqual({ product: "product" });
    expect(imagePlan("artifact-worker", { repository, sha }, root).contexts).toEqual({});
    expect(imagePlan("octogee-ops-agent-runtime", { repository, sha }, root).contexts).toEqual({});
  });

  it.each([
    ["artifact-worker", "artifact-worker/Dockerfile"],
    ["product-controller", "product/controller/Dockerfile"],
  ])("builds the product image %s from the repository root", (image, dockerfile) => {
    const plan = imagePlan(image, { repository, sha });
    expect(plan.dockerfile).toBe(dockerfile);
    expect(plan.context).toBe(".");
  });

  it("leaves the gateway family to the gateway bake", () => {
    for (const image of ["gateway-edge", "octogee-gateway", "octogee-gateway-builder"]) {
      expect(() => imagePlan(image, { repository, sha })).toThrow(`Unknown image: ${image}`);
    }
  });

  it("allows a confirmed cache miss but propagates registry failures", async () => {
    const plan = imagePlan("glm-controller", { repository, sha });
    const run = vi.fn(async () => {});
    await buildImage(plan, { run, exists: async () => false });
    expect(run.mock.calls[0][1].some((arg: string) => arg.startsWith("--cache-from"))).toBe(false);
    run.mockClear();
    await expect(buildImage(plan, { run, exists: async () => { throw new Error("denied"); } })).rejects.toThrow("denied");
    expect(run).not.toHaveBeenCalled();
  });

  it("never checks or publishes a dependent artifact after a build failure", async () => {
    const run = vi.fn(async () => { throw new Error("build failed"); });
    const plan = imagePlan("octogee-api", { repository, sha });
    await expect(buildImage(plan, { run, exists: async () => false })).rejects.toThrow("build failed");
    expect(run).toHaveBeenCalledOnce();
  });
});

describe("image reuse", () => {
  const harness = ({ existing = [] as string[], check = "fingerprint=f1\nexists=false\n" } = {}) => {
    const calls: string[][] = [];
    let clock = 0;
    const record = async (file: string, args: string[]) => {
      calls.push([file, ...args]);
      return args[0] === "check" ? check : "";
    };
    const exists = async (ref: string) => existing.includes(ref);
    return {
      calls,
      deps: {
        exists,
        script: (file: string, args: string[]) => record(file, args),
        build: (plan: ReturnType<typeof imagePlan>) => buildImage(plan, { run: record, exists }),
        now: () => (clock += 90_000),
      },
    };
  };

  it("records the fingerprint and publishes the full-SHA tag after it builds", async () => {
    const { calls, deps } = harness();
    const row = await ensureImage("octogee-api", { repository, sha }, deps);
    expect(calls.filter(call => call[0] === "docker")).toHaveLength(1);
    expect(calls).toContainEqual(["platform/scripts/lib/image-fingerprint-reuse.sh", "record", "octogee-api", repository, sha.slice(0, 7), "f1"]);
    expect(calls.at(-1)).toEqual(["platform/scripts/lib/publish-full-sha-image-tag.sh", "octogee-api", repository, sha, "octogee"]);
    expect(row).toEqual({ image: "octogee-api", tag: sha.slice(0, 7), result: "built", seconds: 90 });
  });

  it.each([
    ["full-SHA tag", { existing: [`${repository}/octogee-api:${sha}`] }, 0],
    ["short tag", { existing: [`${repository}/octogee-api:${sha.slice(0, 7)}`] }, 1],
    ["fingerprint", { check: "fingerprint=f1\nexists=true\n" }, 1],
  ])("reuses by %s without rebuilding", async (via, state, fullShaPublishes) => {
    const { calls, deps } = harness(state);
    const row = await ensureImage("octogee-api", { repository, sha }, deps);
    expect(calls.some(call => call[0] === "docker" || call[1] === "record")).toBe(false);
    expect(calls.filter(call => call[0] === "platform/scripts/lib/publish-full-sha-image-tag.sh")).toHaveLength(fullShaPublishes);
    expect(row.result).toBe(`reused (${via})`);
  });

  it("rebuilds when forced even though a reusable image exists", async () => {
    const { calls, deps } = harness({ existing: [`${repository}/glm-controller:${sha.slice(0, 7)}`], check: "fingerprint=f1\nexists=true\n" });
    const row = await ensureImage("glm-controller", { repository, sha, force: true }, deps);
    expect(row.result).toBe("built");
    expect(calls.some(call => call[1] === "check" || call[1] === "record")).toBe(false);
  });

  it("summarizes each image as reused or built with its tag and wall time", () => {
    const summary = buildSummary([
      { image: "octogee-gateway-base", tag: base, result: "found", seconds: 2 },
      { image: "octogee-gateway-builder", tag: "aaaaaaa", result: "built", seconds: 754 },
      { image: "gateway-edge", tag: "aaaaaaa", result: "reused (fingerprint)", seconds: 3 },
    ]);
    expect(summary).toContain("| Image | Tag | Result | Wall time |");
    expect(summary).toContain(`| octogee-gateway-base | \`${base}\` | found | 0m 2s |`);
    expect(summary).toContain("| octogee-gateway-builder | `aaaaaaa` | built | 12m 34s |");
    expect(summary).toContain("| gateway-edge | `aaaaaaa` | reused (fingerprint) | 0m 3s |");
  });
});

describe("base image recipes", () => {
  it("keys the OpenClaw base on the build context and every file Dockerfile.base copies, not CI plumbing", () => {
    expect(gatewayBaseRecipe(repoRoot).sort()).toEqual([
      ".dockerignore",
      "gateway/Dockerfile.base",
      "gateway/debian-backports/CVE-2026-60002.patch",
      "gateway/debian-backports/CVE-2026-6653.patch",
      "gateway/debian-backports/build.sh",
      "gateway/openclaw-tarball/extract-npm.sh",
      "gateway/openclaw-tarball/npm-distribution.test.mjs",
      "gateway/verify-codex-native-hook-runtime.mjs",
      "gateway/verify-codex-source-match.mjs",
      "gateway/verify-parallel-source-match.mjs",
    ]);
  });

  it("keys the isolated base on every file Dockerfile.isolated-base copies, not CI plumbing", () => {
    expect(isolatedBaseRecipe(repoRoot).sort()).toEqual([
      "gateway/Dockerfile.isolated-base",
      "gateway/isolated-toolchain/base-inputs.mjs",
      "gateway/isolated-toolchain/groups.json",
      "gateway/isolated-toolchain/package-lock.json",
      "gateway/isolated-toolchain/package.json",
      "gateway/isolated-toolchain/preinstall.mjs",
      "gateway/stamp-claude-first-run.mjs",
    ]);
  });
});

it("stages the exact vendored npm bytes independently of the rest of the OpenClaw archive", () => {
  const cwd = mkdtempSync(resolve(tmpdir(), "octogee-gateway-npm-"));
  const extractor = resolve(repoRoot, "gateway/openclaw-tarball/extract-npm.sh");
  try {
    mkdirSync(resolve(cwd, "package/vendor"), { recursive: true });
    writeFileSync(resolve(cwd, "package/vendor/npm.tgz"), Buffer.from([0x1f, 0x8b, 0x08, 0xff]));
    const stageNpm = (version: string) => {
      writeFileSync(resolve(cwd, "package/version"), version);
      execFileSync("tar", ["-czf", "openclaw-fork.tgz", "package"], { cwd });
      execFileSync("bash", [extractor, "openclaw-fork.tgz"], { cwd });
      return readFileSync(resolve(cwd, "npm-fork.tgz"));
    };
    const first = stageNpm("old OpenClaw version");
    const second = stageNpm("new OpenClaw version");
    expect(second).toEqual(first);
    expect(second).toEqual(readFileSync(resolve(cwd, "package/vendor/npm.tgz")));

    rmSync(resolve(cwd, "package/vendor/npm.tgz"));
    execFileSync("tar", ["-czf", "openclaw-fork.tgz", "package"], { cwd });
    const rejected = spawnSync("bash", [extractor, "openclaw-fork.tgz"], { cwd });
    expect(rejected.status).toBeGreaterThan(0);
    expect(existsSync(resolve(cwd, "npm-fork.tgz"))).toBe(false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
