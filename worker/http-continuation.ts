import { authorityCall } from "./authority.ts";
import type { ContinuationOwner } from "./continuation-store.ts";
import type { PinnedGrant } from "./grant-selection.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import { createResponseIdentityInspector, responseIdentity, type ResponseIdentity } from "./response-identities.ts";
import type { AuthorizedIdentity, Env } from "./types.ts";
import { HttpError, sha256Hex } from "./utils.ts";

export function continuationRestart(): HttpError {
  return new HttpError(409, "continuation_restart_required", "continuation owner is unavailable or changed; restart with full input and omit previous_response_id and x-codex-turn-state");
}

export class HttpContinuation {
  readonly requested: boolean;
  readonly pinned?: PinnedGrant;
  private readonly env: Env;
  private readonly scope: string;
  private readonly previous: ContinuationOwner | null;
  private readonly evidence = new Map<ResponseIdentity["kind"], string>();
  private publishedCount = 0;
  private owner?: ContinuationOwner;

  private constructor(env: Env, scope: string, requested: boolean, owner: ContinuationOwner | null) {
    this.env = env; this.scope = scope; this.requested = requested; this.previous = owner;
    // Environment routes are pinned too: current pool availability cannot prove
    // which credential produced an earlier response.
    this.pinned = !requested ? undefined : owner?.grantKey && owner.lineage
      ? { key: owner.grantKey, lineage: owner.lineage } : { key: null, revision: null };
  }

  static async resolve(request: Request, selection: ProxySelection, auth: AuthorizedIdentity, env: Env): Promise<HttpContinuation | undefined> {
    if (selection.capability !== "llm.responses" || Array.isArray(selection.body)) return undefined;
    const identities = [responseIdentity("response", selection.body.previous_response_id), responseIdentity("turn", request.headers.get("x-codex-turn-state"))].filter((value): value is ResponseIdentity => !!value);
    const scope = `http-continuations:${await sha256Hex(JSON.stringify([auth.authType, auth.policy.tenantId ?? "default", auth.policyId, auth.credentialId, auth.principalId]))}`;
    let owner: ContinuationOwner | null = null;
    if (identities.length) {
      const keys = await Promise.all(identities.map(identityKey));
      const { owners } = await call<{ owners: Array<ContinuationOwner | null> }>(env, scope, { action: "resolve", keys });
      owner = owners[0] ?? null;
      if (!owner || owners.some(value => !value || JSON.stringify(value) !== JSON.stringify(owner)) || owner.providerId !== selection.provider.id || owner.endpointId !== selection.endpoint.id || owner.policyGeneration !== auth.policy.generation) throw continuationRestart();
    }
    return new HttpContinuation(env, scope, identities.length > 0, owner);
  }

  bind(owner: ContinuationOwner): void {
    if (this.previous && JSON.stringify(this.previous) !== JSON.stringify(owner)) throw continuationRestart();
    this.owner = owner;
  }

  async headers(response: Response): Promise<void> {
    const identity = responseIdentity("turn", response.headers.get("x-codex-turn-state"));
    if (identity) this.remember(identity);
    await this.flush();
  }

  async publish(identities: readonly ResponseIdentity[]): Promise<void> {
    for (const identity of identities) this.remember(identity);
    await this.flush();
  }

  inspect(response: Response) {
    const type = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!type.includes("json") && !type.includes("text/event-stream")) return undefined;
    const scanner = createResponseIdentityInspector(type.includes("text/event-stream"), identity => this.remember(identity));
    return {
      push: async (bytes: Uint8Array) => { scanner.push(bytes); await this.flush(); },
      end: async () => { scanner.end(); await this.flush(); },
    };
  }

  private remember(identity: ResponseIdentity): void {
    const previous = this.evidence.get(identity.kind);
    if (previous && previous !== identity.value) throw new HttpError(502, "continuation_identity_conflict", "upstream changed its continuation identity");
    this.evidence.set(identity.kind, identity.value);
  }

  private async flush(): Promise<void> {
    if (!this.owner || this.evidence.size === this.publishedCount) return;
    const keys = await Promise.all([...this.evidence].map(([kind, value]) => identityKey({ kind, value })));
    const { outcome } = await call<{ outcome: string }>(this.env, this.scope, { action: "register", keys, owner: this.owner });
    if (outcome !== "stored") throw new HttpError(503, "continuation_unavailable", outcome === "conflict" ? "upstream continuation ownership conflicts; restart with full input" : "continuation binding capacity is unavailable; retry later with full input");
    this.publishedCount = this.evidence.size;
  }
}

async function identityKey(identity: ResponseIdentity): Promise<string> { return sha256Hex(JSON.stringify([identity.kind, identity.value])); }
async function call<T>(env: Env, scope: string, body: unknown): Promise<T> {
  try { return await authorityCall<T>(env, "/http-continuations", body, scope, AbortSignal.timeout(5000)); }
  catch { throw new HttpError(503, "continuation_unavailable", "continuation authority is unavailable; retry later with full input"); }
}
