import { policyRequestCost } from "../shared/request-pricing.ts";
import { readMiniMaxSearchBinding } from "../shared/minimax-search-binding.ts";
import { validateBudgetReservation } from "./accounting.ts";
import { estimateCost } from "./proxy-accounting.ts";
import { softBudgetPolicy } from "./soft-budget.ts";
import { resolveConnection } from "./authority.ts";
import { inspectGrantCredentials } from "./grant-credentials.ts";
import { filterGrantCandidates, grantRoutingPolicy } from "./grant-selection.ts";
import { miniMaxSearchDenied, miniMaxSearchIdentity, miniMaxSearchRequirement } from "./minimax-search-credential.ts";
import type { MiniMaxSearchOperation } from "./minimax-search-operation.ts";
import { miniMaxApiKeySecret } from "./native-media-credential.ts";
import { assertPolicyModel } from "./policy-models.ts";
import type { GrantRequirement } from "./provider-auth.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import type { UpstreamAuth } from "./providers.ts";
import { assertControlCallerLive, authorizeResponseControl, publicControlAuthorization } from "./response-control-authorization.ts";
import type { AuthorizedIdentity, Env, UpstreamGrant } from "./types.ts";

export async function revalidateMiniMaxSearchOwner(env: Env, auth: AuthorizedIdentity, requirement: GrantRequirement,
  key: string, grant: UpstreamGrant, operation: MiniMaxSearchOperation): Promise<UpstreamGrant> {
  if (!miniMaxSearchRequirement(requirement)) miniMaxSearchDenied();
  const original = miniMaxSearchIdentity(grant), caller = publicControlAuthorization(auth), signal = operation.operation.signal;
  const owner = { providerId: "minimax", endpointId: requirement.endpoint.id, grantKey: key,
    lineage: grant.credentialLineage!, routeSha256: "minimax.search:token-plan", policyGeneration: auth.policy.generation };
  const connection = await resolveConnection(env, "minimax", undefined, operation);
  if (!connection?.enabled) miniMaxSearchDenied();
  const policy = await authorizeResponseControl(env, caller, owner, signal, undefined, undefined, operation);
  if (!policy) miniMaxSearchDenied();
  assertPolicyModel(policy, { endpoint: requirement.endpoint, capability: "search.web", model: null });
  // A principal override can become enforced without changing policy generation.
  // Repeat the existing model-less price guard on this fresh policy/connection,
  // before any credential materialization. Query text cannot qualify Search USD.
  if (!softBudgetPolicy(policy)) validateBudgetReservation("search.web",
    estimateCost(null, {}, policyRequestCost(policy, "search.web"), "search.web", requirement.endpoint, undefined, undefined, "minimax"),
    policy.monthlyBudgetMicros, connection, policy.dailyBudgetMicros, policy.limitHint, policy.weeklyBudgetMicros);
  operation.pin(JSON.stringify([key, original, requirement.endpoint.id, requirement.provider.base_urls.default,
    policy.budgetMode ?? "reserve", policy.budgetScope ?? null, policy.dailyBudgetMicros ?? null,
    policy.weeklyBudgetMicros ?? null, policy.monthlyBudgetMicros ?? null, policyRequestCost(policy, "search.web"), connection.monthlyBudgetMicros ?? null]));
  // Caller/policy work completes first. This is the final awaited owner read;
  // only synchronous identity/deadline checks remain before POST construction.
  const current = await inspectGrantCredentials(env, key, signal, undefined, operation);
  signal.throwIfAborted(); assertControlCallerLive(caller);
  if (miniMaxSearchIdentity(current) !== original || !filterGrantCandidates("minimax", [{ key, grant: current, runtimeState: null }],
    new Set(), grantRoutingPolicy(policy.grantRouting), key, requirement, Date.now()).available.length) miniMaxSearchDenied();
  auth.policy = policy;
  return current;
}

export function prepareMiniMaxSearchDispatch(env: Env, auth: AuthorizedIdentity, selection: ProxySelection,
  upstream: UpstreamAuth, destination: URL, headers: Headers, operation: MiniMaxSearchOperation): () => Promise<void> {
  const requirement = { provider: selection.provider, endpoint: selection.endpoint, mode: "http" as const, model: null };
  const grant = upstream.grant, key = upstream.grantKey, binding = readMiniMaxSearchBinding(grant?.minimaxSearchBinding);
  if (!grant || !key || !binding || !miniMaxSearchRequirement(requirement) || upstream.transport !== null
    || upstream.baseUrl !== binding.origin || destination.href !== `${binding.origin}/v1/coding_plan/search`
    || upstream.query.size || Object.keys(selection.pathParams).length || selection.model !== null || selection.capability !== "search.web"
    || !miniMaxApiKeySecret(grant) || headers.get("authorization") !== `Bearer ${miniMaxApiKeySecret(grant)}`) miniMaxSearchDenied();
  return async () => { await revalidateMiniMaxSearchOwner(env, auth, requirement, key, grant, operation); };
}
