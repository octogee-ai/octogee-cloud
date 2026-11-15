import { readFileSync } from 'node:fs';
import {
  getRealtimeVoiceProvider,
  type RealtimeVoiceAudioOutputPort,
  type RealtimeVoiceBridge,
  type RealtimeVoiceBridgeCreateRequest,
  type RealtimeVoiceProviderPlugin,
} from 'openclaw/plugin-sdk/realtime-voice';
import { createLazyRealtimeVoiceBridgeLifecycle } from 'openclaw/plugin-sdk/realtime-voice-provider';

interface BrokeredVoiceOptions {
  baseUrl: string;
  gatewayId: string;
  tokenPath: string;
  load?: () => Promise<RealtimeVoiceProviderPlugin>;
  readToken?: (path: string) => string;
}

export function createBrokeredOpenAiBridge(request: RealtimeVoiceBridgeCreateRequest, options: BrokeredVoiceOptions): RealtimeVoiceBridge {
  let output: RealtimeVoiceAudioOutputPort | undefined;
  let started = false;
  let closed = false;
  const revokeOutput = (sink: RealtimeVoiceAudioOutputPort) => {
    Atomics.store(new Int32Array(sink.state), 0, 1);
    sink.port.close();
  };
  const lifecycle = createLazyRealtimeVoiceBridgeLifecycle({
    label: 'Octogee OpenAI',
    request: {
      ...request,
      providerConfig: { ...request.providerConfig, model: 'gpt-live-1' },
      gatewayRelayTransport: ({ providerId, agentId, model, url, signal }) => {
        signal.throwIfAborted();
        if (providerId !== 'openai' || agentId !== request.agentId || model !== 'gpt-live-1' || url !== 'wss://api.openai.com/v1/live/sessions') {
          throw new Error('Unsupported OpenAI voice transport');
        }
        const token = (options.readToken ?? (path => readFileSync(path, 'utf8')))(options.tokenPath).trim();
        if (!token) throw new Error('Projected voice broker token is unavailable');
        const relay = new URL('/internal/voice/openai/live', options.baseUrl);
        relay.protocol = relay.protocol === 'https:' ? 'wss:' : 'ws:';
        relay.searchParams.set('gatewayId', options.gatewayId);
        return { url: relay.toString(), headers: { 'x-k8s-sa-token': token }, maxPayloadBytes: 512 * 1024 };
      },
    },
    clearPending: () => {
      if (output) revokeOutput(output);
      output = undefined;
    },
    load: async guarded => {
      if (!guarded.runAgentConsult || !guarded.agentId) throw new Error('Native OpenAI voice requires an authenticated agent');
      const provider = options.load ? await options.load() : getRealtimeVoiceProvider('openai', guarded.cfg);
      if (!provider) throw new Error('OpenClaw OpenAI voice provider is unavailable');
      const bridge = provider.createBridge(guarded);
      if (output) {
        if (!bridge.setAudioOutputPort) throw new Error('Native OpenAI voice has no worker output sink');
        bridge.setAudioOutputPort(output);
        output = undefined;
      }
      return bridge;
    },
  });
  return {
    outputAudioMode: 'continuous', pacesInputAudio: true, handlesInputAudioBargeIn: true,
    setAudioOutputPort(sink) {
      if (started || output || closed || !lifecycle.isActive()) {
        revokeOutput(sink);
        throw new Error('Voice output must be bound once before connecting');
      }
      output = sink;
    },
    connect() {
      if (closed) return Promise.reject(new Error('Native OpenAI voice session is closed'));
      started = true;
      return lifecycle.connect();
    },
    sendAudio: audio => { if (!closed) lifecycle.bridge?.sendAudio(audio); },
    setMediaTimestamp: timestamp => { if (!closed) lifecycle.bridge?.setMediaTimestamp(timestamp); },
    sendUserMessage: (text, settings) => { if (!closed) lifecycle.bridge?.sendUserMessage?.(text, settings); },
    triggerGreeting: instructions => { if (!closed) lifecycle.bridge?.triggerGreeting?.(instructions); },
    handleBargeIn: settings => { if (!closed) lifecycle.bridge?.handleBargeIn?.(settings); },
    submitToolResult: (id, result, settings) => {
      if (closed || !lifecycle.bridge) throw new Error('Native OpenAI voice is not connected');
      return lifecycle.bridge.submitToolResult(id, result, settings);
    },
    acknowledgeMark: name => { if (!closed) lifecycle.bridge?.acknowledgeMark(name); },
    close(settings) { closed = true; return lifecycle.close(settings); },
    isConnected: () => lifecycle.isActive() && (lifecycle.bridge?.isConnected() ?? false),
  };
}
