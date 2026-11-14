import {
  VM_HOME_CHECKPOINT_NAME_RE,
  isGatewayVmHomeCheckpoint,
  type GatewayVmHomeCheckpoint,
} from "@octogee/shared/types/glm";
import { gcsBucket } from "../../../gateway-edge/src/lib/gcs-bucket.js";

export class VmHomeCheckpointError extends Error {
  constructor(
    readonly code: "checkpoint_not_uploaded" | "checkpoint_size_mismatch" | "checkpoint_generation_invalid" | "current_pointer_corrupt"
      | "checkpoint_stale" | "checkpoint_conflict" | "checkpoint_commit_conflict",
    message: string,
  ) {
    super(message);
    this.name = "VmHomeCheckpointError";
  }
}

export interface VmHomeStore {
  commit(input: { checkpointPath: string; currentPath: string; checkpoint: GatewayVmHomeCheckpoint }): Promise<GatewayVmHomeCheckpoint>;
  readCurrent(currentPath: string): Promise<GatewayVmHomeCheckpoint | null>;
  prune(input: { checkpointsPrefix: string; currentName: string | null; keep: number }): Promise<number>;
}

export function vmHomeRoot(slug: string): string {
  return `customers/${slug}/computer-home`;
}

export function vmHomeCheckpointsPrefix(slug: string): string {
  return `${vmHomeRoot(slug)}/checkpoints`;
}

export function vmHomeCheckpointPath(slug: string, name: string): string {
  return `${vmHomeCheckpointsPrefix(slug)}/${name}`;
}

export function vmHomeCurrentPath(slug: string): string {
  return `${vmHomeRoot(slug)}/current.json`;
}

export function validVmHomeCheckpointName(value: unknown): string | null {
  return typeof value === "string" && VM_HOME_CHECKPOINT_NAME_RE.test(value) ? value : null;
}

export function validSha256(value: unknown): string | null {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value) ? value : null;
}

export function vmHomePruneCandidates(input: {
  checkpointsPrefix: string;
  objectPaths: readonly string[];
  currentName: string | null;
  keep: number;
}): string[] {
  if (!Number.isSafeInteger(input.keep) || input.keep < 1) throw new Error("vm-home prune keep must be a positive integer");
  const prefix = `${input.checkpointsPrefix}/`;
  const checkpoints = input.objectPaths
    .filter((path) => path.startsWith(prefix))
    .map((path) => ({ path, name: path.slice(prefix.length) }))
    .filter(({ name }) => VM_HOME_CHECKPOINT_NAME_RE.test(name))
    .sort((a, b) => b.name.localeCompare(a.name));
  return checkpoints
    .filter((entry, index) => index >= input.keep && input.currentName !== null && entry.name < input.currentName)
    .map((entry) => entry.path);
}

function statusOf(error: unknown): number | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "number" ? code : undefined;
}

function parseCurrent(raw: string, currentPath: string): GatewayVmHomeCheckpoint {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new VmHomeCheckpointError("current_pointer_corrupt", `vm-home pointer ${currentPath} is not JSON`);
  }
  if (!isGatewayVmHomeCheckpoint(parsed)) {
    throw new VmHomeCheckpointError("current_pointer_corrupt", `vm-home pointer ${currentPath} is not a checkpoint record`);
  }
  return parsed;
}

async function bucket() {
  return gcsBucket();
}

type VmHomeBucket = Awaited<ReturnType<typeof bucket>>;

