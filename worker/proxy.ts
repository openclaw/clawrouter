import { readMiniMaxVideoInput, bindMiniMaxVideoInline, hasMiniMaxVideoInline } from "./minimax-video-inline.ts";
import { MiniMaxVideoOperation, videoJsonBytes, assertVideoHeaders } from "./minimax-video-operation.ts";
import { miniMaxVideoDenied } from "./minimax-video-credential.ts";
import { isMiniMaxVideoModel, miniMaxVideoRequiresInline } from "../shared/minimax-video-binding.ts";
import { prepareMiniMaxVideoDispatch } from "./minimax-video-dispatch.ts";
import { MiniMaxSearchOperation, readSearchJson, assertSearchHeaders } from "./minimax-search-operation.ts";
import { miniMaxSearchRequirement, miniMaxSearchDenied } from "./minimax-search-credential.ts";
import { prepareNativeMiniMaxSearch } from "./native-minimax-search.ts";
import { prepareMiniMaxSearchDispatch } from "./minimax-search-dispatch.ts";
import { vertexAnthropicRoute, prepareVertexAnthropicDispatch } from "./vertex-anthropic-dispatch.ts";
import { miniMaxAnthropicRoute, prepareMiniMaxAnthropicDispatch } from "./minimax-anthropic-dispatch.ts";
import { prepareOpenRouterPcmOwner } from "./openrouter-pcm-owner.ts";
import { prepareInlineMusicOwner } from "./openrouter-music-owner.ts";
import { inlineMusicInput, prepareInlineMusicInput, type InlineMusicInput } from "./openrouter-music-runtime.ts";
import { publishedMusicInput, preparePublishedMusicInput, PublishedMusicUnsent, type PublishedMusicInput } from "./published-music-runtime.ts";
import { readInlineMusicJson } from "./openrouter-music-input.ts";
import { nativeResponseLease } from "./native-response.ts";
import { inputRetirement, type InputRetirement } from "./input-retirement.ts";
import { prepareModelDiscoveryOwner } from "./model-discovery-owner.ts";
import { REQUESTY_MODELS_FORMAT } from "./requesty-model-catalog.ts";
import { assertMultipartIntake } from "./transcription-protocol.ts";
import { prepareVeniceChatAuthority } from "./venice-chat-authority.ts";
import { prepareVeniceChatResponse, veniceChat } from "./venice-chat-runtime.ts";
import { acquireFeatherlessCatalog, featherlessCatalogResponse, prepareFeatherlessCatalogOwner } from "./featherless-catalog-runtime.ts";
import { isKeyedModelDiscovery, prepareKeyedModelDiscovery } from "./keyed-model-discovery.ts";
import { prepareGmiOrganizationBinding } from "./gmi-organization-binding.ts";
import { fetchPublicModelDiscovery } from "./public-model-discovery.ts";
import { assertPublicDiscoveryEnvelope, preparePublicDiscoveryOwner } from "./public-model-discovery-owner.ts";
import { manifestOnlyPublicCatalog, publicCatalogProvider } from "./public-model-discovery-formats.ts";
import { ownMiniMaxImageInput } from "./minimax-image-input.ts";
import { prepareMiniMaxImageDispatch } from "./minimax-image-dispatch.ts";
import { prepareMiniMaxMediaDispatch } from "./minimax-media-dispatch.ts";
import { openCodeSessionHeader, openCodeSessionHeaders } from "./opencode-session.ts";
import { prepareNativeBedrockEmbedding } from "./native-bedrock-embeddings.ts";
import { prepareNativeBedrockConverse } from "./native-bedrock-converse.ts";
import { prepareNativeBedrockConverseStream } from "./native-bedrock-converse-stream.ts";
import { assertNativeResponseDestination } from "./native-response.ts";
import { nativeModelEligible } from "../shared/native-model-eligibility.ts";
import { nativeRawFormat, readNativeRawInput } from "./native-raw-input.ts";
import { GoogleContinuation, googleContinuationRequested, googleContinuationRoute } from "./google-continuation.ts";
import { nativeDispatchQuery, qualifyNativeQuery } from "./native-query.ts";
import { assertRequestTariffDestination } from "./request-tariff.ts";
import { policyRequestCost } from "../shared/request-pricing.ts";
import { fusionAdviserModels, fusionStrategy } from "../shared/fusion-strategy.ts";
import { inspectGrantCredentials } from "./grant-credentials.ts";
import { assertControlCallerLive, authorizeResponseControl, publicControlAuthorization } from "./response-control-authorization.ts";
import { SelectedGrantCredentialFailure } from "./grant-credential-failure.ts";
import { discoveryQuery, isModelDiscovery, modelDiscoveryResponse, validateDiscoveryQuery } from "./model-discovery.ts";
import { anthropicPricing } from "./anthropic-pricing.ts";
import { guardAnthropicPrice, type AnthropicPriceGuard } from "./anthropic-price-response.ts";
import { assertInputTokensRequest } from "./responses-input-tokens.ts";
import { softBudget, softBudgetPolicy, softBudgetPreflight } from "./soft-budget.ts";
import { prepareUpstreamRequest } from "./proxy-upstream-request.ts";
import { BodyLease, bodyLeaseMinimum } from "./body-budget.ts";
import { WanManagedOperation, readWanJson, wanRequestBytes, preflightWanJson, assertWanHeaders } from "./managed-media-json.ts";
import { hasProxyQuery, type ProxyQuery } from "./proxy-query.ts";
import { inheritLocalError } from "./native-errors.ts";
import { identitySelectionDenied } from "./native-request-headers.ts";
import { assertCompactAccount } from "./responses-compact.ts";
import { assertServiceTier } from "./service-tiers.ts";
import { grantStickyInput } from "./grant-sticky.ts";
import { assertPolicyModel } from "./policy-models.ts";
import { assessModelRequest } from "../shared/model-request-parameters.ts";
import { createProxyAccounting, estimateCost, type CompoundRequestContext } from "./proxy-accounting";
import { authenticateProxyKey, proxySessionHash } from "./proxy-auth";
import { queueGrantRuntime } from "./admission-cache.ts";
import { evictGrantCredentials } from "./credential-cache.ts";
import { admissionCacheState, admissionDuration, credentialWait } from "./admission-timing.ts";
import {
  concreteOpenAiSelection, directManifestEnvelope, isSelectionFailure, manifestEnvelope, nativeMatch, nativeModelEndpoint, nativeParams,
  prepareManifestRequest, prepareNativeRequest, requestObject, validateSelectedInput, type ProxySelection,
} from "./proxy-selection";
import { accessIdentity, accessSessionIdentity, verifiedAccessSession } from "./access";
import { markBudgetDispatched, reserveBudget, validateBudgetReservation, type BudgetReservation, type EstimatedCost } from "./accounting";
import { prepareContentRetention, prepareInlineMusicRetention, retentionRequired, type PreparedContentRetention } from "./content-retention";
import { correlationMetadata, logCorrelationError } from "./correlation.ts";
import {
  FUSION_MODEL_ID, buildAggregatorBody, buildFusionReservationProposals, collectFusionProposals,
  fusionMessagesValid, prepareAdviserBody,
} from "./fusion";
import { loadFusionConfig } from "./fusion-config";
import { shouldFailoverGrant } from "./grant-quota";
import { observeProviderGrantQuota } from "./provider-quota.ts";
import { grantRoutingPolicy, type PinnedGrant } from "./grant-selection";
import type { ContinuationOwner } from "./continuation-store.ts";
import { assertSingleOpenAiAccount } from "./openai-public-account.ts";
import { isStandaloneSearch, SearchSession } from "./standalone-search.ts";
import { HttpContinuation } from "./http-continuation.ts";
import { HttpBackground } from "./http-background.ts";
import { HttpOperation } from "./http-operation.ts";
import { backgroundResponse, requireEmptyResponseControlBody, responsesControls, responsesFileControls } from "./responses-lifecycle.ts";
import { proxyResponseControl } from "./response-controls.ts";
import { responseRouteDigest } from "./responses-control-dispatch.ts";
import {
  assertProviderAccess, capabilityForPath, modelRoute, modelSupportsEndpoint, providerById, configuredUpstream,
  signSigV4, upstreamAuth, upstreamPath, type UpstreamAuth,
} from "./providers";
import { assertOperationConfiguration, grantSupports, openRouterPcmRequirement } from "./provider-auth.ts";
import { normalizePreStreamError, observeUsage, proxyResponseHeaders } from "./proxy-response";
import type { AuthorizedIdentity, CompiledEndpoint, CompiledProvider, CompiledQuotaConfig, Env, ProviderConnection } from "./types";
import {
  decodePathSegment,
  errorResponse, HttpError, json, maxJsonBodyBytes, maxMediaJsonBodyBytes, randomId, readJson, type JsonIntake,
} from "./utils";

type AuthMode = "proxy_key" | "access";

// Media-bearing generation formats take the 32 MB envelope on every route form.
const mediaFormats = new Set(["anthropic.messages", "openai.responses", "openai.responses_compact", "openai.responses_input_tokens", "openai.chat_completions", "google.embed_content", "google.batch_embed_contents", "xai.images_generations", "xai.images_edits", "openrouter.audio_transcription"]);
const mediaPaths = new Set(["/v1/responses", "/v1/responses/compact", "/v1/responses/input_tokens", "/v1/chat/completions"]);
const mediaEnvelope = (endpoint: { request_format: string }) => mediaFormats.has(endpoint.request_format);
const bodyLimit = (endpoint: { request_format: string }, providerId?: string) => providerId === "openrouter" && endpoint.request_format === "openai.audio_speech"
  ? 256 * 1024 : endpoint.request_format === "openrouter.audio_transcription"
  ? 24 * 1024 * 1024 : mediaEnvelope(endpoint) ? maxMediaJsonBodyBytes : undefined;
// Unified paths admit the media envelope before the model resolves a format.
const expandedTooLarge = () => errorResponse("request_too_large", `JSON request body exceeds the ${maxJsonBodyBytes} byte limit for this route`, 413);

// Leases this isolate's body budget (see body-budget.ts), authenticating before
// any lease so anonymous callers cannot hold it, and again before expansion past
// 8 MiB. Keep the lease through response delivery: accounting closures can
// still own the input body.
class JsonAdmission implements JsonIntake {
  completion?: Promise<unknown>;
  search?: MiniMaxSearchOperation;
  wan?: WanManagedOperation;
  private wanRefusal?: Promise<void>;
  expanded = false;
  private authenticated = false;
  private lease = new BodyLease();
  private input?: InlineMusicInput | PublishedMusicInput;
  private intakeOperation?: HttpOperation;
  private intakeStartedAt = 0;
  private intakeBytes = 0;
  private readonly request: Request;
  private readonly env: Env;
  private readonly mode: AuthMode;
  private readonly providerId: string | undefined;
  constructor(request: Request, env: Env, mode: AuthMode, providerId?: string) {
    this.request = request; this.env = env; this.mode = mode; this.providerId = providerId;
  }
  reserve = async (bytes: number): Promise<void> => {
    if (bytes >= bodyLeaseMinimum) await this.authenticate();
    if (this.lease.grow(bytes)) return;
    throw this.providerId === "anthropic"
      ? json({ type: "error", error: { type: "overloaded_error", message: "Large request capacity is busy; retry shortly." } }, 503, { "retry-after": "1" })
      : errorResponse("server_overloaded", "Large request capacity is busy; retry shortly.", 503, undefined, { "retry-after": "1" });
  };
  expand = async (): Promise<void> => {
    await this.authenticate();
    this.expanded = true;
  };
  async musicCandidate(): Promise<unknown> {
    // This shared native URL still resolves Chat/music by the existing model
    // selector. Byte-zero parsing changes no ordinary Chat capacity threshold.
    try { await this.authenticate(); }
    catch (error) { void this.request.body?.cancel().catch(() => undefined); throw error; }
    this.intakeStartedAt = Date.now();
    this.intakeOperation = new HttpOperation(this.request.signal, 120_000);
    const parsed = await readInlineMusicJson(this.request, this.intakeOperation, true);
    this.lease = parsed.lease;
    this.intakeBytes = parsed.bytes;
    this.expanded = parsed.bytes > maxJsonBodyBytes;
    const value = parsed.value; parsed.value = undefined;
    return value;
  }
  wanAuth?: AuthorizedIdentity;
  async wanCandidate(endpoint: CompiledEndpoint, empty = false): Promise<unknown> {
    const provider = this.providerId ? providerById(this.providerId) : null;
    // This closed create profile has one registered text model. Obtain its
    // original selection before intake; the parsed literal must still match.
    const model = wanCreate(endpoint) && provider?.models.length === 1 ? provider.models[0] : undefined;
    if (wanCreate(endpoint) && (!provider || !model)) throw new HttpError(503, "prediction_owner_unavailable", "Wan model admission is unavailable");
    const auth = this.mode === "proxy_key" && provider && model
      ? await authenticateProxyKey(this.request.headers, this.env,
        [{ id: provider.id, tokenRef: provider.auth.schemes.find(scheme => scheme.type === "oauth")?.tokenRef ?? provider.id }],
        false, correlationMetadata(this.request).sessionId, { providerId: provider.id, endpointId: endpoint.id, mode: "http",
          model: model.upstream, catalogModelId: model.id, capability: provider.capabilities.find(item => item.endpoint === endpoint.id)?.id ?? endpoint.id })
      : await preauthenticate(this.request, this.env, this.mode, this.providerId);
    if (auth instanceof Response) throw auth;
    if (!auth) throw new HttpError(403, "prediction_owner_unavailable", "Wan caller is unavailable");
    this.wanAuth = auth;
    if (this.request.signal.aborted) throw new HttpError(499, "request_canceled", "request was canceled");
    assertWanHeaders(this.request.headers);
    try { this.wan = new WanManagedOperation(wanCreate(endpoint) ? "create" : "poll"); }
    catch (error) {
      this.wanRefusal = this.request.body?.cancel(error).then(() => undefined, () => undefined);
      throw error;
    }
    this.intakeOperation = new HttpOperation(this.request.signal, Math.min(endpoint.timeout_ms ?? 120_000, 120_000));
    this.wan.controlSignal = this.intakeOperation.signal;
    if (empty && !this.request.body) return {};
    const physical = this.wan.track(readWanJson(this.request, empty ? 0 : wanRequestBytes,
      { signal: this.intakeOperation.signal, registerInput: this.wan.registerInput, empty }));
    return (await this.intakeOperation.wait(physical, "upstream")).body;
  }
  async prepareMusic(selection: ProxySelection): Promise<void> {
    if (!this.intakeOperation) return;
    // Carry elapsed intake time into the selected endpoint's deadline, without
    // applying a music endpoint timeout to an ordinary Chat selection.
    this.intakeOperation.stop("complete");
    if (selection.capability !== "music.generate") { this.intakeOperation = undefined; return; }
    if (this.intakeBytes > 12 * 1024 * 1024) { selection.body = {}; throw new HttpError(413, "request_too_large", "music JSON exceeds its input envelope"); }
    const remaining = Math.min(selection.timeoutMs ?? 120_000, selection.endpoint.timeout_ms ?? 120_000) - (Date.now() - this.intakeStartedAt);
    if (remaining <= 0) throw new HttpError(504, "request_timeout", "music input deadline expired");
    this.intakeOperation = new HttpOperation(this.request.signal, remaining);
    try { this.input = preparePublishedMusicInput(selection, this.lease, this.intakeOperation)
      ?? await prepareInlineMusicInput(selection, this.lease, this.intakeOperation); }
    catch (error) { selection.body = {}; throw error; }
    if (!this.input) { this.intakeOperation.stop("complete"); this.intakeOperation = undefined; }
  }
  private async authenticate(): Promise<void> {
    if (!this.authenticated) {
      const auth = await preauthenticate(this.request, this.env, this.mode, this.providerId);
      if (auth instanceof Response) throw auth;
      this.authenticated = true;
    }
    if (this.request.signal.aborted) throw new HttpError(499, "request_canceled", "request was canceled");
  }
  finish(context: ExecutionContext): void {
    if (this.search) { context.waitUntil(this.search.finish()); return; }
    if (this.wanRefusal) context.waitUntil(this.wanRefusal);
    if (this.wan) {
      context.waitUntil(this.wan.finish().finally(() => this.intakeOperation?.stop("complete")));
      return;
    }
    if (!this.lease.leased && !this.input) { this.intakeOperation?.stop("complete"); return; }
    context.waitUntil((async () => {
      try { await this.completion; }
      finally {
        if (this.input) await this.input.finish();
        else this.lease.release();
        this.intakeOperation?.stop("complete"); this.intakeOperation = undefined;
      }
    })());
  }
}

