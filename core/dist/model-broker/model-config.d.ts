import type { PlatformConfigRepository } from "../platform-state/index.js";
import { type UserAgentModelDefault, type ResolvedHouseModel } from "@octogee/shared/types/platform-config";
export type HouseModelResolver = () => Promise<ResolvedHouseModel>;
export type UserAgentDefaultResolver = () => Promise<UserAgentModelDefault>;
export declare function createCachedHouseModelResolver(opts: {
    platformConfig: Pick<PlatformConfigRepository, "get">;
    ttlMs?: number;
    now?: () => number;
    onError?: (err: unknown) => void;
}): HouseModelResolver;
export declare function createCachedUserAgentDefaultResolver(opts: {
    platformConfig: Pick<PlatformConfigRepository, "get">;
    ttlMs?: number;
    now?: () => number;
    onError?: (err: unknown) => void;
}): UserAgentDefaultResolver;
