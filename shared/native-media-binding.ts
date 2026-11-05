export interface NativeMediaBinding {
  version: "clawrouter.native-media.v1";
  product: "native-media";
  region: "global";
  origin: "https://api.minimax.io";
  operation: "minimax.speech" | "minimax.music";
  credentialKind: "api_key";
  credentialSource: "credential";
}

export const minimaxSpeechBinding: Readonly<NativeMediaBinding> = Object.freeze({
  version: "clawrouter.native-media.v1", product: "native-media", region: "global",
  origin: "https://api.minimax.io", operation: "minimax.speech", credentialKind: "api_key", credentialSource: "credential",
});

export const minimaxMusicBinding: Readonly<NativeMediaBinding> = Object.freeze({
  ...minimaxSpeechBinding, operation: "minimax.music",
});

// Unknown fields and future versions never silently acquire current authority.
export function readNativeMediaBinding(value: unknown): NativeMediaBinding | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const binding = row.operation === "minimax.music" ? minimaxMusicBinding : minimaxSpeechBinding;
  const entries = Object.entries(binding);
  return Object.keys(row).length === entries.length && entries.every(([key, expected]) => row[key] === expected)
    ? { ...binding } : null;
}
