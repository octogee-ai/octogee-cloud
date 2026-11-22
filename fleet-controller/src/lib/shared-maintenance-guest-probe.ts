import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isValidUsername, parseAgentId } from "@octogee/shared/types/identity";

type Owner = { uid: string; slug: string; epoch: number };
type ProbeScope = { namespace: string; gatewayId: string; podUid: string; owners: Owner[] };
type Locations = { home: string; proc: string; temporary: string; nativeBuild: string };

async function homeIdentity(root: string, owner: Owner, agentIds: string[]) {
  const tree = path.join(root, ".openclaw");
  const rootStat = await fs.lstat(root, { bigint: true });
  const hash = createHash("sha256");
  function record(row: unknown[]) {
    hash.update(JSON.stringify(row) + "\n");
  }
  async function inode(relative: string) {
    const stat = await fs.lstat(path.join(tree, relative), { bigint: true });
    if (!stat.isDirectory() || stat.dev !== rootStat.dev)
      throw new Error("Shared maintenance lost an owner directory");
    record([relative, String(stat.dev), String(stat.ino), String(stat.uid), String(stat.gid)]);
  }
  async function keys(relative: string) {
    const here = path.join(tree, relative);
    const names = (await fs.readdir(here, { withFileTypes: true })).sort((a, b) =>
      Buffer.from(a.name).compare(Buffer.from(b.name)),
    );
    for (const entry of names) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        await inode(name);
        await keys(name);
        continue;
      }
      if (!entry.isFile()) throw new Error("Shared owner key entry is not an ordinary file");
      const file = await fs.open(
        path.join(tree, name),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const before = await file.stat({ bigint: true });
        if (!before.isFile() || before.dev !== rootStat.dev)
          throw new Error("Shared owner key changed before read");
        const digest = createHash("sha256");
        for await (const bytes of file.createReadStream({ autoClose: false })) digest.update(bytes);
        const after = await file.stat({ bigint: true });
        if (before.ctimeNs !== after.ctimeNs || before.size !== after.size)
          throw new Error("Shared owner key changed during verification");
        record([
          name,
          String(before.mode),
          String(before.uid),
          String(before.gid),
          digest.digest("hex"),
        ]);
      } finally {
        await file.close();
      }
    }
    return names.length;
  }
  record([owner.uid, owner.slug, owner.epoch, String(rootStat.dev), String(rootStat.ino)]);
  for (const base of ["customers", "customer-keys", "git-metadata"])
    await inode(path.join(base, owner.slug));
  for (const id of agentIds) await inode(path.join("agents", id));
  if (!agentIds.length || !(await keys(path.join("customer-keys", owner.slug))))
    throw new Error("Shared owner identity is incomplete");
  return { ...owner, homeIdentitySha256: hash.digest("hex") };
}

async function transferState(locations: Locations) {
  const tmp = await fs.readdir(locations.temporary);
  const temporaryEntries = tmp.filter((n) =>
    ["migration-rsync-", "migration-activation-", "octogee-migration-stage-"].some((p) =>
      n.startsWith(p),
    ),
  ).length;
  const processes = (await fs.readdir(locations.proc)).filter((n) => /^\d+$/.test(n));
  const names = await Promise.all(
    processes.map((n) =>
      fs
        .readFile(path.join(locations.proc, n, "comm"), "utf8")
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT" || error.code === "ESRCH") return "";
          throw error;
        }),
    ),
  );
  const tables = await Promise.all(
    ["tcp", "tcp6"].map((n) => fs.readFile(path.join(locations.proc, "net", n), "utf8")),
  );
  const sockets = tables.flatMap((table) =>
    table
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => {
        const columns = line.trim().split(/\s+/);
        return { port: Number.parseInt(columns[1]!.split(":")[1]!, 16), state: columns[3]! };
      }),
  );
  return {
    rsyncProcesses: names.filter((n) => n.trim() === "rsync").length,
    temporaryEntries,
    controlSockets: sockets.filter((x) => x.port === 3003).map((x) => x.state),
    transferSockets: sockets.filter((x) => x.port === 30873).map((x) => x.state),
  };
}

export async function observeSharedGuest(
  scope: ProbeScope,
  env: NodeJS.ProcessEnv,
  locations: Locations,
) {
  if (
    !scope.namespace ||
    scope.namespace !== env.K8S_NAMESPACE ||
    scope.podUid !== env.POD_UID ||
    scope.gatewayId !== env.GATEWAY_ID ||
    scope.owners.length !== 6 ||
    new Set(scope.owners.map((o) => o.uid)).size !== 6 ||
    new Set(scope.owners.map((o) => o.slug)).size !== 6 ||
    scope.owners.some((o) => !isValidUsername(o.slug) || !o.uid || !Number.isSafeInteger(o.epoch))
  )
    throw new Error("Shared maintenance guest scope changed");
  const agentIds = (
    await fs.readdir(path.join(locations.home, ".openclaw", "agents"), { withFileTypes: true })
  )
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const owners = await Promise.all(
    scope.owners.map((owner) =>
      homeIdentity(
        locations.home,
        owner,
        agentIds.filter((id) => {
          const parsed = parseAgentId(id);
          return parsed.kind !== "unknown" && parsed.username === owner.slug;
        }),
      ),
    ),
  );
  const native: unknown = JSON.parse(await fs.readFile(locations.nativeBuild, "utf8"));
  if (
    !native ||
    typeof native !== "object" ||
    !("commit" in native) ||
    typeof native.commit !== "string" ||
    !/^[a-f0-9]{40}$/.test(native.commit)
  )
    throw new Error("Shared Native build identity is missing");
  return {
    podUid: scope.podUid,
    gatewayId: scope.gatewayId,
    owners,
    nativeSource: native.commit,
    ...(await transferState(locations)),
  };
}

if (process.argv[1] === "-" && process.argv[2] === "observe-retained-shared-member") {
  const scope = JSON.parse(Buffer.from(process.argv[3]!, "base64").toString("utf8")) as ProbeScope;
  console.log(
    JSON.stringify(
      await observeSharedGuest(scope, process.env, {
        home: "/home/node",
        proc: "/proc",
        temporary: "/tmp",
        nativeBuild: "/usr/local/lib/node_modules/openclaw/dist/build-info.json",
      }),
    ),
  );
}
