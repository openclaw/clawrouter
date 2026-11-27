// Public synthetic upstream. No vendor API, arbitrary destinations or payload log.
type Row = { id: string; role: "eof" | "preabort" | "partial_abort" | "provider_error"; upstream: string; control: string };
type UpstreamEnv = { EDGE_PROOF_SECRET: string; EDGE_PROOF_RUN: string; EDGE_PROOF_EXPIRES: string; EDGE_PROOF_ORIGIN: string; UPSTREAM_RECORDS: DurableObjectNamespace };
type ProducerProof = { canceled: boolean; cancelSettled: boolean; timerState: "pending" | "fulfilled" | "rejected"; expired: boolean; bytes: number; signalAborted: boolean; invalid: boolean };
export function syntheticProducer(signal: AbortSignal, wait: (delay: number, options: { signal: AbortSignal }) => Promise<void>, report: (proof: ProducerProof) => Promise<void>) {
  if (signal.aborted) throw new Error("synthetic producer started after abort");
  const controller = new AbortController();
  const original = wait(10000, { signal: controller.signal });
  const state: ProducerProof = { canceled: false, cancelSettled: false, timerState: "pending", expired: false, bytes: 0, signalAborted: signal.aborted, invalid: false };
  let originalOutcome: { ok: true } | { ok: false; reason: unknown } | undefined;
  const observation = original.then(() => { state.timerState = "fulfilled"; originalOutcome = { ok: true }; }, reason => { state.timerState = "rejected"; originalOutcome = { ok: false, reason }; });
  let resolveRetired!: () => void, rejectRetired!: (error: unknown) => void;
  const retired = new Promise<void>((resolve, reject) => { resolveRetired = resolve; rejectRetired = reject; });
  void retired.catch(() => {});
  let finished = false, originalCancellation: Promise<void> | undefined;
  const finish = async () => {
    if (finished) throw new Error("duplicate producer retirement");
    finished = true;
    state.signalAborted = signal.aborted;
    await report({ ...state });
    if (state.invalid || state.expired || !state.cancelSettled) throw new Error("synthetic producer did not cancel normally");
  };
  async function cancelOriginal(reason: unknown) {
    if (state.canceled || state.expired || state.timerState !== "pending") { state.invalid = true; throw new Error("late or duplicate producer cancellation"); }
    state.canceled = true;
    const failures: unknown[] = [];
    try { controller.abort(reason); } catch (error) { failures.push(error); }
    // Join the ORIGINAL native timer, preserving its rejected disposition.
    try { await original; } catch { /* The original outcome is retained below. */ }
    await observation;
    if (!originalOutcome || originalOutcome.ok) failures.push(new Error("unexpected original timer fulfillment"));
    else if (originalOutcome.reason === undefined || originalOutcome.reason === null || typeof originalOutcome.reason !== "object") failures.push(originalOutcome.reason);
    state.invalid ||= failures.length !== 0;
    if (failures.length) throw new AggregateError(failures, "original synthetic timer cleanup failed");
  }
  const body = new ReadableStream<Uint8Array>({
    start(target) {
      const prefix = new TextEncoder().encode('data: {"id":"edge-proof","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"proof"},"finish_reason":null}]}\n\n');
      state.bytes = prefix.byteLength; target.enqueue(prefix);
      void original.then(() => {
        state.expired = true; target.error(new Error("synthetic producer expired"));
        return finish();
      }, () => {}).catch(rejectRetired);
    },
    cancel(reason) {
      const pending = Reflect.apply(cancelOriginal, this, [reason]);
      originalCancellation = pending;
      // Reporting follows settlement of that exact returned promise. It cannot
      // replace, fulfill or reject the original cancellation operation.
      void pending.then(() => { state.cancelSettled = true; return finish(); }, error => { state.invalid = true; throw error; }).then(resolveRetired, rejectRetired);
      return pending;
    },
  }, { highWaterMark: 0 });
  return { body, original, retired, state, get cancellation() { return originalCancellation; } };
}
export class UpstreamRecords {
  constructor(private state: DurableObjectState) {}
  async fetch(request: Request) {
    const action = new URL(request.url).pathname;
    if (action === "/claim") {
      const { kind } = await request.json() as { kind: string };
      if (!["catalog", "inference", "state"].includes(kind)) return new Response(null, { status: 400 });
      return this.state.storage.transaction(async storage => {
        if (await storage.get("claim/" + kind)) return new Response(null, { status: 409 });
        await storage.put("claim/" + kind, true); return new Response(null, { status: 204 });
      });
    }
    if (action === "/report") {
      const { kind, proof } = await request.json() as { kind: string; proof: unknown };
      if (await this.state.storage.get("report/" + kind)) return new Response(null, { status: 409 });
      await this.state.storage.put("report/" + kind, proof); return new Response(null, { status: 204 });
    }
    if (action === "/state") return Response.json(Object.fromEntries(await this.state.storage.list({ limit: 8 })));
    return new Response(null, { status: 404 });
  }
}
export default {
  async fetch(request: Request, env: UpstreamEnv, context: ExecutionContext) {
    const expires = Number(env.EDGE_PROOF_EXPIRES);
    if (!Number.isSafeInteger(expires) || Date.now() >= expires || expires - Date.now() > 600000 || !/^[a-f0-9]{32}$/.test(env.EDGE_PROOF_RUN) || !/^https:\/\/clawrouter-upstream-proof\.[a-z0-9-]+\.workers\.dev$/.test(env.EDGE_PROOF_ORIGIN)) return new Response(null, { status: 410 });
    const url = new URL(request.url);
    if (url.origin !== env.EDGE_PROOF_ORIGIN || url.search) return new Response(null, { status: 400 });
    let rows: Row[];
    try { rows = JSON.parse(env.EDGE_PROOF_SECRET) as Row[]; } catch { return new Response(null, { status: 503 }); }
    if (rows.length !== 8 || new Set(rows.map(row => row.id)).size !== 8 || new Set(rows.flatMap(row => [row.upstream, row.control])).size !== 16 || rows.some(row => !/^(stream|simple)_(eof|preabort|partial_abort|provider_error)$/.test(row.id) || !row.id.endsWith("_" + row.role) || !/^[a-f0-9]{64}$/.test(row.upstream) || !/^[a-f0-9]{64}$/.test(row.control))) return new Response(null, { status: 503 });
    const control = /^\/__proof\/state\/([a-z_]+)$/.exec(url.pathname);
    const row = control ? rows.find(row => row.id === control[1] && request.headers.get("authorization") === "Bearer " + row.control) : rows.find(row => request.headers.get("authorization") === "Bearer " + row.upstream);
    if (!row) return new Response(null, { status: 403 });
    const stub = env.UPSTREAM_RECORDS.get(env.UPSTREAM_RECORDS.idFromName(env.EDGE_PROOF_RUN + "/" + row.id));
    if (control) {
      if (request.method !== "POST" || request.body !== null) return new Response(null, { status: 405 });
      if ((await stub.fetch("https://proof.invalid/claim", { method: "POST", body: JSON.stringify({ kind: "state" }) })).status !== 204) return new Response(null, { status: 409 });
      return stub.fetch("https://proof.invalid/state", { method: "POST" });
    }
    const kind = url.pathname === "/models" && request.method === "GET" && request.body === null ? "catalog" : url.pathname === "/chat/completions" && request.method === "POST" ? "inference" : null;
    if (!kind || request.headers.has("x-api-key") || Number(request.headers.get("content-length") ?? 0) > 8192) return new Response(null, { status: 400 });
    if ((await stub.fetch("https://proof.invalid/claim", { method: "POST", body: JSON.stringify({ kind }) })).status !== 204) return new Response(null, { status: 409 });
    const report = async (proof: unknown) => { const result = await stub.fetch("https://proof.invalid/report", { method: "POST", body: JSON.stringify({ kind, proof }) }); if (result.status !== 204) throw new Error("upstream receipt refused"); };
    if (kind === "catalog") {
      context.waitUntil(report({ calls: 1, method: "GET", complete: true, expired: false }));
      return Response.json({ object: "list", data: [{ id: "tenant/edge-proof", object: "model" }] });
    }
    // The data body is bounded independently of Content-Length and is never logged.
    const reader = request.body!.getReader(), chunks: Uint8Array[] = []; let length = 0;
    try {
      while (true) { const next = await reader.read(); if (next.done) break; length += next.value.byteLength; if (length > 8192) { await reader.cancel(); return new Response(null, { status: 413 }); } chunks.push(next.value); }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (body.model !== "tenant/edge-proof" || body.stream !== true || !Array.isArray(body.messages) || body.messages.length > 4) return new Response(null, { status: 400 });
    if (row.role === "preabort") { context.waitUntil(report({ calls: 1, unexpected: true })); return new Response(null, { status: 409 }); }
    if (row.role === "provider_error") { context.waitUntil(report({ calls: 1, complete: true, expired: false })); return Response.json({ error: { message: "synthetic refusal", type: "fixture" } }, { status: 503 }); }
    if (row.role === "eof") {
      context.waitUntil(report({ calls: 1, complete: true, expired: false }));
      return new Response('data: {"id":"edge-proof","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"proof"},"finish_reason":null}]}\n\ndata: {"id":"edge-proof","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
    }
    const producer = syntheticProducer(request.signal, (delay, options) => scheduler.wait(delay, options), proof => report({ calls: 1, ...proof }));
    context.waitUntil(producer.retired);
    return new Response(producer.body, { headers: { "content-type": "text/event-stream" } });
  },
};
