import { describe, expect, it, vi } from "vitest";
import { captureHomeSnapshot, discardHomeSnapshot, HOME_SNAPSHOT_CONTAINER, HOME_SNAPSHOT_TIMEOUT_MS } from "../../lib/vm-gateway-agent/home-snapshot";
import type { DockerEngine } from "../../lib/vm-gateway-agent/docker-engine";

function fixture() {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const state = { code: 0, timeout: false, cleanupFailed: false };
  let deletes = 0;
  const engine: DockerEngine = {
    request: async (method, path, body) => {
      calls.push({ method, path, body });
      if (path.endsWith("/json")) return { status: 200, body: { Image: "sha256:agent-image" } as never };
      if (method === "DELETE") {
        if (++deletes > 1 && state.cleanupFailed) throw new Error("remove failed");
        return { status: 204, body: "" as never };
      }
      if (path.endsWith("/wait")) return state.timeout ? new Promise(() => {}) : { status: 200, body: { StatusCode: state.code } as never };
      return { status: 201, body: { Id: "helper" } as never };
    },
  };
  const deps = {
    engine, stateRoot: "/srv/octogee",
    fs: { mkdir: vi.fn(async () => {}), exists: vi.fn(async () => true) },
    shell: { run: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })) },
  };
  return { calls, state, deps };
}

describe("home snapshot helper", () => {
  it("captures a read-only btrfs snapshot with only the required capability and the running agent image", async () => {
    const h = fixture();
    await captureHomeSnapshot(h.deps);
    expect(h.deps.shell.run).toHaveBeenCalledWith("sync", ["-f", "/srv/octogee"]);
    expect(h.deps.fs.mkdir).toHaveBeenCalledWith("/srv/octogee/.home-checkpoint", 0o700);
    expect(h.calls.find((call) => call.path.startsWith("/containers/create"))?.body).toEqual({
      Image: "sha256:agent-image", User: "0:0", NetworkDisabled: true,
      Entrypoint: ["/usr/bin/timeout", "--signal=KILL", "30s", "btrfs"],
      Env: ["PATH=/usr/sbin:/usr/bin:/sbin:/bin"],
      Cmd: ["subvolume", "snapshot", "-r", "/octogee-home", "/octogee-home/.home-checkpoint/snapshot"],
      HostConfig: {
        Binds: ["/srv/octogee:/octogee-home:rw"], NetworkMode: "none", ReadonlyRootfs: true,
        CapDrop: ["ALL"], CapAdd: ["SYS_ADMIN"], SecurityOpt: ["no-new-privileges"], PidsLimit: 16,
      },
    });
    expect(h.calls.at(-1)?.path).toBe(`/containers/${HOME_SNAPSHOT_CONTAINER}?force=true&v=false`);
  });

  it("deletes only the fixed snapshot and skips an absent snapshot", async () => {
    const h = fixture();
    await discardHomeSnapshot(h.deps);
    expect(h.calls.find((call) => call.path.startsWith("/containers/create"))?.body).toMatchObject({ Cmd: ["subvolume", "delete", "/octogee-home/.home-checkpoint/snapshot"] });
    h.calls.length = 0;
    h.deps.fs.exists.mockResolvedValue(false);
    await discardHomeSnapshot(h.deps);
    expect(h.calls).toEqual([]);
  });

  it("keeps both the snapshot failure and the failed cleanup visible", async () => {
    const h = fixture();
    h.state.code = 1;
    h.state.cleanupFailed = true;
    await expect(captureHomeSnapshot(h.deps)).rejects.toThrow("btrfs snapshot exited 1; Error: remove failed");
  });

  it("removes the helper when the Docker wait exceeds its deadline", async () => {
    vi.useFakeTimers();
    try {
      const h = fixture();
      h.state.timeout = true;
      const work = captureHomeSnapshot(h.deps);
      const failure = expect(work).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(HOME_SNAPSHOT_TIMEOUT_MS + 1);
      await failure;
      expect(h.calls.at(-1)?.method).toBe("DELETE");
    } finally { vi.useRealTimers(); }
  });
});
