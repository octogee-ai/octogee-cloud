import type { OpaqueMap, PlatformStateStore } from "@octogee/core/platform-state";

export type ProductContext = OpaqueMap;

export interface UserLifecycleJob {
  uid: string;
  deletionId: string;
  productContext: ProductContext;
}

export interface SuspensionStepRunner {
  run(name: string, action: () => Promise<unknown>): Promise<void>;
  skip(name: string): Promise<void>;
}

export type SuspensionPhase = (job: UserLifecycleJob, steps: SuspensionStepRunner) => Promise<void>;

export interface ProductUserSuspension {
  suspendSignIn(uid: string): Promise<void>;
  afterVisibilityDeactivation: SuspensionPhase;
  afterGatewayRetirement: SuspensionPhase;
  afterModelBrokerRevocation: SuspensionPhase;
}

export interface ErasureStep {
  name: string;
  run(job: UserLifecycleJob): Promise<"done" | "skipped">;
}

export interface ErasureVerification {
  name: string;
  confirm(job: UserLifecycleJob): Promise<"verified" | "skipped" | "pending">;
  pending(job: UserLifecycleJob): { error: string; output: Record<string, unknown>; retryAfterMs: number };
}

export interface UserDataScope {
  uid: string;
  slug: string;
  email: string | null;
  chatArtifactIds: readonly string[];
  agentImportIds: readonly string[];
  currentOperationId: string;
}

export interface ProductUserData {
  eraseStorage(scope: UserDataScope): Promise<void>;
  eraseVmHome(slug: string): Promise<{ deleted: number }>;
  eraseRecords(scope: UserDataScope): Promise<void>;
  deleteSignIn(uid: string): Promise<void>;
  remaining(scope: UserDataScope): Promise<string[]>;
  undrainedArtifactIds(artifactIds: readonly string[]): Promise<string[]>;
}

export interface ProductUserErasure {
  steps: readonly ErasureStep[];
  verification: ErasureVerification;
}

export interface ProductUserCleanup {
  credentialSecretNames: readonly string[];
  chatArtifactIds: readonly string[];
}

export interface ProductUserArchive {
  fields: Record<string, unknown>;
  usageRollup: Record<string, unknown>;
}

export interface ProductUserLifecycle {
  discover(uid: string): Promise<ProductContext>;
  cleanup(uid: string, slug: string): Promise<ProductUserCleanup>;
  suspension: ProductUserSuspension;
  erasure: ProductUserErasure;
  data: ProductUserData;
  verificationContext(productContext: ProductContext): ProductContext | null;
  archive(uid: string, account: Record<string, unknown> | undefined): Promise<ProductUserArchive>;
}

export type ProductUserLifecycleFactory = (deps: {
  store: PlatformStateStore;
  log: (message: string) => void;
}) => ProductUserLifecycle;

export class UserErasureRetryLaterError extends Error {
  override readonly name: string = "UserErasureRetryLaterError";

  constructor(message: string, readonly retryAfterMs: number | null) {
    super(message);
  }
}
