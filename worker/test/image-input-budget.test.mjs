import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { crc32, deflateSync } from "node:zlib";
import { sqlBudgetNamespace } from "./sql-budget-namespace.mjs";
import { proxyKey, usageEnv } from "./usage-budget-fixture.mjs";
const { default: handler } = await import("../index.ts");
const { providerBudgetStatus } = await import("../ledgers.ts");

// Opus 5.5 card: $4/M input, $0.20/M cache read, $8/M 1h cache write, $20/M output,
// 1,000,000 input tokens, 1,024 request overhead. Anthropic bills an image as
// ceil(width / 28) * ceil(height / 28) visual tokens and only ever downsizes it.
const model = "anthropic/claude-opus-5-5";
const opus = { inputMax: 1_000_000, overhead: 1_024, write1h: 8, output: 20 };

function png(width, height) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2; // 8-bit RGB
  // Large fixtures need only a truthful header; upstream is never reached for them.
  const rows = width * height > 4_000_000 ? Buffer.alloc(0) : Buffer.alloc((width * 3 + 1) * height); // filter byte 0 per row, black pixels
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}

// A real OpenClaw-shaped agent turn: a screenshot returned by a tool, with the
// 1h cache marker on the newest block and the Claude 5 128k output ceiling.
function screenshotTurn(source) {
  return {
    model, max_tokens: 128_000, stream: false,
    messages: [
      { role: "user", content: [{ type: "text", text: "Open the dashboard and tell me what you see." }] },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_fixture", name: "browser", input: { action: "screenshot" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_fixture", content: [{ type: "image", source }] }, { type: "text", text: "Describe it.", cache_control: { type: "ephemeral", ttl: "1h" } }] },
    ],
  };
}

const bytes = (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const reservation = (inputTokens, outputTokens = 128_000) => Math.ceil(inputTokens * opus.write1h) + outputTokens * opus.output;

function budgetEnv(t, limit) {
  const env = usageEnv([], { provider: "anthropic", limit, fixedCost: null, retainContent: false });
  env.ANTHROPIC_API_KEY = "fixture-anthropic-key";
  env.BUDGET_LEDGER = sqlBudgetNamespace(t);
  const events = [];
  env.USAGE_QUEUE = { send: async (event) => { events.push(event); } };
  return { env, events };
}

async function send(env, body) {
  const pending = [];
  const response = await handler.fetch(new Request("https://clawrouter.example/v1/messages", {
    method: "POST", headers: { authorization: `Bearer ${proxyKey()}`, "content-type": "application/json" }, body: JSON.stringify(body),
  }), env, { waitUntil: (promise) => pending.push(promise) });
  const text = await response.text();
  await Promise.all(pending);
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function spent(env, limit) {
  const usage = await handler.fetch(new Request("https://clawrouter.example/v1/usage", { headers: { authorization: `Bearer ${proxyKey()}` } }), env, {});
  return [(await usage.json()).budget.spentMicros, (await providerBudgetStatus(env, "anthropic", limit)).spentMicros];
}

const screenshot = { type: "base64", media_type: "image/png", data: png(1920, 1080) };
const screenshotBody = screenshotTurn(screenshot);
// Pricing reads the selected upstream body, which carries the native model id.
const upstreamBody = { ...screenshotBody, model: "claude-opus-5-5" };
// The encoded image is replaced by its visual-token ceiling (69 x 39 = 2,691);
// every other serialized byte, including the block wrapper, still counts.
const screenshotInput = bytes(upstreamBody) - screenshot.data.length + opus.overhead + 69 * 39;
const screenshotReserve = reservation(screenshotInput);

test("a base64 Claude screenshot reserves its visual-token bound and settles actual usage", async (t) => {
  assert.ok(screenshotReserve < 2_600_000, `realistic reservation, got ${screenshotReserve}`);
  const limit = 3_000_000; // $3: below the old full-window $10.56 Opus 5.5 reservation
  const { env, events } = budgetEnv(t, limit);
  const usage = { input_tokens: 2_000, cache_read_input_tokens: 500, cache_creation_input_tokens: 3_000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 3_000 }, output_tokens: 700 };
  const upstream = t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(String(url), "https://api.anthropic.com/v1/messages");
    assert.deepEqual(JSON.parse(init.body), upstreamBody, "the image is forwarded unchanged");
    for (const owner of ["tenant:maintainer_access:owner@example.com", "provider:anthropic"]) {
      const [held] = env.BUDGET_LEDGER.get(owner).reservations();
      assert.equal(held.reserved_micros, screenshotReserve);
    }
    return Response.json({ type: "message", content: [{ type: "text", text: "A dashboard." }], stop_reason: "end_turn", usage });
  });
  const response = await send(env, screenshotBody);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(upstream.mock.callCount(), 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].reserved_input_tokens, screenshotInput);
  assert.equal(events[0].reserved_output_tokens, 128_000);
  assert.equal(events[0].reserved_cost_micros, screenshotReserve);
  // 2,000 x $4 + 500 x $0.20 + 3,000 x $8 (1h writes) + 700 x $20, in micros.
  const actual = 8_000 + 100 + 24_000 + 14_000;
  assert.equal(events[0].actual_cost_micros, actual);
  assert.equal(events[0].cost_basis, "manifest_pricing");
  assert.deepEqual(await spent(env, limit), [actual, actual], "both ledgers settle to actual usage, not the reservation");
});

