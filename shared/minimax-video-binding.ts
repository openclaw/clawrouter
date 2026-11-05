export const miniMaxT2VModels = Object.freeze(["MiniMax-Hailuo-2.3", "MiniMax-Hailuo-02"] as const);
export type MiniMaxVideoRegion = "global" | "cn";
export interface MiniMaxVideoBinding {
  version: "clawrouter.minimax-video.v1";
  product: "video";
  region: MiniMaxVideoRegion;
  origin: "https://api.minimax.io" | "https://api.minimaxi.com";
  operation: "minimax.video";
  models: readonly ["MiniMax-Hailuo-2.3", "MiniMax-Hailuo-02"];
  credentialKind: "api_key";
  credentialSource: "credential";
}

export function miniMaxVideoBinding(region: MiniMaxVideoRegion): Readonly<MiniMaxVideoBinding> {
  return Object.freeze({ version: "clawrouter.minimax-video.v1", product: "video", region,
    origin: region === "global" ? "https://api.minimax.io" : "https://api.minimaxi.com",
    operation: "minimax.video", models: miniMaxT2VModels, credentialKind: "api_key", credentialSource: "credential" });
}

export function readMiniMaxVideoBinding(value: unknown): MiniMaxVideoBinding | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.region !== "global" && row.region !== "cn") return null;
  const expected = miniMaxVideoBinding(row.region);
  if (Object.keys(row).length !== Object.keys(expected).length || !Array.isArray(row.models)
    || row.models.length !== 2 || Object.keys(row.models).length !== 2
    || row.models[0] !== miniMaxT2VModels[0] || row.models[1] !== miniMaxT2VModels[1]
    || Object.entries(expected).some(([key, item]) => key !== "models" && row[key] !== item)) return null;
  return { ...expected, models: [...miniMaxT2VModels] };
}
