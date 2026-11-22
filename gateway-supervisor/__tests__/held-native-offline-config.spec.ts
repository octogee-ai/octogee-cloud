import { describe, expect, it, vi } from "vitest";
import { applyHeldNativeStagedConfig } from "../lib/held-native-offline-config.js";
import type { OpenClawCommand } from "../lib/openclaw-cli.js";

const expected = { agents: { entries: { "octogee-owner-coach": { identity: { name: "Current owner" } } } } };
const old = { agents: { entries: { "octogee-owner-coach": { identity: { name: "Prior owner", stale: true } } } } };
const path = "agents.entries.octogee-owner-coach.identity";

function fixture(original = old) {
  const environment = { OPENCLAW_CONFIG_PATH: "/synthetic/stage/openclaw.json" };
  const stage = {
    environment,
    read: vi.fn().mockResolvedValue({ value: original, contentSha256: "a".repeat(64) }),
    assertPrivateStaging: vi.fn().mockResolvedValue(undefined),
    assertOwnerAnchorsAndRoster: vi.fn().mockResolvedValue(undefined),
  };
  const assertHeld = vi.fn().mockResolvedValue(undefined);
  const compose = () => ({ patch: expected, replacePaths: [path] });
  const runNative = vi.fn<OpenClawCommand>().mockResolvedValue({ code: 0, stdout: "synthetic output" });
  return { stage, assertHeld, compose, runNative };
}

describe("held Native offline config staging", () => {
  it("applies the authored projection through Native and validates the actual resulting file", async () => {
    const f = fixture();
    f.stage.read.mockResolvedValueOnce({ value: old, contentSha256: "a".repeat(64) })
      .mockResolvedValueOnce({ value: expected, contentSha256: "b".repeat(64) });
    await expect(applyHeldNativeStagedConfig(f)).resolves.toEqual({ beforeSha256: "a".repeat(64), stagedSha256: "b".repeat(64), changed: true });
    expect(f.runNative.mock.calls.map(([args]) => args)).toEqual([
      ["config", "patch", "--stdin", "--replace-path", path, "--dry-run", "--json"],
      ["config", "patch", "--stdin", "--replace-path", path],
      ["config", "validate", "--json"],
    ]);
    expect(f.runNative.mock.calls[1]?.[1].stdin).toBe(JSON.stringify(expected));
    expect(f.stage.assertOwnerAnchorsAndRoster).toHaveBeenLastCalledWith(expected);
  });

  it("validates a matching home without writing and refuses an unverified private stage", async () => {
    const f = fixture(expected);
    await expect(applyHeldNativeStagedConfig(f)).resolves.toMatchObject({ changed: false });
    expect(f.runNative).toHaveBeenCalledTimes(2);
    const failed = fixture();
    failed.stage.assertPrivateStaging.mockRejectedValueOnce(new Error("unsafe stage"));
    await expect(applyHeldNativeStagedConfig(failed)).rejects.toThrow("unsafe stage");
    expect(failed.runNative).not.toHaveBeenCalled();
  });

  it("refuses stale replacement fields, changed hold or a Native operation reporting failure", async () => {
    const wrong = fixture();
    await expect(applyHeldNativeStagedConfig(wrong)).rejects.toThrow("complete mounted config");
    const lost = fixture();
    lost.runNative.mockImplementationOnce(async () => {
      lost.assertHeld.mockRejectedValueOnce(new Error("held claim changed"));
      return { code: 0, stdout: "" };
    });
    await expect(applyHeldNativeStagedConfig(lost)).rejects.toThrow("claim changed");
    expect(lost.runNative).toHaveBeenCalledTimes(1);
    const bad = fixture();
    bad.runNative.mockResolvedValueOnce({ code: 1, stdout: "must not be exposed" });
    await expect(applyHeldNativeStagedConfig(bad)).rejects.toThrow("command refused");
  });
});
