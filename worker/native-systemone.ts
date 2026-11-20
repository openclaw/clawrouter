import { readNativeJson } from "./native-json.ts";
import { nativeJsonResponse, nativeResponseLease, type NativeResponse } from "./native-response.ts";
import { decisionRecord } from "./provider-decision-wire.ts";
import { decodeSystemOneResponse, prepareSystemOneRequest } from "./provider-systemone.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import { HttpError } from "./utils.ts";

export function prepareNativeSystemOne(selection: ProxySelection): NativeResponse | undefined {
  const { provider, endpoint, model } = selection;
  const product = endpoint.request_format === "liquid.systemone" ? "liquid-ai"
    : endpoint.request_format === "typesafe.systemone" ? "typesafe" : undefined;
  if (!product) return;
  const upstream = product === "liquid-ai" ? "d1.1" : "jev-latest";
  const base = product === "liquid-ai" ? "https://api.liquid.ai/decisions/v1" : "https://api.typesafe.ai/v1";
  if (provider.id !== product || provider.base_urls.default !== base || !model
    || model.id !== `${product}/${upstream}` || model.upstream !== upstream || !model.capabilities.includes("llm.decisions")
    || selection.capability !== "llm.decisions"
    || !provider.capabilities.some(item => item.id === "llm.decisions" && item.endpoint === endpoint.id && item.methods.includes("POST"))
    || selection.method !== "POST" || endpoint.method !== "POST" || endpoint.id !== "decisions" || endpoint.path !== "/systemone"
    || endpoint.response_format !== endpoint.request_format || endpoint.upstreamPath !== undefined
    || endpoint.path_params.length || Object.keys(selection.pathParams).length || Object.keys(endpoint.query).length
    || selection.nativeQuery !== undefined || endpoint.streaming || endpoint.websocket || endpoint.lifecycle
    || endpoint.responsesLifecycle || endpoint.modelPassthrough || endpoint.requestPricing) {
    throw new HttpError(400, "invalid_native_systemone_route", "SystemOne requires the selected Liquid or TypeSafe native decision route");
  }
  let prepared;
  try {
    const body = decisionRecord(selection.body);
    if (!body || Object.hasOwn(body, "images") || Object.hasOwn(body, "assets")) throw new Error("images");
    prepared = prepareSystemOneRequest(body, upstream, product);
  } catch {
    throw new HttpError(400, "invalid_native_systemone_request", "SystemOne requires valid native text or JSON decision input");
  }
  selection.body = { ...prepared };
  return {
    origin: product === "liquid-ai" ? "https://api.liquid.ai" : "https://api.typesafe.ai",
    path: product === "liquid-ai" ? "/decisions/v1/systemone" : "/v1/systemone",
    acquire: () => nativeResponseLease(32 * 1024 * 1024),
    async read(response, signal) {
      return readNativeJson(boundedResponse(response, signal), signal, responseBytes, value => {
        const envelope = decisionRecord(value);
        if (!envelope || Object.hasOwn(envelope, "error") || !boundedJson(value)) invalidResponse();
        const decoded = decodeSystemOneResponse(value, prepared, product);
        if (!decoded) invalidResponse();
        return { response: nativeJsonResponse(decoded.response, new Response(null, { headers: {
          "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff",
        } })), usage: decoded.inspection };
      }, invalidResponse);
    },
  };
}

function invalidResponse(): never { throw new HttpError(502, "invalid_native_systemone_response", "SystemOne did not return a complete valid native decision"); }

// Operational quarantine bounds, not provider model or billing facts. The
// established 32 MiB NativeResponse lease charges 64 MiB in the shared pool.
const responseBytes = 2 * 1024 * 1024;
const responseChunks = 8192;
const responseContainers = 4096;

function boundedJson(value: unknown, depth = 0, count = { containers: 0 }): boolean {
  if (depth > 64) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ++count.containers > responseContainers) return false;
  if (Array.isArray(value)) return value.every(item => boundedJson(item, depth + 1, count));
  for (const key in value) {
    if (Object.hasOwn(value, key) && !boundedJson(Reflect.get(value, key), depth + 1, count)) return false;
  }
  return true;
}

function boundedResponse(response: Response, signal: AbortSignal): Response {
  const mime = response.headers.get("content-type"), encoding = response.headers.get("content-encoding");
  if (signal.aborted || response.status !== 200 || response.redirected || !response.body
    || !mime || !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i.test(mime.trim())
    || encoding !== null && encoding.trim().toLowerCase() !== "identity") {
    void response.body?.cancel().catch(() => undefined); invalidResponse();
  }
  let bytes = 0, chunks = 0, containers = 0, depth = 0, quoted = false, escaped = false;
  // A demand-driven counting transform retains no chunk archive. Count empty
  // chunks too; a zero-byte producer cannot evade the bounded read work.
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (++chunks > responseChunks || bytes > responseBytes) invalidResponse();
      // Bound structural allocations before JSON.parse. This is only a limit
      // scanner; readNativeJson still owns fatal UTF-8 and complete JSON syntax.
      for (const byte of chunk) {
        if (quoted) {
          if (escaped) escaped = false;
          else if (byte === 92) escaped = true;
          else if (byte === 34) quoted = false;
        } else if (byte === 34) quoted = true;
        else if (byte === 123 || byte === 91) {
          if (depth++ > 64 || ++containers > responseContainers) invalidResponse();
        } else if (byte === 125 || byte === 93) depth--;
      }
      controller.enqueue(chunk);
    },
  }), { signal });
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  return new Response(body, { status: response.status, headers });
}
