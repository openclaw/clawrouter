import { publicSession, sessionPolicies, verifiedAccessSession } from "./access";
import { adminApi } from "./admin";
import {
  avatarResponse, catalogResponse, entitlementResponse, meResponse, modelsResponse, sessionResponse,
} from "./discovery";
import { budgetStatus, BudgetLedgerObject, queue, UsageLedgerObject, usageSnapshot, usageSnapshots } from "./ledgers";
import { oauthCallback } from "./oauth";
import { routeCatalog, snapshot } from "./providers";
import { authenticateProxyKey, inspectKey, proxyManifest, proxyNative, proxyOpenAi } from "./proxy";
import type { Env, QueueMessage } from "./types";
import {
  canonicalPath, caughtResponse, corsEnabled, corsPreflight, errorResponse, legacyRedirect,
  privateJson, redirect, withCors,
} from "./utils";

export { PolicyBindingIndexObject } from "./authority";
export { BudgetLedgerObject, UsageLedgerObject };

const handler: ExportedHandler<Env, QueueMessage> = {
  async fetch(request, env, context) {
    try {
      const response = await route(request, env, context);
      return corsEnabled(canonicalPath(new URL(request.url).pathname)) ? withCors(response) : response;
    } catch (error) { return caughtResponse(error); }
  },
  queue,
};

export default handler;

async function route(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
  const url = new URL(request.url), rawPath = url.pathname, path = canonicalPath(rawPath);
  if (request.method === "OPTIONS" && corsEnabled(path)) return corsPreflight();
  if (request.method === "GET" && rawPath === "/") return redirect(`/dashboard${url.search}`);
  if (request.method === "GET" && rawPath === "/dashboard") return redirect(`/dashboard/home${url.search}`);
  if (request.method === "GET") { const target = legacyRedirect(rawPath); if (target) return redirect(`${target}${url.search}`); }
  if (request.method === "GET" && rawPath.startsWith("/assets/")) return env.ASSETS.fetch(request);
  if (request.method === "GET" && rawPath.startsWith("/dashboard/")) return dashboardShell(request, env);
  if (request.method === "GET" && ["/favicon.ico", "/favicon.svg"].includes(rawPath)) return env.ASSETS.fetch(request);

  if (request.method === "GET" && path === "/v1") return Response.json(serviceIndex());
  if (request.method === "GET" && path === "/v1/health") return Response.json({ ok: true, service: "clawrouter-edge", runtime: "typescript" });
  if (request.method === "GET" && path === "/v1/providers") return Response.json(snapshot);
  if (request.method === "GET" && path === "/v1/routes") return Response.json(routeCatalog());
  if (request.method === "GET" && path === "/v1/session") return sessionResponse(request, env);
  if (request.method === "GET" && path === "/v1/session/avatar") return avatarResponse(request, env);
  if (request.method === "GET" && path === "/v1/entitlements") return entitlementResponse(request, env);
  if (request.method === "GET" && path === "/v1/session/usage") return sessionUsage(request, env);
  if (request.method === "GET" && path === "/v1/me") return meResponse(request, env);
  if (request.method === "GET" && path === "/v1/usage") return userUsage(request, env);
  if (request.method === "GET" && path === "/v1/models") return modelsResponse(request, env);
  if (request.method === "GET" && path === "/v1/catalog") return catalogResponse(request, env);
  if (request.method === "GET" && path === "/v1/oauth/callback") return oauthCallback(request, env);
  if (path.startsWith("/v1/admin/")) return adminApi(request, env, path);
  if (request.method === "GET" && path === "/v1/key/inspect") return inspectKey(request.headers, env);

  if (request.method === "POST" && path.startsWith("/v1/playground/")) {
    if (!sameOrigin(request)) return errorResponse("access_csrf_required", "same-origin playground request required", 403);
    const suffix = path.slice("/v1/playground".length);
    if (openAiPath(suffix)) return proxyOpenAi(request, env, context, suffix, "access");
    if (suffix.startsWith("/proxy/")) return proxyManifest(request, env, context, `/v1${suffix}`, "access");
  }
  if (request.method === "POST" && openAiPath(path)) return proxyOpenAi(request, env, context, path, "proxy_key");
  if (request.method === "POST" && ["/v1/messages", "/v1/messages/count_tokens"].includes(path)) return proxyNative(request, env, context, `/v1/native/anthropic${path}`);
  if (path.startsWith("/v1/proxy/")) return proxyManifest(request, env, context, path, "proxy_key");
  if (path.startsWith("/v1/native/")) return proxyNative(request, env, context, path);
  return errorResponse("route_not_found", "route not found", 404);
}

