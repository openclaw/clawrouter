export interface GenerationBillingBinding {
  providerId: string;
  requestFormat: string;
  capability: string;
  method: string;
  selectedModel: string | null;
}

// A status alone is not billing evidence. Only an actual response from this
// qualified generation route establishes the documented Novita 499 outcome.
// https://docs.novita.ai/guides/llm-billing
export function upstreamGenerationMayBeCharged(binding: Readonly<GenerationBillingBinding>, url: URL, status: number): boolean {
  return status === 499 && binding.providerId === "novita" && binding.method === "POST"
    && binding.capability === "llm.chat" && binding.requestFormat === "openai.chat_completions"
    && typeof binding.selectedModel === "string" && binding.selectedModel.length > 0
    && url.origin === "https://api.novita.ai" && url.pathname === "/openai/v1/chat/completions"
    && !url.search && !url.hash && !url.username && !url.password;
}
