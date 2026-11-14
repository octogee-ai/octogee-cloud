/**
 * Pure client + formatter for `octogee_status` — no openclaw dependency so it
 * is unit-testable outside the gateway image. The broker endpoint
 * (octogee-api `/internal/byok/agent-usage-status`) is KSA-tenant-bound and
 * roster-scoped: this pod can only ask about its own users. Fields the broker
 * adds beyond the platform's own are reported as account fields, verbatim.
 */
import { readFile } from "node:fs/promises";

export interface AgentUsageStatus {
  gatewayClass: string;
  week?: { percentUsed: number; resetAt: string };
  window: {
    percentUsed: number;
    nextRefillAt: string;
    degraded: boolean;
    // The broker denies outright (free allowance spent → 429-until-refill);
    // mutually exclusive with degraded.
    blocked: boolean;
    reason: string | null;
  };
  credits?: { balanceUsd: number } | null;
  credential: {
    path: "platform_broker" | "byok_api_key" | "byosub" | "byosub_suppressed_customer";
    provider: string | null;
  };
  [accountField: string]: unknown;
}

const PLATFORM_FIELDS = new Set(["gatewayClass", "week", "window", "credits", "credential"]);

export class StatusToolError extends Error {
  constructor(
    readonly code: "no-agent" | "broker-error" | "malformed",
    message: string,
  ) {
    super(message);
  }
}

const DEFAULT_TOKEN_PATH = "/var/run/octogee/api-token/token";

function trimTrailingSlashes(value: string): string {
  let out = value;
  while (out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

function defaultBrokerUrl(): string {
  const configured = process.env.FLEET_BROKER_URL || process.env.OCTOGEE_API_URL;
  if (configured) return trimTrailingSlashes(configured);
  const ns = process.env.K8S_NAMESPACE ?? "octogee";
  return `http://octogee-api.${ns}.svc.cluster.local:3001`;
}

export async function fetchAgentUsageStatus(opts: {
  agentId: string;
  brokerUrl?: string;
  tokenPath?: string;
  fetchImpl?: typeof fetch;
  readTokenImpl?: (path: string) => Promise<string>;
}): Promise<AgentUsageStatus> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const readTokenImpl = opts.readTokenImpl ?? ((p: string) => readFile(p, "utf8"));
  const brokerUrl = trimTrailingSlashes(opts.brokerUrl ?? defaultBrokerUrl());
  const token = (await readTokenImpl(opts.tokenPath ?? DEFAULT_TOKEN_PATH)).trim();

  const res = await fetchImpl(`${brokerUrl}/internal/byok/agent-usage-status`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-k8s-sa-token": token,
    },
    body: JSON.stringify({ agentId: opts.agentId }),
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 200);
    throw new StatusToolError("broker-error", `agent-usage-status ${res.status} ${body}`);
  }
  const data = (await res.json()) as AgentUsageStatus;
  if (!data || typeof data !== "object" || !data.window || !data.credential) {
    throw new StatusToolError("malformed", "agent-usage-status: malformed broker response");
  }
  return data;
}

const CREDENTIAL_LABELS: Record<AgentUsageStatus["credential"]["path"], string> = {
  platform_broker: "Platform tokens (metered broker token)",
  byok_api_key: "Owner API key (BYOK) — no platform budget",
  byosub: "Owner subscription (BYOSUB) — no platform budget",
  byosub_suppressed_customer:
    "Owner subscription SUPPRESSED (this gateway requires verified turn authority) — running platform tokens under the owner's policy",
};

function refillClause(nextRefillAt: string): string {
  const date = new Date(nextRefillAt);
  return Number.isNaN(date.getTime()) ? "" : ` · refills ${date.toISOString()}`;
}

function accountLine(status: AgentUsageStatus): string | null {
  const fields = Object.entries(status)
    .filter(([key, value]) => !PLATFORM_FIELDS.has(key) && value !== null && value !== undefined)
    .map(([key, value]) => `${key} ${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
  return fields.length ? `Account: ${fields.join(" · ")}` : null;
}

export function formatStatusText(status: AgentUsageStatus): string {
  const lines: string[] = [];
  lines.push(`Gateway class: ${status.gatewayClass}`);
  const account = accountLine(status);
  if (account) lines.push(account);
  lines.push(`Billing: ${CREDENTIAL_LABELS[status.credential.path]}` +
    (status.credential.provider ? ` (${status.credential.provider})` : ""));
  if (status.credential.path === "platform_broker" || status.credential.path === "byosub_suppressed_customer") {
    lines.push(
      `Token window: ${status.window.percentUsed}% used${refillClause(status.window.nextRefillAt)}`,
    );
    if (status.window.blocked) {
      lines.push(
        status.window.reason === "week_exhausted"
          ? "Throttle: BLOCKED — weekly allowance spent, resumes when the week resets"
          : "Throttle: BLOCKED — burst window spent, resumes at the next refill",
      );
    } else if (status.window.degraded) {
      lines.push(
        status.window.reason === null || status.window.reason === "window_exhausted"
          ? "Throttle: window exhausted — degraded to the house model until refill"
          : `Throttle: degraded to the house model (${status.window.reason})`,
      );
    } else {
      lines.push("Throttle: none — full models available");
    }
  }
  return lines.join("\n");
}

function dualReadGatewayClassValue(value: string): string {
  return value === "builder" ? "isolated" : value;
}

export function gatewayClassMismatchNote(podClass: string, fleetDocClass: string): string {
  if (!podClass || dualReadGatewayClassValue(podClass) === dualReadGatewayClassValue(fleetDocClass)) return "";
  return `\n⚠ pod env says GATEWAY_CLASS=${podClass} but the fleet doc says ${fleetDocClass}`;
}
