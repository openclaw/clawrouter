import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { directSearchProbe } from "./standalone-search-probe.mjs";

const freshMarker = () => `ClawRouterFunnel${randomBytes(24).toString("hex")}`;
const emptyCounts = () => ({ rootGet: 0, rootHead: 0, robots: 0, rejected: 0, overflow: false });

// No HTTP control routes. Controls remain in the owning process, even though
// Funnel's reverse proxy also connects from loopback. Never retain request data.
export async function startLocalSearchFixture({ port = 18765, maxMeasurements = 1 } = {}) {
  assert.ok(maxMeasurements === 1 || maxMeasurements === 2, "fixture permits one measurement or one two-endpoint comparison");
  let marker = freshMarker(), counts = emptyCounts(), phase = "calibration";
  let witnessVerified = false, generation = 0, firstGet = null, lastGet = null, closing;
  const increment = category => {
    if (counts[category] >= 10_000) counts.overflow = true;
    else counts[category]++;
  };
  const server = createServer((req, res) => {
    res.setHeader("cache-control", "no-store, max-age=0");
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.setHeader("x-content-type-options", "nosniff");
    const readable = req.method === "GET" || req.method === "HEAD";
    if (req.url === "/" && readable) {
      increment(req.method === "GET" ? "rootGet" : "rootHead");
      if (req.method === "GET") {
        lastGet = new Date().toISOString();
        firstGet ??= lastGet;
      }
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(req.method === "HEAD" ? undefined : `<!doctype html><html><head><title>Independent search retrieval fixture</title></head><body><h1>Independent search retrieval fixture</h1><p>Current retrieval marker: ${marker}</p></body></html>`);
    } else if (req.url === "/robots.txt" && readable) {
      increment("robots");
      res.end(req.method === "HEAD" ? undefined : "User-agent: *\nAllow: /\n");
    } else {
      increment("rejected");
      res.writeHead(404).end();
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  const snapshot = () => ({ phase, generation, witnessVerified, counts: { ...counts }, firstGet, lastGet });
  return {
    port: server.address().port,
    snapshot,
    confirmWitness(value) {
      assert.equal(phase, "calibration", "external witness precedes measurement");
      assert.ok(value === marker && counts.rootGet > 0 && !counts.overflow, "external witness must return the calibration marker with an origin GET");
      witnessVerified = true;
      return { witnessVerified };
    },
    arm() {
      assert.ok(witnessVerified && (phase === "calibration" || phase === "complete") && generation < maxMeasurements, "confirm outside-tailnet witness first; measurement limit must remain");
      marker = freshMarker(); counts = emptyCounts(); firstGet = lastGet = null;
      generation++; phase = "armed";
      return snapshot();
    },
    async measure({ key, url, probe = directSearchProbe, settle = () => new Promise(resolve => setTimeout(resolve, 15_000)) }) {
      assert.equal(phase, "armed", "one search attempt per exposure");
      assert.ok(Object.entries(counts).every(([name, value]) => name === "overflow" ? !value : value === 0), "measurement requires uncontaminated counters");
      assert.equal(new URL(url).protocol, "https:", "search target must use HTTPS");
      phase = "measuring";
      const dispatchedAt = new Date().toISOString();
      let summary = null, probeFailed = false;
      try {
        const result = await probe({ key, marker, body: { id: randomUUID(), model: "gpt-6.1-sol", commands: { open: [{ ref_id: url }], response_length: "short" }, settings: { external_web_access: true } } });
        // The probe helper's summary is closed metadata. Raw output stays local.
        summary = result.summary;
      } catch { probeFailed = true; }
      const immediate = snapshot();
      await settle();
      const late = snapshot(), withinLifetime = phase === "measuring";
      if (withinLifetime) phase = "complete";
      return { dispatchedAt, finishedAt: new Date().toISOString(), probeFailed, summary, immediate, late,
        freshRetrieval: withinLifetime && !probeFailed && summary?.status === 200 && summary.markerReturned && summary.toolSuccess !== false && !summary.internalError && !summary.referenceError && !summary.fetchError && counts.rootGet > 0 && !counts.overflow };
    },
    close() {
      if (closing) return closing;
      phase = "closed";
      closing = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      server.closeAllConnections();
      return closing;
    },
  };
}
