import { jsonBodyBytes } from "./json-body.ts";
import { readNativeJson } from "./native-json.ts";
import { nativeJsonResponse, nativeResponseLease, type NativeResponse } from "./native-response.ts";
import { observeBedrockEmbedding, prepareBedrockEmbedding } from "./provider-bedrock-embeddings.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import { HttpError } from "./utils.ts";

const requestLimit = 2 * 1024 * 1024, responseLimit = 8 * 1024 * 1024;

// Called after original credential/transport and final URL resolution, before
// reservation or fetch. Common dispatch owns origin/region binding and SigV4;
// this leaf receives no credentials and never serializes the signed request.
export function prepareNativeBedrockEmbedding(
  selection: ProxySelection, input: Readonly<{ origin: string }>,
): NativeResponse | undefined {
  const { provider, endpoint, model, body } = selection;
  if (provider.id !== "aws-bedrock" || selection.capability !== "llm.embeddings") return;
  if (!model || !model.capabilities.includes("llm.embeddings") || selection.pathParams.model !== model.upstream
    || Object.keys(selection.pathParams).length !== 1 || selection.method !== "POST" || endpoint.method !== "POST"
    || endpoint.path !== "/model/${model}/invoke" || endpoint.upstreamPath !== undefined
    || endpoint.path_params.length !== 1 || endpoint.path_params[0] !== "model" || endpoint.path_param_styles.model !== "opaque_segment"
    || endpoint.request_format !== "aws_bedrock.invoke" || endpoint.response_format !== "aws_bedrock.invoke"
    || Object.keys(endpoint.query).length || selection.nativeQuery !== undefined || endpoint.streaming || endpoint.websocket
    || endpoint.lifecycle || endpoint.responsesLifecycle || endpoint.modelPassthrough || endpoint.requestPricing
    || typeof input?.origin !== "string" || input.origin.length > 128
    || !/^https:\/\/bedrock-runtime\.[a-z]{2}(?:-[a-z0-9]+){1,3}-\d\.amazonaws\.com$/.test(input.origin)) {
    throw new HttpError(400, "invalid_native_bedrock_embedding_route", "Bedrock embeddings require a selected model and qualified regional unary route");
  }
  let prepared;
  try {
    if (jsonBodyBytes(body) > requestLimit) throw new Error("size");
    prepared = prepareBedrockEmbedding(model.upstream, body);
  } catch {
    throw new HttpError(400, "invalid_native_bedrock_embedding_request", "Bedrock embedding input must match the selected native model contract");
  }
  return {
    origin: input.origin, path: prepared.path,
    // BodyLease charges twice this amount; dispatch releases it after delivery.
    acquire: () => nativeResponseLease(32 * 1024 * 1024),
    async read(response, signal) {
      const encoding = response.headers.get("content-encoding"), mime = response.headers.get("content-type");
      if (!mime || !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i.test(mime.trim())
        || encoding !== null && encoding.trim().toLowerCase() !== "identity") {
        void response.body?.cancel().catch(() => undefined); invalid();
      }
      // Identity must still undergo the shared reader's exact length check.
      if (encoding !== null) {
        const headers = new Headers(response.headers); headers.delete("content-encoding");
        if (response.redirected || response.status !== 200) { void response.body?.cancel().catch(() => undefined); invalid(); }
        response = new Response(response.body, { status: response.status, headers });
      }
      return readNativeJson(response, signal, responseLimit, value => {
        const observed = observeBedrockEmbedding(value, prepared, true);
        const tokens = observed.inputTokens === null ? null : { input: observed.inputTokens, output: null, total: null,
          cached: null, cacheWrite: null, cacheWrite5m: null, cacheWrite1h: null };
        return { response: nativeJsonResponse(value, new Response(null, { headers: {
          "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff",
        } })), usage: { tokens, outcome: "success" as const } };
      }, invalid);
    },
  };
}

function invalid(): never { throw new Error("invalid_native_bedrock_embedding_response"); }