async function dashboardShell(request: Request, env: Env): Promise<Response> {
  const session = await verifiedAccessSession(request, env);
  if (!session) return errorResponse("access_session_required", "a verified Cloudflare Access session is required", 401);
  const url = new URL(request.url); url.pathname = "/";
  const response = await env.ASSETS.fetch(new Request(url, request));
  const headers = new Headers(response.headers); headers.set("cache-control", "private, no-store");
  return new Response(response.body, { status: response.status, headers });
}

async function userUsage(request: Request, env: Env): Promise<Response> {
  const auth = await authenticateProxyKey(request.headers, env);
  if (auth instanceof Response) return auth;
  return privateJson({ policyId: auth.policyId, budget: await budgetStatus(env, auth.policyId, auth.policy), usage: await usageSnapshot(env, auth.policy.tenantId ?? "default", auth.policyId) });
}

async function sessionUsage(request: Request, env: Env): Promise<Response> {
  const session = await verifiedAccessSession(request, env);
  if (!session) return errorResponse("access_session_required", "a verified Cloudflare Access session is required", 401);
  const policies = await sessionPolicies(session, env);
  const usage = await usageSnapshots(env, policies.map((entry) => ({ policyId: entry.policyId, tenantId: entry.policy.tenantId ?? session.tenantId })));
  const policyRows = await Promise.all(policies.map(async (entry) => ({ policyId: entry.policyId, kid: entry.policyId, tenantId: entry.policy.tenantId ?? session.tenantId, enabled: entry.policy.enabled, providers: entry.policy.providers, tokenRole: entry.policy.tokenRole ?? null, monthlyBudgetMicros: entry.policy.monthlyBudgetMicros ?? null, requestCostMicros: entry.policy.requestCostMicros ?? null, budget: await budgetStatus(env, entry.policyId, entry.policy) })));
  return privateJson({ session: publicSession(session), policies: policyRows, usage });
}

function sameOrigin(request: Request): boolean { const url = new URL(request.url), origin = request.headers.get("origin"), site = request.headers.get("sec-fetch-site"); return origin === url.origin || (!origin && (!site || ["same-origin", "same-site", "none"].includes(site))); }
function openAiPath(path: string): boolean { return ["/v1/chat/completions", "/v1/responses", "/v1/embeddings"].includes(path); }

function serviceIndex() {
  return {
    ok: true, service: "clawrouter-edge", runtime: "typescript",
    interface: { root: "/", dashboard: "/dashboard", playground: "/dashboard/playground", admin: "/dashboard/access", account: "/dashboard/users" },
    endpoints: {
      health: "/v1/health", providers: "/v1/providers", routes: "/v1/routes", session: "/v1/session", entitlements: "/v1/entitlements",
      sessionUsage: "/v1/session/usage", me: "/v1/me", usage: "/v1/usage", models: "/v1/models", catalog: "/v1/catalog",
      anthropicMessages: "/v1/messages", anthropicCountTokens: "/v1/messages/count_tokens", keyInspect: "/v1/key/inspect",
      adminBootstrap: "/v1/admin/bootstrap", adminOverview: "/v1/admin/overview", adminUsers: "/v1/admin/users", adminUsage: "/v1/admin/usage", adminPolicies: "/v1/admin/policies",
      adminCredentials: "/v1/admin/credentials", adminConnections: "/v1/admin/connections", adminAccessUsers: "/v1/admin/access-users",
      adminAssignmentRules: "/v1/admin/assignment-rules", oauthCallback: "/v1/oauth/callback",
      openaiCompatible: ["/v1/chat/completions", "/v1/responses", "/v1/embeddings"], manifestProxy: "/v1/proxy/{provider}/{endpoint}", nativeProxy: "/v1/native/{provider}/{provider-native-path}",
    },
  };
}
