import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import type { RealtimeVoiceBridge, RealtimeVoiceBridgeCreateRequest, RealtimeVoiceProviderPlugin } from 'openclaw/plugin-sdk/realtime-voice';

const providers = vi.hoisted(() => ({ relay: vi.fn(), speech: vi.fn(), openai: vi.fn() }));
vi.mock('openclaw/plugin-sdk/core', () => ({ definePluginEntry: (entry: unknown) => entry }));
vi.mock('openclaw/plugin-sdk/realtime-voice', () => ({
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ: { encoding: 'pcm16', sampleRateHz: 24000, channels: 1 },
}));
vi.mock('@octogee/core/voice-relay-client', () => ({ createVoiceRelayClient: providers.relay }));
vi.mock('../bridge.js', () => ({ createOctogeeVoiceBridge: providers.speech }));
vi.mock('../openai-bridge.js', () => ({ createBrokeredOpenAiBridge: providers.openai }));
import plugin from '../index.js';

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
function setup(config: Record<string, unknown> = {}) {
  const registerRealtimeVoiceProvider = vi.fn<OpenClawPluginApi['registerRealtimeVoiceProvider']>();
  const logger = { info: vi.fn(), warn: vi.fn() };
  plugin.register({ pluginConfig: config, registerRealtimeVoiceProvider, logger } as unknown as OpenClawPluginApi);
  function provider(id: string): RealtimeVoiceProviderPlugin {
    const entry = registerRealtimeVoiceProvider.mock.calls.map(([value]) => value).find(value => typeof value !== 'function' && value.id === id);
    if (!entry || typeof entry === 'function') throw new Error(`Missing voice provider ${id}`);
    return entry;
  }
  return { provider, logger };
}
function request() {
  return {
    providerConfig: { voice: 'marin' }, agentId: 'coach-a',
    runAgentConsult: vi.fn(async () => ({ text: 'Ready.' })),
    onAudio: vi.fn(), onClearAudio: vi.fn(),
  } satisfies RealtimeVoiceBridgeCreateRequest;
}
const bridge = {
  connect: async () => {}, sendAudio: () => {}, setMediaTimestamp: () => {},
  submitToolResult: () => {}, acknowledgeMark: () => {}, close: () => {}, isConnected: () => true,
} satisfies RealtimeVoiceBridge;

describe('native voice provider registration', () => {
  it('publishes the native OpenAI model and voices for the Talk settings pickers', () => {
    const h = setup();
    const provider = h.provider('octogee-openai');
    expect(provider).toMatchObject({ label: 'OpenAI Live', defaultModel: 'gpt-live-1', models: ['gpt-live-1'], voices: ['marin', 'cedar'] });
    expect(provider.resolveConfig({ cfg: {}, rawConfig: { model: 'other', voice: 'cedar' } })).toEqual({ model: 'gpt-live-1', voice: 'cedar' });
    expect(provider.capabilities).toMatchObject({ transports: ['gateway-relay'], handlesAgentConsult: true, supportsToolCalls: false });
  });
  it('keeps the tenant speech provider selection unchanged', () => {
    const provider = setup().provider('octogee');
    const rawConfig = { voice: 'marin' };
    expect(provider.resolveConfig({ cfg: {}, rawConfig })).toBe(rawConfig);
    expect(provider.capabilities).toMatchObject({ transports: ['gateway-relay'], handlesAgentConsult: true, supportsToolCalls: false });
  });
  it('passes the native agent runner unchanged to both bridge owners', () => {
    vi.stubEnv('GATEWAY_ID', 'builder-a');
    const h = setup({ brokerUrl: 'http://localhost:3001', tokenPath: '/projected/token' });
    const nativeRequest = request();
    const relay = { openStt: vi.fn(), tts: vi.fn() };
    providers.relay.mockReturnValue(relay);
    providers.speech.mockReturnValue(bridge);
    providers.openai.mockReturnValue(bridge);
    expect(h.provider('octogee').createBridge(nativeRequest)).toBe(bridge);
    expect(providers.relay).toHaveBeenCalledExactlyOnceWith({ baseUrl: 'http://localhost:3001', gatewayId: 'builder-a', tokenPath: '/projected/token' });
    expect(providers.speech).toHaveBeenCalledExactlyOnceWith(nativeRequest, { relay, logger: h.logger });
    expect(h.provider('octogee-openai').createBridge(nativeRequest)).toBe(bridge);
    expect(providers.openai).toHaveBeenCalledExactlyOnceWith(nativeRequest, { baseUrl: 'http://localhost:3001', gatewayId: 'builder-a', tokenPath: '/projected/token' });
  });
  it.each(['FLEET_BROKER_URL', 'GATEWAY_ID'])('refuses bridge creation without %s', key => {
    vi.stubEnv('FLEET_BROKER_URL', 'http://octogee-api:3001');
    vi.stubEnv('GATEWAY_ID', 'builder-a');
    vi.stubEnv('OCTOGEE_API_SA_TOKEN_PATH', '/projected/token');
    vi.stubEnv(key, undefined);
    const h = setup();
    for (const id of ['octogee', 'octogee-openai']) {
      const provider = h.provider(id);
      expect(provider.isConfigured({ providerConfig: {} })).toBe(false);
      expect(() => provider.createBridge(request())).toThrow('not configured');
    }
    expect(providers.relay).not.toHaveBeenCalled();
    expect(providers.speech).not.toHaveBeenCalled();
    expect(providers.openai).not.toHaveBeenCalled();
  });
  it('requires the projected token path before admitting OpenAI Live', () => {
    vi.stubEnv('FLEET_BROKER_URL', 'http://octogee-api:3001');
    vi.stubEnv('GATEWAY_ID', 'builder-a');
    vi.stubEnv('OCTOGEE_API_SA_TOKEN_PATH', undefined);
    const h = setup();
    expect(h.provider('octogee').isConfigured({ providerConfig: {} })).toBe(true);
    expect(h.provider('octogee-openai').isConfigured({ providerConfig: {} })).toBe(false);
    expect(() => h.provider('octogee-openai').createBridge(request())).toThrow('not configured');
    expect(providers.openai).not.toHaveBeenCalled();
  });
});
