import type {
  GatewayClass,
  GatewayDesiredStatus,
} from "@octogee/shared/types/glm";
import {
  gatewayModelKeySecretName,
  gatewayModelKeySourceLabelErrors,
  gatewayModelKeySourceLabels,
  type GatewayModelKeySourceSecret,
} from "./model-key-secret-ensurer.js";

export interface IssuedGatewayModelKey {
  value: string;
  provider: "anthropic";
  capped: true;
}

export interface GatewayModelKeyIssuerBackend {
  issueGatewayModelKey(opts: {
    gatewayId: string;
    ownerUid?: string;
    secretName: string;
  }): Promise<IssuedGatewayModelKey | null>;
  revokeGatewayModelKey?(opts: {
    gatewayId: string;
    ownerUid?: string;
    secretName: string;
  }): Promise<void>;
}

export interface GatewayModelKeySourceIssuer {
  syncGatewayModelKeySource(opts: {
    gatewayId: string;
    gatewayClass: GatewayClass;
    desiredStatus: GatewayDesiredStatus;
    ownerUid?: string;
  }): Promise<GatewayModelKeySourceResult>;
}

export interface GatewayModelKeySourceResult {
  gatewayId: string;
  secretName: string;
  changed: boolean;
  action:
    | "issued"
    | "deleted"
    | "unchanged"
    | "skipped";
  reason?:
    | "non_builder"
    | "retired"
    | "missing_source"
    | "missing_issuer"
    | "invalid_source_labels"
    | "empty_source_value"
    | "issuer_declined";
}

export interface GatewayModelKeySourceIssuerDeps {
  readSourceSecret: (
    secretName: string,
  ) => Promise<GatewayModelKeySourceSecret | null>;
  writeSourceSecret: (opts: {
    name: string;
    value: string;
    labels: Record<string, string>;
  }) => Promise<void>;
  deleteSourceSecret: (secretName: string) => Promise<{ deleted: boolean }>;
  backend?: GatewayModelKeyIssuerBackend;
  log: (msg: string) => void;
}

export interface HttpGatewayModelKeyIssuerBackendDeps {
  issueUrl: string;
  revokeUrl?: string;
  bearerToken?: string;
  timeoutMs?: number;
}

const DEFAULT_HTTP_ISSUER_TIMEOUT_MS = 10_000;

function invalidSourceReason(
  gatewayId: string,
  source: GatewayModelKeySourceSecret,
): GatewayModelKeySourceResult["reason"] | null {
  const labelErrors = gatewayModelKeySourceLabelErrors(gatewayId, source.labels);
  if (labelErrors.length > 0) return "invalid_source_labels";
  if (!source.value.trim()) return "empty_source_value";
  return null;
}

function issuerOutputIsValid(
  issued: IssuedGatewayModelKey,
): issued is IssuedGatewayModelKey {
  return issued.provider === "anthropic" && issued.capped === true && !!issued.value.trim();
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string") return value;
  }
  return "";
}

async function postJson(
  url: string,
  body: Record<string, unknown>,
  opts: {
    bearerToken?: string;
    timeoutMs: number;
  },
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const resp = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        ...(opts.bearerToken ? { authorization: `Bearer ${opts.bearerToken}` } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(
        `issuer HTTP ${resp.status}: ${text.slice(0, 200) || resp.statusText}`,
      );
    }
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

function parseIssuedGatewayModelKey(raw: unknown): IssuedGatewayModelKey | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as {
    value?: unknown;
    apiKey?: unknown;
    provider?: unknown;
    capped?: unknown;
  };
  const value = firstString(data.value, data.apiKey);
  if (!value) return null;
  return {
    value,
    provider: data.provider === "anthropic" ? "anthropic" : (data.provider as "anthropic"),
    capped: data.capped === true ? true : (data.capped as true),
  };
}

