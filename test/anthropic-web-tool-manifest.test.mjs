import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parse, stringify } from "yaml";

const original = parse(readFileSync(new URL("../providers/anthropic.provider.yaml", import.meta.url), "utf8"));

test("compiler binds the Claude search tariff only to a Messages generation endpoint", t => {
  const root = mkdtempSync(join(tmpdir(), "clawrouter-claude-tariff-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  function compile(mutate = () => {}) {
    const manifest = structuredClone(original); mutate(manifest);
    const input = join(root, "provider.yaml"); writeFileSync(input, stringify(manifest));
    return spawnSync(process.execPath, ["scripts/compile-providers.mjs", input], { encoding: "utf8" });
  }
  const valid = compile(); assert.equal(valid.status, 0, valid.stderr);
  const provider = JSON.parse(valid.stdout).providers[0];
  assert.deepEqual(provider.endpoints.find(endpoint => endpoint.id === "messages").toolPricing, original.endpoints.messages.toolPricing);
  assert.equal(provider.endpoints.find(endpoint => endpoint.id === "count_tokens").toolPricing, undefined);
  for (const mutate of [
    manifest => { manifest.endpoints.messages.method = "GET"; },
    manifest => { manifest.endpoints.messages.responseFormat = "openai.responses"; },
    manifest => { manifest.endpoints.count_tokens.toolPricing = manifest.endpoints.messages.toolPricing; delete manifest.endpoints.messages.toolPricing; },
    manifest => { manifest.endpoints.messages.toolPricing.previewMicrosPerCallByModel = { "claude-opus-5-5": 10000 }; },
  ]) {
    const result = compile(mutate); assert.notEqual(result.status, 0, "invalid tariff endpoint must not compile");
    assert.match(result.stderr, /toolPricing|schema validation/);
  }
});
