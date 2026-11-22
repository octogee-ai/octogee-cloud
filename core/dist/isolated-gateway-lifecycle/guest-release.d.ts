import { type ReleasePayload } from "@octogee/shared/types/gateway-releases";
export declare const GUEST_RELEASE_MODE = "guest-release";
export declare function immutableGuestImageRef(reference: string): string | null;
export declare function sameGuestImageRef(left: string, right: string): boolean;
export declare function hasCompleteGuestRelease(payload: ReleasePayload): boolean;
export declare function guestReleaseImagesMatch(installed: ReleasePayload, desired: ReleasePayload): boolean;
export declare function guestReleaseInstalled(payload: ReleasePayload, instanceId: string, sample: unknown, after?: number): boolean;
