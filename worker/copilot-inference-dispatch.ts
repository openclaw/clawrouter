import { createJsonTokenizer } from "./json-tokens.ts";
import type { CopilotCatalogInput } from "./copilot-catalog-flow.ts";
import type { CopilotInferenceContext, CopilotWireFormat } from "./provider-copilot.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import type { AccessPolicy, AuthorizedIdentity, CompiledProvider } from "./types.ts";
import { HttpError } from "./utils.ts";
import { inputRetirement } from "./input-retirement.ts";
import type { HttpOperation } from "./http-operation.ts";

export const copilotInferenceUnavailable = () => new HttpError(409, "copilot_inference_unavailable", "Original Copilot inference authority unavailable");
export const copilotInferencePaths: Readonly<Record<CopilotWireFormat, string>> = {
  "openai.chat_completions": "/chat/completions", "openai.responses": "/responses", "anthropic.messages": "/messages",
};
export interface CopilotInferenceInput {
  selected: CopilotCatalogInput & { selection: NonNullable<CopilotCatalogInput["selection"]> };
  body: Record<string, unknown>;
  context: CopilotInferenceContext;
  /** Server-resolved public route only; never parsed from the private DTO. */
  accountingSelection?: ProxySelection;
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
  if (input.accountingSelection) return input.accountingSelection;
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

// The pure factory creates one bounded JSON Request representation. Keep its
// ORIGINAL reader until upload EOF/cancel rather than treating response headers
// as evidence that fetch has finished consuming the request body.
export function copilotInferenceUpload(prepared: Request, operation: HttpOperation) {
  if (!prepared.body || prepared.bodyUsed || prepared.body.locked) throw copilotInferenceUnavailable();
  const reader = prepared.body.getReader();
  let cleanupFailed = false, ended = false, complete = false, total = 0, reads = 0;
  let chunk: Uint8Array | undefined, offset = 0, pulling: Promise<void> | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const owner = inputRetirement({
    async cancel(reason) { try { await reader.cancel(reason); } catch (error) { cleanupFailed = true; throw error; } },
    releaseLock: () => reader.releaseLock(),
  });
  let resolve!: () => void, reject!: (error: unknown) => void;
  const retired = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  void retired.catch(() => undefined);
  const finish = (kind: "eof" | "cancel", reason?: unknown) => {
    if (ended) return retired;
    ended = true; complete = kind === "eof";
    operation.signal.removeEventListener("abort", abort);
    const cleanup = owner.retire(kind, reason), active = pulling;
    void Promise.allSettled([cleanup, active]).then(results => {
      chunk = undefined; controller = undefined;
      const failure = results.find(result => result.status === "rejected");
      if (failure?.status === "rejected") reject(failure.reason);
      else if (cleanupFailed || !complete) reject(copilotInferenceUnavailable()); else resolve();
    });
    return retired;
  };
  const abort = () => { try { controller?.error(operation.signal.reason); } catch {} void finish("cancel", operation.signal.reason); };
  operation.signal.addEventListener("abort", abort, { once: true });
  const stream = new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
    pull(output) {
      const work = Promise.resolve().then(async () => {
        try {
          operation.signal.throwIfAborted();
          if (!chunk || offset === chunk.length) {
            chunk = undefined; offset = 0;
            if (++reads > 8192) throw copilotInferenceUnavailable();
            const next = await owner.read(() => reader.read()); operation.signal.throwIfAborted();
            if (ended) return;
            if (next.done) { if (!total) throw copilotInferenceUnavailable(); output.close(); void finish("eof"); return; }
            if (!(next.value instanceof Uint8Array) || !(next.value.buffer instanceof ArrayBuffer)
              || next.value.buffer.byteLength > 512 * 1024 || next.value.length > 512 * 1024 - total) throw copilotInferenceUnavailable();
            total += next.value.length; chunk = next.value;
          }
          if (ended) return;
          const end = Math.min(chunk.length, offset + 16 * 1024);
          output.enqueue(chunk.slice(offset, end)); offset = end;
        } catch (error) { try { output.error(error); } catch {} void finish("cancel", error); }
      });
      pulling = work; return work.finally(() => { if (pulling === work) pulling = undefined; });
    },
    cancel(reason) { void finish("cancel", reason); },
  }, { highWaterMark: 0 });
  if (operation.signal.aborted) abort();
  // No tee or whole-body replay copy. The factory's headers and exact URL stay
  // unchanged, while this private stream owns consumption and retirement.
  const request = new Request(prepared, { body: stream, duplex: "half" } as RequestInit);
  return { request, retired, discard: (reason?: unknown) => { abort(); return finish("cancel", reason); } };
}
