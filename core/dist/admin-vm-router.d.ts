import type { Request, Router } from "express";
import type { PlatformStateStore } from "./platform-state/store.js";
interface VmReplacementMutation {
    req: Request;
    what: string;
    why: string;
    target: Record<string, unknown>;
    preActionStatus: Record<string, unknown>;
    mutation: Record<string, unknown>;
    forced?: boolean;
    dryRunRefusal?: () => Promise<string | null>;
    action: () => Promise<string>;
}
interface VmRouterDeps {
    replacementEnabled?: boolean;
    releaseEnvironment?: "test" | "prod" | null;
    store: PlatformStateStore;
    journal: (input: VmReplacementMutation) => Promise<string>;
}
export declare function addAdminComputerRoutes(router: Router, deps: VmRouterDeps): void;
export {};
