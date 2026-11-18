import type { ModelPricing, RequestPricing } from "./pricing.ts";

// Compiled endpoint declarations. Execution and admission remain host-owned.
export type ManagedProtocol = "replicate.predictions" | "fal.queue" | "kie.jobs" | "vydra.jobs" | "dashscope.video" | "pixverse.video" | "runway.tasks" | "together.video" | "google.omni_video" | "openrouter.video" | "minimax.video";
export type ManagedFileLinks = { mode?: "metadata"; metadata: string; download: string }
  | { mode: "download_only"; metadata?: never; download: string };

export interface OutputTokenLimit { field: "max_tokens" | "max_completion_tokens" | "max_output_tokens"; minimum: number; maximum: number }
export interface ToolPricing { version: string; effectiveAt: string; source: string; webSearchMicrosPerCall: number; previewMicrosPerCallByModel: Record<string, number> }
export interface CompiledEndpoint { inputProfile?: "clawrouter.pixverse-image-input.v1"; id: string; method: string; methods: string[]; path: string; upstreamPath?: string; native_proxy: boolean; auth: string | null; headers: Record<string, string>; request_headers: string[]; response_headers: string[]; query: Record<string, string>; path_params: string[]; path_param_styles: Record<string, string>; request_format: string; response_format: string; streaming: string | null; responsesLifecycle?: { retrieve: string; cancel: string }; lifecycle?: { protocol: ManagedProtocol; retrieve: string; result?: string; cancel?: string; files?: ManagedFileLinks }; outputTokenLimit?: OutputTokenLimit; toolPricing?: ToolPricing; requestPricing?: RequestPricing; modelPassthrough?: { pricing_ref: string | null; pricing: ModelPricing | null }; websocket?: "openai.responses" | "openai.realtime"; timeout_ms: number | null }
