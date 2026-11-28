import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { readPostgresAgentAnchor } from "@octogee/core/agent-postgres";
import { prepareFreshIsolatedPostgresState } from "../lib/isolated-postgres-bootstrap.js";
import { auxiliaryStorePath } from "../lib/user-auxiliary-anchors.js";
import { publishAnchor } from "../lib/postgres-anchor-file.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { force: true, recursive: true })));
});
async function fixture() {
  const stateDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "isolated-postgres-prepare-")));
  roots.push(stateDir);
  return {
    stateDir,
    env: { GATEWAY_CLASS: "isolated", GATEWAY_RUNTIME_KIND: "gce-vm", OPENCLAW_AGENT_STORE_DSN: "postgres://local-test/store" },
    noRecordedAnchors: true,
  };
}

it("publishes one exact identity before Native preparation and resumes that identity after interruption", async () => {
  const options = await fixture();
  const file = path.join(options.stateDir, "state", "openclaw.sqlite");
  const prepare = vi.fn(async (_opts, anchor) => {
    expect(readPostgresAgentAnchor(file)).toEqual(anchor);
  }).mockRejectedValueOnce(new Error("Native process stopped"));
  await expect(prepareFreshIsolatedPostgresState(options, prepare)).rejects.toThrow("Native process stopped");
  const anchor = readPostgresAgentAnchor(file);
  expect(anchor).not.toBeNull();
  expect(await prepareFreshIsolatedPostgresState(options, prepare)).toBe(true);
  expect(prepare.mock.calls[0]?.[1]).toEqual(anchor);
  expect(prepare.mock.calls[1]?.[1]).toEqual(anchor);
  expect(await prepareFreshIsolatedPostgresState(options, prepare)).toBe(false);
  expect(prepare).toHaveBeenCalledTimes(2);
});

it("leaves recorded stores and local WAL history to the existing initializer", async () => {
  const options = await fixture();
  const prepare = vi.fn();
  expect(await prepareFreshIsolatedPostgresState({ ...options, noRecordedAnchors: false }, prepare)).toBe(false);
  const file = path.join(options.stateDir, "state", "openclaw.sqlite-wal");
  await fs.mkdir(path.dirname(file));
  await fs.writeFile(file, "history");
  expect(await prepareFreshIsolatedPostgresState(options, prepare)).toBe(false);
  expect(await fs.readFile(file, "utf8")).toBe("history");
  expect(prepare).not.toHaveBeenCalled();
});

it("keeps local auxiliary history and refuses a symbolic preparation receipt", async () => {
  const options = await fixture();
  const prepare = vi.fn();
  const auxiliary = auxiliaryStorePath(options.stateDir, "logbook");
  await fs.mkdir(path.dirname(auxiliary));
  await fs.writeFile(auxiliary, "local history");
  expect(await prepareFreshIsolatedPostgresState(options, prepare)).toBe(false);
  expect(await fs.readFile(auxiliary, "utf8")).toBe("local history");
  await fs.symlink(auxiliary, path.join(options.stateDir, ".native-postgres-prepare"));
  await expect(prepareFreshIsolatedPostgresState(options, prepare)).rejects.toThrow();
  expect(prepare).not.toHaveBeenCalled();
});

it("recovers the exact atomic publication link left by interruption and no foreign links", async () => {
  const options = await fixture();
  const prepare = vi.fn().mockRejectedValueOnce(new Error("interrupted"));
  await expect(prepareFreshIsolatedPostgresState(options, prepare)).rejects.toThrow("interrupted");
  const file = path.join(options.stateDir, "state", "openclaw.sqlite");
  const anchor = readPostgresAgentAnchor(file)!;
  const foreign = path.join(options.stateDir, "other-link");
  await fs.link(file, foreign);
  await expect(prepareFreshIsolatedPostgresState(options, prepare)).rejects.toThrow("hard link");
  expect((await fs.stat(file)).nlink).toBe(2);
  await fs.unlink(foreign);
  const staging = path.join(options.stateDir, `.native-postgres-anchor-${anchor.storeId}.tmp`);
  await fs.link(file, staging);
  expect(await prepareFreshIsolatedPostgresState(options, prepare)).toBe(true);
  expect((await fs.stat(file)).nlink).toBe(1);
  expect(readPostgresAgentAnchor(file)).toEqual(anchor);
  await expect(fs.stat(staging)).rejects.toMatchObject({ code: "ENOENT" });
});

