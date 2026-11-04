import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import test from "node:test";
const { fetchPublicModelDiscovery } = await import("../public-model-discovery.ts");
const { HttpOperation } = await import("../http-operation.ts");

const nvidiaIds = ["nvidia/nemotron-3-ultra-550b-a55b", "nvidia/nemotron-3.5-lightning-30b-a3b", "moonshotai/kimi-k2.6"];
const contracts = {
  cerebras: { base: "https://api.cerebras.ai/v1", urls: ["https://api.cerebras.ai/public/v1/models"], ids: ["allowed", "denied", "outside"],
    payload: ids => ({ object: "list", data: ids.map(id => ({ id, limits: { max_context_length: 32768, max_completion_tokens: 2048 } })) }) },
  nvidia: { base: "https://integrate.api.nvidia.com/v1", urls: ["https://integrate.api.nvidia.com/v1/models", "https://assets.ngc.nvidia.com/products/api-catalog/featured-models.json"], ids: nvidiaIds,
    payload: ids => ({ object: "list", data: ids.map(id => ({ id, object: "model" })) }) },
  chutes: { base: "https://llm.chutes.ai/v1", urls: ["https://llm.chutes.ai/v1/models"], ids: ["allowed", "denied", "outside"],
    payload: ids => ({ object: "list", data: ids.map(id => ({ id, object: "model" })) }) },
  venice: { base: "https://api.venice.ai/api/v1", urls: ["https://api.venice.ai/api/v1/models?type=text"], ids: ["allowed", "denied", "outside"],
    payload: ids => ({ object: "list", type: "text", data: ids.map(id => ({ id, object: "model", type: "text" })) }) },
};
const featured = { "featured-models": [] };
const rows = result => Array.isArray(result.catalog) ? result.catalog : result.catalog.data;
function input(t, providerId, overrides = {}) {
  const contract = contracts[providerId], operation = new HttpOperation();
  t.after(() => operation.stop("complete"));
  return { providerId, operation, inferenceBaseUrl: contract.base, revalidateAccount: async () => {},
    allows: id => id !== contract.ids[1], permittedModelIds: new Set(contract.ids.slice(0, 2)), ...overrides };
}
function heldBody(onCancel) {
  return new Response(new ReadableStream({ cancel: onCancel }, { highWaterMark: 0 }), { headers: { "content-type": "application/json" } });
}
const turn = () => new Promise(resolve => setImmediate(resolve));

