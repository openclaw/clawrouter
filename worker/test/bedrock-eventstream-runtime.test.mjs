import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { observeUsage } from "../proxy-response.ts";
import { proxyKey, usageEnv } from "./usage-budget-fixture.mjs";
import { chunk, eventFrame, novaFinal } from "./bedrock-eventstream-fixture.mjs";
const { default: handler } = await import("../index.ts");
const contentType = "application/vnd.amazon.eventstream";

for (const manifest of [false, true]) for (const error of [false, true]) test(`Bedrock ${manifest ? "manifest" : "native"} stream preserves wire and ${error ? "modeled error" : "usage"}`, async t => {
  const pending = [], events = [], env = usageEnv([], { provider: "aws-bedrock", limit: null, fixedCost: null, retainContent: false });
  Object.assign(env, { AWS_ACCESS_KEY_ID: "fixture-access", AWS_SECRET_ACCESS_KEY: "fixture-secret", AWS_REGION: "us-east-1" });
  env.USAGE_QUEUE = { send: async event => events.push(event) };
  const wire = Buffer.concat([chunk({ contentBlockDelta: { delta: { text: "fixture" } } }), error
    ? eventFrame({ message: "fixture failure" }, { ":message-type": "exception", ":exception-type": "modelStreamErrorException" }) : chunk(novaFinal)]);
  const upstream = t.mock.method(globalThis, "fetch", async () => new Response(wire, { headers: { "content-type": contentType } }));
  const body = { messages: [{ role: "user", content: [{ text: "fixture" }] }] }, model = "amazon.nova-lite-v1:0";
  const response = await handler.fetch(new Request(`https://router.example/v1/${manifest ? "proxy/aws-bedrock/invoke_model_stream" : `native/aws-bedrock/model/${encodeURIComponent(model)}/invoke-with-response-stream`}`, {
    method: "POST", headers: { authorization: `Bearer ${proxyKey()}`, "content-type": "application/json" }, body: JSON.stringify(manifest ? { body, pathParams: { model } } : body),
  }), env, { waitUntil: promise => pending.push(promise) });
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), wire);
  await Promise.all(pending);
  assert.equal(upstream.mock.callCount(), 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].status, error ? "provider_error" : "success");
  assert.equal(events[0].input_tokens, error ? null : 10);
  assert.equal(events[0].output_tokens, error ? null : 2);
});

test("Bedrock observer retains demand and propagates cancellation without draining", async () => {
  let pulls = 0, canceled;
  const bytes = chunk({ contentBlockDelta: { delta: { text: "fixture" } } });
  const upstream = new ReadableStream({ pull(c) { pulls++; c.enqueue(bytes); }, cancel(reason) { canceled = reason; } }, { highWaterMark: 0 });
  const observed = observeUsage(new Response(upstream, { headers: { "content-type": contentType } }), undefined, undefined, "aws_bedrock.eventstream");
  assert.equal(pulls, 0);
  const reader = observed.response.body.getReader();
  assert.deepEqual((await reader.read()).value, bytes);
  assert.equal(pulls, 1);
  await reader.cancel("fixture cancellation");
  assert.equal(canceled, "fixture cancellation");
  assert.deepEqual(await observed.result, { tokens: null, outcome: null, delivery: "canceled" });
});

test("Bedrock corrupt bytes are forwarded unchanged and cannot publish trusted usage", async () => {
  const bytes = chunk(novaFinal); bytes[bytes.length - 1] ^= 1;
  const observed = observeUsage(new Response(bytes, { headers: { "content-type": contentType } }), undefined, undefined, "aws_bedrock.eventstream");
  assert.deepEqual(Buffer.from(await observed.response.arrayBuffer()), bytes);
  assert.deepEqual(await observed.result, { tokens: null, outcome: "provider_error", delivery: "complete" });
});
