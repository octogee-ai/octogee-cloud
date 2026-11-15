import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { WebSocket } from 'ws';
import type { NativeMobileBinding } from '@octogee/shared/types/native-mobile';
import { sendWsRequest } from '@octogee/shared/types/openclaw-wire-core';
import { isPerUserControlIdentity } from '@octogee/shared/types/openclaw-proxy-identity';
import { postOpenClawControlBroker } from '@octogee/core/http-candidates/openclaw-control/broker';
import {
  createOpenClawControlProxyIdentity,
  openProxyIdentitySocket,
  type OpenClawControlProxyIdentity,
} from '@octogee/core/http-candidates/openclaw-control/proxy-identity';
import { openClawControlUpstreamBase } from './surface.js';
import type { OpenClawControlSession } from '@octogee/core/http-candidates/openclaw-control/session';
import type { MattermostControlChat } from '@octogee/core/http-candidates/openclaw-control/mattermost-chat';
import type { WorkspaceServingResolver } from './workspace-serving.js';
import { mobileRecord } from './mobile-proof.js';
import { isIsolatedGatewayClassValue } from "@octogee/shared/types/glm";

export type MobileBroker = (
  operation: string,
  id: string,
  fields?: Record<string, unknown>,
) => Promise<NativeMobileBinding>;
type Rpc = (method: string, params: Record<string, unknown>) => Promise<unknown>;
export interface MobileOptions {
  env?: NodeJS.ProcessEnv;
  broker?: MobileBroker;
  rpc?: Rpc;
  identity?: OpenClawControlProxyIdentity;
  auth?: RequestHandler;
  workspaceServing?: WorkspaceServingResolver;
  authorizationIntervalMs?: number;
  mattermostChat?: MattermostControlChat;
}

