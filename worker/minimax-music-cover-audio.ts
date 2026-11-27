// Local partial input profile, not a statement of vendor codec compatibility.
export interface MusicCoverWaveFormat {
  readonly profile: "wave-pcm16-48k.v1";
  readonly bytes: number;
  readonly channels: 1 | 2;
  readonly frames: number;
  readonly chunks: number;
}
export function qualifyMusicCoverWave(bytes: Uint8Array<ArrayBuffer>): MusicCoverWaveFormat {
  const invalid = (): never => { throw new Error("invalid music cover WAVE profile"); };
  if (bytes.length < 44 || bytes.length > 50_000_000) invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number, value: string) => {
    for (let i = 0; i < 4; i++) if (view.getUint8(offset + i) !== value.charCodeAt(i)) return false;
    return true;
  };
  if (!tag(0, "RIFF") || !tag(8, "WAVE") || view.getUint32(4, true) !== bytes.length - 8) invalid();
  let offset = 12, chunks = 0, metadata = 0, channels = 0, data = false, frames = 0;
  while (offset < bytes.length) {
    if (++chunks > 32 || bytes.length - offset < 8) invalid();
    const length = view.getUint32(offset + 4, true), start = offset + 8, end = start + length;
    const next = end + (length & 1);
    if (end > bytes.length || next > bytes.length || length & 1 && view.getUint8(end) !== 0) invalid();
    if (tag(offset, "fmt ")) {
      if (channels || data || length !== 16 || view.getUint16(start, true) !== 1) invalid();
      channels = view.getUint16(start + 2, true);
      if ((channels !== 1 && channels !== 2) || view.getUint32(start + 4, true) !== 48000
        || view.getUint16(start + 14, true) !== 16 || view.getUint16(start + 12, true) !== channels * 2
        || view.getUint32(start + 8, true) !== 48000 * channels * 2) invalid();
    } else if (tag(offset, "data")) {
      if (!channels || data || length % (channels * 2)) invalid();
      frames = length / (channels * 2);
      if (frames < 6 * 48000 || frames > 360 * 48000) invalid();
      data = true;
    } else if ((metadata += 8 + length + (length & 1)) > 65536) invalid();
    offset = next;
  }
  if (!channels || !data || offset !== bytes.length) invalid();
  return Object.freeze({ profile: "wave-pcm16-48k.v1", bytes: bytes.length, channels: channels as 1 | 2, frames, chunks });
}
