import { sessionPolicies, sessionPolicyIdentity, verifiedAccessSession } from "./access.ts";
import { authorityCall } from "./authority.ts";
import type { ContinuationOwner } from "./continuation-store.ts";
import { backgroundCall } from "./http-background.ts";
import { continuationScope, identityKey } from "./http-continuation.ts";
import { HttpOperation } from "./http-operation.ts";
import { assertProviderAccess, providerById } from "./providers.ts";
import { authenticateProxyKey } from "./proxy-auth.ts";
import { observeUsage, proxyResponseHeaders } from "./proxy-response.ts";
import { responseIdentity } from "./response-identities.ts";
import { dispatchResponseControl, retainedResponseRoute } from "./responses-control-dispatch.ts";
import { responsesControlQuery, type ResponsesControlAction } from "./responses-lifecycle.ts";
import type { AccessSession, AuthorizedIdentity, Env } from "./types.ts";
import { errorResponse, HttpError } from "./utils.ts";

type Association = { id: string; closed: boolean; stream: boolean };
type Binding = { owner: ContinuationOwner; background: Association | null; auth: AuthorizedIdentity; scope: string };

export async function proxyResponseControl(request: Request, env: Env, action: ResponsesControlAction, responseId: string,
  queryInput: URLSearchParams | Record<string, unknown>, mode: "proxy_key" | "access", providerId?: string, endpointId?: string,
  preauthenticated?: AuthorizedIdentity, verifiedSession?: AccessSession): Promise<Response> {
  let identities: AuthorizedIdentity[];
  if (mode === "proxy_key") {
    const identity = preauthenticated ?? await authenticateProxyKey(request.headers, env);
    if (identity instanceof Response) return identity;
    identities = [identity];
  } else {
    const session = verifiedSession ?? await verifiedAccessSession(request, env);
    if (!session) return errorResponse("access_session_required", "a verified session is required", 401);
    // Controls never shop today's grant pools. Search only the caller's current
    // policy scopes, and require exactly one original authorized ownership fact.
    identities = (await sessionPolicies(session, env)).map(entry => sessionPolicyIdentity(session, entry));
  }
  const identity = responseIdentity("response", responseId);
  if (!identity) throw new HttpError(400, "response_id_required", "response ID is required");
  const query = responsesControlQuery(action, queryInput), operation = new HttpOperation(request.signal, 10_000);
  let response: Response | undefined;
  try {
    const key = await identityKey(identity), matches: Binding[] = [];
    for (const auth of identities) {
      const scope = await continuationScope(auth);
      const result = await operation.wait(authorityCall<{ owners: Array<ContinuationOwner | null>; background?: Array<Association | null> }>(env, "/http-continuations", { action: "resolve", keys: [key] }, scope, operation.signal));
      const owner = result.owners[0];
      if (!owner || owner.policyGeneration !== auth.policy.generation || providerId && owner.providerId !== providerId || endpointId && owner.endpointId !== endpointId) continue;
      if (auth.policy.providers.length && !auth.policy.providers.includes(owner.providerId)) continue;
      matches.push({ owner, auth, scope, background: result.background?.[0] ?? null });
    }
    if (matches.length !== 1) throw new HttpError(409, "response_owner_unavailable", "exactly one current authorized response owner is required");
    const binding = matches[0], provider = providerById(binding.owner.providerId);
    const create = provider?.endpoints.find(endpoint => endpoint.id === binding.owner.endpointId);
    if (!provider || !create?.responsesLifecycle || create.path_params.length) throw new HttpError(409, "response_owner_unavailable", "the original response route is unavailable");
    await operation.wait(assertProviderAccess(provider, binding.auth, env));
    response = await operation.wait(dispatchResponseControl(env, {
      owner: binding.owner, responseId, action, query: query.toString(), stream: binding.background?.stream === true,
      route: retainedResponseRoute({}, request.headers),
    }, operation.signal), "upstream", late => { void late.body?.cancel().catch(() => undefined); });
    operation.retireDeadline();
    // A control response observes the existing generation only. Closed/evicted
    // summaries never mint new accounting, reservations, or response bindings.
    const association = binding.background;
    const inspection = response.ok && association && !association.closed ? {
      async push() {}, async end() {},
      async observe(fact: import("./token-usage.ts").ResponsesObservation) {
        if (fact.id !== responseId) throw new HttpError(502, "response_identity_conflict", "control returned a different response identity");
        await backgroundCall(env, binding.scope, { action: "observe", id: association.id, fact, statusCode: response!.status });
      },
    } : undefined;
    const observed = observeUsage(response, operation, inspection, create.response_format);
    const headers = proxyResponseHeaders(response, provider.id);
    headers.set("x-clawrouter-content-retention", "off");
    return new Response(observed.response.body, { status: response.status, statusText: response.statusText, headers });
  } catch (error) {
    operation.stop("upstream", error); void response?.body?.cancel().catch(() => undefined);
    throw error instanceof HttpError ? error : new HttpError(503, "response_owner_unavailable", "response control is unavailable; retry without creating another generation");
  }
}
