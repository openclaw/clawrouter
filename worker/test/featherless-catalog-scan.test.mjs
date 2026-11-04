import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
const { fetchFeatherlessModelCatalog: scan } = await import("../featherless-catalog-scan.ts");
const { HttpOperation } = await import("../http-operation.ts");
const { BodyLease, bodyBudgetCharged } = await import("../body-budget.ts");
const base = "https://api.featherless.ai/v1", key = "synthetic-original-featherless", MiB = 1024 * 1024;
const encode = value => new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
const turn = () => new Promise(resolve => setImmediate(resolve));
const invalid = error => error.status === 502 && error.code === "invalid_model_discovery_response";
const page = (number, total, data = []) => ({ data, pagination: { current_page: number, per_page: 100, total_items: total, total_pages: Math.ceil(total / 100) }, total });
const body = value => new Response(value instanceof Uint8Array ? value : encode(value), { headers: { "content-type": "application/json" } });
function input(t, options = {}) {
  const operation = options.operation ?? new HttpOperation();
  t.after(() => operation.stop("complete"));
  return { operation, inferenceBaseUrl: base, selectedApiKey: key, revalidateAccount: async () => {}, allows: () => true,
    permittedModelIds: new Set(["one", "two", "three"]), ...options };
}
function mockPages(t, reply) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async request => {
    calls.push(request);
    return reply(Number(new URL(request.url).searchParams.get("page")), request);
  });
  return calls;
}
function padded(number, total, bytes) {
  const value = page(number, total, [{ id: `page-${number}`, ignored: "" }]);
  value.data[0].ignored = "x".repeat(bytes - encode(value).byteLength);
  const result = encode(value); assert.equal(result.byteLength, bytes); return result;
}

test("Featherless complete scan follows short and empty advertised pages with one original key and deadline", async t => {
  const order = [], selected = input(t, { revalidateAccount: async signal => { assert.equal(signal, selected.operation.signal); order.push("auth"); } });
  const calls = mockPages(t, (n, request) => {
    order.push(`fetch-${n}`);
    assert.equal(request.url, `${base}/models?capabilities=chat&page=${n}&per_page=100`);
    assert.deepEqual([...request.headers], [["accept", "application/json"], ["authorization", `Bearer ${key}`]]);
    assert.equal(request.redirect, "error"); assert.equal(request.credentials, "omit");
    return body(page(n, 300, n === 2 ? [] : [{ id: n === 1 ? "one" : "two" }]));
  });
  assert.deepEqual(await scan(selected), { providerId: "featherless", catalog: [{ id: "one" }, { id: "two" }] });
  assert.equal(calls.length, 3);
  assert.deepEqual(order, ["auth", "fetch-1", "auth", "auth", "fetch-2", "auth", "auth", "fetch-3", "auth"]);
  assert.equal(selected.operation.delivery, undefined);
});

test("Featherless scan fixes the original key and canonical base before callbacks can mutate the input object", async t => {
  const selected = input(t, { revalidateAccount: async () => { selected.selectedApiKey = "synthetic-foreign"; selected.inferenceBaseUrl = "https://untrusted.example"; } });
  const calls = mockPages(t, (n, request) => { assert.equal(request.headers.get("authorization"), `Bearer ${key}`); return body(page(n, 200, [{ id: n === 1 ? "one" : "two" }])); });
  await scan(selected); assert.equal(calls.length, 2); assert.ok(calls.every(r => r.url.startsWith(`${base}/models?`)));
});

test("Featherless final authorization applies current policy to rows from earlier pages", async t => {
  const policy = new Set(["one", "two", "foreign"]); let checks = 0;
  const selected = input(t, { allows: id => policy.has(id), revalidateAccount: async () => { if (++checks === 4) policy.delete("one"); } });
  mockPages(t, n => body(page(n, 200, n === 1 ? [{ id: "one" }] : [{ id: "two" }, { id: "foreign" }])));
  assert.deepEqual(await scan(selected), { providerId: "featherless", catalog: [{ id: "two" }] });
});

for (const excluded of [{ status: "inactive" }, { available_on_current_plan: false }, {}]) test(`Featherless rejects cross-page duplicate IDs even when excluded by ${JSON.stringify(excluded)}`, async t => {
  const selected = input(t, { allows: () => false, permittedModelIds: new Set() });
  const calls = mockPages(t, n => body(page(n, 200, [{ id: "hidden", ...(n === 1 ? excluded : {}) }])));
  await assert.rejects(scan(selected), invalid); assert.equal(calls.length, 2);
});

for (const changed of [199, 300]) test(`Featherless denies changed advertised totals ${changed} without a partial catalog`, async t => {
  const calls = mockPages(t, n => body(page(n, n === 1 ? 200 : changed, [{ id: n === 1 ? "one" : "two" }])));
  await assert.rejects(scan(input(t)), invalid); assert.equal(calls.length, 2);
});

