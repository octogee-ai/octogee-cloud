import { spawn } from "node:child_process";
import type {
  GatewayClass,
  GatewayImageProfile,
  GatewayProfile,
  HelmInstancesMap,
  RuntimeUserIdentity,
} from "@octogee/shared/types/glm";
import { dualReadGatewayClassValue } from "@octogee/shared/types/glm";
import type { SizingTier } from "@octogee/shared/types/sizing";
import { SIZING_TIERS } from "@octogee/shared/types/sizing";
import {
  deploymentSettingsForRuntime,
} from "@octogee/core/deployment-environment";
import type { GatewayServiceAccountIdentity } from "./gateway-service-account-ensurer.js";
import type { KubectlSubprocess } from "./fleet-ingress.js";

export interface HelmRunner {

readDeployedInstances(opts: { namespace: string }): Promise<HelmInstancesMap>;

readDeployedInstance(opts: {
  namespace: string;
  gatewayId: string;
}): Promise<HelmInstancesMap[string] | null>;

upsertInstance(opts: {
    namespace: string;
    gatewayId: string;
    // Disposable revision instance id ({gatewayId}-r{n}). Names the Helm release
    // + per-instance resources; defaults to gatewayId (legacy single-revision).
    revisionId?: string;
    builderIdentity?: RuntimeUserIdentity;
    imageRepository: string;
    imageTag: string;
    gatewayEdgeImageRepository?: string;
    gatewayEdgeImageTag?: string;
    serviceAccountName?: string;
    serviceAccount?: HelmInstancesMap[string]["serviceAccount"];
    gatewayContainerSecurityContext?: Record<string, unknown>;
    builderAccess?: HelmInstancesMap[string]["builderAccess"];
    chartPath: string;
    valuesFile?: string;

chartFingerprint?: string;

deploymentIntentFingerprint?: string;

profile?: GatewayProfile;
gatewayClass?: GatewayClass;
imageProfile?: GatewayImageProfile;

sizingTier?: SizingTier;

replicas?: number;

gcpProject?: string;
kmsKeyName?: string;
deploymentTargetId?: string;
deploymentProjectId?: string;
gatewayServiceAccount?: string;
    rollStrategy?: "recreate" | "surge";
    waitForReady?: boolean;
  }): Promise<void>;

removeInstance(opts: {
    namespace: string;
    gatewayId: string;
    awaitHomeCheckpoint?: boolean;
  }): Promise<void>;

  // gatewayIds of releases stuck in a helm pending-* state (an interrupted
  // install/upgrade/rollback). Used by the stuck-release recovery sweeper.
  listPendingReleases(opts: { namespace: string }): Promise<string[]>;

  // Recover one stuck release: roll it back to its last good revision, or
  // uninstall a stuck first-install (no good revision). Returns a human-readable
  // description of what it did — the same recovery the upsert pre-flight runs.
  recoverRelease(opts: { namespace: string; gatewayId: string }): Promise<string>;
}

export interface HelmSubprocessResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type HelmSubprocess = (args: string[]) => Promise<HelmSubprocessResult>;

export interface HelmSubprocessRunnerDeps {
  runHelm: HelmSubprocess;
  log: (msg: string) => void;

  upgradeTimeout?: string;

  uninstallTimeout?: string;

  /**
   * Idempotent pre-install hook: ensure the per-gateway K8s auth-token
   * secret exists before `helm upgrade` runs (the chart references it via
   * secretKeyRef on init/gateway/gateway-edge — missing secret = pod boot
   * fails). Wired in production via `createAuthSecretEnsurer`. Tests that
   * don't care about this hook can leave it undefined.
   */
  ensureAuthSecret?: (opts: {
    namespace: string;
    gatewayId: string;
  }) => Promise<void>;

  /**
   * Idempotent hook: ensure the gateway-scoped K8s ServiceAccount before and
   * after `helm upgrade`, because an older release may prune the now-external
   * object while upgrading to a chart that no longer renders it.
   * (`octogee-gw-<gatewayId>`) exists before `helm upgrade` runs. KSA creation
   * moved OUT of the chart (GATEWAY-RELEASES-SPEC) so simultaneous revision
   * releases don't race on ownership. Wired in production via
   * `createGatewayServiceAccountEnsurer`. Tests that don't care leave it undefined.
   */
  ensureServiceAccount?: (opts: {
    namespace: string;
    serviceAccountName: string;
    identity: GatewayServiceAccountIdentity;
    annotations?: Record<string, string>;
  }) => Promise<void>;

  runKubectl?: KubectlSubprocess;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  workloadDrainTimeoutMs?: number;
  workloadDrainPollMs?: number;
}

