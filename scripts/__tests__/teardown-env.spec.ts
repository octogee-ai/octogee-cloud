import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { TEST_TARGET } from "./fixtures/deployment.js";
import { scriptsTreeWith } from "./fixtures/scripts-tree.js";

const repoRoot = path.resolve(__dirname, "../..");
const teardown = path.join(repoRoot, "scripts/teardown-env.sh");

function executable(file: string, source: string): void {
  writeFileSync(file, source);
  chmodSync(file, 0o755);
}

type TeardownOptions = {
  databaseFailure?: "inspect" | "delete" | "create" | "verify-command" | "verify-value";
  databaseOwner?: "mattermost" | "gitea" | "cloudsqlsuperuser" | "unexpected";
  sqlOwnerJobFailure?: boolean;
  agentStoreJobFailure?: boolean;
  sqlOwnerJobFailed?: boolean;
  agentStoreReportedDatabase?: string;
  platformDatabaseFailure?: "delete" | "create" | "verify";
  publicIp?: boolean;
  pvcFailure?: "inspect" | "delete" | "finalize";
  secretFailure?: "absent" | "error";
  storageFailure?: boolean;
  storageDescribeFailure?: boolean;
  firebaseProbeFailure?: boolean;
  sqlWritersAbsent?: boolean;
  platformWritersAbsent?: boolean;
  resume?: boolean;
  storageListFailure?: boolean;
  storageEmpty?: boolean;
  storageResidual?: boolean;
  functionListFailure?: boolean;
  functionDeleteFailure?: boolean;
  functions?: Array<{ name: string; generation: "GEN_1" | "GEN_2" }>;
  functionInventory?: string;
  giteaWorkloadName?: "gitea" | "octogee-gitea";
  full?: boolean;
  gatewayRuntimeFailure?:
    | "serviceaccount-inspect"
    | "serviceaccount-delete"
    | "serviceaccount-residual"
    | "secret-inspect"
    | "secret-delete"
    | "secret-residual";
  gatewayHelmFailure?:
    | "list"
    | "uninstall"
    | "residual"
    | "appears-after-empty"
    | "paginated";
  gatewayControllerFailure?: "inspect" | "scale" | "pods";
  interactiveInput?: string;
  envExtension?: string;
};

function runPrivateCentralTeardown(options: TeardownOptions = {}) {
  const temp = mkdtempSync(path.join(tmpdir(), "octogee-teardown-private-central-"));
  const log = path.join(temp, "calls.log");
  const describeCount = path.join(temp, "describe-count");
  const deletedPvcs = path.join(temp, "deleted-pvcs");
  const quiescedSqlWriters = path.join(temp, "quiesced-sql-writers");
  const deletedGatewayResources = path.join(temp, "deleted-gateway-resources");
  const deletedGiteaCredentials = path.join(temp, "deleted-gitea-credentials");
  const uninstalledGatewayReleases = path.join(temp, "uninstalled-gateway-releases");
  const helmListCount = path.join(temp, "helm-list-count");
  const storageRemoved = path.join(temp, "storage-removed");
  const sqlOwnerManifest = path.join(temp, "sql-owner-manifest.yaml");
  const platformDatabaseState = path.join(temp, "platform-database-state");
  const laptopServiceAccountKey = path.join(temp, ".openclaw", "secrets", `${TEST_TARGET.firebaseProjectId}-sa-key.json`);
  writeFileSync(log, "");
  writeFileSync(describeCount, "0");
  writeFileSync(deletedPvcs, "");
  writeFileSync(quiescedSqlWriters, "");
  writeFileSync(deletedGatewayResources, "");
  writeFileSync(deletedGiteaCredentials, "");
  writeFileSync(uninstalledGatewayReleases, "");
  writeFileSync(helmListCount, "0");
  writeFileSync(sqlOwnerManifest, "");
  writeFileSync(platformDatabaseState, "present");
  mkdirSync(path.dirname(laptopServiceAccountKey), { recursive: true });
  writeFileSync(laptopServiceAccountKey, `{"type":"service_account","project_id":"${TEST_TARGET.firebaseProjectId}"}`);

  executable(path.join(temp, "gcloud"), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_CALL_LOG"
if [[ "$1 $2" == "sql databases" && "$*" == *"--instance=$FAKE_PLATFORM_STATE_INSTANCE "* ]]; then
  [[ "$4" == platform ]] || { printf 'unexpected platform state database %s\\n' "$4" >&2; exit 2; }
  case "$3" in
    delete)
      [[ "$FAKE_PLATFORM_DATABASE_FAILURE" != "delete" ]] || { printf 'database is being accessed by other users\\n' >&2; exit 1; }
      printf 'absent' > "$FAKE_PLATFORM_DATABASE_STATE"
      ;;
    create)
      [[ "$FAKE_PLATFORM_DATABASE_FAILURE" != "create" ]] || { printf 'create failed\\n' >&2; exit 1; }
      printf 'recreated' > "$FAKE_PLATFORM_DATABASE_STATE"
      ;;
    describe)
      state="$(cat "$FAKE_PLATFORM_DATABASE_STATE")"
      [[ "$state" != absent ]] || { printf 'NOT_FOUND: database was not found\\n' >&2; exit 1; }
      if [[ "$state" == recreated && "$FAKE_PLATFORM_DATABASE_FAILURE" == "verify" ]]; then
        printf 'other\\n'
      else
        printf 'platform\\n'
      fi
      ;;
    *) printf 'unexpected platform state database call: %s\\n' "$*" >&2; exit 2 ;;
  esac
  exit 0
fi
case "$1 $2 $3" in
  "container clusters get-credentials") ;;
  "secrets versions access")
    case "$FAKE_SECRET_FAILURE" in
      absent) printf 'NOT_FOUND: secret does not exist\\n' >&2; exit 1 ;;
      error) printf 'PERMISSION_DENIED\\n' >&2; exit 2 ;;
      *) printf 'retained-password' ;;
    esac
    ;;
  "secrets describe "*)
    if grep -Fxq "secret-manager:$3" "$FAKE_DELETED_GITEA_CREDENTIALS"; then
      printf 'NOT_FOUND: secret does not exist\\n' >&2
      exit 1
    fi
    printf '%s\\n' "$3"
    ;;
  "secrets delete "*)
    printf 'secret-manager:%s\\n' "$3" >> "$FAKE_DELETED_GITEA_CREDENTIALS"
    ;;
  "sql instances describe")
    if [[ "$FAKE_PUBLIC_IP" == "true" ]]; then
      printf 'PRIMARY\\n'
    else
      printf '%s\\n' '{"ipAddresses":[{"type":"PRIVATE","ipAddress":"10.0.0.4"}]}'
    fi
    ;;
  "sql databases delete")
    [[ "$FAKE_DATABASE_FAILURE" != "delete" ]]
    ;;
  "sql databases create")
    [[ "$FAKE_DATABASE_FAILURE" != "create" ]]
    ;;
  "sql databases describe")
    if [[ "$4" == "$FAKE_AGENT_STORE_DATABASE" ]]; then
      printf '%s\\n' "$4"
      exit 0
    fi
    count="$(cat "$FAKE_DESCRIBE_COUNT")"
    count=$((count + 1))
    printf '%s' "$count" > "$FAKE_DESCRIBE_COUNT"
    if [[ "$FAKE_DATABASE_FAILURE" == "inspect" && "$count" == "1" ]]; then
      printf 'PERMISSION_DENIED\\n' >&2
      exit 2
    fi
    if [[ "$FAKE_DATABASE_FAILURE" == "verify-command" && "$count" == "2" ]]; then
      printf 'verification unavailable\\n' >&2
      exit 2
    fi
    if [[ "$FAKE_DATABASE_FAILURE" == "verify-value" && "$count" == "2" ]]; then
      printf 'wrong_database\\n'
    else
      printf '%s\\n' "$4"
    fi
    ;;
  "secrets list "*) ;;
  "functions list "*)
    if [[ "$FAKE_FUNCTION_LIST_FAILURE" == "true" ]]; then
      printf 'PERMISSION_DENIED\\n' >&2
      exit 2
    fi
    printf '%b' "$FAKE_FUNCTION_INVENTORY"
    ;;
  "functions delete "*) [[ "$FAKE_FUNCTION_DELETE_FAILURE" != "true" ]] ;;
  "storage buckets describe")
    [[ "$FAKE_STORAGE_DESCRIBE_FAILURE" != "true" ]] || {
      printf "ERROR: gcloud crashed (CommandLoadFailure): Problem loading gcloud.storage.buckets.describe\\n" >&2
      exit 1
    }
    ;;
  "storage ls --all-versions")
    if [[ "$FAKE_STORAGE_LIST_FAILURE" == "true" ]]; then
      printf 'PERMISSION_DENIED\\n' >&2
      exit 2
    fi
    if [[ "$FAKE_STORAGE_EMPTY" == "true" ]]; then
      printf 'ERROR: (gcloud.storage.ls) One or more URLs matched no objects.\\n' >&2
      exit 1
    fi
    if [[ "$FAKE_STORAGE_RESIDUAL" == "true" || ! -f "$FAKE_STORAGE_REMOVED" ]]; then
      printf 'gs://octogee-data-test.firebasestorage.app/nested/object.txt#2\\n'
      printf 'gs://octogee-data-test.firebasestorage.app/nested/object.txt#1\\n'
    else
      printf 'ERROR: (gcloud.storage.ls) One or more URLs matched no objects.\\n' >&2
      exit 1
    fi
    ;;
  "storage rm --all-versions")
    [[ "$FAKE_STORAGE_FAILURE" != "true" ]] || exit 1
    : > "$FAKE_STORAGE_REMOVED"
    ;;
  *) printf 'unexpected gcloud call: %s\\n' "$*" >&2; exit 2 ;;