const wanCreate = (endpoint: CompiledEndpoint) => endpoint.lifecycle?.protocol === "dashscope.video"
  && endpoint.request_format === "dashscope.video_create";

function openRouterMusicCandidate(provider: CompiledProvider, endpoint: CompiledEndpoint): boolean {
  return provider.id === "openrouter" && endpoint.path === "/v1/chat/completions"
    && endpoint.request_format === "openai.chat_completions"
    && provider.capabilities.some(capability => capability.id === "music.generate"
      && provider.endpoints.some(candidate => candidate.id === capability.endpoint && candidate.path === endpoint.path));
}

interface PreparedUpstream {
  headers: Headers;
  url: URL;
  requestBody: string | ReadableStream<Uint8Array> | undefined;
  grantKey: string | null;
  grantLane: import("./types").GrantLane;
  grantRevision: string | null;
  connection: ProviderConnection;
  websocket: boolean;
  backgroundRecovery: boolean;
  failedGrantKey?: string;
  continuation?: ContinuationOwner;
  managedBaseUrl?: string;
  revalidateAccount?: (signal: AbortSignal) => Promise<void>;
  acquireDiscovery?: () => BodyLease;
  revalidateDiscovery?: (signal: AbortSignal) => Promise<import("./types").AccessPolicy>;
  publicCatalog?: Awaited<ReturnType<typeof preparePublicDiscoveryOwner>>;
  revalidateDelivery?: (signal: AbortSignal) => Promise<void>;
  featherlessCatalog?: Awaited<ReturnType<typeof prepareFeatherlessCatalogOwner>>;
}

interface ReservedProxyBudget {
  failedGrantKey?: string;
  auth: AuthorizedIdentity;
  reservation: BudgetReservation;
  cost: EstimatedCost;
  providerId: string;
  modelId: string | null;
  capability: string;
  connection: ProviderConnection;
}

export async function proxyOpenAi(request: Request, env: Env, context: ExecutionContext, path: string, mode: AuthMode): Promise<Response> {
  const admission = new JsonAdmission(request, env, mode);
  try { return await proxyUnifiedOpenAi(request, env, context, path, mode, admission); }
  finally { admission.finish(context); }
}

async function proxyUnifiedOpenAi(request: Request, env: Env, context: ExecutionContext, path: string, mode: AuthMode, admission: JsonAdmission): Promise<Response> {
  let body: Record<string, unknown>;
  try { body = requestObject(await readJson<unknown>(request, undefined, mediaPaths.has(path) ? maxMediaJsonBodyBytes : undefined, admission)); }
  catch (error) {
    if (error instanceof Response) return error;
    const auth = await preauthenticate(request, env, mode);
    if (auth instanceof Response) return auth;
    throw error;
  }
  // Moderations has an optional model in the native API. Resolve the documented
  // default before both admission and model-policy checks, including bare IDs.
  if (path === "/v1/moderations" && (body.model === undefined || typeof body.model === "string" && !body.model.includes("/"))) body.model = `openai/${body.model ?? "omni-moderation-latest"}`;
  const modelId = typeof body.model === "string" ? body.model : "";
  const earlySelection = concreteOpenAiSelection(path, body, env);
  const preauthenticated = await preauthenticate(request, env, mode, mode === "proxy_key" ? modelRoute(modelId, capabilityForPath(path) ?? undefined)?.provider.id : undefined, undefined, isSelectionFailure(earlySelection) ? undefined : earlySelection);
  if (preauthenticated instanceof Response) return preauthenticated;
  if (!modelId) return errorResponse("model_required", "model is required", 400);
  // Fusion fans one body out to several advisers; only the bounded envelope may.
  if (modelId === FUSION_MODEL_ID) {
    if (path !== "/v1/chat/completions") return errorResponse("fusion_capability_unsupported", `${FUSION_MODEL_ID} supports only /v1/chat/completions`, 400);
    if (admission.expanded) return expandedTooLarge();
    return proxyFusion(request, env, context, mode, body, preauthenticated);
  }
  if (!isSelectionFailure(earlySelection)) return admission.expanded && !mediaEnvelope(earlySelection.endpoint) ? expandedTooLarge() : proxySelected(request, env, context, mode, earlySelection, new URL(request.url).searchParams, preauthenticated, undefined, undefined, undefined, admission);
  return proxyConcreteOpenAi(request, env, context, path, mode, body, preauthenticated, undefined, undefined, undefined, undefined, admission);
}

async function proxyConcreteOpenAi(
  request: Request,
  env: Env,
  context: ExecutionContext,
  path: string,
  mode: AuthMode,
  body: Record<string, unknown>,
  preauthenticated: AuthorizedIdentity | null,
  timeoutMs?: number,
  reservedBudget?: ReservedProxyBudget,
  compound?: CompoundRequestContext,
  auditAuth?: AuthorizedIdentity,
  admission?: JsonAdmission,
): Promise<Response> {
  const result = concreteOpenAiSelection(path, body, env, timeoutMs);
  if (isSelectionFailure(result)) {
    if (compound && result.auditSelection) await auditSelectionFailure(request, env, context, mode, result.auditSelection, preauthenticated, result.response.status, compound, auditAuth);
    return result.response;
  }
  if (admission?.expanded && !mediaEnvelope(result.endpoint)) return expandedTooLarge();
  return proxySelected(request, env, context, mode, result, new URL(request.url).searchParams, preauthenticated, reservedBudget, compound, auditAuth, admission);
}

async function proxyFusion(
  request: Request,
  env: Env,
  context: ExecutionContext,
  mode: AuthMode,
  body: Record<string, unknown>,
  preauthenticated: AuthorizedIdentity | null,
): Promise<Response> {
  const compoundStartedAtMs = Date.now();
  const config = await loadFusionConfig(env);
  if (!config.enabled) return errorResponse("fusion_disabled", `${FUSION_MODEL_ID} is not enabled`, 404);
  if (!fusionMessagesValid(body.messages)) return errorResponse("fusion_messages_invalid", "fusion messages must be an array of objects with string roles", 400);
  const requestId = correlationMetadata(request).requestId;
  const compoundRequestId = randomId("fusion");
  const compoundRequestSize = fusionAdviserModels(config).length + 1;
  const fusionHeaders = new Headers(request.headers);
  fusionHeaders.set("x-request-id", requestId);
  // The original body was already parsed. Concrete routes serialize their transformed body separately.
  const fusionRequest = new Request(request.url, { method: request.method, headers: fusionHeaders, signal: request.signal });
  const aggregatorSelection = concreteOpenAiSelection("/v1/chat/completions", buildAggregatorBody(body, config, buildFusionReservationProposals(config)), env);
  if (isSelectionFailure(aggregatorSelection)) {
    if (aggregatorSelection.auditSelection) await auditSelectionFailure(fusionRequest, env, context, mode, aggregatorSelection.auditSelection, preauthenticated, aggregatorSelection.response.status, {
      id: compoundRequestId, stage: "fusion_synthesizer", index: null, size: 1, startedAtMs: compoundStartedAtMs,
    });
    return aggregatorSelection.response;
  }
  const parameters = assessModelRequest(aggregatorSelection.model, aggregatorSelection.endpoint, aggregatorSelection.body as Record<string, unknown>);
  if (parameters.conflicts.length) {
    await auditSelectionFailure(fusionRequest, env, context, mode, aggregatorSelection, preauthenticated, 400, {
      id: compoundRequestId, stage: "fusion_synthesizer", index: null, size: 1, startedAtMs: compoundStartedAtMs,
    });
    return errorResponse("model_parameter_unsupported", parameters.conflicts.map(({ message }) => message).join(" "), 400);
  }
  const aggregatorBudget = await reserveSelected(fusionRequest, env, context, mode, aggregatorSelection, preauthenticated, {
    id: compoundRequestId, stage: "fusion_synthesizer", index: null, size: 1, startedAtMs: compoundStartedAtMs,
  });
  if (aggregatorBudget instanceof Response) return aggregatorBudget;
  const result = await collectFusionProposals(config, body, async (_model, adviserBody, timeoutMs, index, signal) => {
    const headers = new Headers(fusionRequest.headers);
    headers.set("x-request-id", randomId(`fusion-adviser-${index + 1}`));
    const adviserRequest = new Request(fusionRequest.url, { method: "POST", headers, signal: AbortSignal.any([fusionRequest.signal, signal]) });
    const compound: CompoundRequestContext = {
      id: compoundRequestId, stage: "fusion_adviser", index: index + 1, size: compoundRequestSize, startedAtMs: compoundStartedAtMs,
    };
    const selection = concreteOpenAiSelection("/v1/chat/completions", adviserBody, env, timeoutMs);
    if (isSelectionFailure(selection)) {
      if (selection.auditSelection) await auditSelectionFailure(adviserRequest, env, context, mode, selection.auditSelection, preauthenticated, selection.response.status, compound, aggregatorBudget.auth);
      return selection.response;
    }
    selection.body = prepareAdviserBody(selection.body as Record<string, unknown>, selection.model, selection.endpoint, config.temperature);
    return proxySelected(adviserRequest, env, context, mode, selection, new URL(adviserRequest.url).searchParams, preauthenticated, undefined, compound, aggregatorBudget.auth);
  });
  const aggregatorBody = buildAggregatorBody(body, config, result.proposals);
  const response = await proxyConcreteOpenAi(fusionRequest, env, context, "/v1/chat/completions", mode, aggregatorBody, preauthenticated, undefined, aggregatorBudget, {
    id: compoundRequestId, stage: "fusion_synthesizer", index: null, size: compoundRequestSize, startedAtMs: compoundStartedAtMs,
  });
  const headers = new Headers(response.headers);
  headers.set("x-clawrouter-fusion-strategy", fusionStrategy(config));
  headers.set("x-clawrouter-fusion", result.proposals.length ? "advisers" : "aggregator-only");
  headers.set("x-clawrouter-fusion-aggregator", config.aggregatorModel);
  headers.set("x-clawrouter-fusion-adviser-count", String(result.proposals.length));
  headers.set("x-clawrouter-fusion-failed-count", String(result.failedModels.length));
  headers.set("x-clawrouter-fusion-latency-ms", String(result.durationMs));
  if (result.proposals.length) headers.set("x-clawrouter-fusion-advisers", result.proposals.map((proposal) => proposal.model).join(","));
  return inheritLocalError(response, new Response(response.body, { status: response.status, statusText: response.statusText, headers }));
}