const RELEASE_PREFIX = "octogee-gw-";
const SHARED_PLATFORM_SA = "octogee-gateway";

// Mirror the chart's octogee-gateway.serviceAccountName helper: an empty or the
// legacy shared value resolves to the gateway-scoped KSA; anything else is used
// verbatim. The fleet controller must ensure exactly the name the Deployment will reference.
export function effectiveGatewayServiceAccountName(
  gatewayId: string,
  requested: string | undefined,
): string {
  if (!requested || requested === SHARED_PLATFORM_SA) {
    return `${RELEASE_PREFIX}${gatewayId}`;
  }
  return requested;
}

function gatewayServiceAccountIdentity(opts: {
  namespace: string;
  gatewayId: string;
  deploymentTargetId?: string;
}): GatewayServiceAccountIdentity {
  return {
    gatewayId: opts.gatewayId,
    deploymentTargetId: deploymentSettingsForRuntime({
      namespace: opts.namespace,
      targetId: opts.deploymentTargetId,
    }).targetId,
    lifecycleIdentity: `gateway-${opts.gatewayId}`,
    releaseName: releaseNameForGateway(opts.gatewayId),
  };
}

const NOT_FOUND_PATTERNS = [
  /release:\s*not found/i,
  /no release named/i,
  /no deployed releases/i,
];

function isReleaseNotFound(stderr: string): boolean {
  return NOT_FOUND_PATTERNS.some((p) => p.test(stderr));
}

const UNINSTALL_COMPLETED_WITH_ERRORS = /uninstallation completed with \d+ error\(s\):([\s\S]*)$/;
const TERMINATING_RESOURCE_ERROR =
  /resource \S+ still exists\. status: Terminating, message: [^;\n]*/g;
const FAILED_UNINSTALL_RELEASE = /helm uninstall (\S+) failed/;
const MISSING_RELEASE_RECORD_ERROR =
  /uninstall: Failed to purge the release: secrets "sh\.helm\.release\.v1\.(\S+?)\.v\d+" not found/g;

type BenignUninstallErrors = { terminating: number; missingRecord: number };

function benignUninstallErrors(output: string, release: string): BenignUninstallErrors | null {
  const errors = UNINSTALL_COMPLETED_WITH_ERRORS.exec(output)?.[1];
  if (errors === undefined) return null;
  const counts = { terminating: 0, missingRecord: 0 };
  const residue = errors
    .replace(TERMINATING_RESOURCE_ERROR, () => { counts.terminating++; return ""; })
    .replace(MISSING_RELEASE_RECORD_ERROR, (match, recordRelease: string) => {
      if (recordRelease !== release) return match;
      counts.missingRecord++;
      return "";
    });
  if (counts.terminating + counts.missingRecord === 0 || !/^[\s;]*$/.test(residue)) return null;
  return counts;
}

function isUninstallLeavingOnlyMissingRecord(output: string, release: string): boolean {
  const benign = benignUninstallErrors(output, release);
  return benign !== null && benign.terminating === 0;
}

function isUninstallLeavingOnlyBenignErrors(output: string, release: string): boolean {
  return benignUninstallErrors(output, release) !== null;
}

const WORKLOAD_STILL_TERMINATING = "gateway workload still terminating";

export function isRetryableUninstallFailure(message: string): boolean {
  if (message.includes(WORKLOAD_STILL_TERMINATING)) return true;
  const release = FAILED_UNINSTALL_RELEASE.exec(message)?.[1] ?? "";
  return isUninstallLeavingOnlyBenignErrors(message, release);
}

