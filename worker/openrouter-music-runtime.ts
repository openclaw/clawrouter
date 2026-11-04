import { BodyLease } from "./body-budget.ts";
import { HttpOperation } from "./http-operation.ts";
import { jsonBodyTransport, type JsonBodyTransport } from "./json-body.ts";
import { nativeOpenRouterMusicResponse } from "./native-openrouter-music.ts";
import { openRouterMusicModels, prepareOpenRouterMusicBorrowed, type OpenRouterMusicContext } from "./openrouter-music.ts";
import type { InlineMusicEvidence } from "./openrouter-music-owner.ts";
import { freezeInlineMusicInput } from "./openrouter-music-input.ts";
import { qualifyImageContainer } from "./pixverse-image-multipart.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import { HttpError } from "./utils.ts";

const MiB = 1024 * 1024;
const inputs = new WeakMap<ProxySelection, InlineMusicInput>();

// The map contains common-controller registrations only. Neither a request
// property nor the pure codec can mint an admitted borrowed-input owner.
export function inlineMusicInput(selection: ProxySelection): InlineMusicInput | undefined { return inputs.get(selection); }

// Called after the registered model/capability resolves, before any legacy
// cloning factory or serializer. Ordinary Chat and prompt-only music retain
// their existing preparation path and admission charges.
export async function prepareInlineMusicInput(selection: ProxySelection, lease: BodyLease,
  operation: HttpOperation): Promise<InlineMusicInput | undefined> {
  if (selection.provider.id !== "openrouter" || selection.capability !== "music.generate") return;
  const body = selection.body;
  if (Array.isArray(body) || !Array.isArray(body.messages)) return;
  const message = body.messages[0] as Record<string, unknown> | undefined;
  if (!message || typeof message.content === "string") return;
  if (selection.provider.base_urls.default !== "https://openrouter.ai/api" || !selection.model
    || !openRouterMusicModels.some(model => model === selection.model!.upstream)
    || !selection.model.capabilities.includes("music.generate") || selection.method !== "POST"
    || selection.endpoint.method !== "POST" || selection.endpoint.path !== "/v1/chat/completions"
    || selection.endpoint.request_format !== "openai.chat_completions" || selection.endpoint.response_format !== "openai.chat_completions"
    || selection.endpoint.streaming !== "sse" || selection.endpoint.upstreamPath !== undefined
    || selection.endpoint.path_params.length || Object.keys(selection.pathParams).length || Object.keys(selection.endpoint.query).length
    || selection.nativeQuery !== undefined || selection.endpoint.websocket || selection.endpoint.lifecycle
    || selection.endpoint.responsesLifecycle || selection.endpoint.modelPassthrough || selection.endpoint.requestPricing) invalid();
  if (!lease.grow(32 * MiB)) throw new HttpError(503, "server_overloaded", "inline music validation capacity is busy", { "retry-after": "1" });
  operation.signal.throwIfAborted();
  let context: OpenRouterMusicContext;
  try {
    freezeInlineMusicInput(body);
    const borrowed = prepareOpenRouterMusicBorrowed(selection.model.upstream, body);
    context = borrowed.context;
  } catch { invalid(); }
  const evidence = await imageEvidence(message.content, operation.signal);
  operation.signal.throwIfAborted();
  return new InlineMusicInput(selection, lease, operation, evidence, context);
}

async function imageEvidence(content: unknown, signal: AbortSignal): Promise<Readonly<InlineMusicEvidence>> {
  // The borrowed codec already validated the complete shape and base64 range.
  // Decode bounded slices of that original string, never a whole substring,
  // atob string, normalized copy or second JSON graph. HTTPS remains closed.
  const image = (content as Array<{ image_url?: { url?: unknown } }>)[1];
  const url = image?.image_url?.url;
  if (typeof url !== "string") invalid();
  const mime = (["image/png", "image/jpeg", "image/webp"] as const).find(type => url.startsWith(`data:${type};base64,`));
  if (!mime) invalid();
  const start = `data:${mime};base64,`.length;
  const padding = url.endsWith("==") ? 2 : url.endsWith("=") ? 1 : 0;
  const size = Math.floor((url.length - start) * 3 / 4) - padding;
  if (size < 1 || size > 8 * MiB) invalid();
  let decoded: Uint8Array<ArrayBuffer> | undefined = new Uint8Array(size);
  try {
    let written = 0;
    for (let offset = start; offset < url.length; offset += 16384) {
      signal.throwIfAborted();
      const piece = atob(url.slice(offset, offset + 16384).replace(/-/g, "+").replace(/_/g, "/"));
      if (piece.length > size - written) invalid();
      for (let index = 0; index < piece.length; index++) decoded[written++] = piece.charCodeAt(index);
    }
    if (written !== size) invalid();
    qualifyImageContainer(decoded, mime);
    // WebCrypto snapshots at most 8 MiB while this 8 MiB decoded buffer is
    // live. Both stay under the 64 MiB ingress phase until digest completion.
    const digest = await crypto.subtle.digest("SHA-256", decoded);
    signal.throwIfAborted();
    return Object.freeze({ slot: "messages[0].content[1].image_url.url", mime, bytes: size,
      sha256: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("") });
  } catch (error) {
    if (signal.aborted) throw error;
    invalid();
  } finally { decoded = undefined; }
}

