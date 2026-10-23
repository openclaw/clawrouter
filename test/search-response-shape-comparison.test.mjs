import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { responseShapePlan, runResponseShapeComparison } from "../scripts/search-response-shape-comparison.mjs";

const execute = promisify(execFile);
const control = { output: "IANA-managed Reserved Domains: example.com. RFC 2606.", results: [{ type: "text_result" }] };
const key = "fixture-only-key";
const snapshots = async path => (await readFile(path, "utf8")).trim().split("\n").map(line => JSON.parse(line));
async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), "alpha-response-shape-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, "receipt.jsonl");
}

test("plan is fixed, defensive and requires no key, network or receipt", async () => {
  const plan = responseShapePlan();
  plan.targets[0].url = "https://unapproved.invalid/";
  assert.equal(responseShapePlan().targets[0].url, "https://www.iana.org/help/example-domains");
  const script = new URL("../scripts/search-response-shape-comparison.mjs", import.meta.url).pathname;
  for (const args of [[], ["--plan"], ["--help"]]) {
    const { stdout, stderr } = await execute(process.execPath, [script, ...args]);
    assert.equal(stderr, "");
    const result = JSON.parse(stdout);
    assert.equal(result.mode, "plan-only");
    assert.equal(result.executionAuthorized, false);
    assert.deepEqual(result.plan, responseShapePlan());
  }
  await assert.rejects(execute(process.execPath, [script, "--run-approved", "--plan"]), error => {
    assert.equal(error.code, 2);
    assert.equal(error.stdout, "");
    assert.equal(error.stderr, "unsupported arguments; use --plan\n");
    return true;
  });
});

test("approval gate and existing receipt block credentials and transport", async t => {
  const receiptPath = await setup(t);
  let reads = 0, calls = 0;
  const options = { receiptPath, readKey: async () => { reads++; return key; }, fetcher: async () => { calls++; } };
  for (const approved of [undefined, false, "true", 1]) {
    await assert.rejects(runResponseShapeComparison({ ...options, approved }), /explicit authorization/);
  }
  await assert.rejects(stat(receiptPath), { code: "ENOENT" });
  await writeFile(receiptPath, "partial prior execution\n");
  await assert.rejects(runResponseShapeComparison({ ...options, approved: true }), { code: "EEXIST" });
  assert.equal(await readFile(receiptPath, "utf8"), "partial prior execution\n");
  assert.equal(reads, 0); assert.equal(calls, 0);
});

test("two fixed opens use one key, fresh sessions and durable intents; receipt excludes content", async t => {
  const receiptPath = await setup(t);
  let reads = 0, calls = 0;
  const ids = [];
  const result = await runResponseShapeComparison({ approved: true, receiptPath,
    readKey: async () => { reads++; return key; },
    fetcher: async (url, init) => {
      const index = calls++;
      assert.ok(index < 2);
      assert.equal(url, "https://api.openai.com/v1/alpha/search");
      assert.equal(init.method, "POST"); assert.equal(init.redirect, "error");
      assert.equal(init.headers.get("authorization"), `Bearer ${key}`);
      assert.equal(init.headers.get("content-type"), "application/json");
      assert.ok(init.signal instanceof AbortSignal);
      const body = JSON.parse(init.body);
      ids.push(body.id);
      assert.match(body.id, /^[a-f\d-]{36}$/);
      assert.deepEqual(body, {
        id: body.id, model: "gpt-6.1-sol",
        commands: { open: [{ ref_id: responseShapePlan().targets[index].url }], response_length: "short" },
        settings: { external_web_access: true },
      });
      const journal = await snapshots(receiptPath);
      assert.equal(journal.at(-1).state, "dispatch-intent");
      assert.equal(journal.at(-1).attempts.length, index + 1);
      assert.equal(journal.at(-1).attempts[index].sessionId, body.id);
      if (index === 1) assert.equal(journal.at(-1).attempts[0].result.expectedContentReturned, true);
      return Response.json(index === 0 ? control : {
        output: "Internal Error private-output", encrypted_output: "private-ciphertext",
        results: [{ type: "text_result", text: "private-result" }, { type: "private-type" }, null],
        future: "private-future",
      }, { headers: { "x-request-id": index === 0 ? "req_control" : "req_fakeco" } });
    },
  });
  assert.equal(reads, 1); assert.equal(calls, 2); assert.notEqual(ids[0], ids[1]);
  assert.equal(result.stopReason, "pair-complete");
  assert.equal(result.structuredResultsWithInternalError, true);
  const fakeco = result.attempts[1].result;
  assert.equal(fakeco.toolSuccess, false);
  assert.deepEqual(fakeco.results, { state: "array", count: 3, types: { textResult: 1, unknown: 1, malformed: 1 } });
  assert.equal(fakeco.requestId, "req_fakeco");
  assert.equal(result.freshRetrievalQualified, false); assert.equal(result.upstreamAlphaBillingQualified, false);
  const journal = await snapshots(receiptPath);
  assert.deepEqual(journal.at(-1), result);
  assert.deepEqual(journal.map(entry => entry.state), ["started", "dispatch-intent", "response", "dispatch-intent", "response", "finished"]);
  assert.doesNotMatch(await readFile(receiptPath, "utf8"), /private-|fixture-only-key|IANA-managed Reserved Domains|Internal Error/);
  assert.equal((await stat(receiptPath)).mode & 0o777, 0o600);
  await assert.rejects(runResponseShapeComparison({ approved: true, receiptPath, readKey: () => assert.fail("no replay") }), { code: "EEXIST" });
});

