import type { VoicePcmEncoding } from "./config.js";

export interface PcmFormat {
  sampleRate: number;
  channels: number;
  encoding: VoicePcmEncoding;
}

const WAV_FORMAT_PCM = 1;
const WAV_FORMAT_IEEE_FLOAT = 3;
const WAV_FORMAT_EXTENSIBLE = 0xfffe;
const MAX_HEADER_BYTES = 1 << 20;

export class WavParseError extends Error {
  override readonly name = "WavParseError";
}

/**
 * Incremental RIFF/WAVE reader for streamed responses: header chunks may be split
 * across network reads and the `data` chunk length is often 0 or 0xFFFFFFFF when a
 * provider streams. Everything after the data chunk header is sample bytes.
 */
export class WavStreamParser {
  private pending: Buffer = Buffer.alloc(0);
  private headerDone = false;
  private fmt: PcmFormat | null = null;
  private bitsPerSample = 0;
  private trailingSampleByte: Buffer = Buffer.alloc(0);

  get format(): PcmFormat | null {
    return this.fmt;
  }

  get bytesPerFrame(): number {
    return this.fmt ? (this.bitsPerSample / 8) * this.fmt.channels : 0;
  }

  /** Feed a network chunk; returns whole-frame sample bytes ready for conversion (may be empty). */
  feed(chunk: Buffer): Buffer {
    if (this.headerDone) return this.frameAligned(chunk);
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    if (this.pending.length > MAX_HEADER_BYTES) {
      throw new WavParseError("WAV header exceeds 1 MiB without a data chunk");
    }
    const rest = this.tryParseHeader();
    if (rest === null) return Buffer.alloc(0);
    this.headerDone = true;
    this.pending = Buffer.alloc(0);
    return this.frameAligned(rest);
  }

  private frameAligned(chunk: Buffer): Buffer {
    const buf = this.trailingSampleByte.length ? Buffer.concat([this.trailingSampleByte, chunk]) : chunk;
    const frame = this.bytesPerFrame;
    if (frame <= 1) return buf;
    const usable = buf.length - (buf.length % frame);
    this.trailingSampleByte = buf.subarray(usable);
    return buf.subarray(0, usable);
  }

  private tryParseHeader(): Buffer | null {
    const buf = this.pending;
    if (buf.length < 12) return null;
    if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
      throw new WavParseError("not a RIFF/WAVE stream");
    }
    let offset = 12;
    while (true) {
      if (buf.length < offset + 8) return null;
      const id = buf.toString("ascii", offset, offset + 4);
      const size = buf.readUInt32LE(offset + 4);
      const body = offset + 8;
      if (id === "fmt ") {
        if (buf.length < body + Math.min(size, 40)) return null;
        this.readFmt(buf, body, size);
        offset = body + size + (size % 2);
        continue;
      }
      if (id === "data") {
        if (!this.fmt) throw new WavParseError("WAV data chunk before fmt chunk");
        return buf.subarray(body);
      }
      if (buf.length < body + size) return null;
      offset = body + size + (size % 2);
    }
  }

  private readFmt(buf: Buffer, at: number, size: number): void {
    if (size < 16) throw new WavParseError("WAV fmt chunk too short");
    let audioFormat = buf.readUInt16LE(at);
    const channels = buf.readUInt16LE(at + 2);
    const sampleRate = buf.readUInt32LE(at + 4);
    const bitsPerSample = buf.readUInt16LE(at + 14);
    if (audioFormat === WAV_FORMAT_EXTENSIBLE) {
      if (size < 40) throw new WavParseError("WAV extensible fmt chunk too short");
      audioFormat = buf.readUInt16LE(at + 24);
    }
    let encoding: VoicePcmEncoding;
    if (audioFormat === WAV_FORMAT_PCM && bitsPerSample === 16) encoding = "s16le";
    else if (audioFormat === WAV_FORMAT_IEEE_FLOAT && bitsPerSample === 32) encoding = "f32le";
    else throw new WavParseError(`unsupported WAV sample format ${audioFormat}/${bitsPerSample}-bit`);
    if (channels < 1 || channels > 8) throw new WavParseError(`unsupported WAV channel count ${channels}`);
    if (sampleRate < 8000 || sampleRate > 96_000) throw new WavParseError(`unsupported WAV sample rate ${sampleRate}`);
    this.bitsPerSample = bitsPerSample;
    this.fmt = { sampleRate, channels, encoding };
  }
}

/** Decode interleaved sample bytes into mono Int16 samples (channels averaged). */
export function decodePcmToMonoInt16(bytes: Buffer, format: PcmFormat): Int16Array {
  const bytesPerSample = format.encoding === "f32le" ? 4 : 2;
  const frameBytes = bytesPerSample * format.channels;
  const frames = Math.floor(bytes.length / frameBytes);
  const out = new Int16Array(frames);
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < format.channels; c++) {
      const at = i * frameBytes + c * bytesPerSample;
      acc += format.encoding === "f32le"
        ? Math.max(-1, Math.min(1, bytes.readFloatLE(at))) * 32767
        : bytes.readInt16LE(at);
    }
    out[i] = Math.round(acc / format.channels);
  }
  return out;
}

/** Streaming linear-interpolation resampler for mono Int16 audio. */
export class Int16Resampler {
  private carry: Int16Array = new Int16Array(0);
  private position = 0;

  constructor(
    readonly fromRate: number,
    readonly toRate: number,
  ) {
    if (fromRate <= 0 || toRate <= 0) throw new Error("resampler rates must be positive");
  }

  get isIdentity(): boolean {
    return this.fromRate === this.toRate;
  }

  process(input: Int16Array): Int16Array {
    if (this.isIdentity) return input;
    const samples = this.carry.length ? concatInt16(this.carry, input) : input;
    const step = this.fromRate / this.toRate;
    const out: number[] = [];
    let pos = this.position;
    while (pos + 1 < samples.length) {
      const i = Math.floor(pos);
      const frac = pos - i;
      out.push(Math.round(samples[i] * (1 - frac) + samples[i + 1] * frac));
      pos += step;
    }
    const consumed = Math.floor(pos);
    const keepFrom = Math.max(0, Math.min(consumed, samples.length - 1));
    this.carry = samples.slice(keepFrom);
    this.position = pos - keepFrom;
    return Int16Array.from(out);
  }
}

function concatInt16(a: Int16Array, b: Int16Array): Int16Array {
  const out = new Int16Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export function int16ToBuffer(samples: Int16Array): Buffer {
  const buf = Buffer.allocUnsafe(samples.length * 2);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i], i * 2);
  return buf;
}

export function bufferToInt16(bytes: Buffer): Int16Array {
  const out = new Int16Array(Math.floor(bytes.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = bytes.readInt16LE(i * 2);
  return out;
}

/** Build a minimal 16-bit PCM WAV file (mono by default) for batch transcription uploads. */
export function encodeWav(samples: Int16Array, sampleRate: number, channels = 1): Buffer {
  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(WAV_FORMAT_PCM, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * 2, 28);
  buf.writeUInt16LE(channels * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i], 44 + i * 2);
  return buf;
}
