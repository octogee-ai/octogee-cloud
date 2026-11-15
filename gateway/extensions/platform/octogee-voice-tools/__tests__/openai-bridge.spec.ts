import { MessageChannel } from 'node:worker_threads';
import type { RealtimeVoiceBridge, RealtimeVoiceBridgeCreateRequest, RealtimeVoiceProviderPlugin } from 'openclaw/plugin-sdk/realtime-voice';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { latestLifecycle, resetVoiceSdk } from './voice-sdk.js';
vi.mock('openclaw/plugin-sdk/realtime-voice', async () => {
  const { realtimeVoice } = await import('./voice-sdk.js');
  return realtimeVoice;
});
vi.mock('openclaw/plugin-sdk/realtime-voice-provider', async () => {
  const { realtimeVoiceProvider } = await import('./voice-sdk.js');
  return realtimeVoiceProvider;
});
import { createBrokeredOpenAiBridge } from '../openai-bridge.js';

afterEach(() => resetVoiceSdk());

function setup(load?: () => Promise<RealtimeVoiceProviderPlugin>) {
  const native = {
    connect: vi.fn(async () => {}), close: vi.fn(), sendAudio: vi.fn(),
    setAudioOutputPort: vi.fn(), sendUserMessage: vi.fn(),
    setMediaTimestamp: vi.fn(), submitToolResult: vi.fn(), acknowledgeMark: vi.fn(),
    isConnected: () => true,
  } satisfies RealtimeVoiceBridge;
  const createBridge = vi.fn<RealtimeVoiceProviderPlugin['createBridge']>(() => native);
  const provider: RealtimeVoiceProviderPlugin = { id: 'openai', label: 'OpenAI', isConfigured: () => true, createBridge };
  const runner = vi.fn(async () => ({ text: 'native answer' }));
  const request = {
    cfg: {}, providerConfig: { voice: 'marin' }, agentId: 'coach-a',
    runAgentConsult: runner, onAudio: vi.fn(), onClearAudio: vi.fn(),
  } satisfies RealtimeVoiceBridgeCreateRequest;
  const readToken = vi.fn(() => 'synthetic-tenant-token');
  const bridge = createBrokeredOpenAiBridge(request, {
    baseUrl: 'http://octogee-api:3001', gatewayId: 'b-a', tokenPath: '/projected/token',
    load: load ?? (async () => provider), readToken,
  });
  const bound = () => {
    const value = createBridge.mock.calls[0]?.[0];
    if (!value?.gatewayRelayTransport) throw new Error('Missing native broker contract');
    return value;
  };
  return { native, provider, createBridge, runner, request, readToken, bridge, bound, owner: latestLifecycle() };
}

async function loadBridge(h: ReturnType<typeof setup>) {
  const bridge = await h.owner.options.load(h.owner.options.request);
  h.owner.lifecycle.bridge = bridge;
  return bridge;
}

function transportInput() {
  return {
    providerId: 'openai', agentId: 'coach-a', model: 'gpt-live-1',
    url: 'wss://api.openai.com/v1/live/sessions', signal: new AbortController().signal,
  };
}

describe('native OpenAI voice with brokered credentials', () => {
  it('delegates through the native public provider without a placeholder key or private worker factories', async () => {
    const h = setup();
    await h.bridge.connect();
    expect(h.owner.lifecycle.connect).toHaveBeenCalledOnce();
    await loadBridge(h);
    try {
      const bound = h.bound();
      expect(bound.providerConfig).toEqual({ model: 'gpt-live-1', voice: 'marin' });
      expect(bound).not.toHaveProperty('mediaSocketFactory');
      expect(bound).not.toHaveProperty('webSocketFactory');
      expect(await bound.runAgentConsult?.({ prompt: 'question' })).toEqual({ text: 'native answer' });
      expect(h.runner).toHaveBeenCalledExactlyOnceWith({ prompt: 'question' });
      h.bridge.sendAudio(Buffer.alloc(960));
      expect(h.native.sendAudio).toHaveBeenCalledOnce();
      expect(await bound.gatewayRelayTransport?.(transportInput())).toEqual({
        url: 'ws://octogee-api:3001/internal/voice/openai/live?gatewayId=b-a',
        headers: { 'x-k8s-sa-token': 'synthetic-tenant-token' }, maxPayloadBytes: 512 * 1024,
      });
    } finally {
      await h.bridge.close({ disposition: 'detach' });
    }
    expect(h.owner.lifecycle.close).toHaveBeenCalledExactlyOnceWith({ disposition: 'detach' });
  });

  it.each([
    { providerId: 'other' }, { agentId: 'other' }, { model: 'gpt-realtime-2.1' },
    { url: 'wss://evil.example/live' },
  ])('refuses a mismatched native connection before reading broker credentials: %j', async override => {
    const h = setup();
    await h.bridge.connect();
    await loadBridge(h);
    try {
      expect(() => h.bound().gatewayRelayTransport?.({ ...transportInput(), ...override })).toThrow('Unsupported OpenAI voice transport');
      expect(h.readToken).not.toHaveBeenCalled();
    } finally {
      await h.bridge.close();
    }
  });

  it('stops forwarding commands and delegates close to the native lifecycle', async () => {
    const h = setup();
    await h.bridge.connect();
    await loadBridge(h);
    await h.bridge.close({ disposition: 'detach' });
    h.bridge.sendAudio(Buffer.alloc(960));
    h.bridge.sendUserMessage?.('late');
    expect(h.readToken).not.toHaveBeenCalled();
    expect(h.native.sendAudio).not.toHaveBeenCalled();
    expect(h.native.sendUserMessage).not.toHaveBeenCalled();
    expect(h.owner.lifecycle.close).toHaveBeenCalledExactlyOnceWith({ disposition: 'detach' });
    await expect(h.bridge.connect()).rejects.toThrow('session is closed');
  });

  it('does not construct a provider after a pre-load close', async () => {
    const h = setup();
    await h.bridge.close();
    await expect(h.bridge.connect()).rejects.toThrow('session is closed');
    expect(h.owner.lifecycle.connect).not.toHaveBeenCalled();
    expect(h.createBridge).not.toHaveBeenCalled();
  });

  it('revokes the pending worker output through its native cleanup callback', async () => {
    const h = setup();
    const { port1, port2 } = new MessageChannel();
    const output = { port: port1, state: new SharedArrayBuffer(4) };
    try {
      h.bridge.setAudioOutputPort?.(output);
      h.owner.options.clearPending();
      expect(Atomics.load(new Int32Array(output.state), 0)).toBe(1);
      await loadBridge(h);
      expect(h.native.setAudioOutputPort).not.toHaveBeenCalled();
    } finally {
      await h.bridge.close();
      port1.close();
      port2.close();
    }
  });
});
