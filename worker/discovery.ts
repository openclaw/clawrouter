import { publicSession, sessionPolicies, verifiedAccessSession } from "./access";
import { authenticateProxyKey } from "./proxy";
import { providerReadinessForPolicies, snapshot, type Readiness } from "./providers";
import type { AccessPolicyEntry, AccessSession, AuthorizedIdentity, CompiledProvider, Env } from "./types";
import { errorResponse, privateJson, sha256Hex } from "./utils";

export async function sessionResponse(request: Request, env: Env): Promise<Response> {
  const session = await verifiedAccessSession(request, env);
  if (!session) return errorResponse("access_session_required", "a verified Cloudflare Access session is required", 401);
  let entitlements: { providers: EntitlementRow[] } | undefined;
  let entitlementsError: string | undefined;
  try { entitlements = { providers: await entitlementRows(session, env) }; }
  catch (error) { entitlementsError = error instanceof Error ? error.message : "entitlements unavailable"; }
  return privateJson({ ...publicSession(session), entitlements, entitlementsError, contentRetention: await retentionView(session, env) });
}

export async function entitlementResponse(request: Request, env: Env): Promise<Response> {
  const session = await verifiedAccessSession(request, env);
  if (!session) return errorResponse("access_session_required", "entitlements require a verified Cloudflare Access session", 401);
  return privateJson({ session: publicSession(session), providers: await entitlementRows(session, env), contentRetention: await retentionView(session, env) });
}

export async function avatarResponse(request: Request, env: Env): Promise<Response> {
  const session = await verifiedAccessSession(request, env);
  if (!session) return errorResponse("access_session_required", "avatar access requires a verified Cloudflare Access session", 401);
  const hash = await sha256Hex(session.email.trim().toLowerCase());
  const upstream = await fetch(`https://www.gravatar.com/avatar/${hash}?s=60&d=identicon&r=g`);
  if (!upstream.ok) return new Response(null, { status: 404, headers: { "cache-control": "private, no-store" } });
  const type = upstream.headers.get("content-type")?.split(";")[0] ?? "";
  if (!["image/gif", "image/jpeg", "image/png", "image/webp"].includes(type)) return new Response(null, { status: 502 });
  const bytes = await upstream.arrayBuffer();
  if (bytes.byteLength > 1024 * 1024) return new Response(null, { status: 502 });
  return new Response(bytes, { headers: { "content-type": type, "cache-control": "private, no-store", vary: "cf-access-jwt-assertion" } });
}

export async function modelsResponse(request: Request, env: Env): Promise<Response> {
  const rows = await clientEntitlements(request, env);
  if (rows instanceof Response) return rows;
  const allowed = new Map(rows.filter((row) => row.allowed && row.readiness.executable).map((row) => [row.provider, row.readiness.executableEndpoints]));
  if (request.headers.has("anthropic-version")) {
    const data = snapshot.providers.flatMap((provider) => provider.models.filter((model) => model.capabilities.includes("llm.messages") && executableCapabilities(provider, model.capabilities, allowed.get(provider.id) ?? []).length).map((model) => ({
      id: model.id, type: "model", display_name: `${provider.display_name} · ${model.id}`, created_at: "1970-01-01T00:00:00Z",
      capabilities: null, max_input_tokens: model.pricing?.maxInputTokens ?? null, max_tokens: model.pricing?.defaultMaxOutputTokens ?? null,
    })));
    return privateJson({ data, first_id: data[0]?.id ?? null, has_more: false, last_id: data.at(-1)?.id ?? null });
  }
  const data = snapshot.providers.flatMap((provider) => provider.models.flatMap((model) => {
    const capabilities = executableCapabilities(provider, model.capabilities, allowed.get(provider.id) ?? []);
    return capabilities.length ? [{ id: model.id, object: "model", owned_by: provider.id, display_name: `${provider.display_name} · ${model.id}`, capabilities }] : [];
  }));
  return privateJson({ object: "list", data });
}

