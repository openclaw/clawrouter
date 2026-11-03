import type { CompiledEndpoint, CompiledProvider, ProxyRequestBody } from "./types.ts";
import { HttpOperation } from "./http-operation.ts";
import { HttpError } from "./utils.ts";

export type ResponsesControlAction = "retrieve" | "cancel" | "result";

// Control ownership is declared once on the create endpoint. It never creates
// a second model capability or a fresh inference/catalog offer.
export interface ResponsesControlMatch { create: CompiledEndpoint; action: ResponsesControlAction; protocol?: import("./managed-lifecycle-types.ts").ManagedProtocol }
export function responsesControls(provider: CompiledProvider, endpoint: CompiledEndpoint): ResponsesControlMatch[] {
  const matches: ResponsesControlMatch[] = [];
  for (const create of provider.endpoints) {
    for (const action of ["retrieve", "result", "cancel"] as const) {
      if (create.lifecycle?.[action] === endpoint.id) matches.push({ create, action, protocol: create.lifecycle.protocol });
      if (action !== "result" && create.responsesLifecycle?.[action] === endpoint.id) matches.push({ create, action });
    }
  }
  return matches;
}
export function responsesControl(provider: CompiledProvider, endpoint: CompiledEndpoint): ResponsesControlMatch | null {
  return responsesControls(provider, endpoint)[0] ?? null;
}

export function backgroundResponse(endpoint: CompiledEndpoint, body: ProxyRequestBody): boolean {
  return endpoint.request_format === "openai.responses" && !Array.isArray(body) && body.background === true;
}

// Incoming workerd requests can carry an empty stream for Content-Length: 0,
// and GET can carry bytes. Only observed EOF proves the bodyless contract.
export async function requireEmptyResponseControlBody(request: Request): Promise<void> {
  if (!request.body) { request.signal.throwIfAborted(); return; }
  const reader = request.body.getReader(), operation = new HttpOperation(request.signal, 10_000);
  let ended = false;
  try {
    for (let chunks = 0; chunks < 32; chunks++) {
      const result = await operation.wait(reader.read());
      if (result.done) { ended = true; return; }
      if (result.value.byteLength) break;
    }
    throw new HttpError(400, "invalid_response_control", "response controls require an empty body");
  } finally {
    operation.stop("complete");
    if (!ended) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

// Retrieval has a finite bodyless contract. Keep include[] multiplicity; the
// ordinary manifest query-to-record conversion intentionally is not used here.
export function responsesControlQuery(action: ResponsesControlAction, input: URLSearchParams | Record<string, unknown>): URLSearchParams {
  if (action === "result") throw new HttpError(400, "invalid_response_query", "Responses has no result control");
  const pairs: Array<[string, unknown]> = input instanceof URLSearchParams ? [...input] : Object.entries(input);
  const query = new URLSearchParams();
  const invalid = () => new HttpError(400, "invalid_response_query", "response controls accept bounded include[], stream, include_obfuscation and starting_after query values");
  for (const [name, value] of pairs) {
    if (action === "cancel") throw invalid();
    if (name === "include" || name === "include[]") {
      for (const item of Array.isArray(value) ? value : [value]) {
        if (typeof item !== "string" || !item.length || item.length > 128 || query.getAll("include[]").length >= 32) throw invalid();
        query.append("include[]", item);
      }
    } else if (name === "stream" || name === "include_obfuscation") {
      if (query.has(name) || ![true, false, "true", "false"].includes(value as string | boolean)) throw invalid();
      query.set(name, String(value));
    } else if (name === "starting_after") {
      if (typeof value !== "string" && typeof value !== "number") throw invalid();
      const text = String(value);
      if (query.has(name) || !/^\d{1,16}$/.test(text) || !Number.isSafeInteger(Number(text))) throw invalid();
      query.set(name, text);
    } else throw invalid();
  }
  if (query.toString().length > 8192) throw invalid();
  return query;
}
