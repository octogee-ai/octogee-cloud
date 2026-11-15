import { WebSocket } from 'ws';
import type { NativeMobileBinding } from '@octogee/shared/types/native-mobile';
import { logger } from '@octogee/core/http/logging';
import type { MobileControlTransport } from './surface.js';
import { DesktopObserverTickets } from './desktop-stream.js';
import { MobileGatewayAuthority, mobileSession } from './mobile-authority.js';
import {
  mobileDigest,
  mobileRecord,
  mobileDefaultAgent,
  verifyMobileConnect,
  projectMobileHello,
  projectMobileSessionFrame,
  type MobileConnectProof,
} from '@octogee/core/identity/mobile-proof';

function operatorTokens(auth: Record<string, unknown>): NativeMobileBinding['httpTokens'] {
  const tokens = Array.isArray(auth.deviceTokens) ? [...auth.deviceTokens] : [];
  if (auth.role === 'operator' && auth.deviceToken) tokens.push(auth);
  return tokens
    .filter((t) => t.role === 'operator' && typeof t.deviceToken === 'string' && Array.isArray(t.scopes))
    .map((t) => {
      if (!Number.isSafeInteger(t.issuedAtMs) || t.issuedAtMs <= 0)
        throw new Error('Invalid native token issuance');
      return {
        hash: mobileDigest(t.deviceToken),
        scopes: t.scopes as string[],
        issuedAtMs: t.issuedAtMs as number,
      };
    });
}

interface Mutation {
  method: string;
  params: Record<string, unknown>;
  finish?: () => void;
}
function sessionField(params: Record<string, unknown>): 'sessionKey' | 'key' | null {
  if (typeof params.sessionKey === 'string') return 'sessionKey';
  return typeof params.key === 'string' ? 'key' : null;
}

export class MobileSocketTransport implements MobileControlTransport {
  role: 'node' | 'operator' = 'node';
  private proof?: MobileConnectProof;
  private connected = false;
  private handoff = false;
  private readonly mutations = new Map<string, Mutation>();
  private readonly aliases = new Map<string, string>();
  private readonly timer: NodeJS.Timeout;

  constructor(
    private binding: NativeMobileBinding,
    private readonly ws: WebSocket,
    private readonly authority: MobileGatewayAuthority,
    private readonly desktopTickets: DesktopObserverTickets,
  ) {
    this.timer = setTimeout(() => {
      logger.warn('Mobile handshake timed out', { enrollmentId: binding.id });
      ws.terminate();
    }, 10_000);
    this.timer.unref();
    ws.once('close', () => {
      clearTimeout(this.timer);
      for (const mutation of this.mutations.values()) mutation.finish?.();
    });
  }

  async prepareConnect(frame: Record<string, unknown>, nonce: string): Promise<string> {
    const proof = verifyMobileConnect(frame, nonce);
    this.proof = proof;
    this.role = proof.role;
    this.binding = await this.authority.broker('authorize', this.binding.id);
    if (this.binding.deviceId && !(proof.bootstrapToken && this.binding.state === 'reserved')) {
      if (proof.deviceId !== this.binding.deviceId || proof.publicKey !== this.binding.publicKey)
        throw new Error('mobile-key-mismatch');
      await this.authority.checkNative(this.binding, proof.role);
    } else await this.reserve(proof);
    this.handoff = !!proof.bootstrapToken;
    return JSON.stringify(frame);
  }

  private async reserve(proof: MobileConnectProof): Promise<void> {
    if (
      proof.role !== 'node' ||
      !proof.bootstrapToken ||
      this.binding.bootstrapHash !== mobileDigest(proof.bootstrapToken)
    )
      throw new Error('invalid-mobile-bootstrap');
    this.binding = await this.authority.broker('reserve', this.binding.id, {
      deviceId: proof.deviceId,
      publicKey: proof.publicKey,
      bootstrapHash: mobileDigest(proof.bootstrapToken),
    });
  }

