import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const PLATFORM_CONTEXT = "platform";
export const PRODUCT_ROOT = "product";

export const IMAGE_BUILDS = {
  "glm-controller": { dockerfile: "platform/fleet-controller/Dockerfile", context: PLATFORM_CONTEXT, overlays: { overlay: "fleet-controller" } },
  "artifact-worker": { dockerfile: "artifact-worker/Dockerfile", context: "." },
  "octogee-api": { dockerfile: "platform/platform-api/Dockerfile", context: PLATFORM_CONTEXT },
  "llm-broker": { dockerfile: "platform/llm-broker/Dockerfile", context: PLATFORM_CONTEXT },
  "octogee-ops-agent-runtime": { dockerfile: "ops-agent/Dockerfile", context: "." },
  "product-controller": { dockerfile: "product/controller/Dockerfile", context: "." },
};

export const productContext = (cwd = process.cwd()) => (existsSync(join(cwd, PRODUCT_ROOT)) ? { product: PRODUCT_ROOT } : {});

export const overlayContexts = (overlays = {}, cwd = process.cwd()) => Object.fromEntries(
  Object.entries(overlays)
    .filter(([, pkg]) => existsSync(join(cwd, PRODUCT_ROOT, pkg)))
    .map(([context, pkg]) => [context, `${PRODUCT_ROOT}/${pkg}`]),
);

export function imagePlan(name, { repository, sha, builds = IMAGE_BUILDS }, cwd = process.cwd()) {
  if (!builds[name]) throw new Error(`Unknown image: ${name}`);
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("A full source SHA is required");
  if (!/^[a-z0-9.-]+\/[a-z0-9-]+\/[a-z0-9-]+$/.test(repository)) throw new Error("Invalid registry repository");
  const { overlays, contexts, ...build } = builds[name];
  return {
    ...build, contexts: { ...contexts, ...(build.context === PLATFORM_CONTEXT ? productContext(cwd) : {}), ...overlayContexts(overlays, cwd) },
    name, repository, buildArgs: { BUILD_SHA: sha.slice(0, 7) },
    tag: `${repository}/${name}:${sha.slice(0, 7)}`,
    labels: { "org.opencontainers.image.revision": sha },
    cache: `${repository}/cache/${name}:buildcache`,
  };
}

export async function buildImage(plan, { run, exists }) {
  const args = [
    "buildx", "build", "--platform=linux/amd64", `--file=${plan.dockerfile}`,
    `--tag=${plan.tag}`, "--provenance=false", "--sbom=false", "--push",
  ];
  if (plan.target) args.push(`--target=${plan.target}`);
  for (const [name, path] of Object.entries(plan.contexts ?? {})) args.push(`--build-context=${name}=${path}`);
  for (const [key, value] of Object.entries(plan.buildArgs ?? {})) args.push(`--build-arg=${key}=${value}`);
  for (const [key, value] of Object.entries(plan.labels ?? {})) args.push(`--label=${key}=${value}`);
  if (await exists(plan.cache)) args.push(`--cache-from=type=registry,ref=${plan.cache}`);
  args.push(`--cache-to=type=registry,ref=${plan.cache},mode=max`, plan.context ?? ".");
  await run("docker", args);
}

export async function findReusable(name, { repository, sha, base = "", force = false }, { exists, script }) {
  const short = sha.slice(0, 7);
  if (await exists(`${repository}/${name}:${sha}`)) return { result: "reused (full-SHA tag)", published: true };
  if (force) return { result: "" };
  if (await exists(`${repository}/${name}:${short}`)) return { result: "reused (short tag)" };
  const check = await script("platform/scripts/lib/image-fingerprint-reuse.sh", ["check", name, repository, short, sha, base]);
  const fingerprint = check.match(/^fingerprint=(.*)$/m)?.[1] ?? "";
  return { result: /^exists=true$/m.test(check) ? "reused (fingerprint)" : "", fingerprint };
}

export async function publishImage(name, { repository, sha }, { result, fingerprint, published }, { script }) {
  if (published) return;
  if (!result && fingerprint) await script("platform/scripts/lib/image-fingerprint-reuse.sh", ["record", name, repository, sha.slice(0, 7), fingerprint]);
  await script("platform/scripts/lib/publish-full-sha-image-tag.sh", [name, repository, sha, repository.split("/")[1]]);
}

export async function ensureImage(name, options, { exists, script, build, now = Date.now }) {
  const started = now();
  const found = await findReusable(name, options, { exists, script });
  if (!found.result) await build(imagePlan(name, options));
  await publishImage(name, options, found, { script });
  return { image: name, tag: options.sha.slice(0, 7), result: found.result || "built", seconds: Math.round((now() - started) / 1000) };
}

export function buildSummary(rows) {
  const lines = rows.map(({ image, tag, result, seconds }) => `| ${image} | \`${tag}\` | ${result} | ${Math.floor(seconds / 60)}m ${seconds % 60}s |`);
  return ["### Main image build", "", "| Image | Tag | Result | Wall time |", "| --- | --- | --- | --- |", ...lines, ""].join("\n");
}

const copiedFiles = (dockerfile, context) => readFileSync(join(context, dockerfile), "utf8").split("\n")
  .filter(line => line.startsWith("COPY ") && !/\s--from=/.test(line))
  .flatMap(line => line.split(/\s+/).slice(1).filter(token => !token.startsWith("--")).slice(0, -1));

const recipe = (dockerfile, context) => [...new Set([dockerfile, ...copiedFiles(dockerfile, context)])]
  .filter(file => !(file.startsWith("gateway/openclaw-tarball/") && file.endsWith(".tgz")));

export const gatewayBaseRecipe = (context = PLATFORM_CONTEXT) => [
  ".dockerignore", "gateway/openclaw-tarball/extract-npm.sh", ...recipe("gateway/Dockerfile.base", context),
];
export const isolatedBaseRecipe = (context = PLATFORM_CONTEXT) => recipe("gateway/Dockerfile.isolated-base", context);
