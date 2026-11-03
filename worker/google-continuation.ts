import { authorityCall } from "./authority.ts";
import type { ContinuationOwner } from "./continuation-store.ts";
import { googleField } from "./google-protocol.ts";
import type { PinnedGrant } from "./grant-selection.ts";
import { continuationScope } from "./http-continuation.ts";
import type { ResponseBodyInspection } from "./proxy-response.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import type { AuthorizedIdentity, Env } from "./types.ts";
import { HttpError, sha256Hex } from "./utils.ts";

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const tokenLimit = 16 * 1024, candidateLimit = 8;
export function googleContinuationRoute(selection: ProxySelection): boolean {
  return selection.endpoint.request_format === "google.generate_content"
    && ["google.generate_content", "google.stream_generate_content"].includes(selection.endpoint.response_format);
}
export function googleContinuationRequested(selection: ProxySelection): boolean {
  return googleContinuationRoute(selection) && googleField(selection.body, "continuationToken", "continuation_token") != null;
}
function restart(): HttpError {
  return new HttpError(409, "google_continuation_owner_unavailable", "Google continuation requires the original caller, request, model and credential; automatic replay or credential fallback is unavailable");
}
function token(value: unknown): value is string {
  // Preserve opaque bytes as represented on wire; never decode or log them.
  return typeof value === "string" && value.length > 0 && value.length <= tokenLimit && value.trim() === value && /^[A-Za-z0-9_+/-]+={0,2}$/.test(value);
}
async function key(value: string): Promise<string> { return sha256Hex(JSON.stringify(["google.continuation.v1", value])); }

export class GoogleContinuation {
  readonly requested: boolean;
  readonly pinned?: PinnedGrant;
  private owner?: ContinuationOwner;
  private requestDigest?: Promise<string>;
  private pending = new Set<string>();
  private published = new Set<string>();
  private invalid = false;

  private env: Env;
  private scope: string;
  private selection: ProxySelection;
  private signal: AbortSignal;
  private previous: ContinuationOwner | null;

  private constructor(env: Env, scope: string, selection: ProxySelection,
    signal: AbortSignal, previous: ContinuationOwner | null, requested: boolean) {
    this.env = env; this.scope = scope; this.selection = selection;
    this.signal = signal; this.previous = previous;
    this.requested = requested;
    this.pinned = !requested ? undefined : previous?.grantKey && previous.lineage
      ? { key: previous.grantKey, lineage: previous.lineage } : { key: null, revision: null };
  }

  static async resolve(request: Request, selection: ProxySelection, auth: AuthorizedIdentity, env: Env): Promise<GoogleContinuation | undefined> {
    if (!googleContinuationRoute(selection)) return;
    const value = googleField(selection.body, "continuationToken", "continuation_token"), requested = value != null;
    if (!selection.model || selection.method !== "POST" || !object(selection.body)) { if (requested) throw restart(); return; }
    if (requested && (!token(value) || !Array.isArray(selection.body.contents) || !selection.body.contents.length)) throw restart();
    const scope = await continuationScope(auth);
    let previous: ContinuationOwner | null = null;
    if (requested) {
      const result = await call<{ owners: Array<ContinuationOwner | null> }>(env, scope, { action: "resolve", keys: [await key(value as string)] }, request.signal);
      previous = result.owners?.[0] ?? null;
      if (!previous || previous.providerId !== selection.provider.id || previous.endpointId !== selection.endpoint.id
        || previous.policyGeneration !== auth.policy.generation || previous.grantKey && !previous.lineage) throw restart();
    }
    return new GoogleContinuation(env, scope, selection, request.signal, previous, requested);
  }

  private async bound(owner: ContinuationOwner): Promise<ContinuationOwner> {
    // Keep the six-field durable owner schema. Its route digest adds selected
    // model and exact original JSON, excluding only the two top-level aliases.
    this.requestDigest ??= sha256Hex(JSON.stringify([this.selection.model!.id, this.selection.model!.upstream,
      Object.fromEntries(Object.entries(this.selection.body).filter(([name]) => name !== "continuationToken" && name !== "continuation_token"))]));
    return { ...owner, routeSha256: await sha256Hex(JSON.stringify(["google.continuation.v1", owner.routeSha256, await this.requestDigest])) };
  }

  async bind(owner: ContinuationOwner): Promise<void> {
    if (this.previous && JSON.stringify(this.previous) !== JSON.stringify(await this.bound(owner))) throw restart();
    this.owner = owner;
  }

  preflightError(error: unknown): unknown {
    return this.requested && error instanceof HttpError && ["upstream_grant_pool_unavailable", "upstream_grant_changed", "grant_reauthorization_required", "grant_refresh_failed", "grant_refresh_at_risk", "grant_refresh_persist_failed", "grant_disabled", "grant_credential_missing", "provider_not_configured", "grant_transport_unavailable"].includes(error.code) ? restart() : error;
  }

  inspect(response: Response): ResponseBodyInspection | undefined {
    const expected = this.selection.endpoint.response_format === "google.stream_generate_content" ? "text/event-stream" : "application/json";
    if (response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== expected) return;
    // A complete frame can name a token, but only completed delivery publishes
    // ownership. Interrupted HTTP hops never qualify their pending tokens.
    return { acceptJson: (value, failed) => { if (failed) { this.invalid = true; this.pending.clear(); } else this.accept(value); },
      push: async () => undefined, end: async () => this.flush() };
  }

  private accept(value: unknown): void {
    if (this.invalid || !object(value)) return;
    if (value.error != null) { this.invalid = true; this.pending.clear(); return; }
    if (!Array.isArray(value.candidates)) return;
    if (value.candidates.length > candidateLimit) { this.invalid = true; this.pending.clear(); return; }
    for (const candidate of value.candidates) {
      const next = googleField(candidate, "continuationToken", "continuation_token");
      if (next == null) continue;
      if (!token(next) || googleField(candidate, "finishReason", "finish_reason") !== "CONTINUATION") {
        this.invalid = true; this.pending.clear(); return;
      }
      if (!this.published.has(next)) this.pending.add(next);
    }
    if (this.pending.size + this.published.size > candidateLimit) { this.invalid = true; this.pending.clear(); }
  }

  private async flush(): Promise<void> {
    if (this.invalid || !this.pending.size) return;
    this.signal.throwIfAborted();
    if (!this.owner || this.owner.grantKey && !this.owner.lineage) throw unavailable();
    const owner = await this.bound(this.owner), values = [...this.pending];
    // The existing store accepts at most two keys per atomic registration.
    for (let index = 0; index < values.length; index += 2) {
      this.signal.throwIfAborted();
      const pair = values.slice(index, index + 2);
      const result = await call<{ outcome: string }>(this.env, this.scope, { action: "register", keys: await Promise.all(pair.map(key)), owner }, this.signal);
      if (result.outcome !== "stored") throw unavailable();
      for (const value of pair) { this.published.add(value); this.pending.delete(value); }
    }
  }
}

function unavailable(): HttpError { return new HttpError(503, "google_continuation_unavailable", "Google continuation ownership could not be recorded; automatic continuation is unavailable"); }
async function call<T>(env: Env, scope: string, input: unknown, signal: AbortSignal): Promise<T> {
  try { return await authorityCall<T>(env, "/http-continuations", input, scope, AbortSignal.any([signal, AbortSignal.timeout(5000)])); }
  catch { throw unavailable(); }
}