  private async hello(
    frame: Record<string, unknown>,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const proof = this.proof!;
    const auth = mobileRecord(payload.auth);
    if (!auth) throw new Error('Invalid native mobile hello');
    const tokens = operatorTokens(auth);
    if (this.handoff && (!auth.deviceToken || tokens.length === 0)) {
      setTimeout(() => this.ws.close(1008, 'mobile-setup-interrupted'), 25);
      return {
        type: 'res',
        id: frame.id,
        ok: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'Phone setup was interrupted. Create a new QR code.',
          details: { code: 'AUTH_BOOTSTRAP_TOKEN_INVALID' },
        },
      };
    }
    if (this.binding.state === 'reserved')
      this.binding = await this.authority.broker('commit', this.binding.id, {
        deviceId: proof.deviceId,
        publicKey: proof.publicKey,
        httpTokens: tokens,
        nodeTokenIssuedAtMs: auth.issuedAtMs,
      });
    if (proof.role === 'operator')
      this.binding = await this.authority.broker('active', this.binding.id, { deviceId: proof.deviceId });
    this.connected = true;
    clearTimeout(this.timer);
    return projectMobileHello(frame, this.authority.origin(), this.authority.basePath(this.binding.id));
  }

  async acceptFrame(frame: Record<string, unknown>): Promise<Record<string, unknown>> {
    const payload = mobileRecord(frame.payload);
    if (payload?.type === 'hello-ok' && this.proof) return this.hello(frame, payload);
    const mutation = typeof frame.id === 'string' ? this.mutations.get(frame.id) : undefined;
    if (mutation) {
      this.mutations.delete(frame.id as string);
      try {
        if (frame.ok === true) await this.acceptMutation(mutation, payload);
      } finally {
        mutation.finish?.();
      }
    }
    return this.projectDesktop(frame, payload);
  }

  private async acceptMutation(mutation: Mutation, payload: Record<string, unknown> | null): Promise<void> {
    if (mutation.params.deviceId !== this.binding.deviceId) return;
    if (mutation.method !== 'device.token.rotate') {
      await this.authority.revoke(this.binding.id);
      return;
    }
    if (payload?.tokenDelivery === 'withheld-cross-device' && payload.token === undefined) {
      await this.authority.revoke(this.binding.id, 25);
      return;
    }
    if (!payload || typeof payload.token !== 'string') throw new Error('Invalid native token rotation');
    const fields: Record<string, unknown> = { deviceId: this.binding.deviceId };
    if (mutation.params.role === 'node') fields.nodeTokenIssuedAtMs = payload.rotatedAtMs;
    else
      fields.httpTokens = [
        { hash: mobileDigest(payload.token), scopes: payload.scopes, issuedAtMs: payload.rotatedAtMs },
      ];
    this.binding = await this.authority.broker('tokens', this.binding.id, fields);
  }

  private projectDesktop(
    frame: Record<string, unknown>,
    payload: Record<string, unknown> | null,
  ): Record<string, unknown> {
    if (payload?.transport !== 'rfb' || typeof payload.wsPath !== 'string') return frame;
    const projected = this.desktopTickets.project(frame, mobileSession(this.binding));
    const result = mobileRecord(projected.payload)!;
    return {
      ...projected,
      payload: {
        ...result,
        wsPath: (result.wsPath as string).replace(
          `/g/${this.authority.gatewayId}/openclaw`,
          this.authority.basePath(this.binding.id),
        ),
      },
    };
  }

  async prepareRequest(frame: Record<string, unknown>): Promise<Record<string, unknown>> {
    const params = mobileRecord(frame.params);
    if (!params || !this.proof) return frame;
    const field = sessionField(params);
    if (!field) return frame;
    const agentId = mobileDefaultAgent(
      params[field] as string,
      this.proof.deviceId,
      this.binding.workspaceSlug,
    );
    if (!agentId) {
      if (this.aliases.has(params[field] as string))
        this.aliases.set(params[field] as string, params[field] as string);
      return frame;
    }
    const resolved = (await this.authority.broker('session', this.binding.id, {
      agentId,
    })) as NativeMobileBinding & { resolvedSessionKey: string };
    if (
      typeof resolved.resolvedSessionKey !== 'string' ||
      !resolved.resolvedSessionKey.startsWith(`agent:${agentId}:mattermost:`)
    )
      throw new Error('Invalid mobile conversation route');
    if (this.aliases.size >= 64 && !this.aliases.has(resolved.resolvedSessionKey))
      throw new Error('Mobile conversation limit exceeded');
    this.aliases.set(resolved.resolvedSessionKey, params[field] as string);
    return {
      ...frame,
      params: {
        ...params,
        [field]: resolved.resolvedSessionKey,
        ...(params.agentId === 'main' ? { agentId } : {}),
      },
    };
  }

  projectFrame(frame: Record<string, unknown>): Record<string, unknown> {
    return projectMobileSessionFrame(frame, this.aliases);
  }

  observeRequest(frame: Record<string, unknown>): void {
    if (
      typeof frame.id !== 'string' ||
      !['device.pair.remove', 'device.token.revoke', 'device.token.rotate'].includes(String(frame.method))
    )
      return;
    if (this.mutations.size >= 64) throw new Error('mobile-mutation-limit');
    const mutation: Mutation = { method: frame.method as string, params: mobileRecord(frame.params) ?? {} };
    if (mutation.method === 'device.token.rotate' && mutation.params.deviceId === this.binding.deviceId)
      mutation.finish = this.trackRotation();
    this.mutations.set(frame.id, mutation);
  }

  private trackRotation(): () => void {
    const finish = this.authority.beginRotation(this.binding.id);
    const timer = setTimeout(() => {
      this.ws.close(1008, 'mobile-rotation-timeout');
      finish();
    }, 30_000);
    timer.unref();
    return () => {
      clearTimeout(timer);
      finish();
    };
  }

  async authorize(): Promise<boolean> {
    this.binding = await this.authority.broker('authorize', this.binding.id);
    if (this.proof && this.connected) await this.authority.checkNative(this.binding, this.proof.role);
    return true;
  }
}
