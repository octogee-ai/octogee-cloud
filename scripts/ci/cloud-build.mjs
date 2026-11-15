import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { IMAGE_BUILDS, PLATFORM_CONTEXT, imagePlan } from "./image-build.mjs";
import { gatewayBakePlan } from "./gateway-bake.mjs";

export const PLATFORM_IMAGES = ["glm-controller", "octogee-api", "gateway-edge", "octogee-gateway", "octogee-gateway-builder", "vm-bridge", "provisioning-service"];
export const PLATFORMS = ["linux/amd64", "linux/arm64"];
export const SOURCE_REPOSITORY = "https://github.com/octogee-ai/octogee-cloud";
export const CACHE_PREFIX = "octogee-cloud";

const VM_BRIDGE = { dockerfile: "vm-bridge/Dockerfile", args: {} };
const GATEWAY_BASE = "octogee-gateway-base";
const GATEWAY_SYSTEM = "octogee-gateway-system";
const ISOLATED_BASE = "octogee-gateway-builder-base";
const ISOLATED_GATEWAY = "octogee-gateway-builder";
const unpublished = [GATEWAY_BASE, GATEWAY_SYSTEM, ISOLATED_BASE];
const uncached = [ISOLATED_BASE, ISOLATED_GATEWAY];
const stageContexts = new Set(unpublished);
const stagesOf = { "octogee-gateway": [GATEWAY_BASE, GATEWAY_SYSTEM], [ISOLATED_GATEWAY]: [GATEWAY_BASE, GATEWAY_SYSTEM, ISOLATED_BASE] };
const placeholderBase = `inputs-${"0".repeat(64)}`;
const ISOLATED_TOOLCHAIN = "gateway/isolated-toolchain";

const imagePlatforms = { [ISOLATED_GATEWAY]: ["linux/amd64"] };
export const platformsOf = name => imagePlatforms[name] ?? PLATFORMS;
export const imagesFor = platform => PLATFORM_IMAGES.filter(name => platformsOf(name).includes(platform));

function checkImages(images, platform) {
  const unknown = images.filter(image => !PLATFORM_IMAGES.includes(image));
  if (unknown.length) throw new Error(`Unknown platform image: ${unknown.join(", ")}`);
  const elsewhere = images.filter(image => !platformsOf(image).includes(platform));
  if (elsewhere.length) throw new Error(`${elsewhere.join(", ")} is not published for ${platform}`);
}

function checkInputs({ registry, sha, platform }) {
  if (!/^[a-f0-9]{40}$/.test(sha ?? "")) throw new Error("A full source SHA is required");
  if (!/^[a-z0-9.-]+\/[a-z0-9-]+\/[a-z0-9-]+$/.test(registry ?? "")) throw new Error("Invalid registry repository");
  if (!PLATFORMS.includes(platform)) throw new Error(`Unsupported platform: ${platform}`);
}

function toolchainPins(root) {
  const sha256 = file => createHash("sha256").update(readFileSync(join(root, ISOLATED_TOOLCHAIN, file))).digest("hex");
  return { lockSha256: sha256("package-lock.json"), groupsSha256: sha256("groups.json") };
}

function gatewayTargets(registry, sha, root, wanted) {
  const isolated = wanted.has(ISOLATED_GATEWAY);
  return gatewayBakePlan({
    repository: registry, sha, base: placeholderBase, isolatedBase: `${placeholderBase}-builder-${"0".repeat(12)}`,
    toolchain: isolated ? toolchainPins(root) : {},
    build: { base: true, isolatedBase: isolated, images: ["gateway-edge", "octogee-gateway", ISOLATED_GATEWAY].filter(name => wanted.has(name)) },
  }, root).target;
}

