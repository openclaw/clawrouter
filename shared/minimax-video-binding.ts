export const miniMaxT2VModels = Object.freeze(["MiniMax-Hailuo-2.3", "MiniMax-Hailuo-02"] as const);
export const miniMaxFrozenVideoModels = Object.freeze([...miniMaxT2VModels, "MiniMax-Hailuo-2.3-Fast", "I2V-01-Director", "I2V-01-live", "I2V-01"] as const);
export type MiniMaxVideoRegion = "global" | "cn";
interface VideoBindingFields<Models extends readonly string[]> {
  product: "video";
  region: MiniMaxVideoRegion;
  origin: "https://api.minimax.io" | "https://api.minimaxi.com";
  operation: "minimax.video";
  models: Models;
  credentialKind: "api_key";
  credentialSource: "credential";
}
export type MiniMaxVideoBinding = VideoBindingFields<typeof miniMaxT2VModels> & (
  { version: "clawrouter.minimax-video.v1" }
  | { version: "clawrouter.minimax-video.v2"; region: "global"; origin: "https://api.minimax.io";
    inputProfile: "inline-first-frame.v1" }
) | VideoBindingFields<typeof miniMaxFrozenVideoModels> & { version: "clawrouter.minimax-video.v3";
  region: "global"; origin: "https://api.minimax.io"; inputProfile: "inline-first-frame.v1" };

export function miniMaxVideoBinding(region: MiniMaxVideoRegion): Readonly<Extract<MiniMaxVideoBinding, { version: "clawrouter.minimax-video.v1" }>> {
  return Object.freeze({ version: "clawrouter.minimax-video.v1", product: "video", region,
    origin: region === "global" ? "https://api.minimax.io" : "https://api.minimaxi.com",
    operation: "minimax.video", models: miniMaxT2VModels, credentialKind: "api_key", credentialSource: "credential" });
}

export function miniMaxInlineVideoBinding(): Readonly<Extract<MiniMaxVideoBinding, { version: "clawrouter.minimax-video.v2" }>> {
  return Object.freeze({ ...miniMaxVideoBinding("global"), version: "clawrouter.minimax-video.v2",
    region: "global", origin: "https://api.minimax.io", inputProfile: "inline-first-frame.v1" });
}

export function miniMaxSixModelVideoBinding(): Readonly<Extract<MiniMaxVideoBinding, { version: "clawrouter.minimax-video.v3" }>> {
  return Object.freeze({ ...miniMaxInlineVideoBinding(), version: "clawrouter.minimax-video.v3", models: miniMaxFrozenVideoModels });
}

export function isMiniMaxVideoModel(model: unknown): model is typeof miniMaxFrozenVideoModels[number] {
  return typeof model === "string" && (miniMaxFrozenVideoModels as readonly string[]).includes(model);
}

export function miniMaxVideoRequiresInline(model: unknown): boolean {
  return isMiniMaxVideoModel(model) && !(miniMaxT2VModels as readonly string[]).includes(model);
}

export function miniMaxVideoBindingModel(value: unknown, model: unknown): boolean {
  const binding = readMiniMaxVideoBinding(value);
  return !!binding && typeof model === "string" && (binding.models as readonly string[]).includes(model);
}

export function readMiniMaxVideoBinding(value: unknown): MiniMaxVideoBinding | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.region !== "global" && row.region !== "cn") return null;
  if ((row.version === "clawrouter.minimax-video.v2" || row.version === "clawrouter.minimax-video.v3") && row.region !== "global") return null;
  const expected = row.version === "clawrouter.minimax-video.v3" ? miniMaxSixModelVideoBinding() : row.version === "clawrouter.minimax-video.v2" ? miniMaxInlineVideoBinding() : miniMaxVideoBinding(row.region);
  const models = row.models;
  if (Object.keys(row).length !== Object.keys(expected).length || !Array.isArray(models)
    || models.length !== expected.models.length || Object.keys(models).length !== expected.models.length
    || expected.models.some((model, index) => models[index] !== model)
    || Object.entries(expected).some(([key, item]) => key !== "models" && row[key] !== item)) return null;
  return expected.version === "clawrouter.minimax-video.v3"
    ? { ...expected, models: [...miniMaxFrozenVideoModels] } : { ...expected, models: [...miniMaxT2VModels] };
}
