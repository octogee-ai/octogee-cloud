import type { RetainedUserHome } from "@octogee/shared/types/glm";
import type { ComputeRequest } from "./compute-vm.js";

interface HomeDisk {
  id?: string; name?: string; sizeGb?: string; type?: string;
  labels?: Record<string, string>; labelFingerprint?: string; users?: string[];
}
interface HomeInstance {
  id?: string;
  status?: string;
  metadata?: { items?: Array<{ key?: string; value?: string }> };
  disks?: Array<{ boot?: boolean; source?: string; deviceName?: string; autoDelete?: boolean }>;
}
const missing = (error: unknown): boolean => (error as { response?: { status?: number }; code?: number })?.response?.status === 404 || (error as { code?: number })?.code === 404;
const VM_HOME_DISK_DEVICE_NAME = "octogee-home";
const ownerOf = (instance: HomeInstance | null): string | undefined => instance?.metadata?.items?.find(item => item.key === "octogee-owner-uid")?.value;

function assertStoppedHomeOwner(instance: HomeInstance | null, instanceId: string, ownerUid: string): void {
  if (!instance || instance.id !== instanceId || ownerOf(instance) !== ownerUid || !["STOPPED", "TERMINATED"].includes(instance.status ?? "")) throw new Error("boot deletion requires the same stopped owner VM");
}
function assertRetainedHomeDisks(disks: HomeInstance["disks"], home: RetainedUserHome, parseName: (source: string) => string): void {
  const attached = disks?.find(disk => disk.deviceName === VM_HOME_DISK_DEVICE_NAME && !disk.boot);
  const boot = disks?.filter(disk => disk.boot) ?? [];
  if (!attached?.source || parseName(home.source) !== home.name || parseName(attached.source) !== home.name || attached?.autoDelete !== false || boot.length !== 1 || boot[0].autoDelete !== true
    || disks?.some(disk => !disk.boot && disk.autoDelete !== false)) throw new Error("boot deletion would delete unverified non-boot storage");
}
function assertRetainedHomeDisk(disk: HomeDisk, home: RetainedUserHome, ownerUid: string): void {
  if (disk.id !== home.id || disk.labels?.["octogee-owner-uid"] !== ownerUid.toLowerCase() || disk.labels?.["octogee-storage"] !== "customer-home") throw new Error("retained home changed before boot deletion");
}

