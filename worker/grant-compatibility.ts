import { bindingSupportsOperation, transportForGrant, type ProviderBindingRequirement } from "../shared/provider-bindings.ts";
import { readNativeMediaBinding } from "../shared/native-media-binding.ts";
import { miniMaxVideoBindingModel } from "../shared/minimax-video-binding.ts";
import { miniMaxSearchProjection, miniMaxSearchRequirement } from "./minimax-search-credential.ts";
import { miniMaxVideoProjection, miniMaxVideoRequirement } from "./minimax-video-credential.ts";
import { miniMaxImageProjection, miniMaxImageRequirement } from "./minimax-image-credential.ts";
import { vertexAnthropicProjection } from "./vertex-anthropic-binding.ts";
import { isQualifiedVertexModelLocation } from "./vertex-model-eligibility.ts";
import { miniMaxAnthropicProjection } from "./minimax-anthropic-binding.ts";
import { miniMaxMediaProjection, miniMaxMusicRequirement } from "./native-media-credential.ts";
import { isModelDiscovery, publicCatalogProvider } from "./model-discovery-formats.ts";
import type { CompiledProvider, UpstreamGrant } from "./types.ts";

export interface GrantRequirement extends ProviderBindingRequirement { model?: string | null }

// This one opaque PCM profile is qualified only for an original owned API key.
export function openRouterPcmModel(provider: CompiledProvider, modelId?: string | null): boolean {
  return provider.id === "openrouter"
    && (provider.models.find(model => model.id === modelId)?.upstream ?? modelId) === "google/gemini-3.1-flash-tts-preview";
}
export function openRouterPcmRequirement(requirement: Pick<GrantRequirement, "provider" | "endpoint" | "model">): boolean {
  return requirement.endpoint.request_format === "openai.audio_speech" && openRouterPcmModel(requirement.provider, requirement.model);
}

