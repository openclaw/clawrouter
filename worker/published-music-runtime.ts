import { BodyLease } from "./body-budget.ts";
import { HttpOperation } from "./http-operation.ts";
import { continuationScope } from "./http-continuation.ts";
import { jsonBodyBytes } from "./json-body.ts";
import { nativeOpenRouterMusicResponse } from "./native-openrouter-music.ts";
import { freezeInlineMusicInput } from "./openrouter-music-input.ts";
import { prepareOpenRouterMusicBorrowed } from "./openrouter-music.ts";
import { musicPolicyBinding } from "./openrouter-music-owner.ts";
import { publishedMusicAccess, publishedMusicRequestDigest } from "./published-music.ts";
import { resolvePublishedInputUrl } from "./published-input-archive.ts";
import { assertPublishedInputLive, publishedInputUnavailable, type PublishedInputAttempt, type PublishedInputReceipt } from "./published-input-receipt.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import type { UpstreamAuth } from "./providers.ts";
import type { AuthorizedIdentity, Env } from "./types.ts";
import { HttpError, safeEqual, sha256Hex } from "./utils.ts";

const inputs = new WeakMap<ProxySelection, PublishedMusicInput>();
export const publishedMusicBodyBytes = 256 * 1024;
export const publishedMusicDispatchBytes = 640 * 1024;
export const publishedMusicDispatchHeader = "x-clawrouter-private-asset-dispatch";
export class PublishedMusicUnsent extends HttpError {
  constructor() { super(409, "published_input_unavailable", "the original published input could not authorize a destination attempt"); }
}
export function publishedMusicInput(selection: ProxySelection): PublishedMusicInput | undefined { return inputs.get(selection); }
export function publishedMusicReference(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return;
  const messages = (body as Record<string, unknown>).messages;
  if (!Array.isArray(messages) || !Array.isArray(messages[0]?.content)) return;
  const url = messages[0].content[1]?.image_url?.url;
  return typeof url === "string" && url.startsWith("https:") ? url : undefined;
}
export function preparePublishedMusicInput(selection: ProxySelection, lease: BodyLease, operation: HttpOperation): PublishedMusicInput | undefined {
  const url = publishedMusicReference(selection.body);
  if (!url || selection.provider.id !== "openrouter" || selection.capability !== "music.generate") return;
  if (!selection.model || jsonBodyBytes(selection.body) > publishedMusicBodyBytes
    || selection.method !== "POST" || selection.endpoint.id !== "music_generate" || Object.keys(selection.pathParams).length
    || !selection.model.capabilities.includes("music.generate")) publishedInputUnavailable();
  if (!lease.grow(6 * 1024 * 1024)) throw new HttpError(503, "server_overloaded", "published music input capacity is busy");
  freezeInlineMusicInput(selection.body);
  const prepared = prepareOpenRouterMusicBorrowed(selection.model.upstream, selection.body);
  return new PublishedMusicInput(selection, lease, operation, url, nativeOpenRouterMusicResponse(prepared.context));
}

