import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { boundedText, liveUpstream } from "./smoke-codex-search-upstream.mjs";

export function deployedSearchOptions(args, env = process.env) {
  let origin;
  try { origin = new URL(args["router-url"]); } catch { throw new Error("--router-url must be a router origin"); }
  assert.ok(!origin.username && !origin.password && !origin.search && !origin.hash && origin.pathname === "/", "router URL must be an origin without credentials, path, or query");
  assert.ok(origin.protocol === "https:" || origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname), "router URL must use HTTPS except loopback fixtures");
  assert.ok(typeof args["expected-environment"] === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(args["expected-environment"]), "--expected-environment is required for deployed smoke");
  assert.ok(/^clawrouter-live-[a-zA-Z0-9_-]+-[a-zA-Z0-9_-]+$/.test(env.CLAWROUTER_SMOKE_KEY ?? ""), "inject a dedicated CLAWROUTER_SMOKE_KEY");
  const number = (name, fallback) => {
    const value = String(args[name] ?? fallback);
    assert.ok(/^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value)), `--${name} must be a positive safe integer`);
    return Number(value);
  };
  return { routerUrl: origin.origin, key: env.CLAWROUTER_SMOKE_KEY, environment: args["expected-environment"], searchCostMicros: number("search-cost-micros", 1000), maxBudgetMicros: number("max-budget-micros", 5_000_000) };
}