export async function proxyManifest(request: Request, env: Env, context: ExecutionContext, path: string, mode: AuthMode): Promise<Response> {
  const match = path.match(/^\/v1\/(?:playground\/)?proxy\/([^/]+)\/([^/]+)$/);
  if (!match) return errorResponse("route_not_found", "manifest proxy route not found", 404);
  const provider = providerById(decodePathSegment(match[1]));
  const endpoint = provider?.endpoints.find((candidate) => candidate.id === decodePathSegment(match[2]));
  if (!provider || !endpoint) return errorResponse("route_not_found", "manifest proxy route not found", 404);
  if (miniMaxVideoRoute(provider, endpoint)) return proxyMiniMaxVideo(request, env, context, provider, endpoint, mode, "manifest");
  if (endpoint.request_format === "minimax.search") return proxyMiniMaxSearch(request, env, context, provider, endpoint, mode, "manifest");
  if (provider.id === "github-copilot") {
    if (mode !== "proxy_key") return errorResponse("copilot_public_unauthorized", "Current proxy credential required", 403);
    return (await import("./copilot-public-proxy.ts")).proxyCopilotPublic(request, env, context, provider, endpoint, "manifest");
  }
  const session = mode === "access" ? await verifiedAccessSession(request, env) : null;
  if (mode === "access" && !session) return errorResponse("access_session_required", "a verified session is required", 401);
  if (nativeRawFormat(endpoint.request_format)) return proxyNativeRaw(request, env, context, mode, provider, endpoint);
  let preauthenticated: AuthorizedIdentity | Response | null = null;
  const fileControls = responsesFileControls(provider, endpoint);
  if (fileControls.length) {
    const auth = await preauthenticate(request, env, mode, provider.id);
    if (auth instanceof Response) return auth;
    if (request.method !== "GET" || responsesControls(provider, endpoint).length) return errorResponse("method_not_allowed", "file controls require a declared GET", 405);
    await requireEmptyResponseControlBody(request);
    const query = new URL(request.url).searchParams, params: Record<string, string> = {};
    for (const name of endpoint.path_params) {
      const values = query.getAll(name);
      if (values.length !== 1) throw new HttpError(400, "managed_file_invalid", "one declared file path parameter is required");
      params[name] = values[0]; query.delete(name);
    }
    return (await import("./managed-files.ts")).proxyManagedFile(request, env, provider,
      fileControls.map(control => ({ ...control, endpoint, pathParams: params })), query, mode, auth ?? undefined, session ?? undefined, context);
  }
  const controls = responsesControls(provider, endpoint), control = controls[0];
  if (control) {
    preauthenticated = await preauthenticate(request, env, mode, provider.id, { provider, endpoint, mode: "http" });
    if (preauthenticated instanceof Response) return preauthenticated;
    if (controls.some(candidate => candidate.action !== control.action || candidate.protocol !== control.protocol)) throw new HttpError(409, "response_owner_unavailable", "control declarations do not agree on one protocol and action");
    const wanAdmission = control.protocol === "dashscope.video" ? new JsonAdmission(request, env, mode, provider.id) : undefined;
    try {
    if (request.method === "GET") {
      if (endpoint.method !== "GET") return errorResponse("method_not_allowed", "control method is not allowed", 405);
      if (wanAdmission) await wanAdmission.wanCandidate(endpoint, true);
      else await requireEmptyResponseControlBody(request);
      const query = new URL(request.url).searchParams, params: Record<string, string> = {};
      for (const name of control.protocol ? endpoint.path_params : ["response_id"]) {
        const ids = query.getAll(name);
        if (ids.length !== 1) throw new HttpError(400, "response_id_required", "one declared identity path parameter is required");
        params[name] = ids[0]; query.delete(name);
      }
      const id = control.protocol ? await (await import("./managed-routes.ts")).managedControlIdentity(control.protocol, control.action, params, query) : params.response_id;
      return await proxyResponseControl(request, env, control.action, id, control.protocol ? {} : query, mode, provider.id, controls.map(candidate => ({ createId: candidate.create.id, pathParams: params })), preauthenticated ?? undefined, session ?? undefined, control.protocol, params, context, wanAdmission?.wan);
    }
    if (request.method !== "POST") return errorResponse("method_not_allowed", "control method is not allowed", 405);
    const envelope = manifestEnvelope(wanAdmission ? await wanAdmission.wanCandidate(endpoint) : await readJson<unknown>(request));
    if ((envelope.method ?? endpoint.method).toUpperCase() !== endpoint.method || Object.keys(requestObject(envelope.body)).length || new URL(request.url).search) throw new HttpError(400, "invalid_response_control", "manifest controls accept a bodyless declared method and envelope query only");
    const id = control.protocol ? await (await import("./managed-routes.ts")).managedControlIdentity(control.protocol, control.action, envelope.pathParams, envelope.query) : envelope.pathParams.response_id;
    return await proxyResponseControl(request, env, control.action, id, control.protocol ? {} : envelope.query, mode, provider.id, controls.map(candidate => ({ createId: candidate.create.id, pathParams: envelope.pathParams })), preauthenticated ?? undefined, session ?? undefined, control.protocol, envelope.pathParams, context, wanAdmission?.wan);
    } finally { wanAdmission?.finish(context); }
  }
  // Controls resolve their original owner; creation keeps ordinary policy
  // selection, including transports that cannot provide durable recovery.
  if (endpoint.request_format === "featherless.catalog" && (request.method !== "GET" || request.body !== null || new URL(request.url).search)) {
    const auth = await preauthenticate(request, env, mode, provider.id);
    return auth instanceof Response ? auth : errorResponse("invalid_model_discovery", "the catalog requires a bodyless, query-free GET", 400);
  }
  const admission = new JsonAdmission(request, env, mode, provider.id);
  try {
    let envelope, prepared;
    try {
      if (request.method === "GET" || request.method === "HEAD") envelope = directManifestEnvelope(request, endpoint);
      else {
        let value = wanCreate(endpoint) ? await admission.wanCandidate(endpoint) : openRouterMusicCandidate(provider, endpoint)
          ? await admission.musicCandidate() : await readJson<unknown>(request, undefined, bodyLimit(endpoint, provider.id), admission);
        if (publicCatalogProvider(endpoint.request_format)) assertPublicDiscoveryEnvelope(value);
        envelope = manifestEnvelope(value);
        value = undefined;
      }
      prepared = prepareManifestRequest(provider, endpoint, envelope.body, envelope.pathParams, env);
      envelope.body = undefined;
    } catch (error) {
      if (error instanceof Response) return error;
      const auth = await preauthenticate(request, env, mode, provider.id);
      if (auth instanceof Response) return auth;
      throw error;
    }
    const method = (envelope.method ?? endpoint.method).toUpperCase();
    if (!endpoint.methods.includes(method)) { const auth = await preauthenticate(request, env, mode, provider.id); return auth instanceof Response ? auth : errorResponse("method_not_allowed", `endpoint does not allow ${method}`, 405); }
    if (!session) preauthenticated = admission.wanAuth ?? await preauthenticate(request, env, mode, provider.id, undefined, { provider, endpoint, model: prepared.model, capability: provider.capabilities.find(item => item.endpoint === endpoint.id)?.id ?? endpoint.id, body: prepared.body, pathParams: prepared.pathParams, method });
    if (session) preauthenticated = await accessSessionIdentity(session, env, provider.id, { provider, endpoint, mode: "http", model: prepared.model?.id });
    if (preauthenticated instanceof Response) return preauthenticated;
    const capability = provider.capabilities.find((item) => item.endpoint === endpoint.id)?.id ?? endpoint.id;
    const selection = { provider, endpoint, model: prepared.model, capability, body: prepared.body, pathParams: prepared.pathParams, method };
    prepared.body = {};
    await admission.prepareMusic(selection);
    return await proxySelected(request, env, context, mode, selection, envelope.query, preauthenticated, undefined, undefined, undefined, admission);
  } finally { admission.finish(context); }
}

export async function proxyNative(request: Request, env: Env, context: ExecutionContext, path: string): Promise<Response> {
  const match = path.match(/^\/v1\/native\/([^/]+)(\/.*)$/);
  if (!match) return errorResponse("route_not_found", "native proxy route not found", 404);
  const provider = providerById(decodePathSegment(match[1]));
  if (!provider) return errorResponse("provider_not_found", "provider not found", 404);
  const matching = provider.endpoints.filter(candidate => nativeMatch(candidate, match[2]));
  let endpoint = matching.find(candidate => candidate.methods.includes(request.method.toUpperCase())) ?? matching[0];
  if (matching.some(candidate => miniMaxVideoRoute(provider, candidate))) {
    if (matching.length !== 1 || !endpoint?.native_proxy) miniMaxVideoDenied();
    return proxyMiniMaxVideo(request, env, context, provider, endpoint, "proxy_key", "native", match[2]);
  }
  if (matching.some(candidate => candidate.request_format === "minimax.search")) {
    if (matching.length !== 1 || !endpoint?.native_proxy) miniMaxSearchDenied();
    return proxyMiniMaxSearch(request, env, context, provider, endpoint, "proxy_key", "native", match[2]);
  }
  if (provider.id === "github-copilot" && endpoint) {
    if (matching.length !== 1) return errorResponse("copilot_public_unavailable", "One exact Copilot endpoint required", 409);
    return (await import("./copilot-public-proxy.ts")).proxyCopilotPublic(request, env, context, provider, endpoint, "native");
  }
  if (!endpoint || !endpoint.native_proxy || manifestOnlyPublicCatalog(endpoint.request_format) || endpoint.request_format === "featherless.catalog") { const auth = await preauthenticate(request, env, "proxy_key", provider.id); return auth instanceof Response ? auth : errorResponse("route_not_found", "native provider route not found", 404); }
  const method = request.method.toUpperCase();
  if (!endpoint.methods.includes(method)) { const auth = await preauthenticate(request, env, "proxy_key", provider.id); return auth instanceof Response ? auth : errorResponse("method_not_allowed", `endpoint does not allow ${method}`, 405); }
  if (nativeRawFormat(endpoint.request_format)) return proxyNativeRaw(request, env, context, "proxy_key", provider, endpoint);
  const controlEndpoints = matching.filter(candidate => candidate.native_proxy && candidate.methods.includes(method));
  const fileControls = controlEndpoints.flatMap(candidate => responsesFileControls(provider, candidate).map(control => ({ ...control, endpoint: candidate, pathParams: nativeParams(candidate, match[2]) })));
  if (fileControls.length) {
    const auth = await preauthenticate(request, env, "proxy_key", provider.id);
    if (auth instanceof Response) return auth;
    if (method !== "GET" || controlEndpoints.some(candidate => !fileControls.some(item => item.endpoint === candidate) || responsesControls(provider, candidate).length)) {
      throw new HttpError(409, "managed_file_owner_unavailable", "native file declarations do not agree on one file control");
    }
    await requireEmptyResponseControlBody(request);
    return (await import("./managed-files.ts")).proxyManagedFile(request, env, provider, fileControls, new URL(request.url).searchParams, "proxy_key", auth ?? undefined, undefined, context);
  }
  const controls = controlEndpoints.flatMap(candidate => responsesControls(provider, candidate).map(control => ({ ...control, endpoint: candidate })));
  const control = controls[0];
  if (control) {
    const preauthenticated = await preauthenticate(request, env, "proxy_key", provider.id);
    if (preauthenticated instanceof Response) return preauthenticated;
    if (controlEndpoints.some(candidate => !controls.some(item => item.endpoint === candidate))
      || controls.some(candidate => candidate.action !== control.action || candidate.protocol !== control.protocol)) {
      throw new HttpError(409, "response_owner_unavailable", "native control declarations do not agree on one protocol and action");
    }
    const wanAdmission = control.protocol === "dashscope.video" ? new JsonAdmission(request, env, "proxy_key", provider.id) : undefined;
    try {
    if (wanAdmission) await wanAdmission.wanCandidate(endpoint, true);
    else await requireEmptyResponseControlBody(request);
    const query = new URL(request.url).searchParams;
    const routes = await Promise.all(controls.map(async candidate => {
      const params = nativeParams(candidate.endpoint, match[2]);
      const id = candidate.protocol ? await (await import("./managed-routes.ts")).managedControlIdentity(candidate.protocol, candidate.action, params, query) : params.response_id;
      return { createId: candidate.create.id, pathParams: params, id };
    }));
    if (routes.some(route => route.id !== routes[0].id)) throw new HttpError(409, "response_owner_unavailable", "native control declarations disagree on the bound identity");
    // The scoped owner selects its original create route; endpoint order never
    // chooses between text/image jobs sharing the same native control path.
    return await proxyResponseControl(request, env, control.action, routes[0].id, control.protocol ? {} : query, "proxy_key", provider.id, routes, preauthenticated ?? undefined, undefined, control.protocol, {}, context, wanAdmission?.wan);
    } finally { wanAdmission?.finish(context); }
  }
  try { endpoint = nativeModelEndpoint(provider, matching, match[2], method) ?? endpoint; }
  catch (error) {
    const auth = await preauthenticate(request, env, "proxy_key", provider.id);
    if (auth instanceof Response) return auth;
    throw error;
  }
  if (matching.some(candidate => candidate.inputProfile !== undefined)) {
    const auth = await preauthenticate(request, env, "proxy_key", provider.id);
    if (auth instanceof Response) return auth;
    if (!auth || matching.length !== 1 || endpoint.inputProfile !== "clawrouter.pixverse-image-input.v1")
      throw new HttpError(409, "managed_input_unavailable", "composed input requires one exact registered profile");
    return (await import("./pixverse-input-native.ts")).proxyPixVerseImageInput(request, env, context, provider, endpoint, auth,
      selection => preauthenticate(request, env, "proxy_key", provider.id, undefined, selection));
  }
  const admission = new JsonAdmission(request, env, "proxy_key", provider.id);
  try {
    let prepared;
    try {
      let body = request.method === "GET" || request.method === "HEAD" ? {} : wanCreate(endpoint) ? await admission.wanCandidate(endpoint) : openRouterMusicCandidate(provider, endpoint)
        ? await admission.musicCandidate() : await readJson<unknown>(request, undefined, bodyLimit(endpoint, provider.id), admission);
      endpoint = nativeModelEndpoint(provider, matching, match[2], method, body) ?? endpoint;
      prepared = prepareNativeRequest(provider, endpoint, body, match[2], env);
      body = undefined;
    } catch (error) {
      if (error instanceof Response) return error;
      const auth = await preauthenticate(request, env, "proxy_key", provider.id);
      if (auth instanceof Response) return auth;
      throw error;
    }
    const capability = provider.capabilities.find((item) => item.endpoint === endpoint.id)?.id ?? endpoint.id;
    const selection = { provider, endpoint, model: prepared.model, capability, body: prepared.body, pathParams: prepared.pathParams, method };
    prepared.body = {};
    await admission.prepareMusic(selection);
    const preauthenticated = admission.wanAuth ?? await preauthenticate(request, env, "proxy_key", provider.id, undefined, selection);
    if (preauthenticated instanceof Response) return preauthenticated;
    return await proxySelected(request, env, context, "proxy_key", selection, isModelDiscovery(endpoint) ? discoveryQuery(new URL(request.url).searchParams) : new URL(request.url).searchParams, preauthenticated, undefined, undefined, undefined, admission);
  } finally { admission.finish(context); }
}