for (const [providerId, contract] of Object.entries(contracts)) {
  test(`${providerId} public discovery isolates canonical requests, intersects policy and preserves native result`, async t => {
    const events = [], requests = [], responses = [];
    const selected = input(t, providerId, {
      // Extra JavaScript properties must never become upstream headers or keys.
      headers: { authorization: "Bearer synthetic-private", cookie: "synthetic-private" }, credential: "synthetic-private",
      revalidateAccount: async signal => {
        assert.equal(signal, selected.operation.signal);
        events.push("authorize");
        if (requests.length === contract.urls.length) assert.ok(responses.every(response => response.bodyUsed));
      },
    });
    t.mock.method(globalThis, "fetch", async request => {
      events.push("fetch"); requests.push(request);
      assert.equal(request.method, "GET"); assert.equal(request.body, null);
      assert.equal(request.credentials, "omit"); assert.equal(request.redirect, "error");
      assert.deepEqual([...request.headers], [["accept", "application/json"]]);
      const response = Response.json(request.url === contracts.nvidia.urls[1] ? featured : contract.payload(contract.ids));
      responses.push(response); return response;
    });
    const result = await fetchPublicModelDiscovery(selected);
    assert.equal(result.providerId, providerId); assert.deepEqual(rows(result).map(row => row.id), [contract.ids[0]]);
    assert.deepEqual(requests.map(request => request.url), contract.urls);
    assert.deepEqual(events, [...contract.urls.flatMap(() => ["authorize", "fetch"]), "authorize"]);
    if (providerId === "cerebras" || providerId === "nvidia") assert.equal(result.catalog[0].pricing, null);
    if (providerId === "chutes" || providerId === "venice") assert.equal(result.catalog.object, "list");
    if (providerId === "venice") assert.equal(result.catalog.type, "text");
    assert.equal(selected.operation.signal.aborted, false);
    assert.equal(selected.operation.delivery, undefined, "the caller still owns operation completion");
    selected.operation.cancel(new Error("caller finished"));
    assert.ok(requests.every(request => request.signal.aborted));
  });

  test(`${providerId} noncanonical public catalog is rejected without authority or egress`, async t => {
    let checks = 0, fetches = 0;
    const selected = input(t, providerId, { inferenceBaseUrl: "https://foreign.example/v1", revalidateAccount: async () => { checks++; } });
    t.mock.method(globalThis, "fetch", async () => { fetches++; throw new Error("unexpected fetch"); });
    await assert.rejects(fetchPublicModelDiscovery(selected), error => error.status === 503);
    assert.equal(checks, 0); assert.equal(fetches, 0);
  });

  test(`${providerId} revocation after complete parsing withholds publication`, async t => {
    let checks = 0;
    const revoked = new Error("original owner revoked"), responses = [];
    const selected = input(t, providerId, { revalidateAccount: async () => {
      if (++checks === contract.urls.length + 1) {
        assert.ok(responses.every(response => response.bodyUsed));
        throw revoked;
      }
    } });
    t.mock.method(globalThis, "fetch", async request => {
      const response = Response.json(request.url === contracts.nvidia.urls[1] ? featured : contract.payload(contract.ids));
      responses.push(response); return response;
    });
    await assert.rejects(fetchPublicModelDiscovery(selected), error => error === revoked);
    assert.equal(checks, contract.urls.length + 1);
    assert.ok(responses.every(response => !response.body.locked));
  });

  test(`${providerId} final authorization tightens current policy before catalog publication`, async t => {
    let checks = 0, currentPolicy = new Set(contract.ids);
    const responses = [];
    const selected = input(t, providerId, { allows: id => currentPolicy.has(id), revalidateAccount: async () => {
      if (++checks === contract.urls.length + 1) {
        assert.ok(responses.every(response => response.bodyUsed));
        currentPolicy = new Set([contract.ids[1], contract.ids[2]]);
      }
    } });
    t.mock.method(globalThis, "fetch", async request => {
      const response = Response.json(request.url === contracts.nvidia.urls[1] ? featured : contract.payload(contract.ids));
      responses.push(response); return response;
    });
    const result = await fetchPublicModelDiscovery(selected);
    assert.deepEqual(rows(result).map(row => row.id), [contract.ids[1]], "removed policy ID and out-of-scope permitted ID stay excluded");
    assert.equal(checks, contract.urls.length + 1);
    if (providerId === "venice") assert.equal(result.catalog.type, "text");
  });
}

test("NVIDIA revocation between inventory and featured prevents second egress and cancels unread inventory", async t => {
  let checks = 0, fetches = 0, canceled = 0;
  const revoked = new Error("original grant changed"), inventory = heldBody(() => { canceled++; });
  const selected = input(t, "nvidia", { revalidateAccount: async () => { if (++checks === 2) throw revoked; } });
  t.mock.method(globalThis, "fetch", async () => { fetches++; return inventory; });
  await assert.rejects(fetchPublicModelDiscovery(selected), error => error === revoked);
  assert.equal(fetches, 1); assert.equal(canceled, 1); assert.equal(inventory.body.locked, false);
});

test("NVIDIA fresh empty inventory defeats featured and prior successful metadata without cache resurrection", async t => {
  let empty = false, fetches = 0;
  const selected = input(t, "nvidia");
  t.mock.method(globalThis, "fetch", async request => {
    fetches++;
    if (request.url === contracts.nvidia.urls[0]) return Response.json(contracts.nvidia.payload(empty ? [] : nvidiaIds));
    return empty ? new Response("invalid featured response", { status: 503 }) : Response.json(featured);
  });
  assert.deepEqual(rows(await fetchPublicModelDiscovery(selected)).map(row => row.id), [nvidiaIds[0]]);
  empty = true;
  assert.deepEqual((await fetchPublicModelDiscovery(selected)).catalog, []);
  assert.equal(fetches, 4);
});

