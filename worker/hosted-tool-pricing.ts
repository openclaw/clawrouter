import { googleField } from "./google-protocol.ts";

export const claudeSearchTypes = new Set(["web_search_20250305", "web_search_20260209", "web_search_20260318"]);

// Classify known executable declarations only. A null result does not attest
// that an unknown or partially observed tool inventory is complete.
export function hostedToolPricingGap(tools: readonly unknown[], requestFormat: string): "hosted_tool_fee" | "hosted_tool_usage" | null {
  let usageGap = false;
  for (const tool of tools) {
    if (!isObject(tool)) continue;
    // Inspect protocol declarations, never function names or user JSON schemas.
    if (requestFormat === "openai.chat_completions" && ["browser_search", "code_interpreter"].includes(String(tool.type))) return "hosted_tool_fee";
    if (requestFormat === "openai.responses" && typeof tool.type === "string") {
      if (/^web_search(?:_preview)?(?:_\d{4}_\d{2}_\d{2})?$/.test(tool.type) || ["x_search", "file_search", "code_interpreter", "image_generation"].includes(tool.type)) return "hosted_tool_fee";
      if (tool.type === "shell" && isObject(tool.environment) && ["container_auto", "container_reference"].includes(String(tool.environment.type))) return "hosted_tool_fee";
      // Hosted search has no qualified cumulative bound; this is not a fee claim.
      if (["mcp", "programmatic_tool_calling"].includes(tool.type) || tool.type === "tool_search" && tool.execution !== "client") usageGap = true;
    }
    if (requestFormat === "anthropic.messages" && typeof tool.type === "string" && /^web_search_\d{8}$/.test(tool.type)) {
      if (!claudeSearchTypes.has(tool.type)) return "hosted_tool_fee";
      usageGap = true;
    }
    // Anthropic waives execution fees when these web-tool versions are present.
    // Their search fee, when applicable, is still handled by the branch above.
    if (requestFormat === "anthropic.messages" && typeof tool.type === "string" && /^code_execution_\d{8}$/.test(tool.type) && !tools.some((candidate) => isObject(candidate) && typeof candidate.type === "string" && /^web_(?:search|fetch)_\d{8}$/.test(candidate.type) && candidate.type.slice(-8) >= "20260209")) return "hosted_tool_fee";
    // A waived execution fee does not bound accumulated server-loop input.
    if (requestFormat === "anthropic.messages" && typeof tool.type === "string" && (/^(?:web_fetch|code_execution)_\d{8}$/.test(tool.type) || /^(?:tool_search_tool_regex|tool_search_tool_bm25)(?:_20251119)?$/.test(tool.type) || ["advisor_20260301", "mcp_toolset"].includes(tool.type))) usageGap = true;
    if (requestFormat === "google.generate_content") {
      if ([["googleSearch", "google_search"], ["googleSearchRetrieval", "google_search_retrieval"], ["googleMaps", "google_maps"]].some(([camel, proto]) => isObject(googleField(tool, camel, proto)))) return "hosted_tool_fee";
      // These tools have token charges rather than a flat tool fee, but their
      // server-side work is not covered by our ordinary prompt/output bounds.
      if ([["urlContext", "url_context"], ["fileSearch", "file_search"], ["codeExecution", "code_execution"]].some(([camel, proto]) => isObject(googleField(tool, camel, proto)))) usageGap = true;
      const servers = googleField(tool, "mcpServers", "mcp_servers");
      if (Array.isArray(servers) && servers.length) usageGap = true;
    }
  }
  return usageGap ? "hosted_tool_usage" : null;
}

function isObject(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
