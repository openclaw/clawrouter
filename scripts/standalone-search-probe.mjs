import assert from "node:assert/strict";

// Explicit diagnostic only. Keep output content and credentials in memory;
// return a closed metadata projection suitable for qualification logs.
export function searchProbeSummary(response, value, marker) {
  const output = typeof value?.output === "string" ? value.output : "";
  const requestId = response.headers.get("x-request-id");
  return {
    status: response.status,
    requestId: /^req_[a-zA-Z0-9_-]{1,128}$/.test(requestId ?? "") ? requestId : null,
    outputChars: output.length,
    internalError: /internal error/i.test(output),
    referenceError: /invalid ref(?:erence|_id)|unable to resolve (?:open|find|click) call/i.test(output),
    fetchError: /failed to fetch|not safe to open|blocked|error fetching|403 Forbidden|404 Not Found/i.test(output),
    markerReturned: !!marker && output.includes(marker),
    hasUsage: value?.usage != null,
    hasEncryptedOutput: typeof value?.encrypted_output === "string",
  };
}

export async function directSearchProbe({ key, body, headers = {}, marker, fetcher = fetch }) {
  assert.ok(key?.trim(), "inject OPENAI_API_KEY through the credential helper");
  const outgoing = new Headers(headers);
  outgoing.set("authorization", `Bearer ${key}`);
  outgoing.set("content-type", "application/json");
  outgoing.delete("host"); outgoing.delete("content-length");
  const response = await fetcher("https://api.openai.com/v1/alpha/search", {
    method: "POST", headers: outgoing, body: JSON.stringify(body),
    redirect: "error", signal: AbortSignal.timeout(90_000),
  });
  let text = "", size = 0;
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    size += chunk.length;
    assert.ok(size <= 2 * 1024 * 1024, "direct probe response limit exceeded");
    text += decoder.decode(chunk, { stream: true });
  }
  text += decoder.decode();
  let value;
  try { value = JSON.parse(text); } catch { throw new Error("direct search response is not JSON"); }
  return { summary: searchProbeSummary(response, value, marker), value };
}
