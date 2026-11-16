import type { Router } from "express";
import type { AdminFleetMutationRunner } from "./admin-fleet-router.js";
import type { PlatformStateStore } from "./platform-state/store.js";
import { type ResumeSourceIngress } from "./stranded-source-restore.js";
export interface AdminStrandedSourceCapabilities {
    resumeSourceIngress: ResumeSourceIngress;
}
export interface AdminStrandedSourceRouterDeps extends AdminStrandedSourceCapabilities {
    store: PlatformStateStore;
    journal: AdminFleetMutationRunner;
    log: (message: string) => void;
    now?: () => number;
}
export declare function addAdminStrandedSourceRoutes(router: Router, deps: AdminStrandedSourceRouterDeps): void;
