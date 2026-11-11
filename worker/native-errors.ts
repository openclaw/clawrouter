import { beginOwnedHttpMetadataStage, admitOwnedHttpMetadata, finishOwnedHttpMetadataStage, disposeOwnedHttpLocalErrorBody, type OwnedHttpRequest } from "./http-identity-owner.ts";
import { captureOwnedResponseMetadata, measureOwnedHeaders, newOwnedHeaders, deleteOwnedHeader, setOwnedHeader, hasOwnedHeader, newOwnedResponse } from "./proxy-completion.ts";
import { identityFailure } from "./identity-admission.ts";
export type NativeErrorFormat = "openai" | "anthropic";
export interface NativeErrorContext { format: NativeErrorFormat; requestId: string }
export interface NativeErrorDetails { message?: string; type?: string; code?: string | number | null; param?: unknown; requestId?: string | null }

// Brand only router-owned errors. Never inspect or rewrite an opaque upstream
// response merely because its JSON happens to resemble a router error.
const localErrors = new WeakMap<Response, { code: string; message: string }>();
export function markLocalError(response: Response, code: string, message: string): Response {
  localErrors.set(response, { code, message });
  return response;
}

export function inheritLocalError(source: Response, copy: Response): Response {
  const error = localErrors.get(source);
  if (error) localErrors.set(copy, error);
  return copy;
}

