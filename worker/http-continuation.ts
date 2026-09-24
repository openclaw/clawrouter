import { authorityCall } from "./authority.ts";
import type { ContinuationOwner, EvidenceFinalization, PricingEvidence } from "./continuation-store.ts";
import type { PinnedGrant } from "./grant-selection.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import { createResponseIdentityInspector, responseIdentity, type ResponseIdentity } from "./response-identities.ts";
import { createResponsesToolEvidence, retainedToolBase, type ToolKnowledge } from "./responses-tool-evidence.ts";
import { responseOutcome } from "./token-usage.ts";
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
  private readonly signal: AbortSignal;
  private readonly previous: ContinuationOwner | null;
  private readonly evidence = new Map<ResponseIdentity["kind"], string>();
  private publishedCount = 0;
  private owner?: ContinuationOwner;
  private readonly producerId = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  private readonly tools: ReturnType<typeof createResponsesToolEvidence>;
  private claim: "owned" | "legacy_unknown" | undefined;
  private qualificationAttempted = false;

  private constructor(env: Env, scope: string, requested: boolean, owner: ContinuationOwner | null, base: ToolKnowledge, signal: AbortSignal) {
    this.env = env; this.scope = scope; this.requested = requested; this.previous = owner;
    this.signal = signal;
    this.tools = createResponsesToolEvidence(base);
    // Environment routes are pinned too: current pool availability cannot prove
    // which credential produced an earlier response.
    this.pinned = !requested ? undefined : owner?.grantKey && owner.lineage
      ? { key: owner.grantKey, lineage: owner.lineage } : { key: null, revision: null };
  }

  static async resolve(request: Request, selection: ProxySelection, auth: AuthorizedIdentity, env: Env, transport: "http" | "websocket" = "http"): Promise<HttpContinuation | undefined> {
    if (selection.capability !== "llm.responses" || Array.isArray(selection.body)) return undefined;
    const metadata = transport === "websocket" ? selection.body.client_metadata : null;
    const headerTurn = responseIdentity("turn", request.headers.get("x-codex-turn-state"));
    // Codex reconnects with full input and only this metadata token. Conflicting
    // carriers must never discard an owner check or consume another pool account.
    const metadataTurn = responseIdentity("turn", metadata && typeof metadata === "object" && !Array.isArray(metadata) ? (metadata as Record<string, unknown>)["x-codex-turn-state"] : null);
    if (headerTurn && metadataTurn && headerTurn.value !== metadataTurn.value) throw continuationRestart();
    const identities = [responseIdentity("response", selection.body.previous_response_id), headerTurn ?? metadataTurn].filter((value): value is ResponseIdentity => !!value);
    const scope = `http-continuations:${await sha256Hex(JSON.stringify([auth.authType, auth.policy.tenantId ?? "default", auth.policyId, auth.credentialId, auth.principalId]))}`;
    let owner: ContinuationOwner | null = null;
    let inherited: ToolKnowledge = identities.some(identity => identity.kind === "response") ? "unknown" : "token_only";
    if (identities.length) {
      const keys = await Promise.all(identities.map(identityKey));
      const { owners, evidence } = await call<{ owners: Array<ContinuationOwner | null>; evidence?: Array<PricingEvidence | null> }>(env, scope, { action: "resolve", keys });
      owner = owners[0] ?? null;
      if (!owner || owners.some(value => !value || JSON.stringify(value) !== JSON.stringify(owner)) || owner.providerId !== selection.provider.id || owner.endpointId !== selection.endpoint.id || owner.policyGeneration !== auth.policy.generation) throw continuationRestart();
      const previous = evidence?.[identities.findIndex(identity => identity.kind === "response")];
      if (previous?.state === "final") inherited = previous.knowledge;
    }
    return new HttpContinuation(env, scope, identities.length > 0, owner, retainedToolBase(selection.body, inherited), request.signal);
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

  async publishFrame(identities: readonly ResponseIdentity[], frame: Record<string, unknown>): Promise<void> {
    await this.publish(identities);
    if (this.signal.aborted) return;
    if (responseOutcome(frame) === "provider_error") this.tools.invalid();
    this.tools.accept(frame, true);
    await this.qualify();
  }

  inspect(response: Response) {
    const type = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!type.includes("json") && !type.includes("text/event-stream")) return undefined;
    const scanner = createResponseIdentityInspector(type.includes("text/event-stream"), identity => this.remember(identity));
    return {
      push: async (bytes: Uint8Array) => { scanner.push(bytes); await this.flush(); },
      end: async () => { scanner.end(); await this.flush(); },
      tools: this.tools,
      qualify: () => this.qualify(),
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
    const response = this.evidence.get("response"), responseClaim = response ? { key: await identityKey({ kind: "response", value: response }), producerId: this.producerId } : undefined;
    const { outcome, claim } = await call<{ outcome: string; claim?: "owned" | "legacy_unknown" }>(this.env, this.scope, { action: "register", keys, owner: this.owner, responseClaim });
    if (outcome !== "stored" || responseClaim && claim !== "owned" && claim !== "legacy_unknown") throw unavailable();
    if (responseClaim) this.claim = claim;
    this.publishedCount = this.evidence.size;
  }

  private async qualify(): Promise<void> {
    const proof = this.tools.result();
    if (this.qualificationAttempted || !proof || !this.owner || !this.claim || this.signal.aborted) return;
    this.qualificationAttempted = true;
    if (this.claim === "legacy_unknown") return;
    if (proof.responseId !== this.evidence.get("response")) throw unavailable();
    const key = await identityKey({ kind: "response", value: proof.responseId });
    if (this.signal.aborted) return;
    let result: EvidenceFinalization;
    try {
      result = await authorityCall<EvidenceFinalization>(this.env, "/http-continuations", { action: "qualify", keys: [key], owner: this.owner, responseClaim: { key, producerId: this.producerId }, knowledge: proof.knowledge }, this.scope, AbortSignal.timeout(5000));
    } catch {
      // An acknowledged claim already owns this identity. A lost proof ACK
      // leaves pending/unknown or this producer's committed final fact, never
      // another producer's proof. Delivery and financial accounting still run.
      return;
    }
    // Semantic CAS conflicts must not fall into the transient RPC catch above.
    if (result.outcome !== "qualified" && result.outcome !== "unavailable") throw unavailable();
  }
}

function unavailable(): HttpError { return new HttpError(503, "continuation_unavailable", "upstream continuation ownership could not be recorded; restart with full input"); }

async function identityKey(identity: ResponseIdentity): Promise<string> { return sha256Hex(JSON.stringify([identity.kind, identity.value])); }
async function call<T>(env: Env, scope: string, body: unknown): Promise<T> {
  try { return await authorityCall<T>(env, "/http-continuations", body, scope, AbortSignal.timeout(5000)); }
  catch { throw new HttpError(503, "continuation_unavailable", "continuation authority is unavailable; retry later with full input"); }
}
