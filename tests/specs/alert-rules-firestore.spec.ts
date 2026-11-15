import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";

interface Rule {
  alert?: string;
  expr?: string;
  for?: string;
  labels?: { severity?: string };
  annotations?: { summary?: string; description?: string };
}
interface Group {
  name: string;
  rules: Rule[];
}

const REPO_ROOT = path.resolve(__dirname, "../..");
const DATABASE_RESOURCE = 'monitored_resource="firestore.googleapis.com/Database"';

let firestoreRules: Record<string, Rule>;

beforeAll(() => {
  const doc = parse(
    readFileSync(path.join(REPO_ROOT, "charts/monitoring/files/gmp-rules.yaml"), "utf8"),
  ) as { spec: { groups: Group[] } };
  const group = doc.spec.groups.find((entry) => entry.name === "octogee.firestore");
  if (!group) throw new Error("octogee.firestore group missing");
  firestoreRules = Object.fromEntries(
    group.rules.filter((rule) => rule.alert).map((rule) => [rule.alert!, rule]),
  );
});

describe("gmp-rules — octogee.firestore", () => {
  it("alerts on a sustained document read rate far above the healthy fleet baseline", () => {
    const rule = firestoreRules.FirestoreReadRateHigh;
    expect(rule, "FirestoreReadRateHigh missing").toBeDefined();
    expect(rule.expr).toContain("sum(rate(firestore_googleapis_com:document_read_count{");
    expect(rule.expr).toContain(DATABASE_RESOURCE);
    expect(rule.expr).toContain("[10m])) > 150");
    expect(rule.for).toBe("15m");
  });

  it("alerts on a sustained document write rate — the read amplifier", () => {
    const rule = firestoreRules.FirestoreWriteRateHigh;
    expect(rule, "FirestoreWriteRateHigh missing").toBeDefined();
    expect(rule.expr).toContain("sum(rate(firestore_googleapis_com:document_write_count{");
    expect(rule.expr).toContain(DATABASE_RESOURCE);
    expect(rule.expr).toContain("[10m])) > 50");
    expect(rule.for).toBe("15m");
  });

  it("labels both alerts for a severity the Terraform workload policies select", () => {
    expect(firestoreRules.FirestoreReadRateHigh.labels?.severity).toBe("critical");
    expect(firestoreRules.FirestoreWriteRateHigh.labels?.severity).toBe("warning");
  });

  it("names the read-amplification failure mode the storm went undetected on", () => {
    const read = firestoreRules.FirestoreReadRateHigh.annotations;
    expect(read?.summary).toMatch(/read/i);
    expect(read?.description).toMatch(/baseline/i);
    expect(read?.description).toMatch(/listener|watcher/i);
    const write = firestoreRules.FirestoreWriteRateHigh.annotations;
    expect(write?.summary).toMatch(/write/i);
    expect(write?.description).toMatch(/watcher|listener/i);
  });
});