const nativeUploadGrants = new WeakMap<ProxySelection, PinnedGrant>();

async function proxyNativeRaw(request: Request, env: Env, context: ExecutionContext, mode: AuthMode, provider: CompiledProvider, endpoint: CompiledEndpoint): Promise<Response> {
  const selection: ProxySelection = { provider, endpoint, model: null, capability: provider.capabilities.find(item => item.endpoint === endpoint.id)?.id ?? endpoint.id,
    body: {}, pathParams: {}, method: request.method };
  const initial = await preauthenticate(request, env, mode, provider.id, undefined, selection);
  if (initial instanceof Response) return initial;
  if (!initial) throw new HttpError(401, "invalid_proxy_key", "native upload requires an authenticated caller");
  assertPolicyModel(initial.policy, selection);
  await assertProviderAccess(provider, initial, env);
  const original = await upstreamAuth(provider, initial, env, new Set(), await grantStickyHash(request, initial), true, undefined,
    { provider, endpoint, mode: "http" });
  // Upload awaits may revoke or replace the selected owner. Fresh admission
  // must retain this selection, never reopen environment or another grant.
  nativeUploadGrants.set(selection, { key: original.grantKey, revision: original.grantRevision });
  await readNativeRawInput(request, selection);
  const fresh = await preauthenticate(request, env, mode, provider.id, undefined, selection, "authoritative");
  if (fresh instanceof Response) return fresh;
  if (!fresh || initial.credentialId !== fresh.credentialId || initial.principalId !== fresh.principalId || initial.policyId !== fresh.policyId
    || initial.policy.tenantId !== fresh.policy.tenantId) throw new HttpError(403, "native_upload_owner_changed", "upload caller ownership changed before dispatch");
  return proxySelected(request, env, context, mode, selection, {}, fresh);
}

function miniMaxVideoRoute(provider: CompiledProvider, endpoint: CompiledEndpoint): boolean {
  return provider.id === "minimax" && (endpoint.lifecycle?.protocol === "minimax.video"
    || responsesControls(provider, endpoint).some(control => control.protocol === "minimax.video")
    || responsesFileControls(provider, endpoint).some(control => control.create.lifecycle?.protocol === "minimax.video"));
}

async function proxyMiniMaxVideo(request: Request, env: Env, context: ExecutionContext, provider: CompiledProvider,
  endpoint: CompiledEndpoint, mode: AuthMode, route: "native" | "manifest", nativePath?: string): Promise<Response> {
  if (mode !== "proxy_key") return errorResponse("minimax_video_proxy_key_required", "Video requires a proxy key", 403);
  const files = responsesFileControls(provider, endpoint), controls = responsesControls(provider, endpoint);
  const owner = new MiniMaxVideoOperation(files.length ? "file" : controls.length ? "poll" : "create", request, endpoint.timeout_ms ?? 120_000);
  const operation = owner.operation;
  try {
    if (request.url.length > 16384) miniMaxVideoDenied();
    assertVideoHeaders(request.headers);
    if (!endpoint.native_proxy || files.length && controls.length) miniMaxVideoDenied();
    const authenticate = (selection?: ProxySelection) => authenticateProxyKey(request.headers, env,
      [{ id: provider.id, tokenRef: provider.id }], false, undefined,
      selection ? { providerId: provider.id, endpointId: endpoint.id, mode: "http", model: selection.model?.upstream ?? null,
        catalogModelId: selection.model?.id ?? null, capability: selection.capability } : undefined, "authoritative", undefined, owner);
    const original = await operation.wait(owner.track(authenticate()));
    if (original instanceof Response) return original;
    if (files.length || controls.length) {
      if (request.method !== "GET" || request.body !== null) miniMaxVideoDenied();
      const query = new URL(request.url).searchParams;
      const params = route === "native" ? nativeParams(endpoint, nativePath!) : {};
      if (files.length) return await operation.wait(owner.track((await import("./managed-files.ts")).proxyManagedFile(request, env, provider,
        files.map(control => ({ ...control, endpoint, pathParams: params })), query, mode, original, undefined, context, owner)), "upstream", late => owner.discard(late));
      const control = controls[0];
      if (controls.some(candidate => candidate.protocol !== "minimax.video" || candidate.action !== "retrieve")) miniMaxVideoDenied();
      const id = await (await import("./managed-routes.ts")).managedControlIdentity("minimax.video", "retrieve", params, query);
      return await operation.wait(owner.track(proxyResponseControl(request, env, control.action, id, {}, mode, provider.id,
        controls.map(candidate => ({ createId: candidate.create.id, pathParams: params })), original, undefined,
        "minimax.video", params, context, undefined, owner)), "upstream", late => owner.discard(late));
    }
    if (request.method !== "POST" || new URL(request.url).search || endpoint.lifecycle?.protocol !== "minimax.video") miniMaxVideoDenied();
    let body: unknown = await operation.wait(owner.track(readMiniMaxVideoInput(request, owner, route)));
    let prepared;
    if (route === "manifest") {
      const envelope = manifestEnvelope(body);
      if (envelope.method && envelope.method !== "POST" || Object.keys(envelope.pathParams).length || hasProxyQuery(envelope.query)) miniMaxVideoDenied();
      prepared = prepareManifestRequest(provider, endpoint, envelope.body, {}, env); envelope.body = undefined;
    } else prepared = prepareNativeRequest(provider, endpoint, body, nativePath!, env);
    body = undefined;
    // Generic managed preparation leaves model selection to the protocol owner.
    // Native wire IDs and manifest router IDs each require one exact declared card.
    const input = requestObject(prepared.body);
    let model: CompiledProvider["models"][number] | undefined;
    for (const candidate of provider.models) {
      if ((route === "native" ? candidate.upstream : candidate.id) !== input.model) continue;
      if (model) miniMaxVideoDenied();
      model = candidate;
    }
    if (!model || !isMiniMaxVideoModel(model.upstream)
      || miniMaxVideoRequiresInline(model.upstream) && !hasMiniMaxVideoInline(owner)
      || !model.capabilities.includes("media.predict") || !modelSupportsEndpoint(provider, model, endpoint)) miniMaxVideoDenied();
    input.model = model.upstream;
    const selection: ProxySelection = { provider, endpoint, model, capability: "media.predict", body: input,
      pathParams: prepared.pathParams, method: "POST" };
    prepared.body = {};
    await operation.wait(owner.track(bindMiniMaxVideoInline(owner, input, [original.credentialId, original.principalId,
      original.policyId, original.policy.tenantId, provider.id, endpoint.id, model.id, model.upstream])));
    const auth = await operation.wait(owner.track(authenticate(selection)));
    if (auth instanceof Response) return auth;
    if (auth.credentialId !== original.credentialId || auth.principalId !== original.principalId || auth.policyId !== original.policyId
      || auth.policy.generation !== original.policy.generation || auth.policy.tenantId !== original.policy.tenantId) miniMaxVideoDenied();
    const { proxyManagedPrediction } = await import("./managed-predictions.ts");
    const task = owner.track(proxyManagedPrediction(request, env, context, auth, selection, {}, undefined, owner));
    // The managed branch owns its post-dispatch lifetime. Only delivery races the caller.
    return await operation.wait(task, "upstream", late => owner.discard(late));
  } finally { context.waitUntil(owner.finish()); }
}

async function proxyMiniMaxSearch(request: Request, env: Env, context: ExecutionContext, provider: CompiledProvider,
  endpoint: CompiledEndpoint, mode: AuthMode, route: "native" | "manifest", nativePath?: string): Promise<Response> {
  if (mode !== "proxy_key") return errorResponse("minimax_search_proxy_key_required", "Search requires a proxy key", 403);
  const admission = new JsonAdmission(request, env, mode, provider.id);
  const owner = admission.search = new MiniMaxSearchOperation(request, endpoint.timeout_ms ?? 120_000);
  try {
    assertSearchHeaders(request.headers);
    if (request.method !== "POST" || new URL(request.url).search || !miniMaxSearchRequirement({ provider, endpoint, mode: "http", model: null })) miniMaxSearchDenied();
    const auth = await owner.operation.wait(owner.track(authenticateProxyKey(request.headers, env,
      [{ id: provider.id, tokenRef: provider.id }], false, undefined,
      { providerId: provider.id, endpointId: endpoint.id, mode: "http", model: null, catalogModelId: null, capability: "search.web" }, "authoritative", owner)));
    if (auth instanceof Response) return auth;
    let body = await owner.operation.wait(owner.track(readSearchJson(request, owner.operation.signal, "input", owner.registerInput)));
    await owner.operation.wait(owner.reserveProvider());
    let prepared;
    if (route === "manifest") {
      const envelope = manifestEnvelope(body);
      if (envelope.method && envelope.method !== "POST" || Object.keys(envelope.pathParams).length || hasProxyQuery(envelope.query)) miniMaxSearchDenied();
      prepared = prepareManifestRequest(provider, endpoint, envelope.body, {}, env);
      envelope.body = undefined;
    } else prepared = prepareNativeRequest(provider, endpoint, body, nativePath!, env);
    body = undefined;
    const selection: ProxySelection = { provider, endpoint, model: prepared.model, capability: "search.web", body: prepared.body, pathParams: prepared.pathParams, method: "POST" };
    prepared.body = {};
    const trackedContext = { ...context, waitUntil(promise: Promise<unknown>) { context.waitUntil(owner.track(promise)); }, passThroughOnException: () => context.passThroughOnException() } as ExecutionContext;
    return await owner.operation.wait(owner.track(proxySelected(request, env, trackedContext, mode, selection, {}, auth, undefined, undefined, undefined, admission)), "upstream", response => owner.discard(response));
  } finally { admission.finish(context); }
}

