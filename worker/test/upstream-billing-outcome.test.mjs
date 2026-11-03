import assert from "node:assert/strict";
import test from "node:test";
import { upstreamGenerationMayBeCharged } from "../upstream-billing-outcome.ts";
const binding = { providerId: "novita", method: "POST", capability: "llm.chat", requestFormat: "openai.chat_completions", selectedModel: "stepfun/step-3.7-flash" };
const url = new URL("https://api.novita.ai/openai/v1/chat/completions");

test("only a qualified Novita generation response establishes the HTTP499 billing outcome", () => {
  assert.equal(upstreamGenerationMayBeCharged(binding, url, 499), true);
  for (const status of [200, 400, 401, 403, 404, 429, 500, 503, 504]) assert.equal(upstreamGenerationMayBeCharged(binding, url, status), false);
  for (const patch of [{ providerId: "openai" }, { method: "GET" }, { capability: "llm.embeddings" },
    { requestFormat: "openai.models" }, { selectedModel: null }, { selectedModel: "" }])
    assert.equal(upstreamGenerationMayBeCharged({ ...binding, ...patch }, url, 499), false);
});

test("billing evidence cannot come from a catalog, alternate origin, query or caller credentials in a URL", () => {
  for (const value of ["https://api.novita.ai/openai/v1/models", "https://api.novita.ai/v3/openai/chat/completions",
    "https://other.example/openai/v1/chat/completions", "http://api.novita.ai/openai/v1/chat/completions",
    url.href + "?status=499", url.href + "#499", "https://synthetic@api.novita.ai/openai/v1/chat/completions"])
    assert.equal(upstreamGenerationMayBeCharged(binding, new URL(value), 499), false);
});