async function listWorkloadNames(
  runKubectl: KubectlSubprocess,
  namespace: string,
  kind: "pods" | "deployments",
  selector: string,
): Promise<string[]> {
  const result = await runKubectl(["-n", namespace, "get", kind, "-l", selector, "-o", "name"]);
  if (result.code !== 0) {
    throw new Error(
      `kubectl get ${kind} -l ${selector} failed (code=${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result.stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
}

async function awaitGatewayWorkloadGone(
  deps: HelmSubprocessRunnerDeps & { runKubectl: KubectlSubprocess },
  namespace: string,
  gatewayId: string,
): Promise<void> {
  const release = releaseNameForGateway(gatewayId);
  const now = deps.now ?? Date.now;
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = deps.workloadDrainTimeoutMs ?? 180_000;
  const pollMs = deps.workloadDrainPollMs ?? 5_000;
  const deadline = now() + timeoutMs;
  for (;;) {
    const remaining = [
      ...(await listWorkloadNames(deps.runKubectl, namespace, "pods", `app=octogee-gateway,gateway-id=${gatewayId}`)),
      ...(await listWorkloadNames(deps.runKubectl, namespace, "deployments", `app.kubernetes.io/instance=${release}`)),
    ];
    if (remaining.length === 0) {
      deps.log(`[helm-runner] release=${release} ns=${namespace} workload gone`);
      return;
    }
    if (now() >= deadline) {
      throw new Error(
        `${WORKLOAD_STILL_TERMINATING}: release ${release} is uninstalled but ${remaining.join(", ")} remained after ${timeoutMs}ms`,
      );
    }
    await wait(pollMs);
  }
}

function releaseNameForGateway(gatewayId: string): string {
  return `${RELEASE_PREFIX}${gatewayId}`;
}

function gatewayIdFromRelease(releaseName: string): string | null {
  if (!releaseName.startsWith(RELEASE_PREFIX)) return null;
  return releaseName.slice(RELEASE_PREFIX.length);
}

interface HelmListItem {
  name: string;
  namespace: string;
  status: string;
}

interface PerReleaseValues {
  gatewayId?: unknown;
  imageTag?: unknown;
  image?: { repository?: unknown; tag?: unknown };
  chartFingerprint?: unknown;
  deploymentIntentFingerprint?: unknown;
  serviceAccountName?: unknown;
  serviceAccount?: unknown;
  gatewayContainerSecurityContext?: unknown;
  builderAccess?: unknown;
  profile?: unknown;
  gatewayClass?: unknown;
  imageProfile?: unknown;
  sizingTier?: unknown;
  replicas?: unknown;
}

type HelmInstanceKnobs = Partial<HelmInstancesMap[string]>;
type PersonalKnobReader = (v: PerReleaseValues) => HelmInstanceKnobs;

function coerceIdentityField(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

async function listGatewayReleases(
  deps: HelmSubprocessRunnerDeps,
  namespace: string,
): Promise<HelmListItem[]> {
  const list = await deps.runHelm([
    "list",
    "-n",
    namespace,
    "--filter",
    `^${RELEASE_PREFIX}`,
    "-o",
    "json",
  ]);
  if (list.code !== 0) {
    throw new Error(
      `helm list failed (code=${list.code}): ${list.stderr.trim() || list.stdout.trim()}`,
    );
  }
  return (JSON.parse(list.stdout || "[]") as HelmListItem[]) ?? [];
}

async function readInstanceValue(
  deps: HelmSubprocessRunnerDeps,
  namespace: string,
  releaseName: string,
): Promise<HelmInstancesMap[string] | null> {
  const valuesResult = await deps.runHelm([
    "get",
    "values",
    releaseName,
    "-n",
    namespace,
    "-o",
    "json",
  ]);
  if (valuesResult.code !== 0) {
    if (isReleaseNotFound(valuesResult.stderr)) return null;
    throw new Error(
      `helm get values ${releaseName} failed (code=${valuesResult.code}): ${valuesResult.stderr.trim() || valuesResult.stdout.trim()}`,
    );
  }
  const v = JSON.parse(valuesResult.stdout || "{}") as PerReleaseValues;
  const gatewayId = coerceIdentityField(v.gatewayId);
  const imageTag = coerceIdentityField(v.imageTag);
  const imageRepo = coerceIdentityField(v.image?.repository);
  if (!gatewayId || !imageTag || !imageRepo) {
    deps.log(
      `[helm-runner] release ${releaseName} missing gatewayId/imageTag/imageRepository — skipping`,
    );
    return null;
  }
  const chartFingerprint = nonEmptyString(v.chartFingerprint);
  const deploymentIntentFingerprint = nonEmptyString(v.deploymentIntentFingerprint);
  return {
    enabled: true,
    image: { repository: imageRepo, tag: imageTag },
    gatewayId,
    ...(chartFingerprint ? { chartFingerprint } : {}),
    ...(deploymentIntentFingerprint ? { deploymentIntentFingerprint } : {}),
    ...readPersonalKnobs(v),
  };
}

const PROFILE_VALUES = new Set<GatewayProfile>(["standard", "isolated"]);
const GATEWAY_CLASS_VALUES = new Set<GatewayClass>(["shared", "isolated"]);
const IMAGE_PROFILE_VALUES = new Set<GatewayImageProfile>(["standard", "isolated"]);
const SIZING_TIER_VALUES = new Set<SizingTier>(SIZING_TIERS);

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function enumString<T extends string>(v: unknown, values: ReadonlySet<T>): T | undefined {
  return typeof v === "string" && values.has(v as T) ? v as T : undefined;
}

function integerAtLeastZero(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined;
}

function plainObjectKnob<T>(v: unknown): T | undefined {
  return isPlainObject(v) ? v as T : undefined;
}

function knob<K extends keyof HelmInstanceKnobs>(
  key: K,
  value: HelmInstanceKnobs[K] | undefined,
): HelmInstanceKnobs {
  return value === undefined ? {} : { [key]: value } as HelmInstanceKnobs;
}

const PERSONAL_KNOB_READERS: PersonalKnobReader[] = [
  (v) => knob("serviceAccountName", nonEmptyString(v.serviceAccountName)),
  (v) => knob("serviceAccount", plainObjectKnob<HelmInstancesMap[string]["serviceAccount"]>(v.serviceAccount)),
  (v) => knob("gatewayContainerSecurityContext", plainObjectKnob<Record<string, unknown>>(
    v.gatewayContainerSecurityContext,
  )),
  (v) => knob("builderAccess", plainObjectKnob<HelmInstancesMap[string]["builderAccess"]>(v.builderAccess)),
  (v) => knob("profile", enumString(dualReadGatewayClassValue(v.profile), PROFILE_VALUES)),
  (v) => knob("gatewayClass", enumString(dualReadGatewayClassValue(v.gatewayClass), GATEWAY_CLASS_VALUES)),
  (v) => knob("imageProfile", enumString(dualReadGatewayClassValue(v.imageProfile), IMAGE_PROFILE_VALUES)),
  (v) => knob("sizingTier", enumString(v.sizingTier, SIZING_TIER_VALUES)),
  (v) => knob("replicas", integerAtLeastZero(v.replicas)),
];

export function readPersonalKnobs(
  v: PerReleaseValues,
): Partial<HelmInstancesMap[string]> {
  return Object.assign({}, ...PERSONAL_KNOB_READERS.map((read) => read(v)));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

const HELM_SET = "--set";
const HELM_SET_STRING = "--set-string";
const HELM_SET_JSON = "--set-json";

function pushSetJson(args: string[], key: string, value: unknown): void {
  args.push(HELM_SET_JSON, `${key}=${JSON.stringify(value)}`);
}

export interface BuildUpgradeArgsOpts {
  release: string;
  chartPath: string;
  namespace: string;
  gatewayId: string;
  revisionId?: string;
  imageTag: string;
  imageRepository: string;
  gatewayEdgeImageRepository?: string;
  gatewayEdgeImageTag?: string;
  upgradeTimeout: string;
  chartFingerprint?: string;
  deploymentIntentFingerprint?: string;
  profile?: string;
  gatewayClass?: GatewayClass;
  imageProfile?: GatewayImageProfile;
  sizingTier?: SizingTier;
  replicas?: number;
  serviceAccountName?: string;
  serviceAccount?: HelmInstancesMap[string]["serviceAccount"];
  gatewayContainerSecurityContext?: Record<string, unknown>;
  builderAccess?: HelmInstancesMap[string]["builderAccess"];
  gcpProject?: string;
  kmsKeyName?: string;
  deploymentTargetId?: string;
  deploymentProjectId?: string;
  gatewayServiceAccount?: string;
  valuesFile?: string;
  rollStrategy?: "recreate" | "surge";
  waitForReady?: boolean;
}

type UpgradeStringOption = {
  option: keyof Pick<
    BuildUpgradeArgsOpts,
    | "chartFingerprint"
    | "deploymentIntentFingerprint"
    | "profile"
    | "gatewayClass"
    | "imageProfile"
    | "sizingTier"
    | "serviceAccountName"
    | "gcpProject"
    | "kmsKeyName"
    | "deploymentTargetId"
    | "deploymentProjectId"
    | "gatewayServiceAccount"
    | "gatewayEdgeImageRepository"
    | "gatewayEdgeImageTag"
    | "rollStrategy"
  >;
  key: string;
};

type UpgradeJsonOption = {
  option: keyof Pick<
    BuildUpgradeArgsOpts,
    | "serviceAccount"
    | "gatewayContainerSecurityContext"
    | "builderAccess"
  >;
  key: string;
};

const UPGRADE_STRING_OPTIONS: UpgradeStringOption[] = [
  { option: "chartFingerprint", key: "chartFingerprint" },
  { option: "deploymentIntentFingerprint", key: "deploymentIntentFingerprint" },
  { option: "profile", key: "profile" },
  { option: "gatewayClass", key: "gatewayClass" },
  { option: "imageProfile", key: "imageProfile" },
  { option: "sizingTier", key: "sizingTier" },
  { option: "serviceAccountName", key: "serviceAccountName" },
  { option: "deploymentTargetId", key: "gatewayEdge.env.DEPLOYMENT_TARGET_ID" },
  { option: "deploymentProjectId", key: "env.gcloudProject" },
  { option: "deploymentProjectId", key: "env.firebaseProjectId" },
  { option: "deploymentProjectId", key: "gatewayEdge.env.FIREBASE_PROJECT_ID" },
  { option: "deploymentProjectId", key: "gatewayEdge.env.GCLOUD_PROJECT" },
  { option: "deploymentProjectId", key: "gatewayEdge.env.GCP_PROJECT_ID" },
  { option: "gcpProject", key: "gatewayEdge.env.GCP_PROJECT_ID" },
  { option: "kmsKeyName", key: "gatewayEdge.env.OCTOGEE_KMS_KEY_NAME" },
  { option: "gatewayServiceAccount", key: "gatewayEdge.env.GATEWAY_SERVICE_ACCOUNT" },
  { option: "gatewayEdgeImageRepository", key: "gatewayEdge.image.repository" },
  { option: "gatewayEdgeImageTag", key: "gatewayEdge.image.tag" },
  { option: "rollStrategy", key: "rollStrategy" },
];

const UPGRADE_JSON_OPTIONS: UpgradeJsonOption[] = [
  { option: "serviceAccount", key: "serviceAccount" },
  { option: "gatewayContainerSecurityContext", key: "gatewayContainerSecurityContext" },
  { option: "builderAccess", key: "builderAccess" },
];

function baseUpgradeArgs(opts: BuildUpgradeArgsOpts): string[] {
  const args = [
    "upgrade",
    "--install",
    opts.release,
    opts.chartPath,
    "-n",
    opts.namespace,
    HELM_SET_STRING,
    `gatewayId=${opts.gatewayId}`,
    HELM_SET_STRING,
    `imageTag=${opts.imageTag}`,
    HELM_SET_STRING,
    `image.repository=${opts.imageRepository}`,
    HELM_SET_STRING,
    `env.mmInternalUrl=http://mattermost.${opts.namespace}.svc.cluster.local:8065`,
  ];
  // Revision-aware render: pass the disposable revision id so per-instance
  // resource names key off it. Omitted → chart defaults revisionId to gatewayId
  // (legacy single-revision render is unchanged).
  if (opts.revisionId) {
    args.push(HELM_SET_STRING, `revisionId=${opts.revisionId}`);
  }
  return args;
}

function appendOptionalStringArgs(args: string[], opts: BuildUpgradeArgsOpts): void {
  for (const { option, key } of UPGRADE_STRING_OPTIONS) {
    const value = opts[option];
    if (typeof value === "string" && value.length > 0) args.push(HELM_SET_STRING, `${key}=${value}`);
  }
}

function appendOptionalJsonArgs(args: string[], opts: BuildUpgradeArgsOpts): void {
  for (const { option, key } of UPGRADE_JSON_OPTIONS) {
    const value = opts[option];
    if (value) pushSetJson(args, key, value);
  }
}

function appendOptionalNumberArgs(args: string[], opts: BuildUpgradeArgsOpts): void {
  if (opts.replicas !== undefined) args.push(HELM_SET, `replicas=${opts.replicas}`);
}

function appendOptionalFileArgs(args: string[], opts: BuildUpgradeArgsOpts): void {
  if (opts.valuesFile) args.push("-f", opts.valuesFile);
}

function appendUpgradeApplyArgs(args: string[], opts: BuildUpgradeArgsOpts): void {
  args.push("--server-side=true", "--force-conflicts");
  args.push("--take-ownership");
  if (opts.waitForReady !== false) args.push("--wait");
  args.push(`--timeout=${opts.upgradeTimeout}`);
}

/**
 * Builds the `helm upgrade --install` argv. Extracted from upsertInstance
 * so the per-knob conditionals don't push the orchestrator over the
 * complexity-15 threshold.
 *
 * Note: gcpProject is the BYO-GCP escape hatch — when set, overrides the
 * chart's gatewayEdge.env.GCP_PROJECT_ID. Otherwise the chart's
 * values.yaml + values.{prod,test}.yaml are the single source of truth
 * (no fleet controller --set, no kubectl-set-env field-manager collision risk on
 * the next upgrade — see post-mortem in PR #TBD).
 */
export function buildUpgradeArgs(opts: BuildUpgradeArgsOpts): string[] {
  // String-typed fields use `--set-string` so a digit-only value (e.g.
  // imageTag="3280519" from a CI build-number tag without a SHA suffix)
  // doesn't get coerced to a number by helm's `--set` parser and rejected
  // by the chart schema. Numeric fields (replicas) still use `--set` — they
  // want number semantics.
  const args = baseUpgradeArgs(opts);
  appendOptionalStringArgs(args, opts);
  appendOptionalNumberArgs(args, opts);
  appendOptionalJsonArgs(args, opts);
  appendOptionalFileArgs(args, opts);
  // Server-side apply + force-conflicts: matches the umbrella install path
  // that the CI deploy job has used since #913 + #1056. Strategic merge
  // collides a live kubectl-set `OPENCLAW_GATEWAY_TOKEN: value=<hex>` with
  // the chart's `OPENCLAW_GATEWAY_TOKEN: valueFrom={secretKeyRef}` into one
  // env entry with both fields. SSA + force-conflicts lets helm
  // unconditionally reclaim ownership of fields it manages from any
  // earlier kubectl-set / kubectl-patch / kubectl-rollout side-channel.
  //
  // Syntax matters: helm v4 treats --server-side as a STRING flag taking
  // "true"/"false"/"auto". Writing `--server-side --force-conflicts`
  // (no `=true`) parses as `--server-side="--force-conflicts"` — invalid
  // value silently defaulting to "auto", and the literal `--force-conflicts`
  // is never applied (#1054 post-mortem). Always `--server-side=true`.
  appendUpgradeApplyArgs(args, opts);
  return args;
}

const IN_PROGRESS_PATTERN =
  /another operation \(install\/upgrade\/rollback\) is in progress/i;

const PENDING_STATUSES = new Set([
  "pending-install",
  "pending-upgrade",
  "pending-rollback",
]);

async function getReleaseStatus(
  deps: HelmSubprocessRunnerDeps,
  namespace: string,
  release: string,
): Promise<string | null> {
  const result = await deps.runHelm([
    "status", release, "-n", namespace, "-o", "json",
  ]);
  if (result.code !== 0) {
    if (isReleaseNotFound(result.stderr)) return null;
    throw new Error(
      `helm status ${release} (ns=${namespace}) failed (code=${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  let parsed: { info?: { status?: unknown } };
  try {
    parsed = JSON.parse(result.stdout) as { info?: { status?: unknown } };
  } catch (e) {
    throw new Error(
      `helm status ${release} (ns=${namespace}): could not parse JSON output: ${(e as Error).message}`,
    );
  }

const status = parsed.info?.status;
  if (typeof status !== "string" || status.length === 0) {
    const sample = result.stdout.slice(0, 200);
    throw new Error(
      `helm status ${release} (ns=${namespace}): info.status missing or non-string in response (got ${typeof status}). stdout[:200]: ${sample}`,
    );
  }
  return status;
}

interface HelmHistoryItem {
  revision: number;
  status: string;
}

const GOOD_ROLLBACK_STATUSES = new Set(["deployed", "superseded"]);

function parseHelmHistory(release: string, stdout: string): HelmHistoryItem[] {
  const raw = stdout.trim() || "[]";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `helm history ${release} returned unparseable output during recovery: ${raw.slice(0, 200)}`,
    );
  }
  const items = Array.isArray(parsed)
    ? parsed.filter(
        (h): h is HelmHistoryItem =>
          typeof (h as { revision?: unknown } | null)?.revision === "number" &&
          typeof (h as { status?: unknown } | null)?.status === "string",
      )
    : [];
  if (items.length === 0) {
    throw new Error(
      `helm history ${release} returned no usable revision history during recovery: ${raw.slice(0, 200)}`,
    );
  }
  return items;
}

function findLastGoodRevision(history: readonly HelmHistoryItem[]): number | null {
  let best: number | null = null;
  for (const h of history) {
    if (
      typeof h.revision === "number" &&
      GOOD_ROLLBACK_STATUSES.has(h.status) &&
      (best === null || h.revision > best)
    ) {
      best = h.revision;
    }
  }
  return best;
}

async function recoverStuckRelease(
  deps: HelmSubprocessRunnerDeps,
  namespace: string,
  release: string,
  upgradeTimeout: string,
  uninstallTimeout: string,
): Promise<string> {

const hist = await deps.runHelm([
    "history", release, "-n", namespace, "-o", "json",
  ]);
  if (hist.code !== 0) {
    if (isReleaseNotFound(hist.stderr)) {
      return `${release} no longer exists — retry will fresh-install`;
    }
    throw new Error(
      `helm history ${release} failed during recovery (code=${hist.code}): ${hist.stderr.trim() || hist.stdout.trim()}`,
    );
  }
  const history = parseHelmHistory(release, hist.stdout);
  const target = findLastGoodRevision(history);
  if (target === null) {
    const un = await deps.runHelm([
      "uninstall", release, "-n", namespace, "--wait", `--timeout=${uninstallTimeout}`,
    ]);
    if (un.code !== 0 && !isReleaseNotFound(un.stderr)) {
      throw new Error(
        `helm uninstall ${release} failed during recovery (code=${un.code}): ${un.stderr.trim() || un.stdout.trim()}`,
      );
    }
    return `uninstalled stuck first-install ${release} (no good revision to roll back to)`;
  }
  // Same SSA + force-conflicts as the upgrade path (see buildUpgradeArgs): a
  // recovery rollback must be able to reclaim fields a kubectl-set/-patch
  // side-channel grabbed, or it dies on the conflict instead of unblocking.
  const rb = await deps.runHelm([
    "rollback", release, String(target), "-n", namespace,
    "--server-side=true", "--force-conflicts", "--wait", `--timeout=${upgradeTimeout}`,
  ]);
  if (rb.code !== 0) {
    throw new Error(
      `helm rollback ${release} → revision ${target} failed during recovery (code=${rb.code}): ${rb.stderr.trim() || rb.stdout.trim()}`,
    );
  }
  return `rolled back ${release} to revision ${target}`;
}

export function createHelmSubprocessRunner(deps: HelmSubprocessRunnerDeps): HelmRunner {
  const upgradeTimeout = deps.upgradeTimeout ?? "10m";
  const uninstallTimeout = deps.uninstallTimeout ?? "5m";

  return {
    async readDeployedInstances({ namespace }) {
      const items = await listGatewayReleases(deps, namespace);
      const entries: [string, HelmInstancesMap[string]][] = [];
      for (const item of items) {
        const gatewayId = gatewayIdFromRelease(item.name);
        if (!gatewayId) continue;
        const value = await readInstanceValue(deps, namespace, item.name);
        if (value) entries.push([gatewayId, value]);
      }
      return Object.fromEntries(entries);
    },

    async readDeployedInstance({ namespace, gatewayId }) {
      const release = releaseNameForGateway(gatewayId);
      const status = await getReleaseStatus(deps, namespace, release);
      if (status === null || status === "uninstalled") return null;
      return readInstanceValue(deps, namespace, release);
    },

    async upsertInstance(opts) {
      const { namespace, gatewayId, imageTag, chartFingerprint } = opts;
      // The Helm release + per-instance resources key off the revision id
      // (octogee-gw-{revisionId}); legacy callers omit revisionId → gatewayId.
      const revisionId = opts.revisionId ?? gatewayId;
      const release = releaseNameForGateway(revisionId);
      const args = buildUpgradeArgs({
        ...opts,
        release,
        upgradeTimeout,
      });

      const ensureServiceAccount = async () => {
        if (!deps.ensureServiceAccount) return;
        const serviceAccountName = effectiveGatewayServiceAccountName(
          gatewayId,
          opts.serviceAccountName,
        );
        if (serviceAccountName !== releaseNameForGateway(gatewayId)) return;
        await deps.ensureServiceAccount({
          namespace,
          serviceAccountName,
          identity: gatewayServiceAccountIdentity({
            namespace,
            gatewayId,
            deploymentTargetId: opts.deploymentTargetId,
          }),
          annotations: opts.serviceAccount?.annotations,
        });
      };

      await ensureServiceAccount();

      if (deps.ensureAuthSecret) {
        await deps.ensureAuthSecret({ namespace, gatewayId });
      }

      const preFlightStatus = await getReleaseStatus(deps, namespace, release);
      if (preFlightStatus !== null && PENDING_STATUSES.has(preFlightStatus)) {
        deps.log(
          `[helm-runner] ⚠ ${release} pre-flight detected stuck state '${preFlightStatus}' — running recovery before upgrade`,
        );
        const recovered = await recoverStuckRelease(
          deps,
          namespace,
          release,
          upgradeTimeout,
          uninstallTimeout,
        );
        deps.log(`[helm-runner] pre-flight recovery: ${recovered}`);
      }

      let result: HelmSubprocessResult;
      try {
        result = await deps.runHelm(args);
        if (
          result.code !== 0 &&
          IN_PROGRESS_PATTERN.test(`${result.stderr}\n${result.stdout}`)
        ) {
          deps.log(
            `[helm-runner] ⚠ ${release} stuck (another helm operation in progress) — attempting recovery`,
          );
          const recovered = await recoverStuckRelease(
            deps,
            namespace,
            release,
            upgradeTimeout,
            uninstallTimeout,
          );
          deps.log(`[helm-runner] recovery: ${recovered} — retrying upgrade`);
          result = await deps.runHelm(args);
        }
      } finally {
        await ensureServiceAccount();
      }
      if (result.code !== 0) {
        throw new Error(
          `helm upgrade --install ${release} failed (code=${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
        );
      }
      const fpTag = chartFingerprint ? ` chartFingerprint=${chartFingerprint.slice(0, 12)}` : "";
      deps.log(
        `[helm-runner] upserted release=${release} ns=${namespace} gatewayId=${gatewayId} imageTag=${imageTag}${fpTag}`,
      );
    },

    async removeInstance({ namespace, gatewayId }) {
      const release = releaseNameForGateway(gatewayId);
      const uninstallArgs = [
        "uninstall",
        release,
        "-n",
        namespace,
        "--wait",
        "--cascade=foreground",
        `--timeout=${uninstallTimeout}`,
      ];
      let result = await deps.runHelm(uninstallArgs);

if (
        result.code !== 0 &&
        !isReleaseNotFound(result.stderr) &&
        IN_PROGRESS_PATTERN.test(`${result.stderr}\n${result.stdout}`)
      ) {
        deps.log(
          `[helm-runner] ⚠ ${release} stuck (another helm operation in progress) — attempting recovery before uninstall`,
        );
        const recovered = await recoverStuckRelease(
          deps,
          namespace,
          release,
          upgradeTimeout,
          uninstallTimeout,
        );
        deps.log(`[helm-runner] recovery: ${recovered} — retrying uninstall`);
        result = await deps.runHelm(uninstallArgs);
      }
      const runKubectl = deps.runKubectl;
      if (result.code !== 0) {
        if (isReleaseNotFound(result.stderr) || isUninstallLeavingOnlyMissingRecord(result.stderr, release)) {
          deps.log(
            `[helm-runner] uninstall release=${release} ns=${namespace} — already gone`,
          );
          if (runKubectl) await awaitGatewayWorkloadGone({ ...deps, runKubectl }, namespace, gatewayId);
          return;
        }
        if (runKubectl && isUninstallLeavingOnlyBenignErrors(result.stderr, release)) {
          deps.log(
            `[helm-runner] uninstalled release=${release} ns=${namespace} — awaiting terminating workload`,
          );
          await awaitGatewayWorkloadGone({ ...deps, runKubectl }, namespace, gatewayId);
          return;
        }
        throw new Error(
          `helm uninstall ${release} failed (code=${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
        );
      }
      deps.log(
        `[helm-runner] uninstalled release=${release} ns=${namespace}`,
      );
    },

    async listPendingReleases({ namespace }) {
      const items = await listGatewayReleases(deps, namespace);
      return items
        .filter((item) => PENDING_STATUSES.has(item.status))
        .map((item) => gatewayIdFromRelease(item.name))
        .filter((id): id is string => id !== null);
    },

    async recoverRelease({ namespace, gatewayId }) {
      return recoverStuckRelease(
        deps,
        namespace,
        releaseNameForGateway(gatewayId),
        upgradeTimeout,
        uninstallTimeout,
      );
    },
  };
}

const DEFAULT_HELM_BIN = "/usr/local/bin/helm";

export function spawnHelm(args: string[]): Promise<HelmSubprocessResult> {
  const helmBin = process.env.HELM_BIN ?? DEFAULT_HELM_BIN;
  return new Promise<HelmSubprocessResult>((resolve, reject) => {
    const proc = spawn(helmBin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    proc.on("error", reject);
    proc.on("close", (code, signal) => {
      if (signal !== null) {
        resolve({
          stdout,
          stderr: stderr + `\nhelm terminated by signal ${signal}`,
          code: 128,
        });
        return;
      }
      resolve({ stdout, stderr, code: code ?? 1 });
    });
  });
}

export function createLoggingHelmRunner(log: (msg: string) => void): HelmRunner {
  return {
    readDeployedInstances: async ({ namespace }) => {
      log(`[helm-runner:stub] readDeployedInstances ns=${namespace} — returning empty`);
      return {};
    },
    readDeployedInstance: async ({ namespace, gatewayId }) => {
      log(
        `[helm-runner:stub] readDeployedInstance ns=${namespace} gatewayId=${gatewayId} — returning missing`,
      );
      return null;
    },
    upsertInstance: async (opts) => {
      log(
        `[helm-runner:stub] upsertInstance ns=${opts.namespace} gatewayId=${opts.gatewayId} imageTag=${opts.imageTag} — no exec`,
      );
    },
    removeInstance: async (opts) => {
      log(
        `[helm-runner:stub] removeInstance ns=${opts.namespace} gatewayId=${opts.gatewayId} — no exec`,
      );
    },
    listPendingReleases: async ({ namespace }) => {
      log(`[helm-runner:stub] listPendingReleases ns=${namespace} — returning none`);
      return [];
    },
    recoverRelease: async ({ namespace, gatewayId }) => {
      log(
        `[helm-runner:stub] recoverRelease ns=${namespace} gatewayId=${gatewayId} — no exec`,
      );
      return "no-op (stub)";
    },
  };
}
