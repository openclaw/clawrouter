import { buildCodexCatalog, type CodexModelsResponse } from "../shared/codex-catalog.ts";
import { catalogForProxyIdentity } from "./discovery.ts";
import { HotCache, hotCacheConfig, hotCacheNow, registerHotCache } from "./hot-cache.ts";
import { HttpOperation } from "./http-operation.ts";
import { assertSingleOpenAiAccount } from "./openai-public-account.ts";
import { authenticateProxyKey } from "./proxy-auth.ts";
import { assertProviderAccess, providerById, snapshot, upstreamAuth } from "./providers.ts";
import type { Env } from "./types.ts";
import { HttpError, privateJson, sha256Hex } from "./utils.ts";

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_CACHED_BYTES = 2 * 1024 * 1024;
// At most 8 MiB of serialized, caller-scoped metadata per isolate. No shared
// cache, credential material, response streams or cross-request promises.
const catalogs = registerHotCache(new HotCache<{ json: string; expires: number }>(4));
type CatalogFailureReason = "upstream_http" | "upstream_timeout" | "upstream_transport" | "upstream_body"
  | "invalid_content_type" | "missing_body" | "body_too_large" | "invalid_utf8" | "invalid_json" | "invalid_schema"
  | "projection_failed" | "internal";
class CatalogFailure extends Error {
  readonly reason: CatalogFailureReason;
  readonly transient: boolean;
  readonly upstreamStatus?: number;
  constructor(reason: CatalogFailureReason, transient = false, upstreamStatus?: number) {
    super("Codex metadata request failed");
    this.reason = reason; this.transient = transient; this.upstreamStatus = upstreamStatus;
  }
}
function unavailable(error: unknown): HttpError {
  // Authenticated diagnostics only: fixed labels and numeric status, never an
  // upstream body, header, URL, credential or arbitrary exception message.
  const failure = error instanceof CatalogFailure ? error : undefined;
  return new HttpError(502, "codex_catalog_unavailable", "current Codex model metadata is unavailable; no usable private catalog remains", {
    "cache-control": "no-store", "x-content-type-options": "nosniff",
    "x-clawrouter-catalog-failure": failure?.reason ?? "internal",
    ...(failure?.upstreamStatus === undefined ? {} : { "x-clawrouter-upstream-status": String(failure.upstreamStatus) }),
  });
}

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }

// Validate the fields the router interprets, leaving the rest byte-for-value
// intact for the requesting client's versioned schema, including access programs.
export function parseCodexModels(json: string): CodexModelsResponse {
  let body: unknown;
  try { body = JSON.parse(json); }
  catch { throw new CatalogFailure("invalid_json"); }
  if (!record(body) || !Array.isArray(body.models) || !body.models.length || body.models.length > 2048) throw new CatalogFailure("invalid_schema");
  const slugs = new Set<string>();
  for (const model of body.models) {
    if (!record(model) || typeof model.slug !== "string" || !model.slug || model.slug.length > 512 || slugs.has(model.slug)
      || model.base_instructions != null && typeof model.base_instructions !== "string"
      || model.model_messages != null && (!record(model.model_messages) || model.model_messages.instructions_template != null && typeof model.model_messages.instructions_template !== "string")
      || !model.base_instructions && !(record(model.model_messages) && model.model_messages.instructions_template)
      || [model.context_window, model.max_context_window].some(value => value !== undefined && value !== null && (typeof value !== "number" || !Number.isFinite(value) || value <= 0))
      || model.service_tiers !== undefined && (!Array.isArray(model.service_tiers) || model.service_tiers.some(tier => !record(tier) || typeof tier.id !== "string" || !tier.id))
      || model.additional_speed_tiers !== undefined && (!Array.isArray(model.additional_speed_tiers) || model.additional_speed_tiers.some(tier => typeof tier !== "string"))
      || model.default_service_tier !== undefined && model.default_service_tier !== null && typeof model.default_service_tier !== "string") throw new CatalogFailure("invalid_schema");
    slugs.add(model.slug);
  }
  return body as unknown as CodexModelsResponse;
}

function lifetime(headers: Headers): number {
  const control = headers.get("cache-control") ?? "";
  if (/(?:^|,)\s*(?:no-store|no-cache|must-revalidate|proxy-revalidate)\b/i.test(control)) return 0;
  const match = /(?:^|,)\s*max-age\s*=\s*"?(\d+)"?(?:\s*,|\s*$)/i.exec(control);
  const age = Number(headers.get("age") ?? "0");
  if (!Number.isFinite(age) || age < 0) return 0;
  return Math.max(0, Math.min(60, match ? Number(match[1]) : 60) - age) * 1000;
}