esac
`);

  executable(path.join(temp, "kubectl"), `#!/usr/bin/env bash
set -euo pipefail
printf 'kubectl %s\\n' "$*" >> "$FAKE_CALL_LOG"
case "$1 $2" in
  "config use-context") ;;
  "config current-context") printf '${TEST_TARGET.kubeContext}\\n' ;;
  "get serviceaccount") printf 'octogee-api@octogee.iam.gserviceaccount.com\\n' ;;
  "get serviceaccounts")
    [[ "$FAKE_GATEWAY_RUNTIME_FAILURE" != "serviceaccount-inspect" ]] || {
      printf 'serviceaccounts is forbidden\\n' >&2
      exit 1
    }
    printf 'default\\n'
    printf 'octogee-api\\n'
    for serviceaccount in octogee-gw-default octogee-gw-builder-one; do
      if [[ "$FAKE_GATEWAY_RUNTIME_FAILURE" == "serviceaccount-residual" ]] \
        || ! grep -Fxq "serviceaccount:$serviceaccount" "$FAKE_DELETED_GATEWAY_RESOURCES"; then
        printf '%s\\n' "$serviceaccount"
      fi
    done
    ;;
  "get secrets")
    [[ "$FAKE_GATEWAY_RUNTIME_FAILURE" != "secret-inspect" ]] || {
      printf 'secrets is forbidden\\n' >&2
      exit 1
    }
    printf 'gateway-model-key-issuer\\n'
    printf 'gitea-token\\n'
    for secret in gateway-auth-token-default gateway-auth-token-user-one gateway-model-key-user-one; do
      if [[ "$FAKE_GATEWAY_RUNTIME_FAILURE" == "secret-residual" ]] \
        || ! grep -Fxq "secret:$secret" "$FAKE_DELETED_GATEWAY_RESOURCES"; then
        printf '%s\\n' "$secret"
      fi
    done
    ;;
  "get secret")
    if [[ "$3" == "gitea-token" ]] \
      && ! grep -Fxq "kubernetes:gitea-token" "$FAKE_DELETED_GITEA_CREDENTIALS"; then
      printf 'gitea-token\\n'
    fi
    exit 0
    ;;
  "get deployment,statefulset")
    [[ "$FAKE_SQL_WRITERS_ABSENT" != "true" ]] || exit 0
    case "$*" in
      *"app=mattermost"*) printf 'deployment.apps/mattermost\\n' ;;
      *"app.kubernetes.io/name=gitea"*) printf 'deployment.apps/%s\\n' "$FAKE_GITEA_WORKLOAD_NAME" ;;
    esac
    ;;
  "get deployment")
    [[ "$FAKE_PLATFORM_WRITERS_ABSENT" != "true" ]] || exit 0
    printf 'deployment.apps/octogee-api\\n'
    printf 'deployment.apps/llm-broker\\n'
    ;;
  "get cronjob") printf 'cronjob.batch/platform-state-expiry\\n' ;;
  "get job/"*)
    if [[ "$2" == job/octogee-agent-store-reset-* && "$FAKE_AGENT_STORE_JOB_FAILURE" == "true" ]] \\
      || [[ "$2" != job/octogee-agent-store-reset-* && "$FAKE_SQL_OWNER_JOB_FAILED" == "true" ]]; then
      printf 'FailureTarget Failed '
    else
      printf 'Complete '
    fi
    ;;
  "get deployment/glm-controller")
    [[ "$FAKE_GATEWAY_CONTROLLER_FAILURE" != "inspect" ]] || {
      printf 'glm-controller deployment is forbidden\\n' >&2
      exit 1
    }
    printf 'deployment.apps/glm-controller\\n'
    ;;
  "get pods")
    if [[ "$*" == *"app=glm-controller"* && "$FAKE_GATEWAY_CONTROLLER_FAILURE" == "pods" ]]; then
      printf 'glm-controller pods are forbidden\\n' >&2
      exit 1
    fi
    if [[ "$*" == *"app.kubernetes.io/name=gitea"* ]] \\
      && ! grep -Fxq "deployment/$FAKE_GITEA_WORKLOAD_NAME" "$FAKE_QUIESCED_SQL_WRITERS"; then
      printf 'pod/%s-abc123\\n' "$FAKE_GITEA_WORKLOAD_NAME"
    fi
    ;;
  "get endpoints") printf '10.0.0.4\\n' ;;
  "scale deployment/glm-controller")
    [[ "$FAKE_GATEWAY_CONTROLLER_FAILURE" != "scale" ]] || {
      printf 'glm-controller scale is forbidden\\n' >&2
      exit 1
    }
    ;;
  "scale deployment/"*|"scale statefulset/"*)
    printf '%s\\n' "$2" >> "$FAKE_QUIESCED_SQL_WRITERS"
    ;;
  "apply -f") cat >> "$FAKE_SQL_OWNER_MANIFEST" ;;
  "logs job/"*)
    if [[ "$2" == job/octogee-agent-store-reset-* ]]; then
      printf 'OCTOGEE_AGENT_STORE_RESET=%s\\n' "$FAKE_AGENT_STORE_REPORTED_DATABASE"
      exit 0
    fi
    if [[ "$FAKE_SQL_OWNER_JOB_FAILURE" == "true" ]]; then
      printf 'owner query failed\\n' >&2
      exit 1
    fi
    case "$2" in
      *mattermost*)
        owner="$FAKE_DATABASE_OWNER_MATTERMOST"
        if [[ "$owner" == cloudsqlsuperuser ]] && grep -q '^sql databases delete mattermost_test ' "$FAKE_CALL_LOG"; then owner=mattermost; fi
        printf 'OCTOGEE_DATABASE_OWNER=%s\\n' "$owner"
        ;;
      *gitea*)
        owner="$FAKE_DATABASE_OWNER_GITEA"
        if [[ "$owner" == cloudsqlsuperuser ]] && grep -q '^sql databases delete gitea_test ' "$FAKE_CALL_LOG"; then owner=gitea; fi
        printf 'OCTOGEE_DATABASE_OWNER=%s\\n' "$owner"
        ;;
      *) printf 'unexpected SQL owner job %s\\n' "$2" >&2; exit 2 ;;
    esac
    ;;
  "delete job") ;;
  "delete serviceaccount")
    [[ "$FAKE_GATEWAY_RUNTIME_FAILURE" != "serviceaccount-delete" ]] || {
      printf 'serviceaccount delete forbidden\\n' >&2
      exit 1
    }
    printf 'serviceaccount:%s\\n' "$3" >> "$FAKE_DELETED_GATEWAY_RESOURCES"
    ;;
  "delete secret")
    [[ "$FAKE_GATEWAY_RUNTIME_FAILURE" != "secret-delete" ]] || {
      printf 'secret delete forbidden\\n' >&2
      exit 1
    }
    printf 'secret:%s\\n' "$3" >> "$FAKE_DELETED_GATEWAY_RESOURCES"
    if [[ "$3" == "gitea-token" ]]; then
      printf 'kubernetes:gitea-token\\n' >> "$FAKE_DELETED_GITEA_CREDENTIALS"
    fi
    ;;
  "get pvc")
    pvc="$3"
    if [[ "$FAKE_PVC_FAILURE" == "inspect" && "$pvc" == "gitea-shared-storage" ]]; then
      printf 'persistentvolumeclaims is forbidden\\n' >&2
      exit 2
    fi
    if grep -Fxq "finalized:$pvc" "$FAKE_DELETED_PVCS"; then
      exit 0
    fi
    printf 'persistentvolumeclaim/%s\\n' "$pvc"
    ;;
  "delete pvc")
    pvc="$3"
    if [[ "$FAKE_PVC_FAILURE" == "delete" && "$pvc" == "gitea-shared-storage" ]]; then
      printf 'delete forbidden\\n' >&2
      exit 1
    fi
    printf 'deleted:%s\\n' "$pvc" >> "$FAKE_DELETED_PVCS"
    ;;
  "wait --for=delete")
    if [[ "$*" == *"app.kubernetes.io/name=gitea"* ]] \\
      && ! grep -Fxq "deployment/$FAKE_GITEA_WORKLOAD_NAME" "$FAKE_QUIESCED_SQL_WRITERS"; then
      printf 'gitea pod still running\\n' >&2
      exit 1
    fi
    if [[ "$FAKE_PVC_FAILURE" == "finalize" && "$3" == "pvc/mattermost-data" ]]; then
      printf 'timed out waiting for PVC deletion\\n' >&2
      exit 1
    fi
    printf 'finalized:%s\\n' "\${3#pvc/}" >> "$FAKE_DELETED_PVCS"
    ;;
  *) ;;
