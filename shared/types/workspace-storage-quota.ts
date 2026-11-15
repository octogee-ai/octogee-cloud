export class WorkspaceStorageQuotaError extends Error {
  override readonly name = "WorkspaceStorageQuotaError";
  readonly code = "FREE_STORAGE_LIMIT";

  constructor(
    readonly limitBytes: number,
    readonly projectedBytes: number,
  ) {
    super(`Free workspace storage limit exceeded (${projectedBytes}/${limitBytes} bytes)`);
  }
}

export interface WorkspaceStorageReservation {
  slug: string;
  path: string;
  id: string;
  previousSize: number;
  newSize: number;
}

export interface WorkspaceStorageReservationInput {
  slug: string;
  path: string;
  newSize: number;
  manifestBytes: number;
  manifestPathBytes: number;
  limitBytes: number;
}

export interface WorkspaceStorageRelease {
  slug: string;
  path: string;
  removedBytes: number;
}

export interface WorkspaceStorageAccounting {
  reserve(input: WorkspaceStorageReservationInput): Promise<WorkspaceStorageReservation>;
  finalize(reservation: WorkspaceStorageReservation): Promise<void>;
  rollback(reservation: WorkspaceStorageReservation): Promise<void>;
  release(input: WorkspaceStorageRelease): Promise<void>;
}

function noAccountingStore(): never {
  throw new Error("A workspace storage limit applies but no storage accounting is installed");
}

export const NO_WORKSPACE_STORAGE_ACCOUNTING: WorkspaceStorageAccounting = {
  reserve: async () => noAccountingStore(),
  finalize: async () => noAccountingStore(),
  rollback: async () => noAccountingStore(),
  release: async () => {},
};

let installed: WorkspaceStorageAccounting = NO_WORKSPACE_STORAGE_ACCOUNTING;

export function installWorkspaceStorageAccounting(accounting: WorkspaceStorageAccounting): void {
  installed = accounting;
}

export function workspaceStorageAccounting(): WorkspaceStorageAccounting {
  return installed;
}