export function createHttpGatewayModelKeyIssuerBackend(
  deps: HttpGatewayModelKeyIssuerBackendDeps,
): GatewayModelKeyIssuerBackend {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_HTTP_ISSUER_TIMEOUT_MS;
  return {
    async issueGatewayModelKey({ gatewayId, ownerUid, secretName }) {
      const issued = parseIssuedGatewayModelKey(
        await postJson(
          deps.issueUrl,
          { gatewayId, ownerUid, secretName, provider: "anthropic" },
          { bearerToken: deps.bearerToken, timeoutMs },
        ),
      );
      return issued;
    },
    revokeGatewayModelKey: deps.revokeUrl
      ? async ({ gatewayId, ownerUid, secretName }) => {
          await postJson(
            deps.revokeUrl!,
            { gatewayId, ownerUid, secretName, provider: "anthropic" },
            { bearerToken: deps.bearerToken, timeoutMs },
          );
        }
      : undefined,
  };
}

function parsePositiveNumber(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function gatewayClassUsesBrokerToken(gatewayClass: GatewayClass): boolean {
  return gatewayClass === "isolated";
}

export function createConfiguredGatewayModelKeyIssuerBackend(
  env: NodeJS.ProcessEnv,
): GatewayModelKeyIssuerBackend | undefined {
  const issueUrl = env.GATEWAY_MODEL_KEY_ISSUER_URL;
  if (!issueUrl) return undefined;
  return createHttpGatewayModelKeyIssuerBackend({
    issueUrl,
    revokeUrl: env.GATEWAY_MODEL_KEY_REVOKE_URL,
    bearerToken: env.GATEWAY_MODEL_KEY_ISSUER_BEARER_TOKEN,
    timeoutMs: parsePositiveNumber(env.GATEWAY_MODEL_KEY_ISSUER_TIMEOUT_MS),
  });
}

export function createGatewayModelKeySourceIssuer(
  deps: GatewayModelKeySourceIssuerDeps,
): GatewayModelKeySourceIssuer {
  return {
    async syncGatewayModelKeySource({
      gatewayId,
      gatewayClass,
      desiredStatus,
      ownerUid,
    }) {
      const secretName = gatewayModelKeySecretName(gatewayId);
      const deleteAndReport = async (
        reason: GatewayModelKeySourceResult["reason"],
      ): Promise<GatewayModelKeySourceResult> => {
        const existing = await deps.readSourceSecret(secretName);
        if (!existing) {
          return {
            gatewayId,
            secretName,
            changed: false,
            action: "skipped",
            reason,
          };
        }
        if (deps.backend?.revokeGatewayModelKey) {
          await deps.backend.revokeGatewayModelKey({ gatewayId, ownerUid, secretName });
        }
        const result = await deps.deleteSourceSecret(secretName);
        if (result.deleted) {
          deps.log(
            `[model-key-source] deleted ${secretName} (${reason ?? "policy"})`,
          );
        }
        return {
          gatewayId,
          secretName,
          changed: result.deleted,
          action: result.deleted ? "deleted" : "skipped",
          reason,
        };
      };

      if (!gatewayClassUsesBrokerToken(gatewayClass)) {
        return deleteAndReport("non_builder");
      }
      if (desiredStatus === "retired") {
        return deleteAndReport("retired");
      }

      const existing = await deps.readSourceSecret(secretName);
      if (existing) {
        const invalidReason = invalidSourceReason(gatewayId, existing);
        if (invalidReason) {
          deps.log(
            `[model-key-source] refusing ${secretName}: existing source is ${invalidReason}`,
          );
          return {
            gatewayId,
            secretName,
            changed: false,
            action: "skipped",
            reason: invalidReason,
          };
        }
        return { gatewayId, secretName, changed: false, action: "unchanged" };
      }

      if (!deps.backend) {
        return {
          gatewayId,
          secretName,
          changed: false,
          action: "skipped",
          reason: "missing_issuer",
        };
      }

      const issued = await deps.backend.issueGatewayModelKey({
        gatewayId,
        ownerUid,
        secretName,
      });
      if (!issued) {
        return {
          gatewayId,
          secretName,
          changed: false,
          action: "skipped",
          reason: "issuer_declined",
        };
      }
      if (!issuerOutputIsValid(issued)) {
        throw new Error(
          `model-key issuer returned an invalid or uncapped key for ${gatewayId}`,
        );
      }

      await deps.writeSourceSecret({
        name: secretName,
        value: issued.value.trim(),
        labels: gatewayModelKeySourceLabels(gatewayId),
      });
      deps.log(`[model-key-source] issued capped ${secretName}`);
      return { gatewayId, secretName, changed: true, action: "issued" };
    },
  };
}
