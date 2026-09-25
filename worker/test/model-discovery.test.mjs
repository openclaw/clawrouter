import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { discoverModels, MODEL_DISCOVERY_TIMEOUT_MS, parseModelPage } from "../model-discovery.ts";

const openai = (ids = ["private-model"]) => ({ object: "list", data: ids.map(id => ({ id, object: "model", created: 1_700_000_000, owned_by: "organization-fixture", unknown: "ignored" })) });

test("OpenAI retains only reported identity facts, never executable model metadata", async context => {
  const requests = [];
  context.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push([String(url), init]);
    return Response.json(openai(["z", "a", "a"]));
  });
  const result = await discoverModels("openai.models", new Headers({ authorization: "Bearer synthetic-list-key" }));
  assert.equal(result.error, null);
  assert.deepEqual(result.models, ["a", "z"].map(id => ({ id, created: 1_700_000_000, ownedBy: "organization-fixture" })));
  assert.equal(requests.length, 1);
  assert.equal(requests[0][0], "https://api.openai.com/v1/models");
  assert.equal(requests[0][1].method, "GET");
  assert.equal(requests[0][1].redirect, "manual");
  assert.equal(requests[0][1].body, undefined);
  assert.equal(requests[0][1].headers.get("authorization"), "Bearer synthetic-list-key");
});

for (const adapter of ["openai.models", "google.models"]) test(`${adapter} rejects redirects and cancels the response body`, async context => {
  let calls = 0, cancelled = 0;
  context.mock.method(globalThis, "fetch", async (_url, init) => {
    calls++;
    assert.equal(init.redirect, "manual");
    return new Response(new ReadableStream({ cancel() { cancelled++; } }), {
      status: 302, headers: { location: "https://redirect.example/not-a-model-list" },
    });
  });
  assert.deepEqual(await discoverModels(adapter, new Headers()), { models: null, error: "upstream_rejected" });
  assert.equal(calls, 1);
  assert.equal(cancelled, 1);
});

test("Google paginates opaque tokens with constant parameters and preserves provider method names", async context => {
  const token = " opaque +/%=? token \n", urls = [];
  context.mock.method(globalThis, "fetch", async (url, init) => {
    urls.push(url);
    assert.equal(url.origin, "https://generativelanguage.googleapis.com");
    assert.equal(init.headers.get("x-goog-api-key"), "synthetic-google-key");
    return Response.json(urls.length === 1 ? {
      models: [{ name: "models/z", baseModelId: "z", version: "001", displayName: "Z", inputTokenLimit: "1.2e4", outputTokenLimit: 100, supportedGenerationMethods: ["generateContent", "embedContent", "generateContent"], description: "discarded", pricing: "discarded" }], nextPageToken: token,
    } : { models: [{ name: "models/a", supportedGenerationMethods: null }] });
  });
  const result = await discoverModels("google.models", new Headers({ "x-goog-api-key": "synthetic-google-key" }));
  assert.equal(result.error, null);
  assert.equal(urls.length, 2);
  assert.equal(urls[0].searchParams.get("pageToken"), null);
  assert.equal(urls[1].searchParams.get("pageToken"), token);
  assert.deepEqual(urls.map(url => url.searchParams.get("pageSize")), ["1000", "1000"]);
  assert.deepEqual(result.models, [
    { id: "models/a", supportedGenerationMethods: [] },
    { id: "models/z", baseModelId: "z", version: "001", displayName: "Z", inputTokenLimit: 12000, outputTokenLimit: 100, supportedGenerationMethods: ["embedContent", "generateContent"] },
  ]);
});

for (const body of [{}, { models: null }, { models: [], nextPageToken: null }]) test(`Google empty ProtoJSON collection ${JSON.stringify(body)}`, () => {
  assert.deepEqual(parseModelPage("google.models", body), { models: [], nextPageToken: "" });
});

for (const [adapter, value] of [
  ["openai.models", {}], ["openai.models", { object: "list", data: [null] }],
  ["openai.models", { object: "list", data: [{ id: "model", object: "model", created: -1, owned_by: "org" }] }],
  ["google.models", { models: [null] }], ["google.models", { models: [{ name: "../model" }] }],
  ["google.models", { models: [{ name: "models/a", supportedGenerationMethods: [null] }] }],
  ["google.models", { models: [{ name: "models/a", outputTokenLimit: "not-a-count" }] }],
  ["google.models", { models: [{ name: "models/a", inputTokenLimit: 2_147_483_648 }] }],
]) test(`invalid ${adapter} response is rejected as a whole: ${JSON.stringify(value)}`, () => {
  assert.throws(() => parseModelPage(adapter, value), error => error.code === "invalid_response");
});

for (const scenario of ["status", "malformed", "bytes", "stream-bytes", "ids", "pages", "loop", "conflicting-duplicate", "transport"]) test(`discovery ${scenario} never returns partial data or raw errors`, async context => {
  let calls = 0;
  context.mock.method(globalThis, "fetch", async () => {
    calls++;
    if (scenario === "status") return new Response("private-provider-error", { status: 403 });
    if (scenario === "malformed") return new Response("private-provider-error");
    if (scenario === "bytes") return new Response("{}", { headers: { "content-length": String(1024 * 1024 + 1) } });
    if (scenario === "stream-bytes") return new Response(" ".repeat(1024 * 1024 + 1));
    if (scenario === "ids") return Response.json({ models: Array.from({ length: 1001 }, (_, id) => ({ name: `models/m${id}` })) });
    if (scenario === "transport") throw new Error("private-provider-error");
    if (scenario === "conflicting-duplicate") return Response.json({ models: [{ name: "models/a", version: String(calls) }], nextPageToken: calls === 1 ? "more" : undefined });
    return Response.json({ models: [{ name: `models/m${calls}` }], nextPageToken: scenario === "loop" ? "same" : `page${calls}` });
  });
  const result = await discoverModels("google.models", new Headers());
  assert.equal(result.models, null);
  assert.equal(result.error, scenario === "status" ? "upstream_rejected" : scenario === "transport" ? "transport_error" : ["bytes", "stream-bytes", "ids", "pages"].includes(scenario) ? "limit_exceeded" : "invalid_response");
  assert.doesNotMatch(JSON.stringify(result), /private-provider-error/);
  assert.ok(calls <= 10);
});

test("byte budget covers all pages, not one page at a time", async context => {
  context.mock.method(globalThis, "fetch", async () => Response.json({ models: [], nextPageToken: "more", ignored: "x".repeat(600_000) }));
  assert.equal((await discoverModels("google.models", new Headers())).error, "limit_exceeded");
});

test("one ten-second deadline aborts discovery and is cleared", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let signal;
  context.mock.method(globalThis, "fetch", async (_url, init) => {
    signal = init.signal;
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  });
  const pending = discoverModels("openai.models", new Headers());
  context.mock.timers.tick(MODEL_DISCOVERY_TIMEOUT_MS);
  assert.equal(signal.aborted, true);
  assert.deepEqual(await pending, { models: null, error: "timeout" });
});
