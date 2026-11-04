import "./typescript-setup.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
const { nvidiaPublicCatalogRequests, parseNvidiaPublicCatalog, readNvidiaPublicCatalog } = await import("../nvidia-model-catalog.ts");

const ids = ["nvidia/nemotron-3-ultra-550b-a55b", "nvidia/nemotron-3.5-lightning-30b-a3b",
  "nvidia/nemotron-3.5-super-vl-120b-a12b", "moonshotai/kimi-k2.6"];
const allowed = new Set(ids), signal = () => new AbortController().signal;
const inventory = (...models) => ({ object: "list", data: models.map(id => ({ id, object: "model" })) });
const featured = (...rows) => ({ "featured-models": rows });
const row = (model = ids[0]) => ({ model, "model-name": "Synthetic recommendation", context: 1048576, "max-output": 8192 });
const invalid = e => e.status === 502 && e.code === "provider_catalog_invalid" && e.message === "NVIDIA public model catalog is invalid";

test("NVIDIA public requests pin both vendor origins and omit all inference credentials", () => {
  for (const base of ["https://integrate.api.nvidia.com/v1", "https://integrate.api.nvidia.com/v1/"]) {
    const requests = nvidiaPublicCatalogRequests(base, signal());
    assert.equal(requests.inventory.url, "https://integrate.api.nvidia.com/v1/models");
    assert.equal(requests.featured.url, "https://assets.ngc.nvidia.com/products/api-catalog/featured-models.json");
    for (const r of Object.values(requests)) {
      assert.equal(r.method, "GET"); assert.equal(r.body, null); assert.equal(r.credentials, "omit"); assert.equal(r.redirect, "manual");
      assert.deepEqual([...r.headers], [["accept", "application/json"]]);
    }
  }
});

test("NVIDIA public metadata cannot describe self-hosted NIM, proxies or another resource", () => {
  for (const base of ["https://nim.example/v1", "http://integrate.api.nvidia.com/v1", "https://integrate.api.nvidia.com:444/v1",
    "https://integrate.api.nvidia.com/v1?key=synthetic-private", "https://synthetic-private@integrate.api.nvidia.com/v1",
    "https://integrate.api.nvidia.com/v1#synthetic-private", "https://integrate.api.nvidia.com/v2", "invalid"]) {
    assert.throws(() => nvidiaPublicCatalogRequests(base, signal()), e =>
      e.status === 503 && e.code === "provider_catalog_not_supported" && !e.message.includes("synthetic-private"));
  }
});

test("NVIDIA fresh availability intersects featured ranking and frozen metadata", () => {
  const models = parseNvidiaPublicCatalog(inventory(...ids), featured(row(ids[2]), { ...row(ids[0]), context: 1000000 }), allowed);
  assert.deepEqual(models.map(m => m.id), [ids[2], ids[0], ids[1], ids[3]]);
  assert.deepEqual(models[0].input, ["text", "image", "video"]); assert.equal(models[0].reasoning, true);
  assert.equal(models[1].contextWindow, 1000000); assert.equal(models[1].metadataSource, "featured");
  assert.equal(models[2].metadataSource, "frozen"); assert.equal(models[2].outputTokenBudget, 16384);
  assert.equal(models[3].outputTokenBudget, 65536); assert.ok(models.every(m => m.pricing === null));
});

test("NVIDIA stale featured metadata cannot restore an absent model", () => {
  assert.deepEqual(parseNvidiaPublicCatalog(inventory(ids[1]), featured(row(ids[0])), allowed).map(m => m.id), [ids[1]]);
  assert.deepEqual(parseNvidiaPublicCatalog(inventory(), null, allowed), []);
  assert.deepEqual(parseNvidiaPublicCatalog(inventory(...ids), featured(), new Set()), []);
  assert.deepEqual(parseNvidiaPublicCatalog(inventory(...ids), featured(), new Set(["*"])), []);
});

test("NVIDIA inventory alone cannot promote embeddings or the deprecated seed to Chat", () => {
  const unknown = ["synthetic/embedding", "meta/llama-3.1-8b-instruct"];
  assert.deepEqual(parseNvidiaPublicCatalog(inventory(...unknown), featured(), new Set(unknown)), []);
});

test("NVIDIA explicitly permitted featured identities retain unknown facts and prices", () => {
  const id = "nvidia/synthetic-featured";
  const models = parseNvidiaPublicCatalog(inventory(id), featured({ ...row("synthetic-featured"), api_key: "synthetic-private" }), new Set([id]));
  assert.deepEqual(models, [{ id, name: "Synthetic recommendation", contextWindow: 1048576, outputTokenBudget: 8192,
    metadataSource: "featured", input: null, reasoning: null, pricing: null }]);
  assert.deepEqual(parseNvidiaPublicCatalog(inventory(id), featured(row(id)), allowed), []);
});