export function createVmHomeClient(deps: {
  request: ComputeRequest;
  projectId: string;
  readInstance: (name: string, zone: string) => Promise<HomeInstance | null>;
  waitForOperation: (zone: string, operation: unknown, what: string) => Promise<void>;
  journalHomeResize?: (input: { home: RetainedUserHome; ownerUid: string; sizeGb: number }, action: () => Promise<void>) => Promise<void>;
}) {
  const base = `https://compute.googleapis.com/compute/v1/projects/${deps.projectId}`;
  const readInstance = deps.readInstance;
  const waitForOperation = deps.waitForOperation;
  function homeName(source: string, zone: string): string {
    const relative = source.replace(/^https:\/\/(?:www|compute)\.googleapis\.com\/compute\/v1\//u, "");
    const prefix = `projects/${deps.projectId}/zones/${zone}/disks/`;
    const name = relative.startsWith(prefix) ? relative.slice(prefix.length) : "";
    if (!/^[a-z][a-z0-9-]{0,62}$/u.test(name)) throw new Error("home disk source escaped the configured project/zone");
    return name;
  }

  async function readHome(name: string, zone: string): Promise<HomeDisk> {
    const res = await deps.request({ url: `${base}/zones/${zone}/disks/${name}`, method: "GET" });
    if (res.status >= 400) throw Object.assign(new Error(`read home: HTTP ${res.status}`), { response: { status: res.status } });
    return res.data as HomeDisk;
  }

  function retainedHome(disk: HomeDisk, name: string, zone: string): RetainedUserHome {
    const sizeGb = Number(disk.sizeGb);
    const diskType = disk.type?.split("/").at(-1);
    if (!/^\d+$/u.test(disk.id ?? "") || disk.name !== name || !Number.isSafeInteger(sizeGb) || sizeGb < 10
      || (diskType !== "pd-balanced" && diskType !== "pd-ssd")) throw new Error("home disk identity/capacity/type is incomplete");
    return { projectId: deps.projectId, zone, name, id: disk.id!, sizeGb, diskType,
      source: `projects/${deps.projectId}/zones/${zone}/disks/${name}` };
  }

  async function protectHome(input: { instanceName: string; zone: string; ownerUid: string;
    attached: NonNullable<HomeInstance["disks"]>[number]; disk: HomeDisk; name: string }): Promise<void> {
    const { instanceName, zone, ownerUid, attached, disk, name } = input;
    if (!attached.autoDelete) {
      if (attached.autoDelete !== false) throw new Error("home disk auto-delete state is unknown");
    } else {
      const response = await deps.request({ url: `${base}/zones/${zone}/instances/${instanceName}/setDiskAutoDelete?autoDelete=false&deviceName=${VM_HOME_DISK_DEVICE_NAME}`, method: "POST" });
      await waitForOperation(zone, (response.data ?? {}), `retain home ${instanceName}`);
    }
    if (disk.labels?.["octogee-storage"] !== "customer-home" || disk.labels?.["octogee-owner-uid"] !== ownerUid.toLowerCase()) {
      if (!disk.labelFingerprint) throw new Error("home disk label fingerprint missing");
      const response = await deps.request({ url: `${base}/zones/${zone}/disks/${name}/setLabels`, method: "POST",
        body: { labelFingerprint: disk.labelFingerprint, labels: { ...disk.labels,
          "octogee-owner-uid": ownerUid.toLowerCase(), "octogee-storage": "customer-home" } } });
      await waitForOperation(zone, (response.data ?? {}), `label home ${name}`);
    }
  }

  function assertConfirmedHome(input: { instance: HomeInstance; confirmed: HomeInstance | null;
    attached: NonNullable<HomeInstance["disks"]>[number]; after: NonNullable<HomeInstance["disks"]>[number] | undefined;
    confirmedDisk: HomeDisk; home: RetainedUserHome; ownerUid: string }): void {
    const { instance, confirmed, attached, after, confirmedDisk, home, ownerUid } = input;
    if (!confirmed || confirmed.id !== instance.id || ownerOf(confirmed) !== ownerUid
      || after?.source !== attached.source || after?.autoDelete !== false || confirmedDisk.id !== home.id
      || confirmedDisk.labels?.["octogee-owner-uid"] !== ownerUid.toLowerCase()) throw new Error("home retention did not converge; refusing VM replacement");
  }

  async function retainHome(instanceName: string, zone: string, ownerUid: string): Promise<RetainedUserHome> {
    const instance = await readInstance(instanceName, zone);
    if (!instance || ownerOf(instance) !== ownerUid) {
      throw new Error("cannot retain home for an unverified VM owner");
    }
    const attached = instance.disks?.find(disk => disk.deviceName === VM_HOME_DISK_DEVICE_NAME && !disk.boot);
    if (!attached?.source) throw new Error("VM has no identifiable home disk");
    const name = homeName(attached.source, zone);
    const disk = await readHome(name, zone);
    if (disk.labels?.["octogee-owner-uid"] && disk.labels["octogee-owner-uid"] !== ownerUid.toLowerCase()) {
      throw new Error("home disk belongs to another owner");
    }
    const home = retainedHome(disk, name, zone);
    await protectHome({ instanceName, zone, ownerUid, attached, disk, name });
    const confirmed = await readInstance(instanceName, zone);
    const after = confirmed?.disks?.find(value => value.deviceName === VM_HOME_DISK_DEVICE_NAME);
    const confirmedDisk = await readHome(name, zone);
    assertConfirmedHome({ instance, confirmed, attached, after, confirmedDisk, home, ownerUid });
    return home;
  }

  async function verifyDetachedHome(home: RetainedUserHome, ownerUid: string): Promise<void> {
    if (home.projectId !== deps.projectId || homeName(home.source, home.zone) !== home.name) throw new Error("retained home project/zone mismatch");
    const disk = await readHome(home.name, home.zone);
    if (disk.id !== home.id || disk.labels?.["octogee-owner-uid"] !== ownerUid.toLowerCase()
      || disk.labels?.["octogee-storage"] !== "customer-home" || (disk.users !== undefined && !Array.isArray(disk.users)) || (disk.users?.length ?? 0) > 0) {
      throw new Error("retained home identity/owner/attachment is unverified");
    }
  }

  async function deleteRetainingHome(instanceName: string, zone: string, ownerUid: string, home: RetainedUserHome, instanceId: string): Promise<void> {
    const instance = await readInstance(instanceName, zone);
    assertStoppedHomeOwner(instance, instanceId, ownerUid);
    if (home.projectId !== deps.projectId || home.zone !== zone) throw new Error("boot replacement home escaped configured project/zone");
    assertRetainedHomeDisks(instance!.disks, home, source => homeName(source, zone));
    const disk = await readHome(homeName(home.source, zone), zone);
    assertRetainedHomeDisk(disk, home, ownerUid);
    const response = await deps.request({ url: `${base}/zones/${zone}/instances/${instanceName}`, method: "DELETE" });
    if (response.status >= 400) throw new Error(`delete platform boot: HTTP ${response.status}`);
    await waitForOperation(zone, response.data ?? {}, `delete retained-home boot ${instanceName}`);
  }

  async function deleteRetainedHome(home: RetainedUserHome, ownerUid: string): Promise<void> {
    try { await verifyDetachedHome(home, ownerUid); }
    catch (error) {
      if (missing(error)) return;
      throw error;
    }
    let response;
    try { response = await deps.request({ url: `${base}/zones/${home.zone}/disks/${home.name}`, method: "DELETE" }); }
    catch (error) {
      if (missing(error)) return;
      throw error;
    }
    if (response.status === 404) return;
    if (response.status >= 400) throw Object.assign(new Error(`erase home: HTTP ${response.status}`), { response: { status: response.status } });
    await waitForOperation(home.zone, (response.data ?? {}), `erase home ${home.name}`);
  }

  async function expandHome(home: RetainedUserHome, ownerUid: string, sizeGb: number): Promise<RetainedUserHome> {
    if (!Number.isSafeInteger(sizeGb) || sizeGb < 10 || sizeGb > 100) throw new Error("invalid user home capacity");
    if (home.projectId !== deps.projectId || homeName(home.source, home.zone) !== home.name) throw new Error("home expansion project/zone mismatch");
    const read = async () => {
      const disk = await readHome(home.name, home.zone);
      assertRetainedHomeDisk(disk, home, ownerUid);
      return retainedHome(disk, home.name, home.zone);
    };
    const current = await read();
    if (current.sizeGb >= sizeGb) return current;
    const action = async () => {
      const confirmed = await read();
      if (confirmed.sizeGb >= sizeGb) return;
      const response = await deps.request({ url: `${base}/zones/${home.zone}/disks/${home.name}/resize`, method: "POST", body: { sizeGb: String(sizeGb) } });
      if (response.status >= 400) throw new Error(`expand home: HTTP ${response.status}`);
      await waitForOperation(home.zone, response.data ?? {}, `expand home ${home.name}`);
    };
    if (deps.journalHomeResize) await deps.journalHomeResize({ home: current, ownerUid, sizeGb }, action);
    else await action();
    const expanded = await read();
    if (expanded.sizeGb < sizeGb) throw new Error("home capacity did not converge");
    return expanded;
  }

  return { retainHome, verifyDetachedHome, deleteRetainedHome, deleteRetainingHome, expandHome };
}