test("Featherless complete scan preserves observed facts without prices, plan entitlement or limit defaults", async t => {
  const raw = { id: "one", context_length: 8192, is_gated: true, features: { tool_use: true }, pricing: { prompt: "0.2" }, ignored: "synthetic-private" };
  mockPages(t, () => body(page(1, 2, [raw, { id: "two" }])));
  assert.deepEqual((await scan(input(t))).catalog, [{ id: "one", context_length: 8192, is_gated: true, features: { tool_use: true }, pricing: { prompt: "0.2" } }, { id: "two" }]);
});

for (const pages of [0, 1]) test(`Featherless empty authoritative catalog with ${pages} advertised pages does not restore seeds`, async t => {
  const value = page(1, 0); value.pagination.total_pages = pages;
  const calls = mockPages(t, () => body(value));
  assert.deepEqual(await scan(input(t)), { providerId: "featherless", catalog: [] }); assert.equal(calls.length, 1);
});

test("Featherless accepts fifty advertised pages but refuses fifty-one after the first page", async t => {
  let total = 5000;
  const calls = mockPages(t, n => body(page(n, total)));
  assert.deepEqual(await scan(input(t)), { providerId: "featherless", catalog: [] }); assert.equal(calls.length, 50);
  total = 5001;
  await assert.rejects(scan(input(t)), invalid); assert.equal(calls.length, 51);
});

test("Featherless preserves validated page numbers, row caps and strict native envelopes", async t => {
  const values = [page(2, 200), page(1, 101, Array.from({ length: 101 }, (_, i) => ({ id: `model-${i}` }))),
    { ...page(1, 1, [{ id: "one" }]), extra: true }, { data: [{ id: "one" }] },
    page(1, 2, [{ id: "one" }, { id: "one" }])];
  let next; mockPages(t, () => body(next));
  for (next of values) await assert.rejects(scan(input(t)), invalid);
});

for (const revokeAt of [2, 3, 4]) test(`Featherless original authority revocation at check ${revokeAt} prevents publication or another fetch`, async t => {
  let checks = 0; const denied = new Error("original authority revoked");
  const selected = input(t, { revalidateAccount: async () => { if (++checks === revokeAt) throw denied; } });
  const calls = mockPages(t, n => body(page(n, 200, [{ id: n === 1 ? "one" : "two" }])));
  await assert.rejects(scan(selected), error => error === denied); assert.equal(calls.length, revokeAt === 4 ? 2 : 1);
});

test("Featherless scan rejects noncanonical destinations and invalid keys before authority or fetch", async t => {
  let checks = 0; const calls = mockPages(t, () => { throw new Error("unexpected fetch"); });
  for (const options of [{ inferenceBaseUrl: "https://untrusted.example/v1" }, { inferenceBaseUrl: `${base}?page=2` }, { selectedApiKey: "" }, { selectedApiKey: "bad\nkey" }])
    await assert.rejects(scan(input(t, { ...options, revalidateAccount: async () => { checks++; } })), error => error.status === 503);
  assert.equal(checks, 0); assert.equal(calls.length, 0);
});

test("Featherless scan counts exact page and aggregate bytes without retaining page archives", async t => {
  const selected = input(t, { permittedModelIds: new Set([1, 2, 3, 4].map(n => `page-${n}`)) });
  const calls = mockPages(t, n => body(padded(n, 400, 2 * MiB)));
  assert.equal((await scan(selected)).catalog.length, 4); assert.equal(calls.length, 4);
});

test("Featherless denies a page over two MiB even without a Content-Length header", async t => {
  const calls = mockPages(t, () => body(padded(1, 1, 2 * MiB + 1)));
  await assert.rejects(scan(input(t)), invalid); assert.equal(calls.length, 1);
});

test("Featherless denies aggregate wire overflow even when almost every row is policy-excluded", async t => {
  const calls = mockPages(t, n => body(padded(n, 500, 2 * MiB)));
  await assert.rejects(scan(input(t, { allows: () => false })), invalid); assert.equal(calls.length, 5);
});

for (const bytes of [4 * MiB, 4 * MiB + 1]) test(`Featherless bounds the exact ${bytes}-byte UTF-8 result including its envelope`, async t => {
  const rows = []; let size = encode({ providerId: "featherless", catalog: [] }).byteLength;
  while (bytes - size > 1530) {
    const row = { id: `model-${rows.length}-${"界".repeat(490)}` };
    size += encode(row).byteLength + (rows.length ? 1 : 0); rows.push(row);
  }
  // Keep the last ID within the existing 512-code-unit bound while hitting the
  // exact UTF-8 envelope boundary, rather than counting JavaScript characters.
  const remaining = bytes - size - 1 - encode({ id: "tail-" }).byteLength;
  const tail = { id: `tail-${"界".repeat(Math.floor(remaining / 3))}${"x".repeat(remaining % 3)}` };
  assert.ok(tail.id.length <= 512); rows.push(tail);
  assert.equal(encode({ providerId: "featherless", catalog: rows }).byteLength, bytes);
  const calls = mockPages(t, n => body(page(n, rows.length, rows.slice((n - 1) * 100, n * 100))));
  const selected = input(t, { permittedModelIds: new Set(rows.map(row => row.id)) });
  if (bytes === 4 * MiB) assert.equal(encode(await scan(selected)).byteLength, bytes);
  else await assert.rejects(scan(selected), invalid);
  assert.equal(calls.length, Math.ceil(rows.length / 100));
});