test("NVIDIA strict inventory rejects malformed rows, envelopes, duplicates and bounds", () => {
  for (const payload of [null, {}, { data: [] }, { object: "model", data: [] }, inventory(ids[0], ids[0]),
    { object: "list", data: [null] }, { object: "list", data: [{ id: "bad id" }] },
    { object: "list", data: [{ id: "x".repeat(201) }] }, { object: "list", data: [{ id: ids[0], object: "embedding" }] },
    { object: "list", data: Array(4097).fill({ id: "x" }) }]) {
    assert.throws(() => parseNvidiaPublicCatalog(payload, featured(), allowed), invalid);
  }
});

test("NVIDIA nonempty inventory requires usable bounded featured metadata", () => {
  for (const payload of [null, {}, { "featured-models": {} }, featured(null), featured(row(), row()),
    featured(row("synthetic"), row("nvidia/synthetic")), featured(...Array(33).fill(row())),
    featured({ ...row(), context: 10000001 }), featured({ ...row(), "max-output": 1000001 }),
    featured({ ...row(), context: 1.5 }), featured({ ...row(), "max-output": 0 }),
    featured({ ...row(), model: "bad id" }), featured({ ...row(), "model-name": "bad\nname" })]) {
    assert.throws(() => parseNvidiaPublicCatalog(inventory(ids[0]), payload, allowed), invalid);
  }
  assert.equal(parseNvidiaPublicCatalog(inventory(ids[0]), featured(null, row()), allowed).length, 1);
});

test("NVIDIA returned facts cannot mutate the frozen catalog", () => {
  const first = parseNvidiaPublicCatalog(inventory(...ids), featured(), allowed);
  first[0].input.push("video"); first[0].name = "changed";
  const second = parseNvidiaPublicCatalog(inventory(...ids), featured(), allowed);
  assert.deepEqual(second[0].input, ["text"]); assert.equal(second[0].name, "Nemotron 3 Ultra 550B");
});

test("NVIDIA bounded reader supports fragmented UTF-8 on both public resources", async () => {
  const response = payload => {
    const bytes = new TextEncoder().encode(JSON.stringify(payload)); let offset = 0;
    return new Response(new ReadableStream({ pull(c) { if (offset === bytes.length) c.close(); else c.enqueue(bytes.slice(offset, ++offset)); } }),
      { headers: { "content-type": "application/json", "content-length": String(bytes.length) } });
  };
  const result = await readNvidiaPublicCatalog(response(inventory(ids[0])), response(featured({ ...row(), "model-name": "Synthetic 模型" })), signal(), allowed);
  assert.equal(result[0].name, "Synthetic 模型");
});

test("NVIDIA empty inventory stays authoritative when featured HTTP or schema fails", async () => {
  for (const failed of [new Response("synthetic-private", { status: 403 }), Response.json({ wrong: true })]) {
    assert.deepEqual(await readNvidiaPublicCatalog(Response.json(inventory()), failed, signal(), allowed), []);
  }
});

for (const [name, failure] of [
  ["HTTP failure", () => new Response("synthetic-private", { status: 401 })],
  ["wrong MIME", () => new Response("{}", { headers: { "content-type": "text/html" } })],
  ["partial range", () => Response.json({}, { headers: { "content-range": "bytes 0-1/20" } })],
  ["truncated length", () => Response.json({}, { headers: { "content-length": "20" } })],
  ["invalid JSON", () => new Response("synthetic-private", { headers: { "content-type": "application/json" } })],
  ["invalid UTF-8", () => new Response(new Uint8Array([0xff]), { headers: { "content-type": "application/json" } })],
  ["declared oversize", () => Response.json({}, { headers: { "content-length": String(2 * 1024 * 1024 + 1) } })],
  ["streamed oversize", () => new Response(" ".repeat(2 * 1024 * 1024 + 1), { headers: { "content-type": "application/json" } })],
]) test(`NVIDIA reader rejects ${name} from either resource without disclosing content`, async () => {
  await assert.rejects(readNvidiaPublicCatalog(failure(), Response.json(featured()), signal(), allowed), invalid);
  await assert.rejects(readNvidiaPublicCatalog(Response.json(inventory(ids[0])), failure(), signal(), allowed), invalid);
});

test("NVIDIA deadline cancellation closes both resources and cannot return an empty success", async () => {
  const controller = new AbortController(); let canceled = 0;
  const response = () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"data":')); }, cancel() { canceled++; } }),
    { headers: { "content-type": "application/json" } });
  const reading = readNvidiaPublicCatalog(response(), response(), controller.signal, allowed);
  controller.abort(); await assert.rejects(reading, invalid); assert.equal(canceled, 2);
});

test("NVIDIA catalog loads without the test-only TypeScript resolver", () => {
  const output = execFileSync(process.execPath, ["--input-type=module", "--eval", 'await import("./worker/nvidia-model-catalog.ts"); process.stdout.write("loaded")'], { encoding: "utf8" });
  assert.equal(output, "loaded");
});
