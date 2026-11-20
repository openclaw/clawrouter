import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
const fail = (message) => { throw new Error(message); };
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const identifier = (value) => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,127}$/.test(value);

function fields(value, names, location) {
  if (!object(value) || Object.keys(value).some((key) => !names.includes(key)) || names.some((key) => !Object.hasOwn(value, key))) fail(`Invalid ${location} fields`);
}

/** Analyze already graded, held-out runs. Never invokes a model or reads prompt content. */
export function evaluateFusion(input, baseline, expectedSplit = 'test') {
  fields(input, ["version", "evaluationId", "datasetRevision", "graderRevision", "split", "records"], "evaluation");
  if (!['test', 'development'].includes(expectedSplit) || input.version !== 1 || input.split !== expectedSplit)
    fail(expectedSplit === 'test' ? "Expected version 1 and held-out test split" : "Expected version 1 and explicit development split");
  if (![input.evaluationId, input.datasetRevision, input.graderRevision].every(identifier)) fail("Invalid evaluation provenance");
  if (!Array.isArray(input.records) || input.records.length < 2 || input.records.length > 50_000) fail("Expected 2 to 50000 run records");
  const strategies = new Map(), pairs = new Map(), caseDomains = new Map();
  let totalCost = 0;
  for (const row of input.records) {
    fields(row, ["caseId", "domain", "trial", "strategy", "configurationId", "score", "costMicros", "latencyMs", "callCount", "status"], "run");
    if (![row.caseId, row.domain, row.strategy, row.configurationId].every(identifier)) fail("Invalid run identifiers");
    if (!Number.isSafeInteger(row.trial) || row.trial < 1) fail("Invalid trial");
    if (!["completed", "error"].includes(row.status)) fail("Invalid run status");
    if (!Number.isFinite(row.score) || row.score < 0 || row.score > 1 || (row.status === "error" && row.score !== 0)) fail("Invalid run score; errors must score zero");
    if (!Number.isSafeInteger(row.costMicros) || row.costMicros < 0) fail("Invalid total run cost");
    if (!Number.isFinite(row.latencyMs) || row.latencyMs < 0 || row.latencyMs > Number.MAX_SAFE_INTEGER) fail("Invalid end-to-end latency");
    if (!Number.isSafeInteger(row.callCount) || row.callCount < 0) fail("Invalid total call count");
    totalCost += row.costMicros;
    if (!Number.isSafeInteger(totalCost)) fail("Total cost exceeds safe integer precision");
    if (caseDomains.has(row.caseId) && caseDomains.get(row.caseId) !== row.domain) fail("A case cannot change domains");
    caseDomains.set(row.caseId, row.domain);
    if (!strategies.has(row.strategy)) strategies.set(row.strategy, { configurationId: row.configurationId, rows: [] });
    const strategy = strategies.get(row.strategy);
    if (strategy.configurationId !== row.configurationId) fail("A strategy cannot mix configurations");
    strategy.rows.push(row);
    const key = JSON.stringify([row.caseId, row.trial]);
    if (!pairs.has(key)) pairs.set(key, new Map());
    if (pairs.get(key).has(row.strategy)) fail("Duplicate case/trial/strategy");
    pairs.get(key).set(row.strategy, row);
  }
  if (strategies.size < 2 || !strategies.has(baseline)) fail("Expected a known baseline and at least one comparison");
  if ([...pairs.values()].some((pair) => pair.size !== strategies.size)) fail("Incomplete paired runs; record failed attempts instead of dropping them");
  const caseGroups = (rows) => {
    const groups = new Map();
    for (const row of rows) {
      if (!groups.has(row.caseId)) groups.set(row.caseId, []);
      groups.get(row.caseId).push(row);
    }
    return [...groups.values()];
  };
  const caseMean = (rows, field) => mean(caseGroups(rows).map((group) => mean(group.map((row) => row[field]))));
  const results = [...strategies].map(([id, { configurationId, rows }]) => {
    const domains = [...new Set(rows.map((row) => row.domain))].sort().map((domain) => {
      const domainRows = rows.filter((row) => row.domain === domain);
      return { domain, cases: caseGroups(domainRows).length, meanScore: caseMean(domainRows, "score") };
    });
    return {
      strategy: id, configurationId, runs: rows.length, cases: caseGroups(rows).length,
      meanScore: caseMean(rows, "score"), worstDomainScore: Math.min(...domains.map((domain) => domain.meanScore)),
      errorRate: rows.filter((row) => row.status === "error").length / rows.length,
      totalCostMicros: rows.reduce((sum, row) => sum + row.costMicros, 0),
      meanCostMicros: caseMean(rows, "costMicros"), meanCallCount: caseMean(rows, "callCount"),
      meanLatencyMs: caseMean(rows, "latencyMs"),
      p50LatencyMs: percentile(rows.map((row) => row.latencyMs), 0.5),
      p95LatencyMs: percentile(rows.map((row) => row.latencyMs), 0.95), domains,
    };
  });
  const comparisons = [...strategies.keys()].filter((id) => id !== baseline).map((strategy) => {
    const differences = new Map();
    for (const pair of pairs.values()) {
      const row = pair.get(strategy), base = pair.get(baseline);
      if (!differences.has(row.caseId)) differences.set(row.caseId, []);
      differences.get(row.caseId).push(row.score - base.score);
    }
    const deltas = [...differences.values()].map(mean);
    return {
      strategy, baseline, cases: deltas.length, meanScoreDelta: mean(deltas),
      wins: deltas.filter((delta) => delta > 0).length,
      ties: deltas.filter((delta) => delta === 0).length,
      losses: deltas.filter((delta) => delta < 0).length,
      // A single case cannot establish uncertainty; report unknown, never [delta, delta].
      scoreDelta95: deltas.length < 2 ? null : bootstrapInterval(deltas),
    };
  });
  return {
    version: 1, evaluationId: input.evaluationId, datasetRevision: input.datasetRevision,
    graderRevision: input.graderRevision, split: input.split, baseline,
    weighting: "equal case; trials averaged within case", strategies: results, comparisons,
  };
}

function bootstrapInterval(deltas) {
  let seed = 42;
  const random = () => { seed = (Math.imul(1664525, seed) + 1013904223) >>> 0; return seed / 4294967296; };
  const samples = Array.from({ length: 2000 }, () => {
    let total = 0;
    for (let i = 0; i < deltas.length; i++) total += deltas[Math.floor(random() * deltas.length)];
    return total / deltas.length;
  });
  return { low: percentile(samples, 0.025), high: percentile(samples, 0.975), method: "paired case bootstrap", samples: 2000, seed: 42 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [file, flag, baseline, ...extra] = process.argv.slice(2);
    if (!file || flag !== "--baseline" || !baseline || (extra.length && (extra.length !== 1 || extra[0] !== '--development'))) fail("Usage: node scripts/evaluate-fusion.mjs <runs.json> --baseline <strategy> [--development]");
    if (statSync(file).size > 16 * 1024 * 1024) fail("Evaluation file exceeds 16 MiB");
    const input = JSON.parse(readFileSync(file, "utf8"));
    process.stdout.write(JSON.stringify(evaluateFusion(input, baseline, extra.length ? 'development' : 'test'), null, 2) + "\n");
  } catch (error) {
    // JSON parser and filesystem errors can echo private content or paths.
    process.stderr.write(error instanceof SyntaxError ? "Invalid evaluation JSON\n" : error?.code ? "Cannot read evaluation file\n" : `${error.message}\n`);
    process.exitCode = 1;
  }
}