function invalid(): never { throw new HttpError(400, "invalid_inline_music_input", "music references require qualified inline image bytes and the selected native route"); }

export class InlineMusicInput {
  readonly nativeResponse;
  readonly operation: HttpOperation;
  private inputLease: BodyLease;
  private responseLease?: BodyLease;
  private upload?: { serializer: JsonBodyTransport; done: Promise<void>; abort: AbortController };
  private transferred = false;
  private finished?: Promise<void>;
  private discardRetention?: () => void;

  constructor(private readonly selection: ProxySelection, lease: BodyLease, operation: HttpOperation,
    readonly evidence: Readonly<InlineMusicEvidence>, context: OpenRouterMusicContext) {
    this.inputLease = lease; this.operation = operation;
    this.nativeResponse = nativeOpenRouterMusicResponse(context);
    if (inputs.has(selection)) throw new TypeError("music input already has an owner");
    inputs.set(selection, this);
  }

  retain(discard: () => void): void { this.discardRetention = discard; }

  // A fixed-length stream carries bounded serializer chunks, not a materialized
  // JSON string/UTF-8 copy. The pipe promise owns queued transport bytes until
  // physical consumption or cancellation; serializer EOF alone is insufficient.
  transport(): ReadableStream<Uint8Array> {
    if (this.upload || this.finished || this.transferred) throw new TypeError("music upload is single-use");
    const serializer = jsonBodyTransport(this.selection.body, 12 * MiB);
    const abort = new AbortController(), fixed = new FixedLengthStream(serializer.bytes);
    const canceled = () => abort.abort(this.operation.signal.reason);
    this.operation.signal.addEventListener("abort", canceled, { once: true });
    if (this.operation.signal.aborted) canceled();
    const done = serializer.stream().pipeTo(fixed.writable, { signal: abort.signal }).finally(() => {
      this.operation.signal.removeEventListener("abort", canceled);
      serializer.discard();
    });
    // A consumer may not have reached fetch yet. Keep rejection observed while
    // preserving it for completeUpload/finish and the original operation.
    void done.catch(() => undefined);
    this.upload = { serializer, done, abort };
    return fixed.readable;
  }

  // Call only after the intake parser, decoded image/digest scratch and the
  // awaited retention writer have retired. This never releases/reacquires or
  // assumes GC reclaimed a still-referenced object graph.
  acquireResponse(): BodyLease {
    if (this.transferred || this.finished || !this.upload) throw new TypeError("music input phase is unavailable");
    const next = this.inputLease.splitCharges(32 * MiB, 64 * MiB);
    if (!next) throw new HttpError(503, "server_overloaded", "music response capacity is busy", { "retry-after": "1" });
    this.transferred = true;
    [this.inputLease, this.responseLease] = next;
    return this.responseLease;
  }

  async completeUpload(): Promise<void> {
    if (!this.upload) throw new TypeError("music upload is unavailable");
    await this.operation.wait(this.upload.done, "upstream");
    this.operation.signal.throwIfAborted();
    // Only scalar facts survive in selection/accounting after transport EOF.
    // The input charge remains conservative until the downstream completion
    // owner invokes finish; no response lease is released at upstream DONE.
    this.selection.body = { stream: true };
    this.upload = undefined;
  }

  finish(): Promise<void> {
    return this.finished ??= this.retire();
  }

  private async retire(): Promise<void> {
    this.discardRetention?.(); this.discardRetention = undefined;
    const upload = this.upload;
    if (upload) {
      upload.abort.abort();
      await upload.done.catch(() => undefined);
      upload.serializer.discard();
      this.upload = undefined;
    }
    this.selection.body = { stream: true };
    inputs.delete(this.selection);
    this.inputLease.release();
    this.responseLease?.release(); this.responseLease = undefined;
  }
}
