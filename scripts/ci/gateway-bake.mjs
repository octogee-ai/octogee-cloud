import { PLATFORM_CONTEXT, findReusable, overlayContexts, productContext, publishImage } from "./image-build.mjs";

const BASE = "octogee-gateway-base";
const ISOLATED_BASE = "octogee-gateway-builder-base";
const SYSTEM = "octogee-gateway-system";
const IMAGES = ["gateway-edge", "octogee-gateway", "octogee-gateway-builder"];
const ISOLATED_MAX_COMPRESSED_BYTES = 3100000000;
const common = {
  context: PLATFORM_CONTEXT,
  platforms: ["linux/amd64"],
  attest: ["type=provenance,disabled=true", "type=sbom,disabled=true"],
  output: ["type=registry"],
};

const withContexts = contexts => (Object.keys(contexts).length ? { contexts } : {});

const requireImmutable = (tag, label) => {
  if (!/^inputs-[a-f0-9]{64}$/.test(tag ?? "")) throw new Error(`An immutable ${label} is required`);
};

export function gatewayBakePlan({ repository, sha, base, isolatedBase, toolchain, build }, cwd = process.cwd()) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("A full source SHA is required");
  if (!/^[a-z0-9.-]+\/[a-z0-9-]+\/[a-z0-9-]+$/.test(repository)) throw new Error("Invalid registry repository");
  requireImmutable(base, "gateway base");
  if (!/^inputs-[a-f0-9]{64}-builder-[a-f0-9]{12}$/.test(isolatedBase ?? "") || !isolatedBase.startsWith(`${base}-`)) throw new Error("An immutable isolated base over the gateway base is required");
  const unknown = build.images.filter(image => !IMAGES.includes(image));
  if (unknown.length) throw new Error(`Unknown gateway image: ${unknown.join(", ")}`);
  const short = sha.slice(0, 7);
  const baseRef = { [BASE]: `${repository}/${BASE}:${base}`, [ISOLATED_BASE]: `${repository}/${ISOLATED_BASE}:${isolatedBase}` };
  const inRun = { [BASE]: build.base, [ISOLATED_BASE]: build.isolatedBase };
  const from = name => inRun[name] ? `target:${name}` : `docker-image://${baseRef[name]}`;
  const systemContext = { [SYSTEM]: `target:${SYSTEM}` };
  const systemArg = { GATEWAY_SYSTEM_IMAGE: SYSTEM };
  const cached = name => ({
    "cache-from": [`type=registry,ref=${repository}/cache/${name}:buildcache`],
    "cache-to": [`type=registry,ref=${repository}/cache/${name}:buildcache,mode=max`],
  });
  const image = (name, extra = {}) => ({
    ...common, ...cached(name), ...extra, tags: [`${repository}/${name}:${short}`],
    args: { BUILD_SHA: short, ...extra.args },
    labels: { "org.opencontainers.image.revision": sha },
  });
  const product = productContext(cwd);
  const runtimeArgs = { OPENCLAW_RUNTIME_PLUGINS: "mattermost,parallel-plugin,codex", ...systemArg };
  const candidates = {
    [BASE]: build.base && {
      ...common, ...cached(BASE), dockerfile: "infra/gateway/Dockerfile.base", target: "gateway-runtime", tags: [baseRef[BASE]],
    },
    [ISOLATED_BASE]: build.isolatedBase && {
      ...common, ...cached(ISOLATED_BASE), dockerfile: "infra/gateway/Dockerfile.isolated-base", tags: [baseRef[ISOLATED_BASE]],
      contexts: { [BASE]: from(BASE), ...systemContext },
      args: { ...systemArg, BUILDER_TOOLCHAIN_LOCK_SHA256: toolchain.lockSha256, BUILDER_TOOL_GROUPS_SHA256: toolchain.groupsSha256 },
    },
    "gateway-edge": build.images.includes("gateway-edge") && image("gateway-edge", { dockerfile: "gateway-edge/Dockerfile", ...withContexts({ ...product, ...overlayContexts({ overlay: "gateway-edge" }, cwd) }) }),
    "octogee-gateway": build.images.includes("octogee-gateway") && image("octogee-gateway", {
      dockerfile: "infra/gateway/Dockerfile", contexts: { [BASE]: from(BASE), ...systemContext, ...product }, args: runtimeArgs,
    }),
    "octogee-gateway-builder": build.images.includes("octogee-gateway-builder") && image("octogee-gateway-builder", {
      dockerfile: "infra/gateway/Dockerfile", contexts: { [BASE]: from(BASE), [ISOLATED_BASE]: from(ISOLATED_BASE), ...systemContext, ...product },
      args: { ...runtimeArgs, RUNTIME_BASE_IMAGE: ISOLATED_BASE, IMAGE_PROFILE: "isolated" },
    }),
  };
  const target = Object.fromEntries(Object.entries(candidates).filter(([, definition]) => definition));
  const targets = Object.keys(target);
  if (Object.values(target).some(definition => definition.contexts?.[SYSTEM])) {
    target[SYSTEM] = {
      ...common, ...cached(SYSTEM), dockerfile: "infra/gateway/Dockerfile.base", target: "gateway-system", output: ["type=cacheonly"],
    };
  }
  return { group: { default: { targets } }, target };
}

export async function buildGatewayImages({ repository, sha, base, isolatedBase, toolchain, force = false, root = process.cwd() }, { exists, script, bake, prepareBase, now = Date.now }) {
  const short = sha.slice(0, 7);
  const build = {
    base: !(await exists(`${repository}/${BASE}:${base}`)),
    isolatedBase: !(await exists(`${repository}/${ISOLATED_BASE}:${isolatedBase}`)),
    images: [],
  };
  const salts = { "gateway-edge": "", "octogee-gateway": base, "octogee-gateway-builder": isolatedBase };
  const found = {};
  for (const [image, salt] of Object.entries(salts)) {
    found[image] = await findReusable(image, { repository, sha, base: salt, force }, { exists, script });
    if (!found[image].result) build.images.push(image);
  }
  const plan = gatewayBakePlan({ repository, sha, base, isolatedBase, toolchain, build }, root);
  const started = now();
  if (plan.group.default.targets.length) {
    if (build.base || plan.target[SYSTEM]) await prepareBase();
    await bake(plan);
  }
  const seconds = Math.round((now() - started) / 1000);
  if (!found["octogee-gateway-builder"].published) await script("platform/scripts/lib/assert-artifact-image-size.sh", [
    `${repository}/octogee-gateway-builder:${short}`, String(ISOLATED_MAX_COMPRESSED_BYTES), repository.split("/")[1],
  ]);
  for (const image of IMAGES) await publishImage(image, { repository, sha }, found[image], { script });
  return [
    { image: BASE, tag: base, result: build.base ? "built" : "found", seconds: build.base ? seconds : 0 },
    { image: ISOLATED_BASE, tag: isolatedBase, result: build.isolatedBase ? "built" : "found", seconds: build.isolatedBase ? seconds : 0 },
    ...IMAGES.map(image => ({ image, tag: short, result: found[image].result || "built", seconds: found[image].result ? 0 : seconds })),
  ];
}