for (const emptyChunks of [8191, 8192]) test(`Featherless counts all ${emptyChunks} empty chunks toward its per-page work bound`, async t => {
  let emitted = 0, canceled = 0;
  mockPages(t, () => new Response(new ReadableStream({ pull(controller) {
    if (emitted++ < emptyChunks) controller.enqueue(new Uint8Array());
    else { controller.enqueue(encode(page(1, 0))); controller.close(); }
  }, cancel() { canceled++; } }, { highWaterMark: 0 }), { headers: { "content-type": "application/json" } }));
  if (emptyChunks === 8191) assert.deepEqual(await scan(input(t)), { providerId: "featherless", catalog: [] });
  else await assert.rejects(scan(input(t)), invalid);
  assert.ok(emitted <= 8194); assert.ok(canceled <= 1);
});

test("Featherless cancels an endless empty-chunk producer at the finite work bound", async t => {
  let emitted = 0, canceled = 0;
  mockPages(t, () => new Response(new ReadableStream({ pull(controller) { emitted++; controller.enqueue(new Uint8Array()); },
    cancel() { canceled++; } }, { highWaterMark: 0 }), { headers: { "content-type": "application/json" } }));
  await assert.rejects(scan(input(t)), invalid); await turn();
  assert.ok(emitted <= 8194); assert.equal(canceled, 1);
});

test("Featherless caller abort closes the active counting reader and does not publish", async t => {
  const caller = new AbortController(), operation = new HttpOperation(caller.signal); let canceled = 0;
  const calls = mockPages(t, () => new Response(new ReadableStream({
    pull() { queueMicrotask(() => caller.abort(new Error("caller stopped"))); }, cancel() { canceled++; },
  }, { highWaterMark: 0 }), { headers: { "content-type": "application/json" } }));
  await assert.rejects(scan(input(t, { operation }))); await turn();
  assert.equal(calls.length, 1); assert.equal(canceled, 1); assert.equal(operation.delivery, "canceled");
});

test("Featherless pages share the original deadline and discard a late response", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const operation = new HttpOperation(undefined, 100); let late, canceled = 0;
  const calls = mockPages(t, n => {
    if (n === 1) { t.mock.timers.tick(60); return body(page(1, 200, [{ id: "one" }])); }
    const pending = new Promise(resolve => { late = resolve; }); queueMicrotask(() => t.mock.timers.tick(40)); return pending;
  });
  await assert.rejects(scan(input(t, { operation }))); assert.equal(operation.status, "timeout"); assert.equal(calls.length, 2);
  const response = new Response(new ReadableStream({ cancel() { canceled++; } }), { headers: { "content-type": "application/json" } });
  late(response); await turn(); assert.equal(canceled, 1); assert.equal(response.body.locked, false);
});

test("Featherless scan preserves caller capacity ownership through result serialization", async t => {
  const lease = new BodyLease(), before = bodyBudgetCharged(); t.after(() => lease.release()); assert.equal(lease.grow(32 * MiB), true);
  mockPages(t, () => body(page(1, 1, [{ id: "one" }])));
  const selected = input(t), result = await scan(selected);
  assert.equal(bodyBudgetCharged(), before + 64 * MiB); assert.equal(selected.operation.delivery, undefined);
  assert.equal(JSON.parse(JSON.stringify(result)).catalog[0].id, "one"); assert.equal(bodyBudgetCharged(), before + 64 * MiB);
});

test("Featherless HTTP, MIME, redirect, truncated JSON and UTF-8 failures never return partial data or retry", async t => {
  const failures = [() => new Response("synthetic-private", { status: 503 }),
    () => new Response("{}", { headers: { "content-type": "text/plain" } }),
    () => { const r = body(page(1, 0)); r.headers.set("content-range", "bytes 0-4/10"); return r; },
    () => { const r = body(page(1, 0)); r.headers.set("content-length", "1"); return r; },
    () => { const r = body(page(1, 0)); Object.defineProperty(r, "redirected", { value: true }); return r; },
    () => body('{"data":['), () => body(new Uint8Array([0xff]))];
  let next; const calls = mockPages(t, () => next());
  for (next of failures) await assert.rejects(scan(input(t)), error => invalid(error) && !error.message.includes("synthetic-private"));
  assert.equal(calls.length, failures.length);
});

test("Featherless scan helper has qualified native Node runtime import suffixes", () => {
  const url = new URL("../featherless-catalog-scan.ts", import.meta.url).href;
  assert.equal(execFileSync(process.execPath, ["--experimental-transform-types", "--input-type=module", "-e",
    `const m = await import(${JSON.stringify(url)}); if (typeof m.fetchFeatherlessModelCatalog !== "function") throw new Error("missing scan");`], { encoding: "utf8" }), "");
});