// Parent-process relay: the isolated native client sees only a synthetic key.
// No upstream secret is needed. No fixture-only SQL route is exposed remotely.
export function deployedSearch({ routerUrl, key, environment, searchCostMicros, maxBudgetMicros, models, mode, transport, clientKey, probe, fetcher = fetch, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const sessionId = `codex-search-smoke-${randomUUID()}`;
  const live = liveUpstream({ key, models, mode, transport, routerUrl, sessionId, probe });
  let baseline, failure;
  async function read(path, authenticated = true) {
    const response = await fetcher(new URL(path, routerUrl), { headers: authenticated ? { authorization: `Bearer ${key}` } : {}, redirect: "error", signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, 200, "deployed metadata request succeeds");
    assert.equal(response.headers.get("content-type")?.split(";")[0], "application/json", "deployed metadata is JSON");
    try { return JSON.parse(await boundedText(response, 16 * 1024 * 1024)); }
    catch { throw new Error("deployed metadata is invalid or too large"); }
  }
  async function preflight() {
    const health = await read("/v1/health", false);
    assert.equal(health.environment, environment, "deployed environment matches the selected target");
    assert.equal(health.ok, true);
    assert.equal(health.observability?.requestContentRetentionDefault, false, "deployed retention defaults off");
    const inspection = await read("/v1/key/inspect");
    assert.equal(inspection.verified, true, "dedicated smoke key verifies");
    assert.deepEqual(inspection.providers, ["openai"], "dedicated key is scoped to OpenAI");
    assert.equal(inspection.budgetScope, "policy", "deployed smoke requires a dedicated policy budget");
    assert.equal(inspection.requestCostMicros, null, "inference retains token pricing");
    assert.equal(inspection.requestCostsMicros?.["search.web"], searchCostMicros, "configured standalone request tariff matches");
    assert.ok(!Object.keys(inspection.requestCostsMicros).some(name => name.startsWith("llm.")), "inference has no fixed operation tariff");
    const budget = inspection.budget;
    assert.ok(budget?.configured && budget.ledger === "durable_object" && Number.isSafeInteger(budget.limitMicros) && budget.limitMicros > 0 && budget.limitMicros <= maxBudgetMicros, "dedicated budget is positive and within the smoke ceiling");
    assert.ok(budget.remainingMicros >= searchCostMicros, "dedicated key has remaining search budget");
    baseline = await read("/v1/usage");
    assert.ok(Array.isArray(baseline.usage?.events), "deployed usage exposes receipts");
    assert.equal(baseline.budget.windowKey, budget.windowKey);
    assert.equal(baseline.budget.limitMicros, budget.limitMicros);
    assert.equal(baseline.budget.spentMicros, baseline.usage.summary.actualCostMicros, "dedicated policy has no unsettled or unreported spend");
    return { environment, budgetLimitMicros: budget.limitMicros, searchCostMicros };
  }
  async function outbound(request) {
    const url = new URL(request.url);
    assert.equal(request.headers.get("authorization"), `Bearer ${clientKey}`, "relay accepts only the isolated client key");
    assert.ok(!url.search, "relay does not forward query parameters");
    if (request.method === "GET" && url.pathname === "/v1/catalog") return Response.json(await read("/v1/catalog"));
    assert.ok(baseline, "deployed preflight precedes native requests");
    assert.ok(["/v1/native/openai/v1/responses", "/v1/native/openai/v1/responses/compact", "/v1/native/openai/v1/alpha/search"].includes(url.pathname), "relay only forwards qualified native endpoints");
    const websocket = request.headers.get("upgrade") === "websocket";
    assert.equal(request.method, websocket ? "GET" : "POST", "relay request method");
    // The transport adapter owns the request ceiling, output cap, error latch,
    // native mode/reference checks, and strict no-HTTP-fallback WS check.
    return live.outbound(new Request(`https://api.openai.com${url.pathname.slice("/v1/native/openai".length)}`, { method: request.method, headers: request.headers, ...(!websocket ? { body: await boundedText(request) } : {}) }));
  }
  async function accounting(timeoutMs = 60_000) {
    assert.ok(baseline, "deployed preflight captured a usage baseline");
    const deadline = now() + timeoutMs;
    let usage, events;
    do {
      usage = await read("/v1/usage");
      events = usage.usage?.events?.filter(event => event.session_id === sessionId) ?? [];
      if (events.length >= live.calls.length && usage.budget?.spentMicros - baseline.budget.spentMicros === events.reduce((sum, event) => sum + event.actual_cost_micros, 0)) break;
      await sleep(Math.min(1000, Math.max(0, deadline - now())));
    } while (now() < deadline);
    assert.equal(events.length, live.calls.length, "one deployed usage receipt per routed operation; do not repeat paid requests on reporting delay");
    assert.equal(new Set(events.map(event => event.request_id)).size, events.length, "deployed receipts have unique request IDs");
    const searches = live.calls.filter(call => call.commands).length;
    assert.equal(events.filter(event => event.capability === "search.web").length, searches);
    for (const event of events) {
      assert.equal(event.status, "success"); assert.equal(event.status_code, 200);
      assert.equal(event.provider, "openai"); assert.ok(models.includes(event.model?.replace(/^openai\//, "")));
      assert.equal(event.content_retained, false, "deployed request content was not retained");
      assert.ok(typeof event.request_id === "string" && event.request_id.length > 0);
      assert.ok(Number.isSafeInteger(event.actual_cost_micros) && event.actual_cost_micros >= 0);
      if (event.capability === "search.web") {
        assert.equal(event.cost_basis, "policy_fixed"); assert.equal(event.reserved_cost_micros, searchCostMicros);
        assert.equal(event.actual_cost_micros, searchCostMicros); assert.equal(event.input_tokens, null);
      } else {
        assert.equal(event.capability, "llm.responses"); assert.equal(event.cost_basis, "manifest_pricing");
        assert.ok(Number.isSafeInteger(event.input_tokens) && event.input_tokens >= 0);
      }
    }
    const spent = events.reduce((sum, event) => sum + event.actual_cost_micros, 0);
    assert.equal(usage.budget.windowKey, baseline.budget.windowKey, "canary stays in one budget window");
    assert.equal(usage.budget.limitMicros, baseline.budget.limitMicros, "budget limit stays unchanged");
    assert.equal(usage.budget.spentMicros - baseline.budget.spentMicros, spent, "policy authority spend matches the receipts");
    assert.equal(usage.usage.summary.actualCostMicros - baseline.usage.summary.actualCostMicros, spent, "reported policy spend matches the receipts");
    assert.equal(usage.usage.summary.requestCount - baseline.usage.summary.requestCount, events.length, "dedicated policy has no concurrent traffic");
    return { receipts: events.length, searches, searchCostMicros: searches * searchCostMicros, inferenceCostMicros: spent - searches * searchCostMicros, totalCostMicros: spent, policyBudgetAgrees: true, providerLedgerInspected: false };
  }
  return { ...live, get firstReference() { return live.firstReference; }, get searchNamespace() { return live.searchNamespace; }, outbound: async request => {
    try { return await outbound(request); }
    catch (error) { failure ??= error; throw error; }
  }, check() { if (failure) throw failure; live.check(); }, preflight, accounting };
}
