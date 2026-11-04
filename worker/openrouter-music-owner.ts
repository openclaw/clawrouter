import { inspectGrantCredentials } from "./grant-credentials.ts";
import { filterGrantCandidates, grantRoutingPolicy } from "./grant-selection.ts";
import { continuationScope } from "./http-continuation.ts";
import { openRouterMusicModels } from "./openrouter-music.ts";
import { assertPolicyModel } from "./policy-models.ts";
import { policyRequestCost } from "../shared/request-pricing.ts";
import type { ProxySelection } from "./proxy-selection.ts";
import type { UpstreamAuth } from "./providers.ts";
import { assertControlCallerLive, authorizeResponseControl, publicControlAuthorization } from "./response-control-authorization.ts";
import type { AccessPolicy, AuthorizedIdentity, Env, UpstreamGrant } from "./types.ts";
import { HttpError, safeEqual, sha256Hex } from "./utils.ts";

export interface InlineMusicEvidence {
  readonly slot: "messages[0].content[1].image_url.url";
  readonly sha256: string;
  readonly mime: "image/png" | "image/jpeg" | "image/webp";
  readonly bytes: number;
}
export interface InlineMusicBinding extends InlineMusicEvidence {
  readonly scope: string;
  readonly providerId: "openrouter";
  readonly endpointId: string;
  readonly modelId: string;
  readonly upstreamModel: string;
  readonly origin: "https://openrouter.ai";
  readonly grantKey: string;
  readonly generation: number;
  readonly lineage: string;
}

// This is request-local evidence created from validated bytes, never a public
// handle, URL permission or stored/cross-request asset receipt.
export async function prepareInlineMusicOwner(env: Env, auth: AuthorizedIdentity, selection: ProxySelection,
  upstream: UpstreamAuth, url: URL, headers: Headers, evidence: InlineMusicEvidence): Promise<{
    binding: Readonly<InlineMusicBinding>; revalidate(signal: AbortSignal): Promise<void>;
  }> {
  const { grant, grantKey } = upstream, model = selection.model;
  if (!grantKey || !qualified(grant) || typeof grant.credential !== "string" || !grant.credential
    || selection.provider.id !== "openrouter" || selection.capability !== "music.generate" || !model
    || !model.capabilities.includes("music.generate") || !openRouterMusicModels.some(value => value === model.upstream) || selection.method !== "POST"
    || selection.endpoint.path !== "/v1/chat/completions" || selection.endpoint.method !== "POST"
    || selection.endpoint.request_format !== "openai.chat_completions" || selection.endpoint.response_format !== "openai.chat_completions"
    || selection.endpoint.streaming !== "sse" || selection.endpoint.upstreamPath !== undefined
    || selection.endpoint.path_params.length || Object.keys(selection.pathParams).length || Object.keys(selection.endpoint.query).length
    || selection.nativeQuery !== undefined || selection.endpoint.websocket || selection.endpoint.lifecycle
    || selection.endpoint.responsesLifecycle || selection.endpoint.modelPassthrough || selection.endpoint.requestPricing
    || upstream.transport !== null || upstream.query.size || upstream.baseUrl !== "https://openrouter.ai/api"
    || url.href !== "https://openrouter.ai/api/v1/chat/completions"
    || !safeEqual(headers.get("authorization") ?? "", `Bearer ${grant.credential}`)
    || headers.get("authorization") !== upstream.headers.get("authorization")
    || evidence.slot !== "messages[0].content[1].image_url.url" || !/^[a-f0-9]{64}$/.test(evidence.sha256)
    || !["image/png", "image/jpeg", "image/webp"].includes(evidence.mime)
    || !Number.isSafeInteger(evidence.bytes) || evidence.bytes < 1 || evidence.bytes > 8 * 1024 * 1024) unavailable();
  const original = identity(grant), admittedPolicy = musicPolicyBinding(auth.policy), caller = publicControlAuthorization(auth);
  const binding: Readonly<InlineMusicBinding> = Object.freeze({ ...evidence, scope: await continuationScope(auth),
    providerId: "openrouter", endpointId: selection.endpoint.id, modelId: model.id, upstreamModel: model.upstream,
    origin: "https://openrouter.ai", grantKey, generation: grant.credentialGeneration!, lineage: grant.credentialLineage! });
  const owner = { providerId: "openrouter", endpointId: selection.endpoint.id, grantKey,
    lineage: grant.credentialLineage!, policyGeneration: auth.policy.generation,
    routeSha256: await sha256Hex(JSON.stringify([url.href, binding])) };
  return {
    binding,
    async revalidate(signal) {
      const policy = await authorizeResponseControl(env, caller, owner, signal);
      if (!policy) unavailable();
      assertPolicyModel(policy, selection);
      // A newer logging or monetary policy cannot borrow an older archive /
      // reservation verdict. Start a new request under that policy instead.
      if (musicPolicyBinding(policy) !== admittedPolicy) unavailable();
      const current = await inspectGrantCredentials(env, grantKey, signal);
      signal.throwIfAborted(); assertControlCallerLive(caller);
      if (!qualified(current) || identity(current) !== original || !qualified(grant)
        || selection.provider.id !== binding.providerId || selection.endpoint.id !== binding.endpointId
        || selection.model?.id !== binding.modelId || selection.model.upstream !== binding.upstreamModel
        || url.href !== "https://openrouter.ai/api/v1/chat/completions"
        || !filterGrantCandidates("openrouter", [{ key: grantKey, grant: current, runtimeState: null }], new Set(),
          grantRoutingPolicy(policy.grantRouting), grantKey, undefined, Date.now()).available.length) unavailable();
    },
  };
}

function qualified(grant: UpstreamGrant | null): grant is UpstreamGrant {
  return !!grant && grant.provider === "openrouter" && grant.kind === "api_key" && grant.credentialStore === "durable_object"
    && grant.enabled === true && !grant.revokedAt && grant.credentialStatus === "active"
    && Number.isSafeInteger(grant.credentialGeneration) && !!grant.credentialLineage
    && (!grant.expiresAt || Number.isFinite(Date.parse(grant.expiresAt)) && Date.parse(grant.expiresAt) > Date.now());
}
function identity(grant: UpstreamGrant): string {
  return JSON.stringify([grant.provider, grant.kind, grant.credentialGeneration, grant.credentialLineage, grant.accountId ?? null]);
}
export function musicPolicyBinding(policy: AccessPolicy): string {
  return JSON.stringify([policyRequestCost(policy, "music.generate"), policy.monthlyBudgetMicros ?? null,
    policy.dailyBudgetMicros ?? null, policy.weeklyBudgetMicros ?? null, policy.budgetScope ?? "policy",
    policy.budgetMode ?? "reserve", policy.budgetOverride ?? null, policy.retainRequestContent !== false]);
}
function unavailable(): never {
  throw new HttpError(503, "inline_music_owner_unavailable", "the original OpenRouter music caller, credential or input binding is unavailable");
}