async function proxySelected(request: Request, env: Env, context: ExecutionContext, mode: AuthMode, selection: ProxySelection, queryInput: ProxyQuery = {}, preauthenticated: AuthorizedIdentity | null = null, reservedBudget?: ReservedProxyBudget, compound?: CompoundRequestContext, auditAuth?: AuthorizedIdentity, admission?: JsonAdmission): Promise<Response> {
  const searchOwner = admission?.search;
  const published = publishedMusicInput(selection);
  const music = inlineMusicInput(selection) ?? published;
  const usageContext = Object.freeze({ providerId: selection.provider.id, requestFormat: selection.endpoint.request_format, responseFormat: selection.endpoint.response_format });
  const auth = reservedBudget?.auth ?? await selectedAuth(request, env, mode, selection, preauthenticated);
  if (auth instanceof Response) {
    if (compound && auditAuth) {
      createProxyAccounting({ context, env, auth: auditAuth, selection, request, compound })
        .fail(auth.status, auth.status === 403 ? "denied" : auth.status < 500 ? "client_error" : "provider_error");
    }
    return auth;
  }
  const identityDenial = identitySelectionDenied(request, selection.provider.id);
  if (identityDenial) {
    createProxyAccounting({ context, env, auth, selection, request, compound, cost: { reserveMicros: 0, basis: "none", inputTokens: 0, outputTokens: 0 } }).fail(identityDenial.status, "denied");
    return identityDenial;
  }
  if (selection.endpoint.request_format === "elevenlabs.speech") selection.nativeQuery = qualifyNativeQuery(selection, queryInput, new URL(request.url));
  if (selection.endpoint.request_format === "openrouter.audio_transcription"
    && (!/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i.test(request.headers.get("content-type")?.trim() ?? "")
      || ![null, "identity"].includes(request.headers.get("content-encoding"))))
    throw new HttpError(400, "invalid_native_transcription_content_type", "native transcription requires uncompressed UTF-8 JSON");
  if (selection.endpoint.inputProfile !== undefined)
    throw new HttpError(400, "managed_input_profile_required", "this endpoint requires its registered native multipart input profile");
  validateSelectedInput(selection);
  if (selection.endpoint.lifecycle || selection.endpoint.response_format === "replicate.prediction") {
    const { proxyManagedPrediction } = await import("./managed-predictions.ts");
    return proxyManagedPrediction(request, env, context, auth, selection, queryInput, admission?.wan);
  }
  const accountingContext = { context, env, auth, selection, request, compound, search: searchOwner, startedAtMs: Date.now() };
  let accounting: ReturnType<typeof createProxyAccounting> | undefined;
  let background: HttpBackground | undefined;
  let prepared: PreparedUpstream;
  let continuation: HttpContinuation | undefined;
  let googleContinuation: GoogleContinuation | undefined;
  let search: SearchSession | undefined;
  let grantFailover = false;
  try {
    // Published assets require an acknowledged reservation before their sole
    // destination claim. A soft-budget request cannot supply that authority.
    if (published && softBudgetPolicy(auth.policy)) throw new HttpError(400, "published_input_reservation_required", "published input forwarding requires authoritative budget reservation");
    const publishedPin = await published?.resolve(env, auth);
    if (isStandaloneSearch(selection.endpoint)) search = await SearchSession.resolve(env, auth, selection.body as Record<string, unknown>, selection.endpoint.id);
    continuation = await HttpContinuation.resolve(request, selection, auth, env);
    if (googleContinuationRoute(selection)) googleContinuation = await GoogleContinuation.resolve(request, selection, auth, env);
    const uploadGrant = nativeUploadGrants.get(selection);
    prepared = await prepareSelected(request, env, selection, queryInput, auth, new Set(reservedBudget?.failedGrantKey ? [reservedBudget.failedGrantKey] : []), !uploadGrant && !published, reservedBudget?.connection, publishedPin ?? search?.pinned ?? continuation?.pinned ?? googleContinuation?.pinned ?? uploadGrant, "http", true, undefined, searchOwner);
    assertRequestTariffDestination(selection.endpoint, prepared.url);
    assertNativeResponseDestination(selection.nativeResponse, prepared.url);
    grantFailover = !!(reservedBudget?.failedGrantKey || prepared.failedGrantKey);
    if (prepared.continuation) continuation?.bind(prepared.continuation);
    if (prepared.continuation && googleContinuation) await googleContinuation.bind(prepared.continuation);
    if (search) {
      if (!prepared.continuation) throw new HttpError(503, "search_state_unavailable", "search owner is unavailable");
      prepared.requestBody = JSON.stringify({ ...selection.body, id: await search.bind(prepared.continuation) });
    }
    const cost = estimateCost(selection.model, selection.body, policyRequestCost(auth.policy, selection.capability), selection.capability, selection.endpoint, continuation?.parentTools, selection.nativeResponse?.tariff, selection.provider.id);
    accounting = createProxyAccounting({ ...accountingContext, cost, grantKey: prepared.grantKey, grantLane: prepared.grantLane });
    if (reservedBudget && (reservedBudget.providerId !== selection.provider.id || reservedBudget.modelId !== selection.model?.id || reservedBudget.capability !== selection.capability || cost.reserveMicros > reservedBudget.cost.reserveMicros)) {
      accounting.fail(500, "provider_error", reservedBudget.reservation);
      return errorResponse("fusion_reservation_invalid", "fusion synthesizer reservation does not cover the final request", 500);
    }
    // Monetary coverage alone cannot prove that the final request remains priced.
    if (reservedBudget) validateBudgetReservation(selection.capability, cost, auth.policy.monthlyBudgetMicros, reservedBudget.connection, auth.policy.dailyBudgetMicros, auth.policy.limitHint, auth.policy.weeklyBudgetMicros);
  }
  catch (error) {
    let failure = selectedFailure(search?.preflightError(error) ?? continuation?.preflightError(error) ?? googleContinuation?.preflightError(error) ?? error);
    if (isModelDiscovery(selection.endpoint) && failure.status === 400 && failure.code === "grant_transport_unavailable")
      failure = new HttpError(503, "upstream_grant_pool_unavailable", `provider ${selection.provider.id} has no available scoped upstream grant`);
    const status = failure.status === 403 ? "denied" : failure.status < 500 ? "client_error" : "provider_error";
    (accounting ?? createProxyAccounting(accountingContext)).fail(failure.status, status, reservedBudget?.reservation);
    return errorResponse(failure.code, failure.message, failure.status, undefined, failure.headers);
  }
  const { cost, requestId } = accounting;
  const useSoft = !isModelDiscovery(selection.endpoint) && softBudgetPolicy(auth.policy) && !prepared.backgroundRecovery && !reservedBudget && compound?.stage !== "fusion_synthesizer";
  let soft: ReturnType<typeof softBudget> | undefined;
  let budgetMs = 0;
  let upstreamMs = 0;
  const budgetStart = performance.now();
  let reservation = reservedBudget?.reservation;
  let retention: PreparedContentRetention | null;
  try {
    if (music) {
      const pending = prepareInlineMusicRetention(env, auth, published?.retentionSelection() ?? selection, requestId, music.operation.signal);
      if (pending) music.retain(() => pending.discard());
      retention = pending;
    } else if (searchOwner) retention = await searchOwner.task(async () => {
      const pending = prepareContentRetention(env, auth, selection, requestId);
      await pending?.write(); return pending;
    });
    else retention = prepareContentRetention(env, auth, selection, requestId);
  }
  catch {
    accounting.fail(503, "provider_error", reservation);
    return errorResponse("content_retention_unavailable", "required request-content retention is temporarily unavailable", 503);
  }
  const content = retention?.contentRef ?? null;
  if (prepared.backgroundRecovery) {
    try {
      if (!prepared.continuation || !continuation || reservedBudget) throw new HttpError(400, "background_unsupported", "this route cannot own background recovery");
      const pathParams = Object.fromEntries(selection.endpoint.path_params.map(name => [name, selection.pathParams[name]]));
      background = await HttpBackground.prepare(request, env, auth, prepared.continuation, accounting.facts, prepared.connection, pathParams, prepared.headers, !Array.isArray(selection.body) && selection.body.stream === true);
      await background.admit();
      continuation.background(background.admission.id);
    } catch (error) {
      const failure = selectedFailure(error);
      // Once a durable admission was attempted, only that owner may account it.
      if (!background) accounting.fail(failure.status, failure.status === 402 ? "denied" : "provider_error");
      return errorResponse(failure.code, failure.message, failure.status);
    }
  } else if (!reservation && !useSoft) {
    try { reservation = await reserveBudget(env, auth, selection.capability, cost, prepared.connection, undefined, {
      // Fail-closed retention and stateful revalidation must finish before the
      // separate dispatch transition. Durable owners keep their own protocol.
      dispatched: !retention?.large && !prepared.revalidateAccount, search: searchOwner,
    }); }
    catch (error) {
      const failure = error instanceof HttpError ? error : new HttpError(503, "budget_store_unavailable", "budget ledger is unavailable");
      accounting.fail(failure.status, failure.status === 402 ? "denied" : failure.status < 500 ? "client_error" : "provider_error");
      return errorResponse(failure.code, failure.message, failure.status);
    }
  }
  if (useSoft) {
    const denial = softBudgetPreflight(env, auth, selection.capability, prepared.connection);
    if (denial) {
      accounting.fail(402, "denied");
      return errorResponse(denial.code, denial.message, 402);
    }
  }
  budgetMs = useSoft || !background && !reservation?.reservations.length ? 0 : performance.now() - budgetStart;
  try {
    // Durable background owners read the stored bytes, and expanded bodies must
    // not overlap transport memory: both keep the write ahead of dispatch.
    if (retention && !searchOwner && (background || retention.large)) await retention.write();
  }
  catch {
    if (background) context.waitUntil(background.unsent(503, "provider_error", null));
    else accounting.fail(503, "provider_error", reservation);
    return errorResponse("content_retention_unavailable", "required request-content retention is temporarily unavailable", 503);
  }
  if (retention && !searchOwner && !background && !retention.large) {
    // Best-effort and off the critical path: the timer lets dispatch start first,
    // so serialization and the R2 put overlap the upstream request.
    const pendingRetention = retention;
    context.waitUntil(new Promise(resolve => setTimeout(resolve, 0)).then(() => pendingRetention.write()).catch(() => logCorrelationError("request content retention failed", requestId)));
  }
  try {
    const dispatchStart = performance.now();
    if (background) await background.dispatch(content);
    else if (!useSoft) await markBudgetDispatched(env, reservation!, undefined, searchOwner);
    if (background || reservation?.reservations.length) budgetMs += performance.now() - dispatchStart;
  }
  catch {
    if (background) context.waitUntil(background.unsent(503, "provider_error", content));
    else accounting.fail(503, "provider_error", reservation, content);
    return errorResponse("accounting_unavailable", "Budget dispatch could not be recorded; no upstream request was sent.", 503);
  }
  const endpointTimeout = selection.endpoint.timeout_ms ?? 120_000;
  const operation = searchOwner?.operation ?? music?.operation ?? new HttpOperation(request.signal, Math.min(selection.timeoutMs ?? endpointTimeout, endpointTimeout));
  const signal = operation.signal;
  // Stateful auxiliary operations requalify after budget/retention awaits, under the same
  // cancellation/deadline owner as transport. Interrupted reads are known-unsent.
  if (prepared.revalidateAccount && !searchOwner) {
    try { signal.throwIfAborted(); await operation.wait(prepared.revalidateAccount(signal)); }
    catch (error) {
      const failure = signal.aborted ? new HttpError(502, "provider_unavailable", `upstream request to provider ${selection.provider.id} failed`) : selectedFailure(error);
      const status = operation.status ?? (failure.status < 500 ? "client_error" : "provider_error");
      operation.stop("upstream", error);
      accounting.fail(failure.status, status, reservation, content);
      return errorResponse(failure.code, failure.message, failure.status);
    }
  }
  const catalogInputs = prepared.featherlessCatalog || prepared.acquireDiscovery
    ? new WeakMap<ReadableStream<Uint8Array>, InputRetirement>() : undefined;
  const catalogFetches: Promise<void>[] = [], catalogRetired: Promise<void>[] = [];
  const activeCatalogInputs = new Set<InputRetirement>();
  const unclaimedCatalogResponses = new Map<Response, (response: Response) => Promise<void>>();
  let catalogWork: Promise<Response> | undefined;
  const registerCatalogInput = (input: InputRetirement, response: Response): void => {
    if (response.body) catalogInputs?.set(response.body, input);
    unclaimedCatalogResponses.delete(response);
    activeCatalogInputs.add(input);
    catalogRetired.push(input.retired);
    // Keep settlement evidence across pages, not completed readers/page bodies.
    void input.retired.then(() => activeCatalogInputs.delete(input), () => activeCatalogInputs.delete(input));
    if (signal.aborted) void input.retire("cancel", signal.reason).catch(() => undefined);
  };
  let discarded: WeakMap<Response, Promise<void>> | undefined;
  const discard = (response: Response): Promise<void> => {
    if (searchOwner) return searchOwner.discard(response);
    let pending = discarded?.get(response);
    if (!pending) {
      pending = (async () => {
        if (!catalogInputs) { await response.body?.cancel(signal.reason).catch(() => undefined); return; }
        if (!response.body) return;
        let input = catalogInputs.get(response.body);
        if (!input) {
          // A locked/used body without our owner is not a retirement receipt.
          if (response.bodyUsed || response.body.locked) throw new Error("catalog input ownership unavailable");
          input = inputRetirement(response.body.getReader());
          registerCatalogInput(input, response);
        }
        await input.retire("cancel", signal.reason);
      })();
      void pending.catch(() => undefined);
      (discarded ??= new WeakMap()).set(response, pending);
    }
    return pending;
  };
  const registerCatalogFetch = (pending: Promise<Response>, dispose = discard): void => {
    // A fetched body transfers into its reader registration. Only unclaimed
    // bodies remain strong references; settled evidence carries no page payload.
    const retired = pending.then(async response => {
      if (signal.aborted) await dispose(response);
      else unclaimedCatalogResponses.set(response, dispose);
    }, () => undefined);
    catalogFetches.push(retired);
    void retired.catch(() => undefined);
  };
  const discardNative = (value: { response: Response }) => discard(value.response);
  let response: Response | undefined;
  let priceGuard: AnthropicPriceGuard | undefined;
  let nativeLease: BodyLease | undefined;
  let nativeUsage: import("./native-response.ts").ValidatedNativeUsage | undefined;
  let nativeRead: ReturnType<NonNullable<ProxySelection["nativeResponse"]>["read"]> | undefined;
  let nativeFetch: Promise<Response> | undefined;
  let musicRead: Promise<unknown> | undefined;
  let imageRead: Promise<unknown> | undefined;
  let imageInput: ReturnType<typeof ownMiniMaxImageInput> | undefined;
  let dispatched = false;
  try {
    // A canceled preflight is known-unsent even if the ledger marks already landed.
    signal.throwIfAborted();
    nativeLease = searchOwner ? undefined : music ? music.acquireResponse() : prepared.featherlessCatalog ? acquireFeatherlessCatalog() : selection.nativeResponse?.acquire() ?? prepared.acquireDiscovery?.();
    if (!nativeModelEligible(selection.endpoint.request_format, selection.model?.upstream)) throw new HttpError(400, "model_capability_unsupported", "selected model qualification expired before dispatch");
    dispatched = !searchOwner;
    const upstreamStart = performance.now();
    const pending = published ? published.dispatch(env, prepared.requestBody, { requestId, eventId: accounting.facts.event.id,
      reservedMicros: cost.reserveMicros, reservations: (reservation?.reservations ?? []).map(({ objectName, reservationId }) => ({ objectName, reservationId })) }) : prepared.featherlessCatalog
      ? featherlessCatalogResponse({ ...prepared.featherlessCatalog, registerInput: registerCatalogInput, registerFetch: registerCatalogFetch }, operation)
      : prepared.publicCatalog
      ? fetchPublicModelDiscovery({ ...prepared.publicCatalog, operation }).then(result => Response.json(
        manifestOnlyPublicCatalog(selection.endpoint.request_format) ? result : result.catalog,
        { headers: { "cache-control": "private, no-store" } }))
      : searchOwner ? searchOwner.providerFetch(async active => {
        await prepared.revalidateAccount?.(active);
        active.throwIfAborted();
        dispatched = true;
        return fetch(prepared.url, { method: selection.method, headers: prepared.headers, body: prepared.requestBody, signal: active, redirect: "manual" });
      }) : fetch(prepared.url, { method: selection.method, headers: prepared.headers, body: prepared.requestBody, signal, redirect: "manual" });
    if (selection.nativeResponse) nativeFetch = pending;
    if (prepared.featherlessCatalog) catalogWork = pending;
    else if (catalogInputs) registerCatalogFetch(pending);
    if (useSoft) {
      soft = softBudget(env, auth, selection.capability, prepared.connection, accounting.facts.event.id, error => operation.stop("upstream", error), searchOwner);
      reservation = soft.reservation;
      context.waitUntil(soft.check);
    }
    response = await operation.wait(pending, "upstream", discard);
    if (music) {
      await music.completeUpload();
      prepared.requestBody = undefined;
    }
    accounting.observeUpstreamResponse(response, prepared.url);
    // Metadata permissions and rate limits do not establish inference health.
    if (!searchOwner && !isModelDiscovery(selection.endpoint)) captureGrantRuntime(context, env, prepared.grantKey, prepared.grantRevision, selection.provider.quota, response, selection.provider.id, selectionUpstreamModel(selection));
    if (!accounting.upstreamChargePossible && !miniMaxAnthropicRoute(selection.provider, selection.endpoint) && selection.provider.id !== "anthropic-vertex" && selection.provider.id !== "gmi" && !selection.nativeResponse && !selection.endpoint.requestPricing && !grantFailover && !isModelDiscovery(selection.endpoint) && !background && !search && !continuation?.requested && !googleContinuation?.requested && shouldFailoverGrant(response.status, selection.method, selection.capability, prepared.grantKey, grantRoutingPolicy(auth.policy.grantRouting).failover)) {
      let retry: PreparedUpstream | undefined;
      try {
        retry = await operation.wait(prepareSelected(request, env, selection, queryInput, auth, new Set([prepared.grantKey!]), true, prepared.connection));
      } catch {
        // Cancellation also bounds selection; a late result must never dispatch.
        signal.throwIfAborted();
        // Selection failure leaves the original rejection available to the caller.
      }
      if (retry) {
        signal.throwIfAborted();
        void response.body?.cancel().catch(() => undefined);
        signal.throwIfAborted();
        // The alternate may execute without returning headers. Its uncertainty
        // must not inherit the discarded attempt's nonbillable rejection.
        response = undefined;
        prepared = retry;
        accounting.setGrant(prepared.grantKey, prepared.grantLane);
        response = await operation.wait(fetch(prepared.url, { method: selection.method, headers: prepared.headers, body: prepared.requestBody, signal, redirect: "manual" }), "upstream", discard);
        accounting.observeUpstreamResponse(response, prepared.url);
        captureGrantRuntime(context, env, prepared.grantKey, prepared.grantRevision, selection.provider.quota, response, selection.provider.id, selectionUpstreamModel(selection));
        if (prepared.continuation) continuation?.bind(prepared.continuation);
        if (prepared.continuation && googleContinuation) await googleContinuation.bind(prepared.continuation);
        grantFailover = true;
      }
    }
    // Redirects cannot select a new destination or replay a credentialed body.
    // Do not pass Location downstream for the client to replay either.
    if (response.status >= 300 && response.status < 400) throw new Error("upstream redirect refused");
    if (isModelDiscovery(selection.endpoint) && !prepared.publicCatalog && !prepared.featherlessCatalog) {
      const reading = modelDiscoveryResponse(response, selection.provider, selection.endpoint, auth.policy, discoveryQuery(queryInput), operation, async (cursor, before) => {
        const pageUrl = new URL(prepared.url);
        pageUrl.searchParams.set(before ? "before_id" : "after_id", cursor);
        signal.throwIfAborted();
        const pending = fetch(pageUrl, { method: "GET", headers: prepared.headers, signal, redirect: "manual" });
        if (catalogInputs) registerCatalogFetch(pending);
        const page = await operation.wait(pending, "upstream", discard);
        return page;
      }, prepared.revalidateDiscovery ? () => operation.wait(prepared.revalidateDiscovery!(signal)) : undefined,
      catalogInputs ? registerCatalogInput : undefined);
      if (catalogInputs) catalogWork = reading;
      response = catalogInputs ? await operation.wait(reading, "upstream", discard) : await reading;
    }
    if (selection.nativeResponse) {
      if (selection.endpoint.request_format === "minimax.images") imageInput = ownMiniMaxImageInput(response);
      const reading = selection.nativeResponse.read(imageInput?.response ?? response, signal);
      nativeRead = searchOwner ? searchOwner.track(reading) : reading;
      if (imageInput) imageRead = reading;
      if (music) musicRead = reading;
      const validated = await operation.wait(reading, "upstream", discardNative);
      try { if (prepared.revalidateDelivery) await operation.wait(prepared.revalidateDelivery(signal), "publication"); }
      catch (error) { discardNative(validated); throw error; }
      await imageInput?.retire();
      response = validated.response;
      nativeUsage = "usage" in validated ? validated.usage : undefined;
    }
    upstreamMs = performance.now() - upstreamStart;
    if (soft) {
      budgetMs = await soft.beforeDelivery();
      if (soft.denial) throw soft.denial;
    }
    if (!response.ok && !selection.nativeResponse) operation.acceptRejection(response.status);
    const streaming = Array.isArray(selection.body)
      ? selection.body.some(({ query }) => !!query && typeof query === "object" && "stream" in query && query.stream === true)
      : selection.body.stream === true;
    const errorFormat = selection.endpoint.request_format.startsWith("anthropic.") ? "anthropic" : selection.endpoint.request_format.startsWith("openai.") ? "openai" : undefined;
    response = await normalizePreStreamError(response, !cost.requestTariff && streaming && !["audio.binary", "ollama.chat", "radius.messages"].includes(selection.endpoint.response_format), operation, errorFormat ? { format: errorFormat, requestId } : undefined);
    // Price inspection reads delivery bytes, not initial-response headers.
    // Search retains its original deadline through delivery; other native paths
    // retire only the timer and keep caller cancellation connected through EOF.
    if (!searchOwner) operation.retireDeadline();
    if (selection.capability === "llm.messages" && selection.endpoint.request_format === "anthropic.messages" && reservation?.reservations.length && policyRequestCost(auth.policy, selection.capability) == null) {
      priceGuard = await guardAnthropicPrice(response, tokens => tokens?.billable === false || !!anthropicPricing(selection.model?.pricing, selection.model?.upstream, accounting.facts.anthropicRequest ?? {}, tokens?.anthropic ?? {}), operation, requestId);
      response = priceGuard.response;
    }
  } catch (error) {
    if (error instanceof PublishedMusicUnsent) dispatched = false;
    if (music) {
      operation.stop("upstream", error);
      // The operation's rejection may win before a physical quarantined read
      // has acknowledged cancellation. Keep its response charge until then.
      await musicRead?.catch(() => undefined);
    }
    if (imageInput) {
      operation.stop("upstream", error);
      await imageInput.retire(error);
      await imageRead?.catch(() => undefined);
    }
    const failedLease = nativeLease;
    nativeLease = undefined;
    if (catalogInputs) {
      operation.stop("upstream", error);
      const retirement = (async () => {
        // Whole scan/projection completion closes registration. A late fetch can
        // still add its original reader while disposal is settling.
        const work = await Promise.allSettled([catalogWork?.then(discard, () => undefined), response ? discard(response) : undefined]);
        const fetches = await Promise.allSettled(catalogFetches);
        const late = await Promise.allSettled([...unclaimedCatalogResponses].map(async ([response, dispose]) => {
          await dispose(response); unclaimedCatalogResponses.delete(response);
        }));
        for (const input of activeCatalogInputs) void input.retire("cancel", signal.reason).catch(() => undefined);
        const inputs = await Promise.allSettled(catalogRetired);
        // Cleanup settlement is not success: failed ownership/lock retirement
        // cannot certify release, and never replaces the public error outcome.
        const failed = [...work, ...fetches, ...late, ...inputs].find(result => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
      })();
      context.waitUntil(retirement.then(() => failedLease?.release()));
    } else if (nativeRead || nativeFetch) {
      // Cancellation/accounting can finish now. A qualified reader settles only
      // after input retirement; late fetch/results also retain their first cleanup.
      const retirement = (async () => {
        await nativeRead?.then(discardNative, () => undefined);
        await nativeFetch?.then(discard, () => undefined);
      })();
      context.waitUntil(retirement.then(() => failedLease?.release()));
    } else failedLease?.release();
    soft?.close();
    if (soft?.denial) {
      operation.stop("upstream", soft.denial);
      if (response) void discard(response);
      if (nativeUsage?.requestCostReceipt && cost.requestTariff) context.waitUntil(accounting.settle(402, "denied", true, null, reservation!, content, null, undefined, "unknown", nativeUsage.requestCostReceipt));
      else accounting.fail(402, "denied", (cost.requestTariff || selection.nativeResponse) ? reservation : undefined, content, !!(cost.requestTariff || selection.nativeResponse) && dispatched);
      return errorResponse(soft.denial.code, soft.denial.message, 402);
    }
    operation.stop("upstream", error);
    if (response) void discard(response);
    if (!dispatched && error instanceof HttpError) {
      accounting.fail(error.status, "provider_error", reservation, content);
      return errorResponse(error.code, error.message, error.status);
    }
    // A fetch failure can incur cost; a received rejection stays nonbillable
    // even if reading its SSE error body failed.
    if (background) {
      if (!dispatched || response?.ok === false) context.waitUntil(background.unsent(response?.status ?? 502, operation.status ?? "provider_error", content));
      // Unknown dispatched delivery remains collectible; it is not a terminal.
    } else accounting.fail(isModelDiscovery(selection.endpoint) && error instanceof HttpError ? error.status : 502, isModelDiscovery(selection.endpoint) && error instanceof HttpError && error.status === 403 ? "denied" : operation.status ?? "provider_error", reservation, content, dispatched && (!!cost.requestTariff || !!selection.nativeResponse || response?.ok !== false));
    if (isModelDiscovery(selection.endpoint) && error instanceof HttpError) return errorResponse(error.code, error.message, error.status, undefined, error.headers);
    return errorResponse("provider_unavailable", `upstream request to provider ${selection.provider.id} failed`, 502, undefined);
  }
  // Existing endpoint timers cover fetch and normalization. Search instead
  // keeps its operation deadline through downstream EOF or cancellation.
  if (!searchOwner) operation.retireDeadline();
  if (continuation && response.ok && !operation.receivedRejection && selection.capability !== "llm.responses.compact") {
    try { await operation.wait(continuation.headers(response), "publication"); }
    catch (error) {
      operation.stop("publication", error);
      discard(response);
      const failure = selectedFailure(error);
      if (!background) context.waitUntil(accounting.settle(failure.status, operation.status ?? "provider_error", true, null, reservation!, content));
      return errorResponse(failure.code, failure.message, failure.status);
    }
  }
  const inspection = response.ok && !operation.receivedRejection ? continuation?.inspect(response, selection.capability === "llm.responses.compact") ?? googleContinuation?.inspect(response) : undefined;
  if (inspection && background) {
    const job = background;
    Object.assign(inspection, { observe: async (fact: import("./token-usage.ts").ResponsesObservation) => { await job.observe(fact, response!.status); } });
  }
  const observed = observeUsage(response, operation, inspection, selection.endpoint.response_format, cost.requestTariff, nativeUsage, usageContext);
  if (nativeLease) {
    const deliveryLease = nativeLease;
    context.waitUntil(observed.retired.then(() => deliveryLease.release()));
  }
  if (admission) admission.completion = observed.result;
  if (searchOwner) searchOwner.track(observed.retired);
  if (background) {
    if (!response.ok) context.waitUntil(background.unsent(response.status, operation.status ?? "provider_error", content));
    else if (operation.receivedRejection) {
      // Native HTTP-200 rejection evidence remains provisional until delivery:
      // a misbehaving upstream may send billable work after its error event.
      const job = background, statusCode = response.status;
      context.waitUntil(observed.result.then(result => job.finishRejectedDelivery({
        statusCode, status: operation.status ?? "provider_error", billable: !result.nonbillable, tokens: result.tokens, contentRef: content,
      })));
    }
  } else context.waitUntil(observed.result.then(result => {
    const failure = priceGuard?.failure();
    // Replacing an unpriced response doesn't undo the dispatched work. Retain
    // the hard reservation and record the original usage, not a free rejection.
    return failure ? accounting.pricingFailure(failure.tokens, reservation!, content)
      : accounting.complete(observed.response, result, reservation!, content, operation.status);
  }));
  response = observed.response;
  const outputHeaders = proxyResponseHeaders(response, selection.provider.id);
  // Header sanitization strips upstream router-code spoofing. Only a verified
  // local JSON replacement may restore this diagnostic; SSE fails after headers.
  if (priceGuard?.failure() && response.status === 502) outputHeaders.set("x-clawrouter-error-code", "pricing_required");
  const cacheState = admissionCacheState(auth), credential = credentialWait(auth);
  outputHeaders.set("server-timing", `cr-admission;dur=${admissionDuration(auth).toFixed(1)}, cr-budget;dur=${budgetMs.toFixed(1)}, cr-upstream-ttfb;dur=${upstreamMs.toFixed(1)}${cacheState ? `, cr-cache;desc=${cacheState}` : ""}${credential ? `, cr-credential;dur=${credential.ms.toFixed(1)};desc=${credential.cache}` : ""}`);
  outputHeaders.set("x-clawrouter-grant-lane", prepared.grantLane);
  if (grantFailover) outputHeaders.set("x-clawrouter-grant-failover", "1");
  outputHeaders.set("x-clawrouter-content-retention", music ? content ? "on; retention-days=30" : "off" : retentionRequired(auth, selection.capability) ? "on; retention-days=30" : "off");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: outputHeaders });
}

