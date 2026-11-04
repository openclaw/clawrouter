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
export interface InlineMusicReferenceImage {
  required: false;
  count: 1;
  encoding: "base64_data_url";
  mimeTypes: ["image/png", "image/jpeg", "image/webp"];
  maxDecodedBytes: 8388608;
  maxJsonBytes: 12582912;
  https: false;
  assetHandles: false;
}
// Support facts only. Publication permission and original-input authority are
// evaluated by the server; this record never selects a request mode.
const publishedMusicInputShape = {
  version: "clawrouter.published-input.v1",
  publication: {
    method: "POST", path: "/v1/input-assets/openrouter/music", query: false, body: "native_plan",
    idempotencyKey: { header: "Idempotency-Key", pattern: "^[A-Za-z0-9._:-]{1,128}$" },
  },
  slot: "messages[0].content[1].image_url.url",
  count: 1, encoding: "base64_data_url", mimeTypes: ["image/png", "image/jpeg", "image/webp"],
  maxDecodedBytes: 8388608, maxJsonBytes: 12582912, maxForwardJsonBytes: 262144,
  maxLifetimeSeconds: 900, renewable: false, destinationAttempts: 1,
} as const;
export type PublishedMusicInputSupport = typeof publishedMusicInputShape;

export function isPublishedMusicInputSupport(value: unknown): value is PublishedMusicInputSupport {
  return matchesSupport(value, publishedMusicInputShape);
}
function matchesSupport(value: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== "object") return value === expected;
  if (!value || typeof value !== "object" || Array.isArray(value) !== Array.isArray(expected)) return false;
  if (Array.isArray(expected) && (value as unknown[]).length !== expected.length) return false;
  const keys = Object.keys(expected);
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)
    && matchesSupport((value as Record<string, unknown>)[key], (expected as Record<string, unknown>)[key]));
}
export interface NativeEndpointCapabilities {
  sources: string[];
  checkedAt: string;
  input?: Array<"text" | "image" | "audio" | "video" | "json">;
  speech?: OpaquePcmSpeechProfile;
  referenceImage?: InlineMusicReferenceImage;
  publishedInput?: PublishedMusicInputSupport;
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
