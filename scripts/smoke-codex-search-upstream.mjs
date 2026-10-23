import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { assertSearchToolSuccess, directSearchProbe } from "./standalone-search-probe.mjs";
const require = createRequire(import.meta.resolve("wrangler/package.json"));
const { Response: WorkerResponse, WebSocketPair } = require("miniflare");
const NodeWebSocket = require("ws");
const digest = value => createHash("sha256").update(value).digest("hex");
export async function boundedText(response, limit = 2 * 1024 * 1024) {
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) { bytes += chunk.length; if (bytes > limit) throw new Error("live fixture response limit exceeded"); chunks.push(chunk); }
  return Buffer.concat(chunks).toString("utf8");
}
// Explicit live harness only. Never expose the real credential to the Worker,
// native client, diagnostic output, or filesystem.
export function liveUpstream({ key, models, mode, transport, probe = {} }) {
  const calls = [], sessions = new Set(), sockets = new Set();
  let attempts = 0, firstReference, searchNamespace, failure, originRequest;
  function entry(model, path, extra = {}) {
    assert.ok(++attempts <= 32, "live qualification request ceiling");
    assert.ok(models.includes(model), "upstream uses an allowed qualification model");
    const call = { model, path, ...extra, status: null }; calls.push(call); return call;
  }
  function report(call) { console.error(JSON.stringify({ phase: "upstream", ...call })); }
  async function outbound(request) {
    const url = new URL(request.url);
    assert.equal(url.origin, "https://api.openai.com");
    const headers = new Headers(request.headers); headers.set("authorization", `Bearer ${key}`);
    headers.delete("content-length"); headers.delete("host");
    if (request.headers.get("upgrade") === "websocket") {
      assert.equal(transport, "websocket"); assert.equal(url.pathname, "/v1/responses");
      const ws = new NodeWebSocket("wss://api.openai.com/v1/responses", { headers: Object.fromEntries(headers), handshakeTimeout: 15000, maxPayload: 2 * 1024 * 1024 });
      sockets.add(ws);
      await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", () => reject(new Error("live WebSocket handshake failed"))); });
      const pair = new WebSocketPair(); pair[1].accept();
      const pending = [];
      const timer = setTimeout(() => { failure = new Error("live WebSocket time limit"); ws.terminate(); }, 180000);
      pair[1].addEventListener("message", ({ data }) => {
        try {
          assert.ok(typeof data === "string" && data.length <= 2 * 1024 * 1024);
          const frame = JSON.parse(data); assert.equal(frame.type, "response.create");
          const call = entry(frame.model, url.pathname, { transport: "websocket", warmup: frame.generate === false }); pending.push(call);
          frame.max_output_tokens = Math.min(frame.max_output_tokens ?? 4096, 4096);
          ws.send(JSON.stringify(frame));
        } catch { failure = new Error("live WebSocket frame validation failed"); ws.terminate(); }
      });
      ws.on("message", (data, binary) => {
        try {
          assert.ok(!binary && data.length <= 2 * 1024 * 1024);
          const frame = JSON.parse(data.toString());
          if (["response.completed", "response.failed", "response.incomplete", "error"].includes(frame.type)) {
            const call = pending.shift(); assert.ok(call);
            call.status = frame.type === "response.completed" ? 200 : frame.status ?? 502;
            call.terminal = frame.type; report(call);
          }
          pair[1].send(data.toString());
        } catch { failure = new Error("live WebSocket response validation failed"); ws.terminate(); }
      });
      ws.on("error", () => { failure = new Error("live WebSocket transport failed"); });
      ws.on("close", (code, reason) => { clearTimeout(timer); sockets.delete(ws); try { pair[1].close(code === 1006 ? 1011 : code, reason.toString()); } catch {} });
      pair[1].addEventListener("close", () => ws.close());
      return new WorkerResponse(null, { status: 101, webSocket: pair[0] });
    }
    assert.ok(["/v1/responses", "/v1/responses/compact", "/v1/alpha/search"].includes(url.pathname));
    assert.equal(request.method, "POST");
    const body = JSON.parse(await boundedText(request)), search = url.pathname.endsWith("/search");
    if (url.pathname === "/v1/responses") assert.equal(transport, "http", "WebSocket qualification cannot silently fall back to HTTP inference");
    if (search) {
      sessions.add(body.id); searchNamespace ??= digest(body.id);
      assert.equal(body.settings?.external_web_access, mode === "live", "native search mode reaches upstream unchanged");
    }
    const call = entry(body.model, url.pathname, { transport: "http", ...(search ? { externalWebAccess: body.settings.external_web_access, commands: Object.keys(body.commands ?? {}).filter(name => name !== "response_length"), opensControlledOrigin: !!probe.url && !!body.commands?.open?.some(operation => operation.ref_id === probe.url), opensOriginalReference: !!firstReference && !!body.commands?.open?.some(operation => operation.ref_id === firstReference) } : {}) });
    if (call.opensControlledOrigin && probe.replay && !originRequest) originRequest = { body: structuredClone(body), headers: new Headers(headers) };
    if (!search && !url.pathname.endsWith("/compact")) body.max_output_tokens = Math.min(body.max_output_tokens ?? 4096, 4096);
    let response;
    try { response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(90000) }); }
    catch { throw new Error("live upstream transport failed"); }
    call.status = response.status; report(call);
    const responseHeaders = new Headers(response.headers); responseHeaders.delete("content-length"); responseHeaders.delete("content-encoding");
    if (!search) return new Response(response.body, { status: response.status, headers: responseHeaders });
    const text = await boundedText(response);
    if (response.ok) {
      const output = JSON.parse(text).output;
      if (probe.marker) {
        call.probeContentReturned = typeof output === "string" && output.includes(probe.marker);
        call.probeOutputChars = typeof output === "string" ? output.length : null;
        call.probeKeywords = ["error", "timeout", "fetch", "denied", "robots", "cache", "invalid", "unsupported", "failed", "unavailable", "not found", "safety", "untrusted", "could not", "403", "404", "500", "503"].filter(word => output.toLowerCase().includes(word));
        call.probeInternalError = typeof output === "string" && /internal error/i.test(output);
        call.probeFetchError = typeof output === "string" && /\berror\b|failed to fetch|not safe to open|blocked|robots|error fetching|403 Forbidden|404 Not Found/i.test(output);
      }
      assert.ok(typeof output === "string" && output.length, "search returns text output");
      assert.ok(!/invalid ref(?:erence|_id)|unable to resolve (?:open|find|click) call/i.test(output), "search output has no reference/tool error");
      if (!probe.marker) assertSearchToolSuccess({ output });
      firstReference ??= output.match(/turn\d+search\d+/)?.[0];
    }
    return new Response(text, { status: response.status, headers: responseHeaders });
  }
  async function replayOrigin() {
    assert.ok(originRequest, "native origin request captured for direct replay");
    const results = [];
    for (const kind of ["native-payload", "minimal-payload"]) {
      const original = originRequest.body;
      const body = kind === "native-payload" ? original : { id: original.id, model: original.model, commands: original.commands, settings: original.settings };
      const call = entry(body.model, "/v1/alpha/search", { transport: "http", directReplay: kind });
      const { summary } = await directSearchProbe({ key, body, headers: originRequest.headers, marker: probe.marker });
      Object.assign(call, summary); report(call); results.push({ kind, ...summary });
    }
    return results;
  }
  return { outbound: async request => {
    try { return await outbound(request); }
    catch (error) { failure ??= error; throw error; }
  }, replayOrigin, calls, sessions, get firstReference() { return firstReference; }, get searchNamespace() { return searchNamespace; }, check() { if (failure) throw failure; }, close() { for (const ws of sockets) ws.terminate(); } };
}
