import type { SizingKeyReader } from "@octogee/core/sizing-key";
import type { PlatformStateStore } from "@octogee/core/platform-state";
import type { CopyHomeDisk, HomeCopyInput, HomeCopyProgress, UserHomeLocation, UserHomeOwner } from "@octogee/core/isolated-gateway-lifecycle";

export interface UserHomeMigrationDeps {
  store: PlatformStateStore;
  readSizingKey: SizingKeyReader;
  environment: "test" | "prod";
  now: () => number;
  subnetwork: string;
  nativeZones: readonly string[];
  nativeZone: (uid: string) => Promise<string | null>;
  inventory: (uid: string, owner: UserHomeOwner) => Promise<UserHomeLocation | null>;
  verifyStopped: (uid: string, source: UserHomeLocation) => Promise<void>;
  copy: {
    advance(input: HomeCopyInput): Promise<{ progress: HomeCopyProgress; target?: CopyHomeDisk }>;
    release(input: HomeCopyInput): Promise<boolean>;
    abort(input: HomeCopyInput): Promise<boolean>;
  };
  adopt: (input: { uid: string; target: CopyHomeDisk }) => Promise<boolean>;
  removeStoppedHome: (uid: string, source: UserHomeLocation) => Promise<boolean>;
  log: (message: string) => void;
}