esac
`);

  executable(path.join(temp, "helm"), `#!/usr/bin/env bash
set -euo pipefail
printf 'helm %s\\n' "$*" >> "$FAKE_CALL_LOG"
case "$1" in
  status) exit 1 ;;
  list)
    count="$(cat "$FAKE_HELM_LIST_COUNT")"
    count=$((count + 1))
    printf '%s' "$count" > "$FAKE_HELM_LIST_COUNT"
    [[ "$FAKE_GATEWAY_HELM_FAILURE" != "list" ]] || {
      printf 'helm list forbidden\\n' >&2
      exit 1
    }
    if [[ "$FAKE_GATEWAY_HELM_FAILURE" == "paginated" ]]; then
      offset=0
      previous=""
      for argument in "$@"; do
        if [[ "$previous" == "--offset" ]]; then offset="$argument"; fi
        previous="$argument"
      done
      emitted=0
      for index in $(seq $((offset + 1)) 257); do
        release="$(printf 'octogee-gw-page-%03d' "$index")"
        if ! grep -Fxq "$release" "$FAKE_UNINSTALLED_GATEWAY_RELEASES"; then
          printf '%s\\n' "$release"
          emitted=$((emitted + 1))
          [[ "$emitted" -lt 256 ]] || break
        fi
      done
      exit 0
    fi
    if [[ "$FAKE_GATEWAY_HELM_FAILURE" == "appears-after-empty" ]]; then
      [[ "$count" == 1 ]] || printf 'octogee-gw-stale\\n'
      exit 0
    fi
    if [[ "$FAKE_GATEWAY_HELM_FAILURE" == "residual" ]] \
      || ! grep -Fxq 'octogee-gw-stale' "$FAKE_UNINSTALLED_GATEWAY_RELEASES"; then
      printf 'octogee-gw-stale\\n'
    fi
    ;;
  uninstall)
    if [[ "$2" == octogee-gw-* ]]; then
      [[ "$FAKE_GATEWAY_HELM_FAILURE" != "uninstall" ]] || {
        printf 'gateway uninstall failed\\n' >&2
        exit 1
      }
      printf '%s\\n' "$2" >> "$FAKE_UNINSTALLED_GATEWAY_RELEASES"
    fi
    ;;
esac
`);
  executable(path.join(temp, "cloud-sql-proxy"), "#!/usr/bin/env bash\nset -euo pipefail\nsleep 300\n");
  executable(path.join(temp, "lsof"), "#!/usr/bin/env bash\nset -euo pipefail\nexit 1\n");
  executable(path.join(temp, "nc"), "#!/usr/bin/env bash\nset -euo pipefail\n");
  executable(path.join(temp, "psql"), "#!/usr/bin/env bash\nset -euo pipefail\necho 'connection to server failed: Connection refused' >&2\nexit 1\n");
  executable(path.join(temp, "firebase"), `#!/usr/bin/env bash
set -euo pipefail
printf 'firebase %s\\n' "$*" >> "$FAKE_CALL_LOG"
if [[ "$FAKE_FIREBASE_PROBE_FAILURE" == "true" && "$1" == "firestore:databases:get" ]]; then
  printf 'Authentication Error: Your credentials are no longer valid.\\n' >&2
  exit 1
fi
`);
  executable(path.join(temp, "npx"), "#!/usr/bin/env bash\nset -euo pipefail\nprintf 'npx %s\\n' \"$*\" >> \"$FAKE_CALL_LOG\"\n");

  const root = options.envExtension === undefined
    ? repoRoot
    : scriptsTreeWith({ "fixture-extension": { "env.sh": options.envExtension } }, temp);
  const args = [path.join(root, "scripts/teardown-env.sh"), "--env=test", "--deployment-target=test-central"];
  if (options.full ?? true) args.push("--full");
  if (!options.interactiveInput) args.push("--yes");
  if (options.resume) args.push("--resume");
  const result = spawnSync("bash", args, {
    cwd: root,
    env: {
      ...process.env,
      HOME: temp,
      SA_KEY_PATH: laptopServiceAccountKey,
      PATH: `${temp}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      FAKE_CALL_LOG: log,
      FAKE_DATABASE_FAILURE: options.databaseFailure ?? "",
      FAKE_AGENT_STORE_DATABASE: TEST_TARGET.cloudSqlAgentStoreDatabaseName,
      FAKE_DESCRIBE_COUNT: describeCount,
      FAKE_DELETED_PVCS: deletedPvcs,
      FAKE_QUIESCED_SQL_WRITERS: quiescedSqlWriters,
      FAKE_DELETED_GATEWAY_RESOURCES: deletedGatewayResources,
      FAKE_DELETED_GITEA_CREDENTIALS: deletedGiteaCredentials,
      FAKE_GATEWAY_RUNTIME_FAILURE: options.gatewayRuntimeFailure ?? "",
      FAKE_GATEWAY_HELM_FAILURE: options.gatewayHelmFailure ?? "",
      FAKE_GATEWAY_CONTROLLER_FAILURE: options.gatewayControllerFailure ?? "",
      FAKE_HELM_LIST_COUNT: helmListCount,
      FAKE_UNINSTALLED_GATEWAY_RELEASES: uninstalledGatewayReleases,
      FAKE_PUBLIC_IP: options.publicIp ? "true" : "false",
      FAKE_PVC_FAILURE: options.pvcFailure ?? "",
      FAKE_SECRET_FAILURE: options.secretFailure ?? "",
      FAKE_STORAGE_FAILURE: options.storageFailure ? "true" : "false",
      FAKE_STORAGE_DESCRIBE_FAILURE: options.storageDescribeFailure ? "true" : "false",
      FAKE_FIREBASE_PROBE_FAILURE: options.firebaseProbeFailure ? "true" : "false",
      FAKE_SQL_WRITERS_ABSENT: options.sqlWritersAbsent ? "true" : "false",
      FAKE_PLATFORM_WRITERS_ABSENT: options.platformWritersAbsent ? "true" : "false",
      FAKE_STORAGE_LIST_FAILURE: options.storageListFailure ? "true" : "false",
      FAKE_STORAGE_EMPTY: options.storageEmpty ? "true" : "false",
      FAKE_STORAGE_RESIDUAL: options.storageResidual ? "true" : "false",
      FAKE_STORAGE_REMOVED: storageRemoved,
      FAKE_SQL_OWNER_MANIFEST: sqlOwnerManifest,
      FAKE_SQL_OWNER_JOB_FAILURE: options.sqlOwnerJobFailure ? "true" : "false",
      FAKE_AGENT_STORE_JOB_FAILURE: options.agentStoreJobFailure ? "true" : "false",
      FAKE_SQL_OWNER_JOB_FAILED: options.sqlOwnerJobFailed ? "true" : "false",
      FAKE_AGENT_STORE_REPORTED_DATABASE: options.agentStoreReportedDatabase ?? TEST_TARGET.cloudSqlAgentStoreDatabaseName,
      FAKE_PLATFORM_DATABASE_FAILURE: options.platformDatabaseFailure ?? "",
      FAKE_PLATFORM_DATABASE_STATE: platformDatabaseState,
      FAKE_PLATFORM_STATE_INSTANCE: TEST_TARGET.cloudSqlPlatformStateInstanceName,
      FAKE_DATABASE_OWNER_MATTERMOST: options.databaseOwner === "unexpected" ? "legacy-owner" : options.databaseOwner ?? "mattermost",
      FAKE_DATABASE_OWNER_GITEA: options.databaseOwner === "unexpected" ? "legacy-owner" : options.databaseOwner ?? "gitea",
      FAKE_FUNCTION_LIST_FAILURE: options.functionListFailure ? "true" : "false",
      FAKE_FUNCTION_DELETE_FAILURE: options.functionDeleteFailure ? "true" : "false",
      FAKE_FUNCTION_INVENTORY: options.functionInventory
        ?? `${(options.functions ?? []).map(({ name, generation }) => `${name},${generation}`).join("\n")}${options.functions?.length ? "\n" : ""}`,
      FAKE_GITEA_WORKLOAD_NAME: options.giteaWorkloadName ?? "octogee-gitea",
    },
    input: options.interactiveInput,
    encoding: "utf8",
  });

  return {
    ...result,
    calls: readFileSync(log, "utf8").trim().split("\n").filter(Boolean),
    sqlOwnerManifest: readFileSync(sqlOwnerManifest, "utf8"),
  };
}

