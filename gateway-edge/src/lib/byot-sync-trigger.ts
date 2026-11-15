import { internalFetch } from "@octogee/core/internal-fetch";
import { isIPv4 } from "node:net";
import { logger } from "@octogee/core/http/logging";
import { platformStateStore } from "@octogee/core/identity/platform-state-store";
import { isSafeGatewayId } from "@octogee/core/model-credentials/byosub";
import { createModelCredentialSyncAuthHeaders } from "@octogee/core/model-credentials/byot-sync-internal-auth";
import {
  DEFAULT_HOUSE_MODEL_REF,
  userAgentModelDefaultFromDoc,
  resolveHouseModel,
  type UserAgentModelDefault,
} from "@octogee/shared/types/platform-config";

export interface ModelCredentialSyncUserData {
  byotActive?: boolean;
  username?: string;
  planInputs: Record<string, unknown>;
  // The operator's house model dial. Stamped onto every push payload by
  // postGatewayModelCredentialSync — a payload without it makes the pod-side
  // derive fall back to its compiled constant, silently reverting a dialed
  // fleet; the snapshot fingerprint wouldn't change, so reconcile can't repair
  // the drift until the next mount/roll.
  freeTierModelRef?: string;
  // The operator's default agent dial, stamped alongside the house model
  // dial: the {primary, fallbacks} a catalog agent runs with no explicit pick.
  builderAgentDefault?: UserAgentModelDefault;
  provisioning?: { openclaw?: { status?: string } };
  systemConfig?: {
    byot?: { provider?: string; baseUrl?: string; model?: string };
    modelCredential?: {
      active?: boolean;
      provider?: string;
      mode?: string;
      baseUrl?: string;
      model?: string;
    };
    agentModels?: Record<string, { primary: string; fallbacks: string[] }>;
  };
}

export interface GatewayModelCredentialSyncEnv {
  K8S_NAMESPACE?: string;
  GATEWAY_EDGE_INTERNAL_URL_TEMPLATE?: string;
  BYOT_SYNC_INTERNAL_SIGNING_SECRET?: string;
}

function trimTrailingSlash(value: string): string {
  let out = value;
  while (out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

export function gatewayModelCredentialSyncUrl(
  gatewayId: string,
  env: GatewayModelCredentialSyncEnv = process.env,
  runtime?: { runtime?: unknown; vm?: { status?: unknown; internalIp?: unknown } | null },
): string {
  if (!isSafeGatewayId(gatewayId)) {
    throw new Error(`invalid gatewayId ${JSON.stringify(gatewayId)}`);
  }
  let vmOrigin: string | undefined;
  if (!env.GATEWAY_EDGE_INTERNAL_URL_TEMPLATE && runtime?.runtime === "gce-vm") {
    const ip = runtime.vm?.internalIp;
    if (runtime.vm?.status !== "RUNNING" || typeof ip !== "string" || !isIPv4(ip)) {
      throw new Error(`Gateway VM is not reachable: ${gatewayId}`);
    }
    vmOrigin = `http://${ip}:3001`;
  }
  const base = env.GATEWAY_EDGE_INTERNAL_URL_TEMPLATE
    ? env.GATEWAY_EDGE_INTERNAL_URL_TEMPLATE.replace("{gatewayId}", gatewayId)
    : vmOrigin ?? `http://gateway-edge-${gatewayId}.${env.K8S_NAMESPACE ?? "octogee"}.svc.cluster.local:3001`;
  return `${trimTrailingSlash(base)}/api/g/${encodeURIComponent(gatewayId)}/internal/model-credential-sync`;
}

async function platformModelDialsForSync(logWarn: (msg: string) => void): Promise<{
  freeTierModelRef: string;
  builderAgentDefault: UserAgentModelDefault;
}> {
  try {
    const models = (await platformStateStore.config.platform.get("models"))?.value;
    const configured = models?.freeTierModelRef;
    return {
      freeTierModelRef: configured !== undefined && resolveHouseModel(configured)
        ? configured
        : DEFAULT_HOUSE_MODEL_REF,
      builderAgentDefault: userAgentModelDefaultFromDoc(models),
    };
  } catch (err) {
    logWarn(
      `platform model dial read failed for model credential sync — sending the compiled defaults: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return {
      freeTierModelRef: DEFAULT_HOUSE_MODEL_REF,
      builderAgentDefault: userAgentModelDefaultFromDoc(undefined),
    };
  }
}

export async function postGatewayModelCredentialSync(args: {
  gatewayId: string;
  userData: ModelCredentialSyncUserData;
  env?: GatewayModelCredentialSyncEnv;
  fetchImpl?: typeof fetch;
  logWarn?: (msg: string) => void;
}): Promise<void> {
  const env = args.env ?? process.env;
  const signingSecret = env.BYOT_SYNC_INTERNAL_SIGNING_SECRET ?? "";
  if (!signingSecret.trim()) {
    throw new Error("BYOT_SYNC_INTERNAL_SIGNING_SECRET is required for model credential sync");
  }
  const logWarn = args.logWarn ?? ((m: string) => logger.warn(m));
  if (!isSafeGatewayId(args.gatewayId)) throw new Error(`invalid gatewayId ${JSON.stringify(args.gatewayId)}`);
  const [dials, runtime] = await Promise.all([
    platformModelDialsForSync(logWarn),
    env.GATEWAY_EDGE_INTERNAL_URL_TEMPLATE
      ? undefined
      : platformStateStore.fleetRegistry.get(args.gatewayId).then((record) => record ?? undefined),
  ]);
  const userData: ModelCredentialSyncUserData = {
    ...dials,
    ...args.userData,
  };
  const body = JSON.stringify(userData);
  const authHeaders = createModelCredentialSyncAuthHeaders({ body: userData, gatewayId: args.gatewayId, secret: signingSecret });
  const res = await internalFetch(
    gatewayModelCredentialSyncUrl(args.gatewayId, env, runtime),
    {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body,
    },
    {
      fetchImpl: args.fetchImpl,
    },
  );
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`gateway model credential sync ${res.status} ${body}`.trim());
  }
}

export function triggerGatewayModelCredentialSync(args: {
  gatewayId: string;
  userData: ModelCredentialSyncUserData;
  env?: GatewayModelCredentialSyncEnv;
  fetchImpl?: typeof fetch;
  logWarn?: (msg: string) => void;
}): void {
  postGatewayModelCredentialSync(args).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    (args.logWarn ?? ((m) => logger.warn(m)))(
      `model credential sync trigger failed for ${args.gatewayId}: ${msg}`,
    );
  });
}
