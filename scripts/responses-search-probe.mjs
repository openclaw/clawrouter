import assert from "node:assert/strict";
import { readSearchProbeJson, searchOutputSummary } from "./standalone-search-probe.mjs";

export const responseToolLimit = 3;
export function responsesSearchBody(url) {
  assert.equal(new URL(url).protocol, "https:", "search target must use HTTPS");
  return {
    model: "gpt-6.1-sol", store: false, reasoning: { effort: "low" },
    tools: [{ type: "web_search", external_web_access: true }],
    tool_choice: { type: "web_search" }, max_tool_calls: responseToolLimit,
    parallel_tool_calls: false, max_output_tokens: 2048,
    input: `Use web search to open ${url} and report the exact value labeled "Current retrieval marker" on that page. Retrieve the page itself. If unavailable, say so; do not guess.`,
  };
}

export function responsesSearchSummary(response, value, marker, url) {
  const output = Array.isArray(value?.output) ? value.output : [];
  const messages = output.filter(item => item?.type === "message");
  const parts = messages.flatMap(item => Array.isArray(item.content) ? item.content : []);
  const text = parts.filter(part => part?.type === "output_text" && typeof part.text === "string").map(part => part.text).join("\n");
  const calls = output.filter(item => item?.type === "web_search_call");
  const actions = { search: 0, openPage: 0, findInPage: 0, unknown: 0 };
  for (const item of calls) {
    if (item.action?.type === "search") actions.search++;
    else if (item.action?.type === "open_page") actions.openPage++;
    else if (item.action?.type === "find_in_page") actions.findInPage++;
    else actions.unknown++;
  }
  const responseStatus = ["completed", "failed", "incomplete", "cancelled", "in_progress", "queued"].includes(value?.status) ? value.status : "unknown";
  const completedWebSearchCalls = calls.filter(item => item.status === "completed").length;
  const errorPresent = value?.error != null, incomplete = value?.incomplete_details != null;
  const refused = parts.some(part => part?.type === "refusal");
  const unexpectedOutput = output.some(item => !["message", "reasoning", "web_search_call"].includes(item?.type));
  const toolCallLimitExceeded = calls.length > responseToolLimit;
  const tokens = value?.usage;
  const usageTokens = tokens && [tokens.input_tokens, tokens.output_tokens, tokens.total_tokens].every(number => Number.isSafeInteger(number) && number >= 0)
    ? { input: tokens.input_tokens, output: tokens.output_tokens, total: tokens.total_tokens } : null;
  return {
    ...searchOutputSummary(response, { output: text, usage: tokens }, marker),
    responseStatus, errorPresent, incomplete, refused, unexpectedOutput, webSearchCalls: calls.length,
    completedWebSearchCalls, actions, toolCallLimitExceeded, usageTokens,
    targetOpened: calls.some(item => item.status === "completed" && item.action?.type === "open_page" && item.action.url === url),
    toolSuccess: responseStatus === "completed" && !errorPresent && !incomplete && !refused && !unexpectedOutput && calls.length > 0 && completedWebSearchCalls === calls.length && actions.unknown === 0 && !toolCallLimitExceeded,
  };
}

export async function directResponsesSearchProbe({ key, url, marker, fetcher = fetch }) {
  assert.ok(key?.trim(), "inject OPENAI_API_KEY through the credential helper");
  const response = await fetcher("https://api.openai.com/v1/responses", {
    method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(responsesSearchBody(url)), redirect: "error", signal: AbortSignal.timeout(90_000),
  });
  const value = await readSearchProbeJson(response);
  return { summary: responsesSearchSummary(response, value, marker, url), value };
}
