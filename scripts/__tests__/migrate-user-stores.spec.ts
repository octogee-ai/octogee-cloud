import { afterEach, expect, it, vi } from "vitest";
import { migrateUserStores } from "../ops/migrate-user-stores.js";

const client = vi.hoisted(() => ({ migrateUserStores: vi.fn(), permitNormal: vi.fn() }));
vi.mock("../lib/surge-openclaw-process-gate.js", () => ({ createSurgeOpenClawProcessSupervisorClient: () => client }));
afterEach(() => { vi.resetAllMocks(); vi.restoreAllMocks(); });
const env = { GATEWAY_CLASS: "isolated", GATEWAY_ID: "source", OPENCLAW_DIR: "/fixture" };

it("requires an explicit allocation and apply flag before stopping anything", async () => {
  await expect(migrateUserStores([], env)).rejects.toThrow("expected-pod-uid");
  expect(client.migrateUserStores).not.toHaveBeenCalled();
});

it("leaves the repaired user held by default", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  client.migrateUserStores.mockResolvedValue({ podUid: "source-pod", mode: "held", phase: "held" });
  await migrateUserStores(["--expected-pod-uid=source-pod", "--apply"], env);
  expect(client.migrateUserStores).toHaveBeenCalledExactlyOnceWith("source-pod");
  expect(client.permitNormal).not.toHaveBeenCalled();
});

it("resumes only after a successful repair when explicitly requested", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  client.migrateUserStores.mockResolvedValue({ podUid: "source-pod", mode: "held", phase: "held" });
  client.permitNormal.mockResolvedValue({ podUid: "source-pod", mode: "permitted", phase: "running" });
  await migrateUserStores(["--expected-pod-uid=source-pod", "--apply", "--resume"], env);
  expect(client.migrateUserStores.mock.invocationCallOrder[0]).toBeLessThan(client.permitNormal.mock.invocationCallOrder[0]);
});

it("does not resume after a failed repair even when resume was requested", async () => {
  client.migrateUserStores.mockRejectedValue(new Error("retained workboard"));
  await expect(migrateUserStores(["--expected-pod-uid=source-pod", "--apply", "--resume"], env)).rejects.toThrow("retained workboard");
  expect(client.permitNormal).not.toHaveBeenCalled();
});
