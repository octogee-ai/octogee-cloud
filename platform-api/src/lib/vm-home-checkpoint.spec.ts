import { describe, expect, it, vi } from "vitest";
import { vmHomeCheckpointName, type GatewayVmHomeCheckpoint } from "@octogee/shared/types/glm";
import {
  createGcsVmHomeStore,
  vmHomeCheckpointPath,
  vmHomeCurrentPath,
  vmHomePruneCandidates,
  validVmHomeCheckpointName,
} from "./vm-home-checkpoint.js";

describe("vm-home checkpoint layout", () => {
  it("names checkpoints by UTC second so lexical order is chronological, and keys the layout by user", () => {
    const name = vmHomeCheckpointName(Date.UTC(2026, 8, 5, 10, 15, 0, 123));
    expect(name).toBe("20260905T101500Z.tar.gz");
    expect(validVmHomeCheckpointName(name)).toBe(name);
    expect(validVmHomeCheckpointName("../current.json")).toBeNull();
    expect(validVmHomeCheckpointName("20260905T101500Z.tar")).toBeNull();
    expect(vmHomeCheckpointPath("bob", name)).toBe("customers/bob/computer-home/checkpoints/20260905T101500Z.tar.gz");
    expect(vmHomeCurrentPath("bob")).toBe("customers/bob/computer-home/current.json");
  });
});

const gcs = vi.hoisted(() => ({ gcsBucket: vi.fn() }));
vi.mock("@octogee/core/workspace/gcs-bucket", () => gcs);

function checkpoint(name = "20260905T101500Z.tar.gz"): GatewayVmHomeCheckpoint {
  return { generation: "9007199254740995", name, size: 123, sha256: "a".repeat(64), instanceId: "123", completedAt: 1000 };
}

function checkpointBucket() {
  const currentPath = vmHomeCurrentPath("bob");
  let generation = 9007199254740993n;
  let current: { record: unknown; generation: string } | null = null;
  const writes: Array<{ checkpoint: GatewayVmHomeCheckpoint; generation: unknown }> = [];
  const hooks: {
    beforeSave?: (record: GatewayVmHomeCheckpoint) => Promise<void>;
    beforeDownload?: () => void;
    metadataError?: number;
    currentMetadataError?: number;
    afterSaveError?: number;
    invalidGeneration?: unknown;
    checkpointSize?: number;
    archiveGeneration?: unknown;
  } = {};
  const missing = () => Object.assign(new Error("missing"), { code: 404 });
  const bucket = {
    file(path: string, options?: { generation?: string }) {
      return {
        async getMetadata() {
          if (hooks.metadataError) throw Object.assign(new Error("metadata unavailable"), { code: hooks.metadataError });
          if (path !== currentPath) return [{ size: String(hooks.checkpointSize ?? 123), generation: hooks.archiveGeneration ?? "9007199254740995" }];
          if (hooks.currentMetadataError) throw Object.assign(new Error("current metadata unavailable"), { code: hooks.currentMetadataError });
          if (!current) throw missing();
          return [{ generation: hooks.invalidGeneration ?? current.generation }];
        },
        async download() {
          hooks.beforeDownload?.();
          if (!current || (options?.generation && current.generation !== options.generation)) throw missing();
          return [Buffer.from(JSON.stringify(current.record))];
        },
        async save(raw: string, options?: { preconditionOpts?: { ifGenerationMatch?: string | number } }) {
          const record = JSON.parse(raw) as GatewayVmHomeCheckpoint;
          await hooks.beforeSave?.(record);
          const expected = options?.preconditionOpts?.ifGenerationMatch;
          if (expected !== undefined && expected !== (current?.generation ?? 0)) {
            throw Object.assign(new Error("precondition failed"), { code: 412 });
          }
          writes.push({ checkpoint: record, generation: expected });
          current = { record, generation: String(++generation) };
          if (hooks.afterSaveError) throw Object.assign(new Error("save response lost"), { code: hooks.afterSaveError });
        },
      };
    },
  };
  gcs.gcsBucket.mockReturnValue(bucket);
  const store = createGcsVmHomeStore();
  return {
    store, writes, hooks,
    current: () => current?.record,
    putCurrent(record: unknown) { current = { record, generation: String(++generation) }; },
    commit(record: GatewayVmHomeCheckpoint) {
      return store.commit({ checkpointPath: vmHomeCheckpointPath("bob", record.name), currentPath, checkpoint: record });
    },
  };
}

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

