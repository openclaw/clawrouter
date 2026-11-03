import assert from "node:assert/strict";
import { fixture } from "./managed-runtime-fixture.mjs";
const { snapshot } = await import("../providers.ts");
export const googleContinuationToken = "c3ludGhldGljLW9yaWdpbmFsLXN0YXRl";
export const googleOriginalRequest = { contents: [{ role: "user", parts: [{ text: "Synthetic original request" }] }], generationConfig: { maxOutputTokens: 100 } };
export const googleContinuationResponse = {
  candidates: [{ finishReason: "CONTINUATION", continuationToken: googleContinuationToken, content: { parts: [{ text: "Synthetic output" }] } }],
  usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3, thoughtsTokenCount: 2, totalTokenCount: 17 },
};

// Source-owned pricing tests can use the same real Worker + scoped SQLite
// authority to obtain an original response before exercising another hop.
export async function googleContinuationFixture(t, { stream = false, manifest = false, pooled = false, fixed = 700 } = {}) {
  const original = snapshot.providers, google = structuredClone(original.find(provider => provider.id === "google-gemini"));
  assert.ok(google); snapshot.providers = original.filter(provider => provider.id !== google.id);
  t.after(() => { snapshot.providers = original; });
  const f = await fixture(t, { fixed, pooled, providerId: google.id, configure(provider) { Object.assign(provider, google); } });
  f.model = f.provider.models.find(model => model.upstream === "gemini-3.5-flash"); assert.ok(f.model);
  f.env.GOOGLE_API_KEY = "synthetic-google-environment";
  f.output = structuredClone(googleContinuationResponse);
  f.wire = (value = f.output) => stream ? `data: ${JSON.stringify(value)}\n\n` : JSON.stringify(value);
  f.upstream = () => new Response(f.wire(), { headers: { "content-type": stream ? "text/event-stream" : "application/json" } });
  f.request = (body = googleOriginalRequest, extra = {}) => {
    const options = { stream, manifest, ...extra }, model = options.model ?? f.model.upstream;
    const endpoint = options.stream ? "stream_generate_content" : "generate_content";
    const route = options.manifest ? `/v1/proxy/google-gemini/${endpoint}`
      : `/v1/native/google-gemini/v1beta/models/${model}:${options.stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
    return f.call(route, options.manifest ? { body, pathParams: { model }, query: options.stream ? { alt: "sse" } : {} } : body,
      { headers: options.headers, ...(options.signal ? { signal: options.signal } : {}) });
  };
  f.initial = async () => {
    const response = await f.request(); assert.equal(response.status, 200, await response.clone().text());
    assert.equal(await response.text(), f.wire()); await f.drain(); return response;
  };
  f.continuations = () => [...f.env.ACCESS_CONTROL.objects].filter(([name]) => name.startsWith("http-continuations:"))
    .flatMap(([scope, state]) => state.db.prepare("SELECT binding_key, owner_json FROM http_continuations").all().map(row => ({ scope, ...row })));
  f.reservations = () => [...new Set(f.budgetCalls.map(call => call.name))].flatMap(name => f.budgets.get(name).reservations());
  t.after(f.drain); return f;
}