function singleTarget(name, registry, sha, root) {
  const definition = IMAGE_BUILDS[name];
  if (!definition) throw new Error(`Missing platform image definition: ${name}`);
  if (definition.context !== PLATFORM_CONTEXT) throw new Error(`${name} does not build from the platform tree`);
  if (definition.target) throw new Error(`${name} builds a named target, which the platform build does not publish`);
  const plan = imagePlan(name, { repository: registry, sha }, root);
  const dockerfile = relative(PLATFORM_CONTEXT, plan.dockerfile);
  if (!existsSync(join(root, dockerfile))) throw new Error(`${name} has no Dockerfile at ${dockerfile}`);
  const stages = new Set([...readFileSync(join(root, dockerfile), "utf8").matchAll(/^FROM\s+\S+\s+AS\s+(\S+)\s*$/gim)].map(match => match[1].toLowerCase()));
  const missing = Object.keys(plan.contexts ?? {}).filter(context => !stages.has(context));
  if (missing.length) throw new Error(`${name} needs build contexts outside the platform tree: ${missing.join(", ")}`);
  return { dockerfile, args: plan.buildArgs, labels: plan.labels };
}

function checkContexts(name, contexts = {}) {
  const outside = Object.keys(contexts).filter(context => !stageContexts.has(context));
  if (outside.length) throw new Error(`${name} needs build contexts outside the platform tree: ${outside.join(", ")}`);
}

function cacheFor(cache, name, platform) {
  if (cache !== "gha" || uncached.includes(name)) return {};
  const scope = `${CACHE_PREFIX}-${name}-${platform.replace("/", "-")}`;
  return { "cache-from": [`type=gha,scope=${scope}`], "cache-to": [`type=gha,scope=${scope},mode=max`] };
}

function outputFor({ name, registry, push, load, tagPrefix, short }) {
  if (unpublished.includes(name)) return { output: ["type=cacheonly"] };
  if (load || push) {
    if (!tagPrefix) throw new Error("A tag prefix is required to load or push tagged images");
    return { output: [load ? "type=docker" : "type=image,push=true"], tags: [`${tagPrefix}${name}:${short}`] };
  }
  return { output: [`type=image,name=${registry}/${name},push-by-digest=true,name-canonical=true,push=true`] };
}

const planOptions = ({
  registry, sha, platform, root = ".", context = root, load = false, push = false, tagPrefix = "", cache = "", images = imagesFor(platform),
}) => ({ registry, sha, platform, root, context, load, push, tagPrefix, cache, images });

const revisionLabel = sha => ({ labels: { "org.opencontainers.image.revision": sha } });

function sourceFor(name, gateway, { registry, sha, root }) {
  if (gateway[name]) return gateway[name];
  if (name === "vm-bridge") return { ...VM_BRIDGE, ...revisionLabel(sha) };
  return singleTarget(name, registry, sha, root);
}

function bakeTarget(name, source, options) {
  const { platform, root, context, cache, sha } = options;
  const { tags: _tags, output: _output, "cache-from": _from, "cache-to": _to, platforms: _platforms, attest: _attest, context: _context, ...definition } = source;
  checkContexts(name, definition.contexts);
  if (definition.contexts && Object.keys(definition.contexts).length === 0) delete definition.contexts;
  if (!existsSync(join(root, definition.dockerfile))) throw new Error(`${name} has no Dockerfile at ${definition.dockerfile}`);
  return {
    ...definition, context, platforms: [platform], ...outputFor({ ...options, name, short: sha.slice(0, 7) }), ...cacheFor(cache, name, platform),
    attest: ["type=provenance,disabled=true", "type=sbom,disabled=true"],
    labels: { ...definition.labels, "org.opencontainers.image.source": SOURCE_REPOSITORY },
  };
}

export function cloudBakePlan(input) {
  const options = planOptions(input);
  const { registry, sha, platform, root, load, push, images } = options;
  checkInputs({ registry, sha, platform });
  if (load && push) throw new Error("Choose either load or push");
  checkImages(images, platform);
  const wanted = new Set(images);
  for (const image of images) (stagesOf[image] ?? []).forEach(stage => wanted.add(stage));
  const gateway = [...wanted].some(name => name.startsWith("octogee-gateway") || name === "gateway-edge") ? gatewayTargets(registry, sha, root, wanted) : {};
  const target = Object.fromEntries([...wanted].map(name => [name, bakeTarget(name, sourceFor(name, gateway, options), options)]));
  return { group: { default: { targets: images } }, target };
}