test("the image bound is an exact admission boundary, not a waiver", async (t) => {
  for (const [limit, allowed] of [[screenshotReserve - 1, false], [screenshotReserve, true]]) {
    const { env, events } = budgetEnv(t, limit);
    const upstream = t.mock.method(globalThis, "fetch", async () => Response.json({ type: "message", content: [], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 1 } }));
    const response = await send(env, screenshotBody);
    assert.equal(response.status, allowed ? 200 : 402, JSON.stringify(response.body));
    if (!allowed) assert.equal(response.body.error.code, "budget_exhausted");
    assert.equal(upstream.mock.callCount(), allowed ? 1 : 0);
    assert.equal(events[0].reserved_input_tokens, screenshotInput);
    assert.deepEqual(await spent(env, limit), allowed ? [60, 60] : [0, 0]);
    upstream.mock.restore();
  }
});

const fullWindow = reservation(opus.inputMax);
for (const [name, source, extra = {}] of [
  ["URL source", { type: "url", url: "https://example.com/screenshot.png" }],
  ["Files API source", { type: "file", file_id: "file_fixture" }],
  ["undecodable base64", { type: "base64", media_type: "image/png", data: "not-base64!" }],
  ["unrecognized image header", { type: "base64", media_type: "image/png", data: Buffer.from("not an image at all").toString("base64") }],
  ["mismatched media type", { type: "base64", media_type: "image/jpeg", data: screenshot.data }],
  ["oversized dimensions", { type: "base64", media_type: "image/png", data: png(8_001, 16) }],
  ["base64 PDF document", { type: "base64", media_type: "application/pdf", data: Buffer.from("%PDF-1.7 fixture").toString("base64") }, { document: true }],
]) test(`truly unbounded Claude media keeps the full-window reservation: ${name}`, async (t) => {
  assert.equal(fullWindow, 10_560_000);
  const limit = 3_000_000;
  const { env, events } = budgetEnv(t, limit);
  const upstream = t.mock.method(globalThis, "fetch", async () => { throw new Error("denied requests must not reach upstream"); });
  const body = screenshotTurn(source);
  if (extra.document) body.messages[2].content[0].content = [{ type: "document", source }];
  const response = await send(env, body);
  assert.equal(response.status, 402, JSON.stringify(response.body));
  assert.equal(response.body.error.code, "budget_exhausted");
  assert.equal(upstream.mock.callCount(), 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].reserved_input_tokens, opus.inputMax);
  assert.equal(events[0].actual_cost_micros, 0);
  assert.deepEqual(await spent(env, limit), [0, 0]);
});

test("an image-shaped object inside tool_use.input is billed as text and keeps the full-window 402", async (t) => {
  // A valid 1x1 PNG header followed by 3.2M base64 characters of arbitrary data.
  // Anthropic bills tool_use.input as text, so only a qualifying position may
  // replace encoded bytes with a visual-token bound.
  const filler = Buffer.concat([Buffer.from(png(1, 1), "base64"), Buffer.alloc(2_400_000, 0x41)]).toString("base64");
  const smuggled = { type: "image", source: { type: "base64", media_type: "image/png", data: filler } };
  const body = screenshotTurn(screenshot);
  body.messages[1].content[0].input = { action: "screenshot", blob: smuggled };
  const limit = 3_000_000;
  const { env, events } = budgetEnv(t, limit);
  // An answering upstream makes a wrongful admission visible as a served 200.
  const upstream = t.mock.method(globalThis, "fetch", async () => Response.json({ type: "message", content: [], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 1 } }));
  const response = await send(env, body);
  assert.equal(response.status, 402, `reserved ${events[0]?.reserved_input_tokens} input tokens`);
  assert.equal(response.body.error.code, "budget_exhausted");
  assert.equal(upstream.mock.callCount(), 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].reserved_input_tokens, opus.inputMax);
  assert.deepEqual(await spent(env, limit), [0, 0]);
});

test("many large inline images still exhaust a small budget through their summed bound", async (t) => {
  const limit = 3_000_000;
  const { env, events } = budgetEnv(t, limit);
  const upstream = t.mock.method(globalThis, "fetch", async () => { throw new Error("denied requests must not reach upstream"); });
  const large = { type: "base64", media_type: "image/png", data: png(8_000, 8_000) };
  const body = screenshotTurn(large);
  body.messages[2].content[0].content = Array.from({ length: 13 }, () => ({ type: "image", source: large }));
  const response = await send(env, body);
  assert.equal(response.status, 402, JSON.stringify(response.body));
  assert.equal(upstream.mock.callCount(), 0);
  // 13 x (286 x 286) = 1,063,348 visual tokens: the bound saturates at the window.
  assert.equal(events[0].reserved_input_tokens, opus.inputMax);
});
