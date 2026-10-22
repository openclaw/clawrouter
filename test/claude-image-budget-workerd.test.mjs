import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { crc32, deflateSync } from "node:zlib";
import { startWorkerdFixture } from "./helpers/workerd.mjs";

// The actual Worker in workerd, with SQL Durable Object ledgers and authority, and a
// synthetic Anthropic upstream. The pool credential is a fixture api_key grant in KV.
const router = `
import handler, { BudgetLedgerObject as RealBudgetLedger } from "./worker/index.ts";
export * from "./worker/index.ts";
export class BudgetLedgerObject extends RealBudgetLedger {
  constructor(state) { super(state); this.sqlFixture = state.storage.sql; }
  async fetch(request) {
    if (new URL(request.url).pathname === "/fixture-reservations") return Response.json([...this.sqlFixture.exec("SELECT settled, dispatch_started, reserved_micros FROM budget_reservations")]);
    return super.fetch(request);
  }
}
export default handler;`;
const upstream = `export default { async fetch(request) {
  const body = await request.json();
  if (new URL(request.url).pathname !== "/v1/messages" || request.headers.get("x-api-key") !== "fixture-pool-anthropic-key" || body.model !== "claude-opus-5-5") throw new Error("unexpected synthetic Anthropic request");
  const image = body.messages[0].content[0];
  if (image.type !== "image" || image.source.type !== "base64" || !image.source.data.startsWith("iVBORw0KGgo")) throw new Error("image was not forwarded");
  return Response.json({ type: "message", content: [{ type: "text", text: "synthetic" }], stop_reason: "end_turn", usage: { input_tokens: 2800, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 40 } });
} };`;

function png(width, height) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.alloc((width * 3 + 1) * height))), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}

test("workerd admits a budgeted Claude image turn at its visual-token bound and settles actual usage", { timeout: 60_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-claude-image-"));
  let mf;
  try {
    mf = await startWorkerdFixture(temporary, router, upstream);
    const kv = await mf.getKVNamespace("POLICY_KV", "router");
    const secret = "claude-budget-fixture-secret", limit = 3_000_000; // $3, below the old $10.56 image reservation
    await kv.put("policies/fixture", JSON.stringify({ enabled: true, generation: "g1", providers: ["anthropic"], tenantId: "fixture", monthlyBudgetMicros: limit, requestCostMicros: null, retainRequestContent: false }));
    await kv.put("credentials/fixture", JSON.stringify({ enabled: true, secretSha256: createHash("sha256").update(secret).digest("hex"), policyId: "fixture", policyGeneration: "g1" }));
    await kv.put("oauth/fixture/anthropic", JSON.stringify({ provider: "anthropic", kind: "api_key", enabled: true, credential: "fixture-pool-anthropic-key", updatedAt: "2026-01-01T00:00:00Z" }));
    await kv.put("connections/anthropic", JSON.stringify({ providerId: "anthropic", enabled: true, monthlyBudgetMicros: null }));
    const origin = await mf.ready;
    const body = { model: "anthropic/claude-opus-5-5", max_tokens: 128_000, messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: png(1920, 1080) } }, { type: "text", text: "Describe it." }] }] };
    const headers = { authorization: `Bearer clawrouter-live-fixture-${secret}` };
    const send = (payload) => fetch(new URL("/v1/messages", origin), { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(10_000) });

    const response = await send(body);
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).content[0].text, "synthetic");
    const forwarded = { ...body, model: "claude-opus-5-5" };
    const inputTokens = Buffer.byteLength(JSON.stringify(forwarded)) - body.messages[0].content[0].source.data.length + 1_024 + 69 * 39;
    const reserved = inputTokens * 4 + 128_000 * 20; // $4/M input, $20/M output
    const actual = 2_800 * 4 + 40 * 20;
    const deadline = Date.now() + 5_000;
    let usage;
    do {
      usage = await (await fetch(new URL("/v1/usage", origin), { headers, signal: AbortSignal.timeout(5_000) })).json();
      if (usage.usage.events.length) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    } while (Date.now() < deadline);
    assert.equal(usage.usage.events.length, 1);
    const [event] = usage.usage.events;
    assert.equal(event.reserved_input_tokens, inputTokens);
    assert.equal(event.reserved_cost_micros, reserved);
    assert.equal(event.actual_cost_micros, actual);
    assert.equal(usage.budget.spentMicros, actual);
    const budgets = await mf.getDurableObjectNamespace("BUDGET_LEDGER", "router");
    const ledger = budgets.get(budgets.idFromName("fixture:fixture"));
    assert.deepEqual(await (await ledger.fetch("https://budget/fixture-reservations")).json(), [{ settled: 1, dispatch_started: 1, reserved_micros: actual }]);

    // A URL image has no header to bound it: the full-window reservation still refuses it.
    const unbounded = await send({ ...body, messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url: "https://example.com/screenshot.png" } }] }] });
    assert.equal(unbounded.status, 402);
    assert.equal((await unbounded.json()).error.code, "budget_exhausted");
    assert.deepEqual(await (await ledger.fetch("https://budget/fixture-reservations")).json(), [{ settled: 1, dispatch_started: 1, reserved_micros: actual }]);
  } finally {
    await mf?.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
});