export function grantSupports(requirement: GrantRequirement, grant: UpstreamGrant | null): boolean {
  if (requirement.provider.id === "minimax" && readNativeMediaBinding(grant?.nativeMediaBinding)?.version === "clawrouter.native-media.v2") return false;
  if (requirement.endpoint.lifecycle?.protocol === "minimax.video" && (!miniMaxVideoRequirement(requirement)
    || !miniMaxVideoProjection(grant) || !miniMaxVideoBindingModel(grant?.minimaxVideoBinding, requirement.model)
    || transportForGrant(requirement.provider, grant) !== null)) return false;
  if (requirement.endpoint.request_format === "minimax.search" && (!miniMaxSearchRequirement(requirement)
    || !miniMaxSearchProjection(grant) || grant?.minimaxSearchBinding?.origin !== requirement.provider.base_urls.default)) return false;
  if (requirement.endpoint.request_format === "minimax.music" && (!miniMaxMusicRequirement(requirement)
    || grant && (!miniMaxMediaProjection(grant, "minimax.music") || !Number.isSafeInteger(grant.credentialGeneration)
      || !grant.credentialLineage || transportForGrant(requirement.provider, grant) !== null))) return false;
  if (requirement.endpoint.request_format === "minimax.images" && (!miniMaxImageRequirement(requirement)
    || !miniMaxImageProjection(grant) || transportForGrant(requirement.provider, grant) !== null)) return false;
  if (requirement.provider.id === "anthropic-vertex") {
    const binding = vertexAnthropicProjection(grant);
    const models = requirement.provider.models.filter(model => model.id === requirement.model || model.upstream === requirement.model);
    if (!binding || models.length !== 1 || !isQualifiedVertexModelLocation(models[0].upstream, binding.location)
      || requirement.mode !== "http" || requirement.endpoint.request_format !== "anthropic.messages"
      || requirement.endpoint.response_format !== "anthropic.messages" || requirement.endpoint.method !== "POST"
      || requirement.endpoint.path !== "/v1/messages" || requirement.endpoint.upstreamPath !== undefined || requirement.endpoint.auth
      || requirement.endpoint.websocket || requirement.endpoint.lifecycle || requirement.endpoint.responsesLifecycle
      || requirement.endpoint.modelPassthrough || requirement.endpoint.path_params.length || Object.keys(requirement.endpoint.query).length
      || transportForGrant(requirement.provider, grant) !== null
      || binding.source !== "service_account" && Date.parse(grant?.expiresAt ?? "") <= Date.now() + 60_000) return false;
  }
  if (requirement.provider.id === "minimax") {
    const native = requirement.endpoint.request_format === "anthropic.messages";
    if (native && (requirement.mode !== "http" || requirement.endpoint.response_format !== "anthropic.messages"
      || requirement.endpoint.method !== "POST" || requirement.endpoint.path !== "/anthropic/v1/messages"
      || requirement.endpoint.upstreamPath !== undefined || requirement.endpoint.auth || requirement.endpoint.websocket
      || requirement.endpoint.lifecycle || requirement.endpoint.responsesLifecycle || requirement.endpoint.modelPassthrough
      || requirement.endpoint.path_params.length || Object.keys(requirement.endpoint.query).length
      || transportForGrant(requirement.provider, grant) !== null || !miniMaxAnthropicProjection(grant))) return false;
    if (!native && (grant?.kind === "oauth" || grant?.minimaxAnthropicBinding?.region === "cn")) return false;
  }
  if (openRouterPcmRequirement(requirement) && (requirement.mode !== "http" || !grant || grant.kind !== "api_key"
    || grant.provider !== "openrouter" || grant.credentialStore !== "durable_object" || !grant.credentialLineage
    || !Number.isSafeInteger(grant.credentialGeneration) || !(grant.credential || grant.hasCredential && !grant.credentialFields?.length)
    || transportForGrant(requirement.provider, grant) !== null)) return false;
  const publicProvider = publicCatalogProvider(requirement.endpoint.request_format);
  if (publicProvider && (requirement.provider.id !== publicProvider || requirement.mode !== "http"
    || requirement.endpoint.response_format !== requirement.endpoint.request_format || !grant || grant.kind !== "api_key"
    || grant.credentialStore !== "durable_object" || !grant.credentialLineage || !Number.isSafeInteger(grant.credentialGeneration)
    || transportForGrant(requirement.provider, grant) !== null)) return false;
  if (requirement.endpoint.request_format === "featherless.catalog" && (requirement.provider.id !== "featherless"
    || requirement.endpoint.response_format !== "featherless.catalog" || requirement.mode !== "http"
    || !grant || grant.kind !== "api_key" || grant.credentialStore !== "durable_object"
    || !grant.credentialLineage || !Number.isSafeInteger(grant.credentialGeneration)
    || transportForGrant(requirement.provider, grant) !== null)) return false;
  if (requirement.endpoint.inputProfile !== undefined && (requirement.endpoint.inputProfile !== "clawrouter.pixverse-image-input.v1"
    || requirement.provider.id !== "pixverse" || requirement.mode !== "http" || !grant || grant.kind !== "api_key"
    || grant.credentialStore !== "durable_object" || !grant.credentialLineage || !Number.isSafeInteger(grant.credentialGeneration))) return false;
  if (requirement.endpoint.request_format === "minimax.speech" && grant && !miniMaxMediaProjection(grant)) return false;
  if (isModelDiscovery(requirement.endpoint) && grant?.kind !== "api_key") return false;
  if (requirement.endpoint.request_format === "openai.standalone_search" && grant && grant.kind !== "api_key") return false;
  if (requirement.endpoint.request_format === "openai.moderations" && grant && grant.kind !== "api_key") return false;
  if (requirement.endpoint.request_format === "openai.responses_input_tokens" && grant && grant.kind !== "api_key") return false;
  return bindingSupportsOperation(requirement, grant);
}

