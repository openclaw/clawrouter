import { createServer } from "node:http";

export function createCatalogDiagnosticHarness({ cases, safeDiagnosticRecord, failureDiagnostic,
  diagnosticTestFor, diagnosticData, diagnosticPrimitive, annotationEscape, deferred }) {
  function createDiagnostics(write = line => process.stdout.write(line)) {
    let emitted = 0, suppressed = 0, sdkRecords = 0, finished = false;
    const emit = (value, summary = false) => {
      try {
        const record = safeDiagnosticRecord(value); if (!record) return false;
        if (record.layer === "sdk") sdkRecords = Math.min(65_535, sdkRecords + 1);
        if (finished || emitted >= (summary ? 64 : 63)) { suppressed = Math.min(65_535, suppressed + 1); return true; }
        const json = JSON.stringify(record); if (Buffer.byteLength(json) > 2_048) return false;
        emitted++; write("::error title=Catalog contract diagnostic::" + annotationEscape(json) + "\n");
        return true;
      } catch { return false; } // Reporting cannot replace the original outcome.
    };
    const failure = (phase, error, caseId = "none", field = "none") => emit(failureDiagnostic("outer", diagnosticTestFor(caseId), caseId, phase, error, field));
    return { emit, failure, child(error) {
      // Do not inspect message, stdout or stderr from the buffered child.
      const base = { v: 1, layer: "outer", testId: "none", caseId: "none", phase: "sdk_process", category: "child_process", name: "unknown" };
      const code = diagnosticData(error, "code"), killed = diagnosticData(error, "killed"), signal = diagnosticData(error, "signal");
      if (typeof code === "number" && diagnosticPrimitive(code)) emit({ ...base, field: "exit_code", actual: code });
      if (typeof killed === "boolean") emit({ ...base, field: "killed", actual: killed });
      emit({ ...base, field: "sdk_records", actual: sdkRecords, ...(["SIGTERM", "SIGKILL"].includes(signal) ? { code: signal } : {}) });
      // Zero reports establishes only that no structured record arrived.
    }, finish() {
      if (finished) return;
      if (suppressed) emit({ v: 1, layer: "outer", testId: "none", caseId: "none", phase: "relay", category: "limit", name: "unknown", field: "suppressed", actual: suppressed }, true);
      finished = true;
    } };
  }
  async function receiveDiagnostic(request, response, diagnostics) {
    try {
      if (request.method !== "POST" || request.headers.authorization || request.headers["content-type"] !== "application/json") {
        request.resume(); response.writeHead(400); response.end(); return;
      }
      const chunks = []; let bytes = 0;
      request.setTimeout(2_000, () => request.destroy());
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        bytes += chunk.length;
        if (bytes > 2_048) { request.resume(); response.writeHead(413); response.end(); return; }
        chunks.push(chunk);
      }
      request.setTimeout(0);
      const record = safeDiagnosticRecord(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (!record || record.layer !== "sdk" || !diagnostics.emit(record)) { response.writeHead(400); response.end(); return; }
      response.writeHead(204); response.end();
    } catch { if (!response.headersSent) response.writeHead(400); response.end(); }
    finally { request.setTimeout(0); }
  }
  async function barriers(diagnostics = createDiagnostics()) {
    const states = new Map(cases.filter(row => row.scenario === "abort").map(row => [row.id, { seen: deferred(), response: undefined, released: false }]));
    const server = createServer(async (request, response) => {
      if (request.url === "/diagnostic") { await receiveDiagnostic(request, response, diagnostics); return; }
      const match = /^\/(hold|seen|release)\/([a-z_]+)$/.exec(request.url ?? "");
      const state = match && states.get(match[2]);
      if (!state || request.headers.authorization || request.method !== (match[1] === "release" ? "POST" : "GET")) {
        response.writeHead(400); response.end(); return;
      }
      if (match[1] === "hold") {
        if (state.response) { response.writeHead(409); response.end(); return; }
        state.response = response; state.seen.resolve();
        if (state.released) response.end("released");
      } else if (match[1] === "seen") {
        await state.seen.promise; response.end("seen");
      } else {
        state.released = true; state.response?.end("released"); response.end("released");
      }
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    return { origin: `http://127.0.0.1:${server.address().port}`, releaseAll() {
      for (const state of states.values()) { state.released = true; state.response?.end("released"); }
    }, async close() {
      for (const state of states.values()) { state.released = true; state.response?.end("teardown"); }
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    } };
  }
  return { createDiagnostics, barriers };
}