export function digestsFromMetadata(metadata, images = PLATFORM_IMAGES) {
  return Object.fromEntries(images.map(name => {
    const digest = metadata[name]?.["containerimage.digest"];
    if (!/^sha256:[a-f0-9]{64}$/.test(digest ?? "")) throw new Error(`No pushed digest for ${name}`);
    return [name, digest];
  }));
}

export function mergeCommands({ registry, sha, digests }) {
  const platforms = Object.keys(digests);
  for (const platform of PLATFORMS) if (!platforms.includes(platform)) throw new Error(`Missing ${platform} digests`);
  return PLATFORM_IMAGES.map(name => [
    "buildx", "imagetools", "create", `--tag=${registry}/${name}:${sha}`, `--tag=${registry}/${name}:${sha.slice(0, 7)}`,
    ...platformsOf(name).map(platform => {
      const digest = digests[platform][name];
      if (!digest) throw new Error(`Missing ${platform} digest for ${name}`);
      return `${registry}/${name}@${digest}`;
    }),
  ]);
}

export function imageManifest({ registry, sha, digests, indexes }) {
  return {
    sha, registry, source: SOURCE_REPOSITORY,
    images: Object.fromEntries(PLATFORM_IMAGES.map(name => {
      if (!/^sha256:[a-f0-9]{64}$/.test(indexes[name] ?? "")) throw new Error(`No index digest for ${name}`);
      return [name, {
        image: `${registry}/${name}@${indexes[name]}`, tag: `${registry}/${name}:${sha}`, digest: indexes[name],
        platforms: Object.fromEntries(platformsOf(name).map(platform => [platform, digests[platform][name]])),
      }];
    })),
  };
}

export function readDigestDirectory(directory) {
  const digests = {};
  for (const file of readdirSync(directory).filter(entry => entry.endsWith(".json"))) {
    const { platform, images } = JSON.parse(readFileSync(join(directory, file), "utf8"));
    if (!PLATFORMS.includes(platform) || digests[platform]) throw new Error(`Unexpected digest file ${file}`);
    digests[platform] = images;
  }
  return digests;
}

const SERVICE_SOURCE_DIRS = { "fleet-controller": "fleet-controller", "gateway-edge": "gateway-edge", "octogee-api": "platform-api" };
const SERVICE_PACKAGES = "fleet-controller|gateway-edge|octogee-api";
const sourceOf = path => path.replace(/^[^/]+/, directory => SERVICE_SOURCE_DIRS[directory]);
const sourceRules = [
  [new RegExp(`(?:^|/)(?:${SERVICE_PACKAGES})/dist/((?:${SERVICE_PACKAGES})/src/.+?)(?:\\.d\\.ts|\\.js\\.map|\\.js)$`), path => [`${sourceOf(path)}.ts`, `${sourceOf(path)}.tsx`]],
  [new RegExp(`(?:^|/)((?:${SERVICE_PACKAGES})/src/.+)$`), path => [sourceOf(path)]],
  [/(?:^|\/)core\/dist\/(.+?)(?:\.d\.ts|\.js\.map|\.js)$/, path => [`core/src/${path}.ts`]],
  [/(?:^|\/)shared\/dist\/(.+?)(?:\.d\.ts|\.js\.map|\.js)$/, path => [`shared/${path}.ts`]],
  [/^octogee\/extensions\/([^/]+)\//, extension => [`gateway/extensions/platform/${extension}`]],
];

export function productFindings(paths, exists) {
  const findings = new Set();
  for (const raw of paths) {
    const path = raw.replace(/^\.?\//, "");
    if (path.endsWith("/") || path.startsWith("usr/")) continue;
    if (/(?:^|\/)node_modules\/@octogee\/product-/.test(path)) { findings.add(path); continue; }
    if (path.includes("node_modules/")) continue;
    if (path.split("/").includes("product")) { findings.add(path); continue; }
    for (const [pattern, sources] of sourceRules) {
      const match = path.match(pattern);
      if (!match) continue;
      if (!sources(match[1]).some(exists)) findings.add(path);
      break;
    }
  }
  return [...findings].sort();
}

const tool = (command, args, stdio) => spawn(command, args, { stdio });

function exited(child, label) {
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", code => (code === 0 ? resolve() : reject(new Error(`${label} exited ${code}`))));
  });
}