async function reserveSelected(request: Request, env: Env, context: ExecutionContext, mode: AuthMode, selection: ProxySelection, preauthenticated: AuthorizedIdentity | null, compound?: CompoundRequestContext): Promise<ReservedProxyBudget | Response> {
  const auth = await selectedAuth(request, env, mode, selection, preauthenticated);
  if (auth instanceof Response) return auth;
  let prepared: PreparedUpstream;
  try {
    prepared = await prepareSelected(request, env, selection, {}, auth, new Set(), false);
  } catch (error) {
    const failure = selectedFailure(error);
    const status = failure.status === 403 ? "denied" : failure.status < 500 ? "client_error" : "provider_error";
    createProxyAccounting({ context, env, auth, selection, request, compound }).fail(failure.status, status);
    return errorResponse(failure.code, failure.message, failure.status, undefined, failure.headers);
  }
  const accounting = createProxyAccounting({ context, env, auth, selection, request, compound });
  const { cost } = accounting;
  try {
    const reservation = await reserveBudget(env, auth, selection.capability, cost, prepared.connection);
    return { auth, reservation, cost, failedGrantKey: prepared.failedGrantKey, providerId: selection.provider.id, modelId: selection.model?.id ?? null, capability: selection.capability, connection: prepared.connection };
  } catch (error) {
    const failure = error instanceof HttpError ? error : new HttpError(503, "budget_store_unavailable", "budget ledger is unavailable");
    accounting.fail(failure.status, failure.status === 402 ? "denied" : failure.status < 500 ? "client_error" : "provider_error");
    return errorResponse(failure.code, failure.message, failure.status);
  }
}

