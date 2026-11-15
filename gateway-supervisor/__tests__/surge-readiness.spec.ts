import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSurgeReadinessGate } from "../lib/surge-readiness.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("surge readiness gate", () => {
  it("starts closed, opens durably, and is idempotent", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-surge-ready-"));
    roots.push(root);
    const gate = createSurgeReadinessGate(root);

    await expect(gate.released()).resolves.toBe(false);
    await Promise.all([
      gate.release({ targetPodUid: "pod-123" }),
      gate.release({ targetPodUid: "pod-123" }),
    ]);

    await expect(createSurgeReadinessGate(root).released()).resolves.toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(root, ".surge-handoff-ready.json"), "utf8")))
      .toEqual({ targetPodUid: "pod-123" });
  });

  it("does not trust a readiness marker written by another pod", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-surge-ready-"));
    roots.push(root);
    await fs.promises.writeFile(
      path.join(root, ".surge-handoff-ready.json"),
      JSON.stringify({ targetPodUid: "pod-old" }),
    );

    await expect(createSurgeReadinessGate(root, "pod-new").released()).resolves.toBe(false);
    await expect(createSurgeReadinessGate(root, "pod-old").released()).resolves.toBe(true);
  });
});
