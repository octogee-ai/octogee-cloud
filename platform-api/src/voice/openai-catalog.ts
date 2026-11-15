import { encodeWav, bufferToInt16 } from './audio-format.js';
import { previewText, VoiceCatalogError, type VoiceCatalog } from './catalog.js';
import { synthesizeSpeech } from './tts-openai-compatible.js';

const VOICES = ['marin', 'cedar'].map(id => ({ id, name: id[0].toUpperCase() + id.slice(1) }));
export function createOpenAiVoiceCatalog(apiKey: string, fetchImpl: typeof fetch = fetch): VoiceCatalog {
  return {
    async list() { return { configured: true, default: VOICES[0], voices: VOICES }; },
    async preview(input, signal) {
      const voice = input.voice || 'marin';
      if (!VOICES.some(candidate => candidate.id === voice)) throw new VoiceCatalogError(400, 'invalid_voice');
      const chunks: Buffer[] = [];
      for await (const audio of synthesizeSpeech({
        url: 'https://api.openai.com/v1/audio/speech', model: 'gpt-4o-mini-tts', apiKey, voice,
        voiceParam: 'voice', speedParam: 'speed', format: 'pcm', pcmSampleRate: 24000,
        pcmEncoding: 's16le', extraBody: {}, voices: VOICES,
      }, { text: previewText(input.name), voice }, { fetchImpl, signal })) chunks.push(audio);
      return encodeWav(bufferToInt16(Buffer.concat(chunks)), 24000);
    },
  };
}
