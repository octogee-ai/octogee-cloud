import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { observeSharedGuest } from "../lib/shared-maintenance-guest-probe.js";

it("binds the retained six home directories, key contents and Native build to the unique Pod while observing legacy transfer state", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shared-probe-"));
  try {
    const locations = {
      home: root,
      proc: path.join(root, "proc"),
      temporary: path.join(root, "tmp"),
      nativeBuild: path.join(root, "build.json"),
    };
    const owners = ["birch", "ash", "oak", "maple", "alder", "elm"].map((slug, i) => ({
      uid: "fixture-" + slug,
      slug,
      epoch: i,
    }));
    const scope = { owners, gatewayId: "shared", namespace: "test", podUid: "pod" };
    const env = { POD_UID: "pod", GATEWAY_ID: "shared", K8S_NAMESPACE: "test" };
    await mkdir(locations.temporary);
    await mkdir(path.join(locations.proc, "net"), { recursive: true });
    await writeFile(
      path.join(locations.proc, "net", "tcp"),
      "header\n  5: 00000000:0BBB 00000000:0000 0A\n",
    );
    await writeFile(path.join(locations.proc, "net", "tcp6"), "header\n");
    await writeFile(locations.nativeBuild, JSON.stringify({ commit: "a".repeat(40) }));
    for (const owner of owners) {
      for (const base of ["customers", "customer-keys", "git-metadata"])
        await mkdir(path.join(root, ".openclaw", base, owner.slug), { recursive: true });
      await mkdir(path.join(root, ".openclaw", "agents", "octogee-" + owner.slug + "-coach"), {
        recursive: true,
      });
      await writeFile(
        path.join(root, ".openclaw", "customer-keys", owner.slug, "identity"),
        "fixture-" + owner.slug,
      );
    }
    const before = await observeSharedGuest(scope, env, locations);
    expect(before.controlSockets).toEqual(["0A"]);
    expect(before.temporaryEntries).toBe(0);
    expect(new Set(before.owners.map((o) => o.homeIdentitySha256)).size).toBe(6);
    await writeFile(path.join(root, ".openclaw/customer-keys/birch/identity"), "changed-fixture");
    await mkdir(path.join(locations.temporary, "migration-rsync-fixture"));
    const after = await observeSharedGuest(scope, env, locations);
    expect(after.temporaryEntries).toBe(1);
    expect(after.owners.slice(1)).toEqual(before.owners.slice(1));
    expect(after.owners[0]!.homeIdentitySha256).not.toBe(before.owners[0]!.homeIdentitySha256);
    await expect(
      observeSharedGuest(scope, { ...env, POD_UID: "another" }, locations),
    ).rejects.toThrow(/scope/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