export class PublishedMusicInput {
  readonly operation: HttpOperation;
  readonly nativeResponse: ReturnType<typeof nativeOpenRouterMusicResponse>;
  private selection: ProxySelection;
  private inputLease: BodyLease;
  private responseLease?: BodyLease;
  private url: string | undefined;
  private receipt?: PublishedInputReceipt;
  private admissionDigest?: string;
  private access?: ReturnType<typeof publishedMusicAccess>;
  private discardRetention?: () => void;
  private forwarding?: Promise<Response>;
  private finished = false;
  constructor(selection: ProxySelection, lease: BodyLease, operation: HttpOperation, url: string,
    nativeResponse: ReturnType<typeof nativeOpenRouterMusicResponse>) {
    if (inputs.has(selection)) publishedInputUnavailable();
    this.selection = selection; this.inputLease = lease; this.operation = operation; this.url = url; this.nativeResponse = nativeResponse;
    inputs.set(selection, this);
  }
  async resolve(env: Env, auth: AuthorizedIdentity): Promise<{ key: string; lineage: string }> {
    if (!this.url || this.receipt || this.finished) publishedInputUnavailable();
    const receipt = await resolvePublishedInputUrl(env, this.url, this.operation.signal), binding = receipt.binding;
    if (receipt.state !== "published" || await continuationScope(auth) !== binding.scope || auth.policy.generation !== binding.issuer.policyGeneration
      || this.selection.provider.id !== binding.owner.providerId || this.selection.endpoint.id !== binding.owner.endpointId
      || this.selection.model?.id !== binding.modelId || this.selection.model.upstream !== binding.upstreamModel
      || Array.isArray(this.selection.body) || await publishedMusicRequestDigest(this.selection.body, binding) !== binding.requestDigest) publishedInputUnavailable();
    const policy = musicPolicyBinding(auth.policy);
    const access = publishedMusicAccess(env, binding, this.operation, policy);
    await access.authorize(); access.assertLive();
    this.admissionDigest = await sha256Hex(policy);
    this.receipt = receipt; this.access = access;
    return { key: binding.owner.grantKey, lineage: binding.owner.lineage };
  }
  async bind(upstream: UpstreamAuth, url: URL, headers: Headers): Promise<{ revalidate(signal: AbortSignal): Promise<void> }> {
    const binding = this.receipt?.binding, grant = upstream.grant;
    if (!binding || !grant || upstream.grantKey !== binding.owner.grantKey || grant.credentialGeneration !== binding.generation
      || grant.credentialLineage !== binding.owner.lineage || !grant.credential || upstream.transport !== null || upstream.query.size
      || upstream.baseUrl !== "https://openrouter.ai/api" || url.href !== binding.origin + binding.path
      || !safeEqual(headers.get("authorization") ?? "", `Bearer ${grant.credential}`)) publishedInputUnavailable();
    return { revalidate: async signal => { signal.throwIfAborted(); await this.access!.authorize(); this.access!.assertLive(); } };
  }
  retentionSelection(): ProxySelection {
    // Logging may retain the prompt under its existing policy, never the bearer.
    const body = structuredClone(this.selection.body) as Record<string, unknown>;
    const messages = body.messages as { content: { image_url?: { url: string } }[] }[];
    messages[0].content[1].image_url!.url = `published-input:${this.receipt!.binding.id}`;
    return { ...this.selection, body };
  }
  retain(discard: () => void): void { this.discardRetention = discard; }
  acquireResponse(): BodyLease {
    if (this.finished || !this.receipt || this.responseLease) publishedInputUnavailable();
    // 12 MiB input + 64 MiB response + 4 MiB credential-owner preparation +
    // one 16 MiB delegated GET fit the SAME 96 MiB pool before paid egress.
    const split = this.inputLease.splitCharges(12 * 1024 * 1024, 64 * 1024 * 1024);
    if (!split) throw new HttpError(503, "server_overloaded", "published music response capacity is busy");
    [this.inputLease, this.responseLease] = split; return this.responseLease;
  }
  async dispatch(env: Env, requestBody: BodyInit | undefined, attempt: Omit<PublishedInputAttempt, "admissionDigest">): Promise<Response> {
    const binding = this.receipt?.binding;
    if (!binding || !this.admissionDigest || !this.responseLease || this.finished || typeof requestBody !== "string"
      || new TextEncoder().encode(requestBody).byteLength > publishedMusicBodyBytes) throw new PublishedMusicUnsent();
    this.operation.signal.throwIfAborted(); assertPublishedInputLive(binding);
    const body = JSON.stringify({ binding, attempt: { ...attempt, admissionDigest: this.admissionDigest }, body: requestBody, deadline: Math.min(binding.expiresAt, Date.now() + 120_000) });
    if (new TextEncoder().encode(body).byteLength > publishedMusicDispatchBytes) throw new PublishedMusicUnsent();
    this.forwarding = env.GRANT_CREDENTIALS.get(env.GRANT_CREDENTIALS.idFromName(binding.owner.grantKey)).fetch(
      "https://clawrouter.internal/published-input/forward", { method: "POST", body, signal: this.operation.signal });
    const response = await this.forwarding;
    const disposition = response.headers.get(publishedMusicDispatchHeader);
    if (disposition === "unsent") { await response.body?.cancel().catch(() => undefined); throw new PublishedMusicUnsent(); }
    if (disposition !== "attempted") { await response.body?.cancel().catch(() => undefined); throw new Error("published music dispatch acknowledgment unavailable"); }
    const headers = new Headers(response.headers); headers.delete(publishedMusicDispatchHeader);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
  async completeUpload(): Promise<void> { this.selection.body = { stream: true }; this.url = undefined; }
  async finish(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    // A raced cancellation is not retirement of the private request's body.
    // The credential owner receives the same abort and settles its upload first.
    await this.forwarding?.catch(() => undefined); this.forwarding = undefined;
    this.discardRetention?.(); this.discardRetention = undefined;
    this.selection.body = { stream: true }; this.url = undefined; this.receipt = undefined; this.access = undefined;
    inputs.delete(this.selection); this.inputLease.release(); this.responseLease?.release(); this.responseLease = undefined;
  }
}