function resetOwnerScript(manifest: string): string {
  const resetOwner = manifest.indexOf("      containers:\n        - name: reset-owner\n");
  if (resetOwner < 0) throw new Error("reset-owner container is missing from private SQL owner manifest");
  const args = manifest.indexOf("          args:\n            - |\n", resetOwner);
  if (args < 0) throw new Error("reset-owner script is missing from private SQL owner manifest");
  const start = args + "          args:\n            - |\n".length;
  const end = manifest.indexOf("\n          env:\n", start);
  if (end < 0) throw new Error("reset-owner script has no env boundary in private SQL owner manifest");
  return manifest.slice(start, end).split("\n").map((line) => line.startsWith("              ")
    ? line.slice("              ".length)
    : line).join("\n");
}

function agentStoreJobManifest(manifest: string): string {
  const marker = manifest.indexOf("octogee.ai/reset: agent-store");
  expect(marker).toBeGreaterThan(-1);
  const start = manifest.lastIndexOf("apiVersion:", marker);
  const end = manifest.indexOf("apiVersion:", marker);
  return manifest.slice(start, end === -1 ? undefined : end);
}

function agentStoreResetScript(manifest: string): string {
  const container = manifest.indexOf("      containers:\n        - name: reset-agent-store\n");
  if (container < 0) throw new Error("reset-agent-store container is missing from the agent store reset manifest");
  const args = manifest.indexOf("          args:\n            - |\n", container);
  if (args < 0) throw new Error("reset-agent-store script is missing from the agent store reset manifest");
  const start = args + "          args:\n            - |\n".length;
  const end = manifest.indexOf("\n          env:\n", start);
  if (end < 0) throw new Error("reset-agent-store script has no env boundary in the agent store reset manifest");
  return manifest.slice(start, end).split("\n").map((line) => line.startsWith("              ")
    ? line.slice("              ".length)
    : line).join("\n");
}

function runAgentStoreResetScript(script: string, adminDsn: string) {
  const temp = mkdtempSync(path.join(tmpdir(), "octogee-agent-store-reset-"));
  const psqlCalls = path.join(temp, "psql-calls");
  writeFileSync(psqlCalls, "");
  executable(path.join(temp, "pg_isready"), "#!/bin/sh\nexit 0\n");
  executable(path.join(temp, "psql"), `#!/bin/sh\nfor argument in "$@"; do printf '%s\\n' "$argument" >> "${psqlCalls}"; done\n`);
  const result = spawnSync("sh", ["-ceu", script], {
    env: {
      PATH: `${temp}:/usr/bin:/bin`,
      AGENT_STORE_ADMIN_DSN: adminDsn,
      AGENT_STORE_DATABASE: TEST_TARGET.cloudSqlAgentStoreDatabaseName,
    },
    encoding: "utf8",
  });
  return { ...result, psqlArguments: readFileSync(psqlCalls, "utf8").trim().split("\n").filter(Boolean) };
}

function expectGiteaTokenMaterialPreserved(calls: string[]): void {
  expect(calls.some((call) => call.includes("delete secret gitea-token"))).toBe(false);
  expect(calls.some((call) => call.includes("secrets delete gitea-api-token"))).toBe(false);
}