describe("GCS vm-home pointer commits", () => {
  it("rejects delayed older commits without replacing the accepted newer checkpoint", async () => {
    const bucket = checkpointBucket();
    const newer = checkpoint("20260905T101501Z.tar.gz");
    await bucket.commit(newer);
    await expect(bucket.commit(checkpoint())).rejects.toMatchObject({ code: "checkpoint_stale" });
    expect(bucket.current()).toEqual(newer);
    expect(bucket.writes).toHaveLength(1);
  });

  it("uses create-only then exact-generation updates without rounding GCS generations", async () => {
    const bucket = checkpointBucket();
    await bucket.commit(checkpoint());
    await bucket.commit(checkpoint("20260905T101501Z.tar.gz"));
    expect(bucket.writes.map((write) => write.generation)).toEqual([0, "9007199254740994"]);
  });

  it("rechecks chronological order after another writer wins the generation race", async () => {
    const bucket = checkpointBucket();
    const older = checkpoint();
    const newer = checkpoint("20260905T101501Z.tar.gz");
    const reachedSave = barrier();
    const releaseSave = barrier();
    bucket.hooks.beforeSave = async (record) => {
      if (record.name === older.name) {
        reachedSave.release();
        await releaseSave.promise;
      }
    };
    const delayed = bucket.commit(older);
    await reachedSave.promise;
    await bucket.commit(newer);
    releaseSave.release();
    await expect(delayed).rejects.toMatchObject({ code: "checkpoint_stale" });
    expect(bucket.current()).toEqual(newer);
  });

  it("advances a newer commit after a concurrent older commit wins first", async () => {
    const bucket = checkpointBucket();
    const newer = checkpoint("20260905T101501Z.tar.gz");
    const reachedSave = barrier();
    const releaseSave = barrier();
    bucket.hooks.beforeSave = async (record) => {
      if (record.name === newer.name) {
        reachedSave.release();
        await releaseSave.promise;
      }
    };
    const delayed = bucket.commit(newer);
    await reachedSave.promise;
    await bucket.commit(checkpoint());
    releaseSave.release();
    await delayed;
    expect(bucket.current()).toEqual(newer);
    expect(bucket.writes.map((write) => write.generation)).toEqual([0, "9007199254740994"]);
  });

  it("accepts a retry after a lost response without rewriting its original completion time", async () => {
    const bucket = checkpointBucket();
    const original = checkpoint();
    await expect(bucket.commit(original)).resolves.toEqual(original);
    await expect(bucket.commit({ ...original, completedAt: 2000 })).resolves.toEqual(original);
    expect(bucket.current()).toEqual(original);
    expect(bucket.writes).toHaveLength(1);
  });

  it("recovers a committed pointer after the storage save reply was lost", async () => {
    const bucket = checkpointBucket();
    const original = checkpoint();
    bucket.hooks.afterSaveError = 503;
    await expect(bucket.commit(original)).rejects.toMatchObject({ code: 503 });
    delete bucket.hooks.afterSaveError;
    await expect(bucket.commit({ ...original, completedAt: 2000 })).resolves.toEqual(original);
    expect(bucket.writes).toHaveLength(1);
  });

  it.each(["sha256", "size", "instanceId"] as const)("rejects conflicting same-name %s", async (field) => {
    const bucket = checkpointBucket();
    const original = checkpoint();
    await bucket.commit(original);
    const conflicting = { ...original, [field]: field === "size" ? 124 : "b".repeat(64) };
    if (field === "size") bucket.hooks.checkpointSize = 124;
    await expect(bucket.commit(conflicting)).rejects.toMatchObject({ code: "checkpoint_conflict" });
    expect(bucket.current()).toEqual(original);
  });

  it("retries a generation-pinned read replaced between metadata and download", async () => {
    const bucket = checkpointBucket();
    bucket.putCurrent(checkpoint());
    const newer = checkpoint("20260905T101502Z.tar.gz");
    bucket.hooks.beforeDownload = () => {
      delete bucket.hooks.beforeDownload;
      bucket.putCurrent(newer);
    };
    await expect(bucket.commit(checkpoint("20260905T101501Z.tar.gz"))).rejects.toMatchObject({ code: "checkpoint_stale" });
    expect(bucket.current()).toEqual(newer);
    expect(bucket.writes).toHaveLength(0);
  });

  it("fails explicitly when repeated generation conflicts exhaust bounded retries", async () => {
    const bucket = checkpointBucket();
    bucket.hooks.beforeSave = async () => { bucket.putCurrent(checkpoint()); };
    await expect(bucket.commit(checkpoint("20260905T101501Z.tar.gz"))).rejects.toMatchObject({ code: "checkpoint_commit_conflict" });
    expect(bucket.writes).toHaveLength(0);
  });

  it("preserves corrupt pointers and reports the corruption", async () => {
    const bucket = checkpointBucket();
    bucket.putCurrent({ broken: true });
    await expect(bucket.commit(checkpoint())).rejects.toMatchObject({ code: "current_pointer_corrupt" });
    expect(bucket.current()).toEqual({ broken: true });
  });

  it("propagates storage failure without treating it as an absent pointer", async () => {
    const bucket = checkpointBucket();
    bucket.hooks.metadataError = 503;
    await expect(bucket.commit(checkpoint())).rejects.toMatchObject({ code: 503 });
    expect(bucket.writes).toHaveLength(0);
  });

  it("does not recreate a pointer when its metadata cannot be read", async () => {
    const bucket = checkpointBucket();
    bucket.putCurrent(checkpoint());
    bucket.hooks.currentMetadataError = 403;
    await expect(bucket.commit(checkpoint("20260905T101501Z.tar.gz"))).rejects.toMatchObject({ code: 403 });
    expect(bucket.writes).toHaveLength(0);
  });

  it("rejects invalid generation metadata without attempting an unguarded write", async () => {
    const bucket = checkpointBucket();
    bucket.putCurrent(checkpoint());
    bucket.hooks.invalidGeneration = 123;
    await expect(bucket.commit(checkpoint("20260905T101501Z.tar.gz"))).rejects.toMatchObject({ code: "current_pointer_corrupt" });
    expect(bucket.writes).toHaveLength(0);
  });

  it("rejects missing uploads and size mismatches before updating the pointer", async () => {
    const bucket = checkpointBucket();
    bucket.hooks.metadataError = 404;
    await expect(bucket.commit(checkpoint())).rejects.toMatchObject({ code: "checkpoint_not_uploaded" });
    delete bucket.hooks.metadataError;
    bucket.hooks.checkpointSize = 122;
    await expect(bucket.commit(checkpoint())).rejects.toMatchObject({ code: "checkpoint_size_mismatch" });
    expect(bucket.writes).toHaveLength(0);
  });
});