function collect(stream) {
  let text = "";
  stream.on("data", chunk => { text += chunk; });
  return () => text;
}

export async function imagePaths(image) {
  const create = tool("docker", ["create", image], ["ignore", "pipe", "inherit"]);
  const id = collect(create.stdout);
  await exited(create, `docker create ${image}`);
  const container = id().trim();
  try {
    const exported = tool("docker", ["export", container], ["ignore", "pipe", "inherit"]);
    const tar = tool("tar", ["-t"], ["pipe", "pipe", "inherit"]);
    exported.stdout.pipe(tar.stdin);
    const listing = collect(tar.stdout);
    await Promise.all([exited(exported, `docker export ${image}`), exited(tar, `listing ${image}`)]);
    const paths = listing().split("\n").filter(Boolean);
    if (!paths.length) throw new Error(`${image} lists no files`);
    return paths;
  } finally {
    await exited(tool("docker", ["rm", container], "ignore"), `docker rm ${container}`);
  }
}

function docker(args) {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- docker is the build runner's own tool.
  const result = spawnSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  if (result.status !== 0) throw new Error(`docker ${args.slice(0, 3).join(" ")} exited ${result.status}`);
  return result.stdout;
}

function options(argv) {
  return Object.fromEntries(argv.filter(arg => arg.startsWith("--")).map(arg => {
    const [key, ...value] = arg.slice(2).split("=");
    return [key, value.length ? value.join("=") : true];
  }));
}

function unbuiltCommit(sha, reference) {
  return new Error([
    `Commit ${sha} has no published images: its Build main run did not publish ${reference}. The run was cancelled, failed or is still running.`,
    `Check out the latest release (${SOURCE_REPOSITORY}/releases/latest) or main's newest built commit`,
    `(${SOURCE_REPOSITORY}/actions/workflows/build-main.yml?query=branch%3Amain+is%3Asuccess) and install again,`,
    `or ask a maintainer to run Build main with workflow_dispatch on a branch or tag at ${sha}.`,
  ].join("\n"));
}

