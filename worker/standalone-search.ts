import { policyRequestCost } from "../shared/request-pricing.ts";
import { authorityCall } from "./authority.ts";
import type { ContinuationOwner } from "./continuation-store.ts";
import { continuationScope } from "./http-continuation.ts";
import type { PinnedGrant } from "./grant-selection.ts";
import type { AuthorizedIdentity, Env } from "./types.ts";
import { HttpError, sha256Hex } from "./utils.ts";

const commands = new Set(["search_query", "open", "click", "find", "response_length"]);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export const isStandaloneSearch = (endpoint: { request_format: string }): boolean => endpoint.request_format === "openai.standalone_search";
export function searchRestart(): HttpError { return new HttpError(409, "search_restart_required", "search session owner is unavailable or changed; start a new Codex session and search again"); }

// This qualification is deliberately text-only. Do not advertise broader
// web.run feed/media parity merely because the upstream accepts its schema.
export function validateStandaloneSearch(body: Record<string, unknown>): void {
  const invalid = () => { throw new HttpError(400, "invalid_search_request", "search requires a bounded session id and nonempty text search, open, click, or find commands"); };
  if (typeof body.id !== "string" || !body.id.trim() || body.id.length > 256 || !object(body.commands)) invalid();
  if (body.stream !== undefined || body.background !== undefined) invalid();
  const requested = body.commands as Record<string, unknown>;
  if (Object.keys(requested).some(key => !commands.has(key))) throw new HttpError(400, "unsupported_search_command", "standalone search currently supports search_query, open, click, and find only");
  let count = 0;
  for (const name of ["search_query", "open", "click", "find"]) {
    const operations = requested[name];
    if (operations === undefined) continue;
    if (!Array.isArray(operations) || !operations.length || operations.length > 8) invalid();
    for (const operation of operations as unknown[]) {
      if (!object(operation)) { invalid(); continue; }
      const value = operation[name === "search_query" ? "q" : "ref_id"];
      if (typeof value !== "string" || !value.trim() || value.length > 8192) invalid();
      if (name === "click" && (!Number.isSafeInteger(operation.id) || (operation.id as number) < 0)) invalid();
      if (name === "find" && (typeof operation.pattern !== "string" || !operation.pattern.length)) invalid();
      count++;
    }
  }
  if (!count) invalid();
}

export function assertSearchTariff(auth: AuthorizedIdentity): void {
  if (policyRequestCost(auth.policy, "search.web") == null) throw new HttpError(400, "pricing_required", "standalone search requires an explicit fixed search.web tariff (requestCostsMicros or requestCostMicros); measured upstream search usage is unavailable");
}

// One metadata row per caller/session. Reuse the existing authority's atomic
// owner registration; no prompts, results, reference lists or ciphertext stored.
export class SearchSession {
  readonly pinned?: PinnedGrant;
  private readonly env: Env;
  private readonly scope: string;
  private readonly key: string;
  private readonly previous: ContinuationOwner | null;
  private constructor(env: Env, scope: string, key: string, previous: ContinuationOwner | null) {
    this.env = env; this.scope = scope; this.key = key; this.previous = previous;
    this.pinned = previous ? previous.grantKey && previous.lineage ? { key: previous.grantKey, lineage: previous.lineage } : { key: null, revision: null } : undefined;
  }
  static async resolve(env: Env, auth: AuthorizedIdentity, body: Record<string, unknown>, endpointId: string): Promise<SearchSession> {
    assertSearchTariff(auth);
    const scope = await continuationScope(auth), key = await sha256Hex(JSON.stringify(["standalone-search-v1", body.id]));
    const { owners } = await searchAuthority<{ owners: (ContinuationOwner | null)[] }>(env, scope, { action: "resolve", keys: [key] });
    const previous = owners[0] ?? null;
    if (previous && (previous.providerId !== "openai" || previous.endpointId !== endpointId || previous.policyGeneration !== auth.policy.generation)) throw searchRestart();
    const requested = body.commands as Record<string, unknown>;
    const hasReference = ["open", "click", "find"].some(name => (requested[name] as Record<string, unknown>[] | undefined)?.some(operation => !/^https?:\/\//i.test(operation.ref_id as string)));
    if (!previous && hasReference) throw searchRestart();
    return new SearchSession(env, scope, key, previous);
  }
  async bind(owner: ContinuationOwner): Promise<string> {
    if (this.previous && JSON.stringify(this.previous) !== JSON.stringify(owner)) throw searchRestart();
    const result = await searchAuthority<{ outcome: string }>(this.env, this.scope, { action: "register", keys: [this.key], owner });
    if (result.outcome === "conflict") throw searchRestart();
    if (result.outcome !== "stored") throw unavailable();
    // Owner identity also separates a namespace after local metadata expiry.
    const digest = await sha256Hex(JSON.stringify(["standalone-search-v1", this.scope, this.key, owner]));
    return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
  }
  preflightError(error: unknown): unknown {
    return this.previous && error instanceof HttpError && ["upstream_grant_pool_unavailable", "upstream_grant_changed", "grant_reauthorization_required", "grant_disabled", "grant_credential_missing", "provider_not_configured", "grant_transport_unavailable"].includes(error.code) ? searchRestart() : error;
  }
}
function unavailable(): HttpError { return new HttpError(503, "search_state_unavailable", "search session ownership is unavailable; retry later"); }
async function searchAuthority<T>(env: Env, scope: string, body: unknown): Promise<T> {
  try { return await authorityCall<T>(env, "/http-continuations", body, scope, AbortSignal.timeout(5000)); }
  catch { throw unavailable(); }
}
