import { maxAnthropicJsonBodyBytes, maxJsonBodyBytes } from "./utils.ts";

// Opt in only after provider and endpoint resolution. OpenAI-compatible
// providers, admin routes and unrelated OpenAI APIs retain the default cap.
export function proxyJsonBodyLimit(providerId: string, requestFormat: string): number {
  if (providerId === "anthropic" && requestFormat === "anthropic.messages") return maxAnthropicJsonBodyBytes;
  // Reuse the qualified 32 MB Worker envelope, not OpenAI's much larger direct
  // image-input allowance: the isolate has only 128 MB shared memory.
  if (providerId === "openai" && expandedOpenAiFormat(requestFormat)) return 32_000_000;
  return maxJsonBodyBytes;
}

export function expandedOpenAiFormat(requestFormat: string): boolean {
  return ["openai.responses", "openai.chat_completions", "openai.responses_compact", "openai.responses_input_tokens"].includes(requestFormat);
}
