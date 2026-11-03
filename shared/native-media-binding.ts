export interface NativeMediaBinding {
  version: "clawrouter.native-media.v1";
  product: "native-media";
  region: "global";
  origin: "https://api.minimax.io";
  operation: "minimax.speech";
  credentialKind: "api_key";
  credentialSource: "credential";
}

export const minimaxSpeechBinding: Readonly<NativeMediaBinding> = Object.freeze({
  version: "clawrouter.native-media.v1", product: "native-media", region: "global",
  origin: "https://api.minimax.io", operation: "minimax.speech", credentialKind: "api_key", credentialSource: "credential",
});

// Unknown fields and future versions never silently acquire current authority.
export function readNativeMediaBinding(value: unknown): NativeMediaBinding | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>, entries = Object.entries(minimaxSpeechBinding);
  return Object.keys(row).length === entries.length && entries.every(([key, expected]) => row[key] === expected)
    ? { ...minimaxSpeechBinding } : null;
}
