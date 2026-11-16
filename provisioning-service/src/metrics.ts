import { PROVISIONING_CONDITION_REASONS, type ProvisioningWorkState } from "@octogee/shared/types/provisioning-service";

type Labels = Record<string, string>;

function labelText(labels: Labels): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return "";
  const escape = (value: string) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
  const pairs = entries.map(([key, value]) => key + '="' + escape(value) + '"');
  return "{" + pairs.join(",") + "}";
}

export interface GitKeyRowCount {
  status: string;
  reason: string;
  count: number;
}

const KEY_STATUSES: ReadonlySet<string> = new Set(["True", "False", "Unknown"]);
const KEY_REASONS: ReadonlySet<string> = new Set(PROVISIONING_CONDITION_REASONS);

function boundedKeyLabels(row: GitKeyRowCount): Labels {
  return {
    status: KEY_STATUSES.has(row.status) ? row.status : "Unrecognized",
    reason: KEY_REASONS.has(row.reason) ? row.reason : "Unrecognized",
  };
}

export interface WorkSnapshot {
  states: Record<ProvisioningWorkState, number>;
  gitKeys: GitKeyRowCount[];
  oldestDueSeconds: number;
  generationLagSeconds: number;
}

export class Metrics {
  private readonly attempts = new Map<string, { labels: Labels; value: number }>();
  private readonly hostCalls = new Map<string, { labels: Labels; sum: number; count: number }>();
  private leaseExpired = 0;
  private leasesHeld = 0;

  attempt(result: string, reason: string): void {
    const labels = { result, reason };
    const key = labelText(labels);
    const entry = this.attempts.get(key) ?? { labels, value: 0 };
    entry.value += 1;
    this.attempts.set(key, entry);
  }

  setLeasesHeld(count: number): void {
    this.leasesHeld = count;
  }

  leaseExpiredSeen(count = 1): void {
    this.leaseExpired += count;
  }

  hostCall(host: string, operation: string, status: string, seconds: number): void {
    const labels = { host, operation, status };
    const key = labelText(labels);
    const entry = this.hostCalls.get(key) ?? { labels, sum: 0, count: 0 };
    entry.sum += seconds;
    entry.count += 1;
    this.hostCalls.set(key, entry);
  }

  render(snapshot: WorkSnapshot): string {
    const lines: string[] = [
      "# TYPE provisioning_work gauge",
      ...Object.entries(snapshot.states).map(([state, count]) => `provisioning_work${labelText({ state })} ${count}`),
      "# TYPE provisioning_git_keys gauge",
      ...snapshot.gitKeys.map((row) => `provisioning_git_keys${labelText(boundedKeyLabels(row))} ${row.count}`),
      "# TYPE provisioning_oldest_due_seconds gauge",
      `provisioning_oldest_due_seconds ${snapshot.oldestDueSeconds}`,
      "# TYPE provisioning_generation_lag_seconds gauge",
      `provisioning_generation_lag_seconds ${snapshot.generationLagSeconds}`,
      "# TYPE provisioning_attempts_total counter",
      ...[...this.attempts.values()].map((entry) => `provisioning_attempts_total${labelText(entry.labels)} ${entry.value}`),
      "# TYPE provisioning_lease_expired_total counter",
      `provisioning_lease_expired_total ${this.leaseExpired}`,
      "# TYPE provisioning_leases_held gauge",
      `provisioning_leases_held ${this.leasesHeld}`,
      "# TYPE provisioning_host_call_seconds summary",
      ...[...this.hostCalls.values()].flatMap((entry) => [
        `provisioning_host_call_seconds_sum${labelText(entry.labels)} ${entry.sum}`,
        `provisioning_host_call_seconds_count${labelText(entry.labels)} ${entry.count}`,
      ]),
    ];
    return `${lines.join("\n")}\n`;
  }
}