for (const [name, response] of [
  ["HTTP failure", () => Response.json(control, { status: 403 })],
  ["internal error", () => Response.json({ ...control, output: `${control.output} Internal Error` })],
  ["reference error", () => Response.json({ ...control, output: `${control.output} Invalid ref_id` })],
  ["fetch error", () => Response.json({ ...control, output: `${control.output} Failed to fetch` })],
  ["wrong content", () => Response.json({ output: "Example Domains example.com", results: [{ type: "text_result" }] })],
  ["empty output", () => Response.json({ output: "", results: [{ type: "text_result" }] })],
  ["null response", () => Response.json(null)],
  ["non-JSON", () => new Response("private-error-body")],
  ["oversized response", () => new Response("x".repeat(2 * 1024 * 1024 + 1))],
  ["timeout", () => { throw new DOMException("private-timeout-detail", "TimeoutError"); }],
]) {
  test(`control ${name} stops before FakeCo without retry`, async t => {
    const receiptPath = await setup(t);
    let calls = 0;
    const result = await runResponseShapeComparison({ approved: true, receiptPath, readKey: async () => key,
      fetcher: async () => { assert.equal(++calls, 1); return response(); },
    });
    assert.equal(calls, 1); assert.equal(result.attempts.length, 1);
    assert.ok(["control-not-qualified", "control-request-failed"].includes(result.stopReason));
    assert.equal(result.structuredResultsWithInternalError, null);
    assert.equal((await snapshots(receiptPath)).at(-1).state, "finished");
    assert.doesNotMatch(await readFile(receiptPath, "utf8"), /private-|fixture-only-key/);
  });
}

for (const [name, extra, state, count] of [
  ["absent", {}, "absent", null], ["null", { results: null }, "null", null],
  ["empty", { results: [] }, "array", 0], ["invalid", { results: "private-invalid" }, "invalid", null],
]) {
  test(`FakeCo Internal Error preserves ${name} results state`, async t => {
    const receiptPath = await setup(t);
    let calls = 0;
    const result = await runResponseShapeComparison({ approved: true, receiptPath, readKey: async () => key,
      fetcher: async () => Response.json(++calls === 1 ? control : { output: "Internal Error", ...extra }),
    });
    assert.equal(calls, 2); assert.equal(result.stopReason, "pair-complete");
    assert.equal(result.structuredResultsWithInternalError, false);
    assert.equal(result.attempts[1].result.results.state, state);
    assert.equal(result.attempts[1].result.results.count, count);
  });
}

test("unexpected FakeCo content return still cannot qualify fresh retrieval or billing", async t => {
  const receiptPath = await setup(t);
  let calls = 0;
  const result = await runResponseShapeComparison({ approved: true, receiptPath, readKey: async () => key,
    fetcher: async () => Response.json(++calls === 1 ? { ...control, results: null } : {
      output: '{"ok":true,"environment":"fakeco","fixture":"search-semantics-v1"}', results: [],
    }),
  });
  assert.equal(calls, 2); assert.equal(result.attempts[1].result.expectedContentReturned, true);
  assert.equal(result.structuredResultsWithInternalError, null);
  assert.equal(result.freshRetrievalQualified, false); assert.equal(result.upstreamAlphaBillingQualified, false);
});

for (const failure of ["credential", "fakeco"]) {
  test(`${failure} failure records fixed category without secrets or retry`, async t => {
    const receiptPath = await setup(t);
    let calls = 0;
    const result = await runResponseShapeComparison({ approved: true, receiptPath,
      readKey: async () => { if (failure === "credential") throw new Error("private-credential-error"); return key; },
      fetcher: async () => { if (++calls === 1) return Response.json(control); throw new Error("private-provider-error"); },
    });
    assert.equal(calls, failure === "credential" ? 0 : 2);
    assert.equal(result.stopReason, `${failure === "credential" ? "credential" : "fakeco-request"}-failed`);
    assert.equal(result.structuredResultsWithInternalError, null);
    assert.doesNotMatch(await readFile(receiptPath, "utf8"), /private-|fixture-only-key/);
  });
}
