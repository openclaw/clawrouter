import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "./cli-args.mjs";
import { startSearchOrigin } from "./smoke-codex-search-origin.mjs";
import { directSearchProbe } from "./standalone-search-probe.mjs";

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log("Usage: CLAWROUTER_SEARCH_LIVE=1 node scripts/probe-codex-search.mjs [--model SLUG]\nTen direct alpha/search operations, no inference. Requires injected OPENAI_API_KEY and cloudflared. Logs metadata only.");
  process.exit(0);
}
assert.ok(Object.keys(args).every(name => name === "model"), "unknown probe option");
const model = args.model ?? "gpt-6.1-sol";
assert.ok(typeof model === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(model));
assert.equal(process.env.CLAWROUTER_SEARCH_LIVE, "1", "set CLAWROUTER_SEARCH_LIVE=1 for bounded paid API probes");
const key = process.env.OPENAI_API_KEY;
assert.ok(key?.trim(), "inject OPENAI_API_KEY through the credential helper");
const temporary = await mkdtemp(join(tmpdir(), "clawrouter-direct-search-"));
let origin;
try {
  origin = await startSearchOrigin(temporary);
  const stable = marker => `https://httpbingo.org/base64/${Buffer.from(`<html><title>Synthetic probe</title><p>${marker}</p></html>`).toString("base64url")}?content-type=text%2Fhtml`;
  // Check this established service with a different URL; do not prime either
  // unique content URL passed to search. There is no inference to decode a URL.
  const healthMarker = "ClawRouterReadiness", health = await fetch(stable(healthMarker), { redirect: "error", signal: AbortSignal.timeout(10_000) });
  assert.equal(health.status, 200); assert.ok((await health.text()).includes(healthMarker));
  const results = [];
  for (const mode of ["cached", "live"]) {
    const id = randomUUID(), settings = { external_web_access: mode === "live" };
    async function probe(kind, commands, marker) {
      const before = origin.count(), robots = origin.robots();
      const { summary, value } = await directSearchProbe({ key, body: { id, model, commands: { ...commands, response_length: "short" }, settings }, marker });
      results.push({ mode, kind, ...summary, originRequests: origin.count() - before, robotsRequests: origin.robots() - robots });
      console.log(JSON.stringify(results.at(-1)));
      return value;
    }
    const searched = await probe("search", { search_query: [{ q: "official OpenAI homepage" }] });
    const ref = searched.output?.match(/turn\d+search\d+/)?.[0];
    assert.ok(ref, "direct query returns a search reference");
    await probe("reference", { open: [{ ref_id: ref }] });
    await probe("indexed-url", { open: [{ ref_id: "https://openai.com/" }] });
    const marker = `ClawRouterProbe${randomUUID().replaceAll("-", "")}`;
    await probe("stable-synthetic-url", { open: [{ ref_id: stable(marker) }] }, marker);
    await probe("controlled-origin", { open: [{ ref_id: `${origin.url}/${mode}` }] }, origin.marker);
  }
  console.log(JSON.stringify({ completed: true, model, operations: results.length, originRequests: origin.count(), robotsRequests: origin.robots() }));
} catch (error) {
  console.error(JSON.stringify({ completed: false, category: error.name, check: error instanceof assert.AssertionError ? error.message.split("\n")[0] : "direct_probe_failed" }));
  process.exitCode = 1;
} finally {
  await origin?.close(); await rm(temporary, { recursive: true, force: true });
}