it("discards a partial staging file before publication and uses the original pending identity", async () => {
  const options = await fixture();
  const storeId = "8c4a923c-d36e-4ee8-bcaf-362a3c9f7e82";
  const staged = path.join(options.stateDir, `.native-postgres-anchor-${storeId}.tmp`);
  await fs.writeFile(path.join(options.stateDir, ".native-postgres-prepare"), storeId);
  await fs.writeFile(staged, "incomplete anchor");
  await fs.writeFile(`${staged}-journal`, "incomplete SQLite rollback journal");
  const prepare = vi.fn();
  expect(await prepareFreshIsolatedPostgresState(options, prepare)).toBe(true);
  expect(prepare.mock.calls[0]?.[1]).toEqual({ storeId, schema: "octogee_state_8c4a923cd36e4ee8" });
  await expect(fs.stat(staged)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(fs.stat(`${staged}-journal`)).rejects.toMatchObject({ code: "ENOENT" });
});

it("refuses to prepare foreign local or newly recorded state after interruption", async () => {
  const options = await fixture();
  const prepare = vi.fn().mockRejectedValueOnce(new Error("interrupted"));
  await expect(prepareFreshIsolatedPostgresState(options, prepare)).rejects.toThrow("interrupted");
  await expect(prepareFreshIsolatedPostgresState({ ...options, noRecordedAnchors: false }, prepare))
    .rejects.toThrow("Recorded Native state appeared");
  const file = path.join(options.stateDir, "state", "openclaw.sqlite");
  await fs.unlink(file);
  const foreign = { storeId: "8c4a923c-d36e-4ee8-bcaf-362a3c9f7e82", schema: "octogee_state_8c4a923cd36e4ee8" };
  await publishAnchor(file, foreign);
  await expect(prepareFreshIsolatedPostgresState(options, prepare)).rejects.toThrow("preserve the existing state anchor");
  expect(readPostgresAgentAnchor(file)).toEqual(foreign);
  expect(prepare).toHaveBeenCalledOnce();
});

it("uses native journal preparation for fresh owned isolated cluster pods and refuses foreign checkpoint slots", async () => {
  const options = await fixture();
  const cluster = { ...options, env: { ...options.env, GATEWAY_RUNTIME_KIND: "cluster", GATEWAY_ID: "gw-s-slot" } };
  const prepare = vi.fn();
  expect(await prepareFreshIsolatedPostgresState({
    ...cluster, env: { ...cluster.env, GATEWAY_ID: "" },
  }, prepare)).toBe(false);
  expect(await prepareFreshIsolatedPostgresState({
    ...cluster, env: { ...cluster.env, OCTOGEE_CHECKPOINT_SLOT_ID: "gw-s-another" },
  }, prepare)).toBe(false);
  expect(await prepareFreshIsolatedPostgresState({ ...cluster, noRecordedAnchors: false }, prepare)).toBe(false);
  expect(await prepareFreshIsolatedPostgresState({
    ...cluster, env: { ...cluster.env, OPENCLAW_AGENT_STORE_DSN: "" },
  }, prepare)).toBe(false);
  expect(await prepareFreshIsolatedPostgresState({
    ...cluster, noRecordedAnchors: false, noRecordedHostAnchors: true,
  }, prepare)).toBe(true);
  expect(prepare).toHaveBeenCalledOnce();
  expect(readPostgresAgentAnchor(path.join(cluster.stateDir, "state", "openclaw.sqlite"))).toEqual(prepare.mock.calls[0]?.[1]);
});

it("prepares a fresh isolated VM or checkpoint slot when only agent anchors exist on Shared", async () => {
  for (const extraEnv of [
    { GATEWAY_RUNTIME_KIND: "gce-vm" },
    { GATEWAY_RUNTIME_KIND: "cluster", GATEWAY_ID: "gw-s-slot", OCTOGEE_CHECKPOINT_SLOT_ID: "gw-s-slot" },
  ]) {
    const options = await fixture();
    const prepare = vi.fn();
    expect(await prepareFreshIsolatedPostgresState({
      ...options,
      env: { ...options.env, ...extraEnv },
      noRecordedAnchors: false,
      noRecordedHostAnchors: true,
    }, prepare)).toBe(true);
    expect(prepare).toHaveBeenCalledOnce();
    expect(readPostgresAgentAnchor(path.join(options.stateDir, "state", "openclaw.sqlite"))).toEqual(prepare.mock.calls[0]?.[1]);
  }
});
