import { describe, expect, it } from "vitest";
import type { PlatformStateStore } from "@octogee/core/platform-state";
import { createNativeRecoveryComposition } from "../lib/native-recovery-composition.js";

const noStore = new Proxy({} as PlatformStateStore, {
  get() { throw new Error("unenrolled recovery touched the platform store"); },
});

describe("native recovery product enrollment", () => {
  it("installs no worker or operator hooks without TEST enrollment", () => {
    expect(createNativeRecoveryComposition("test", "fixture", noStore, Date.now)).toBeUndefined();
    expect(createNativeRecoveryComposition("test", "fixture", noStore, Date.now, null)).toBeUndefined();
  });

  it("never reads enrollment in production", () => {
    expect(createNativeRecoveryComposition("prod", "fixture", noStore, Date.now, new Proxy({} as never, {
      get() { throw new Error("production recovery touched TEST enrollment"); },
    }))).toBeUndefined();
  });
});