async function verifyUploadedCheckpoint(store: VmHomeBucket, checkpointPath: string, expectedSize: number): Promise<string> {
  let size: unknown;
  let generation: unknown;
  try {
    const [metadata] = await store.file(checkpointPath).getMetadata();
    size = metadata.size;
    generation = metadata.generation;
  } catch (error) {
    if (statusOf(error) === 404) {
      throw new VmHomeCheckpointError("checkpoint_not_uploaded", `vm-home checkpoint ${checkpointPath} is not in the bucket`);
    }
    throw error;
  }
  if (Number(size) !== expectedSize) {
    throw new VmHomeCheckpointError(
      "checkpoint_size_mismatch",
      `vm-home checkpoint ${checkpointPath} is ${String(size)} bytes, commit claims ${expectedSize}`,
    );
  }
  if (typeof generation !== "string" || !/^[1-9]\d*$/u.test(generation)) {
    throw new VmHomeCheckpointError("checkpoint_generation_invalid", `vm-home checkpoint ${checkpointPath} has an invalid generation`);
  }
  return generation;
}

async function currentGeneration(store: VmHomeBucket, currentPath: string): Promise<string | 0> {
  try {
    const [metadata] = await store.file(currentPath).getMetadata();
    if (typeof metadata.generation !== "string" || !/^[1-9]\d*$/u.test(metadata.generation)) {
      throw new VmHomeCheckpointError("current_pointer_corrupt", `vm-home pointer ${currentPath} has an invalid generation`);
    }
    return metadata.generation;
  } catch (error) {
    if (statusOf(error) === 404) return 0;
    throw error;
  }
}

function alreadyCommitted(current: GatewayVmHomeCheckpoint, checkpoint: GatewayVmHomeCheckpoint): boolean {
  if (current.name > checkpoint.name) {
    throw new VmHomeCheckpointError("checkpoint_stale", `vm-home checkpoint ${checkpoint.name} precedes current ${current.name}`);
  }
  if (current.name !== checkpoint.name) return false;
  if (current.size !== checkpoint.size || current.sha256 !== checkpoint.sha256 || current.instanceId !== checkpoint.instanceId || current.generation !== checkpoint.generation) {
    throw new VmHomeCheckpointError("checkpoint_conflict", `vm-home checkpoint ${checkpoint.name} was committed with different content or provenance`);
  }
  return true;
}

export function createGcsVmHomeStore(): VmHomeStore {
  return {
    async commit({ checkpointPath, currentPath, checkpoint }) {
      const store = await bucket();
      checkpoint = { ...checkpoint, generation: await verifyUploadedCheckpoint(store, checkpointPath, checkpoint.size) };
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const generation = await currentGeneration(store, currentPath);
        if (typeof generation === "string") {
          let bytes: Buffer;
          try {
            [bytes] = await store.file(currentPath, { generation }).download();
          } catch (error) {
            if (statusOf(error) === 404 || statusOf(error) === 412) continue;
            throw error;
          }
          const current = parseCurrent(bytes.toString("utf8"), currentPath);
          if (alreadyCommitted(current, checkpoint)) return current;
        }
        try {
          await store.file(currentPath).save(JSON.stringify(checkpoint), {
            contentType: "application/json",
            resumable: false,
            preconditionOpts: { ifGenerationMatch: generation },
          });
          return checkpoint;
        } catch (error) {
          if (statusOf(error) !== 412) throw error;
        }
      }
      throw new VmHomeCheckpointError("checkpoint_commit_conflict", `vm-home pointer ${currentPath} kept changing during commit`);
    },
    async readCurrent(currentPath) {
      const store = await bucket();
      let raw: string;
      try {
        const [bytes] = await store.file(currentPath).download();
        raw = bytes.toString("utf8");
      } catch (error) {
        if (statusOf(error) === 404) return null;
        throw error;
      }
      return parseCurrent(raw, currentPath);
    },
    async prune({ checkpointsPrefix, currentName, keep }) {
      const store = await bucket();
      const [files] = await store.getFiles({ prefix: `${checkpointsPrefix}/` });
      const candidates = vmHomePruneCandidates({
        checkpointsPrefix,
        objectPaths: files.map((file) => file.name),
        currentName,
        keep,
      });
      await Promise.all(candidates.map((path) => store.file(path).delete({ ignoreNotFound: true })));
      return candidates.length;
    },
  };
}