export function nativeErrorFormat(path: string): NativeErrorFormat | undefined {
  const provider = path.match(/^\/v1\/(?:playground\/)?(?:native|proxy)\/([^/]+)\//)?.[1];
  if (provider) {
    try { const id = decodeURIComponent(provider); if (id === "anthropic" || id === "openai") return id; } catch { /* Invalid provider IDs have no native format. */ }
  }
  if (/^\/v1\/messages(?:\/|$)/.test(path)) return "anthropic";
  // Unified routes speak OpenAI's protocol even when the backend is compatible.
  const unified = path.replace(/^\/v1\/playground/, "");
  if (/^\/v1\/(?:chat\/completions|responses|decisions|embeddings|audio\/(?:speech|transcriptions)|images\/generations|realtime)(?:\/|$)/.test(unified)) return "openai";
  return undefined;
}

export function nativeErrorEnvelope(context: NativeErrorContext, status: number, details: NativeErrorDetails) {
  const message = details.message ?? "upstream request failed";
  if (context.format === "anthropic") return {
    type: "error", error: { type: details.type ?? anthropicErrorType(status), message },
    request_id: details.requestId === undefined ? context.requestId : details.requestId,
  };
  return { error: {
    message, type: details.type ?? (status >= 500 ? "server_error" : status === 429 ? "rate_limit_error" : "invalid_request_error"),
    param: details.param ?? null, code: details.code === undefined ? status : details.code,
  } };
}

function anthropicErrorType(status: number): string {
  const types: Record<number, string> = { 401: "authentication_error", 402: "billing_error", 403: "permission_error", 404: "not_found_error", 409: "conflict_error", 413: "request_too_large", 429: "rate_limit_error", 504: "timeout_error", 529: "overloaded_error" };
  return types[status] ?? (status >= 500 ? "api_error" : "invalid_request_error");
}

export function withNativeLocalError(response: Response, path: string, requestId: string): Response {
  const error = localErrors.get(response), format = nativeErrorFormat(path);
  if (!error || !format) return response;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  // Native Anthropic has no error.code. Keep router diagnostics separate from
  // its native body, just as router correlation is separate from provider IDs.
  headers.set("x-clawrouter-error-code", error.code);
  if (format === "anthropic") headers.set("request-id", requestId);
  return Response.json(nativeErrorEnvelope({ format, requestId }, response.status, error), { status: response.status, headers });
}


const ownedLocalErrorGet = WeakMap.prototype.get;
const ownedLocalErrorSet = WeakMap.prototype.set;
const ownedLocalErrorDelete = WeakMap.prototype.delete;
const ownedLocalErrorApply = Reflect.apply;
export function inheritOwnedLocalError(source: Response, copy: Response): Response {
  const error = ownedLocalErrorApply(ownedLocalErrorGet, localErrors, [source]);
  if (error) ownedLocalErrorApply(ownedLocalErrorSet, localErrors, [copy, error]);
  return copy;
}
export function clearOwnedLocalError(response: Response): void {
  // Called only by the admitted private copy's physical owner, after its last
  // formatter/metadata consumer. Original ordinary source brands are untouched.
  ownedLocalErrorApply(ownedLocalErrorDelete, localErrors, [response]);
}
// The shared format function keeps its ordinary body. Its private caller admits
// only the captured standard DATA dispatch it uses; descriptor checks never run
// a substituted accessor. No global prototype is changed for the private call.
const ownedFormatDescriptor = Object.getOwnPropertyDescriptor;
const ownedFormatString = String.prototype;
const ownedFormatRegExp = RegExp.prototype;
const ownedFormatMatch = String.prototype.match;
const ownedFormatReplace = String.prototype.replace;
const ownedFormatExec = RegExp.prototype.exec;
const ownedFormatTest = RegExp.prototype.test;
const ownedFormatMatchSymbol = Symbol.match;
const ownedFormatReplaceSymbol = Symbol.replace;
const ownedFormatRegExpMatch = RegExp.prototype[Symbol.match];
const ownedFormatRegExpReplace = RegExp.prototype[Symbol.replace];
const ownedFormatGlobal = ownedFormatDescriptor(ownedFormatRegExp, "global")!.get;
const ownedFormatDecode = decodeURIComponent;
function assertOwnedErrorFormat(): void {
  if (ownedFormatDescriptor(ownedFormatString, "match")?.value !== ownedFormatMatch
    || ownedFormatDescriptor(ownedFormatString, "replace")?.value !== ownedFormatReplace
    || ownedFormatDescriptor(ownedFormatRegExp, "exec")?.value !== ownedFormatExec
    || ownedFormatDescriptor(ownedFormatRegExp, "test")?.value !== ownedFormatTest
    || ownedFormatDescriptor(ownedFormatRegExp, ownedFormatMatchSymbol)?.value !== ownedFormatRegExpMatch
    || ownedFormatDescriptor(ownedFormatRegExp, ownedFormatReplaceSymbol)?.value !== ownedFormatRegExpReplace
    || ownedFormatDescriptor(ownedFormatRegExp, "global")?.get !== ownedFormatGlobal
    || ownedFormatDescriptor(globalThis, "decodeURIComponent")?.value !== ownedFormatDecode) throw identityFailure("protocol");
}
const ownedErrorStringify = JSON.stringify;
const ownedErrorPrototype = Object.setPrototypeOf;
const ownedErrorEncoder = TextEncoder;
const ownedErrorEncode = TextEncoder.prototype.encode;
const ownedErrorApply = Reflect.apply;
function ownedAnthropicType(status: number): string {
  // Supplying this own primitive avoids the ordinary helper's inherited numeric
  // property lookup. Envelope construction itself stays the shared algorithm.
  return status === 401 ? "authentication_error" : status === 402 ? "billing_error" : status === 403 ? "permission_error"
    : status === 404 ? "not_found_error" : status === 409 ? "conflict_error" : status === 413 ? "request_too_large"
    : status === 429 ? "rate_limit_error" : status === 504 ? "timeout_error" : status === 529 ? "overloaded_error"
    : status >= 500 ? "api_error" : "invalid_request_error";
}
export function withOwnedNativeLocalError(cap: OwnedHttpRequest, response: Response, path: string, requestId: string): Response {
  beginOwnedHttpMetadataStage(cap, response, 0, requestId, path);
  assertOwnedErrorFormat();
  const error = ownedLocalErrorApply(ownedLocalErrorGet, localErrors, [response]) as { code: string; message: string } | undefined, format = nativeErrorFormat(path);
  if (!error || !format) return finishOwnedHttpMetadataStage(cap, response, 0, response);
  const code = error.code, message = error.message;
  if (typeof code !== "string" || typeof message !== "string") throw identityFailure("protocol");
  const source = captureOwnedResponseMetadata(response), measured = measureOwnedHeaders(source.headers);
  // Every UTF16 input unit can emit six escaped JSON units. The fixed syntax
  // and type spelling fit512. Hold graph/string/UTF8/native-body copies together.
  const units = code.length + message.length + requestId.length, serialized = 6 * units + 512;
  admitOwnedHttpMetadata(cap, response, 0, 8192 + 3 * measured + 4 * source.statusText.length + 14 * serialized + 8 * units);
  // Enroll the replaced body's disposition before any replacement can escape.
  // This joins an existing reader when present, without acquiring another one.
  disposeOwnedHttpLocalErrorBody(cap, response);
  if (measureOwnedHeaders(source.headers) > measured) throw identityFailure("protocol");
  const headers = newOwnedHeaders(source.headers);
  deleteOwnedHeader(headers, "content-length");
  setOwnedHeader(headers, "x-clawrouter-error-code", code);
  if (format === "anthropic") setOwnedHeader(headers, "request-id", requestId);
  if (!hasOwnedHeader(headers, "content-type")) setOwnedHeader(headers, "content-type", "application/json");
  const type = format === "anthropic" ? ownedAnthropicType(source.status)
    : source.status >= 500 ? "server_error" : source.status === 429 ? "rate_limit_error" : "invalid_request_error";
  const envelope = nativeErrorEnvelope({ __proto__: null, format, requestId } as NativeErrorContext, source.status,
    { __proto__: null, message, code, type, param: null, requestId } as NativeErrorDetails);
  // Only these newly constructed private records lose their prototype; the
  // shared envelope algorithm and all ordinary objects remain unchanged.
  ownedErrorPrototype(envelope, null); ownedErrorPrototype(envelope.error, null);
  const text = ownedErrorStringify(envelope), bytes = ownedErrorApply(ownedErrorEncode, new ownedErrorEncoder(), [text]) as Uint8Array;
  const copy = newOwnedResponse(bytes, source.status, "", headers);
  inheritOwnedLocalError(response, copy);
  return finishOwnedHttpMetadataStage(cap, response, 0, copy);
}

/** @internal Called only after the genuine owner's initial-error admission. */
export function markOwnedLocalError(response: Response, code: string, message: string): Response {
  ownedLocalErrorApply(ownedLocalErrorSet, localErrors, [response, { __proto__: null, code, message }]);
  return response;
}
