import { type FailActivationLeaseInput, type IsolatedLifecycleDeps, type LifecycleMode } from "./inputs.js";
type RollbackParkDeps = Pick<IsolatedLifecycleDeps, "store" | "now" | "requireOwner" | "sourceRecoveryPending">;
export declare function tryFailActivationLeaseAndPark(deps: RollbackParkDeps, request: FailActivationLeaseInput, mode?: LifecycleMode): Promise<boolean>;
export {};
