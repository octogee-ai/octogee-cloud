import { vi } from 'vitest';
import type {
  createRealtimeVoiceAgentTalkbackQueue,
  RealtimeVoiceBridge,
  RealtimeVoiceProviderPlugin,
} from 'openclaw/plugin-sdk/realtime-voice';
import type { createLazyRealtimeVoiceBridgeLifecycle } from 'openclaw/plugin-sdk/realtime-voice-provider';

type TalkbackOptions = Parameters<typeof createRealtimeVoiceAgentTalkbackQueue>[0];
type LifecycleOptions = Parameters<typeof createLazyRealtimeVoiceBridgeLifecycle>[0];

export const voiceSdk = {
  queues: [] as Array<{
    options: TalkbackOptions;
    queue: ReturnType<typeof createRealtimeVoiceAgentTalkbackQueue>;
  }>,
  lifecycles: [] as Array<{
    options: LifecycleOptions;
    lifecycle: {
      bridge: RealtimeVoiceBridge | undefined;
      isActive: ReturnType<typeof vi.fn<() => boolean>>;
      connect: ReturnType<typeof vi.fn<() => Promise<void>>>;
      close: ReturnType<typeof vi.fn<RealtimeVoiceBridge['close']>>;
    };
  }>,
  getProvider: vi.fn<() => RealtimeVoiceProviderPlugin | undefined>(),
};

export const realtimeVoice = {
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ: { encoding: 'pcm16', sampleRateHz: 24000, channels: 1 },
  createRealtimeVoiceAgentTalkbackQueue(options: TalkbackOptions) {
    const queue = { enqueue: vi.fn(), close: vi.fn(), isIdle: vi.fn<() => boolean>() };
    voiceSdk.queues.push({ options, queue });
    return queue;
  },
  createSpeechThresholdGate: () => {
    let speaking = false;
    return { accept: (stats: { rms: number }) => {
      if (stats.rms <= 300) { speaking = false; return false; }
      if (speaking) return false;
      speaking = true;
      return true;
    } };
  },
  readPcm16AudioStats: (audio: Buffer) => ({ rms: audio.readInt16LE(0), peak: audio.readInt16LE(0) }),
  getRealtimeVoiceProvider: voiceSdk.getProvider,
};

export const realtimeVoiceProvider = {
  createStreamingPcmResampler: () => ({ process: (audio: Buffer) => audio, flush: () => Buffer.alloc(0) }),
  createLazyRealtimeVoiceBridgeLifecycle(options: LifecycleOptions) {
    const lifecycle = {
      bridge: undefined as RealtimeVoiceBridge | undefined,
      isActive: vi.fn(() => true),
      connect: vi.fn(async () => {}),
      close: vi.fn<RealtimeVoiceBridge['close']>(),
    };
    voiceSdk.lifecycles.push({ options, lifecycle });
    return lifecycle;
  },
};

export function latestTalkback() {
  const value = voiceSdk.queues.at(-1);
  if (!value) throw new Error('Native talkback queue was not requested');
  return value;
}

export function latestLifecycle() {
  const value = voiceSdk.lifecycles.at(-1);
  if (!value) throw new Error('Native lazy lifecycle was not requested');
  return value;
}

export function resetVoiceSdk() {
  voiceSdk.queues.length = 0;
  voiceSdk.lifecycles.length = 0;
  voiceSdk.getProvider.mockReset();
}
