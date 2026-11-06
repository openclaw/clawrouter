import { assertMiniMaxVideoInlineOwner } from "./minimax-video-inline.ts";
import { policyRequestCost } from "../shared/request-pricing.ts";
import { readMiniMaxVideoBinding } from "../shared/minimax-video-binding.ts";
import { validateBudgetReservation } from "./accounting.ts";
import { resolveConnection } from "./authority.ts";
import { inspectGrantCredentials } from "./grant-credentials.ts";
import { filterGrantCandidates, grantRoutingPolicy } from "./grant-selection.ts";
import { miniMaxVideoDenied, miniMaxVideoIdentity, miniMaxVideoRequirement } from "./minimax-video-credential.ts";
import { videoJsonBytes, type MiniMaxVideoOperation } from "./minimax-video-operation.ts";
import { miniMaxApiKeySecret } from "./native-media-credential.ts";
import { assertPolicyModel } from "./policy-models.ts";
import { estimateCost } from "./proxy-accounting.ts";
import type { GrantRequirement } from "./provider-auth.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import type { UpstreamAuth } from "./providers.ts";
import { assertControlCallerLive, authorizeResponseControl, publicControlAuthorization } from "./response-control-authorization.ts";
import type { AuthorizedIdentity, Env, UpstreamGrant } from "./types.ts";
import { HttpError, sha256Hex } from "./utils.ts";

export async function revalidateMiniMaxVideoOwner(env: Env, auth: AuthorizedIdentity, requirement: GrantRequirement,
  key: string, grant: UpstreamGrant, operation: MiniMaxVideoOperation): Promise<UpstreamGrant> {
  if (!miniMaxVideoRequirement(requirement)) miniMaxVideoDenied();
  const model = requirement.provider.models.find(row => row.upstream === requirement.model && row.capabilities.includes("media.predict"));
  if (!model) miniMaxVideoDenied();
  const inputContext = [auth.credentialId, auth.principalId, auth.policyId, auth.policy.tenantId,
    requirement.provider.id, requirement.endpoint.id, model.id, model.upstream];
  assertMiniMaxVideoInlineOwner(operation, readMiniMaxVideoBinding(grant.minimaxVideoBinding), inputContext, [key, miniMaxVideoIdentity(grant)]);
  const original = miniMaxVideoIdentity(grant), caller = publicControlAuthorization(auth), signal = operation.controlSignal;
  const owner = { providerId: "minimax", endpointId: requirement.endpoint.id, grantKey: key,
    lineage: grant.credentialLineage!, routeSha256: "minimax.video:v1", policyGeneration: auth.policy.generation };
  const connection = await resolveConnection(env, "minimax", undefined, undefined, operation);
  if (!connection?.enabled) miniMaxVideoDenied();
  const policy = await authorizeResponseControl(env, caller, owner, signal, undefined, undefined, undefined, operation);
  if (!policy) miniMaxVideoDenied();
  assertPolicyModel(policy, { endpoint: requirement.endpoint, capability: "media.predict", model });
  const fixed = policyRequestCost(policy, "media.predict");
  // Managed admission needs a deliberate tariff. A model card does not price a job.
  if (fixed == null || !Number.isSafeInteger(fixed) || fixed < 0) throw new HttpError(400, "pricing_required", "managed video requires an explicit policy-fixed tariff");
  validateBudgetReservation("media.predict", estimateCost(model, {}, fixed, "media.predict", requirement.endpoint),
    policy.monthlyBudgetMicros, connection, policy.dailyBudgetMicros, policy.limitHint, policy.weeklyBudgetMicros);
  operation.pin([key, original, requirement.endpoint.id, model.id, policy.generation,
    policy.budgetMode ?? "reserve", policy.budgetScope ?? null, policy.dailyBudgetMicros ?? null,
    policy.weeklyBudgetMicros ?? null, policy.monthlyBudgetMicros ?? null, fixed, connection.monthlyBudgetMicros ?? null]);
  // All policy and pricing awaits precede this original-owner read.
  const current = await inspectGrantCredentials(env, key, signal, undefined, undefined, operation);
  signal.throwIfAborted(); assertControlCallerLive(caller);
  if (miniMaxVideoIdentity(current) !== original || !filterGrantCandidates("minimax", [{ key, grant: current, runtimeState: null }],
    new Set(), grantRoutingPolicy(policy.grantRouting), key, requirement, Date.now()).available.length) miniMaxVideoDenied();
  assertMiniMaxVideoInlineOwner(operation, readMiniMaxVideoBinding(current.minimaxVideoBinding), inputContext, [key, miniMaxVideoIdentity(current)]);
  operation.setCurrentConnection(connection);
  auth.policy = policy;
  return current;
}

export function prepareMiniMaxVideoDispatch(env: Env, auth: AuthorizedIdentity, selection: ProxySelection,
  upstream: UpstreamAuth, destination: URL, headers: Headers, operation: MiniMaxVideoOperation): () => Promise<void> {
  const requirement = { provider: selection.provider, endpoint: selection.endpoint, mode: "http" as const,
    model: selection.model?.upstream, managedLifecycle: true };
  const grant = upstream.grant, key = upstream.grantKey, binding = readMiniMaxVideoBinding(grant?.minimaxVideoBinding);
  if (!grant || !key || !binding || !miniMaxVideoRequirement(requirement) || upstream.transport !== null
    || upstream.baseUrl !== binding.origin || destination.href !== `${binding.origin}/v1/video_generation`
    || upstream.query.size || Object.keys(selection.pathParams).length || selection.capability !== "media.predict"
    || !miniMaxApiKeySecret(grant) || headers.get("authorization") !== `Bearer ${miniMaxApiKeySecret(grant)}`) miniMaxVideoDenied();
  return async () => { await revalidateMiniMaxVideoOwner(env, auth, requirement, key, grant, operation); };
}

// Appended only to the existing Hailuo route digest. No new durable authority field.
export async function miniMaxVideoRouteComponent(grant: UpstreamGrant | null, key: string | null, model: string | undefined): Promise<unknown[]> {
  const binding = readMiniMaxVideoBinding(grant?.minimaxVideoBinding), secret = grant && miniMaxApiKeySecret(grant);
  if (!grant || !key || !binding || !secret || !binding.models.some(value => value === model)) miniMaxVideoDenied();
  const identity = miniMaxVideoIdentity(grant);
  videoJsonBytes([key, identity, model, secret]);
  return ["clawrouter.minimax-video-route.v1", key, identity, model, await sha256Hex(secret)];
}