function selectionUpstreamModel(selection: ProxySelection): string | null {
  return !Array.isArray(selection.body) && typeof selection.body.model === "string" ? selection.body.model : selection.pathParams.model ?? selection.pathParams.deployment ?? selection.pathParams.model_id ?? null;
}

async function selectedAuth(request: Request, env: Env, mode: AuthMode, selection: ProxySelection, preauthenticated: AuthorizedIdentity | null): Promise<AuthorizedIdentity | Response> {
  if (preauthenticated) return preauthenticated;
  if (mode === "access") return accessIdentity(request, env, selection.provider.id, { provider: selection.provider, endpoint: selection.endpoint, mode: "http", model: selection.model?.id ?? selectionUpstreamModel(selection) });
  return (await preauthenticate(request, env, mode, selection.provider.id))!;
}

export async function prepareSelected(request: Request, env: Env, selection: ProxySelection, queryInput: ProxyQuery, auth: AuthorizedIdentity, excludedGrantKeys: ReadonlySet<string> = new Set(), recordSelection = true, resolvedConnection?: ProviderConnection, pinned?: PinnedGrant, transport: "http" | "websocket" = "http", recoverBackground = false, wan?: WanManagedOperation, searchOwner?: MiniMaxSearchOperation, video?: MiniMaxVideoOperation): Promise<PreparedUpstream> {
  assertMultipartIntake(selection);
  const prepare = (excluded: ReadonlySet<string>) => prepareSingleSelected(request, env, selection, queryInput, auth, excluded, recordSelection, resolvedConnection, pinned, transport, recoverBackground, wan, searchOwner, video);
  try { return await prepare(excludedGrantKeys); }
  catch (error) {
    const routing = grantRoutingPolicy(auth.policy.grantRouting);
    if (!(error instanceof SelectedGrantCredentialFailure) || video || searchOwner || wan || wanCreate(selection.endpoint) || pinned || selection.provider.id === "anthropic-vertex" || inlineMusicInput(selection) || publishedMusicInput(selection) || openRouterPcmRequirement({ ...selection, model: selection.model?.upstream }) || isModelDiscovery(selection.endpoint) || nativeRawFormat(selection.endpoint.request_format) || isStandaloneSearch(selection.endpoint) || ["minimax.speech", "minimax.images", "minimax.music"].includes(selection.endpoint.request_format) || miniMaxAnthropicRoute(selection.provider, selection.endpoint) || excludedGrantKeys.size || !routing.failover) throw error;
    try {
      const retry = await prepare(new Set([error.grantKey]));
      if (!retry.grantKey && !grantRoutingPolicy(auth.policy.grantRouting).environmentFallback) throw error;
      return { ...retry, failedGrantKey: error.grantKey };
    } catch { throw error; } // No usable alternate: preserve the original credential failure.
  }
}

async function prepareSingleSelected(request: Request, env: Env, selection: ProxySelection, queryInput: ProxyQuery, auth: AuthorizedIdentity, excludedGrantKeys: ReadonlySet<string> = new Set(), recordSelection = true, resolvedConnection?: ProviderConnection, pinned?: PinnedGrant, transport: "http" | "websocket" = "http", recoverBackground = false, wan?: WanManagedOperation, searchOwner?: MiniMaxSearchOperation, video?: MiniMaxVideoOperation): Promise<PreparedUpstream> {
  assertPolicyModel(auth.policy, selection);
  if (isModelDiscovery(selection.endpoint)) {
    queryInput = discoveryQuery(queryInput);
    validateDiscoveryQuery(selection.provider, selection.endpoint, auth.policy, queryInput);
  }
  if (selection.endpoint.upstreamPath !== undefined && !isModelDiscovery(selection.endpoint)
    && (hasProxyQuery(queryInput) || new URL(request.url).search))
    throw new HttpError(400, "invalid_mapped_endpoint_query", "mapped operation options must be in the request body");
  if (selection.nativeResponse || selection.nativeQuery || selection.endpoint.request_format === "elevenlabs.speech")
    queryInput = nativeDispatchQuery(selection, queryInput, new URL(request.url));
  assertServiceTier(auth, selection);
  if (selection.endpoint.request_format === "openai.responses_input_tokens") assertInputTokensRequest(request, queryInput);
  if (selection.endpoint.request_format === "openai.images_generations" && (hasProxyQuery(queryInput) || new URL(request.url).search)) throw new HttpError(400, "invalid_image_generation", "image generation options must be in JSON, not query parameters");
  const compact = selection.endpoint.request_format === "openai.responses_compact";
  const search = isStandaloneSearch(selection.endpoint);
  if (search && (hasProxyQuery(queryInput) || new URL(request.url).search)) throw new HttpError(400, "invalid_search_query", "search options must be in JSON, not query parameters");
  if (compact && (hasProxyQuery(queryInput) || new URL(request.url).search)) throw new HttpError(400, "invalid_compact_query", "compaction options must be in JSON, not query parameters");
  let connection: ProviderConnection;
  try { connection = await assertProviderAccess(selection.provider, auth, env, resolvedConnection, wan, video); }
  catch (error) { throw error instanceof HttpError ? error : new HttpError(503, "provider_unavailable", "provider authorization failed"); }
  // Native owner materialization follows known monetary denials. Messages
  // may refresh inside the owner; images may only read the exact admitted key.
  if ((["minimax.images", "minimax.music", "minimax.search", "minimax.video_create"].includes(selection.endpoint.request_format) || miniMaxAnthropicRoute(selection.provider, selection.endpoint) || vertexAnthropicRoute(selection.provider, selection.endpoint)) && !softBudgetPolicy(auth.policy)) {
    const cost = estimateCost(selection.model, selection.body, policyRequestCost(auth.policy, selection.capability),
      selection.capability, selection.endpoint, undefined, undefined, selection.provider.id);
    validateBudgetReservation(selection.capability, cost, auth.policy.monthlyBudgetMicros, connection,
      auth.policy.dailyBudgetMicros, auth.policy.limitHint, auth.policy.weeklyBudgetMicros);
  }
  let upstream: UpstreamAuth;
  if (video) videoJsonBytes(selection.body, "input");
  const stickyHash = await grantStickyHash(request, auth);
  try { upstream = await upstreamAuth(selection.provider, auth, env, excludedGrantKeys, stickyHash, recordSelection, pinned, { provider: selection.provider, endpoint: selection.endpoint, mode: transport, model: selectionUpstreamModel(selection), managedLifecycle: !!selection.endpoint.lifecycle }, video?.controlSignal ?? searchOwner?.operation.signal ?? request.signal, wan, searchOwner, video); }
  catch (error) { throw error instanceof HttpError ? error : new HttpError(503, "provider_not_configured", "provider is not configured"); }
  try {
    if (compact) await assertCompactAccount(auth, env, upstream);
    if (search) await assertSingleOpenAiAccount(auth, env, upstream, "search");
    assertPolicyModel(auth.policy, selection);
    assertServiceTier(auth, selection, upstream.transport);
    if (publicCatalogProvider(selection.endpoint.request_format)) {
      if (transport !== "http") throw new HttpError(400, "invalid_model_discovery", "public model catalogs require HTTP");
      const publicCatalog = await preparePublicDiscoveryOwner(request, env, auth, selection, upstream);
      // The public factories own physical URLs and headers. The selected
      // inference credential remains local authority and is never forwarded.
      return { publicCatalog, headers: new Headers(), url: new URL(upstream.baseUrl), requestBody: undefined,
        grantKey: upstream.grantKey, grantLane: upstream.grantLane, grantRevision: upstream.grantRevision,
        connection, websocket: false, backgroundRecovery: false };
    }
    if (selection.endpoint.request_format === "featherless.catalog") {
      if (transport !== "http") throw new HttpError(400, "invalid_model_discovery", "model catalogs require HTTP");
      const featherlessCatalog = await prepareFeatherlessCatalogOwner(request, env, auth, selection, upstream);
      return { featherlessCatalog, headers: new Headers(), url: new URL(upstream.baseUrl), requestBody: undefined,
        grantKey: upstream.grantKey, grantLane: upstream.grantLane, grantRevision: upstream.grantRevision,
        connection, websocket: false, backgroundRecovery: false };
    }
    const lifecycle = { provider: selection.provider, endpoint: selection.endpoint, mode: transport, responsesLifecycle: true };
    // Decide once from the materialized transport, before reservation. An
    // ordinary failover cannot promote an already reserved request into a job.
    const backgroundRecovery = recoverBackground && backgroundResponse(selection.endpoint, selection.body) && grantSupports(lifecycle, upstream.grant);
    if (selection.endpoint.lifecycle) assertOperationConfiguration({ provider: selection.provider, endpoint: selection.endpoint, mode: transport, managedLifecycle: true, ...(video ? { model: selection.model?.upstream } : {}) }, upstream.grant, env);
    if (backgroundRecovery) {
      assertOperationConfiguration(lifecycle, upstream.grant, env);
      if (hasProxyQuery(queryInput) || new URL(request.url).search) throw new HttpError(400, "background_query_unsupported", "background create options must be in JSON; caller query parameters are unsupported");
    }
    const converse = ["aws_bedrock.converse", "aws_bedrock.converse_stream"].includes(selection.endpoint.request_format);
    if (converse) {
      if (transport !== "http" || upstream.transport || upstream.query.size || hasProxyQuery(queryInput) || new URL(request.url).search)
        throw new HttpError(400, "invalid_native_bedrock_converse_destination", "Bedrock Converse requires the original regional HTTP route without transport or query overrides");
      // The native codec removes routing-only fields. Prepare that payload
      // before its one serialization and SigV4 hash, using the selected origin.
      selection.nativeResponse = prepareNativeBedrockConverse(selection, { origin: upstream.baseUrl })
        ?? prepareNativeBedrockConverseStream(selection, { origin: upstream.baseUrl });
    }
    const minimaxAnthropic = miniMaxAnthropicRoute(selection.provider, selection.endpoint)
      ? await prepareMiniMaxAnthropicDispatch(request, env, auth, selection, upstream, hasProxyQuery(queryInput), transport) : undefined;
    if (minimaxAnthropic) upstream = minimaxAnthropic.upstream;
    const vertexAnthropic = vertexAnthropicRoute(selection.provider, selection.endpoint)
      ? await prepareVertexAnthropicDispatch(request, env, auth, selection, upstream, hasProxyQuery(queryInput), transport) : undefined;
    if (wanCreate(selection.endpoint)) { preflightWanJson(selection.body); assertWanHeaders(request.headers); assertWanHeaders(upstream.headers); }
    const { headers, url, configuredOwnerUrl, requestBody, streamBody } = vertexAnthropic?.prepared ?? prepareUpstreamRequest(request, env, selection, queryInput, upstream, transport);
    minimaxAnthropic?.apply(url, headers);
    const gmiCheck = selection.provider.id === "gmi"
      ? await prepareGmiOrganizationBinding(request, env, auth, selection, upstream, url, headers) : undefined;
    const discoveryCheck = gmiCheck ?? (["openai.models", REQUESTY_MODELS_FORMAT].includes(selection.endpoint.request_format) && selection.capability === "models.list"
      ? await prepareModelDiscoveryOwner(request, env, auth, selection, upstream, url, headers) : undefined);
    if (selection.provider.id === "opencode" || selection.provider.id === "opencode-go") {
      for (const name of openCodeSessionHeaders) headers.delete(name);
      const session = transport === "http" ? await openCodeSessionHeader(request, auth, selection, upstream, url) : null;
      if (session) headers.set(session.name, session.value);
    }
    const signingRegion = !streamBody ? await signSigV4(selection.provider, url, selection.method, requestBody as string | undefined, headers, env, upstream.grant) : undefined;
    if (selection.provider.id === "aws-bedrock" && (selection.capability === "llm.embeddings" || converse)) {
      const signingScheme = selection.provider.auth.schemes.find(scheme => scheme.type === "sig_v4");
      if (transport !== "http" || signingScheme?.type !== "sig_v4" || signingScheme.service !== "bedrock"
        || !signingRegion || url.origin !== `https://bedrock-runtime.${signingRegion}.amazonaws.com`
        || hasProxyQuery(queryInput) || new URL(request.url).search)
        throw new HttpError(400, converse ? "invalid_native_bedrock_converse_destination" : "invalid_native_bedrock_embedding_destination", converse
          ? "Bedrock Converse requires the original signed regional destination without query options"
          : "Bedrock embeddings require the original signed regional destination without query options");
      if (!converse) selection.nativeResponse = prepareNativeBedrockEmbedding(selection, { origin: url.origin });
      assertNativeResponseDestination(selection.nativeResponse, url);
    }
    const chatCheck = veniceChat(selection)
      ? await prepareVeniceChatAuthority(env, auth, selection, upstream, url, headers) : undefined;
    if (chatCheck) selection.nativeResponse = prepareVeniceChatResponse(selection, chatCheck);
    const catalogCheck = isKeyedModelDiscovery(selection.endpoint.request_format)
      ? await prepareKeyedModelDiscovery(request, env, auth, selection, upstream, url, headers) : undefined;
    const pcmCheck = openRouterPcmRequirement({ ...selection, model: selection.model?.upstream })
      ? await prepareOpenRouterPcmOwner(env, auth, selection, upstream, url, headers) : undefined;
    const music = inlineMusicInput(selection);
    const published = publishedMusicInput(selection);
    const musicCheck = published ? await published.bind(upstream, url, headers)
      : music ? await prepareInlineMusicOwner(env, auth, selection, upstream, url, headers, music.evidence) : undefined;
    const imageCheck = selection.endpoint.request_format === "minimax.images"
      ? prepareMiniMaxImageDispatch(env, auth, selection, upstream, url, headers) : undefined;
    const nativeMediaCheck = ["minimax.speech", "minimax.music"].includes(selection.endpoint.request_format)
      ? await prepareMiniMaxMediaDispatch(selection, env, upstream, url, headers, auth) : undefined;
    let continuation: ContinuationOwner | undefined;
    if (selection.capability === "llm.responses" || compact || search || selection.endpoint.lifecycle || googleContinuationRoute(selection)) {
      if (upstream.grantKey && !upstream.grant?.credentialLineage && !googleContinuationRoute(selection)) throw new HttpError(503, "continuation_unavailable", "upstream credential ownership is unavailable");
      const create = compact ? selection.provider.endpoints.find(endpoint => endpoint.id === selection.provider.capabilities.find(capability => capability.id === "llm.responses")?.endpoint) : selection.endpoint;
      if (!create) throw new HttpError(503, "continuation_unavailable", "Responses creation ownership is unavailable");
      const ownerUrl = compact ? new URL(upstream.baseUrl.replace(/\/$/, "") + upstreamPath(selection.provider, create, {}, env, upstream)) : configuredOwnerUrl;
      if (compact) upstream.query.forEach((value, name) => ownerUrl.searchParams.set(name, value));
      continuation = {
        providerId: selection.provider.id, endpointId: create.id, grantKey: upstream.grantKey,
        lineage: upstream.grant?.credentialLineage ?? null,
        // A WebSocket GET is only the handshake; both transports execute the
        // same logical Responses POST and must share continuation ownership.
        routeSha256: await responseRouteDigest(selection.provider, upstream, ownerUrl, headers, upstream.grantKey, selection.endpoint.lifecycle, env, selection.pathParams, selection.model?.upstream),
        policyGeneration: auth.policy.generation,
      };
    }
    const videoCheck = video ? prepareMiniMaxVideoDispatch(env, auth, selection, upstream, url, headers, video) : undefined;
    const tokenPlanCheck = searchOwner ? prepareMiniMaxSearchDispatch(env, auth, selection, upstream, url, headers, searchOwner) : undefined;
    if (searchOwner) {
      const origin = upstream.grant?.minimaxSearchBinding?.origin;
      if (!origin) miniMaxSearchDenied();
      selection.nativeResponse = prepareNativeMiniMaxSearch(selection, { origin, operation: searchOwner });
      if (!selection.nativeResponse) miniMaxSearchDenied();
      assertNativeResponseDestination(selection.nativeResponse, url);
    }
    const wanCheck = wanCreate(selection.endpoint) && continuation
      ? wanCreateAuthority(env, auth, selection, upstream, configuredOwnerUrl, headers, continuation, wan) : undefined;
    return { headers, url, requestBody, grantKey: upstream.grantKey, grantLane: upstream.grantLane, grantRevision: upstream.grantRevision, connection, websocket: ["openai.responses", "openai.realtime"].includes(selection.endpoint.websocket ?? "") && upstream.transport === null, backgroundRecovery, continuation, ...(selection.endpoint.lifecycle ? { managedBaseUrl: upstream.baseUrl } : {}), ...(videoCheck ? { revalidateAccount: videoCheck } : tokenPlanCheck ? { revalidateAccount: tokenPlanCheck, revalidateDelivery: tokenPlanCheck } : wanCheck ? { revalidateAccount: wanCheck } : chatCheck ? { revalidateAccount: chatCheck.revalidate, ...(!Array.isArray(selection.body) && selection.body.stream === true ? {} : { revalidateDelivery: chatCheck.revalidate }) } : discoveryCheck ? { revalidateAccount: async (signal: AbortSignal) => { await discoveryCheck(signal); }, ...(isModelDiscovery(selection.endpoint) ? { revalidateDiscovery: discoveryCheck, acquireDiscovery: () => nativeResponseLease(16 * 1024 * 1024) } : {}) } : catalogCheck ? { revalidateAccount: catalogCheck } : musicCheck ? { revalidateAccount: musicCheck.revalidate, revalidateDelivery: musicCheck.revalidate } : pcmCheck ? { revalidateAccount: pcmCheck } : vertexAnthropic ? { revalidateAccount: vertexAnthropic.revalidate } : minimaxAnthropic ? { revalidateAccount: minimaxAnthropic.revalidate } : imageCheck ? { revalidateAccount: imageCheck } : nativeMediaCheck ? { revalidateAccount: nativeMediaCheck } : compact || search ? { revalidateAccount: () => assertSingleOpenAiAccount(auth, env, upstream, search ? "search" : "compact") } : {}) };
  } catch (error) {
    throw error instanceof HttpError ? error : new HttpError(503, "provider_request_invalid", "provider request configuration is invalid");
  }
}

