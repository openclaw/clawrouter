export interface MiniMaxImageBinding {
  version: "clawrouter.minimax-image.v1";
  product: "native-media";
  region: "global";
  origin: "https://api.minimax.io";
  operation: "minimax.images";
  model: "image-01";
  credentialKind: "api_key";
  credentialSource: "credential";
}

export const minimaxImageBinding: Readonly<MiniMaxImageBinding> = Object.freeze({
  version: "clawrouter.minimax-image.v1", product: "native-media", region: "global",
  origin: "https://api.minimax.io", operation: "minimax.images", model: "image-01",
  credentialKind: "api_key", credentialSource: "credential",
});

export function readMiniMaxImageBinding(value: unknown): MiniMaxImageBinding | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>, entries = Object.entries(minimaxImageBinding);
  return Object.keys(row).length === entries.length && entries.every(([key, expected]) => row[key] === expected)
    ? { ...minimaxImageBinding } : null;
}
