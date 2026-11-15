import { createContainer, inspectContainer, removeContainer, startContainer, waitContainer, type DockerEngine } from "./docker-engine.js";
import type { HomeFs, HomeShell } from "./home-checkpoint.js";

export const HOME_SNAPSHOT_CONTAINER = "octogee-home-snapshot";
export const HOME_SNAPSHOT_TIMEOUT_MS = 35_000;
const SNAPSHOT_ROOT = "/octogee-home";
const SNAPSHOT_PATH = `${SNAPSHOT_ROOT}/.home-checkpoint/snapshot`;

type SnapshotDeps = {
  engine: DockerEngine;
  stateRoot: string;
  fs: Pick<HomeFs, "exists" | "mkdir">;
};

async function deadline<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`home snapshot helper timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function runBtrfs(deps: SnapshotDeps, args: string[]): Promise<void> {
  const agent = await deadline(inspectContainer(deps.engine, "octo-gateway-agent"), 5_000);
  if (!agent?.Image?.startsWith("sha256:")) throw new Error("home snapshot requires the running VM agent's immutable image ID");
  await deadline(removeContainer(deps.engine, HOME_SNAPSHOT_CONTAINER), 5_000);
  const errors: unknown[] = [];
  try {
    await deadline(createContainer(deps.engine, HOME_SNAPSHOT_CONTAINER, {
      Image: agent.Image,
      User: "0:0",
      NetworkDisabled: true,
      Entrypoint: ["/usr/bin/timeout", "--signal=KILL", "30s", "btrfs"],
      Env: ["PATH=/usr/sbin:/usr/bin:/sbin:/bin"],
      Cmd: args,
      HostConfig: {
        Binds: [`${deps.stateRoot}:${SNAPSHOT_ROOT}:rw`],
        NetworkMode: "none",
        ReadonlyRootfs: true,
        CapDrop: ["ALL"],
        CapAdd: ["SYS_ADMIN"],
        SecurityOpt: ["no-new-privileges"],
        PidsLimit: 16,
      },
    }), 5_000);
    await deadline(startContainer(deps.engine, HOME_SNAPSHOT_CONTAINER), 5_000);
    const code = await deadline(waitContainer(deps.engine, HOME_SNAPSHOT_CONTAINER), HOME_SNAPSHOT_TIMEOUT_MS);
    if (code !== 0) throw new Error(`home snapshot btrfs ${args[1]} exited ${code}`);
  } catch (error) {
    errors.push(error);
  } finally {
    try { await deadline(removeContainer(deps.engine, HOME_SNAPSHOT_CONTAINER), 5_000); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, `home snapshot helper failed: ${errors.map(String).join("; ")}`);
}

export async function captureHomeSnapshot(deps: SnapshotDeps & { shell: HomeShell }): Promise<void> {
  await deps.fs.mkdir(`${deps.stateRoot}/.home-checkpoint`, 0o700);
  const sync = await deps.shell.run("sync", ["-f", deps.stateRoot]);
  if (sync.code !== 0) throw new Error(`home snapshot sync failed: ${sync.stderr}`);
  await runBtrfs(deps, ["subvolume", "snapshot", "-r", SNAPSHOT_ROOT, SNAPSHOT_PATH]);
}

export async function discardHomeSnapshot(deps: SnapshotDeps): Promise<void> {
  if (await deps.fs.exists(`${deps.stateRoot}/.home-checkpoint/snapshot`)) {
    await runBtrfs(deps, ["subvolume", "delete", SNAPSHOT_PATH]);
  }
}
