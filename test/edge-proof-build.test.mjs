import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { API } from "typescript/unstable/sync";
import { instrumentAst, eraseInstrumentation, frozenSource, materializeRuntimeDependencies, bundleCapsule } from "../scripts/edge-proof-build.mjs";
const require = createRequire(import.meta.resolve("wrangler/package.json"));
const { transform } = require("esbuild");
const blob = text => createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest("hex");
test("actual capsule dependency copies and native resolver produce stable path-clean bundles", async () => {
  const task = await mkdtemp(join(tmpdir(), "edge-proof-bundle-"));
  try {
    const receipts = [];
    for (const label of ["first", "second"]) {
      const root = join(task, label), fixture = join(root, "worker/fixtures"); await mkdir(fixture, { recursive: true });
      await writeFile(join(fixture, "edge-native-cancellation.ts"), 'import {jsonParser} from "stream-json/core/parser.js"; export {jsonParser};');
      await writeFile(join(fixture, "edge-native-upstream.ts"), 'export const value = "unchanged";');
      const inputs = await materializeRuntimeDependencies(process.cwd(), root), bundles = await bundleCapsule(root);
      assert.ok(inputs.length > 0);
      for (const input of inputs) {
        const original = await readFile(join(process.cwd(), input.path)), copied = await readFile(join(root, input.path));
        assert.deepEqual(copied, original); assert.equal(createHash("sha256").update(original).digest("hex"), input.sha256);
      }
      for (const name of ["edge", "upstream"]) {
        const output = await readFile(join(root, name + ".mjs"), "utf8");
        assert.equal(output.includes(task), false); assert.equal(output.includes(process.cwd()), false);
      }
      receipts.push({ inputs, bundles });
    }
    assert.deepEqual(receipts[0], receipts[1]);
    const outside = join(task, "outside.ts"); await writeFile(outside, "export const forbidden = true;");
    await writeFile(join(task, "second/worker/fixtures/edge-native-cancellation.ts"), `export {forbidden} from ${JSON.stringify(outside)};`);
    await assert.rejects(bundleCapsule(join(task, "second")), /bundle input escapes capsule/);
  } finally { await rm(task, { recursive: true, force: true }); }
});
test("AST instrumentation distinguishes calls from text and erases byte exactly", async () => {
  const root = await mkdtemp(join(tmpdir(), "edge-proof-ast-")); let api;
  const source = 'function transfer(response: Response) { const note = "reader.read()"; const reader=response.body!.getReader(); return new Response(new ReadableStream({async pull(c){ c.enqueue(await reader.read()); },cancel(reason){return reader.cancel(reason)}})); }\n';
  try {
    await writeFile(join(root, "input.ts"), source); await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { noResolve: true, noLib: true }, files: ["input.ts"] }));
    api = new API({ cwd: root }); using snapshot = api.updateSnapshot({ openProjects: [join(root, "tsconfig.json")] });
    const ast = snapshot.getProject(join(root, "tsconfig.json")).program.getSourceFile(join(root, "input.ts"));
    const result = instrumentAst(ast, source, blob(source));
    assert.deepEqual(result.counts, { reader: 1, response: 1, read: 1, cancel: 1 });
    assert.equal(eraseInstrumentation(result.text, result.patches), source);
    assert.throws(() => instrumentAst(ast, source + " ", blob(source)));
    assert.throws(() => eraseInstrumentation(result.text.replace("/*edge:0:start*/", ""), result.patches));
    await transform(result.text, { loader: "ts", target: "es2022" });
  } finally { api?.close(); await rm(root, { recursive: true, force: true }); }
});
test("frozen capsule refuses an alternative source before materialization", () => {
  assert.throws(() => frozenSource(process.cwd(), "0".repeat(40)), /identity mismatch/);
});
let instance = 0;
async function observer() {
  const source = await readFile(new URL("../worker/fixtures/edge-native-cancellation.ts", import.meta.url), "utf8");
  const body = source.split("// BEGIN EDGE OBSERVER\n")[1].split("// END EDGE OBSERVER")[0];
  const result = await transform(body, { loader: "ts", format: "esm", target: "es2022" });
  return import("data:text/javascript;base64," + Buffer.from(result.code + `\n// instance ${instance++}`).toString("base64"));
}
test("actual observer preserves original promise, receiver, arguments and synchronous undefined", async () => {
  const o = await observer(), request = new Request("https://edge.invalid/test"), state = o.edgeIngress(request, "unit", "https://upstream.invalid", "unit");
  const original = Promise.resolve(1);
  assert.equal(o.edgeObserve("task", request, () => original), original);
  let caught = false; try { o.edgeObserve("task", request, () => { throw undefined; }); } catch (error) { caught = true; assert.equal(error, undefined); }
  assert.equal(caught, true);
  const receipt = await o.edgeJoin(state);
  assert.equal(receipt.strict, false); assert.equal(receipt.records[1].state, "sync_throw"); assert.equal(receipt.records[1].reasonDefined, false);
});
test("actual observer joins original retirement and source tail before final snapshot", async () => {
  const o = await observer(), request = new Request("https://edge.invalid/test"), state = o.edgeIngress(request, "unit", "https://upstream.invalid", "unit");
  const response = o.edgeTransfer(new Response("ok"), request), reader = o.edgeObserve("reader", response.body, () => response.body.getReader());
  const tail = Promise.withResolvers(), retired = Promise.withResolvers();
  const value = { retired: retired.promise }, factory = function (actualReader, actualTail) { assert.equal(this, undefined); assert.equal(actualReader, reader); assert.equal(actualTail, tail.promise); return value; };
  assert.equal(o.edgeFactory(factory)(reader, tail.promise), value);
  await o.edgeObserve("read", reader, () => reader.read()); await o.edgeObserve("read", reader, () => reader.read());
  o.edgeObserve("unlock", reader, () => reader.releaseLock());
  let finished = false; const joined = o.edgeJoin(state).then(result => { finished = true; return result; });
  retired.resolve(); await Promise.resolve(); await Promise.resolve(); assert.equal(finished, false);
  tail.reject(undefined); const receipt = await joined;
  assert.equal(receipt.strict, false); assert.ok(receipt.records.some(row => row.kind === "source_tail" && row.state === "rejected" && row.reasonDefined === false));
});
test("observer overflow and missing correlation invalidate proof without changing operations", async () => {
  const o = await observer(), request = new Request("https://edge.invalid/test"), state = o.edgeIngress(request, "unit", "https://upstream.invalid", "unit");
  const original = Promise.resolve(null);
  for (let index = 0; index < 257; index++) assert.equal(o.edgeObserve("task", request, () => original), original);
  assert.equal(o.edgeObserve("task", {}, () => original), original);
  const receipt = await o.edgeJoin(state); assert.equal(receipt.overflow, true); assert.equal(receipt.invalid, true); assert.equal(receipt.strict, false); assert.equal(receipt.records.length, 256);
});