async function upstreamCatalog(request: Request, headers: Headers, version: string): Promise<{ json: string; ttl: number }> {
  const operation = new HttpOperation(request.signal, 15_000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let response: Response | undefined;
  try {
    const url = new URL("https://chatgpt.com/backend-api/codex/models");
    url.searchParams.set("client_version", version);
    headers.set("accept", "application/json");
    try {
      response = await operation.wait(fetch(url, { headers, redirect: "manual", signal: operation.signal }), undefined,
        late => { void late.body?.cancel().catch(() => {}); });
    } catch { throw new CatalogFailure(operation.status === "timeout" ? "upstream_timeout" : "upstream_transport", true); }
    if (!response.ok) throw new CatalogFailure("upstream_http", response.status === 429 || response.status >= 500);
    const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    if (type !== "application/json") throw new CatalogFailure("invalid_content_type");
    if (!response.body) throw new CatalogFailure("missing_body");
    if (Number(response.headers.get("content-length")) > MAX_BYTES) throw new CatalogFailure("body_too_large");
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await operation.wait(reader.read()); }
      catch { throw new CatalogFailure(operation.status === "timeout" ? "upstream_timeout" : "upstream_body", true); }
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BYTES) throw new CatalogFailure("body_too_large");
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    let json: string;
    try { json = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new CatalogFailure("invalid_utf8"); }
    // An invalid response is never a new fallback generation.
    parseCodexModels(json);
    return { json, ttl: lifetime(response.headers) };
  } catch (error) {
    if (error instanceof CatalogFailure) throw new CatalogFailure(error.reason, error.transient, response?.status);
    throw error;
  } finally {
    operation.stop("upstream");
    // Cancellation can be ignored by a hostile source. Do not await its promise.
    if (reader) void reader.cancel().catch(() => {});
    else void response?.body?.cancel().catch(() => {});
  }
}

export async function codexModelsResponse(request: Request, env: Env): Promise<Response> {
  const auth = await authenticateProxyKey(request.headers, env, snapshot.providers.map(provider => ({ id: provider.id, tokenRef: provider.auth.schemes.find(scheme => scheme.type === "oauth")?.tokenRef ?? provider.id })), true);
  if (auth instanceof Response) return auth;
  const params = new URL(request.url).searchParams;
  const version = params.get("client_version");
  if (params.getAll("client_version").length !== 1 || !version || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(version)
    || [...params.keys()].some(key => !["client_version", "standalone_search"].includes(key))
    || params.getAll("standalone_search").length > 1 || params.has("standalone_search") && params.get("standalone_search") !== "true") throw new HttpError(400, "codex_catalog_query_invalid", "one release client_version (major.minor.patch) is required; optional standalone_search must be true");
  const provider = providerById("openai")!;
  await assertProviderAccess(provider, auth, env);
  const catalog = await catalogForProxyIdentity(auth, env);
  if (!catalog.providers.find(item => item.id === "openai")?.offers.some(offer => offer.eligible && offer.modelId && offer.routeKind === "native"
    && offer.endpoint === "responses" && offer.transport === "http")) throw new HttpError(403, "codex_models_not_allowed", "no native OpenAI Responses model is currently eligible");
  const project = (json: string) => {
    const parsed = parseCodexModels(json);
    try {
      const result = buildCodexCatalog(catalog, parsed, "openai");
      if (params.has("standalone_search")) result.catalog.models = result.catalog.models.filter(model => result.standaloneSearchModels.includes(model.slug));
      if (!result.catalog.models.length) throw new CatalogFailure("projection_failed");
      return result.catalog;
    } catch { throw new CatalogFailure("projection_failed"); }
  };
  const endpoint = provider.endpoints.find(endpoint => endpoint.id === "responses")!;
  const upstream = await upstreamAuth(provider, auth, env, new Set(), null, false, undefined, { provider, endpoint, mode: "http" }, request.signal);
  await assertSingleOpenAiAccount(auth, env, upstream, "catalog");
  if (upstream.baseUrl !== "https://api.openai.com" || upstream.query.size || !/^Bearer \S+$/.test(upstream.headers.get("authorization") ?? "")) throw new HttpError(409, "catalog_account_unqualified", "Codex metadata currently requires the public OpenAI API credential lane");
  // Opaque digest only. Rotation, grant revision, caller, policy, routing,
  // pricing, connection changes and client schema cannot share a generation.
  const key = await sha256Hex(JSON.stringify([version, auth.credentialId, auth.principalId, auth.policyId, auth.policy, auth.serviceTiers,
    catalog.providers, upstream.grantKey, upstream.grantRevision, [...upstream.headers], params.get("standalone_search")]));
  const bound = hotCacheConfig(env);
  const config = { maxAgeMs: Math.min(60_000, bound.maxAgeMs), freshMs: Math.min(10_000, bound.freshMs) };
  const cached = catalogs.peek(key, config);
  let json = cached?.fresh ? cached.value.json : undefined;
  if (!json) {
    const publication = catalogs.beginPublication(key);
    const started = hotCacheNow();
    try {
      const loaded = await upstreamCatalog(request, upstream.headers, version);
      project(loaded.json);
      json = loaded.json;
      const expires = started + loaded.ttl;
      if (loaded.ttl && new TextEncoder().encode(json).byteLength <= MAX_CACHED_BYTES) catalogs.publish(key, publication, { json, expires }, config, expires, started);
      else catalogs.delete(key);
    } catch (error) {
      if (request.signal.aborted) throw new HttpError(499, "client_canceled", "catalog request canceled");
      if (error instanceof CatalogFailure && error.transient && cached && cached.value.expires > hotCacheNow()
        && catalogs.peek(key, config)?.value === cached.value) json = cached.value.json;
      else { catalogs.delete(key); throw unavailable(error); }
    } finally { catalogs.endPublication(key, publication); }
  }
  try {
    return privateJson(project(json));
  } catch (error) { throw unavailable(error); }
}