// The create keeps its selected key through durable waits. Metadata inspection
// never materializes a replacement secret or turns another grant into a retry.
function wanCreateAuthority(env: Env, auth: AuthorizedIdentity, selection: ProxySelection, upstream: UpstreamAuth,
  url: URL, headers: Headers, owner: ContinuationOwner, wan?: WanManagedOperation): (signal: AbortSignal) => Promise<void> {
  const caller = publicControlAuthorization(auth), selected = upstream.grant;
  const originalGeneration = selected?.credentialGeneration, originalLineage = selected?.credentialLineage;
  const unavailable = () => { throw new HttpError(503, "prediction_owner_unavailable", "the original Wan owner or destination is unavailable"); };
  return async signal => {
    const policy = await authorizeResponseControl(env, caller, owner, signal, undefined, wan);
    if (!policy) unavailable();
    assertPolicyModel(policy!, selection);
    const configured = configuredUpstream(selection.provider, selected, env);
    assertWanHeaders(configured.headers);
    const destination = new URL(configured.baseUrl.replace(/\/$/, "") + upstreamPath(selection.provider, selection.endpoint, selection.pathParams, env, configured));
    configured.query.forEach((value, name) => destination.searchParams.set(name, value));
    if (destination.href !== url.href || await responseRouteDigest(selection.provider, configured, destination, headers,
      upstream.grantKey, selection.endpoint.lifecycle, env, selection.pathParams) !== owner.routeSha256) unavailable();
    if (upstream.grantKey) {
      const current = await inspectGrantCredentials(env, upstream.grantKey, signal, wan);
      if (!selected || !Number.isSafeInteger(originalGeneration) || !originalLineage
        || current.provider !== selected.provider || current.kind !== selected.kind || current.accountId !== selected.accountId
        || current.enabled !== true || current.revokedAt || current.credentialStatus !== "active"
        || current.credentialGeneration !== originalGeneration || current.credentialLineage !== originalLineage
        || current.updatedAt !== selected.updatedAt
        || current.expiresAt && (!Number.isFinite(Date.parse(current.expiresAt)) || Date.parse(current.expiresAt) <= Date.now())) unavailable();
      assertOperationConfiguration({ provider: selection.provider, endpoint: selection.endpoint, mode: "http", model: selection.model?.upstream, managedLifecycle: true }, current, env);
    } else {
      const current = configuredUpstream(selection.provider, null, env);
      assertWanHeaders(current.headers);
      if (current.baseUrl !== configured.baseUrl || current.query.toString() !== configured.query.toString()
        || [...current.headers].length !== [...configured.headers].length
        || [...current.headers].some(([name, value]) => configured.headers.get(name) !== value)) unavailable();
    }
    // Inspect is an await too: reject configuration movement after the earlier
    // digest check, without constructing another request or selecting a key.
    const final = configuredUpstream(selection.provider, selected, env);
    assertWanHeaders(final.headers);
    if (final.baseUrl !== configured.baseUrl || final.query.toString() !== configured.query.toString()
      || [...final.headers].length !== [...configured.headers].length
      || [...final.headers].some(([name, value]) => configured.headers.get(name) !== value)) unavailable();
    signal.throwIfAborted(); assertControlCallerLive(caller);
  };
}

export function captureGrantRuntime(context: ExecutionContext, env: Env, key: string | null, revision: string | null, quota: CompiledQuotaConfig, response: Pick<Response, "status" | "headers">, providerId?: string, model?: string | null): void {
  if (!key) return;
  // A rejected credential must not keep serving from this isolate's cache.
  if (response.status === 401 || response.status === 403) evictGrantCredentials(key);
  const state = observeProviderGrantQuota(providerId, response, quota, model);
  if (!state) return;
  const direct = queueGrantRuntime(env, key, { ...state, grantRevision: revision });
  if (direct) context.waitUntil(direct);
}

function grantStickyHash(request: Request, auth: AuthorizedIdentity): Promise<string | null> {
  return grantStickyInput(auth, proxySessionHash(auth), correlationMetadata(request).sessionId);
}

function selectedFailure(error: unknown): HttpError {
  return error instanceof HttpError ? error : new HttpError(503, "provider_unavailable", "provider request preflight failed");
}

async function auditSelectionFailure(request: Request, env: Env, context: ExecutionContext, mode: AuthMode, selection: ProxySelection, preauthenticated: AuthorizedIdentity | null, statusCode: number, compound: CompoundRequestContext, auditAuth?: AuthorizedIdentity): Promise<void> {
  const selected = await selectedAuth(request, env, mode, selection, preauthenticated);
  const auth = selected instanceof Response ? auditAuth : selected;
  if (!auth) return;
  const status = statusCode === 403 ? "denied" : statusCode < 500 ? "client_error" : "provider_error";
  createProxyAccounting({ context, env, auth, selection, request, compound }).fail(statusCode, status);
}

async function preauthenticate(request: Request, env: Env, mode: AuthMode, providerId?: string, requirement?: import("./provider-auth").GrantRequirement, selection?: ProxySelection, freshness: "cached" | "authoritative" = "cached"): Promise<AuthorizedIdentity | Response | null> {
  if (mode === "proxy_key") {
    // Continuations select their recorded owner later. Invalid operations must
    // retain their existing error precedence without incrementing counters.
    if (selection) {
      try { validateSelectedInput(selection); }
      catch { selection = undefined; }
      if (selection && ["llm.responses", "llm.responses.compact"].includes(selection.capability) && (request.headers.has("x-codex-turn-state") || !Array.isArray(selection.body) && selection.body.previous_response_id)) selection = undefined;
      if (selection && googleContinuationRequested(selection)) selection = undefined;
    }
    const provider = providerId ? providerById(providerId) : null;
    return authenticateProxyKey(request.headers, env, provider ? [{ id: provider.id, tokenRef: provider.auth.schemes.find(scheme => scheme.type === "oauth")?.tokenRef ?? provider.id }] : [], false, correlationMetadata(request).sessionId, selection ? { providerId: selection.provider.id, endpointId: selection.endpoint.id, mode: "http", model: selectionUpstreamModel(selection), catalogModelId: selection.model?.id ?? null, capability: selection.capability } : undefined, freshness);
  }
  return providerId ? accessIdentity(request, env, providerId, requirement) : null;
}
