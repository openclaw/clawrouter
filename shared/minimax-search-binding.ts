export interface MiniMaxSearchBinding {
  version: "clawrouter.minimax-search.v1";
  product: "token-plan-search";
  region: "global" | "cn";
  origin: "https://api.minimax.io" | "https://api.minimaxi.com";
  operation: "minimax.search";
  model: null;
  credentialKind: "api_key";
  credentialSource: "credential";
}

export function miniMaxSearchBinding(region: "global" | "cn"): Readonly<MiniMaxSearchBinding> {
  return Object.freeze({ version: "clawrouter.minimax-search.v1", product: "token-plan-search", region,
    origin: region === "global" ? "https://api.minimax.io" : "https://api.minimaxi.com",
    operation: "minimax.search", model: null, credentialKind: "api_key", credentialSource: "credential" });
}

export function readMiniMaxSearchBinding(value: unknown): MiniMaxSearchBinding | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.region !== "global" && row.region !== "cn") return null;
  const expected = miniMaxSearchBinding(row.region);
  return Object.keys(row).length === Object.keys(expected).length
    && Object.entries(expected).every(([key, item]) => row[key] === item) ? { ...expected } : null;
}
