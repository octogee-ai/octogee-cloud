import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadAppliedFingerprints,
  saveAppliedFingerprints,
} from "../lib/applied-fingerprint-store.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "applied-fp-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function file(): string {
  return path.join(dir, "applied-fingerprints.json");
}

describe("applied fingerprint store", () => {
  it("round-trips the map across a process restart", () => {
    // The reconcile's appliedFp bookkeeping survives a container restart with the
    // disk intact, so an unchanged fleet does not re-ensure after every restart.
    const applied = new Map([
      ["alice", "fp-1"],
      ["bob", "fp-2"],
    ]);
    saveAppliedFingerprints(file(), applied);
    expect(loadAppliedFingerprints(file())).toEqual(applied);
  });

  it("returns an empty map when the file does not exist (fresh pod — everything re-ensures anyway)", () => {
    expect(loadAppliedFingerprints(file()).size).toBe(0);
  });

  it("returns an empty map on a corrupt file instead of wedging the reconcile", () => {
    fs.writeFileSync(file(), "{not json", "utf-8");
    expect(loadAppliedFingerprints(file()).size).toBe(0);
  });

  it("ignores non-string entries from a tampered/odd file", () => {
    fs.writeFileSync(file(), JSON.stringify({ alice: "fp-1", bob: 42, carol: null }), "utf-8");
    expect(loadAppliedFingerprints(file())).toEqual(new Map([["alice", "fp-1"]]));
  });

  it("save overwrites atomically (no partial state visible after a rewrite)", () => {
    saveAppliedFingerprints(file(), new Map([["alice", "fp-1"]]));
    saveAppliedFingerprints(file(), new Map([["bob", "fp-2"]]));
    expect(loadAppliedFingerprints(file())).toEqual(new Map([["bob", "fp-2"]]));
    // No temp files left behind.
    expect(fs.readdirSync(dir)).toEqual(["applied-fingerprints.json"]);
  });

  it("leaves a pre-existing temporary sibling alone when saving", () => {
    const sibling = path.join(dir, ".applied-fingerprints.json.tmp");
    fs.writeFileSync(sibling, "existing data");
    saveAppliedFingerprints(file(), new Map([["alice", "fp-1"]]));
    expect(fs.readFileSync(sibling, "utf8")).toBe("existing data");
    expect(loadAppliedFingerprints(file()).get("alice")).toBe("fp-1");
  });
});
