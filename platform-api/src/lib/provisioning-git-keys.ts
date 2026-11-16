import { readFile } from "node:fs/promises";
import { PROVISIONING_API_VERSION, type GitKey } from "@octogee/shared/types/provisioning-service";
import {
  isAddressableUid,
  provisioningServiceConfigFromEnvironment,
  ProvisioningServiceError,
  type ProvisioningServiceConfig,
} from "@octogee/core/provisioning-service-client";

const REQUEST_TIMEOUT_MS = 10_000;

export interface ProvisioningGitKeys {
  put(uid: string, gatewayId: string, publicKey: string): Promise<GitKey>;
  delete(uid: string, gatewayId: string): Promise<void>;
}

export interface ProvisioningGitKeysDeps extends ProvisioningServiceConfig {
  readonly fetch?: typeof fetch;
  readonly readToken?: (path: string) => Promise<string>;
}

function retryAfterMs(header: string | null): number | null {
  if (header === null) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

async function errorFrom(response: Response, operation: string): Promise<ProvisioningServiceError> {
  let body: unknown = null;
  try {
    body = JSON.parse(await response.text());
  } catch {
    body = null;
  }
  const fields = typeof body === "object" && body !== null ? body as { code?: unknown; error?: unknown } : {};
  const code = typeof fields.code === "string" ? fields.code : "unexpected-response";
  const detail = typeof fields.error === "string" ? fields.error : `answered ${response.status}`;
  return new ProvisioningServiceError(
    response.status,
    code as ProvisioningServiceError["code"],
    `provisioning service ${operation}: ${detail}`,
    retryAfterMs(response.headers.get("retry-after")),
  );
}

function keyPath(uid: string, gatewayId: string): string {
  if (!isAddressableUid(uid)) throw new ProvisioningServiceError(400, "invalid-request", "provisioning service git key: the uid is not addressable");
  return `users/${encodeURIComponent(uid)}/git-keys/${encodeURIComponent(gatewayId)}`;
}

export function createProvisioningGitKeys(deps: ProvisioningGitKeysDeps): ProvisioningGitKeys {
  const fetchImpl = deps.fetch ?? fetch;
  const readToken = deps.readToken ?? (async (path: string) => (await readFile(path, "utf8")).trim());
  const base = new URL(`/${PROVISIONING_API_VERSION}/`, deps.baseUrl);

  async function send(method: "PUT" | "DELETE", path: string, operation: string, body?: unknown): Promise<Response> {
    const token = await readToken(deps.tokenPath);
    if (token === "") throw new ProvisioningServiceError(0, "unreachable", `provisioning service ${operation}: the service account token is empty`);
    let response: Response;
    try {
      response = await fetchImpl(new URL(path, base), {
        method,
        redirect: "error",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new ProvisioningServiceError(0, "unreachable", `provisioning service ${operation} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) throw await errorFrom(response, operation);
    return response;
  }

  return {
    async put(uid, gatewayId, publicKey) {
      const response = await send("PUT", keyPath(uid, gatewayId), "put git key", { spec: { publicKey } });
      try {
        return JSON.parse(await response.text()) as GitKey;
      } catch {
        throw new ProvisioningServiceError(response.status, "unexpected-response", "provisioning service put git key: answered unreadable JSON");
      }
    },
    async delete(uid, gatewayId) {
      await send("DELETE", keyPath(uid, gatewayId), "delete git key");
    },
  };
}

export function provisioningGitKeysFromEnvironment(env: NodeJS.ProcessEnv): ProvisioningGitKeys | null {
  const config = provisioningServiceConfigFromEnvironment(env);
  return config === null ? null : createProvisioningGitKeys(config);
}