describe("vmHomePruneCandidates", () => {
  const prefix = "customers/bob/computer-home/checkpoints";
  const at = (day: number) => `${prefix}/202609${String(day).padStart(2, "0")}T000000Z.tar.gz`;

  it("keeps the newest N and the current checkpoint, ignores foreign objects, and deletes the rest", () => {
    const objectPaths = [at(1), at(4), at(2), at(5), at(3), `${prefix}/notes.txt`, "customers/bob/computer-home/current.json"];
    expect(vmHomePruneCandidates({ checkpointsPrefix: prefix, objectPaths, currentName: "20260903T000000Z.tar.gz", keep: 2 }))
      .toEqual([at(2), at(1)]);
    expect(vmHomePruneCandidates({ checkpointsPrefix: prefix, objectPaths, currentName: null, keep: 5 })).toEqual([]);
    expect(() => vmHomePruneCandidates({ checkpointsPrefix: prefix, objectPaths, currentName: null, keep: 0 })).toThrow(/positive integer/);
  });

  it("preserves every upload that could still become current while a commit is in flight", () => {
    const objectPaths = Array.from({ length: 8 }, (_, index) => at(index + 1));
    expect(vmHomePruneCandidates({ checkpointsPrefix: prefix, objectPaths, currentName: "20260902T000000Z.tar.gz", keep: 2 }))
      .toEqual([at(1)]);
    expect(vmHomePruneCandidates({ checkpointsPrefix: prefix, objectPaths, currentName: null, keep: 2 })).toEqual([]);
  });
});


describe("archive generation identity", () => {
  it("rejects invalid archive metadata without publishing a pointer", async () => {
    const h = checkpointBucket();
    h.hooks.archiveGeneration = Number("9007199254740995");
    await expect(h.commit(checkpoint())).rejects.toMatchObject({ code: "checkpoint_generation_invalid" });
    expect(h.writes).toEqual([]);
  });
  it("records the exact archive generation without converting it to a number", async () => {
    const h = checkpointBucket();
    const record = checkpoint();
    delete record.generation;
    expect(await h.commit(record)).toMatchObject({ generation: "9007199254740995" });
  });
});
