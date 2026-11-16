import type {
  AssignmentDoc,
  AssignmentState,
  GatewayDoc,
  ReleaseDoc,
  ReleasePayload,
} from "@octogee/shared/types/gateway-releases";
import type { GatewayMutableConfig } from "@octogee/shared/types/gateway-mutable-config";
import type { GatewayClass, GatewayDesiredStatus, GatewayVmRuntimeBundle } from "@octogee/shared/types/glm";
import type { GitKeysReleasedProof } from "../gateway-root-deletion.js";
import type { Clearable, OpaqueMap, RecordPatch, Revision, Stored, TimeInput } from "./store.js";

export type GatewayRuntimeRestartFenceValue = OpaqueMap & {
  readonly attemptId: string;
  readonly auditId?: string;
  readonly gatewayId: string;
  readonly kind: string;
  readonly phase: string;
  readonly startedAt: number;
};

export interface GatewayLastErrorRecord {
  readonly slug: string | null;
  readonly message: string;
  readonly at: number;
}

export interface GatewayConfigBackfill {
  readonly sourceRelease: number;
  readonly sourcePayloadHash: string;
  readonly at: number;
}

export interface GatewayRootFields {
  readonly runtimeRestartFence?: GatewayRuntimeRestartFenceValue;
  readonly lastError?: GatewayLastErrorRecord | null;
  readonly lastPreStopFlush?: OpaqueMap;
  readonly configBackfill?: GatewayConfigBackfill;
}

export type GatewayRoot = GatewayDoc & GatewayMutableConfig & GatewayRootFields;

export type GatewayLastErrorInput = Omit<GatewayLastErrorRecord, "at"> & { readonly at: TimeInput };

export type GatewayPreStopFlushInput = OpaqueMap & { readonly at: TimeInput };

export type GatewayRootPatch = RecordPatch<
  Omit<GatewayRoot, "lastError" | "lastPreStopFlush">,
  "gatewayId" | "createdAt" | "createdBy" | "latestRelease"
> & {
  readonly lastError?: Clearable<GatewayLastErrorInput | null>;
  readonly lastPreStopFlush?: Clearable<GatewayPreStopFlushInput>;
};

export interface GatewayRootFence {
  readonly revision?: Revision;
  readonly updatedAt?: number;
  readonly latestRelease?: number;
  readonly retirementVersion?: number | null;
  readonly desiredStatus?: readonly GatewayDesiredStatus[];
  readonly allocationGeneration?: number | null;
  readonly lastErrorSlug?: string;
}

export interface GatewayRootFilter {
  readonly gatewayClass?: GatewayClass;
  readonly ownerUid?: string;
}

export interface GatewayRootsRepository {
  get(gatewayId: string): Promise<Stored<GatewayRoot> | null>;
  getMany(gatewayIds: readonly string[]): Promise<ReadonlyMap<string, Stored<GatewayRoot>>>;
  list(filter?: GatewayRootFilter): Promise<readonly Stored<GatewayRoot>[]>;
  findByServiceAccountName(serviceAccountName: string): Promise<Stored<GatewayRoot> | null>;
  create(root: GatewayRoot): Promise<void>;
  patch(gatewayId: string, patch: GatewayRootPatch, fence?: GatewayRootFence): Promise<void>;
  compareAndSetRuntimeRestartFence(
    gatewayId: string,
    expected: GatewayRuntimeRestartFenceValue | null,
    next: GatewayRuntimeRestartFenceValue | null,
  ): Promise<void>;
  delete(gatewayId: string, gitKeys: GitKeysReleasedProof, fence?: GatewayRootFence): Promise<void>;
  deleteChildren(gatewayId: string): Promise<void>;
}

export type GatewayRelease = ReleaseDoc;

export interface AppendGatewayReleaseInput {
  readonly gatewayId: string;
  readonly expectedLatestRelease: number;
  readonly createdAt: number;
  readonly createdBy: string;
  readonly sourceRelease: number | null;
  readonly note: string | null;
  readonly payload: ReleasePayload;
  readonly payloadHash: string;
  readonly activate: boolean;
  readonly updatedBy: string;
}

export interface GatewayReleasesRepository {
  get(gatewayId: string, release: number): Promise<GatewayRelease | null>;
  list(gatewayId: string, order: "asc" | "desc", limit?: number): Promise<readonly GatewayRelease[]>;
  append(input: AppendGatewayReleaseInput): Promise<number>;
  createInitial(release: GatewayRelease): Promise<void>;
  replace(release: GatewayRelease): Promise<void>;
}

export type GatewayAssignment = AssignmentDoc;

export type GatewayAssignmentPatch = RecordPatch<GatewayAssignment, "uid" | "gatewayId" | "createdAt">;

export interface GatewayAssignmentFence {
  readonly revision?: Revision;
  readonly epoch?: number;
  readonly updatedAt?: number;
  readonly state?: readonly AssignmentState[];
}

export interface GatewayAssignmentsRepository {
  get(gatewayId: string, uid: string): Promise<Stored<GatewayAssignment> | null>;
  list(gatewayId: string, limit?: number): Promise<readonly Stored<GatewayAssignment>[]>;
  isEmpty(gatewayId: string): Promise<boolean>;
  findBySlug(gatewayId: string, slug: string): Promise<Stored<GatewayAssignment> | null>;
  listForUid(uid: string): Promise<readonly Stored<GatewayAssignment>[]>;
  listForSlug(slug: string): Promise<readonly Stored<GatewayAssignment>[]>;
  listAll(): Promise<readonly Stored<GatewayAssignment>[]>;
  create(assignment: GatewayAssignment): Promise<void>;
  put(assignment: GatewayAssignment): Promise<void>;
  patch(gatewayId: string, uid: string, patch: GatewayAssignmentPatch, fence?: GatewayAssignmentFence): Promise<void>;
  delete(gatewayId: string, uid: string, fence?: GatewayAssignmentFence): Promise<void>;
}

export interface GatewayVmRuntimeRepository {
  get(gatewayId: string): Promise<Stored<GatewayVmRuntimeBundle> | null>;
  put(gatewayId: string, bundle: GatewayVmRuntimeBundle): Promise<void>;
  delete(gatewayId: string): Promise<void>;
}

export interface GatewayRepositories {
  readonly roots: GatewayRootsRepository;
  readonly releases: GatewayReleasesRepository;
  readonly assignments: GatewayAssignmentsRepository;
  readonly vmRuntime: GatewayVmRuntimeRepository;
}