test("NVIDIA nonempty inventory cannot publish after malformed featured metadata", async t => {
  let checks = 0, fetches = 0;
  const selected = input(t, "nvidia", { revalidateAccount: async () => { checks++; } });
  t.mock.method(globalThis, "fetch", async request => {
    fetches++;
    return Response.json(request.url === contracts.nvidia.urls[0] ? contracts.nvidia.payload(nvidiaIds) : { invalid: true });
  });
  await assert.rejects(fetchPublicModelDiscovery(selected));
  assert.equal(checks, 2); assert.equal(fetches, 2);
});

test("public discovery rejects canceled authorization without a fetch", async t => {
  const caller = new AbortController(), reason = new Error("caller stopped"), operation = new HttpOperation(caller.signal);
  t.after(() => operation.stop("complete"));
  let fetches = 0;
  const selected = input(t, "chutes", { operation, revalidateAccount: async () => { caller.abort(reason); } });
  t.mock.method(globalThis, "fetch", async () => { fetches++; throw new Error("unexpected fetch"); });
  await assert.rejects(fetchPublicModelDiscovery(selected), error => error === reason);
  assert.equal(fetches, 0);
});

test("NVIDIA pair shares the original deadline and discards a response arriving after abort", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const operation = new HttpOperation(undefined, 100);
  t.after(() => operation.stop("complete"));
  let resolveFeatured, fetched = 0, canceledInventory = 0, canceledFeatured = 0;
  const inventory = heldBody(() => { canceledInventory++; });
  const selected = input(t, "nvidia", { operation });
  t.mock.method(globalThis, "fetch", request => {
    fetched++;
    if (request.url === contracts.nvidia.urls[0]) { t.mock.timers.tick(60); return Promise.resolve(inventory); }
    const pending = new Promise(resolve => { resolveFeatured = resolve; });
    queueMicrotask(() => t.mock.timers.tick(40));
    return pending;
  });
  await assert.rejects(fetchPublicModelDiscovery(selected));
  assert.equal(operation.status, "timeout"); assert.equal(fetched, 2); assert.equal(canceledInventory, 1);
  const late = heldBody(() => { canceledFeatured++; });
  resolveFeatured(late); await turn();
  assert.equal(canceledFeatured, 1); assert.equal(late.body.locked, false);
});

test("public discovery cancellation closes an active bounded reader before publication", async t => {
  const caller = new AbortController(), reason = new Error("caller stopped reader"), operation = new HttpOperation(caller.signal);
  t.after(() => operation.stop("complete"));
  let canceled = 0, checks = 0;
  const response = new Response(new ReadableStream({
    pull() { queueMicrotask(() => caller.abort(reason)); }, cancel() { canceled++; },
  }, { highWaterMark: 0 }), { headers: { "content-type": "application/json" } });
  const selected = input(t, "cerebras", { operation, revalidateAccount: async () => { checks++; } });
  t.mock.method(globalThis, "fetch", async () => response);
  await assert.rejects(fetchPublicModelDiscovery(selected)); await turn();
  assert.equal(checks, 1); assert.equal(canceled, 1); assert.equal(response.body.locked, false);
});

test("NVIDIA canceled paired readers discard both bodies under the same operation", async t => {
  const caller = new AbortController(), operation = new HttpOperation(caller.signal);
  t.after(() => operation.stop("complete"));
  let pulls = 0, canceled = 0, checks = 0;
  const responses = [];
  const selected = input(t, "nvidia", { operation, revalidateAccount: async () => { checks++; } });
  t.mock.method(globalThis, "fetch", async () => {
    const response = new Response(new ReadableStream({
      pull() { if (++pulls === 2) caller.abort(new Error("stop paired readers")); }, cancel() { canceled++; },
    }, { highWaterMark: 0 }), { headers: { "content-type": "application/json" } });
    responses.push(response); return response;
  });
  await assert.rejects(fetchPublicModelDiscovery(selected)); await turn();
  assert.equal(checks, 2); assert.equal(canceled, 2); assert.ok(responses.every(response => !response.body.locked));
});

test("public discovery failure does not retry with a different credential, origin or cached result", async t => {
  let fetches = 0;
  const selected = input(t, "venice");
  t.mock.method(globalThis, "fetch", async () => { fetches++; return new Response("synthetic upstream rejection", { status: 401 }); });
  await assert.rejects(fetchPublicModelDiscovery(selected), error => error.status === 502 && !error.message.includes("synthetic upstream rejection"));
  assert.equal(fetches, 1);
});