describe("full teardown for private-only Cloud SQL", { timeout: 180_000 }, () => {
  it("quiesces the exact target Gitea deployment before the private SQL owner reset", () => {
    const result = runPrivateCentralTeardown({ giteaWorkloadName: "octogee-gitea" });

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(result.calls).toContain(
      `kubectl scale deployment/octogee-gitea -n ${TEST_TARGET.namespace} --context ${TEST_TARGET.kubeContext} --replicas=0`,
    );
  });

  it("uses one JSONPath escape per Workload Identity annotation dot", () => {
    const source = readFileSync(teardown, "utf8");

    expect(source).toContain("jsonpath='{.metadata.annotations.iam\\.gke\\.io/gcp-service-account}'");
    expect(source).not.toContain("jsonpath='{.metadata.annotations.iam\\\\.gke\\\\.io/gcp-service-account}'");
  });

  it("feeds private owner SQL through stdin so psql expands database variables", () => {
    const result = runPrivateCentralTeardown({ giteaWorkloadName: "octogee-gitea" });

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(result.sqlOwnerManifest).toContain("printf '%s\\n'");
    expect(result.sqlOwnerManifest).toContain('-v database="$database"');
    expect(result.sqlOwnerManifest).toContain('WHERE datname = :\'database\'');
    expect(result.sqlOwnerManifest).toContain('CREATE DATABASE :"database";');
    expect(result.sqlOwnerManifest).toContain('DROP DATABASE :"database";');
    expect(result.sqlOwnerManifest).not.toContain("-v database='mattermost_test' -c");
    expect(result.sqlOwnerManifest).not.toContain("-v database='gitea_test' -c");
  });

  it("uses a native Cloud SQL proxy sidecar that terminates when the owner reset completes", () => {
    const result = runPrivateCentralTeardown({ giteaWorkloadName: "octogee-gitea" });

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(result.sqlOwnerManifest).toContain("initContainers:\n        - name: cloud-sql-proxy");
    expect(result.sqlOwnerManifest).toContain("restartPolicy: Always");
    expect(result.sqlOwnerManifest).toContain("containers:\n        - name: reset-owner");
  });

  it("generates a shell-valid reset-owner script without nested SQL heredocs", () => {
    const result = runPrivateCentralTeardown({ giteaWorkloadName: "octogee-gitea" });
    const script = resetOwnerScript(result.sqlOwnerManifest);
    const syntax = spawnSync("sh", ["-n"], { input: script, encoding: "utf8" });

    expect(syntax.status, `${syntax.stderr}\n${script}`).toBe(0);
    expect(script).not.toContain("<<");
    expect(script).toContain("printf '%s\\n'");
  });

  it("drops app-owned private databases through an exact-target in-cluster owner job before API recreation", () => {
    const result = runPrivateCentralTeardown();

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(result.calls).toContainEqual(expect.stringContaining("kubectl scale deployment/mattermost"));
    expect(result.calls).toContainEqual(expect.stringContaining("kubectl get serviceaccount octogee-api"));
    expect(result.calls).toContainEqual(expect.stringContaining("kubectl apply -f -"));
    expect(result.calls).not.toContainEqual(expect.stringContaining("sql databases delete mattermost_test"));
    expect(result.calls).not.toContainEqual(expect.stringContaining("sql databases delete gitea_test"));
    expect(result.calls).not.toContainEqual(expect.stringContaining("sql databases create mattermost_test"));
    expect(result.calls).not.toContainEqual(expect.stringContaining("sql databases create gitea_test"));
    expect(result.sqlOwnerManifest).toContain("name: mattermost-cloud-sql");
    expect(result.sqlOwnerManifest).toContain("name: gitea-credentials");
    expect(result.sqlOwnerManifest).toContain("cloud-sql-proxy");
    expect(result.sqlOwnerManifest).toContain("mattermost_test");
    expect(result.sqlOwnerManifest).toContain("gitea_test");
    expect(result.sqlOwnerManifest).toContain('CREATE DATABASE :"database";');
  });

  it("removes only exact-target dynamic gateway identities and secrets during a full reset", () => {
    const result = runPrivateCentralTeardown();

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    for (const name of ["octogee-gw-default", "octogee-gw-builder-one"]) {
      expect(result.calls).toContain(
        `kubectl delete serviceaccount ${name} -n ${TEST_TARGET.namespace} --context ${TEST_TARGET.kubeContext} --wait=true`,
      );
    }
    for (const name of [
      "gateway-auth-token-default",
      "gateway-auth-token-user-one",
      "gateway-model-key-user-one",
    ]) {
      expect(result.calls).toContain(
        `kubectl delete secret ${name} -n ${TEST_TARGET.namespace} --context ${TEST_TARGET.kubeContext} --wait=true`,
      );
    }
    expect(result.calls).not.toContainEqual(
      expect.stringContaining("delete secret gateway-model-key-issuer"),
    );
    expect(result.calls).not.toContainEqual(
      expect.stringContaining("delete serviceaccount octogee-api"),
    );
    expect(result.calls).not.toContainEqual(
      expect.stringContaining("delete serviceaccount default"),
    );
    expect(result.stdout).toContain("Dynamic gateway runtime identities confirmed absent");
    expect(result.calls).toContain(
      `kubectl scale deployment/glm-controller -n ${TEST_TARGET.namespace} --context ${TEST_TARGET.kubeContext} --replicas=0`,
    );
  });

  it("removes database-bound Gitea token material before resetting the Gitea database", () => {
    const result = runPrivateCentralTeardown();

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    const kubernetesDelete = result.calls.indexOf(
      `kubectl delete secret gitea-token -n ${TEST_TARGET.namespace} --context ${TEST_TARGET.kubeContext} --ignore-not-found=true --wait=true`,
    );
    const secretManagerDelete = result.calls.indexOf(
      `secrets delete gitea-api-token-test --project=${TEST_TARGET.firebaseProjectId} --quiet`,
    );
    const databaseResets = result.calls
      .map((call, index) => call.includes("kubectl apply -f -") ? index : -1)
      .filter((index) => index >= 0);
    const controllerQuiescence = result.calls.indexOf(
      `kubectl scale deployment/glm-controller -n ${TEST_TARGET.namespace} --context ${TEST_TARGET.kubeContext} --replicas=0`,
    );
    const gatewayHelmRemoval = result.calls.findIndex((call) =>
      call.startsWith("helm uninstall octogee-gw-stale "),
    );
    const runtimeIdentityRemoval = result.calls.indexOf(
      `kubectl delete secret gateway-model-key-user-one -n ${TEST_TARGET.namespace} --context ${TEST_TARGET.kubeContext} --wait=true`,
    );

    expect(kubernetesDelete).toBeGreaterThan(-1);
    expect(secretManagerDelete).toBeGreaterThan(-1);
    expect(databaseResets).toHaveLength(3);
    const [, mattermostReset, giteaReset] = databaseResets;
    expect(kubernetesDelete).toBeGreaterThan(controllerQuiescence);
    expect(kubernetesDelete).toBeGreaterThan(gatewayHelmRemoval);
    expect(kubernetesDelete).toBeGreaterThan(runtimeIdentityRemoval);
    expect(kubernetesDelete).toBeGreaterThan(mattermostReset);
    expect(secretManagerDelete).toBeGreaterThan(mattermostReset);
    expect(giteaReset).toBeGreaterThan(secretManagerDelete);
    expect(giteaReset).toBeGreaterThan(kubernetesDelete);
  });

  it("resets the platform state and agent store databases after quiescing every writer and before Mattermost and Gitea", () => {
    const result = runPrivateCentralTeardown();
    const call = (text: string) => result.calls.indexOf(text);
    const scoped = `-n ${TEST_TARGET.namespace} --context ${TEST_TARGET.kubeContext}`;
    const platformInstance = `--instance=${TEST_TARGET.cloudSqlPlatformStateInstanceName} --project=${TEST_TARGET.cloudSqlProjectId}`;

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    const controller = call(`kubectl scale deployment/glm-controller ${scoped} --replicas=0`);
    const gateways = result.calls.findIndex((entry) => entry.startsWith("helm uninstall octogee-gw-stale "));
    const api = call(`kubectl scale deployment/octogee-api ${scoped} --replicas=0`);
    const broker = call(`kubectl scale deployment/llm-broker ${scoped} --replicas=0`);
    const expiry = call(`kubectl patch cronjob/platform-state-expiry ${scoped} --type=merge -p {"spec":{"suspend":true}}`);
    const platformJobs = call(`kubectl delete job ${scoped} -l app in (platform-state-expiry,platform-state-migrate) --ignore-not-found=true --wait=true`);
    const agentStore = result.calls.findIndex((entry) => entry.startsWith("kubectl create configmap octogee-agent-store-reset-"));
    const platformDelete = call(`sql databases delete platform ${platformInstance} --quiet`);
    const platformCreate = call(`sql databases create platform ${platformInstance} --quiet`);
    const mattermost = call(`kubectl scale deployment/mattermost ${scoped} --replicas=0`);
    for (const index of [controller, gateways, api, broker, expiry, platformJobs, agentStore, platformDelete, platformCreate, mattermost]) {
      expect(index).toBeGreaterThan(-1);
    }
    for (const writer of [controller, gateways, api, broker, expiry, platformJobs]) {
      expect(writer).toBeLessThan(agentStore);
      expect(writer).toBeLessThan(platformDelete);
    }
    expect(platformCreate).toBeGreaterThan(platformDelete);
    expect(mattermost).toBeGreaterThan(platformCreate);
    expect(mattermost).toBeGreaterThan(agentStore);
    expect(result.calls).toContainEqual(
      `sql databases describe ${TEST_TARGET.cloudSqlAgentStoreDatabaseName} --instance=${TEST_TARGET.cloudSqlInstanceName} --project=${TEST_TARGET.cloudSqlProjectId} --format=value(name)`,
    );
    expect(result.calls[agentStore]).toContain(`--from-file=agent-store-reset.sql=${repoRoot}/core/src/agent-store-reset.sql`);
    expect(result.sqlOwnerManifest).toContain("name: agent-store-postgres\n                  key: admin-dsn");
    expect(result.sqlOwnerManifest).toContain(`value: ${TEST_TARGET.cloudSqlAgentStoreDatabaseName}`);
    expect(result.sqlOwnerManifest).toContain(`- ${TEST_TARGET.cloudSqlConnectionName}`);
    expect(result.stdout).toContain(`${TEST_TARGET.cloudSqlAgentStoreDatabaseName} — agent store emptied`);
    expect(result.stdout).toContain("platform — Cloud SQL API confirmed a newly-created empty database");
    expect(agentStoreJobManifest(result.sqlOwnerManifest)).toContain("- --private-ip\n");
  });

  it("resets the platform state and agent store through the public route when the instance has a public IP", () => {
    const result = runPrivateCentralTeardown({ publicIp: true });

    expect(result.calls).toContainEqual(expect.stringContaining("sql databases delete platform"));
    expect(result.calls).toContainEqual(expect.stringContaining("sql databases create platform"));
    expect(agentStoreJobManifest(result.sqlOwnerManifest)).not.toContain("--private-ip");
  });

  it("resets the platform state and agent store again when a resumed public-IP teardown still has its platform", () => {
    const result = runPrivateCentralTeardown({ publicIp: true, resume: true });

    expect(result.calls).toContainEqual(expect.stringContaining("create configmap octogee-agent-store-reset-"));
    expect(result.calls).toContainEqual(expect.stringContaining("sql databases create platform"));
  });

  it("skips the platform state and agent store reset when a resumed public-IP teardown already removed its platform", () => {
    const result = runPrivateCentralTeardown({ publicIp: true, resume: true, platformWritersAbsent: true });

    expect(result.stdout).toContain("Resuming: an earlier full teardown reset the platform state and agent store databases");
    expect(result.calls.some((entry) => entry.startsWith("sql databases delete platform"))).toBe(false);
    expect(result.calls.some((entry) => entry.includes("create configmap octogee-agent-store-reset-"))).toBe(false);
  });

  it("refuses a public-IP full teardown whose platform is already gone unless resumed", () => {
    const result = runPrivateCentralTeardown({ publicIp: true, platformWritersAbsent: true });

    expect(result.status).toBe(1);
    expect(`${result.stderr}\n${result.stdout}`).toContain("octogee-api is not installed");
    expect(`${result.stderr}\n${result.stdout}`).toContain("rerun with --resume");
    expect(result.calls.some((entry) => entry.startsWith("sql databases delete platform"))).toBe(false);
    expect(result.calls.some((entry) => entry.startsWith("firebase firestore:delete"))).toBe(false);
  });

  it("lists the platform state and agent store databases among what a full teardown removes", () => {
    const full = runPrivateCentralTeardown();
    const helmOnly = runPrivateCentralTeardown({ full: false });
    const removal = (output: string) => output.slice(output.indexOf("Will remove:"), output.indexOf("Will preserve:"));

    expect(removal(full.stdout)).toContain(`platform on ${TEST_TARGET.cloudSqlPlatformStateInstanceName}`);
    expect(removal(full.stdout)).toContain(TEST_TARGET.cloudSqlAgentStoreDatabaseName);
    expect(removal(helmOnly.stdout)).not.toContain(TEST_TARGET.cloudSqlPlatformStateInstanceName);
    expect(removal(helmOnly.stdout)).not.toContain(TEST_TARGET.cloudSqlAgentStoreDatabaseName);
  });

  it("keeps the platform state and agent store databases on an ordinary Helm-only teardown", () => {
    const result = runPrivateCentralTeardown({ full: false });

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(result.calls.some((entry) => entry.startsWith("sql databases delete"))).toBe(false);
    expect(result.calls.some((entry) => entry.startsWith("sql databases create"))).toBe(false);
    expect(result.calls.some((entry) => entry.includes("create configmap octogee-agent-store-reset-"))).toBe(false);
    expect(result.calls.some((entry) => entry.includes("scale deployment/octogee-api"))).toBe(false);
    expect(result.calls.some((entry) => entry.includes("patch cronjob/platform-state-expiry"))).toBe(false);
  });

  it("stops before the platform state and Mattermost resets when the agent store reset fails", () => {
    const result = runPrivateCentralTeardown({ agentStoreJobFailure: true });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`agent store reset job failed for ${TEST_TARGET.cloudSqlAgentStoreDatabaseName}`);
    expect(result.calls).toContainEqual(expect.stringMatching(/^kubectl logs job\/octogee-agent-store-reset-\S+ .*--all-containers=true/));
    expect(result.calls.some((entry) => entry.startsWith("kubectl wait --for=condition=complete"))).toBe(false);
    expect(result.calls.some((entry) => entry.startsWith("sql databases delete platform"))).toBe(false);
    expect(result.calls.some((entry) => entry.includes("scale deployment/mattermost"))).toBe(false);
    expect(result.calls).toContainEqual(expect.stringMatching(/^kubectl delete configmap octogee-agent-store-reset-/));
  });

  it("refuses an agent store reset that reports a different database", () => {
    const result = runPrivateCentralTeardown({ agentStoreReportedDatabase: "octogee_agents_other" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`agent store reset reported 'octogee_agents_other' instead of ${TEST_TARGET.cloudSqlAgentStoreDatabaseName}`);
    expect(result.calls.some((entry) => entry.startsWith("sql databases delete platform"))).toBe(false);
  });

  it.each([
    ["delete", "Cloud SQL Admin API delete failed for platform"],
    ["create", "Cloud SQL Admin API create failed for platform"],
    ["verify", "Cloud SQL Admin API verification returned 'other' for platform"],
  ] as const)("stops before Mattermost when the platform state database %s fails", (platformDatabaseFailure, message) => {
    const result = runPrivateCentralTeardown({ platformDatabaseFailure });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
    expect(result.calls.some((entry) => entry.includes("scale deployment/mattermost"))).toBe(false);
    expect(result.calls.some((entry) => entry.startsWith("firebase firestore:delete"))).toBe(false);
  });

  it("connects the agent store reset through the proxy as the administrator its DSN names", () => {
    const result = runPrivateCentralTeardown();
    const script = agentStoreResetScript(result.sqlOwnerManifest);
    const reset = runAgentStoreResetScript(
      script,
      `postgresql://octogee_agent_controller_test:p%40ss@10.89.0.4:5432/${TEST_TARGET.cloudSqlAgentStoreDatabaseName}?sslmode=verify-ca&uselibpqcompat=true&sslrootcert=/etc/ssl/certs/octogee-postgres-ca.pem`,
    );

    expect(spawnSync("sh", ["-n"], { input: script, encoding: "utf8" }).status).toBe(0);
    expect(reset.status, reset.stderr).toBe(0);
    expect(reset.psqlArguments).toContain(
      `postgresql://octogee_agent_controller_test:p%40ss@127.0.0.1:5432/${TEST_TARGET.cloudSqlAgentStoreDatabaseName}`,
    );
    expect(reset.psqlArguments).toContain("/reset/agent-store-reset.sql");
  });

  it("refuses an agent store administrator DSN that selects another database", () => {
    const result = runPrivateCentralTeardown();
    const reset = runAgentStoreResetScript(
      agentStoreResetScript(result.sqlOwnerManifest),
      "postgresql://octogee_agent_controller_test:secret@10.89.0.4:5432/octogee_agents_prod?sslmode=require",
    );

    expect(reset.status).toBe(1);
    expect(reset.stderr).toContain(`agent-store admin DSN selects octogee_agents_prod, not ${TEST_TARGET.cloudSqlAgentStoreDatabaseName}`);
    expect(reset.psqlArguments).toEqual([]);
  });

  it("preserves dynamic gateway identities during the ordinary Helm-only teardown", () => {
    const result = runPrivateCentralTeardown({ full: false });

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(result.calls.some((call) => call.includes("get serviceaccounts"))).toBe(false);
    expect(result.calls.some((call) => call.includes("get secrets"))).toBe(false);
    expect(result.calls.some((call) => call.includes("delete serviceaccount"))).toBe(false);
    expect(result.calls.some((call) => call.includes("delete secret"))).toBe(false);
    expect(result.calls.some((call) => call.includes("secrets delete gitea-api-token"))).toBe(false);
  });

  it("pages a server-filtered gateway Helm inventory instead of trusting the 256-release default", () => {
    const source = readFileSync(teardown, "utf8");

    expect(source).toContain("--filter '^octogee-gw-'");
    expect(source).toContain('--max "$HELM_RELEASE_LIST_PAGE_SIZE"');
    expect(source).toContain('--offset "$offset"');
    expect(source).toContain("offset=$((offset + page_count))");
  });

  it("discovers and removes a gateway Helm release beyond the first 256 results", () => {
    const result = runPrivateCentralTeardown({ gatewayHelmFailure: "paginated" });

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(result.calls).toContainEqual(
      expect.stringMatching(/^helm list .*--max 256 --offset 256$/),
    );
    expect(result.calls).toContainEqual(
      expect.stringContaining("helm uninstall octogee-gw-page-257"),
    );
  });

  it.each([
    ["serviceaccount-inspect", "could not inspect dynamic gateway ServiceAccounts"],
    ["serviceaccount-delete", "could not delete dynamic gateway ServiceAccount octogee-gw-default"],
    ["serviceaccount-residual", "dynamic gateway ServiceAccounts remain after cleanup"],
    ["secret-inspect", "could not inspect per-gateway runtime Secrets"],
    ["secret-delete", "could not delete per-gateway runtime Secret gateway-auth-token-default"],
    ["secret-residual", "per-gateway runtime Secrets remain after cleanup"],
  ] as const)("fails closed when gateway runtime cleanup hits %s", (gatewayRuntimeFailure, message) => {
    const result = runPrivateCentralTeardown({ gatewayRuntimeFailure });

    expect(result.status).toBe(1);
    expect(`${result.stderr}\n${result.stdout}`).toContain(message);
    expectGiteaTokenMaterialPreserved(result.calls);
    expect(result.calls.some((call) => call.startsWith("firebase firestore:delete"))).toBe(false);
  });

  it.each([
    ["list", "could not list per-instance gateway Helm releases"],
    ["uninstall", "could not uninstall per-instance gateway release octogee-gw-stale"],
    ["residual", "per-instance gateway Helm releases remain after uninstall"],
    ["appears-after-empty", "per-instance gateway Helm releases remain after uninstall"],
  ] as const)("fails before credential cleanup when gateway Helm removal hits %s", (gatewayHelmFailure, message) => {
    const result = runPrivateCentralTeardown({ gatewayHelmFailure });

    expect(result.status).toBe(1);
    expect(`${result.stderr}\n${result.stdout}`).toContain(message);
    expect(result.calls.some((call) => call.includes("delete serviceaccount"))).toBe(false);
    expect(result.calls.some((call) => call.includes("delete secret"))).toBe(false);
    expectGiteaTokenMaterialPreserved(result.calls);
  });

  it.each([
    ["inspect", "could not inspect glm-controller before full gateway cleanup"],
    ["scale", "could not quiesce glm-controller before full gateway cleanup"],
    ["pods", "could not inspect glm-controller pods before full gateway cleanup"],
  ] as const)("fails before Helm removal when controller quiescence hits %s", (gatewayControllerFailure, message) => {
    const result = runPrivateCentralTeardown({ gatewayControllerFailure });

    expect(result.status).toBe(1);
    expect(`${result.stderr}\n${result.stdout}`).toContain(message);
    expect(result.calls.some((call) => call.startsWith("helm list"))).toBe(false);
    expect(result.calls.some((call) => call.includes("delete serviceaccount"))).toBe(false);
    expect(result.calls.some((call) => call.includes("delete secret"))).toBe(false);
    expectGiteaTokenMaterialPreserved(result.calls);
  });

  it("fails closed before data cleanup when a private database owner is not the target app user", () => {
    const result = runPrivateCentralTeardown({ databaseOwner: "unexpected" });

    expect(result.status).toBe(1);
    expect(`${result.stderr}\n${result.stdout}`).toContain("private Cloud SQL owner reset job returned unexpected owner 'legacy-owner' for mattermost_test");
    expect(result.calls.some((call) => /^sql databases create (mattermost|gitea)_/.test(call))).toBe(false);
    expect(result.calls.some((call) => call.startsWith("firebase firestore:delete"))).toBe(false);
  });

  it("fails closed before data cleanup when the private owner job cannot complete", () => {
    const result = runPrivateCentralTeardown({ sqlOwnerJobFailure: true });

    expect(result.status).toBe(1);
    expect(`${result.stderr}\n${result.stdout}`).toContain("could not read private Cloud SQL owner reset job output for mattermost_test");
    expect(result.calls.some((call) => /^sql databases create (mattermost|gitea)_/.test(call))).toBe(false);
    expect(result.calls.some((call) => call.startsWith("firebase firestore:delete"))).toBe(false);
  });

  it("dies as soon as the private owner job reports failure, with its logs", () => {
    const result = runPrivateCentralTeardown({ sqlOwnerJobFailed: true });

    expect(result.status).toBe(1);
    expect(`${result.stderr}\n${result.stdout}`).toContain("private Cloud SQL owner reset job failed for mattermost_test");
    expect(result.calls).toContainEqual(expect.stringMatching(/^kubectl logs job\/\S+ .*--all-containers=true/));
    expect(result.calls.some((entry) => entry.startsWith("kubectl wait --for=condition=complete"))).toBe(false);
    expect(result.calls.some((call) => /^sql databases create (mattermost|gitea)_/.test(call))).toBe(false);
  });

  it("uses the Cloud SQL Admin API only when the database is API-owned", () => {
    const result = runPrivateCentralTeardown({ databaseOwner: "cloudsqlsuperuser" });

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(result.calls).toContainEqual(expect.stringContaining("sql databases delete mattermost_test"));
    expect(result.calls).toContainEqual(expect.stringContaining("sql databases delete gitea_test"));
  });
  it("keeps TEST full-reset Secret Manager and Storage mutations inside the resolved data project", () => {
    const source = readFileSync(teardown, "utf8");

    expect(source).toContain('gcloud secrets list --project="$FIREBASE_PROJECT"');
    expect(source).toContain('gcloud secrets delete "$sm" --project="$FIREBASE_PROJECT"');
    expect(source).not.toContain('gcloud secrets list --project=octogee');
    expect(source).toContain('FIREBASE_STORAGE_BUCKET="gs://${FIREBASE_PROJECT}.firebasestorage.app"');
    expect(source).toContain(
      'gcloud storage ls --all-versions "$FIREBASE_STORAGE_BUCKET/**" --project="$TARGET_STORAGE_PROJECT"',
    );
    expect(source).toContain(
      'gcloud storage rm --all-versions "$FIREBASE_STORAGE_BUCKET/**" --project="$TARGET_STORAGE_PROJECT" --quiet',
    );
    expect(source).not.toContain("gcloud storage rm --recursive");
    expect(source).not.toContain("gcloud storage objects list");
  });

  it("runs extension preflight hooks before data deletion and extension cleanup after Firestore", () => {
    const source = readFileSync(teardown, "utf8");
    const preflight = source.indexOf('run_env_hooks ${ENV_TEARDOWN_FULL_PREFLIGHT[@]');
    const cleanup = source.indexOf('run_env_hooks ${ENV_TEARDOWN_FULL_STEPS[@]');

    expect(source.indexOf('load_env_extensions "$SCRIPT_DIR"')).toBeLessThan(preflight);
    expect(preflight).toBeGreaterThan(-1);
    expect(preflight).toBeLessThan(source.indexOf("# ── 1. Helm uninstall + resource cleanup"));
    expect(cleanup).toBeGreaterThan(source.indexOf("firebase firestore:delete --all-collections"));
  });

  it("fails before Firestore or Auth cleanup when the target Storage bucket cannot be wiped", () => {
    const result = runPrivateCentralTeardown({ storageFailure: true });

    expect(result.status).toBe(1);
    expect(`${result.stderr}\n${result.stdout}`).toContain("Firebase Storage wipe failed");
    expect(result.calls).toContainEqual(
      expect.stringContaining(`storage rm --all-versions gs://${TEST_TARGET.firebaseProjectId}.firebasestorage.app/** --project=${TEST_TARGET.firebaseProjectId} --quiet`),
    );
    expect(result.calls.some((call) => call.startsWith("firebase firestore:delete"))).toBe(false);
    expect(result.calls.some((call) => call.startsWith("npx ") && !call.includes("--verify"))).toBe(false);
  });

  it.each([
    ["Firebase CLI", { firebaseProbeFailure: true }, "Firebase CLI preflight failed"],
    ["Storage bucket", { storageDescribeFailure: true }, "Firebase Storage preflight failed"],
  ] as const)("stops before any destructive step when the %s cannot reach the target", (_name, options, message) => {
    const result = runPrivateCentralTeardown(options);

    expect(result.status).toBe(1);
    expect(`${result.stderr}\n${result.stdout}`).toContain(message);
    expect(result.calls.some((call) => call.startsWith("kubectl delete pvc"))).toBe(false);
    expect(result.calls.some((call) => call.startsWith("kubectl scale"))).toBe(false);
    expect(result.calls.some((call) => call.startsWith("helm uninstall"))).toBe(false);
    expect(result.calls.some((call) => call.startsWith("functions delete"))).toBe(false);
    expect(result.sqlOwnerManifest).toBe("");
  });

  it("refuses to reset private databases whose Mattermost and Gitea are already gone unless resumed", () => {
    const result = runPrivateCentralTeardown({ sqlWritersAbsent: true });

    expect(result.status).toBe(1);
    expect(`${result.stderr}\n${result.stdout}`).toContain("rerun with --resume");
    expect(result.sqlOwnerManifest).toBe("");
    expect(result.calls.some((call) => call.startsWith("firebase firestore:delete"))).toBe(false);
  });

  it("resumes a full reset whose previous run already reset the databases and removed Mattermost and Gitea", () => {
    const result = runPrivateCentralTeardown({ sqlWritersAbsent: true, resume: true });

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(result.sqlOwnerManifest).toBe("");
    expect(result.calls.some((entry) => entry.startsWith("sql databases delete platform"))).toBe(false);
    expect(result.calls.some((entry) => entry.includes("create configmap octogee-agent-store-reset-"))).toBe(false);
    expect(result.calls).toContain(`firebase firestore:delete --all-collections --project ${TEST_TARGET.firebaseProjectId} --force`);
  });

  it("refuses --resume while Mattermost and Gitea still run", () => {
    const result = runPrivateCentralTeardown({ resume: true });

    expect(result.status).toBe(1);
    expect(`${result.stderr}\n${result.stdout}`).toContain("--resume");
    expect(result.sqlOwnerManifest).toBe("");
    expect(result.calls.some((call) => call.startsWith("firebase firestore:delete"))).toBe(false);
  });

  it("prints a rebuild sequence that waits for any Shared slot and deploys Firebase through CI", () => {
    const result = runPrivateCentralTeardown();

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(result.stdout).toContain("kubectl wait --for=condition=Available deploy -l app=octogee-gateway,gateway-class=shared");
    expect(result.stdout).toContain('npm run ci:deploy -- --environment=test --sha="$PLATFORM_SOURCE_SHA"');
    expect(result.stdout).not.toContain("octogee-gateway-shared-0");
    expect(result.stdout).not.toContain("firebase deploy --project");
  });

  it("prints an env extension's after-deploy steps between the platform deploy and verify-env", () => {
    const result = runPrivateCentralTeardown({
      envExtension: 'ENV_REBUILD_STEPS_AFTER_DEPLOY+=(fixture_step)\nfixture_step() { echo "  fixture after deploy for $ENV$TARGET_ARG"; }\n',
    });

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(result.stdout).toContain("Env extensions loaded: fixture-extension");
    const fixture = result.stdout.indexOf("fixture after deploy for test --deployment-target=test-central");
    expect(fixture).toBeGreaterThan(result.stdout.indexOf("npm run ci:deploy"));
    expect(fixture).toBeLessThan(result.stdout.indexOf("./scripts/verify-env.sh"));
  });

  it("prints a Helm install that waits for Mattermost and Gitea, not for glm-controller's Gitea token", () => {
    const result = runPrivateCentralTeardown();

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    const install = result.stdout.slice(result.stdout.indexOf("helm upgrade --install octogee"), result.stdout.indexOf("# 3. Bootstrap Mattermost"));
    expect(install).not.toContain("--wait");
    expect(install).toContain("kubectl rollout status deployment/mattermost");
    expect(install).toContain("kubectl rollout status deployment/octogee-gitea");
  });

  it("prints a pod restart that leaves the fleet controller's gateway Deployments alone", () => {
    const result = runPrivateCentralTeardown();

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(result.stdout).toContain(`kubectl rollout restart deploy -n ${TEST_TARGET.namespace} --context ${TEST_TARGET.kubeContext} -l 'app!=octogee-gateway'`);
  });

  it("allows an already-empty target Storage bucket to complete the reset", () => {
    const result = runPrivateCentralTeardown({ storageEmpty: true });

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(result.calls.some((call) => call.startsWith("storage rm"))).toBe(false);
    expect(result.stdout).toContain("Firebase Storage already empty");
  });

  it("fails closed when target Storage generations cannot be listed", () => {
    const result = runPrivateCentralTeardown({ storageListFailure: true });

    expect(result.status).toBe(1);
    expect(`${result.stderr}\n${result.stdout}`).toContain("Firebase Storage listing failed");
    expect(`${result.stderr}\n${result.stdout}`).toContain("PERMISSION_DENIED");
    expect(result.calls.some((call) => call.startsWith("storage rm"))).toBe(false);
    expect(result.calls.some((call) => call.startsWith("firebase firestore:delete"))).toBe(false);
  });

  it("fails before Firestore or Auth cleanup when generations remain after Storage deletion", () => {
    const result = runPrivateCentralTeardown({ storageResidual: true });

    expect(result.status).toBe(1);
    expect(`${result.stderr}\n${result.stdout}`).toContain("Firebase Storage still contains object generations");
    expect(result.calls.filter((call) => call.startsWith("storage ls --all-versions"))).toHaveLength(2);
    expect(result.calls.some((call) => call.startsWith("firebase firestore:delete"))).toBe(false);
    expect(result.calls.some((call) => call.startsWith("npx ") && !call.includes("--verify"))).toBe(false);
  });

  it("fails closed when Cloud Function discovery is unavailable", () => {
    const result = runPrivateCentralTeardown({ functionListFailure: true });

    expect(result.status).toBe(1);
    expect(`${result.stderr}\n${result.stdout}`).toContain("could not list Cloud Functions");
    expect(result.calls.some((call) => call.startsWith("npx ") && !call.includes("--verify"))).toBe(false);
  });

  it("fails closed when Cloud Function inventory has an unknown generation", () => {
    const result = runPrivateCentralTeardown({ functionInventory: "mystery,GEN_3\n" });

    expect(result.status).toBe(1);
    expect(`${result.stderr}\n${result.stdout}`).toContain(
      "unexpected Cloud Function inventory row 'mystery,GEN_3'",
    );
    expect(result.calls.some((call) => call.startsWith("functions delete"))).toBe(false);
    expect(result.calls.some((call) => call.startsWith("storage ") && !call.startsWith("storage buckets describe"))).toBe(false);
  });

  it("waits for every Cloud Function deletion and stops on the first failure", () => {
    const result = runPrivateCentralTeardown({
      functions: [
        { name: "function-a", generation: "GEN_1" },
        { name: "function-b", generation: "GEN_2" },
      ],
      functionDeleteFailure: true,
    });

    expect(result.status).toBe(1);
    expect(`${result.stderr}\n${result.stdout}`).toContain("could not delete GEN_1 Cloud Function function-a");
    expect(result.calls).toContainEqual(expect.stringContaining("functions delete function-a"));
    expect(result.calls).not.toContainEqual(expect.stringContaining("functions delete function-b"));
    expect(result.calls.some((call) => call.startsWith("npx ") && !call.includes("--verify"))).toBe(false);
  });

  it("quiesces Gen 1 and Gen 2 functions before wiping Firebase data and never deletes Cloud Run services", () => {
    const result = runPrivateCentralTeardown({
      functions: [
        { name: "legacyTrigger", generation: "GEN_1" },
        { name: "onSignup", generation: "GEN_2" },
        { name: "octogee-chat-proxy", generation: "GEN_2" },
      ],
    });
    const functionList = result.calls.findIndex((call) => call.startsWith("functions list --regions=us-central1"));
    const gen1Delete = result.calls.findIndex((call) => call.startsWith("functions delete legacyTrigger"));
    const gen2Delete = result.calls.findIndex((call) => call.startsWith("functions delete onSignup"));
    const storageWipe = result.calls.findIndex((call) => call.startsWith("storage rm"));
    const firestoreWipe = result.calls.findIndex((call) => call.startsWith("firebase firestore:delete"));

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(functionList).toBeGreaterThanOrEqual(0);
    expect(gen1Delete).toBeGreaterThan(functionList);
    expect(gen2Delete).toBeGreaterThan(gen1Delete);
    expect(storageWipe).toBeGreaterThan(gen2Delete);
    expect(firestoreWipe).toBeGreaterThan(gen2Delete);
    expect(result.calls.some((call) => call.startsWith("functions delete octogee-chat-proxy"))).toBe(false);
    expect(result.calls.some((call) => call.startsWith("run services delete"))).toBe(false);
  });

  it("aborts an interactive full reset when a required wipe is declined", () => {
    const result = runPrivateCentralTeardown({ interactiveInput: "y\ny\nn\ny\ny\n" });

    expect(result.status).toBe(1);
    expect(`${result.stderr}\n${result.stdout}`).toContain("Full teardown cancelled; Firebase Storage objects remain");
    expect(result.stdout).not.toContain("Teardown complete");
    expect(result.calls.some((call) => call.startsWith("firebase firestore:delete"))).toBe(false);
  });

  it("describes full teardown as deleting its durable PVCs", () => {
    const result = spawnSync("bash", [teardown, "--help"], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("deletes durable PVCs");
    expect(result.stdout).not.toContain("Still preserves PVCs");
  });

  it("prints an env extension's after-rollout steps after the pods roll and before the platform deploy", () => {
    const result = runPrivateCentralTeardown({
      envExtension: 'ENV_REBUILD_STEPS_AFTER_ROLLOUT+=(fixture_step)\nfixture_step() { echo "  fixture after rollout for $ENV"; }\n',
    });

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    const roll = result.stdout.indexOf(`kubectl rollout restart deploy -n ${TEST_TARGET.namespace}`);
    const step = result.stdout.indexOf("fixture after rollout for test");
    const deploy = result.stdout.indexOf("npm run ci:deploy -- --environment=test");
    expect(roll).toBeGreaterThan(-1);
    expect(step).toBeGreaterThan(roll);
    expect(deploy).toBeGreaterThan(step);
  });

  it("resets test-central through target-owned in-cluster credentials without a local proxy", () => {
    const result = runPrivateCentralTeardown();

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(result.calls).not.toContainEqual(expect.stringContaining("sql databases create mattermost_test"));
    expect(result.calls).toContainEqual(expect.stringContaining("sql databases describe mattermost_test"));
    expect(result.calls).not.toContainEqual(expect.stringContaining("sql databases create gitea_test"));
    expect(result.calls).toContainEqual(expect.stringContaining("sql databases describe gitea_test"));
    expect(result.stdout).toContain("Private Cloud SQL owner reset completed before Helm uninstall");
    expect(result.calls).toContainEqual(expect.stringContaining("kubectl wait --for=delete pvc/gitea-shared-storage"));
    expect(result.calls).toContainEqual(expect.stringContaining("kubectl wait --for=delete pvc/mattermost-data"));
    expect(result.stdout).toContain("Durable PVCs confirmed absent");
    expect(result.stdout).toContain(
      "PLATFORM_SOURCE_SHA=<full 40-character source SHA from the tested Central release manifest>",
    );
    expect(result.stdout).toContain(
      "RELEASE_VALUES_FILE=$(mktemp)",
    );
    expect(result.stdout).toContain(
      "scripts/ops/render-release-helm-values.ts \"$PLATFORM_SOURCE_SHA\"",
    );
    expect(result.stdout).toContain(
      '> "$RELEASE_VALUES_FILE" || exit 1',
    );
    expect(result.stdout).toContain(
      '-f "$RELEASE_VALUES_FILE"',
    );
  });

  it.each([
    ["inspect", "could not inspect PVC gitea-shared-storage", false],
    ["delete", "delete request failed for PVC gitea-shared-storage", false],
    ["finalize", "PVC mattermost-data did not finalize", true],
  ] as const)("fails closed when durable PVC %s fails", (pvcFailure, message, databaseResetStarted) => {
    const result = runPrivateCentralTeardown({ pvcFailure });

    expect(result.status).toBe(1);
    expect(`${result.stderr}\n${result.stdout}`).toContain(message);
    expect(result.calls.some((call) => call.startsWith("sql databases"))).toBe(databaseResetStarted);
  });

  it.each([
    ["inspect", "could not inspect mattermost_test", "sql databases delete mattermost_test"],
    ["delete", "delete failed for API-owned mattermost_test", "sql databases describe gitea_test"],
    ["verify-command", "verification failed for mattermost_test", "sql databases describe gitea_test"],
    ["verify-value", "verification returned 'wrong_database' for mattermost_test", "sql databases describe gitea_test"],
  ] as const)(
    "fails closed when the Cloud SQL Admin API %s boundary fails",
    (databaseFailure, message, forbiddenCall) => {
      const result = runPrivateCentralTeardown({
        databaseFailure,
        databaseOwner: databaseFailure === "delete" ? "cloudsqlsuperuser" : undefined,
      });

      expect(result.status).toBe(1);
      expect(`${result.stderr}\n${result.stdout}`).toContain(message);
      expect(result.calls).not.toContainEqual(expect.stringContaining(forbiddenCall));
      expect(result.calls.some((call) => call.startsWith("secrets list"))).toBe(false);
      expect(result.stderr).not.toContain("Authentication failed");
    },
  );

  it("distinguishes an absent password secret from a Secret Manager read failure", () => {
    const absent = runPrivateCentralTeardown({ secretFailure: "absent", publicIp: true });
    expect(absent.status).toBe(1);
    expect(absent.stdout).toContain("MM_DB_PASSWORD:    absent");
    expect(absent.stderr).not.toContain("gcloud auth or network");

    const failed = runPrivateCentralTeardown({ secretFailure: "error", publicIp: true });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("PERMISSION_DENIED");
    expect(failed.stderr).toContain("gcloud auth or network");
  });

  it("does not mislabel a reachable-proxy transport failure as a password mismatch", () => {
    const result = runPrivateCentralTeardown({ publicIp: true });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("transport/config failure, not a credential mismatch");
    expect(result.stderr).toContain("Fix Cloud SQL proxy/private-network reachability and retry.");
    expect(result.stderr).not.toContain("Authentication failed");
  });
});
