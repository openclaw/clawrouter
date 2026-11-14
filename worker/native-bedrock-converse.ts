import { jsonBodyBytes } from "./json-body.ts";
import { readNativeJson } from "./native-json.ts";
import { nativeJsonResponse, nativeResponseLease, type NativeResponse } from "./native-response.ts";
import { bedrockConverseLimit, bedrockRecord, decodeBedrockConverseResponse, prepareBedrockConverseRequest } from "./provider-bedrock-converse.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import { errorResponse, HttpError } from "./utils.ts";

// Common dispatch supplies the original selected regional origin and calls this
// before serialization/SigV4. It owns credentials, admission and lease lifetime.
export function prepareNativeBedrockConverse(
  selection: ProxySelection, input: Readonly<{ origin: string }>,
): NativeResponse | undefined {
  const { provider, endpoint, model, body } = selection;
  if (endpoint.request_format !== "aws_bedrock.converse") return;
  if (provider.id !== "aws-bedrock" || selection.capability !== "llm.chat" || !model
    || !model.capabilities.includes("llm.chat")
    || !provider.capabilities.some(item => item.id === "llm.chat" && item.endpoint === endpoint.id)
    || selection.pathParams.model !== model.upstream || Object.keys(selection.pathParams).length !== 1
    || selection.method !== "POST" || endpoint.method !== "POST" || endpoint.path !== "/model/${model}/converse"
    || endpoint.upstreamPath !== undefined || endpoint.path_params.length !== 1 || endpoint.path_params[0] !== "model"
    || endpoint.path_param_styles.model !== "opaque_segment" || endpoint.response_format !== "aws_bedrock.converse"
    || Object.keys(endpoint.query).length || selection.nativeQuery !== undefined || endpoint.streaming || endpoint.websocket
    || endpoint.lifecycle || endpoint.responsesLifecycle || endpoint.modelPassthrough || endpoint.requestPricing
    || typeof input?.origin !== "string" || input.origin.length > 128
    || !/^https:\/\/bedrock-runtime\.[a-z]{2}(?:-[a-z0-9]+){1,3}-\d\.amazonaws\.com$/.test(input.origin)) {
    throw new HttpError(400, "invalid_native_bedrock_converse_route", "Bedrock Converse requires an explicitly selected chat model and regional unary route");
  }
  let prepared;
  try {
    if (jsonBodyBytes(body) > bedrockConverseLimit) throw new Error("size");
    const request = bedrockRecord(body);
    if (!request || request.stream !== undefined && request.stream !== false) throw new Error("stream");
    prepared = prepareBedrockConverseRequest(body, model.upstream, false);
    // Bound total request blocks as well as the codec's message/depth limits.
    let blocks = Array.isArray(prepared.body.system) ? prepared.body.system.length : 0;
    if (!Array.isArray(prepared.body.messages)) throw new Error("messages");
    for (const message of prepared.body.messages) {
      const content = bedrockRecord(message)?.content;
      if (!Array.isArray(content)) throw new Error("content");
      blocks += content.length;
    }
    if (blocks > 4096) throw new Error("blocks");
  } catch {
    throw new HttpError(400, "invalid_native_bedrock_converse_request", "Bedrock Converse requires bounded native unary input");
  }
  selection.body = prepared.body;
  return {
    origin: input.origin, path: prepared.path,
    // Complete JSON and decoded copies: BodyLease charges 64 MiB.
    acquire: () => nativeResponseLease(32 * 1024 * 1024),
    async read(response, signal) {
      const encoding = response.headers.get("content-encoding"), mime = response.headers.get("content-type");
      if (!mime || !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i.test(mime.trim())
        || encoding !== null && encoding.trim().toLowerCase() !== "identity") {
        void response.body?.cancel().catch(() => undefined); invalid();
      }
      // Preserve exact EOF/length validation for identity-encoded responses.
      if (encoding !== null) {
        if (response.redirected || response.status !== 200) { void response.body?.cancel().catch(() => undefined); invalid(); }
        const headers = new Headers(response.headers); headers.delete("content-encoding");
        response = new Response(response.body, { status: response.status, headers });
      }
      return readNativeJson(response, signal, bedrockConverseLimit, value => {
        const decoded = decodeBedrockConverseResponse(value);
        const headers = { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" };
        // A valid failed stop retains observed usage, never provider prose or a
        // partial answer. Malformed envelopes throw through the shared reader.
        return { response: decoded.error
          ? errorResponse(decoded.error, "Bedrock Converse did not complete successfully", 502, undefined, headers)
          : nativeJsonResponse(value, new Response(null, { headers })), usage: decoded.inspection };
      }, invalid);
    },
  };
}

function invalid(): never { throw new Error("invalid_native_bedrock_converse_response"); }
