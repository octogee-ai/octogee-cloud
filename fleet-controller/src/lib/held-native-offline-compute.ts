import { GoogleAuth } from "google-auth-library";
import type { GceBoot, ReadOfflineReturnCompute } from "./held-native-offline-custody.js";

interface ComputeDisk {
  id: string;
  users?: string[];
  sourceImageId?: string;
  sourceSnapshotId?: string;
}

interface ComputeInstance {
  id: string;
  status: string;
  lastStopTimestamp?: string;
  lastStartTimestamp?: string;
  networkInterfaces?: { accessConfigs?: unknown[]; ipv6AccessConfigs?: unknown[] }[];
  serviceAccounts?: { email: string }[];
  disks: { boot?: boolean; source: string; mode: "READ_ONLY" | "READ_WRITE" }[];
}

interface ComputeSnapshot {
  id: string;
  sourceDiskId: string;
  creationTimestamp: string;
  status: string;
}

type GetCompute = <T>(url: string) => Promise<T>;
const computeOrigin = "https://compute.googleapis.com/compute/v1/";
const segment = /^[a-z][a-z0-9-]{0,62}$/;
const providerId = /^[1-9]\d*$/;

function relativeComputeLink(link: string): string {
  const url = new URL(link);
  if (url.protocol !== "https:" || !["compute.googleapis.com", "www.googleapis.com"].includes(url.host) ||
      url.search || url.hash || url.username || url.password || !url.pathname.startsWith("/compute/v1/projects/")) {
    throw new Error("Held Native offline Compute attachment has an unexpected resource path");
  }
  return url.pathname.slice("/compute/v1/".length);
}

function attachedResource(source: string, projectId: string, zone: string): string {
  const relative = relativeComputeLink(source);
  const prefix = `projects/${projectId}/zones/${zone}/disks/`;
  if (!relative.startsWith(prefix) || !segment.test(relative.slice(prefix.length))) {
    throw new Error("Held Native offline Compute attachment escaped the exact project or zone");
  }
  return `${computeOrigin}${relative}`;
}

function makeReadOnlyCompute(): GetCompute {
  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/compute.readonly"] });
  async function read<T>(url: string): Promise<T> {
    const client = await auth.getClient();
    return (await client.request<T>({ url, method: "GET" })).data;
  }
  return read;
}

export function createHeldNativeOfflineComputeReader(projectId: string, read = makeReadOnlyCompute()): ReadOfflineReturnCompute {
  if (!segment.test(projectId)) throw new Error("Held Native offline Compute project is invalid");
  const base = `${computeOrigin}projects/${projectId}/`;
  const assertProjectZone = (project: string, zone: string) => {
    if (project !== projectId || !segment.test(zone)) throw new Error("Held Native offline Compute project or zone was not authorized");
  };
  const exact = async <T extends { id: string }>(collection: string, id: string): Promise<T | null> => {
    if (!providerId.test(id)) throw new Error("Held Native offline Compute resource ID is not numeric");
    const url = new URL(collection, base);
    url.searchParams.set("filter", `id = ${id}`);
    const { items, nextPageToken } = await read<{ items?: T[]; nextPageToken?: string }>(url.href);
    if (nextPageToken || (items?.length ?? 0) > 1) throw new Error("Held Native offline Compute lookup was not unique");
    const resource = items?.[0] ?? null;
    if (resource && resource.id !== id) throw new Error("Held Native offline Compute lookup returned a foreign resource");
    return resource;
  };

  return {
    async instance(expected: GceBoot) {
      const { projectId: observedProject, zone, instanceName } = expected;
      assertProjectZone(observedProject, zone);
      if (!segment.test(instanceName)) throw new Error("Held Native offline Compute instance name is invalid");
      const vm = await read<ComputeInstance>(`${base}zones/${zone}/instances/${instanceName}`);
      if (vm.id !== expected.instanceId) return null;
      const observed = await Promise.all(vm.disks.map(async disk => ({
        ...disk, data: await read<ComputeDisk>(attachedResource(disk.source, projectId, zone)),
      })));
      const boot = observed.filter(disk => disk.boot);
      if (boot.length !== 1 || !boot[0].data.sourceImageId) throw new Error("Held Native offline Compute boot provenance is ambiguous");
      return {
        projectId, zone, instanceName, instanceId: vm.id, bootDiskId: boot[0].data.id, bootImageId: boot[0].data.sourceImageId,
        status: vm.status, lastStoppedAt: vm.lastStopTimestamp ? Date.parse(vm.lastStopTimestamp) : null,
        lastStartedAt: vm.lastStartTimestamp ? Date.parse(vm.lastStartTimestamp) : null,
        publicAccess: (vm.networkInterfaces ?? []).some(network => Boolean(network.accessConfigs?.length || network.ipv6AccessConfigs?.length)),
        serviceAccounts: (vm.serviceAccounts ?? []).map(account => account.email).sort(),
        attachedDisks: observed.map(disk => ({ id: disk.data.id, mode: disk.mode })),
      };
    },
    async disk(project, zone, id) {
      assertProjectZone(project, zone);
      const resource = await exact<ComputeDisk>(`zones/${zone}/disks`, id);
      return resource ? { projectId, id: resource.id, sourceSnapshotId: resource.sourceSnapshotId ?? null,
        users: (resource.users ?? []).map(relativeComputeLink) } : null;
    },
    async snapshot(project, id) {
      if (project !== projectId) throw new Error("Held Native offline snapshot project was not authorized");
      const resource = await exact<ComputeSnapshot>("global/snapshots", id);
      return resource ? { projectId, id: resource.id, sourceDiskId: resource.sourceDiskId,
        status: resource.status, createdAt: Date.parse(resource.creationTimestamp) } : null;
    },
  };
}