export function mobileOrigin(env: NodeJS.ProcessEnv): string {
  const url = new URL(env.API_PUBLIC_URL!);
  if (
    url.protocol !== 'https:' ||
    url.pathname !== '/' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Mobile gateway requires an HTTPS API_PUBLIC_URL origin');
  return url.origin;
}

export function mobileSession(e: NativeMobileBinding): OpenClawControlSession {
  return {
    sessionId: e.id,
    uid: e.uid,
    gatewayId: e.gatewayId,
    revisionId: e.gatewayId,
    workspaceSlug: e.workspaceSlug,
    idleExpiresAt: Number.MAX_SAFE_INTEGER,
    absoluteExpiresAt: Number.MAX_SAFE_INTEGER,
  };
}

function defaultBroker(gatewayId: string, env: NodeJS.ProcessEnv): MobileBroker {
  return async (operation, id, fields = {}) => {
    const response = await postOpenClawControlBroker(
      `/internal/mobile-devices/${operation}`,
      { gatewayId, revisionId: env.GATEWAY_REVISION_ID, id, ...fields },
      env,
    );
    if (!response.ok) throw new Error(`mobile-broker-${response.status}`);
    const result = (await response.json()) as NativeMobileBinding;
    if (
      result.id !== id ||
      result.gatewayId !== gatewayId ||
      typeof result.uid !== 'string' ||
      !result.uid ||
      !Array.isArray(result.httpTokens)
    )
      throw new Error('Invalid mobile broker response');
    return result;
  };
}

function defaultRpc(env: NodeJS.ProcessEnv, identity: OpenClawControlProxyIdentity): Rpc {
  return async (method, params) => {
    const url = openClawControlUpstreamBase(env);
    url.protocol = 'ws:';
    const ws = await openProxyIdentitySocket({ url, headers: identity.serviceHeaders(), timeoutMs: 10_000 });
    try {
      return await sendWsRequest({ ws, id: randomUUID(), method, params, timeoutMs: 15_000 });
    } finally {
      ws.close();
    }
  };
}

function nativeDevice(
  list: unknown,
  binding: NativeMobileBinding,
  role?: string,
): Record<string, unknown> | undefined {
  const devices = mobileRecord(list)?.paired;
  if (!Array.isArray(devices)) throw new Error('Invalid native device list');
  return devices.find(
    (d) =>
      d.deviceId === binding.deviceId &&
      d.publicKey === binding.publicKey &&
      (!role || d.role === role || d.roles?.includes(role)),
  );
}

function tokenGeneration(device: Record<string, unknown>, role: string): number | null {
  if (!Array.isArray(device.tokens)) return null;
  const token = device.tokens.find((t) => t.role === role);
  if (!token || token.revokedAtMs) return null;
  const generation = token.rotatedAtMs ?? token.createdAtMs;
  return Number.isSafeInteger(generation) && generation > 0 ? (generation as number) : null;
}

function currentTokens(binding: NativeMobileBinding, paired: Record<string, unknown>): boolean {
  return (
    binding.nodeTokenIssuedAtMs === tokenGeneration(paired, 'node') &&
    binding.httpTokens.some((t) => t.issuedAtMs === tokenGeneration(paired, 'operator'))
  );
}

export class MobileGatewayAuthority {
  readonly env: NodeJS.ProcessEnv;
  readonly gatewayId: string;
  readonly identity: OpenClawControlProxyIdentity;
  readonly broker: MobileBroker;
  readonly rpc: Rpc;
  private readonly sockets = new Map<string, Set<WebSocket>>();
  private readonly rotations = new Map<string, Set<Promise<void>>>();

  constructor(readonly options: MobileOptions) {
    this.env = options.env ?? process.env;
    this.gatewayId = this.env.GATEWAY_ID!;
    this.identity =
      options.identity ??
      createOpenClawControlProxyIdentity({
        env: this.env,
        upstreamBase: () => openClawControlUpstreamBase(this.env),
      });
    this.broker = options.broker ?? defaultBroker(this.gatewayId, this.env);
    this.rpc = options.rpc ?? defaultRpc(this.env, this.identity);
  }

  enabled(): boolean {
    return (
      isIsolatedGatewayClassValue(this.env.GATEWAY_CLASS) && isPerUserControlIdentity(this.env) && this.identity.enabled
    );
  }
  origin(): string {
    return mobileOrigin(this.env);
  }
  basePath(id: string): string {
    return `${this.controlBasePath()}/mobile/${id}`;
  }
  controlBasePath(): string {
    return `/g/${this.gatewayId}/openclaw`;
  }

  register(id: string, ws: WebSocket): void {
    const peers = this.sockets.get(id) ?? new Set<WebSocket>();
    peers.add(ws);
    this.sockets.set(id, peers);
    ws.once('close', () => {
      peers.delete(ws);
      if (!peers.size) this.sockets.delete(id);
    });
  }

  async revoke(id: string, closeDelayMs = 0): Promise<void> {
    await this.broker('revoke', id);
    const close = () => {
      for (const ws of this.sockets.get(id) ?? []) ws.close(1008, 'mobile-device-revoked');
    };
    if (closeDelayMs) setTimeout(close, closeDelayMs).unref();
    else close();
  }

  beginRotation(id: string): () => void {
    const rotations = this.rotations.get(id) ?? new Set<Promise<void>>();
    let complete!: () => void;
    const pending = new Promise<void>((resolve) => {
      complete = resolve;
    });
    rotations.add(pending);
    this.rotations.set(id, rotations);
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      complete();
      rotations.delete(pending);
      if (!rotations.size) this.rotations.delete(id);
    };
  }

  private async settleRotations(id: string): Promise<void> {
    while (this.rotations.has(id)) await Promise.all(this.rotations.get(id)!);
  }

  async checkNative(binding: NativeMobileBinding, role?: string): Promise<Record<string, unknown>> {
    await this.settleRotations(binding.id);
    let paired = nativeDevice(await this.rpc('device.pair.list', {}), binding, role);
    if (paired && currentTokens(binding, paired)) return paired;
    await this.settleRotations(binding.id);
    const current = await this.broker('authorize', binding.id);
    paired = nativeDevice(await this.rpc('device.pair.list', {}), current, role);
    if (this.rotations.has(binding.id)) return this.checkNative(current, role);
    if (paired && currentTokens(current, paired)) return paired;
    await this.revoke(binding.id);
    throw new Error('Native mobile credentials no longer match the enrollment');
  }
}