export async function catalogResponse(request: Request, env: Env): Promise<Response> {
  const rows = await clientEntitlements(request, env);
  if (rows instanceof Response) return rows;
  const providers = rows.filter((row) => row.allowed).flatMap((row) => {
    const provider = snapshot.providers.find((candidate) => candidate.id === row.provider);
    if (!provider) return [];
    const endpoints = row.readiness.executableEndpoints;
    return [{
      id: provider.id, displayName: provider.display_name, allowed: true, executable: row.readiness.executable,
      openaiCompatible: row.readiness.executable && provider.class === "openai_compatible", nativeBaseUrl: `/v1/native/${provider.id}`,
      policies: row.policies, readiness: row.readiness, connectionTypes: connectionTypes(provider),
      routes: provider.endpoints.filter((endpoint) => endpoint.native_proxy && endpoints.includes(endpoint.id)).map((endpoint) => ({ endpoint: endpoint.id, methods: endpoint.methods, path: endpoint.path, requestFormat: endpoint.request_format, responseFormat: endpoint.response_format, streaming: endpoint.streaming })),
      models: provider.models.flatMap((model) => {
        const capabilities = executableCapabilities(provider, model.capabilities, endpoints);
        return capabilities.length ? [{ id: model.id, upstream: model.upstream, capabilities, pricing_ref: model.pricing_ref, pricing: model.pricing }] : [];
      }),
    }];
  });
  return privateJson({ version: "clawrouter.client-catalog.v1", providers });
}

export async function meResponse(request: Request, env: Env): Promise<Response> {
  const session = await verifiedAccessSession(request, env);
  if (session) return privateJson(publicSession(session));
  const auth = await authenticateProxyKey(request.headers, env);
  if (auth instanceof Response) return auth;
  return privateJson({ authenticated: true, auth: "proxy_key", role: "user", email: auth.principalId, subject: null, tenantId: auth.policy.tenantId ?? "default", groups: [] });
}

interface EntitlementRow {
  provider: string;
  displayName: string;
  serviceKind: string;
  allowed: boolean;
  policies: string[];
  readiness: Readiness;
}

async function entitlementRows(session: AccessSession, env: Env): Promise<EntitlementRow[]> {
  return entitlementRowsForEntries(await sessionPolicies(session, env), env);
}

async function entitlementRowsForEntries(entries: AccessPolicyEntry[], env: Env): Promise<EntitlementRow[]> {
  const readiness = await providerReadinessForPolicies(env, entries);
  return snapshot.providers.map((provider) => {
    const policies = entries.filter((entry) => entry.policy.enabled && (!entry.policy.providers.length || entry.policy.providers.includes(provider.id))).map((entry) => entry.policyId);
    return { provider: provider.id, displayName: provider.display_name, serviceKind: provider.service_kind, allowed: policies.length > 0, policies, readiness: readiness.find((row) => row.id === provider.id)! };
  });
}

async function clientEntitlements(request: Request, env: Env): Promise<EntitlementRow[] | Response> {
  const hasKey = ["authorization", "x-api-key", "x-goog-api-key", "api-key"].some((name) => request.headers.get(name)?.includes("clawrouter-") || request.headers.get(name)?.includes("ocpk_"));
  if (hasKey) {
    const auth = await authenticateProxyKey(request.headers, env);
    if (auth instanceof Response) return auth;
    return entitlementRowsForEntries([{ policyId: auth.policyId, policy: auth.policy }], env);
  }
  const session = await verifiedAccessSession(request, env);
  return session ? entitlementRows(session, env) : errorResponse("client_auth_required", "a valid ClawRouter proxy key or Cloudflare Access session is required", 401);
}

async function retentionView(session: AccessSession, env: Env) {
  const enabledByPolicy = (await sessionPolicies(session, env)).some((entry) => entry.policy.retainRequestContent !== false);
  return { enabled: enabledByPolicy && !session.contentRetentionDisabled, retentionDays: 30, policyEnabled: enabledByPolicy, userExempt: session.contentRetentionDisabled };
}

function executableCapabilities(provider: CompiledProvider, capabilities: string[], endpoints: string[]): string[] {
  return capabilities.filter((capability) => endpoints.includes(provider.capabilities.find((candidate) => candidate.id === capability)?.endpoint ?? ""));
}

function connectionTypes(provider: CompiledProvider): string[] {
  const types = new Set<string>();
  for (const scheme of provider.auth.schemes) {
    if (scheme.type === "oauth") { types.add("oauth"); types.add("subscription"); }
    else if (["bearer", "api_key", "query_api_key"].includes(scheme.type)) { types.add("api_key"); types.add("oauth"); types.add("subscription"); }
    else if (scheme.type === "sig_v4") types.add("api_key");
    else types.add("cloudflare_binding");
  }
  return [...types].sort();
}
