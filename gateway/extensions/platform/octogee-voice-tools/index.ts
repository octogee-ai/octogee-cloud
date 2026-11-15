import { definePluginEntry, type OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import { REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ } from 'openclaw/plugin-sdk/realtime-voice';
import { trustedBrokerBaseUrl } from '@octogee/core/trusted-broker-url';
import { createVoiceRelayClient } from '@octogee/core/voice-relay-client';
import { createOctogeeVoiceBridge } from './bridge.js';
import { createBrokeredOpenAiBridge } from './openai-bridge.js';

export default definePluginEntry({
  id: 'octogee-voice-tools',
  name: 'Octogee Voice',
  description: 'Tenant-brokered speech on native Talk.',
  register(api: OpenClawPluginApi) {
    const config = api.pluginConfig ?? {};
    const configuredBase = typeof config.brokerUrl === 'string' ? config.brokerUrl : process.env.FLEET_BROKER_URL;
    const baseUrl = configuredBase ? trustedBrokerBaseUrl(configuredBase, process.env) : undefined;
    const gatewayId = process.env.GATEWAY_ID;
    const tokenPath = typeof config.tokenPath === 'string' ? config.tokenPath : process.env.OCTOGEE_API_SA_TOKEN_PATH;
    api.registerRealtimeVoiceProvider({
      id: 'octogee', label: 'Octogee Voice',
      capabilities: {
        transports: ['gateway-relay'],
        inputAudioFormats: [REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ],
        outputAudioFormats: [REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ],
        supportsBargeIn: true, handlesInputAudioBargeIn: true,
        handlesAgentConsult: true, supportsToolCalls: false,
      },
      resolveConfig: ({ rawConfig }) => rawConfig,
      isConfigured: () => Boolean(baseUrl && gatewayId),
      createBridge: request => {
        if (!baseUrl || !gatewayId) throw new Error('Octogee tenant speech broker is not configured');
        return createOctogeeVoiceBridge(request, {
          relay: createVoiceRelayClient({ baseUrl, gatewayId, tokenPath }), logger: api.logger,
        });
      },
    });
    api.registerRealtimeVoiceProvider({
      id: 'octogee-openai', label: 'OpenAI Live', defaultModel: 'gpt-live-1', models: ['gpt-live-1'], voices: ['marin', 'cedar'],
      capabilities: {
        transports: ['gateway-relay'],
        inputAudioFormats: [REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ],
        outputAudioFormats: [REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ],
        supportsBargeIn: true, handlesInputAudioBargeIn: true, handlesAgentConsult: true, supportsToolCalls: false,
      },
      resolveConfig: ({ rawConfig }) => ({ ...rawConfig, model: 'gpt-live-1' }),
      isConfigured: () => Boolean(baseUrl && gatewayId && tokenPath),
      createBridge: request => {
        if (!baseUrl || !gatewayId || !tokenPath) throw new Error('OpenAI voice broker is not configured');
        return createBrokeredOpenAiBridge(request, { baseUrl, gatewayId, tokenPath });
      },
    });
  },
});
