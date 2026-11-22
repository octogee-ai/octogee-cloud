import { describe, expect, it, vi } from "vitest";
import { acquireHeldContainerWriters } from "../../lib/vm-gateway-agent/held-container-writers.js";
import type { DockerEngine } from "../../lib/vm-gateway-agent/docker-engine.js";

function fixture() {
  const writers = [{ name: "writer-one", id: "a".repeat(64) }, { name: "writer-two", id: "b".repeat(64) }];
  const states = writers.map(({ name, id }) => ({
    name, Id: id, State: { Running: true, Paused: false },
    HostConfig: { RestartPolicy: { Name: "on-failure", MaximumRetryCount: 0 } },
  }));
  const assertHostHold = vi.fn(async () => {});
  const calls: string[] = [];
  const request = vi.fn(async (_method: string, path: string, body?: { RestartPolicy: { Name: string } }) => {
    const [, , name, action] = path.split("/");
    const state = states.find(row => row.name === name || row.Id === name);
    if (!state) return { status: 404, body: null };
    if (action === "json") return { status: 200, body: structuredClone(state) };
    calls.push(`${name}:${action}`);
    if (action === "update" && body) state.HostConfig.RestartPolicy.Name = body.RestartPolicy.Name;
    if (action === "pause" || action === "unpause") state.State.Paused = action === "pause";
    return { status: 204, body: null };
  });
  return { states, writers, assertHostHold, calls, engine: { request } as unknown as DockerEngine };
}

describe("holding the exact disposable Native guest container writers", () => {
  it("mutates only exact IDs and restores the same known restart policy on release", async () => {
    const f = fixture();
    const hold = await acquireHeldContainerWriters(f);
    expect(f.states.every(row => row.State.Paused && row.HostConfig.RestartPolicy.Name === "no")).toBe(true);
    expect(f.calls).toEqual(f.writers.flatMap(({ id }) => [`${id}:update`, `${id}:pause`]));
    await hold.assertHeld();
    await hold.release();
    expect(f.states.every(row => !row.State.Paused && row.HostConfig.RestartPolicy.Name === "on-failure")).toBe(true);
    await expect(hold.assertHeld()).rejects.toThrow(/hold is ending/);
  });

  it("does not pause any writer if the authorized roster is stale at acquisition", async () => {
    const f = fixture();
    f.states[1]!.Id = "c".repeat(64);
    await expect(acquireHeldContainerWriters(f)).rejects.toThrow(/writer-two.*expected identity/);
    expect(f.calls).toEqual([]);
  });

  it("reports a replacement without unpausing it or releasing another writer", async () => {
    const f = fixture();
    const hold = await acquireHeldContainerWriters(f);
    const before = [...f.calls];
    f.states[1]!.Id = "c".repeat(64);
    await expect(hold.release()).rejects.toThrow(/writer-two.*expected identity/);
    expect(f.calls).toEqual(before);
  });

  it("keeps the writers paused when the external host hold is lost", async () => {
    const f = fixture();
    const hold = await acquireHeldContainerWriters(f);
    f.assertHostHold.mockRejectedValueOnce(new Error("trusted host hold lost"));
    await expect(hold.release()).rejects.toThrow(/trusted host hold lost/);
    expect(f.states.every(row => row.State.Paused)).toBe(true);
  });
});
