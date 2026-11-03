import { decodeBedrockEventFrame } from "./bedrock-eventstream.ts";
import { jsonBodyBytes } from "./json-body.ts";
import { nativeResponseLease, type NativeResponse } from "./native-response.ts";
import { bedrockConverseLimit, bedrockRecord, createBedrockConverseDecoder, prepareBedrockConverseRequest } from "./provider-bedrock-converse.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import { errorResponse, HttpError } from "./utils.ts";

const eventKinds = new Set(["messageStart", "contentBlockStart", "contentBlockDelta", "contentBlockStop", "messageStop", "metadata"]);
const exceptionKinds = new Set(["internalServerException", "modelStreamErrorException", "validationException", "throttlingException", "serviceUnavailableException"]);
const metadataNames = new Set([":message-type", ":event-type", ":exception-type", ":content-type"]);
const maxReads = 65536, maxFrames = 16384, maxHeaderBytes = 4096;

// Common dispatch supplies the original regional origin and calls this before
// serialization/SigV4. Credentials, admission, deadlines and lease lifetime stay there.
export function prepareNativeBedrockConverseStream(
  selection: ProxySelection, input: Readonly<{ origin: string }>,
): NativeResponse | undefined {
  const { provider, endpoint, model, body } = selection;
  if (endpoint.request_format !== "aws_bedrock.converse_stream") return;
  if (provider.id !== "aws-bedrock" || selection.capability !== "llm.chat" || !model
    || !model.capabilities.includes("llm.chat")
    || !provider.capabilities.some(item => item.id === "llm.chat" && item.endpoint === endpoint.id)
    || selection.pathParams.model !== model.upstream || Object.keys(selection.pathParams).length !== 1
    || selection.method !== "POST" || endpoint.method !== "POST" || endpoint.path !== "/model/${model}/converse-stream"
    || endpoint.upstreamPath !== undefined || endpoint.path_params.length !== 1 || endpoint.path_params[0] !== "model"
    || endpoint.path_param_styles.model !== "opaque_segment" || endpoint.response_format !== "aws_bedrock.converse_eventstream"
    || Object.keys(endpoint.query).length || selection.nativeQuery !== undefined || endpoint.streaming || endpoint.websocket
    || endpoint.lifecycle || endpoint.responsesLifecycle || endpoint.modelPassthrough || endpoint.requestPricing
    || typeof input?.origin !== "string" || input.origin.length > 128
    || !/^https:\/\/bedrock-runtime\.[a-z]{2}(?:-[a-z0-9]+){1,3}-\d\.amazonaws\.com$/.test(input.origin)) {
    throw new HttpError(400, "invalid_native_bedrock_converse_stream_route", "Bedrock ConverseStream requires an explicitly selected chat model and regional buffered route");
  }
  let prepared;
  try {
    if (jsonBodyBytes(body) > bedrockConverseLimit) throw new Error("size");
    const request = bedrockRecord(body);
    if (!request || request.stream !== undefined && request.stream !== true) throw new Error("stream");
    prepared = prepareBedrockConverseRequest(body, model.upstream, true);
    let blocks = Array.isArray(prepared.body.system) ? prepared.body.system.length : 0;
    if (!Array.isArray(prepared.body.messages)) throw new Error("messages");
    for (const message of prepared.body.messages) {
      const content = bedrockRecord(message)?.content;
      if (!Array.isArray(content)) throw new Error("content");
      blocks += content.length;
    }
    if (blocks > 4096) throw new Error("blocks");
  } catch {
    throw new HttpError(400, "invalid_native_bedrock_converse_stream_request", "Bedrock ConverseStream requires bounded native input");
  }
  selection.body = prepared.body;
  return { origin: input.origin, path: prepared.path,
    // BodyLease charges 64 MiB, including wire, parsed events and delivery copies.
    acquire: () => nativeResponseLease(32 * 1024 * 1024), read: readConverseStream };
}

async function readConverseStream(response: Response, signal: AbortSignal) {
  const length = response.headers.get("content-length"), encoding = response.headers.get("content-encoding");
  if (response.status !== 200 || response.redirected || !response.body || response.headers.has("content-range")
    || response.headers.get("content-type")?.trim().toLowerCase() !== "application/vnd.amazon.eventstream"
    || encoding !== null && encoding.trim().toLowerCase() !== "identity"
    || length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > bedrockConverseLimit)) {
    void response.body?.cancel().catch(() => undefined); invalid();
  }
  // One fixed buffer: chunk/frame metadata is never accumulated. Bound read and
  // frame counts as well, including pathological empty chunks and tiny frames.
  const wire = new Uint8Array(bedrockConverseLimit), reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  let size = 0, reads = 0;
  try {
    signal.throwIfAborted();
    for (;;) {
      if (++reads > maxReads) invalid();
      const chunk = await reader.read(); signal.throwIfAborted();
      if (chunk.done) break;
      if (size + chunk.value.byteLength > wire.length) invalid();
      wire.set(chunk.value, size); size += chunk.value.byteLength;
    }
    if (length !== null && Number(length) !== size) invalid();
    const decoder = createBedrockConverseDecoder(), utf8 = new TextDecoder("utf-8", { fatal: true });
    let offset = 0, frames = 0;
    while (offset < size) {
      signal.throwIfAborted();
      if (++frames > maxFrames || size - offset < 12) invalid();
      // Length only selects a bounded slice. The shared decoder validates both
      // CRCs, declared sizes and every header before any payload is interpreted.
      const prelude = new DataView(wire.buffer, offset, size - offset), frameLength = prelude.getUint32(0);
      // Cap metadata before the shared parser allocates header names/maps.
      if (frameLength < 16 || frameLength > size - offset || prelude.getUint32(4) > maxHeaderBytes) invalid();
      const { headers, payload } = decodeBedrockEventFrame(wire.subarray(offset, offset + frameLength));
      const messageType = headers.get(":message-type"), eventType = headers.get(":event-type"), exceptionType = headers.get(":exception-type");
      if (headers.get(":content-type") !== "application/json"
        || [...headers.keys()].some(name => !metadataNames.has(name))) invalid();
      const kind = messageType === "event" && eventType && !headers.has(":exception-type") && eventKinds.has(eventType) ? eventType
        : messageType === "exception" && exceptionType && !headers.has(":event-type") && exceptionKinds.has(exceptionType) ? exceptionType : undefined;
      if (!kind) invalid();
      const data: unknown = JSON.parse(utf8.decode(payload));
      const object = bedrockRecord(data);
      if (!object || Object.keys(object).some(key => eventKinds.has(key) || exceptionKinds.has(key))) invalid();
      decoder.accept({ [kind]: object });
      offset += frameLength;
    }
    signal.throwIfAborted();
    const result = decoder.result(true);
    if (result.inspection.outcome === "provider_error" && result.error) {
      wire.fill(0);
      return { response: errorResponse(result.error, "Bedrock ConverseStream did not complete successfully", 502, undefined,
        { "cache-control": "no-store", "x-content-type-options": "nosniff" }), usage: result.inspection };
    }
    if (result.inspection.outcome !== "success") invalid();
    return { response: new Response(wire.subarray(0, size), { headers: {
      "content-type": "application/vnd.amazon.eventstream", "content-length": String(size),
      "cache-control": "no-store", "x-content-type-options": "nosniff",
    } }), usage: result.inspection };
  } catch {
    wire.fill(0); void reader.cancel().catch(() => undefined); invalid();
  } finally {
    signal.removeEventListener("abort", abort); reader.releaseLock();
  }
}

function invalid(): never { throw new Error("invalid_native_bedrock_converse_stream_response"); }
