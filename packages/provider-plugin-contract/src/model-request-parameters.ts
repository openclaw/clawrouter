export type ProviderReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ParameterSupport = "supported" | "unsupported" | "requires_reasoning_none";

export interface ModelRequestParameters {
  sources: string[];
  checkedAt: string;
  defaultReasoningEffort?: ProviderReasoningEffort;
  temperature?: ParameterSupport;
  topP?: ParameterSupport;
  logprobs?: ParameterSupport;
  toolCalling?: ParameterSupport;
}
