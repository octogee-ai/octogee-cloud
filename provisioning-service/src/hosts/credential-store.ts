import type { ProvisioningCredential, ProvisioningCredentialName } from "@octogee/shared/types/provisioning-service";

export class LeaseLostError extends Error {
  constructor(uid: string) {
    super(`lease on ${uid} is no longer held`);
    this.name = "LeaseLostError";
  }
}

export interface CredentialStore {
  read(uid: string, name: ProvisioningCredentialName): Promise<ProvisioningCredential | null>;
  names(uid: string): Promise<ProvisioningCredentialName[]>;
  write(uid: string, name: ProvisioningCredentialName, value: string, leaseToken: string): Promise<{ version: number }>;
}
