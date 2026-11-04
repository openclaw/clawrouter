// Model/endpoint support, never a grant, price, or admission decision.
export interface OpenAiDecisionCapabilities {
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
export interface BasetenSystemOneDecisionCapabilities {
  protocol: "baseten-systemone";
  reasoning: { modes: Array<"auto"> };
  questions: {
    boolean: { probabilities: "boolean"; abstention: false };
    choice: { probabilities: "provider-defined"; abstention: false; minOptions: 2; maxOptions: 255 };
    score: { probabilities: "provider-defined"; abstention: false; minOptions: 2; maxOptions: 10 };
  };
  confidence: "provider-specific";
  outputTokensPerQuestion: 1;
  limits: { maxTotalOptions: 512; maxStateAndQuestionTokens: 16384 };
}
export type NativeDecisionCapabilities = OpenAiDecisionCapabilities | BasetenSystemOneDecisionCapabilities;
export interface OpaquePcmSpeechProfile {
  voiceRequired: true;
  responseFormat: "pcm";
  output: { kind: "opaque"; mimeType: "audio/pcm"; sampleRate: null; voiceCompatible: false };
}
export interface NativeEndpointCapabilities {
  sources: string[];
  checkedAt: string;
  input?: Array<"text" | "image" | "audio" | "video" | "json">;
  speech?: OpaquePcmSpeechProfile;
  // Full context, preferred input threshold, and endpoint output bound are
  // distinct from the router's authoritative reservation/pricing limits.
  contextWindow?: number;
  contextTokens?: number;
  maxOutputTokens?: number;
  supportedServiceTiers?: string[];
  hostedTools?: Array<"web_search">;
  inference?: { chat?: boolean; decision?: NativeDecisionCapabilities };
}
export interface NativeModelCapabilities {
  version: "clawrouter.native-capabilities.v1";
  endpoints: Record<string, NativeEndpointCapabilities>;
}
