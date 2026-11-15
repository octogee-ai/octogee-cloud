import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import type { RealtimeVoiceBridge, RealtimeVoiceBridgeCreateRequest, RealtimeVoiceProviderPlugin } from 'openclaw/plugin-sdk/realtime-voice';
import type { internalFetch } from '@octogee/core/internal-fetch';
import { latestTalkback, resetVoiceSdk } from './voice-sdk.js';

const broker = vi.hoisted(() => ({
  fetch: vi.fn<typeof internalFetch>(),
  webSocket: vi.fn(function () { throw new Error('Unexpected STT WebSocket in HTTP TTS broker wiring'); }),
}));
vi.mock('openclaw/plugin-sdk/core', () => ({ definePluginEntry: (entry: unknown) => entry }));
vi.mock('@octogee/core/internal-fetch', () => ({ internalFetch: broker.fetch }));
vi.mock('ws', () => ({ WebSocket: broker.webSocket }));
vi.mock('openclaw/plugin-sdk/realtime-voice', async () => {
  const { realtimeVoice } = await import('./voice-sdk.js');
  return realtimeVoice;
});
vi.mock('openclaw/plugin-sdk/realtime-voice-provider', async () => {
  const { realtimeVoiceProvider } = await import('./voice-sdk.js');
  return realtimeVoiceProvider;
});
import plugin from '../index.js';

const bridges: RealtimeVoiceBridge[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv('GATEWAY_ID', 'builder-a');
  vi.stubEnv('OPENCLAW_RUNTIME_BROKER_URL', undefined);
  vi.stubEnv('FLEET_BROKER_URL', 'http://octogee-api:3001');
  vi.stubEnv('OCTOGEE_API_SA_TOKEN_PATH', '/gateway/projected-token');
});
afterEach(() => {
  for (const bridge of bridges) bridge.close();
  bridges.length = 0;
  resetVoiceSdk();
  expect(broker.webSocket).not.toHaveBeenCalled();
  vi.useRealTimers(); vi.unstubAllEnvs(); vi.clearAllMocks();
});
function setup(explicit: boolean) {
  const brokerUrl = explicit ? 'http://localhost:3001' : 'http://octogee-api:3001';
  const tokenPath = explicit ? '/configured/projected-token' : '/gateway/projected-token';
  const registerRealtimeVoiceProvider = vi.fn<OpenClawPluginApi['registerRealtimeVoiceProvider']>();
  const logger = { info: vi.fn(), warn: vi.fn() };
  plugin.register({ pluginConfig: explicit ? { brokerUrl, tokenPath } : {}, registerRealtimeVoiceProvider, logger } as unknown as OpenClawPluginApi);
  const provider = registerRealtimeVoiceProvider.mock.calls[0][0] as RealtimeVoiceProviderPlugin;
  const request = {
    providerConfig: { voice: 'marin' }, agentId: 'octogee-alice-coach',
    onAudio: vi.fn(), onClearAudio: vi.fn(), onError: vi.fn(), onResponseDone: vi.fn(),
    onMark: vi.fn((_name: string, acknowledge?: () => void) => acknowledge?.()),
    runAgentConsult: vi.fn(async () => ({ text: 'Ready.' })),
  } satisfies RealtimeVoiceBridgeCreateRequest;
  const bridge = provider.createBridge(request);
  bridges.push(bridge);
  return { bridge, request, brokerUrl, tokenPath, logger };
}
async function submit(bridge: RealtimeVoiceBridge) {
  await bridge.connect();
  bridge.sendUserMessage?.('Read the news');
  const { options, queue } = latestTalkback();
  expect(queue.enqueue).toHaveBeenCalledExactlyOnceWith('Read the news');
  const answer = await options.consult({ question: 'Read the news', responseStyle: options.responseStyle, signal: new AbortController().signal });
  options.deliver(answer.text);
  await vi.advanceTimersByTimeAsync(0);
}

describe('native voice plugin broker configuration', () => {
  it.each([false, true])('uses the configured tenant speech broker with the native consult runner (explicit config: %s)', async explicit => {
    const h = setup(explicit);
    broker.fetch.mockResolvedValueOnce(new Response(new Uint8Array([0, 1, 2, 3])));
    await submit(h.bridge);
    expect(h.request.runAgentConsult).toHaveBeenCalledExactlyOnceWith({ prompt: 'Read the news', signal: expect.any(AbortSignal) });
    expect(broker.fetch).toHaveBeenCalledExactlyOnceWith(`${h.brokerUrl}/internal/voice/tts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gatewayId: 'builder-a', text: 'Ready.', voice: 'marin' }),
      signal: expect.any(AbortSignal),
    }, { fetchImpl: undefined, tokenPath: h.tokenPath, timeoutMs: 30000 });
    expect(h.request.onAudio).toHaveBeenCalledExactlyOnceWith(Buffer.from([0, 1, 2, 3]), expect.objectContaining({ itemId: expect.any(String) }));
    const [responseId] = h.request.onMark.mock.calls[0];
    expect(h.request.onResponseDone).toHaveBeenCalledExactlyOnceWith({ status: 'completed', responseId });
    expect(h.request.onError).not.toHaveBeenCalled();
    expect(h.logger.warn).not.toHaveBeenCalled();
  });
  it('surfaces tenant broker refusal through the native provider error lifecycle', async () => {
    const h = setup(false);
    broker.fetch.mockResolvedValueOnce(new Response('Voice unavailable', { status: 403 }));
    await submit(h.bridge);
    const message = 'voice relay TTS HTTP 403: Voice unavailable';
    expect(h.request.onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message }));
    expect(h.logger.warn).toHaveBeenCalledExactlyOnceWith(`Octogee voice: ${message}`);
    expect(h.request.onResponseDone).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 'failed', message }));
    expect(h.request.onAudio).not.toHaveBeenCalled();
    expect(h.request.onMark).not.toHaveBeenCalled();
  });
  it('does not contact the speech broker when native agent delegation is refused', async () => {
    const h = setup(false);
    h.request.runAgentConsult.mockRejectedValueOnce(new Error('Native agent access refused'));
    await expect(submit(h.bridge)).rejects.toThrow('Native agent access refused');
    expect(h.request.onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: 'Native agent access refused' }));
    expect(broker.fetch).not.toHaveBeenCalled();
    expect(h.request.onAudio).not.toHaveBeenCalled();
    expect(h.request.onMark).not.toHaveBeenCalled();
  });
  it('refuses an untrusted broker before publishing a voice provider', () => {
    const registerRealtimeVoiceProvider = vi.fn();
    expect(() => plugin.register({
      pluginConfig: { brokerUrl: 'https://foreign.example' }, registerRealtimeVoiceProvider,
      logger: { info: vi.fn(), warn: vi.fn() },
    } as unknown as OpenClawPluginApi)).toThrow('must target octogee-api or localhost');
    expect(registerRealtimeVoiceProvider).not.toHaveBeenCalled();
    expect(broker.fetch).not.toHaveBeenCalled();
  });
});
