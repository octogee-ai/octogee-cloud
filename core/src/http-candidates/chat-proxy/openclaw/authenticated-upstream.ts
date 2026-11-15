import { assertWorkspaceIdentityReady } from "../../../openclaw-workspace-bootstrap.js";
import type { WebSocket } from "ws";

import type { DeviceIdentity } from "@octogee/shared/types/device-identity";

import {
  OPENCLAW_EDGE_SERVICE_IDENTITY,
  openClawProxyIdentityHeaders,
  openClawProxyOrigin,
} from "@octogee/shared/types/openclaw-proxy-identity";

import { getOpenClawDeviceIdentity } from "./device-identity.js";
import {
  clearGatewayDeviceToken,
  fetchGatewayAuth,
  invalidateGatewayToken,
  persistGatewayDeviceToken,
  type FetchGatewayAuthOptions,
  type GatewayOpenClawAuth,
} from "./gateway-token.js";
import {
  OpenclawWireError,
  openUpstream,
  requestDevicePairBootstrapToken,
  type OpenUpstreamParams,
  type RequestDevicePairBootstrapTokenParams,
} from "./upstream.js";
import { podClientAddress } from "../../openclaw-control/proxy-identity.js";

export interface AuthenticatedUpstreamDeps {
  fetchGatewayAuth(opts: FetchGatewayAuthOptions): Promise<GatewayOpenClawAuth>;
  serviceClientAddress(): string | undefined;
  openUpstream(params: OpenUpstreamParams): Promise<WebSocket>;
  requestDevicePairBootstrapToken(params: RequestDevicePairBootstrapTokenParams): Promise<string>;
  clearGatewayDeviceToken(): Promise<void>;
  invalidateGatewayToken(gatewayId: string): void;
  persistGatewayDeviceToken(opts: { token: string }): Promise<void>;
  getIdentity(): DeviceIdentity;
}

const productionDeps: AuthenticatedUpstreamDeps = {
  fetchGatewayAuth,
  serviceClientAddress: podClientAddress,
  openUpstream,
  requestDevicePairBootstrapToken,
  clearGatewayDeviceToken,
  invalidateGatewayToken,
  persistGatewayDeviceToken,
  getIdentity: getOpenClawDeviceIdentity,
};

const FULL_ACCESS_DEVICE_SCOPES = [
  "operator.admin",
  "operator.approvals",
  "operator.questions",
  "operator.read",
  "operator.talk.secrets",
  "operator.write",
] as const;

export interface AuthenticatedUpstreamOptions {
  gatewayId: string;
  url: string;
  pairingUrl?: string;
  timeoutMs?: number;
}

async function connect(
  opts: AuthenticatedUpstreamOptions,
  auth: Pick<OpenUpstreamParams, "token" | "bootstrapToken" | "deviceToken">,
  deps: AuthenticatedUpstreamDeps,
  scopes?: string[],
): Promise<{ ws: WebSocket; issuedDeviceToken: boolean }> {
  let issuedDeviceToken = false;
  const ws = await deps.openUpstream({
    url: opts.url,
    token: auth.token,
    bootstrapToken: auth.bootstrapToken,
    deviceToken: auth.deviceToken,
    identity: deps.getIdentity(),
    scopes,
    timeoutMs: opts.timeoutMs,
    onDeviceToken: async (issued) => {
      await deps.persistGatewayDeviceToken({ token: issued.deviceToken });
      issuedDeviceToken = true;
    },
  });
  return { ws, issuedDeviceToken };
}

function connectWithProxyIdentity(
  opts: AuthenticatedUpstreamOptions,
  deps: AuthenticatedUpstreamDeps,
): Promise<WebSocket> {
  assertWorkspaceIdentityReady();
  const clientAddress = deps.serviceClientAddress();
  if (!clientAddress) {
    throw new OpenclawWireError("auth-failed", "service identity upstream requires a non-loopback IPv4 address");
  }
  return deps.openUpstream({
    url: opts.url,
    identity: deps.getIdentity(),
    timeoutMs: opts.timeoutMs,
    proxyIdentity: {
      headers: {
        ...openClawProxyIdentityHeaders({ user: OPENCLAW_EDGE_SERVICE_IDENTITY, clientAddress }),
        origin: openClawProxyOrigin(),
      },
    },
  });
}

export async function openUpstreamWithGatewayAuth(
  opts: AuthenticatedUpstreamOptions,
  auth: GatewayOpenClawAuth,
  deps: AuthenticatedUpstreamDeps = productionDeps,
): Promise<WebSocket> {
  if (auth.source === "trusted-proxy") {
    return connectWithProxyIdentity(opts, deps);
  }
  if (auth.source !== "legacy-token") {
    return (await connect(opts, auth, deps, [...FULL_ACCESS_DEVICE_SCOPES])).ws;
  }

  const pairingOpts = opts.pairingUrl ? { ...opts, url: opts.pairingUrl } : opts;
  const enrollment = await connect(pairingOpts, auth, deps);
  if (enrollment.issuedDeviceToken) {
    return enrollment.ws;
  }
  let bootstrapToken: string;
  try {
    bootstrapToken = await deps.requestDevicePairBootstrapToken({
      ws: enrollment.ws,
      url: pairingOpts.url,
      timeoutMs: opts.timeoutMs ?? 30_000,
    });
  } finally {
    enrollment.ws.terminate();
  }

  const paired = await connect(
    pairingOpts,
    { bootstrapToken },
    deps,
    [...FULL_ACCESS_DEVICE_SCOPES],
  );
  if (!paired.issuedDeviceToken) {
    paired.ws.terminate();
    throw new OpenclawWireError(
      "invalid-response",
      "OpenClaw bootstrap pairing completed without issuing a device token",
    );
  }
  return paired.ws;
}

async function rotateAuth(
  gatewayId: string,
  stale: GatewayOpenClawAuth,
  deps: AuthenticatedUpstreamDeps,
): Promise<GatewayOpenClawAuth> {
  if (stale.source === "legacy-token") {
    deps.invalidateGatewayToken(gatewayId);
  } else if (stale.source === "device-token-file") {
    await deps.clearGatewayDeviceToken();
  }
  return deps.fetchGatewayAuth({
    gatewayId,
    allowLegacyFallback: true,
    skipCache: true,
  });
}

export async function openAuthenticatedUpstream(
  opts: AuthenticatedUpstreamOptions,
  deps: AuthenticatedUpstreamDeps = productionDeps,
): Promise<WebSocket> {
  const initial = await deps.fetchGatewayAuth({
    gatewayId: opts.gatewayId,
    allowLegacyFallback: true,
  });
  try {
    return await openUpstreamWithGatewayAuth(opts, initial, deps);
  } catch (error) {
    if (!(error instanceof OpenclawWireError) || error.code !== "auth-failed") throw error;
  }
  const fresh = await rotateAuth(opts.gatewayId, initial, deps);
  return openUpstreamWithGatewayAuth(opts, fresh, deps);
}
