import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = readFileSync(new URL("../verify-env.sh", import.meta.url), "utf8");
const policy = fileURLToPath(new URL("../lib/cloud-sql-backup-policy.sh", import.meta.url));
const healthy = {
  region: "us-central1",
  settings: {
    backupConfiguration: {
      enabled: true, pointInTimeRecoveryEnabled: true, startTime: "04:00",
      transactionLogRetentionDays: 7, backupRetentionSettings: { retainedBackups: 7 },
    },
    retainBackupsOnDelete: true,
    deletionProtectionEnabled: true,
  },
};

function verify(configuration: string, required = "true", env = "test") {
  const section = script.split('header "2. Cloud SQL Proxy"')[1].split("# ── 3. Mattermost")[0];
  return spawnSync("bash", ["-eu", "-o", "pipefail", "-c", `
source "$1"
pass() { printf 'pass %s\\n' "$*"; }
fail() { printf 'fail %s\\n' "$*"; failed=1; }
kubectl() { printf '1\\n'; }
gcloud() {
  [[ "$*" == "sql instances describe octogee-pg --project=sql-project --format=json" ]] || return 2
  [[ "$2" == instances && -n "$CLOUD_SQL_RESPONSE" ]] || return 3
  printf '%s\\n' "$CLOUD_SQL_RESPONSE"
}
failed=0
FIX=false
NAMESPACE=test-namespace
TARGET_ID=test-central
TARGET_CLOUD_SQL_INSTANCE=octogee-pg
TARGET_CLOUD_SQL_PROJECT=sql-project
TARGET_CLOUD_SQL_REGION=us-central1
${section}
exit "$failed"
`, "verify-test", policy], {
    env: { ...process.env, CLOUD_SQL_RESPONSE: configuration, TARGET_CLOUD_SQL_PITR_ENABLED: required, ENV: env },
    encoding: "utf8",
  });
}

describe("verify-env Cloud SQL recovery", () => {
  it("checks the resolved application database and accepts the live backup policy", () => {
    const result = verify(JSON.stringify(healthy));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("pass Cloud SQL PITR and backup policy verified for sql-project/octogee-pg");
  });

  it.each([
    ["disabled PITR", { ...healthy.settings, backupConfiguration: { ...healthy.settings.backupConfiguration, pointInTimeRecoveryEnabled: false } }],
    ["missing deletion protection", { ...healthy.settings, deletionProtectionEnabled: false }],
    ["insufficient WAL retention", { ...healthy.settings, backupConfiguration: { ...healthy.settings.backupConfiguration, transactionLogRetentionDays: 6 } }],
    ["malformed WAL retention", { ...healthy.settings, backupConfiguration: { ...healthy.settings.backupConfiguration, transactionLogRetentionDays: "7" } }],
    ["insufficient backups", { ...healthy.settings, backupConfiguration: { ...healthy.settings.backupConfiguration, backupRetentionSettings: { retainedBackups: 6 } } }],
  ])("fails on %s", (_case, settings) => {
    const result = verify(JSON.stringify({ region: healthy.region, settings }));
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain("fail Cloud SQL PITR or backup policy drifted");
  });

  it("fails when the instance settings cannot be read", () => {
    const result = verify("");
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain("fail Cannot read Cloud SQL backup policy");
  });

  it("leaves separately provisioned custom namespaces and opt-out targets alone", () => {
    expect(verify("", "false").status).toBe(0);
    expect(verify("", "true", "custom").status).toBe(0);
  });
});
