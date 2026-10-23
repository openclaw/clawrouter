import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadProbeKey } from "./search-semantics-funnel.mjs";
import { directSearchProbe } from "./standalone-search-probe.mjs";

const endpoint = "https://api.openai.com/v1/alpha/search";
const model = "gpt-6.1-sol";
const targets = [
  { name: "control", url: "https://www.iana.org/help/example-domains" },
  { name: "fakeco", url: "https://clawrouter-fakeco.openclaw.ai/search-semantics/health" },
];
const receipt = fileURLToPath(new URL("../.artifacts/fakeco-codex-search-20261022/alpha-response-shape-comparison-execution.jsonl", import.meta.url));

export function responseShapePlan() {
  return {
    endpoint, model, targets: targets.map(target => ({ ...target })),
    callCeiling: 2, retries: 0, separateSessions: true,
    responseLength: "short", externalWebAccess: true,
    requestTimeoutMs: 90_000, responseLimitBytes: 2 * 1024 * 1024,
    fakecoRequiresPassingControl: true, executionReceipt: receipt,
    freshRetrievalQualified: false, upstreamAlphaBillingQualified: false,
  };
}

function inspect(target, { summary, value }) {
  const output = typeof value?.output === "string" ? value.output : "";
  const toolSuccess = summary.status === 200 && summary.outputChars > 0 &&
    !summary.internalError && !summary.referenceError && !summary.fetchError;
  const contentChecks = target === "control" ? {
    expectedTitle: /IANA-managed Reserved Domains|Example Domains/i.test(output),
    exampleDomain: /example\.com/i.test(output),
    rfc2606: /RFC[\s\S]{0,30}2606/i.test(output),
  } : {
    fixtureIdentity: output.includes("search-semantics-v1"),
    fakecoEnvironment: output.includes("fakeco"),
    okTrue: /["']?ok["']?\s*:\s*true/.test(output),
  };
  return { ...summary, toolSuccess, contentChecks,
    expectedContentReturned: toolSuccess && Object.values(contentChecks).every(Boolean) };
}

// Explicitly authorized execution only. The append-only, exclusive journal is
// durable before each request intent; an existing/partial journal forbids replay.
// Responses and credentials remain transient. Dependency seams are for offline tests.
export async function runResponseShapeComparison({
  approved = false, receiptPath = receipt, readKey = loadProbeKey, fetcher = fetch, openFile = open,
} = {}) {
  assert.equal(approved, true, "paid comparison requires separate explicit authorization");
  const journal = await openFile(receiptPath, "wx", 0o600);
  const record = {
    schemaVersion: 1, kind: "alpha-response-shape-comparison",
    plan: { ...responseShapePlan(), executionReceipt: receiptPath },
    startedAt: new Date().toISOString(), state: "started", attempts: [],
    stopReason: null, structuredResultsWithInternalError: null,
    freshRetrievalQualified: false, upstreamAlphaBillingQualified: false,
  };
  let stage = "journal", journalFailed = false, directorySynced = false;
  async function save() {
    try {
      await journal.writeFile(`${JSON.stringify(record)}\n`);
      await journal.sync();
      if (!directorySynced) {
        // File fsync alone need not persist a newly created pathname. Establish
        // replay protection before reading credentials or making a paid request.
        const directory = await openFile(dirname(receiptPath), "r");
        try { await directory.sync(); } finally { await directory.close(); }
        directorySynced = true;
      }
    } catch {
      journalFailed = true;
      throw new Error("comparison journal failed; preserve receipt and reconcile without replay");
    }
  }
  try {
    await save();
    stage = "credential";
    const key = await readKey();
    assert.ok(typeof key === "string" && key.trim(), "canonical key must be populated");
    for (const target of targets) {
      stage = target.name;
      const attempt = {
        target: target.name, sessionId: randomUUID(),
        dispatchIntentAt: new Date().toISOString(), completedAt: null, result: null,
      };
      record.attempts.push(attempt);
      record.state = "dispatch-intent";
      await save();
      const result = await directSearchProbe({ key, fetcher, body: {
        id: attempt.sessionId, model,
        commands: { open: [{ ref_id: target.url }], response_length: "short" },
        settings: { external_web_access: true },
      } });
      attempt.result = inspect(target.name, result);
      attempt.completedAt = new Date().toISOString();
      record.state = "response";
      await save();
      if (target.name === "control" && !attempt.result.expectedContentReturned) {
        record.stopReason = "control-not-qualified";
        break;
      }
      if (target.name === "fakeco" && attempt.result.internalError) {
        const results = attempt.result.results;
        record.structuredResultsWithInternalError = results.state === "array" && results.count > 0;
      }
    }
    record.stopReason ??= "pair-complete";
  } catch {
    if (journalFailed) throw new Error("comparison journal failed; preserve receipt and reconcile without replay");
    // Never serialize subprocess/provider error messages, bodies or stack traces.
    record.stopReason = stage === "credential" ? "credential-failed" :
      stage === "control" ? "control-request-failed" : "fakeco-request-failed";
  } finally {
    try {
      if (!journalFailed) {
        record.state = "finished";
        record.completedAt = new Date().toISOString();
        await save();
      }
    } finally { await journal.close(); }
  }
  return record;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  try {
    if (!args.length || (args.length === 1 && ["--plan", "--help"].includes(args[0]))) {
      console.log(JSON.stringify({ mode: "plan-only", executionAuthorized: false,
        plan: responseShapePlan(), usage: "--plan | --run-approved (separate approval required)" }, null, 2));
    } else if (args.length === 1 && args[0] === "--run-approved") {
      const result = await runResponseShapeComparison({ approved: true });
      console.log(JSON.stringify(result, null, 2));
      if (result.stopReason !== "pair-complete") process.exitCode = 1;
    } else {
      console.error("unsupported arguments; use --plan");
      process.exitCode = 2;
    }
  } catch {
    console.error("comparison did not finish; preserve any receipt and reconcile without replay");
    process.exitCode = 1;
  }
}
