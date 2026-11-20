interface NativeMediaV1Binding {
  version: "clawrouter.native-media.v1";
  product: "native-media";
  region: "global";
  origin: "https://api.minimax.io";
  operation: "minimax.speech" | "minimax.music";
  credentialKind: "api_key";
  credentialSource: "credential";
}

export interface MiniMaxMusicCoverBinding {
  version: "clawrouter.native-media.v2";
  product: "native-media";
  region: "global";
  origin: "https://api.minimax.io";
  operation: "minimax.music";
  credentialKind: "api_key";
  credentialSource: "credential";
  model: "music-cover";
  inputProfile: "inline-audio.v1";
}
export type NativeMediaBinding = NativeMediaV1Binding | MiniMaxMusicCoverBinding;

export const minimaxSpeechBinding: Readonly<NativeMediaV1Binding> = Object.freeze({
  version: "clawrouter.native-media.v1", product: "native-media", region: "global",
  origin: "https://api.minimax.io", operation: "minimax.speech", credentialKind: "api_key", credentialSource: "credential",
});

export const minimaxMusicBinding: Readonly<NativeMediaV1Binding> = Object.freeze({
  ...minimaxSpeechBinding, operation: "minimax.music",
});

export const minimaxMusicCoverBinding: Readonly<MiniMaxMusicCoverBinding> = Object.freeze({
  ...minimaxMusicBinding, version: "clawrouter.native-media.v2", operation: "minimax.music", model: "music-cover", inputProfile: "inline-audio.v1",
});

// Unknown fields and future versions never silently acquire current authority.
export function readNativeMediaBinding(value: unknown): NativeMediaBinding | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const binding = row.version === "clawrouter.native-media.v2" ? minimaxMusicCoverBinding
    : row.operation === "minimax.music" ? minimaxMusicBinding : minimaxSpeechBinding;
  const entries = Object.entries(binding);
  return Object.keys(row).length === entries.length && entries.every(([key, expected]) => row[key] === expected)
    ? { ...binding } : null;
}
