import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { getStaticTOMLValue, parseTOML } from "toml-eslint-parser";
import { startBundledWorkerdFixture } from "../../test/helpers/workerd.mjs";

const require = createRequire(import.meta.url);

test("maintained parser imports and flushes in the unchanged Wrangler/workerd runtime", { timeout: 180_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "clawrouter-parser-runtime-"));
  let worker;
  try {
    const wrangler = join(dirname(require.resolve("wrangler/package.json")), "bin/wrangler.js");
    const output = join(temporary, "bundle");
    const config = getStaticTOMLValue(parseTOML(await readFile("wrangler.toml", "utf8")));
    assert.equal(config.compatibility_date, "2026-06-05");
    assert.deepEqual(config.compatibility_flags, ["enable_request_signal"]);
    // Keep runtime/bundler settings, but isolate assets and omit the custom build
    // that would rewrite shared checkout files while sibling tests read them.
    delete config.build;
    config.main = resolve("worker/test/fixtures/responses-parser-runtime.ts");
    config.assets.directory = join(temporary, "assets");
    await mkdir(config.assets.directory);
    await writeFile(join(config.assets.directory, "index.html"), "parser runtime fixture");
    const configPath = join(temporary, "wrangler.json");
    await writeFile(configPath, JSON.stringify(config));
    const built = spawnSync(process.execPath, [wrangler, "deploy", "--dry-run", "--outdir", output, "--config", configPath], {
      encoding: "utf8", timeout: 120_000,
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    });
    assert.equal(built.status, 0, built.error?.message ?? `${built.stdout}\n${built.stderr}`);
    const bundle = await readFile(join(output, "responses-parser-runtime.js"), "utf8");
    // This worker exposes only the parser, without admin or proxy routes.
    worker = await startBundledWorkerdFixture(temporary, bundle, 'export default { fetch() { throw new Error("unexpected upstream request"); } };', { activate: false });
    const parse = chunks => worker.dispatchFetch("https://router.example/parser", { method: "POST", body: JSON.stringify({ chunks }) });

    const number = await parse(["1", "2"]);
    assert.equal(number.status, 200);
    assert.deepEqual((await number.json()).tokens, [
      { name: "startNumber" }, { name: "numberChunk", value: "1" },
      { name: "numberChunk", value: "2" }, { name: "endNumber" },
    ]);
    const object = await parse(['{"usage":{"input_tokens":', '3},"text":"escaped \\u', '0061"}']);
    assert.equal(object.status, 200);
    const { tokens } = await object.json();
    assert.equal(tokens.filter(token => token.name === "endObject").length, 2);
    assert.ok(tokens.some(token => token.name === "stringChunk" && token.value === "a"));
    const incomplete = await parse(['{"usage":1']);
    assert.equal(incomplete.status, 400);
    assert.deepEqual(await incomplete.json(), { error: "invalid_json" });
  } finally {
    await worker?.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
});