function publishedIndex(reference, sha) {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- docker is the operator's own tool.
  const result = spawnSync("docker", ["buildx", "imagetools", "inspect", reference, "--raw"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status === 0) return JSON.parse(result.stdout);
  const error = (result.stderr ?? "").trim() || `docker exited ${result.status}`;
  if (/: not found$/m.test(error)) throw unbuiltCommit(sha, reference);
  throw new Error(`Could not read ${reference}: ${error}`);
}

function platformDigest(index, platform, reference) {
  const [os, architecture] = platform.split("/");
  const manifest = (index.manifests ?? []).find(entry => entry.platform?.os === os && entry.platform?.architecture === architecture);
  if (!/^sha256:[a-f0-9]{64}$/.test(manifest?.digest ?? "")) throw new Error(`${reference} has no ${platform} image`);
  return manifest.digest;
}

export function resolvePublished({ registry, sha, platform, manifest, images = imagesFor(platform) }) {
  checkInputs({ registry, sha, platform });
  checkImages(images, platform);
  const build = manifest === undefined ? undefined : JSON.parse(readFileSync(manifest, "utf8"));
  if (manifest !== undefined && (build?.sha !== sha || build?.registry !== registry)) {
    throw new Error(`Image manifest does not match ${registry} at ${sha}`);
  }
  return Object.fromEntries(images.map(name => {
    const reference = `${registry}/${name}:${sha}`;
    const digest = build ? build.images?.[name]?.platforms?.[platform] : platformDigest(publishedIndex(reference, sha), platform, reference);
    if (typeof digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(digest)) {
      throw new Error(`Image manifest: ${name} has no valid ${platform} digest`);
    }
    return [name, digest];
  }));
}

export function copyPublished({ registry, sha, platform, tagPrefix, manifest, images }) {
  if (!tagPrefix) throw new Error("A tag prefix is required to copy published images");
  const digests = resolvePublished({ registry, sha, platform, manifest, images });
  for (const [name, digest] of Object.entries(digests)) {
    docker(["buildx", "imagetools", "create", "--prefer-index=false", `--tag=${tagPrefix}${name}:${sha.slice(0, 7)}`, `${registry}/${name}@${digest}`]);
  }
  return { platform, images: digests };
}

const selectedImages = opts => (typeof opts.images === "string" ? { images: opts.images.split(",") } : {});

async function tripwire(opts) {
  const root = opts.root ?? ".";
  const { images: pushed } = JSON.parse(readFileSync(opts.digests, "utf8"));
  const checked = [];
  const failures = [];
  for (const [name, digest] of Object.entries(pushed)) {
    const image = `${opts.registry}/${name}@${digest}`;
    if (opts.pull === true) docker(["pull", "--quiet", image]);
    const findings = productFindings(await imagePaths(image), path => existsSync(join(root, path)));
    if (findings.length) failures.push(`${image} carries files that are not platform source:\n${findings.slice(0, 50).join("\n")}`);
    checked.push(image);
  }
  if (failures.length) throw new Error(failures.join("\n"));
  return { checked };
}

function publish(opts) {
  const digests = readDigestDirectory(opts.digests);
  for (const args of mergeCommands({ registry: opts.registry, sha: opts.sha, digests })) docker(args);
  const indexes = Object.fromEntries(PLATFORM_IMAGES.map(name => [
    name, JSON.parse(docker(["buildx", "imagetools", "inspect", `${opts.registry}/${name}:${opts.sha}`, "--format", "{{json .Manifest}}"])).digest,
  ]));
  return imageManifest({ registry: opts.registry, sha: opts.sha, digests, indexes });
}

const COMMANDS = {
  plan: opts => cloudBakePlan({
    registry: opts.registry, sha: opts.sha, platform: opts.platform, root: opts.root, context: opts.context ?? opts.root,
    load: opts.load === true, push: opts.push === true, tagPrefix: opts["tag-prefix"], cache: opts.cache, ...selectedImages(opts),
  }),
  digests: opts => {
    if (!PLATFORMS.includes(opts.platform)) throw new Error(`Unsupported platform: ${opts.platform}`);
    return { platform: opts.platform, images: digestsFromMetadata(JSON.parse(readFileSync(opts.metadata, "utf8")), selectedImages(opts).images ?? imagesFor(opts.platform)) };
  },
  resolve: opts => ({ platform: opts.platform, sha: opts.sha, images: resolvePublished({ registry: opts.registry, sha: opts.sha, platform: opts.platform, manifest: opts.manifest, ...selectedImages(opts) }) }),
  copy: opts => copyPublished({ registry: opts.registry, sha: opts.sha, platform: opts.platform, tagPrefix: opts["tag-prefix"], manifest: opts.manifest, ...selectedImages(opts) }),
  publish,
  tripwire,
};

async function cli([command, ...rest]) {
  if (!Object.hasOwn(COMMANDS, command ?? "")) throw new Error("Usage: cloud-build.mjs plan|digests|resolve|copy|publish|tripwire [--options]");
  return COMMANDS[command](options(rest));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.stdout.write(`${JSON.stringify(await cli(process.argv.slice(2)), null, 2)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
