import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { directSearchProbe } from "./standalone-search-probe.mjs";
import { directResponsesSearchProbe } from "./responses-search-probe.mjs";
import { startFunnelExperiment, loadProbeKey, runFunnelSession } from "./search-semantics-funnel.mjs";

export function comparisonOutcome(rows) {
  if (rows.length !== 2 || rows.some(row => row.measurementComplete !== true)) return "incomplete";
  const [responses, alpha] = rows.map(row => row.freshRetrieval === true);
  return responses ? (alpha ? "both-observed" : "responses-only-observed") : (alpha ? "alpha-only-observed" : "neither-observed");
}

export async function startEndpointComparison({ startExperiment = startFunnelExperiment, readKey = loadProbeKey, responsesProbe = directResponsesSearchProbe, alphaProbe = directSearchProbe, ...options } = {}) {
  let keyPromise, endpoint = "responses", attempted = false;
  const experiment = await startExperiment({ ...options, maxMeasurements: 2,
    readKey: () => keyPromise ??= readKey(),
    probe: args => endpoint === "responses" ? responsesProbe({ key: args.key, marker: args.marker, url: args.body.commands.open[0].ref_id }) : alphaProbe(args),
  });
  return {
    ...experiment,
    async measure({ approved = false } = {}) {
      assert.equal(approved, true, "comparison requires separate approval for up to two paid requests");
      assert.equal(attempted, false, "one comparison attempt per exposure");
      attempted = true;
      const rows = [];
      let stopReason = "complete", cleanup;
      try {
        assert.ok(Date.now() + 250_000 < Date.parse(experiment.expiresAt), "insufficient exposure time for the bounded pair");
        for (const name of ["responses", "alpha"]) {
          endpoint = name;
          if (name === "alpha") experiment.arm();
          const result = await experiment.measure({ approved: true });
          rows.push({ endpoint: name, ...result });
          if (!result.measurementComplete) { stopReason = "measurement-interrupted"; break; }
          if (name === "responses" && (result.probeFailed || result.summary?.status !== 200 || result.summary.toolSuccess !== true)) {
            stopReason = "responses-control-unavailable"; break;
          }
        }
      } catch { stopReason = "local-precondition-or-cancellation"; }
      finally {
        keyPromise = undefined;
        try { cleanup = await experiment.stop(); } catch { cleanup = { cleanupFailed: true }; }
      }
      return { outcome: comparisonOutcome(rows), stopReason, rows, cleanup };
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  (async () => {
    assert.deepEqual(process.argv.slice(2), ["--expose-approved"], "run only after a new public-exposure approval");
    await runFunnelSession({ start: startEndpointComparison, measureCommand: "compare-approved" });
  })().catch(() => { process.stderr.write("Endpoint comparison failed; verify Serve/Funnel status and port 18765.\n"); process.exitCode = 1; });
}
