import { Buffer } from 'node:buffer';

/** Independently generated exact-bin stereo signal; never uses application DSP. */
export function fixture(frequency = 1000, seconds = 1): Buffer {
  const rate = 48000;
  const frames = rate * seconds;
  const wav = Buffer.alloc(44 + frames * 4);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 4, 28);
  wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36);
  wav.writeUInt32LE(frames * 4, 40);
  for (let i = 0; i < frames; i += 1) {
    wav.writeInt16LE(Math.round(0.2 * 32767 * Math.sin(2 * Math.PI * frequency * i / rate)), 44 + i * 4);
    wav.writeInt16LE(Math.round(0.1 * 32767 * Math.sin(2 * Math.PI * frequency * i / rate)), 46 + i * 4);
  }
  return wav;
}

export function decode(wav: Buffer): { left: number[]; right: number[]; rate: number; bits: number } {
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Invalid WAV magic');
  if (wav.readUInt32LE(4) + 8 !== wav.length) throw new Error('Invalid RIFF size');
  let format = 0; let channels = 0; let rate = 0; let bits = 0; let start = -1; let length = 0;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const id = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (offset + 8 + size > wav.length) throw new Error('Truncated chunk');
    if (id === 'fmt ') {
      format = wav.readUInt16LE(offset + 8); channels = wav.readUInt16LE(offset + 10);
      rate = wav.readUInt32LE(offset + 12); bits = wav.readUInt16LE(offset + 22);
    }
    if (id === 'data') { start = offset + 8; length = size; }
    offset += 8 + size + size % 2;
  }
  if (start < 0 || channels !== 2 || ![16, 24, 32].includes(bits) || ![1, 3].includes(format)) throw new Error('Unsupported exported WAV');
  const bytes = bits / 8; const left: number[] = []; const right: number[] = [];
  if (length % (bytes * channels) !== 0) throw new Error('Misaligned samples');
  const sample = (offset: number): number => {
    const value = format === 3 ? wav.readFloatLE(offset) : wav.readIntLE(offset, bytes) / 2 ** (bits - 1);
    if (!Number.isFinite(value)) throw new Error('Nonfinite PCM sample');
    return value;
  };
  for (let offset = start; offset < start + length; offset += bytes * channels) {
    left.push(sample(offset)); right.push(sample(offset + bytes));
  }
  return { left, right, rate, bits };
}

function rms(samples: number[]): number {
  return Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
}

export function dbRatio(actual: number[], reference: number[]): number {
  return 20 * Math.log10(rms(actual) / rms(reference));
}
