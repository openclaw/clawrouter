import assert from "node:assert/strict";
import { parseArgs } from "./cli-args.mjs";
import { createSemanticsFixture, fixtureOrigin } from "./search-semantics-fixture.mjs";
import { searchSemanticsMatrix } from "./search-semantics-matrix.mjs";
import { directSearchProbe } from "./standalone-search-probe.mjs";

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log("Usage: CLAWROUTER_SEARCH_LIVE=1 node scripts/probe-search-semantics.mjs [--target direct|router] [--model SLUG]\nRequires SEARCH_SEMANTICS_CONTROL_TOKEN and OPENAI_API_KEY (direct) or CLAWROUTER_SMOKE_KEY (router). Creates/rotates/deletes one hosted synthetic run; at most 7 search calls, no inference. Router target is locked to FakeCo. Metadata-only output; nonzero for violation/inconclusive.");
  process.exit(0);
}
let fixture;
try {
  assert.ok(Object.keys(args).every(name => ["target", "model"].includes(name)), "unknown semantics option");
  assert.equal(process.env.CLAWROUTER_SEARCH_LIVE, "1", "explicit live approval required");
  const target = args.target ?? "direct", model = args.model ?? "gpt-6.1-sol";
  assert.ok(["direct", "router"].includes(target), "target must be direct or router");
  assert.ok(["gpt-6.1-sol", "gpt-6-astra"].includes(model), "model must be a campaign-qualified model");
  const key = target === "direct" ? process.env.OPENAI_API_KEY : process.env.CLAWROUTER_SMOKE_KEY;
  assert.ok(key?.trim(), "inject the selected credential");
  fixture = await createSemanticsFixture({ token: process.env.SEARCH_SEMANTICS_CONTROL_TOKEN });
  let calls = 0;
  const deadline = Date.now() + 10 * 60_000;
  const result = await searchSemanticsMatrix({ fixture, model, probe: options => {
    assert.ok(++calls <= 7 && Date.now() < deadline, "semantics call/time ceiling");
    return directSearchProbe({ ...options, key, ...(target === "router" ? { routerUrl: fixtureOrigin, headers: { "x-clawrouter-session-id": `search-semantics-${fixture.initial.id}`, "x-clawrouter-client": "search-semantics" } } : {}) });
  } });
  console.log(JSON.stringify({ target, model, ...result }));
  if (result.status !== "observed") process.exitCode = 1;
} catch {
  console.error(JSON.stringify({ status: "inconclusive", check: "semantics_probe_failed" })); process.exitCode = 1;
} finally {
  try { await fixture?.close(); } catch { console.error(JSON.stringify({ status: "inconclusive", check: "fixture_cleanup_failed" })); process.exitCode = 1; }
}
