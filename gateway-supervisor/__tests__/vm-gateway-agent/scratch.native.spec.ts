import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createDockerEngine, createContainer, startContainer, waitContainer, removeContainer, setContainerPaused, type DockerEngine } from "../../lib/vm-gateway-agent/docker-engine.js";
import { prepareScratchVolumes, scratchVolumeName, inspectInactiveScratchVolumes } from "../../lib/vm-gateway-agent/scratch.js";

import { planBundle } from "../../lib/vm-gateway-agent/plan.js";
import { bundleFixture } from "./fixture.js";

const native = process.env.OCTOGEE_NATIVE_DOCKER_TEST === "1";
describe.skipIf(!native)("native host Docker scratch custody", () => {
  it("retains one writable scratch backing across five gateway rebindings on the same VM", async () => {
    const engine = createDockerEngine({ socketPath: process.env.OCTOGEE_NATIVE_DOCKER_SOCKET });
    const vmId = BigInt(`0x${randomUUID().replaceAll("-", "")}`).toString();
    const image = process.env.OCTOGEE_NATIVE_DOCKER_IMAGE || "node:22-bookworm-slim";
    const name = scratchVolumeName(vmId, "builder-cache");
    const writer = `scratch-writer-${randomUUID()}`;
    try {
      for (let lease = 0; lease < 5; lease++) {
        await prepareScratchVolumes({ engine, image, vmId, stateRoot: "/srv/octogee", names: ["builder-cache"], beforeCreate: async () => {
          if (lease > 0) throw new Error("no boot headroom for a new allocation");
        } });
        const bundle = bundleFixture({ gatewayId: `b-${lease}` });
        bundle.volumes.push({ name: "builder-cache", kind: "ephemeral" });
        bundle.containers[0].mounts.push({ volume: "builder-cache", mountPath: "/scratch", readOnly: false, subPath: null });
        const binds = (planBundle(bundle, { stateRoot: "/srv/octogee", instanceId: vmId, desktopAuth: false }).services[0].config.HostConfig as { Binds: string[] }).Binds.filter(bind => bind.endsWith(":/scratch"));
        expect(binds).toEqual([`${name}:/scratch`]);
        const code = lease === 0 ? "require('fs').writeFileSync('/scratch/acknowledged.txt','native write');"
          : "if(require('fs').readFileSync('/scratch/acknowledged.txt','utf8')!=='native write')process.exit(2);";
        await createContainer(engine, writer, { Image: image, User: "1000:1000", NetworkDisabled: true,
          Entrypoint: ["node", "-e", code], HostConfig: { Binds: binds, ReadonlyRootfs: true } });
        await startContainer(engine, writer);
        expect(await waitContainer(engine, writer)).toBe(0);
        await removeContainer(engine, writer);
      }
      const inventory = await engine.request<{ Volumes: Array<{ Name: string; Labels: Record<string, string> }> }>("GET", "/volumes");
      expect(inventory.body.Volumes.filter(volume => volume.Labels?.["ai.octogee.computer-id"] === vmId).map(volume => volume.Name)).toEqual([name]);
    } finally {
      await removeContainer(engine, writer);
      await engine.request("DELETE", `/volumes/${name}`);
    }
  }, 60_000);
  it("retains caches of other VMs, including running/paused/stopped references and durable volumes", async () => {
    const engine = createDockerEngine({ socketPath: process.env.OCTOGEE_NATIVE_DOCKER_SOCKET });
    const run = randomUUID();
    const image = process.env.OCTOGEE_NATIVE_DOCKER_IMAGE || "node:22-bookworm-slim";
    const owners = Array.from({ length: 5 }, (_, index) => `scratch-${run}-${index}`);
    const names = new Set(owners.map(owner => scratchVolumeName(owner, "builder-cache")));
    const durable = `scratch-durable-${run}`;
    const actor = `scratch-actor-${run}`;
    const scoped: DockerEngine = { request: async <T>(method: string, path: string, body?: unknown) => {
      if (method === "DELETE" && path.startsWith("/volumes/") && !names.has(decodeURIComponent(path.slice("/volumes/".length)))) {
        throw new Error("native test refuses deletion outside its owned scratch names");
      }
      const response = await engine.request<T>(method, path, body);
      if (path.startsWith("/volumes?")) {
        const inventory = response.body as { Volumes?: Array<{ Name: string }> | null };
        return { ...response, body: { ...inventory, Volumes: inventory.Volumes?.filter(volume => names.has(volume.Name)) ?? [] } as T };
      }
      return response;
    } };
    const log = (message: string) => expect(message).toContain("exclusive writer custody unavailable");
    const inspect = (vmId: string) => inspectInactiveScratchVolumes({ engine: scoped, vmId, stateRoot: "/srv/octogee", log });
    try {
      expect((await engine.request("POST", "/volumes/create", { Name: durable, Driver: "local" })).status).toBe(201);
      await prepareScratchVolumes({ engine, image, vmId: owners[0], stateRoot: "/srv/octogee", names: ["builder-cache"], beforeCreate: async () => {} });
      await createContainer(engine, actor, { Image: image, User: "1000:1000", NetworkDisabled: true,
        Entrypoint: ["node", "-e", "setInterval(()=>{},1000)"],
        HostConfig: { Binds: [`${scratchVolumeName(owners[0], "builder-cache")}:/scratch`], ReadonlyRootfs: true } });
      await startContainer(engine, actor);
      await prepareScratchVolumes({ engine, image, vmId: owners[1], stateRoot: "/srv/octogee", names: ["builder-cache"], beforeCreate: async () => {} });
      expect(await inspect(owners[1])).toEqual([]);
      await setContainerPaused(engine, actor, true);
      expect(await inspect(owners[1])).toEqual([]);
      await setContainerPaused(engine, actor, false);
      expect((await engine.request("POST", `/containers/${actor}/stop?t=1`)).status).toBe(204);
      expect(await inspect(owners[1])).toEqual([]);
      await removeContainer(engine, actor);
      expect(await inspect(owners[1])).toEqual([scratchVolumeName(owners[0], "builder-cache")]);
      const retainedNames = [scratchVolumeName(owners[0], "builder-cache")];
      for (const owner of owners.slice(1)) {
        await prepareScratchVolumes({ engine, image, vmId: owner, stateRoot: "/srv/octogee", names: ["builder-cache"], beforeCreate: async () => {} });
        const name = scratchVolumeName(owner, "builder-cache");
        retainedNames.push(name);
        await createContainer(engine, actor, { Image: image, User: "1000:1000", NetworkDisabled: true,
          Entrypoint: ["node", "-e", "require('fs').writeFileSync('/scratch/acknowledged',Buffer.alloc(512*1024,42));"],
          HostConfig: { Binds: [`${name}:/scratch`], ReadonlyRootfs: true } });
        await startContainer(engine, actor);
        expect(await waitContainer(engine, actor)).toBe(0);
        await removeContainer(engine, actor);
        await inspect(owner);
        const inventory = await engine.request<{ Volumes: Array<{ Name: string; UsageData: { Size: number } }> }>("GET", "/system/df");
        const retained = inventory.body.Volumes.filter(volume => names.has(volume.Name));
        expect(retained.map(volume => volume.Name).sort()).toEqual(retainedNames.sort());
        expect(retained.reduce((size, volume) => size + volume.UsageData.Size, 0)).toBeGreaterThanOrEqual((retainedNames.length - 1) * 512 * 1024);
        expect((await engine.request("GET", `/volumes/${durable}`)).status).toBe(200);
      }
    } finally {
      await removeContainer(engine, actor);
      for (const name of [...names, durable]) {
        const response = await engine.request("DELETE", `/volumes/${name}`);
        expect([204, 404]).toContain(response.status);
      }
    }
  }, 60_000);

  it("preserves an acknowledged bind writer admitted after the volume inventory", async () => {
    const engine = createDockerEngine({ socketPath: process.env.OCTOGEE_NATIVE_DOCKER_SOCKET });
    const run = promisify(execFile);
    const owner = `scratch-race-${randomUUID()}`;
    const image = process.env.OCTOGEE_NATIVE_DOCKER_IMAGE || "node:22-bookworm-slim";
    const name = scratchVolumeName(owner, "builder-cache");
    const actor = `scratch-bind-${randomUUID()}`;
    let inventoried = false;
    let acknowledged = false;
    const scoped: DockerEngine = { request: async <T>(method: string, path: string, body?: unknown) => {
      if (method === "DELETE" && path.startsWith("/volumes/") && path !== `/volumes/${name}`) throw new Error("test refuses deletion outside its own volume");
      const response = await engine.request<T>(method, path, body);
      if (path.startsWith("/volumes?")) {
        const inventory = response.body as { Volumes?: Array<{ Name: string }> | null };
        return { ...response, body: { ...inventory, Volumes: inventory.Volumes?.filter(volume => volume.Name === name) ?? [] } as T };
      }
      if (path.startsWith("/containers/json?")) inventoried = true;
      if (method === "GET" && path === `/volumes/${name}` && inventoried && !acknowledged) {
        const volume = response.body as { Mountpoint: string };
        await createContainer(engine, actor, { Image: image, NetworkDisabled: true,
          Entrypoint: ["node", "-e", "setInterval(()=>{},1000)"],
          HostConfig: { Mounts: [{ Type: "bind", Source: volume.Mountpoint, Target: "/scratch" }], ReadonlyRootfs: true } });
        await startContainer(engine, actor);
        const write = await run("docker", ["exec", actor, "node", "-e", "require('fs').writeFileSync('/scratch/acknowledged','bind actor acknowledged bytes');process.stdout.write('ACK');"]);
        expect(write.stdout).toBe("ACK");
        acknowledged = true;
      }
      return response;
    } };
    try {
      await prepareScratchVolumes({ engine, image, vmId: owner, stateRoot: "/srv/octogee", names: ["builder-cache"], beforeCreate: async () => {} });
      await inspectInactiveScratchVolumes({ engine: scoped, vmId: "current-race-owner", stateRoot: "/srv/octogee", log: () => {} });
      expect(acknowledged).toBe(true);
      const state = await engine.request<{ State: { Running: boolean } }>("GET", `/containers/${actor}/json`);
      expect(state.body.State.Running).toBe(true);
      const read = await run("docker", ["exec", actor, "node", "-e", "process.stdout.write(require('fs').readFileSync('/scratch/acknowledged','utf8'));"], { timeout: 5_000 })
        .catch(error => ({ stdout: `MISSING: ${error.stderr}` }));
      expect(read.stdout).toBe("bind actor acknowledged bytes");
    } finally {
      await removeContainer(engine, actor);
      const result = await engine.request("DELETE", `/volumes/${name}`);
      expect([204, 404]).toContain(result.status);
    }
  }, 30_000);

});
