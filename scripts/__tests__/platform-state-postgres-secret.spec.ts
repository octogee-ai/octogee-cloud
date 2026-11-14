import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runAgainstFakes, testCentral } from "./fixtures/secret-script-fakes.js";

const helper = path.resolve(import.meta.dirname, "../lib/platform-state-postgres-secret.sh");

interface Scenario {
  readonly exists?: boolean;
  readonly lookupFails?: boolean;
  readonly passwordMissing?: boolean;
  readonly privateIp?: string;
}

function materialize(scenario: Scenario = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "platform-state-secret-"));
  const trace = path.join(dir, "trace");
  const literals = path.join(dir, "literals");
  const files = path.join(dir, "files");
  writeFileSync(path.join(dir, "gcloud"), `#!/bin/bash
printf '%s\\n' "$*" >> "$TRACE"
if [[ "$1 $2 $3" == "sql instances describe" ]]; then
  [[ "$*" == *"octogee-platform-test"* && "$*" == *"--project=sql-project"* ]] || exit 8
  printf '%s\\n' "$PRIVATE_IP"
  exit 0
fi
[[ "$*" == *"--project=password-project"* ]] || exit 8
if [[ "$*" == *"runtime-password"* && "$PASSWORD_MISSING" == 1 ]]; then exit 9; fi
case "$*" in
  *"platform-state-postgres-migration-password"*) printf 'private-migration-credential' ;;
  *"platform-state-postgres-runtime-password"*) printf 'private-runtime-credential' ;;
  *) exit 8 ;;
esac
`);
  writeFileSync(path.join(dir, "kubectl"), `#!/bin/bash
printf '%s\\n' "$*" >> "$TRACE"
if [[ "$*" == *" get secret platform-state-postgres "* ]]; then
  [[ "$LOOKUP_FAILS" != 1 ]] || exit 7
  [[ "$EXISTS" != 1 ]] || printf 'secret/platform-state-postgres\\n'
  exit 0
fi
if [[ "$*" == *"create secret"* ]]; then
  for arg in "$@"; do
    case "$arg" in
      --from-literal=*) printf '%s\\n' "\${arg#--from-literal=}" >> "$LITERALS" ;;
      --from-file=*)
        file="\${arg#--from-file=}"; key="\${file%%=*}"; file="\${file#*=}"
        [[ "$(stat ${process.platform === "darwin" ? "-f %Lp" : "-c %a"} "$file")" == 600 ]] || exit 10
        printf '%s=%s\\n' "$key" "$(cat "$file")" >> "$FILES"
        printf '%s\\n' "$file" >> "$TRACE"
        ;;
    esac
  done
  printf 'materialized-secret'
else cat >/dev/null; fi
`);
  for (const name of ["gcloud", "kubectl"]) chmodSync(path.join(dir, name), 0o755);
  const result = spawnSync("bash", ["-euo", "pipefail", "-c", `source "$HELPER"; materialize_platform_state_postgres_secret password-project sql-project octogee-platform-test target-namespace explicit-context`], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      HELPER: helper,
      TRACE: trace,
      LITERALS: literals,
      FILES: files,
      EXISTS: scenario.exists ? "1" : "0",
      LOOKUP_FAILS: scenario.lookupFails ? "1" : "0",
      PASSWORD_MISSING: scenario.passwordMissing ? "1" : "0",
      PRIVATE_IP: scenario.privateIp ?? "10.89.0.11",
    },
  });
  const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "");
  const calls = read(trace);
  const keys = [...read(literals).split("\n"), ...read(files).split("\n")].filter(Boolean).sort();
  const temporaryFiles = calls.split("\n").filter((line) => line.startsWith("/") && line.endsWith("-password"));
  const cleaned = temporaryFiles.every((file) => !existsSync(file));
  rmSync(dir, { recursive: true, force: true });
  return { result, calls, keys, temporaryFiles, cleaned };
}

function expectNothingWritten(calls: string) {
  expect(calls).not.toContain("create secret");
  expect(calls).not.toContain("apply -f -");
}

