import { describe, it, expect } from "vitest";
import {
  fingerprintCredential,
  decideSyncBack,
  syncBackSweep,
  type AuthFingerprint,
} from "../lib/byosub-syncback.js";

describe("fingerprintCredential", () => {
  it("returns sha256 + size for a credential", () => {
    const fp = fingerprintCredential('{"tokens":{"refresh_token":"a"}}');
    expect(fp).not.toBeNull();
    expect(fp!.size).toBeGreaterThan(0);
    expect(fp!.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is content-stable and content-sensitive", () => {
    const a = fingerprintCredential('{"x":1}');
    const b = fingerprintCredential('{"x":1}');
    const c = fingerprintCredential('{"x":2}');
    expect(a!.sha256).toBe(b!.sha256);
    expect(a!.sha256).not.toBe(c!.sha256);
  });

  it("returns null for an absent credential", () => {
    expect(fingerprintCredential(null)).toBeNull();
  });
});

describe("decideSyncBack", () => {
  const fp = (s: string): AuthFingerprint => ({ sha256: s, size: 1 });

  it("first observation (no prior) is a change", () => {
    const d = decideSyncBack(null, fp("aaa"));
    expect(d.changed).toBe(true);
  });

  it("a content change (token rotation) is a change", () => {
    expect(decideSyncBack(fp("aaa"), fp("bbb")).changed).toBe(true);
  });

  it("identical content is not a change (no churn on every poll)", () => {
    expect(decideSyncBack(fp("aaa"), fp("aaa")).changed).toBe(false);
  });

  it("absent current file is NEVER a change (don't push a deletion as a rotation)", () => {
    expect(decideSyncBack(fp("aaa"), null).changed).toBe(false);
    expect(decideSyncBack(null, null).changed).toBe(false);
  });
});

describe("syncBackSweep", () => {
  function target(content: string) {
    const t = {
      agentId: "octogee-a-coach",
      credential: content as string | null,
      readCredential: () => t.credential,
    };
    return t;
  }

  it("observe mode: a changed credential is logged, NEVER pushed", async () => {
    const t = target('{"tokens":{"refresh_token":"v1"}}');
    const logs: string[] = [];
    let pushed = 0;
    const r = await syncBackSweep({
      targets: [t],
      prev: new Map(),
      mode: "observe",
      pushCredential: async () => {
        pushed++;
      },
      logFn: (m) => logs.push(m),
    });
    expect(pushed).toBe(0);
    expect(r.observed).toBe(1);
    expect(r.pushed).toBe(0);
    expect(logs.join("\n")).toMatch(/octogee-a-coach/);
    
    const r2 = await syncBackSweep({
      targets: [t],
      prev: r.prev,
      mode: "observe",
    });
    expect(r2.observed).toBe(0);
  });

  it("active mode: a rotation is pushed with the credential payload; prev advances", async () => {
    const t = target('{"tokens":{"refresh_token":"v1"}}');
    const seen: Array<{ agentId: string; payload: string }> = [];
    const r = await syncBackSweep({
      targets: [t],
      prev: new Map(),
      mode: "active",
      pushCredential: async (agentId, payload) => {
        seen.push({ agentId, payload });
      },
    });
    expect(r.pushed).toBe(1);
    expect(seen[0].agentId).toBe("octogee-a-coach");
    expect(JSON.parse(seen[0].payload).tokens.refresh_token).toBe("v1");
    
    t.credential = '{"tokens":{"refresh_token":"v2"}}';
    const r2 = await syncBackSweep({
      targets: [t],
      prev: r.prev,
      mode: "active",
      pushCredential: async (agentId, payload) => {
        seen.push({ agentId, payload });
      },
    });
    expect(r2.pushed).toBe(1);
    expect(JSON.parse(seen[1].payload).tokens.refresh_token).toBe("v2");
  });

  it("active push failure: counts failed, does NOT advance prev (retry next sweep), never throws", async () => {
    const t = target('{"tokens":{"refresh_token":"v1"}}');
    const r = await syncBackSweep({
      targets: [t],
      prev: new Map(),
      mode: "active",
      pushCredential: async () => {
        throw new Error("gateway-edge 503");
      },
    });
    expect(r.pushed).toBe(0);
    expect(r.failed).toBe(1);
    
    let retried = 0;
    const r2 = await syncBackSweep({
      targets: [t],
      prev: r.prev,
      mode: "active",
      pushCredential: async () => {
        retried++;
      },
    });
    expect(retried).toBe(1);
    expect(r2.pushed).toBe(1);
  });

  it("unchanged + absent credentials are no-ops", async () => {
    const t = target('{"tokens":{"x":1}}');
    const r = await syncBackSweep({ targets: [t], prev: new Map(), mode: "observe" });
    const r2 = await syncBackSweep({ targets: [t], prev: r.prev, mode: "observe" });
    expect(r2.observed).toBe(0);
    const gone = { agentId: "octogee-b-coach", readCredential: () => null };
    const r3 = await syncBackSweep({ targets: [gone], prev: new Map(), mode: "active" });
    expect(r3).toMatchObject({ pushed: 0, observed: 0, failed: 0 });
  });
});
