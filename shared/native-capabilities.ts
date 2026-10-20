// Model/endpoint support, never a grant, price, or admission decision.
export interface NativeDecisionCapabilities {
  protocol: "openai-decisions";
  reasoning?: { modes: Array<"auto"> };
  questions: {
    boolean?: { probabilities: "boolean"; abstention: boolean };
    choice?: { probabilities: "categorical"; abstention: boolean; minOptions: number; maxOptions: number };
    score?: { probabilities: "categorical"; abstention: boolean };
  };
  confidence?: "provider-specific";
  limits: { maxQuestions: number; image?: { maxBytes: number; mimeTypes: Array<"image/png" | "image/jpeg" | "image/webp">; remoteUrls: boolean } };
}
export interface NativeEndpointCapabilities {
  sources: string[];
  checkedAt: string;
  input?: Array<"text" | "image" | "audio" | "video" | "json">;
  // Full context, preferred input threshold, and endpoint output bound are
  // distinct from the router's authoritative reservation/pricing limits.
  contextWindow?: number;
  contextTokens?: number;
  maxOutputTokens?: number;
  supportedServiceTiers?: string[];
  inference?: { chat?: boolean; decision?: NativeDecisionCapabilities };
}
export interface NativeModelCapabilities {
  version: "clawrouter.native-capabilities.v1";
  endpoints: Record<string, NativeEndpointCapabilities>;
}
