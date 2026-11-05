import { createJsonTokenizer } from "./json-tokens.ts";
import type { CopilotCatalogInput } from "./copilot-catalog-flow.ts";
import type { CopilotInferenceContext, CopilotWireFormat } from "./provider-copilot.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import type { AccessPolicy, AuthorizedIdentity, CompiledProvider } from "./types.ts";
import { HttpError } from "./utils.ts";

export const copilotInferenceUnavailable = () => new HttpError(409, "copilot_inference_unavailable", "Original Copilot inference authority unavailable");
export const copilotInferencePaths: Readonly<Record<CopilotWireFormat, string>> = {
  "openai.chat_completions": "/chat/completions", "openai.responses": "/responses", "anthropic.messages": "/messages",
};
export interface CopilotInferenceInput {
  selected: CopilotCatalogInput & { selection: NonNullable<CopilotCatalogInput["selection"]> };
  body: Record<string, unknown>;
  context: CopilotInferenceContext;
}

// Bound the complete graph BEFORE JSON.parse, including overwritten members,
// ignored metadata and every decoded key/string. Token vectors are feed-bounded.
export function inspectCopilotInferenceJson(text: string): void {
  let depth = 0, values = 0, members = 0, entries = 0, strings = 0;
  const stack = new Uint8Array(64), invalid = () => { throw copilotInferenceUnavailable(); };
  const value = () => { if (++values > 4096 || depth && stack[depth - 1] === 2 && ++entries > 4096) invalid(); };
  const tokenizer = createJsonTokenizer(token => {
    switch (token.name) {
      case "startObject": case "startArray":
        value(); if (depth === 64) invalid(); stack[depth++] = token.name === "startArray" ? 2 : 1; break;
      case "endObject": case "endArray": depth--; break;
      case "startKey": if (++members > 4096) invalid(); break;
      case "stringChunk": strings += token.value.length; if (strings > 262144) invalid(); break;
      case "startString": case "startNumber": case "nullValue": case "trueValue": case "falseValue": value(); break;
    }
  });
  // At most 1024 UTF-8 bytes; 256 UTF-16 units also bounds malformed surrogates.
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(text.length, offset + 256);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
    tokenizer.push(text.slice(offset, end)); offset = end;
  }
  tokenizer.end();
  if (depth || !values) invalid();
}

export function copilotInferenceInput(value: unknown, deadline: number): CopilotInferenceInput {
  const invalid = copilotInferenceUnavailable;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const { body, initiator, ...selected } = value as Record<string, unknown>;
  if (selected.deadline !== deadline || !body || typeof body !== "object" || Array.isArray(body)
    || !["user", "agent"].includes(initiator as string)) throw invalid();
  const selection = selected.selection as CopilotCatalogInput["selection"];
  if (!selection || !Object.hasOwn(copilotInferencePaths, selection.format) || typeof selection.modelId !== "string"
    || !selection.modelId.startsWith("github-copilot/")) throw invalid();
  const request = body as Record<string, unknown>, upstream = selection.modelId.slice("github-copilot/".length);
  if (!upstream || request.model !== upstream || typeof request.stream !== "boolean"
    || ["background", "previous_response_id", "conversation", "store", "websocket"].some(key => Object.hasOwn(request, key))) throw invalid();
  if (selection.format === "openai.responses" ? !Object.hasOwn(request, "input") : !Array.isArray(request.messages)) throw invalid();
  // Inspect only protocol content, not words inside tool schemas or text. This
  // fact controls a frozen protocol header; it never grants asset authority.
  const content = selection.format === "openai.responses" ? request.input : request.messages;
  let hasImages = false;
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) { for (const child of item) visit(child); return; }
    if (!item || typeof item !== "object") return;
    const part = item as Record<string, unknown>;
    if (["image", "image_url", "input_image"].includes(part.type as string)) hasImages = true;
    if (Object.hasOwn(part, "content")) visit(part.content);
  };
  visit(content);
  return { selected: selected as unknown as CopilotInferenceInput["selected"], body: request,
    context: { initiator: initiator as "user" | "agent", hasImages } };
}

// Private accounting descriptor only: no registered route, credentials, prices,
// manifest capability or public catalog entry. The owner verdict authorizes I/O.
const accountingProvider: CompiledProvider = {
  id: "github-copilot", display_name: "GitHub Copilot", status: "private", class: "private", service_platform: "github", service_kind: "inference",
  config_keys: [], optional_config_keys: [], auth: { schemes: [], authorization: null, refresh: null, grantTransports: {} }, auth_schemes: [], base_urls: {},
  routing: { nativePrefixes: [], modelPrefixes: [], baseUrlParam: null, serviceParam: null }, native_prefixes: [],
  adapter: { request: null, response: null, stream: null, error: null, passthroughHeaders: [], injectHeaders: {}, injectQuery: {}, requestTransforms: { renameFields: [] } },
  capabilities: [], endpoints: [], models: [], billing: { meter: null, dimensions: [], counters: [] }, meter: null, quota: { responseHeaders: [], probes: [] },
};
export function copilotAccountingSelection(input: CopilotInferenceInput): ProxySelection {
  const { selection } = input.selected, format = selection.format;
  return { provider: accountingProvider, capability: "llm.chat", body: input.body, method: "POST", pathParams: {},
    model: { id: selection.modelId, upstream: selection.modelId.slice("github-copilot/".length), capabilities: ["llm.chat"], pricing_ref: null, pricing: null },
    endpoint: { id: format === "openai.responses" ? "responses" : format === "anthropic.messages" ? "messages" : "chat_completions",
      method: "POST", methods: ["POST"], path: copilotInferencePaths[format], native_proxy: false, auth: null, headers: {}, request_headers: [], response_headers: [],
      query: {}, path_params: [], path_param_styles: {}, request_format: format, response_format: format, streaming: input.body.stream ? "sse" : null, timeout_ms: null } };
}
export function copilotAccountingIdentity(input: CopilotInferenceInput, policy: AccessPolicy): AuthorizedIdentity {
  const authorization = input.selected.authorization;
  if (authorization.kind !== "public") throw copilotInferenceUnavailable();
  const { binding } = authorization;
  return { credentialId: binding.credentialId, principalId: binding.principalId, policyId: binding.policyId, policy,
    authType: binding.proof.kind === "proxy_key" ? "proxy_key" : "access", contentRetentionDisabled: true };
}