describe("platform state database secret", () => {
  it("creates every key the services read, from the instance and the environment's password versions", () => {
    const { result, calls, keys, temporaryFiles, cleaned } = materialize();
    expect(result.status, result.stderr).toBe(0);
    expect(keys).toEqual([
      "database=platform",
      "host=10.89.0.11",
      "migration-password=private-migration-credential",
      "migration-user=platform_migrator",
      "port=5432",
      "runtime-password=private-runtime-credential",
      "runtime-user=platform_state",
      "sslmode=require",
    ]);
    expect(calls).toContain("--context=explicit-context");
    expect(calls).toContain("-n target-namespace");
    expect(calls).toContain("apply -f -");
    expect(temporaryFiles).toHaveLength(2);
    expect(cleaned).toBe(true);
  });

  it("never exposes a password on a command line or in its output", () => {
    const { result, calls } = materialize();
    expect(result.status, result.stderr).toBe(0);
    expect(calls).not.toContain("credential");
    expect(result.stdout + result.stderr).not.toContain("credential");
  });

  it("leaves an existing secret untouched, because its TLS identity cannot be rebuilt from Cloud SQL", () => {
    const { result, calls } = materialize({ exists: true });
    expect(result.status, result.stderr).toBe(0);
    expectNothingWritten(calls);
    expect(calls).not.toContain("secrets versions access");
  });

  it("stops without writing when it cannot tell whether the secret exists", () => {
    const { result, calls } = materialize({ lookupFails: true });
    expect(result.status).not.toBe(0);
    expectNothingWritten(calls);
  });

  it("stops without writing when a password version is unavailable", () => {
    const { result, calls, cleaned } = materialize({ passwordMissing: true });
    expect(result.status).not.toBe(0);
    expectNothingWritten(calls);
    expect(cleaned).toBe(true);
  });

  it.each([
    ["no private address", ""],
    ["more than one private address", "10.89.0.11;10.89.0.12"],
  ])("stops without writing when the instance has %s", (_label, privateIp) => {
    const { result, calls } = materialize({ privateIp });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("octogee-platform-test");
    expectNothingWritten(calls);
  });
});


function runSetupSecrets(...args: readonly string[]) {
  return runAgainstFakes("scripts/setup-secrets.sh", args, `case "$*" in
  "sql instances describe"*) printf '10.0.0.9\\n' ;;
  *MM_DB_PASSWORD*) exit 1 ;;
  "secrets versions access"*) printf 'fake-value' ;;
esac`, `case "$*" in
  "config current-context") printf '%s\\n' "$KUBE_CONTEXT" ;;
  *"create secret"*) printf 'materialized-secret' ;;
  *"apply -f -"*) cat >/dev/null ;;
esac`);
}

describe("setup-secrets platform state wiring", () => {
  it("creates the secret from the deployment target's projects during bootstrap", () => {
    const { calls, output } = runSetupSecrets("--env=test", "--deployment-target=test-central", "--phase=bootstrap", "--yes");
    expect(output).toContain("MM_DB_PASSWORD not in Secret Manager");
    expect(calls).toContain(`sql instances describe ${testCentral.cloudSql.platformStateInstance} --project=${testCentral.cloudSql.projectId}`);
    expect(calls).toContain(`secrets versions access latest --secret=platform-state-postgres-runtime-password --project=${testCentral.firebaseProjectId}`);
    expect(calls).toContain(`create secret generic platform-state-postgres -n ${testCentral.namespace}`);
  });

  it("gives custom namespaces no platform database credentials", () => {
    const { calls, output } = runSetupSecrets("--env=custom", "--namespace=feat-review", "--phase=bootstrap", "--yes");
    expect(output).toContain("MM_DB_PASSWORD not in Secret Manager");
    expect(calls).not.toContain("platform-state-postgres");
  });
});


describe("verify-secrets platform state requirement", () => {
  const missingEverything = "[[ \"$*\" != *\" get secret \"* && \"$*\" != get\\ secret* ]] || exit 1";

  it("reports the secret as missing for a standard environment", () => {
    const { result, output } = runAgainstFakes("scripts/verify-secrets.sh", ["--env=test", "--deployment-target=test-central"], "exit 1", missingEverything);
    expect(result.status).not.toBe(0);
    expect(output).toContain("platform-state-postgres — ");
    expect(output).toContain("MISSING");
  });

  it("does not require it for custom namespaces", () => {
    const { output } = runAgainstFakes("scripts/verify-secrets.sh", ["--env=custom", "--namespace=feat-review"], "exit 1", missingEverything);
    expect(output).toContain("agent-store-postgres");
    expect(output).not.toContain("platform-state-postgres");
  });

  it.each(["host", "database", "sslmode", "migration-user", "migration-password", "runtime-user", "runtime-password"])("reports an empty %s", (key) => {
    const { result, output } = runAgainstFakes("scripts/verify-secrets.sh", ["--env=test", "--deployment-target=test-central"], "exit 1", "exit 0");
    expect(result.status).not.toBe(0);
    expect(output).toContain(`platform-state-postgres/${key} — `);
  });
});
