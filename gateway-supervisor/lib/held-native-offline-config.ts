import { isDeepStrictEqual } from "node:util";
import { mergePatchValueAlreadyApplied } from "@octogee/core/apply-config-patch";
import { runOpenClaw, type OpenClawCommand } from "./openclaw-cli.js";

interface StagedNativeConfig {
  read(): Promise<{ value: unknown; contentSha256: string }>;
  environment: NodeJS.ProcessEnv;
  assertPrivateStaging(): Promise<void>;
  assertOwnerAnchorsAndRoster(value: unknown): Promise<void>;
}

type Projection = { patch: Record<string, unknown>; replacePaths: string[] };

function readProjectionValue(value: unknown, names: string[]): unknown {
  return names.reduce<unknown>((child, key) =>
    child && typeof child === "object" && Object.hasOwn(child, key) ? (child as Record<string, unknown>)[key] : undefined,
  value);
}

function replacementPaths(projection: Projection): string[] {
  return projection.replacePaths.filter(path => {
    if (!/^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/i.test(path)) {
      throw new Error("Held Native offline config does not have concrete replace paths");
    }
    return readProjectionValue(projection.patch, path.split(".")) !== undefined;
  });
}

function projected(value: unknown, projection: Projection, paths: readonly string[]): boolean {
  return mergePatchValueAlreadyApplied(value, projection.patch) && paths.every(path => {
    const names = path.split(".");
    return isDeepStrictEqual(readProjectionValue(value, names), readProjectionValue(projection.patch, names));
  });
}

export async function applyHeldNativeStagedConfig(input: {
  stage: StagedNativeConfig;
  compose: (config: unknown) => Projection;
  assertHeld: () => Promise<void>;
  runNative?: OpenClawCommand;
}) {
  const { stage, compose, assertHeld, runNative = runOpenClaw } = input;
  const check = async () => {
    await assertHeld();
    await stage.assertPrivateStaging();
  };
  const native = async (args: string[], stdin?: string) => {
    await check();
    const result = await runNative(args, { env: stage.environment, stdin, timeoutMs: 45_000 });
    await check();
    if (result.code !== 0) throw new Error(`Held Native staged config command refused (${args[1]})`);
  };
  await check();
  const before = await stage.read();
  if (!/^[a-f0-9]{64}$/.test(before.contentSha256)) throw new Error("Held Native staged config lacks an observed file digest");
  await stage.assertOwnerAnchorsAndRoster(before.value);
  const plan = compose(before.value);
  const paths = replacementPaths(plan);
  const patchArgs = ["config", "patch", "--stdin", ...paths.flatMap(path => ["--replace-path", path])];
  const patch = JSON.stringify(plan.patch);
  await native([...patchArgs, "--dry-run", "--json"], patch);
  const unchanged = projected(before.value, plan, paths);
  if (!unchanged) await native(patchArgs, patch);
  await native(["config", "validate", "--json"]);
  const after = await stage.read();
  const afterPlan = compose(after.value);
  if (!/^[a-f0-9]{64}$/.test(after.contentSha256) ||
      (before.contentSha256 === after.contentSha256) !== unchanged ||
      !projected(after.value, plan, paths) || !projected(after.value, afterPlan, replacementPaths(afterPlan))) {
    throw new Error("Held Native staged file does not match the complete mounted config plan");
  }
  await stage.assertOwnerAnchorsAndRoster(after.value);
  await check();
  return { beforeSha256: before.contentSha256, stagedSha256: after.contentSha256, changed: !unchanged };
}
