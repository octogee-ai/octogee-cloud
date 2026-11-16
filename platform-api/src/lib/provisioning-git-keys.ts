import {
  createProvisioningServiceClient,
  provisioningServiceConfigFromEnvironment,
  type ProvisioningServiceClient,
} from "@octogee/core/provisioning-service-client";

export type ProvisioningGitKeys = Pick<ProvisioningServiceClient, "putGitKey" | "deleteGitKey">;

export function provisioningGitKeysFromEnvironment(env: NodeJS.ProcessEnv): ProvisioningGitKeys | null {
  const config = provisioningServiceConfigFromEnvironment(env);
  if (config === null) return null;
  return createProvisioningServiceClient({ ...config, retry: { attempts: 1, baseDelayMs: 0, maxDelayMs: 0 } });
}
