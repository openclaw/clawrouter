import { setOwnedHeader, ProxyCompletion, inspectOwnedBytes, newOwnedBytes, ownedByteLength, ownedByteSubarray, copyOwnedBytes, newOwnedDecoder, decodeOwnedBytes } from "./proxy-completion.ts";
import { isIdentityFailure, identityFailure } from "./identity-admission.ts";
import { beginOwnedHttpProxyPublicationHeaders, checkOwnedHttpProxyPublicationBody, finishOwnedHttpProxyPublication, beginOwnedHttpUpload, beginOwnedHttpRevalidation, prepareOwnedHttpAccounting, finishOwnedHttpRevalidationPreparation, discardOwnedHttpInitialError, admitOwnedHttpErrorText, isOwnedHttpLocalFailure, checkOwnedHttpRequest, matchesOwnedHttpRequestInputs, canCompleteOwnedHttpPreparation, checkOwnedHttpUpload, holdOwnedHttpUploadSerialization, abandonOwnedHttpUpload, growOwnedHttpRequest, ownedHttpSinkOwner, startOwnedHttpProviderFetch, consumeOwnedHttpProviderResponse, disposeOwnedHttpProviderResponse, matchesOwnedHttpProviderHandoff, ownedHttpSignal, cancelOwnedHttpResponse,
  beginOwnedHttpIntakeDiagnostics, ownedHttpIntakeFailure, finishOwnedHttpIntakeDiagnostics,
  beginOwnedHttpSinkRegistration, completeOwnedHttpSinkRegistration, abandonUnstartedOwnedHttpRegistration,
  ownedHttpCompletion, holdOwnedHttpRequest, dispatchOwnedHttpUpload, ownOwnedHttpResponse,
  beginOwnedHttpGenericUsage, consumeOwnedHttpGenericUsage, failOwnedHttpGenericUsage, abandonOwnedHttpGenericUsage, type OwnedHttpUsage,
  type OwnedHttpRequest, type OwnedHttpUpload } from "./http-identity-owner.ts";
import { providerConfigurationList } from "./provider-connections.ts";
import { prepareOwnedHttpPricing, adoptOwnedHttpTierBody, takeOwnedHttpMediaAdmission, enterOwnedHttpPricing, leaveOwnedHttpPricing, retireOwnedHttpPricing } from "./pricing.ts";
import { ownsOwnedHttpSelectionPermit, prepareOwnedHttpProvider, reserveOwnedHttpProviderPreparation, retireOwnedHttpProviderPreparation } from "./providers.ts";
import { createPrivateJsonBodyParser, JsonBodyStructureLimit, privateMediaJsonBody, privateUploadJson, type MediaJsonBody } from "./json-body.ts";
import { bindOwnedHttpAuthentication, matchesOwnedHttpAuthentication, queueOwnedHttpSelectionRuntime,
  invalidateOwnedHttpSelectionCredentials, finishOwnedHttpForegroundCommands, matchesOwnedHttpCredentialPreparation, reduceOwnedHttpPreparedCredential, type OwnedHttpCredential, type GenerationSelectionHandle } from "./credential-preflight.ts";
import { admitAccountingJson, isAccountingAdmissionFailure } from "./json-body.ts";
import { PreparationAdmission, isPreparationLimit, preparationHeader, templateCandidates, preparationValue } from "./provider-templates.ts";
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
import { prepareVeniceChatAuthority, prepareOwnedVeniceChatAuthority } from "./venice-chat-authority.ts";
import { prepareVeniceChatResponse, veniceChat, prepareOwnedVeniceChatCodec, checkOwnedVeniceChatCodec,
  readOwnedVeniceChatResponse, forwardOwnedVeniceUsage, matchesOwnedVeniceUsage } from "./venice-chat-runtime.ts";
import type { OwnedHttpRevalidation } from "./http-identity-owner.ts";
import { acquireFeatherlessCatalog, featherlessCatalogResponse, prepareFeatherlessCatalogOwner } from "./featherless-catalog-runtime.ts";
import { isKeyedModelDiscovery, prepareKeyedModelDiscovery } from "./keyed-model-discovery.ts";
import { prepareGmiOrganizationBinding, prepareOwnedGmiOrganizationBinding } from "./gmi-organization-binding.ts";
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
import { softBudget, prepareSoftBudget, startSoftBudget, softBudgetPolicy, softBudgetPreflight, prepareOwnedHttpSoftBudget, startOwnedHttpSoftBudget, ownedHttpSoftBudgetCheck, beforeOwnedHttpSoftDelivery, ownedHttpSoftDenial, closeOwnedHttpSoftBudget } from "./soft-budget.ts";
import { prepareUpstreamRequest, prepareOwnedUpstreamRequest } from "./proxy-upstream-request.ts";
import { BodyLease, ExactBodyCharge, bodyLeaseMinimum } from "./body-budget.ts";
import { WanManagedOperation, readWanJson, wanRequestBytes, preflightWanJson, assertWanHeaders } from "./managed-media-json.ts";
import { hasProxyQuery, type ProxyQuery } from "./proxy-query.ts";
import { inheritLocalError } from "./native-errors.ts";
import { identitySelectionDenied } from "./native-request-headers.ts";
import { assertCompactAccount } from "./responses-compact.ts";
import { assertServiceTier } from "./service-tiers.ts";
import { grantStickyInput } from "./grant-sticky.ts";
import { assertPolicyModel } from "./policy-models.ts";
import { assessModelRequest } from "../shared/model-request-parameters.ts";
import { admitAccountingFacts, createProxyAccounting, createOwnedHttpPreparationAccounting, createOwnedHttpAccountingCommand, matchesOwnedHttpAccountingCommand, estimateCost, type AccountingOutcome, type OwnedHttpAccountingCommand, type OwnedHttpPreparationAccounting, type CompoundRequestContext } from "./proxy-accounting";
import { authenticateProxyKey, authenticateOwnedHttp, proxySessionHash, retireOwnedHttpControlVerification } from "./proxy-auth";
import { queueGrantRuntime } from "./admission-cache.ts";
import { evictGrantCredentials } from "./credential-cache.ts";
import { admissionCacheState, admissionDuration, credentialWait } from "./admission-timing.ts";
import {
  concreteOwnedOpenAiSelection, concreteOpenAiSelection, directManifestEnvelope, isSelectionFailure, manifestEnvelope, nativeMatch, nativeModelEndpoint, nativeParams,
  prepareManifestRequest, prepareNativeRequest, requestObject, validateSelectedInput, type ProxySelection,
} from "./proxy-selection";
import { accessIdentity, accessSessionIdentity, verifiedAccessSession } from "./access";
import { planBudgetReservation, markBudgetDispatched, reserveBudget, validateBudgetReservation, type BudgetReservation, type EstimatedCost } from "./accounting";
import { admitProspectiveContentRetention, prepareContentRetention, prepareOwnedHttpContentRetention, prepareInlineMusicRetention, retentionRequired, type PreparedContentRetention } from "./content-retention";
import { correlationMetadata, logCorrelationError } from "./correlation.ts";
import {
  FUSION_MODEL_ID, prepareFusionAccounting, buildFusionReservationProposals, collectFusionProposals,
  fusionMessagesValid, prepareAdviserBody,
} from "./fusion";
import { loadFusionConfig } from "./fusion-config";
import { shouldFailoverGrant } from "./grant-quota";
import { observeProviderGrantQuota, providerCreditExhausted } from "./provider-quota.ts";
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
import { inspectJsonError, normalizePreStreamError, observeUsage, proxyResponseHeaders, beginOwnedCodecConsumer,
  normalizeOwnedCodecPreStreamError, normalizeOwnedHttpPreStreamError, observeOwnedCodecUsage, ownedCodecConsumerRetirement,
  observeOwnedGenericUsage, ownedGenericUsageRetirement, matchesOwnedCodecUsage, abandonOwnedCodecConsumer, type OwnedCodecConsumer, type ObservedUsage } from "./proxy-response";
import type { AuthorizedIdentity, CompiledEndpoint, CompiledProvider, CompiledQuotaConfig, Env, ProviderConnection } from "./types";
import {
  decodePathSegment,
  ownedErrorResponse, ownedHttpError, errorResponse, HttpError, json, maxJsonBodyBytes, maxMediaJsonBodyBytes, randomId, readJson, type JsonIntake,
} from "./utils";

const MAX_GRANT_ATTEMPTS = 4;

type AuthMode = "proxy_key" | "access";

type OwnedPreparedFields = ReturnType<typeof prepareUpstreamRequest>;
interface OwnedRetryPort {
  phase: number; input?: import("./authority-admission.ts").AdmissionSelection;
  signal?: AbortSignal; permit?: object; prepared?: PreparedUpstream; upload?: OwnedHttpUpload; identity?: AuthorizedIdentity; credential?: OwnedHttpCredential;
}
interface OwnedRetryAuthority { ports: OwnedRetryPort[]; excluded: Set<string>; next: number; pending?: OwnedRetryPort }
interface OwnedProxyInvocation {
  context: ExecutionContext;
  admission?: JsonAdmission;
  selection?: ProxySelection;
  initialSelectionBody?: Record<string, unknown>;
  normalizingResponse?: Response;
  identity?: AuthorizedIdentity;
  required?: import("./authority-admission.ts").AdmissionSelection;
  prepared?: PreparedUpstream;
  preparationAdmitted?: true;
  archivePrepared?: true;
  foregroundCommandsClosed?: true;
  upload?: OwnedHttpUpload;
  attempts: OwnedHttpUpload[];
  retry?: OwnedRetryAuthority;
  retryClosed?: true;
  preparingIdentity?: AuthorizedIdentity;
  preparingUpstream?: UpstreamAuth;
  preparingFields?: OwnedPreparedFields;
  preparingAdmission?: PreparationAdmission;
  nativeResponse?: Response;
  incomingResponse?: Response;
  nativeSignal?: AbortSignal;
  nativeUsage?: import("./native-response.ts").ValidatedNativeUsage;
  publicBody?: ReadableStream<Uint8Array> | null;
  operation?: HttpOperation;
  consumer?: OwnedCodecConsumer;
  genericUsage?: OwnedHttpUsage;
  usageInput?: Response;
  observedUsage?: ObservedUsage;
  usageContext?: Readonly<import("./token-usage.ts").UsageTokenContext>;
  requestId?: string;
  softPlan?: ReturnType<typeof prepareSoftBudget>;
  softAttempt?: OwnedHttpUpload;
  accounting?: OwnedHttpAccountingCommand;
  accountingCost?: EstimatedCost;
  accountingPlan?: unknown;
  terminalResponse?: Response;
  terminalReservation?: BudgetReservation;
  terminalContent?: string | null;
  accountingHandoff?: number;
  accountingReady?: Promise<void>;
  resolveAccounting?: () => void;
  accountingWork?: Promise<boolean>;
  accountingRegistration?: ReturnType<typeof beginOwnedHttpSinkRegistration>;
  accountingOutcome?: AccountingOutcome;
  accountingStatus?: number;
  accountingDispatched?: boolean;
}
interface OwnedPreparationReceiver { owner: OwnedHttpRequest; fields?: OwnedPreparedFields }
let ownedProxyInvocations: WeakMap<OwnedHttpRequest, OwnedProxyInvocation> | undefined;
let ownedPreparationReceivers: WeakMap<OwnedHttpUpload, OwnedPreparationReceiver> | undefined;
let ownedPreparedSelections: WeakMap<PreparedUpstream, GenerationSelectionHandle> | undefined;
let ownedPreparedUploads: WeakMap<PreparedUpstream, OwnedHttpUpload> | undefined;
let ownedProxyCount = 0;
export function matchesOwnedHttpConfigurationPreparation(cap: OwnedHttpRequest, preparation: PreparationAdmission): boolean {
  const invocation = ownedProxyInvocations?.get(cap);
  return !!invocation && invocation.preparingAdmission === preparation
    && (invocation.initialSelectionBody !== undefined || invocation.preparingIdentity !== undefined);
}
export function matchesOwnedHttpInitialSelection(cap: OwnedHttpRequest, body: Record<string, unknown>, preparation: PreparationAdmission): boolean {
  const invocation = ownedProxyInvocations?.get(cap);
  return !!invocation && invocation.initialSelectionBody === body && invocation.preparingAdmission === preparation
    && invocation.selection === undefined;
}
export function hasOwnedHttpProxyInvocation(cap: OwnedHttpRequest): boolean { return ownedProxyInvocations?.has(cap) === true; }
export function matchesOwnedHttpForegroundCommandRetirement(cap: OwnedHttpRequest): boolean {
  const owner = ownedProxyInvocations?.get(cap);
  return !!owner?.foregroundCommandsClosed && !!owner.prepared && !!owner.operation
    && !owner.preparingIdentity && !owner.preparingFields && !owner.preparingAdmission;
}
export function matchesOwnedHttpVeniceResponseInput(cap: OwnedHttpRequest, attempt: OwnedHttpUpload, response: Response, signal: AbortSignal): boolean {
  const owner = ownedProxyInvocations?.get(cap);
  return !!owner && owner.nativeResponse === response && owner.nativeSignal === signal && owner.upload === attempt
    && owner.prepared !== undefined && ownedPreparedUploads?.get(owner.prepared) === attempt;
}
export function matchesOwnedHttpProviderFetchInput(cap: OwnedHttpRequest, attempt: OwnedHttpUpload, url: URL, init: RequestInit): boolean {
  const owner = ownedProxyInvocations?.get(cap), prepared = owner?.prepared;
  return !!owner && !!prepared && owner.upload === attempt && ownedPreparedUploads?.get(prepared) === attempt
    && prepared.url === url && init.headers === prepared.headers && init.body === prepared.requestBody
    && init.signal === owner.operation?.signal && init.method === owner.selection?.method && init.redirect === "manual";
}
export function acceptOwnedHttpProviderResponse(cap: OwnedHttpRequest, attempt: OwnedHttpUpload, response: Response): void {
  const owner = ownedProxyInvocations?.get(cap);
  if (!owner || owner.upload !== attempt || owner.incomingResponse || !matchesOwnedHttpProviderHandoff(cap, attempt, response)) throw identityFailure("protocol");
  owner.incomingResponse = response;
}
export function matchesOwnedHttpAccountingInput(http: OwnedHttpRequest, request: Request, env: Env, auth: AuthorizedIdentity, selection: ProxySelection): boolean {
  const owner = ownedProxyInvocations?.get(http);
  return !!owner && matchesOwnedHttpRequestInputs(http, env, request) && owner.identity === auth && owner.selection === selection;
}
export function matchesOwnedHttpArchiveInput(http: OwnedHttpRequest, env: Env, auth: AuthorizedIdentity,
  selection: ProxySelection, requestId: string): boolean {
  const owner = ownedProxyInvocations?.get(http);
  return !!owner && !owner.archivePrepared && matchesOwnedHttpRequestInputs(http, env) && owner.identity === auth && owner.selection === selection
    && !!owner.accounting && owner.accounting.requestId === requestId && owner.prepared !== undefined;
}
export function claimOwnedHttpArchiveInput(http: OwnedHttpRequest, env: Env, auth: AuthorizedIdentity,
  selection: ProxySelection, requestId: string): boolean {
  if (!matchesOwnedHttpArchiveInput(http, env, auth, selection, requestId)) return false;
  ownedProxyInvocations!.get(http)!.archivePrepared = true; return true;
}
export function acceptOwnedHttpAccountingCost(http: OwnedHttpRequest, accounting: OwnedHttpAccountingCommand, cost: EstimatedCost): void {
  const owner = ownedProxyInvocations?.get(http);
  if (!owner || owner.accounting || !matchesOwnedHttpAccountingCommand(http, accounting)) throw identityFailure("protocol");
  // The fixed waiter and registration exist before any budget obligation.
  growOwnedHttpRequest(http, 4096);
  const registration = beginOwnedHttpSinkRegistration(ownedHttpSinkOwner(http));
  owner.accounting = accounting; owner.accountingCost = cost;
  owner.accountingRegistration = registration; owner.accountingHandoff = 1;
  owner.accountingReady = new Promise<void>(resolve => { owner.resolveAccounting = resolve; });
  try { ownedHttpCompletion(http).startPrivateLeaf(() => owner.accountingWork = runOwnedUsageAccounting(http)); }
  catch (reason) {
    if (!owner.accountingWork) {
      abandonUnstartedOwnedHttpRegistration(registration);
      owner.accountingRegistration = undefined; owner.resolveAccounting!();
      owner.accountingReady = undefined; owner.resolveAccounting = undefined; owner.accountingHandoff = undefined;
      owner.accounting = undefined; owner.accountingCost = undefined;
    }
    throw reason;
  }
}
export function matchesOwnedHttpSoftStatusPlan(cap: OwnedHttpRequest, env: Env, plan: ReturnType<typeof prepareSoftBudget>, operation?: HttpOperation): boolean {
  const owner = ownedProxyInvocations?.get(cap);
  return !!owner && matchesOwnedHttpRequestInputs(cap, env) && owner.softPlan === plan && !!owner.softAttempt
    && (operation === undefined || owner.operation === operation && owner.upload === owner.softAttempt);
}
export function matchesOwnedHttpPublicBody(cap: OwnedHttpRequest, body: ReadableStream<Uint8Array> | null): boolean {
  return !!body && ownedProxyInvocations?.get(cap)?.publicBody === body;
}
export function matchesOwnedHttpCodecConsumerInput(http: OwnedHttpRequest, codec: OwnedHttpRevalidation,
  attempt: OwnedHttpUpload, operation: HttpOperation, streaming: boolean, requestId: string,
  usageContext?: Readonly<import("./token-usage.ts").UsageTokenContext>): boolean {
  const owner = ownedProxyInvocations?.get(http), selection = owner?.selection;
  return !!owner && owner.operation === operation && owner.upload === attempt && owner.requestId === requestId && owner.usageContext === usageContext
    && owner.prepared?.ownedVenice === codec && ownedPreparedUploads?.get(owner.prepared) === attempt
    && !!selection && !Array.isArray(selection.body) && (selection.body.stream === true) === streaming
    && selection.endpoint.request_format === "openai.chat_completions" && selection.endpoint.response_format === "openai.chat_completions";
}
export function matchesOwnedHttpNormalizationInput(http: OwnedHttpRequest, attempt: OwnedHttpUpload, response: Response, operation: HttpOperation): boolean {
  const owner = ownedProxyInvocations?.get(http);
  return !!owner && owner.normalizingResponse === response && owner.operation === operation && owner.upload === attempt
    && !!owner.prepared && ownedPreparedUploads?.get(owner.prepared) === owner.upload;
}
export function matchesOwnedHttpCodecNormalizationInput(http: OwnedHttpRequest, codec: OwnedHttpRevalidation,
  attempt: OwnedHttpUpload, operation: HttpOperation, requestId: string): boolean {
  const owner = ownedProxyInvocations?.get(http);
  return !!owner && owner.operation === operation && owner.upload === attempt && owner.requestId === requestId
    && owner.prepared?.ownedVenice === codec && ownedPreparedUploads?.get(owner.prepared) === attempt;
}
export function matchesOwnedHttpPublicationContext(http: OwnedHttpRequest, attempt: OwnedHttpUpload, operation: HttpOperation): boolean {
  const owner = ownedProxyInvocations?.get(http), selection = owner?.selection;
  return !!owner && owner.upload === attempt && owner.operation === operation && !!owner.prepared
    && ownedPreparedUploads?.get(owner.prepared) === attempt && selection?.capability === "llm.chat"
    && selection.endpoint.request_format === "openai.chat_completions" && selection.endpoint.response_format === "openai.chat_completions";
}
export function matchesOwnedHttpGenericUsageInput(http: OwnedHttpRequest, attempt: OwnedHttpUpload, response: Response,
  operation: HttpOperation, format: string, tariff: import("./request-tariff.ts").RequestTariff | undefined,
  validated: import("./native-response.ts").ValidatedNativeUsage | undefined, usageContext: Readonly<import("./token-usage.ts").UsageTokenContext> | undefined,
  accounting: OwnedHttpAccountingCommand): boolean {
  const owner = ownedProxyInvocations?.get(http), selection = owner?.selection;
  return !!owner && !owner.consumer && !owner.genericUsage && owner.usageInput === response && owner.operation === operation
    && owner.upload === attempt && !!owner.prepared && ownedPreparedUploads?.get(owner.prepared) === attempt
    && selection?.capability === "llm.chat" && selection.endpoint.request_format === "openai.chat_completions"
    && selection.endpoint.response_format === "openai.chat_completions" && format === selection.endpoint.response_format
    && owner.accounting === accounting && matchesOwnedHttpAccountingCommand(http, accounting)
    && owner.accountingCost?.requestTariff === tariff && owner.nativeUsage === validated && owner.usageContext === usageContext;
}
export function acceptOwnedGenericUsage(http: OwnedHttpRequest, cap: OwnedHttpUsage, usage: ObservedUsage): void {
  const owner = ownedProxyInvocations?.get(http);
  if (!owner || owner.genericUsage !== cap || owner.observedUsage !== undefined) throw identityFailure("protocol");
  if (((owner.accountingHandoff ?? 0) & 7) >= 3) return;
  owner.observedUsage = usage;
  owner.accountingHandoff = owner.accountingHandoff! & ~7 | 3;
  wakeOwnedAccounting(owner);
}
export function matchesOwnedHttpCodecUsageInput(http: OwnedHttpRequest, codec: OwnedHttpRevalidation,
  attempt: OwnedHttpUpload, operation: HttpOperation, validated: import("./native-response.ts").ValidatedNativeUsage | undefined,
  usageContext: Readonly<import("./token-usage.ts").UsageTokenContext> | undefined): boolean {
  const owner = ownedProxyInvocations?.get(http);
  return !!owner && owner.operation === operation && owner.upload === attempt && owner.consumer === codec
    && owner.prepared?.ownedVenice === codec && ownedPreparedUploads?.get(owner.prepared) === attempt
    && owner.nativeUsage === validated && owner.usageContext === usageContext;
}
export function acceptOwnedHttpVeniceUsage(http: OwnedHttpRequest, codec: OwnedHttpRevalidation,
  response: Response, usage: import("./native-response.ts").ValidatedNativeUsage | undefined): void {
  const owner = ownedProxyInvocations?.get(http);
  if (!owner || owner.prepared?.ownedVenice !== codec || !matchesOwnedVeniceUsage(codec, response, usage)) throw identityFailure("protocol");
  owner.nativeUsage = usage;
}
export function acceptOwnedCodecUsage(http: OwnedHttpRequest, consumer: OwnedCodecConsumer, response: Response, usage: ObservedUsage): void {
  const owner = ownedProxyInvocations?.get(http);
  if (!owner || owner.consumer !== consumer || owner.observedUsage !== undefined || !matchesOwnedCodecUsage(consumer, response, usage))
    throw identityFailure("protocol");
  if (((owner.accountingHandoff ?? 0) & 7) >= 3) return;
  owner.observedUsage = usage;
  owner.accountingHandoff = owner.accountingHandoff! & ~7 | 3;
  wakeOwnedAccounting(owner);
}
// Low three bits: PREPARED, ARMED, READY, CLAIMED, TERMINAL_OWNED, SETTLED.
// Bits 8/16/32: publication settled / actual work registered / publication failed. Readiness is VOID.
function wakeOwnedAccounting(owner: OwnedProxyInvocation): void {
  if ((owner.accountingHandoff! & 15) === 11) owner.resolveAccounting!();
}
export function offerOwnedHttpAccountingOutcome(http: OwnedHttpRequest, accounting: OwnedHttpAccountingCommand,
  outcome: AccountingOutcome): Promise<boolean> {
  const owner = ownedProxyInvocations?.get(http), phase = (owner?.accountingHandoff ?? 0) & 7;
  if (!owner || owner.accounting !== accounting || !owner.accountingWork || phase < 1 || phase > 3
    || !matchesOwnedHttpAccountingCommand(http, accounting)) throw identityFailure("protocol");
  if (phase !== 3) {
    owner.accountingOutcome = outcome;
    owner.accountingHandoff = owner.accountingHandoff! & ~7 | 3;
    wakeOwnedAccounting(owner);
  }
  return owner.accountingWork;
}
export function matchesOwnedHttpBudgetPlan(http: OwnedHttpRequest, accounting: OwnedHttpAccountingCommand,
  plan: unknown, attempt: OwnedHttpUpload): boolean {
  const owner = ownedProxyInvocations?.get(http);
  return !!owner && owner.accounting === accounting && owner.accountingPlan === plan && owner.upload === attempt
    && !!owner.prepared && ownedPreparedUploads?.get(owner.prepared) === attempt && (owner.accountingHandoff! & 7) === 1;
}
export function matchesOwnedHttpPreparationAccountingRoute(http: OwnedHttpRequest): boolean {
  const owner = ownedProxyInvocations?.get(http);
  return !!owner && !owner.accounting && !owner.accountingHandoff;
}
export function matchesOwnedHttpAccountingClaim(http: OwnedHttpRequest, accounting: OwnedHttpAccountingCommand,
  outcome?: AccountingOutcome): boolean {
  const owner = ownedProxyInvocations?.get(http);
  return !!owner && owner.accounting === accounting && (owner.accountingHandoff! & 7) === 4
    && (outcome === undefined || owner.accountingOutcome === outcome);
}
export function matchesOwnedHttpAccountingUsage(http: OwnedHttpRequest, accounting: OwnedHttpAccountingCommand,
  status: number, usage: ObservedUsage, reservation: BudgetReservation, content: string | null): boolean {
  const owner = ownedProxyInvocations?.get(http);
  return !!owner && matchesOwnedHttpAccountingClaim(http, accounting) && owner.observedUsage === usage
    && (owner.accountingStatus ?? 502) === status && owner.terminalReservation === reservation && (owner.terminalContent ?? null) === content;
}
export function adoptedOwnedHttpAccountingOutcome(http: OwnedHttpRequest, accounting: OwnedHttpAccountingCommand): void {
  const owner = ownedProxyInvocations?.get(http);
  if (!owner || owner.accounting !== accounting || (owner.accountingHandoff! & 7) !== 4) throw identityFailure("protocol");
  owner.accountingHandoff = owner.accountingHandoff! & ~7 | 5;
}
export function failedOwnedHttpAccountingOutcome(http: OwnedHttpRequest, accounting: OwnedHttpAccountingCommand): void {
  const owner = ownedProxyInvocations?.get(http);
  if (!owner || owner.accounting !== accounting || (owner.accountingHandoff! & 7) !== 4) throw identityFailure("protocol");
  owner.accountingHandoff = owner.accountingHandoff! & ~7 | 7; // FAILED_PRE_ADOPTION, never consumed.
}
export function captureOwnedHttpAccountingStatus(http: OwnedHttpRequest, accounting: OwnedHttpAccountingCommand, status: number): void {
  const owner = ownedProxyInvocations?.get(http);
  if (!owner || owner.accounting !== accounting || !matchesOwnedHttpAccountingCommand(http, accounting)) throw identityFailure("protocol");
  if (typeof status === "number" && Number.isInteger(status) && status >= 200 && status <= 599) owner.accountingStatus = status;
}
export function ownedHttpAccountingStatus(http: OwnedHttpRequest, accounting: OwnedHttpAccountingCommand): number | undefined {
  const owner = ownedProxyInvocations?.get(http);
  if (!owner || owner.accounting !== accounting) throw identityFailure("protocol");
  return owner.accountingStatus;
}
export function ownsConsumedHttpAccountingHandoff(http: OwnedHttpRequest, producer: OwnedHttpUsage): boolean {
  const owner = ownedProxyInvocations?.get(http);
  return !!owner && owner.genericUsage === producer && (owner.accountingHandoff! & 7) === 5;
}
export function ownsFailedHttpAccountingHandoff(http: OwnedHttpRequest, producer: OwnedHttpUsage): boolean {
  const owner = ownedProxyInvocations?.get(http);
  return !!owner && owner.genericUsage === producer && (owner.accountingHandoff! & 7) === 7;
}
export function captureOwnedHttpUsageStatus(http: OwnedHttpRequest, producer: OwnedHttpUsage | OwnedCodecConsumer,
  response: Response, status: number): void {
  const owner = ownedProxyInvocations?.get(http);
  if (!owner || owner.consumer !== producer && owner.genericUsage !== producer || !owner.accounting
    || owner.usageInput !== response && owner.terminalResponse !== response) throw identityFailure("protocol");
  captureOwnedHttpAccountingStatus(http, owner.accounting, status);
}
export function registerOwnedHttpAccountingWork(http: OwnedHttpRequest, accounting: OwnedHttpAccountingCommand): void {
  const owner = ownedProxyInvocations?.get(http);
  if (!owner || owner.accounting !== accounting || !owner.accountingWork || !owner.accountingHandoff) throw identityFailure("protocol");
  if (owner.accountingHandoff & 16) return;
  const receipt = owner.accountingRegistration;
  if (!receipt) throw identityFailure("protocol");
  // A throw after waitUntil starts never creates a replacement work item.
  owner.accountingHandoff |= 16; owner.accountingRegistration = undefined;
  completeOwnedHttpSinkRegistration(receipt, owner.context, owner.accountingWork);
}
async function runOwnedUsageAccounting(http: OwnedHttpRequest): Promise<boolean> {
  const owner = ownedProxyInvocations!.get(http)!;
  await owner.accountingReady;
  if (!owner.accounting || (owner.accountingHandoff! & 15) !== 11) throw identityFailure("protocol");
  owner.accountingHandoff = owner.accountingHandoff! & ~7 | 4;
  let original: Promise<boolean>;
  try {
    original = owner.accountingOutcome ? owner.accounting.consume(owner.accountingOutcome)
      : owner.accounting.completeCaptured(owner.accountingStatus ?? 502, owner.observedUsage!, owner.terminalReservation!,
        owner.terminalContent ?? null, owner.operation?.status);
  } catch (reason) {
    original = owner.accounting.failClaim(reason); reason = undefined;
  }
  const adopted = (owner.accountingHandoff! & 7) === 5;
  if (!adopted && (owner.accountingHandoff! & 7) !== 7) throw identityFailure("protocol");
  if (adopted) {
    delete owner.accountingOutcome; delete owner.observedUsage;
    if (owner.genericUsage) { consumeOwnedHttpGenericUsage(owner.genericUsage); delete owner.genericUsage; }
    delete owner.terminalResponse; delete owner.terminalReservation; delete owner.terminalContent;
  } else if (owner.genericUsage) failOwnedHttpGenericUsage(owner.genericUsage);
  try { return await original; }
  finally {
    if (adopted) owner.accountingHandoff = owner.accountingHandoff! & ~7 | 6;
    owner.accounting.close(); owner.accountingReady = undefined; owner.resolveAccounting = undefined;
  }
}
function settleOwnedAccountingPublication(http: OwnedHttpRequest, published: boolean): void {
  const owner = ownedProxyInvocations!.get(http)!, accounting = owner.accounting;
  if (!accounting || !owner.accountingHandoff) return;
  const phase = owner.accountingHandoff & 7;
  if (phase < 3 && !published) accounting.publicationFailure(owner.terminalReservation, owner.terminalContent ?? null,
    !!owner.accountingDispatched, owner.operation?.status, owner.nativeUsage, owner.operation?.receivedRejection === true);
  owner.accountingHandoff! |= 8 | (published ? 0 : 32);
  wakeOwnedAccounting(owner);
  registerOwnedHttpAccountingWork(http, accounting);
}
export function closeOwnedHttpAccountingHandoff(http: OwnedHttpRequest, accounting: OwnedHttpAccountingCommand): boolean {
  const owner = ownedProxyInvocations?.get(http);
  if (!owner || owner.accounting !== accounting || !owner.accountingHandoff) return true;
  if ((owner.accountingHandoff & 7) === 6 || (owner.accountingHandoff & 7) === 7) return true;
  if (!(owner.accountingHandoff & 8)) settleOwnedAccountingPublication(http, false);
  return false;
}
function startOwnedUsageAccounting(http: OwnedHttpRequest, context: ExecutionContext, _completion: ProxyCompletion,
  consumer: OwnedCodecConsumer | OwnedHttpUsage, accounting: OwnedHttpAccountingCommand, response: Response,
  reservation: BudgetReservation, content: string | null): void {
  const owner = ownedProxyInvocations?.get(http);
  if (!owner || owner.context !== context || owner.consumer !== consumer && owner.genericUsage !== consumer || owner.accounting !== accounting)
    throw identityFailure("protocol");
  owner.terminalResponse = response; owner.terminalReservation = reservation; owner.terminalContent = content;
  registerOwnedHttpAccountingWork(http, accounting);
}

export function hasBoundOwnedHttpAuthentication(cap: OwnedHttpRequest): boolean {
  return ownedProxyInvocations?.get(cap)?.identity !== undefined;
}
export function matchesOwnedHttpRevalidationInput(cap: OwnedHttpRequest, request: Request, env: Env,
  auth: AuthorizedIdentity, selection: ProxySelection, upstream: UpstreamAuth, attempt: OwnedHttpUpload,
  url: URL, headers: Headers, preparation: PreparationAdmission): boolean {
  const invocation = ownedProxyInvocations?.get(cap);
  return !!invocation && matchesOwnedHttpRequestInputs(cap, env, request) && invocation.selection === selection
    && invocation.preparingIdentity === auth && invocation.preparingUpstream === upstream && invocation.retry?.pending?.upload === attempt
    && invocation.preparingFields?.url === url && invocation.preparingFields.headers === headers
    && invocation.preparingAdmission === preparation;
}
export function matchesOwnedHttpPricingInput(cap: OwnedHttpRequest, body: Record<string, unknown>): boolean {
  const selection = ownedProxyInvocations?.get(cap)?.selection;
  return !!selection && selection.body === body && selection.capability === "llm.chat"
    && selection.endpoint.request_format === "openai.chat_completions"
    && selection.endpoint.response_format === "openai.chat_completions";
}
export function ownedHttpMayDefaultServiceTier(cap: OwnedHttpRequest, body: Record<string, unknown>): boolean {
  if (!matchesOwnedHttpPricingInput(cap, body)) throw identityFailure("protocol");
  return ownedProxyInvocations!.get(cap)!.selection!.provider.id === "openai";
}
export function ownedHttpHasToolPriceCard(cap: OwnedHttpRequest, body: Record<string, unknown>): boolean {
  if (!matchesOwnedHttpPricingInput(cap, body)) throw identityFailure("protocol");
  return !!ownedProxyInvocations!.get(cap)!.selection!.endpoint.toolPricing;
}
export function reserveOwnedHttpInitialPreparation(cap: OwnedHttpRequest, request: Request, env: Env): void {
  const invocation = ownedProxyInvocations?.get(cap);
  if (!invocation?.selection) throw identityFailure("protocol");
  if (invocation.preparationAdmitted) return;
  // Four fixed ports exist before initial selection/count effects. They share
  // the request's existing physical custody; no per-port completion Promise.
  growOwnedHttpRequest(cap, 8 * (1 + 8 + 2 + 1 + 1 + 4 + 4 * (1 + 16 + 8) + 64)
    + 2 * ("portsexcludednextpending".length + 4 * "phaseinputsignalpermitprepareduploadidentitycredential".length));
  invocation.retry = { ports: [
    { phase: 0, input: undefined, signal: undefined, permit: undefined, prepared: undefined, upload: undefined, identity: undefined, credential: undefined },
    { phase: 0, input: undefined, signal: undefined, permit: undefined, prepared: undefined, upload: undefined, identity: undefined, credential: undefined },
    { phase: 0, input: undefined, signal: undefined, permit: undefined, prepared: undefined, upload: undefined, identity: undefined, credential: undefined },
    { phase: 0, input: undefined, signal: undefined, permit: undefined, prepared: undefined, upload: undefined, identity: undefined, credential: undefined },
  ], excluded: new Set(), next: 0, pending: undefined };
  prepareOwnedHttpPricing(cap, invocation.selection.body as Record<string, unknown>);
  reserveOwnedHttpProviderPreparation(cap, request, env, invocation.selection);
  prepareOwnedHttpAccounting(cap);
  invocation.preparationAdmitted = true;
}
export function acceptOwnedHttpAuthentication(cap: OwnedHttpRequest, identity: AuthorizedIdentity): void {
  const invocation = ownedProxyInvocations?.get(cap);
  if (!invocation || !matchesOwnedHttpAuthentication(cap, identity)) throw identityFailure("protocol");
  invocation.identity = identity;
}

// Fixed synchronous receiver only. There is no public preparation getter and
// no callback supplied by the caller; the actual attempt installs this slot.
export function acceptOwnedHttpPreparation(upload: OwnedHttpUpload, fields: OwnedPreparedFields): void {
  const receiver = ownedPreparationReceivers?.get(upload);
  if (!receiver || receiver.fields) throw identityFailure("protocol");
  receiver.fields = fields;
}

export function checkOwnedHttpProviderInput(cap: OwnedHttpRequest, request: Request, env: Env, selection: ProxySelection): void {
  checkOwnedHttpRequest(cap, request, env);
  const invocation = ownedProxyInvocations?.get(cap);
  if (!invocation || !matchesOwnedHttpRequestInputs(cap, env, request) || invocation.selection !== selection) throw identityFailure("protocol");
}
export async function acceptOwnedHttpConfiguredProvider(cap: OwnedHttpRequest, request: Request, env: Env,
  selection: ProxySelection, query: ProxyQuery, identity: AuthorizedIdentity, connection: ProviderConnection,
  upstream: UpstreamAuth, preparation: PreparationAdmission, permit: object, selected: GenerationSelectionHandle): Promise<void> {
  checkOwnedHttpProviderInput(cap, request, env, selection);
  if (!ownsOwnedHttpSelectionPermit(permit, cap)) throw identityFailure("protocol");
  const invocation = ownedProxyInvocations!.get(cap)!, port = invocation.retry?.pending;
  if (!port || port.phase !== 1 || port.permit !== permit || !port.signal) throw identityFailure("protocol");
  let original: Promise<PreparedUpstream> | undefined, prepared: PreparedUpstream | undefined;
  invocation.preparingIdentity = identity; invocation.preparingUpstream = upstream;
  invocation.preparingAdmission = preparation;
  try {
    original = prepareSingleSelected(request, env, selection, query, identity, new Set(), false, connection,
      undefined, "http", false, undefined, undefined, undefined, preparation, { cap, upstream }, port.signal);
    void original.then(() => undefined, () => undefined);
    prepared = await original;
    original = undefined; finishOwnedHttpRevalidationPreparation(cap);
    ownedHttpSignal(cap).throwIfAborted(); port.signal.throwIfAborted();
    (ownedPreparedSelections ??= new WeakMap()).set(prepared, selected);
    if (port.upload) (ownedPreparedUploads ??= new WeakMap()).set(prepared, port.upload);
    port.prepared = prepared; port.identity = identity;
  } finally {
    invocation.preparingIdentity = undefined; invocation.preparingUpstream = undefined; invocation.preparingFields = undefined;
    invocation.preparingAdmission = undefined;
    original = undefined; prepared = undefined; upstream = undefined as never; identity = undefined as never;
  }
}

// Closed producer gate: only the current genuine Unified Chat preparation and
// its ingress-derived body revision may enter the synchronous marker phase.
export function prepareOwnedHttpUploadJson(upload: OwnedHttpUpload, body: unknown): string | MediaJsonBody | undefined {
  checkOwnedHttpUpload(upload);
  const receiver = ownedPreparationReceivers?.get(upload), invocation = receiver && ownedProxyInvocations?.get(receiver.owner);
  const selection = invocation?.selection;
  if (!receiver || !invocation || invocation.retry?.pending?.upload !== upload || !selection || selection.body !== body
    || !invocation.preparingAdmission || !invocation.preparingUpstream || !matchesOwnedHttpPricingInput(receiver.owner, body as Record<string, unknown>))
    throw identityFailure("protocol");
  const admission = takeOwnedHttpMediaAdmission(receiver.owner, body as Record<string, unknown>);
  const signed = selection.provider.auth.schemes.some(scheme => scheme.type === "sig_v4");
  const bodyless = ["GET", "HEAD"].includes(selection.method);
  if (bodyless) return undefined;
  if (signed) return privateUploadJson(body);
  try { return privateMediaJsonBody(body, admission) ?? privateUploadJson(body); }
  finally { if (admission.restorePending) holdOwnedHttpUploadSerialization(upload); }
}

function prepareOwnedHttpTransport(cap: OwnedHttpRequest, request: Request, env: Env,
  selection: ProxySelection, query: ProxyQuery, upstream: UpstreamAuth, preparation: PreparationAdmission): OwnedPreparedFields {
  checkOwnedHttpRequest(cap, request, env);
  const invocation = ownedProxyInvocations?.get(cap);
  if (!invocation || invocation.selection !== selection) throw identityFailure("protocol");
  const upload = beginOwnedHttpUpload(cap);
  if (!invocation.retry?.pending || invocation.retry.pending.phase !== 1) throw identityFailure("protocol");
  invocation.retry.pending.upload = upload; invocation.attempts.push(upload);
  const receiver: OwnedPreparationReceiver = { owner: cap };
  (ownedPreparationReceivers ??= new WeakMap()).set(upload, receiver);
  try {
    prepareOwnedUpstreamRequest(upload, request, env, selection, query, upstream, preparation);
    if (!receiver.fields) throw identityFailure("protocol");
    invocation.preparingFields = receiver.fields;
    return receiver.fields;
  } catch (error) { void abandonOwnedHttpUpload(upload); throw error; }
  finally { receiver.fields = undefined; ownedPreparationReceivers!.delete(upload); }
}

export function retireOwnedHttpProxy(cap: OwnedHttpRequest): void {
  const invocation = ownedProxyInvocations?.get(cap);
  if (!invocation) return;
  // Validate the intake handoff before deleting this owner's last lookup.
  // Its body lease is released only after all prepared/body callback aliases.
  invocation.admission?.checkOwnedRetirement();
  retireOwnedHttpPricing(cap);
  retireOwnedHttpProviderPreparation(cap);
  retireOwnedHttpControlVerification(cap);
  const admission = invocation.admission;
  invocation.prepared = undefined; invocation.archivePrepared = undefined; invocation.identity = undefined; invocation.selection = undefined;
  invocation.nativeResponse = undefined; invocation.incomingResponse = undefined; invocation.nativeSignal = undefined; invocation.nativeUsage = undefined;
  invocation.publicBody = undefined;
  invocation.operation = undefined;
  invocation.softPlan = undefined; invocation.softAttempt = undefined; invocation.accounting = undefined; invocation.accountingCost = undefined; invocation.accountingPlan = undefined;
  invocation.terminalResponse = undefined; invocation.terminalReservation = undefined; invocation.terminalContent = undefined;
  invocation.genericUsage = undefined; invocation.observedUsage = undefined;
  invocation.accountingReady = undefined; invocation.resolveAccounting = undefined; invocation.accountingWork = undefined;
  invocation.accountingRegistration = undefined; invocation.accountingOutcome = undefined;
  invocation.consumer = undefined; invocation.genericUsage = undefined; invocation.usageInput = undefined; invocation.observedUsage = undefined;
  invocation.usageContext = undefined; invocation.requestId = undefined;
  invocation.admission = undefined; invocation.upload = undefined; invocation.attempts.length = 0;
  if (invocation.retry) {
    for (const port of invocation.retry.ports) { port.input = undefined; port.signal = undefined; port.permit = undefined; port.prepared = undefined; port.upload = undefined; port.identity = undefined; port.credential = undefined; port.phase = 5; }
    invocation.retry.ports.length = 0; invocation.retry.excluded.clear(); invocation.retry.pending = undefined; invocation.retry = undefined;
  }
  invocation.required = undefined; invocation.context = undefined as never;
  admission?.retireOwned();
  ownedProxyInvocations!.delete(cap);
  if (!--ownedProxyCount) { ownedProxyInvocations = undefined; ownedPreparationReceivers = undefined; ownedPreparedSelections = undefined; ownedPreparedUploads = undefined; }
}

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
  private ownedInputBytes = 0;
  private ownedBodyCharge = 0;
  private ownedDataCharge?: ExactBodyCharge;
  private readonly request: Request;
  private readonly env: Env;
  private readonly mode: AuthMode;
  private readonly providerId: string | undefined;
  private readonly owned?: OwnedHttpRequest;
  constructor(request: Request, env: Env, mode: AuthMode, providerId?: string, owned?: OwnedHttpRequest) {
    this.request = request; this.env = env; this.mode = mode; this.providerId = providerId; this.owned = owned;
  }
  checkOwnedRetirement(): void {
    if (!this.owned || this.input || this.wan || this.search || this.intakeOperation) throw identityFailure("protocol");
  }
  retireOwned(): void {
    this.checkOwnedRetirement();
    const failures: unknown[] = [];
    try { this.ownedDataCharge?.release(); this.ownedDataCharge = undefined; } catch (error) { failures.push(error); }
    try { this.lease.release(); this.ownedBodyCharge = 0; } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "owned HTTP body funding retirement");
  }
  noteOwnedInputBytes(bytes: number): void {
    if (!this.owned || !Number.isSafeInteger(bytes) || bytes < this.ownedInputBytes) throw identityFailure("protocol");
    this.ownedInputBytes = bytes;
  }
  get ownedWireBytes(): number { return this.ownedInputBytes; }
  admitOwnedData(bytes: number, cleared = false): void {
    if (!this.owned || !Number.isSafeInteger(bytes) || bytes < 0) throw identityFailure("protocol");
    // One body component: existing positive BodyLease credit is counted ONCE.
    // Supplement with exact COMMON credit; never convert source counters into
    // funding. Only an explicit alias-clear boundary may shrink this supplement.
    const extra = Math.max(0, bytes - this.ownedBodyCharge), held = this.ownedDataCharge?.bytes ?? 0;
    if (extra === held || extra < held && !cleared) return;
    if (!extra) { this.ownedDataCharge?.release(); this.ownedDataCharge = undefined; return; }
    const next = this.ownedDataCharge ? this.ownedDataCharge.replace(extra) : ExactBodyCharge.reserve(extra);
    if (!next) throw identityFailure("limit");
    this.ownedDataCharge = next;
  }
  reserve = async (bytes: number): Promise<void> => {
    if (bytes >= bodyLeaseMinimum) await this.authenticate();
    if (this.lease.grow(bytes)) {
      if (this.owned && bytes >= bodyLeaseMinimum) this.ownedBodyCharge = Math.max(this.ownedBodyCharge, 2 * bytes);
      return;
    }
    if (this.owned) throw ownedErrorResponse(this.owned, "server_overloaded", "Large request capacity is busy; retry shortly.", 503, "1");
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
      const auth = this.owned ? await authenticateOwnedHttp(this.owned, this.request, this.env)
        : await preauthenticate(this.request, this.env, this.mode, this.providerId);
      if (auth instanceof Response) throw auth;
      this.authenticated = true;
    }
    if (this.request.signal.aborted) throw new HttpError(499, "request_canceled", "request was canceled");
  }
  ordinaryCompletion(): boolean { return !this.search && !this.wan && !this.input && !this.intakeOperation; }
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
  ownedVenice?: OwnedHttpRevalidation;
  headers: Headers;
  url: URL;
  requestBody: string | ReadableStream<Uint8Array> | undefined;
  grantKey: string | null;
  grantLane: import("./types").GrantLane;
  grantRevision: string | null;
  connection: ProviderConnection;
  websocket: boolean;
  backgroundRecovery: boolean;
  failedGrantKeys?: string[];
  continuation?: ContinuationOwner;
  managedBaseUrl?: string;
  revalidateAccount?: (signal: AbortSignal) => Promise<void>;
  revalidateMedia?: (currentEnv: Env, signal: AbortSignal) => Promise<void>;
  acquireDiscovery?: () => BodyLease;
  revalidateDiscovery?: (signal: AbortSignal) => Promise<import("./types").AccessPolicy>;
  publicCatalog?: Awaited<ReturnType<typeof preparePublicDiscoveryOwner>>;
  revalidateDelivery?: (signal: AbortSignal) => Promise<void>;
  featherlessCatalog?: Awaited<ReturnType<typeof prepareFeatherlessCatalogOwner>>;
}

interface ReservedProxyBudget {
  failedGrantKeys?: string[];
  grant: PinnedGrant;
  auth: AuthorizedIdentity;
  reservation: BudgetReservation;
  cost: EstimatedCost;
  providerId: string;
  modelId: string | null;
  capability: string;
  connection: ProviderConnection;
  fusion?: ReturnType<typeof prepareFusionAccounting>;
  claim(): void;
  finishUnclaimed(): Promise<void>;
}

// Prospective DATA only. Native JSON.parse remains the grammar/last-wins owner.
// For valid JSON, commas + nonempty containers = members + array entries.
// Count every source occurrence (including overwritten members), without a
// visitor stack, key array, substring, decoded-string copy or graph factory.
function ownedHttpJsonDataBytes(text: string): number {
  let containers = 0, members = 0, commas = 0, nonempty = 0, primitives = 0, units = 0;
  let string = false, scalar = false, previous = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (string) {
      if (code === 34) string = false;
      else { units++; if (code === 92) { index++; if (text.charCodeAt(index) === 117) index += 4; } }
      continue;
    }
    if (code === 32 || code === 9 || code === 10 || code === 13) { scalar = false; continue; }
    if (previous === 123 && code !== 125 || previous === 91 && code !== 93) nonempty++;
    if (code === 34) { primitives++; string = true; scalar = false; }
    else if (code === 123 || code === 91) { containers++; scalar = false; }
    else if (code === 58) { members++; scalar = false; }
    else if (code === 44) { commas++; scalar = false; }
    else if (code === 125 || code === 93) scalar = false;
    else if (!scalar) { primitives++; scalar = true; }
    previous = code;
  }
  const entries = Math.max(0, commas + nonempty - members);
  // Quoted keys contribute their member cells, not a primitive value cell.
  // Every quoted value (including an empty or root string) contributes one.
  return 8 * (containers + 2 * members + entries + Math.max(0, primitives - members)) + 2 * units;
}

// Same public JSON grammar/thresholds as readJson, with explicit ORIGINAL
// request read/FIRSTcancel/unlock ownership instead of fire-and-forget cleanup.
const ownedIntakeJsonParse = JSON.parse;
const ownedIntakeArray = Array.isArray;
const ownedIntakeNativeCancel = ReadableStreamBYOBReader.prototype.cancel;
const ownedIntakeThen = Promise.prototype.then;
const ownedIntakeNativeRead = ReadableStreamBYOBReader.prototype.read;
const ownedIntakeNativeClosed = Object.getOwnPropertyDescriptor(ReadableStreamBYOBReader.prototype, "closed")?.get;
const ownedIntakeLookupGetter = (Object.prototype as { __lookupGetter__?: unknown }).__lookupGetter__;
const ownedIntakeQueue = queueMicrotask;
function ownedIntakeViewLength(view: unknown): number {
  const proof = inspectOwnedBytes(view);
  return proof.backing > 16384 ? -1 : proof.length;
}
interface OwnedIntakeObservation {
  owner: OwnedHttpIntakeIo | undefined;
  kind: number;
  flags: number; // accepted, installed, UNKNOWN, inert, queued, installing, native
  ready: Promise<void> | undefined;
  resolve: (() => void) | undefined;
}
function intakeObservationFulfilled(this: OwnedIntakeObservation, value: unknown): void {
  if (this.flags & (1 | 8)) { value = undefined; return; }
  try { this.owner?.receive(this, false, value); } finally { value = undefined; }
}
function intakeObservationRejected(this: OwnedIntakeObservation, reason: unknown): void {
  if (this.flags & (1 | 8)) { reason = undefined; return; }
  try { this.owner?.receive(this, true, reason); } finally { reason = undefined; }
}
function advanceIntakeObservation(this: OwnedIntakeObservation): void {
  this.flags &= ~16;
  if (this.flags & (4 | 8 | 32) || (this.flags & 3) !== 3) return;
  this.resolve?.(); this.resolve = undefined;
}
interface OwnedIntakeAbort { owner: OwnedHttpIntakeIo | undefined }
function abortOwnedIntake(this: OwnedIntakeAbort): void { this.owner?.cancel(); }

// This owner never receives the parser, admission object, request or parsed
// graph. External native observers bind only their own severable cell.
class OwnedHttpIntakeIo {
  reader?: ReadableStreamBYOBReader;
  captureWire: Uint8Array | undefined = newOwnedBytes(16384);
  captureLength = 0;
  captureDone = false;
  captureOversized = false;
  readFailure?: object;
  cancelFailure?: object;
  unlockFailure?: object;
  reading?: OwnedIntakeObservation;
  cancelling?: OwnedIntakeObservation;
  unlocking?: OwnedIntakeObservation;
  closed?: OwnedIntakeObservation;
  private flags = 0; // eof, UNKNOWN, retired, native closed, native errored
  private nativeFailure?: object;
  private stopped: object | undefined = Object.freeze({ kind: "owned-http-intake-stopped" });
  private abortCell: OwnedIntakeAbort | undefined = { owner: this };
  readonly abort = abortOwnedIntake.bind(this.abortCell!);
  declare private cap: OwnedHttpRequest;
  declare private diagnostics: ReturnType<typeof beginOwnedHttpIntakeDiagnostics>;
  declare private body: ReadableStream<Uint8Array> | undefined;
  constructor(cap: OwnedHttpRequest, diagnostics: ReturnType<typeof beginOwnedHttpIntakeDiagnostics>,
    body: ReadableStream<Uint8Array> | undefined) {
    this.cap = cap; this.diagnostics = diagnostics; this.body = body;
  }
  private unknown(): void {
    this.flags |= 2;
    try { holdOwnedHttpRequest(this.cap); } catch { /* A lost parent remains UNKNOWN here. */ }
  }
  hold(): void { this.unknown(); }
  private failure(kind: number, reason: unknown, observing = false): object {
    return ownedHttpIntakeFailure(this.diagnostics, kind === 1 ? observing ? "readObserver" : "read"
      : kind === 2 ? observing ? "cancelObserver" : "cancel"
      : kind === 4 ? observing ? "unlockObserver" : "unlock" : observing ? "closedObserver" : "closed", reason);
  }
  private make(kind: number): OwnedIntakeObservation {
    const cell: OwnedIntakeObservation = { owner: this, kind, flags: 32, ready: undefined, resolve: undefined };
    cell.ready = new Promise<void>(resolve => { cell.resolve = resolve; });
    if (kind === 1) this.reading = cell; else if (kind === 2) this.cancelling = cell;
    else if (kind === 4) this.unlocking = cell; else this.closed = cell;
    return cell;
  }
  private schedule(cell: OwnedIntakeObservation): void {
    if (cell.flags & (8 | 16)) return;
    cell.flags |= 16;
    try { ownedIntakeQueue(advanceIntakeObservation.bind(cell)); }
    catch (reason) {
      cell.flags |= 4; this.unknown();
      try { this.failure(cell.kind, reason, true); } catch { /* UNKNOWN keeps the cell and parent. */ }
      finally { reason = undefined; }
    }
  }
  private observe(cell: OwnedIntakeObservation, original: Promise<unknown>): void {
    let then: unknown;
    if (cell.kind === 4) {
      if (original !== null && (typeof original === "object" || typeof original === "function")) then = original.then;
      if (typeof then !== "function") { original = Promise.resolve(); then = ownedIntakeThen; }
    } else then = original.then;
    if (then !== ownedIntakeThen) { cell.flags &= ~64; if (cell.kind === 8) this.flags &= ~8; }
    void Reflect.apply(then as Function, original, [intakeObservationFulfilled.bind(cell), intakeObservationRejected.bind(cell)]);
    cell.flags |= 2;
  }
  private observationFailure(cell: OwnedIntakeObservation, reason: unknown): object {
    cell.flags |= 4; this.unknown();
    const failure = this.failure(cell.kind, reason, true);
    if (cell.kind === 1) this.readFailure = failure;
    else if (cell.kind === 2) this.cancelFailure = failure;
    else if (cell.kind === 4) this.unlockFailure = failure;
    return failure;
  }
  private capture(item: ReadableStreamReadResult<Uint8Array>): void {
    let operand: unknown, length: unknown, destination: Uint8Array | undefined;
    let method: typeof copyOwnedBytes | undefined;
    try {
      this.captureDone = !!item.done;
      if (this.captureDone) return;
      operand = item.value;
      this.captureOversized = (operand as Uint8Array).buffer.byteLength > 16384;
      if (!this.captureOversized) this.captureOversized = ownedIntakeViewLength(operand) < 0;
      operand = undefined;
      if (this.captureOversized) return;
      operand = item.value;
      length = (operand as Uint8Array).byteLength;
      if (typeof length !== "number" || length < 0 || length > 16384 || length % 1 !== 0) throw identityFailure("protocol");
      this.captureOversized = ownedIntakeViewLength(operand) < 0;
      operand = undefined;
      if (this.captureOversized) return;
      this.captureLength = length; length = undefined;
      destination = this.captureWire!;
      // The held private DATA command is selected before the third VALUE get.
      // Mutable set/subarray/species hooks never receive the private snapshot.
      method = copyOwnedBytes;
      operand = item.value;
      const actualLength = ownedIntakeViewLength(operand);
      if (actualLength < 0) { this.captureOversized = true; return; }
      if (actualLength !== this.captureLength) throw identityFailure("protocol");
      method(destination, operand as Uint8Array);
    } finally { item = undefined as never; operand = undefined; length = undefined; destination = undefined; method = undefined; }
  }
  receive(cell: OwnedIntakeObservation, rejected: boolean, value: unknown): void {
    if (cell.owner !== this || cell.flags & (1 | 8) || this.flags & 4
      || cell !== (cell.kind === 1 ? this.reading : cell.kind === 2 ? this.cancelling : cell.kind === 4 ? this.unlocking : this.closed)) { value = undefined; return; }
    cell.flags |= 1;
    try {
      if (!rejected && cell.kind === 1) {
        // Intake's existing order is deliberately different: DONE first,
        // truthy EOF ignores VALUE, otherwise the three conditional VALUE gets.
        this.capture(value as ReadableStreamReadResult<Uint8Array>);
      } else if (rejected) {
        if (cell.kind === 1) {
          this.readFailure = cell.flags & 64 && this.nativeFailure ? this.nativeFailure : this.failure(1, value);
          if (cell.flags & 64) this.nativeFailure = this.readFailure;
        } else if (cell.kind === 8) {
          this.flags |= 16;
          if (!(this.flags & 8 && this.nativeFailure)) {
            const failure = this.failure(8, value); if (this.flags & 8) this.nativeFailure = failure;
          }
        } else if (cell.kind === 2) { if (!(cell.flags & 64)) this.cancelFailure = this.failure(2, value); }
        else this.unlockFailure = this.failure(4, value);
      }
    } catch (reason) {
      try { if (cell.kind === 1) this.readFailure = this.failure(1, reason); else { cell.flags |= 4; this.unknown(); } }
      catch { cell.flags |= 4; this.unknown(); }
      finally { reason = undefined; }
    } finally { value = undefined; this.schedule(cell); }
  }
  open(): void {
    try { this.reader = this.body!.getReader({ mode: "byob" }); }
    catch (reason) { throw ownedHttpIntakeFailure(this.diagnostics, "acquire", reason); }
    const cell = this.make(8);
    let original: Promise<void> | undefined, started = false;
    try {
      if (Object.getPrototypeOf(this.reader) === ReadableStreamBYOBReader.prototype && !Object.hasOwn(this.reader, "closed")
        && typeof ownedIntakeLookupGetter === "function" && ownedIntakeLookupGetter.call(this.reader, "closed") === ownedIntakeNativeClosed) this.flags |= 8;
      original = this.reader.closed; started = !!original;
      if (this.flags & 8) cell.flags |= 64;
      this.observe(cell, original);
    } catch (reason) {
      if (started) throw this.observationFailure(cell, reason);
      const failure = this.failure(8, reason); cell.flags |= 1 | 2; reason = undefined; throw failure;
    } finally { original = undefined; cell.flags &= ~32; this.schedule(cell); }
  }
  read(): Promise<void> {
    if (this.reading || this.flags & (1 | 2 | 4) || !this.reader) throw identityFailure("protocol");
    this.captureLength = 0; this.captureDone = false; this.captureOversized = false; this.readFailure = undefined;
    const cell = this.make(1);
    let original: Promise<ReadableStreamReadResult<Uint8Array>> | undefined, started = false;
    try {
      const reader = this.reader, method = reader.read;
      if (this.flags & 8 && Object.getPrototypeOf(reader) === ReadableStreamBYOBReader.prototype && !Object.hasOwn(reader, "closed")
        && method === ownedIntakeNativeRead) cell.flags |= 64;
      original = Reflect.apply(method, reader, [newOwnedBytes(16384)]); started = !!original;
      this.observe(cell, original!);
    } catch (reason) {
      if (started) throw this.observationFailure(cell, reason);
      this.receive(cell, true, reason); cell.flags |= 2;
    } finally { original = undefined; cell.flags &= ~32; this.schedule(cell); }
    return cell.ready!;
  }
  cancel(): void {
    if (this.cancelling || this.flags & (1 | 4)) return;
    const cell = this.make(2);
    let original: Promise<void> | undefined, started = false;
    try {
      const reader = this.reader, receiver = reader ?? this.body!, method = receiver.cancel;
      if (reader && this.nativeFailure && this.flags & 8 && this.flags & 16 && Object.getPrototypeOf(reader) === ReadableStreamBYOBReader.prototype
        && !Object.hasOwn(reader, "closed") && method === ownedIntakeNativeCancel) cell.flags |= 64;
      original = Reflect.apply(method, receiver, [this.stopped]); started = !!original;
      this.observe(cell, original!);
    } catch (reason) {
      try { if (started) this.observationFailure(cell, reason); else { this.receive(cell, true, reason); cell.flags |= 2; } }
      catch { cell.flags |= 4; this.unknown(); }
      finally { reason = undefined; }
    } finally { original = undefined; cell.flags &= ~32; this.schedule(cell); }
  }
  unlock(): void {
    if (this.unlocking || this.flags & 4) return;
    const cell = this.make(4);
    let original: unknown, started = false;
    try {
      if (!this.reader) { cell.flags |= 1 | 2; return; }
      const reader = this.reader, method = reader.releaseLock;
      original = Reflect.apply(method, reader, []); started = original !== undefined;
      if (!started) { cell.flags |= 1 | 2; return; }
      this.observe(cell, original as Promise<unknown>);
    } catch (reason) {
      try { if (started) this.observationFailure(cell, reason); else { this.receive(cell, true, reason); cell.flags |= 2; } }
      catch { cell.flags |= 4; this.unknown(); }
      finally { reason = undefined; }
    } finally { original = undefined; cell.flags &= ~32; this.schedule(cell); }
  }
  private discharge(kind: number): void {
    let cell = kind === 1 ? this.reading : kind === 2 ? this.cancelling : kind === 4 ? this.unlocking : this.closed;
    if (!cell || this.flags & 2 || cell.flags & (4 | 16 | 32) || (cell.flags & 3) !== 3 || cell.resolve) { cell = undefined; return; }
    cell.flags = 8; cell.owner = undefined; cell.ready = undefined; cell.resolve = undefined; cell.kind = 0;
    if (kind === 1) this.reading = undefined; else if (kind === 2) this.cancelling = undefined;
    else if (kind === 4) this.unlocking = undefined; else this.closed = undefined;
    cell = undefined;
  }
  consumedRead(): void { this.discharge(1); }
  end(): void { this.flags |= 1; }
  clear(): boolean {
    if (this.flags & 2) return false;
    this.discharge(1); this.discharge(2); this.discharge(4); this.discharge(8);
    if (this.reading || this.cancelling || this.unlocking || this.closed) { this.unknown(); return false; }
    this.flags |= 4; this.abortCell!.owner = undefined; this.abortCell = undefined;
    this.reader = undefined; this.body = undefined; this.captureWire = undefined; this.nativeFailure = undefined;
    this.cap = undefined as never; this.diagnostics = undefined as never; this.stopped = undefined;
    return true;
  }
}
async function readOwnedHttpJson(cap: OwnedHttpRequest, request: Request, admission: JsonAdmission): Promise<unknown> {
  // Original BYOB request/backing, returned view, decoder slice and copying
  // overlap are funded before the first reader/read or authentication await.
  growOwnedHttpRequest(cap, 131072 + 16384 + 256);
  const diagnostics = beginOwnedHttpIntakeDiagnostics(cap);
  return ownedHttpCompletion(cap).start(async () => {
    const tooLarge = () => ownedHttpError(cap, 413, "request_too_large", `JSON request body exceeds the ${maxMediaJsonBodyBytes} byte limit`);
    const body = request.body;
    if (!body) { finishOwnedHttpIntakeDiagnostics(diagnostics); throw ownedHttpError(cap, 400, "invalid_json", "request body must be valid JSON"); }
    const io = new OwnedHttpIntakeIo(cap, diagnostics, body);
    let hasPrimary = false, primary: unknown, publicFailure: unknown;
    let prefixWire: Uint8Array | undefined, prefixUsed = 0, parser: ReturnType<typeof createPrivateJsonBodyParser> | undefined;
    let decoder: TextDecoder | undefined, parsed: unknown, size = 0;
    // Existing expanded-parser bound, including its current scalar before
    // concatenation. It is a component of the SAME body debit, not a new cap.
    const parserData = () => 8 * 3 * 65536 + 4 * size + 131072 + 524288;
    const feedText = (text: string) => {
      for (let offset = 0; offset < text.length;) {
        const first = text.charCodeAt(offset), second = text.charCodeAt(offset + 1);
        const end = offset + (first >= 0xd800 && first <= 0xdbff && second >= 0xdc00 && second <= 0xdfff ? 2 : 1);
        parser!.push(text.slice(offset, end)); offset = end;
      }
    };
    const feed = (bytes: Uint8Array) => {
      for (let offset = 0; offset < ownedByteLength(bytes); offset += 4096) feedText(decodeOwnedBytes(decoder!, ownedByteSubarray(bytes, offset, offset + 4096), true));
    };
    try {
      const declared = Number(request.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > maxMediaJsonBodyBytes) throw tooLarge();
      if (Number.isFinite(declared) && declared > 0) await admission.reserve(declared);
      io.open();
      decoder = newOwnedDecoder();
      try { request.signal.addEventListener("abort", io.abort, { once: true }); }
      catch (error) { throw ownedHttpIntakeFailure(diagnostics, "listenerAdd", error); }
      while (true) {
        if (request.signal.aborted) throw ownedHttpError(cap, 499, "request_canceled", "request was canceled");
        await io.read();
        if (io.readFailure) throw io.readFailure;
        if (request.signal.aborted) throw ownedHttpError(cap, 499, "request_canceled", "request was canceled");
        if (io.captureDone) { io.end(); io.consumedRead(); break; }
        if (io.captureOversized) throw identityFailure("limit");
        if (!io.captureLength) { io.consumedRead(); continue; }
        size += io.captureLength;
        if (size > maxMediaJsonBodyBytes) throw tooLarge();
        admission.noteOwnedInputBytes(size);
        // A short native read must not retain a whole 16 KiB backing for one
        // byte. The exact copy is admitted before its factory; the original
        // whole backing stays covered by the fixed read component until clear.
        await admission.reserve(Math.max(size, parser ? ownedByteLength(io.captureWire!) : prefixUsed + io.captureLength));
        if (!parser && size > maxJsonBodyBytes) {
          await admission.expand();
          admission.admitOwnedData(((prefixWire ? ownedByteLength(prefixWire) : 0)) + ownedByteLength(io.captureWire!) + parserData());
          parser = createPrivateJsonBodyParser();
          if (prefixWire) feed(ownedByteSubarray(prefixWire, 0, prefixUsed));
          prefixWire = undefined; prefixUsed = 0;
        }
        if (parser) {
          admission.admitOwnedData(ownedByteLength(io.captureWire!) + parserData(), true);
          feed(ownedByteSubarray(io.captureWire!, 0, io.captureLength));
        } else {
          if (!prefixWire || prefixUsed + io.captureLength > ownedByteLength(prefixWire)) {
            let next = (prefixWire ? ownedByteLength(prefixWire) : 16384);
            while (next < prefixUsed + io.captureLength) next = Math.min(maxJsonBodyBytes, 2 * next);
            admission.admitOwnedData(((prefixWire ? ownedByteLength(prefixWire) : 0)) + next + 4 * size);
            let previous = prefixWire;
            const replacement = newOwnedBytes(next);
            if (previous) copyOwnedBytes(replacement, ownedByteSubarray(previous, 0, prefixUsed));
            prefixWire = replacement; previous = undefined;
          }
          admission.admitOwnedData(ownedByteLength(prefixWire) + 4 * size, true);
          copyOwnedBytes(prefixWire, ownedByteSubarray(io.captureWire!, 0, io.captureLength), prefixUsed); prefixUsed += io.captureLength;
        }
        io.consumedRead();
      }
      if (parser) { feedText(decodeOwnedBytes(decoder)); parsed = parser.take(); }
      else {
        let text = "";
        for (let offset = 0; offset < prefixUsed; offset += 4096) text += decodeOwnedBytes(decoder, ownedByteSubarray(prefixWire!, offset, Math.min(offset + 4096, prefixUsed)), true);
        text += decodeOwnedBytes(decoder);
        prefixWire = undefined; prefixUsed = 0;
        const graph = ownedHttpJsonDataBytes(text);
        admission.admitOwnedData(2 * text.length + graph, true);
        parsed = ownedIntakeJsonParse(text); text = "";
        admission.admitOwnedData(graph, true);
      }
    } catch (error) {
      hasPrimary = true; primary = error;
      try { publicFailure = error instanceof JsonBodyStructureLimit ? ownedHttpError(cap, 413, "request_too_large", "JSON request exceeds Worker structure limits (65536 values, 128 nesting levels, 4096-character keys/numbers)")
        : isIdentityFailure(error) || isOwnedHttpLocalFailure(cap, error) || error instanceof Response ? error : ownedHttpError(cap, 400, "invalid_json", "request body must be valid JSON"); }
      catch (failure) { publicFailure = failure; }
      io.cancel();
    }
    const failures: unknown[] = [];
    // A read installation failure can throw before returning its logical
    // receipt. Its already-published cell still owns the actual late outcome.
    await io.reading?.ready;
    await io.cancelling?.ready;
    if (io.cancelFailure) failures.push(io.cancelFailure);
    try { request.signal.removeEventListener("abort", io.abort); }
    catch (error) { io.hold(); failures.push(ownedHttpIntakeFailure(diagnostics, "listenerRemove", error)); }
    io.unlock(); await io.unlocking?.ready;
    if (io.unlockFailure) failures.push(io.unlockFailure);
    await io.closed?.ready;
    if (body.locked) { io.hold(); failures.push(identityFailure("cleanup")); }
    decoder = undefined;
    parser?.discard(); parser = undefined; prefixWire = undefined;
    if (io.clear()) finishOwnedHttpIntakeDiagnostics(diagnostics);
    if (failures.length) throw new AggregateError(hasPrimary ? [primary, ...failures] : failures, "owned HTTP intake cleanup");
    if (hasPrimary) throw publicFailure;
    return parsed;
  });
}

// concreteOpenAiSelection retains the original input while constructing two
// shallow string-key carriers. Borrowing a nested object does not copy its graph;
// each copied string/primitive occurrence and each carrier cell still costs DATA.
// JSON intake supplies ordinary own data properties, including own __proto__.
function admitOwnedHttpSelectionCopies(cap: OwnedHttpRequest, body: Record<string, unknown>): void {
  let members = 0, primitives = 0, units = 0;
  for (const key in body) if (Object.prototype.hasOwnProperty.call(body, key)) {
    members++; units += key.length;
    const value = body[key];
    if (key === "model") continue; // Both carriers install the admitted upstream id.
    if (typeof value === "string") units += value.length;
    else if (value === null || typeof value !== "object") primitives++;
  }
  // Missing model is appended. The existing preparation profile admits the
  // resolved model before copies; reserve its full 16384-unit output here.
  if (!Object.prototype.hasOwnProperty.call(body, "model")) { members++; units += 5; }
  units += 16384;
  growOwnedHttpRequest(cap, 2 * (8 * (1 + 2 * members + primitives) + 2 * units));
}

/** Inactive compiled UNIFIED Chat entry. The index owns correlation/retirement. */
export async function proxyOwnedHttpChat(cap: OwnedHttpRequest, request: Request, env: Env, context: ExecutionContext): Promise<Response> {
  checkOwnedHttpRequest(cap, request, env); growOwnedHttpRequest(cap, 32768);
  const admission = new JsonAdmission(request, env, "proxy_key", undefined, cap);
  const invocation: OwnedProxyInvocation = { context, admission, attempts: [] };
  (ownedProxyInvocations ??= new WeakMap()).set(cap, invocation); ownedProxyCount++;
  let body: Record<string, unknown> | undefined;
  try {
    try {
      const parsed = await readOwnedHttpJson(cap, request, admission);
      if (!parsed || typeof parsed !== "object" || ownedIntakeArray(parsed)) throw ownedHttpError(cap, 400, "invalid_request_body", "request body must be a JSON object");
      body = parsed as Record<string, unknown>;
    }
    catch (error) {
      if (error instanceof Response) return error;
      const denied = await authenticateOwnedHttp(cap, request, env); if (denied) return denied;
      throw error;
    }
    admitOwnedHttpSelectionCopies(cap, body);
    const preparation = new PreparationAdmission();
    invocation.initialSelectionBody = body; invocation.preparingAdmission = preparation;
    let selection: ReturnType<typeof concreteOpenAiSelection>;
    try { selection = concreteOwnedOpenAiSelection(cap, request, body, env, preparation); }
    finally { invocation.initialSelectionBody = undefined; invocation.preparingAdmission = undefined; }
    const modelId = typeof body.model === "string" ? body.model : "";
    if (isSelectionFailure(selection)) {
      let delivered = false;
      try {
        const denied = await authenticateOwnedHttp(cap, request, env); if (denied) return denied;
        if (!modelId) return ownedErrorResponse(cap, "model_required", "model is required", 400);
        delivered = true; return selection.response;
      } finally { if (!delivered) discardOwnedHttpInitialError(cap, selection.response); }
    }
    if (selection.capability !== "llm.chat" || selection.endpoint.lifecycle || inlineMusicInput(selection) || publishedMusicInput(selection))
      throw ownedHttpError(cap, 400, "owned_chat_required", "private owned entry accepts unified Chat only");
    invocation.selection = selection;
    const provider = selection.provider, required = { providerId: provider.id, endpointId: selection.endpoint.id,
      mode: "http" as const, model: selectionUpstreamModel(selection), catalogModelId: selection.model?.id ?? null,
      capability: selection.capability };
    const denied = await authenticateOwnedHttp(cap, request, env, [{ id: provider.id,
      tokenRef: provider.auth.schemes.find(scheme => scheme.type === "oauth")?.tokenRef ?? provider.id }], required, correlationMetadata(request).sessionId);
    if (denied) return denied;
    invocation.required = required; bindOwnedHttpAuthentication(cap, request, env);
    if (!invocation.identity) throw identityFailure("protocol");
    return proxySelected(request, env, context, "proxy_key", selection, new URL(request.url).searchParams,
      invocation.identity, undefined, undefined, undefined, admission, cap);
  } finally { body = undefined; }
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
  const preparation = new PreparationAdmission();
  const earlySelection = concreteOpenAiSelection(path, body, env, undefined, preparation);
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
  return proxyConcreteOpenAi(request, env, context, path, mode, body, preauthenticated, undefined, undefined, undefined, undefined, admission, preparation);
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
  preparation = new PreparationAdmission(),
): Promise<Response> {
  const result = concreteOpenAiSelection(path, body, env, timeoutMs, preparation);
  if (isSelectionFailure(result)) {
    if (compound && result.auditSelection) await auditSelectionFailure(request, env, context, mode, result.auditSelection, preauthenticated, result.response.status, compound, auditAuth);
    return result.response;
  }
  reservedBudget?.fusion?.assertRoute(body, result.body as Record<string, unknown>, result.provider.id, result.endpoint.id, result.pathParams.model);
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
  const aggregatorPreparation = new PreparationAdmission();
  admitAccountingJson(body, "archive");
  // Resolve the route with a constant-size envelope before constructing the
  // worst-case reservation body. The SAME preparation token covers both reads.
  const probe = concreteOpenAiSelection("/v1/chat/completions", { model: config.aggregatorModel, messages: [] }, env, undefined, aggregatorPreparation);
  if (isSelectionFailure(probe)) return probe.response;
  const fusionAuth = await selectedAuth(fusionRequest, env, mode, probe, preauthenticated);
  if (fusionAuth instanceof Response) return fusionAuth;
  const renames = fusionAccountingRenames(probe, body, env, aggregatorPreparation);
  const certificate = prepareFusionAccounting(body, config, { provider: probe.provider.id, endpoint: probe.endpoint.id,
    upstream: probe.pathParams.model, renames }, view => admitProspectiveContentRetention(fusionAuth, probe, requestId, view));
  const aggregatorSelection = concreteOpenAiSelection("/v1/chat/completions", certificate.assemble(buildFusionReservationProposals(certificate.config)), env, undefined, aggregatorPreparation);
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
  const aggregatorBudget = await reserveSelected(fusionRequest, env, context, mode, aggregatorSelection, fusionAuth, {
    id: compoundRequestId, stage: "fusion_synthesizer", index: null, size: 1, startedAtMs: compoundStartedAtMs,
  });
  if (aggregatorBudget instanceof Response) return aggregatorBudget;
  aggregatorBudget.fusion = certificate;
  let primary: unknown, hasPrimary = false;
  try {
    const result = await collectFusionProposals(certificate.config, certificate.input, async (_model, adviserBody, timeoutMs, index, signal) => {
      const headers = new Headers(fusionRequest.headers);
      headers.set("x-request-id", randomId(`fusion-adviser-${index + 1}`));
      const adviserRequest = new Request(fusionRequest.url, { method: "POST", headers, signal: AbortSignal.any([fusionRequest.signal, signal]) });
      const compound: CompoundRequestContext = {
        id: compoundRequestId, stage: "fusion_adviser", index: index + 1, size: compoundRequestSize, startedAtMs: compoundStartedAtMs,
      };
      const preparation = new PreparationAdmission();
      const selection = concreteOpenAiSelection("/v1/chat/completions", adviserBody, env, timeoutMs, preparation);
      if (isSelectionFailure(selection)) {
        if (selection.auditSelection) await auditSelectionFailure(adviserRequest, env, context, mode, selection.auditSelection, preauthenticated, selection.response.status, compound, aggregatorBudget.auth);
        return selection.response;
      }
      selection.body = prepareAdviserBody(selection.body as Record<string, unknown>, selection.model, selection.endpoint, config.temperature);
      return proxySelected(adviserRequest, env, context, mode, selection, new URL(adviserRequest.url).searchParams, preauthenticated, undefined, compound, aggregatorBudget.auth);
    }, work => context.waitUntil(work));
    const aggregatorBody = certificate.assemble(result.proposals);
    const response = await proxyConcreteOpenAi(fusionRequest, env, context, "/v1/chat/completions", mode, aggregatorBody, preauthenticated, undefined, aggregatorBudget, {
      id: compoundRequestId, stage: "fusion_synthesizer", index: null, size: compoundRequestSize, startedAtMs: compoundStartedAtMs,
    }, undefined, undefined, aggregatorPreparation);
    const headers = new Headers(response.headers);
    headers.set("x-clawrouter-fusion-strategy", fusionStrategy(config));
    headers.set("x-clawrouter-fusion", result.proposals.length ? "advisers" : "aggregator-only");
    headers.set("x-clawrouter-fusion-aggregator", config.aggregatorModel);
    headers.set("x-clawrouter-fusion-adviser-count", String(result.proposals.length));
    headers.set("x-clawrouter-fusion-failed-count", String(result.failedModels.length));
    headers.set("x-clawrouter-fusion-latency-ms", String(result.durationMs));
    if (result.proposals.length) headers.set("x-clawrouter-fusion-advisers", result.proposals.map((proposal) => proposal.model).join(","));
    return inheritLocalError(response, new Response(response.body, { status: response.status, statusText: response.statusText, headers }));
  } catch (error) { hasPrimary = true; primary = error; throw error; }
  finally {
    try { await aggregatorBudget.finishUnclaimed(); }
    catch (cleanup) {
      const failure = new HttpError(503, "accounting_unavailable", "Fusion reservation cleanup could not finish");
      Object.defineProperty(failure, "accountingCleanup", { value: { hasPrimary, primary, cleanup } });
      throw failure;
    }
  }
}

// Mirror only the declared rename selection; no prompt-field vectors/copies.
// The certificate records the actual active sequence and upstream primitive.
function fusionAccountingRenames(selection: ProxySelection, original: Record<string, unknown>, env: Env, owner: PreparationAdmission) {
  const declared = selection.provider.adapter.requestTransforms.renameFields;
  admitAccountingJson(declared, "capsule");
  const active: Array<{ from: string; to: string }> = [];
  const translated = (key: string) => { for (const rename of active) if (key === rename.from) key = rename.to; return key; };
  const present = (name: string) => {
    if (name in Object.prototype) return true;
    if (translated("model") === name) return true;
    for (const key in original) if (Object.hasOwn(original, key) && translated(key) === name) return true;
    return false;
  };
  for (const rename of declared) {
    if (rename.paths.length && !rename.paths.includes("/v1/chat/completions")) continue;
    let allowed = !rename.upstreams.length || rename.upstreams.includes(selection.pathParams.model);
    if (!allowed && rename.upstreamConfig) {
      let value: string | null = null;
      const key = templateCandidates(selection.provider, rename.upstreamConfig, owner).find(candidate => (value = preparationValue(env, candidate, owner, true)));
      allowed = !!key && providerConfigurationList(value!, owner, key, undefined, true).includes(selection.pathParams.model);
    }
    if (allowed && present(rename.from) && !present(rename.to)) active.push({ from: rename.from, to: rename.to });
  }
  return active;
}

export async function proxyManifest(request: Request, env: Env, context: ExecutionContext, path: string, mode: AuthMode): Promise<Response> {
  const preparation = new PreparationAdmission();
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
  if (nativeRawFormat(endpoint.request_format)) return proxyNativeRaw(request, env, context, mode, provider, endpoint, preparation);
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
    const envelope = manifestEnvelope(wanAdmission ? await wanAdmission.wanCandidate(endpoint) : await readJson<unknown>(request), preparation, endpoint.path_param_styles);
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
        envelope = manifestEnvelope(value, preparation, endpoint.path_param_styles);
        value = undefined;
      }
      prepared = prepareManifestRequest(provider, endpoint, envelope.body, envelope.pathParams, env, false, preparation);
      envelope.body = undefined;
    } catch (error) {
      if (error instanceof Response) return error;
      const auth = await preauthenticate(request, env, mode, provider.id);
      if (auth instanceof Response) return auth;
      throw error;
    }
    const method = (envelope.method ?? endpoint.method).toUpperCase();
    if (!endpoint.methods.includes(method)) { const auth = await preauthenticate(request, env, mode, provider.id); return auth instanceof Response ? auth : errorResponse("method_not_allowed", `endpoint does not allow ${method}`, 405); }
    const capability = provider.capabilities.find((item) => item.endpoint === endpoint.id)?.id ?? endpoint.id;
    const selection: ProxySelection = { preparation, provider, endpoint, model: prepared.model, capability, body: prepared.body, pathParams: prepared.pathParams, method };
    if (!session) preauthenticated = admission.wanAuth ?? await preauthenticate(request, env, mode, provider.id, undefined, selection);
    if (session) preauthenticated = await accessSessionIdentity(session, env, provider.id, { provider, endpoint, mode: "http", model: prepared.model?.id });
    if (preauthenticated instanceof Response) return preauthenticated;
    prepared.body = {};
    await admission.prepareMusic(selection);
    return await proxySelected(request, env, context, mode, selection, envelope.query, preauthenticated, undefined, undefined, undefined, admission);
  } finally { admission.finish(context); }
}

export async function proxyNative(request: Request, env: Env, context: ExecutionContext, path: string): Promise<Response> {
  const preparation = new PreparationAdmission();
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
  if (nativeRawFormat(endpoint.request_format)) return proxyNativeRaw(request, env, context, "proxy_key", provider, endpoint, preparation);
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
      prepared = prepareNativeRequest(provider, endpoint, body, match[2], env, preparation);
      body = undefined;
    } catch (error) {
      if (error instanceof Response) return error;
      const auth = await preauthenticate(request, env, "proxy_key", provider.id);
      if (auth instanceof Response) return auth;
      throw error;
    }
    const capability = provider.capabilities.find((item) => item.endpoint === endpoint.id)?.id ?? endpoint.id;
    const selection = { preparation, provider, endpoint, model: prepared.model, capability, body: prepared.body, pathParams: prepared.pathParams, method };
    prepared.body = {};
    await admission.prepareMusic(selection);
    const preauthenticated = admission.wanAuth ?? await preauthenticate(request, env, "proxy_key", provider.id, undefined, selection);
    if (preauthenticated instanceof Response) return preauthenticated;
    return await proxySelected(request, env, context, "proxy_key", selection, isModelDiscovery(endpoint) ? discoveryQuery(new URL(request.url).searchParams) : new URL(request.url).searchParams, preauthenticated, undefined, undefined, undefined, admission);
  } finally { admission.finish(context); }
}

const nativeUploadGrants = new WeakMap<ProxySelection, PinnedGrant>();

async function proxyNativeRaw(request: Request, env: Env, context: ExecutionContext, mode: AuthMode, provider: CompiledProvider, endpoint: CompiledEndpoint, preparation: PreparationAdmission): Promise<Response> {
  const selection: ProxySelection = { preparation, provider, endpoint, model: null, capability: provider.capabilities.find(item => item.endpoint === endpoint.id)?.id ?? endpoint.id,
    body: {}, pathParams: {}, method: request.method };
  const initial = await preauthenticate(request, env, mode, provider.id, undefined, selection);
  if (initial instanceof Response) return initial;
  if (!initial) throw new HttpError(401, "invalid_proxy_key", "native upload requires an authenticated caller");
  assertPolicyModel(initial.policy, selection);
  await assertProviderAccess(provider, initial, env);
  const original = await upstreamAuth(provider, initial, env, new Set(), await grantStickyHash(request, initial), true, undefined,
    { provider, endpoint, mode: "http" }, undefined, undefined, undefined, undefined, preparation);
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
  const preparation = new PreparationAdmission();
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
      const envelope = manifestEnvelope(body, preparation, endpoint.path_param_styles);
      if (envelope.method && envelope.method !== "POST" || Object.keys(envelope.pathParams).length || hasProxyQuery(envelope.query)) miniMaxVideoDenied();
      prepared = prepareManifestRequest(provider, endpoint, envelope.body, {}, env, false, preparation); envelope.body = undefined;
    } else prepared = prepareNativeRequest(provider, endpoint, body, nativePath!, env, preparation);
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
    const selection: ProxySelection = { preparation, provider, endpoint, model, capability: "media.predict", body: input,
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
  const preparation = new PreparationAdmission();
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
      const envelope = manifestEnvelope(body, preparation, endpoint.path_param_styles);
      if (envelope.method && envelope.method !== "POST" || Object.keys(envelope.pathParams).length || hasProxyQuery(envelope.query)) miniMaxSearchDenied();
      prepared = prepareManifestRequest(provider, endpoint, envelope.body, {}, env, false, preparation);
      envelope.body = undefined;
    } else prepared = prepareNativeRequest(provider, endpoint, body, nativePath!, env, preparation);
    body = undefined;
    const selection: ProxySelection = { preparation, provider, endpoint, model: prepared.model, capability: "search.web", body: prepared.body, pathParams: prepared.pathParams, method: "POST" };
    prepared.body = {};
    const trackedContext = { ...context, waitUntil(promise: Promise<unknown>) { context.waitUntil(owner.track(promise)); }, passThroughOnException: () => context.passThroughOnException() } as ExecutionContext;
    return await owner.operation.wait(owner.track(proxySelected(request, env, trackedContext, mode, selection, {}, auth, undefined, undefined, undefined, admission)), "upstream", response => owner.discard(response));
  } finally { admission.finish(context); }
}

// Normalization may replay a body or detach its reader cancellation. Keep an
// independent receipt for the ORIGINAL source before giving it to those wrappers.
function ownOrdinaryResponse(response: Response, completion: ProxyCompletion, owned?: OwnedHttpRequest): Response {
  if (owned) return ownOwnedHttpResponse(owned, response);
  if (!response.body) return response;
  let forwarded!: Response;
  completion.start(source => {
    const reader = response.body!.getReader(), input = inputRetirement(reader);
    let stopped = false;
    try {
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          return source.start(async () => {
            try {
              const next = await input.read(() => reader.read());
              if (stopped) return;
              if (next.done) {
                stopped = true; controller.close();
                void input.retire("eof");
              } else controller.enqueue(next.value); // Forward the original chunk, without a copy.
            } catch (error) {
              if (!stopped) { stopped = true; controller.error(error); }
              void input.retire("cancel", error);
            }
          });
        },
        cancel(reason) { stopped = true; return input.retire("cancel", reason); },
      }, { highWaterMark: 0 });
      forwarded = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) {
      // Construction failure still owns the acquired source; preserve the throw.
      source.start(() => input.retire("cancel", error));
      throw error;
    }
    // Neither a pull nor cancel waits on encompassing caller completion. The
    // active source scope can enroll pulls until its original receipt settles.
    return input.retired;
  });
  return forwarded;
}

// Internal fixed call sites return only terminal scalars. The private receipt
// exists BEFORE work starts; registration failure cannot detach started work.
function registerProxyBackground(owned: OwnedHttpRequest | undefined, context: ExecutionContext, start: () => Promise<void | boolean>): void {
  if (!owned) { context.waitUntil(start()); return; }
  const receipt = beginOwnedHttpSinkRegistration(ownedHttpSinkOwner(owned));
  let work: Promise<void | boolean>;
  try { work = start(); }
  catch (primary) {
    try { abandonUnstartedOwnedHttpRegistration(receipt); }
    catch (cleanup) { throw new AggregateError([primary, cleanup], "owned background start cleanup"); }
    throw primary;
  }
  completeOwnedHttpSinkRegistration(receipt, context, work);
}
async function writeOwnedProxyRetention(retention: PreparedContentRetention): Promise<void> {
  let hasPrimary = false, primary: unknown;
  try {
    await new Promise<void>(resolve => { setTimeout(resolve, 0); });
    await retention.write();
  } catch (reason) { hasPrimary = true; primary = reason; }
  try { retention.discardUnused?.(); }
  catch (cleanup) { throw new AggregateError(hasPrimary ? [primary, cleanup] : [cleanup], "owned retention close"); }
  finally { retention = undefined as never; }
  if (hasPrimary) throw primary;
}
function reportOwnedRetentionFailure(requestId: string): void { logCorrelationError("request content retention failed", requestId); }
function startOwnedProxyRetention(http: OwnedHttpRequest, context: ExecutionContext, completion: ProxyCompletion,
  retention: PreparedContentRetention, requestId: string): void {
  const owner = ownedProxyInvocations?.get(http);
  if (!owner || owner.context !== context || owner.accounting?.requestId !== requestId) throw identityFailure("protocol");
  const receipt = beginOwnedHttpSinkRegistration(ownedHttpSinkOwner(http));
  let work: Promise<void> | undefined;
  try { completion.startPrivateLeaf(() => work = writeOwnedProxyRetention(retention)); }
  catch (primary) {
    try {
      if (work) completeOwnedHttpSinkRegistration(receipt, context, work);
      else abandonUnstartedOwnedHttpRegistration(receipt);
    } catch (cleanup) { throw new AggregateError([primary, cleanup], "owned retention start cleanup"); }
    throw primary;
  }
  // The leaf observes failure before the ordinary best-effort reporting path
  // consumes it. A recovered diagnostic does not rewrite its custody receipt.
  completeOwnedHttpSinkRegistration(receipt, context, work!.catch(reportOwnedRetentionFailure.bind(undefined, requestId)));
}
function startOwnedProxySoftBudget(http: OwnedHttpRequest, env: Env, context: ExecutionContext, completion: ProxyCompletion,
  plan: ReturnType<typeof prepareSoftBudget>, operation: HttpOperation): void {
  const owner = ownedProxyInvocations?.get(http);
  if (!owner || owner.context !== context || !matchesOwnedHttpRequestInputs(http, env) || owner.softPlan !== plan || owner.operation !== operation)
    throw identityFailure("protocol");
  const receipt = beginOwnedHttpSinkRegistration(ownedHttpSinkOwner(http));
  let check: Promise<void> | undefined;
  try { completion.startPrivateLeaf(() => {
    startOwnedHttpSoftBudget(http, env, plan, operation);
    check = ownedHttpSoftBudgetCheck(http); return check;
  }); } catch (primary) {
    try {
      if (check) completeOwnedHttpSinkRegistration(receipt, context, check);
      else abandonUnstartedOwnedHttpRegistration(receipt);
    } catch (cleanup) { throw new AggregateError([primary, cleanup], "owned status start cleanup"); }
    throw primary;
  }
  completeOwnedHttpSinkRegistration(receipt, context, check!);
}

// Fixed named synchronous calls: no arbitrary graph callback or async scope.
// The plan was funded before full admission could commit its initial choice.
function createOwnedHttpAccounting(cap: OwnedHttpRequest, options: Parameters<typeof createProxyAccounting>[0]): OwnedHttpAccountingCommand;
function createOwnedHttpAccounting(cap: OwnedHttpRequest, options: Parameters<typeof createProxyAccounting>[0], preparation: true): OwnedHttpPreparationAccounting;
function createOwnedHttpAccounting(cap: OwnedHttpRequest, options: Parameters<typeof createProxyAccounting>[0], preparation = false): OwnedHttpAccountingCommand | OwnedHttpPreparationAccounting {
  options.ownedHttp = ownedHttpSinkOwner(cap);
  const body = options.selection.body as Record<string, unknown>;
  enterOwnedHttpPricing(cap, body);
  let result: OwnedHttpAccountingCommand | OwnedHttpPreparationAccounting | undefined, hasPrimary = false, primary: unknown;
  try { result = preparation ? createOwnedHttpPreparationAccounting(cap, options) : createOwnedHttpAccountingCommand(cap, options); } catch (error) { hasPrimary = true; primary = error; }
  const failures: unknown[] = [];
  try { leaveOwnedHttpPricing(cap, body); } catch (error) { failures.push(error); }
  if (failures.length) {
    try { result?.close(); } catch (error) { failures.push(error); }
    result = undefined;
    throw new AggregateError(hasPrimary ? [primary, ...failures] : failures, "owned HTTP accounting pricing scope");
  }
  if (hasPrimary) throw primary;
  return result!;
}
function estimateOwnedHttpCost(cap: OwnedHttpRequest, selection: ProxySelection, auth: AuthorizedIdentity,
  parentTools: Parameters<typeof estimateCost>[5]): EstimatedCost {
  const body = selection.body as Record<string, unknown>;
  enterOwnedHttpPricing(cap, body);
  let result: EstimatedCost | undefined, hasPrimary = false, primary: unknown;
  try {
    result = estimateCost(selection.model, selection.body, policyRequestCost(auth.policy, selection.capability),
      selection.capability, selection.endpoint, parentTools, selection.nativeResponse?.tariff, selection.provider.id);
  } catch (error) { hasPrimary = true; primary = error; }
  const failures: unknown[] = [];
  try { leaveOwnedHttpPricing(cap, body); } catch (error) { failures.push(error); }
  if (failures.length) { result = undefined; throw new AggregateError(hasPrimary ? [primary, ...failures] : failures, "owned HTTP cost pricing scope"); }
  if (hasPrimary) throw primary;
  return result!;
}

async function proxySelected(request: Request, env: Env, context: ExecutionContext, mode: AuthMode, selection: ProxySelection, queryInput: ProxyQuery = {}, preauthenticated: AuthorizedIdentity | null = null, reservedBudget?: ReservedProxyBudget, compound?: CompoundRequestContext, auditAuth?: AuthorizedIdentity, admission?: JsonAdmission, owned?: OwnedHttpRequest): Promise<Response> {
  // Invoke only at the authenticated, validated boundary (or the earlier
  // identity-denial receipt). Never reconstruct the selection or reauthenticate.
  const complete = async (start: (scope?: ProxyCompletion) => Promise<Response>): Promise<Response> => {
    const ordinary = admission?.ordinaryCompletion() && !compound && !reservedBudget && !selection.nativeResponse
      && !selection.endpoint.lifecycle && !backgroundResponse(selection.endpoint, selection.body) && !isModelDiscovery(selection.endpoint) && selection.capability.startsWith("llm.")
      && !["minimax", "anthropic-vertex", "gmi"].includes(selection.provider.id)
      && ["openai.chat_completions", "openai.responses", "openai.responses_compact", "openai.responses_input_tokens", "anthropic.messages"].includes(selection.endpoint.request_format);
    const completion = owned ? ownedHttpCompletion(owned) : ordinary ? new ProxyCompletion() : undefined;
    if (completion) admission!.completion = completion.completion;
    try {
      if (completion && !owned) context.waitUntil(completion.completion);
      return await (completion ? completion.start(start) : start());
    } finally { if (!owned) completion?.seal(); }
  };
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
    return complete(async completion => {
      const options = { context, env, auth, selection, request, compound, completion, cost: { reserveMicros: 0, basis: "none", inputTokens: 0, outputTokens: 0 } };
      const accounting = owned ? createOwnedHttpAccounting(owned, options) : createProxyAccounting(options);
      try { accounting.fail(identityDenial.status, "denied"); return identityDenial; }
      finally { accounting.close(); }
    });
  }
  if (selection.endpoint.request_format === "elevenlabs.speech") selection.nativeQuery = qualifyNativeQuery(selection, queryInput, new URL(request.url));
  if (selection.endpoint.request_format === "openrouter.audio_transcription"
    && (!/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i.test(request.headers.get("content-type")?.trim() ?? "")
      || ![null, "identity"].includes(request.headers.get("content-encoding"))))
    throw new HttpError(400, "invalid_native_transcription_content_type", "native transcription requires uncompressed UTF-8 JSON");
  if (selection.endpoint.inputProfile !== undefined)
    throw new HttpError(400, "managed_input_profile_required", "this endpoint requires its registered native multipart input profile");
  validateSelectedInput(selection);
  return complete(completion => proxySelectedOwned(request, env, context, auth, selection, queryInput, reservedBudget, compound, admission, completion, owned));
}

async function proxySelectedOwned(request: Request, env: Env, context: ExecutionContext, auth: AuthorizedIdentity, selection: ProxySelection, queryInput: ProxyQuery, reservedBudget?: ReservedProxyBudget, compound?: CompoundRequestContext, admission?: JsonAdmission, completion?: ProxyCompletion, owned?: OwnedHttpRequest): Promise<Response> {
  let failureAccounting: ReturnType<typeof createProxyAccounting> | OwnedHttpPreparationAccounting | undefined;
  let accounting: ReturnType<typeof createProxyAccounting> | OwnedHttpAccountingCommand | undefined;
  let retention: PreparedContentRetention | null | undefined;
  let accountingDeferred = false, retentionDeferred = false;
  let codecConsumer: OwnedCodecConsumer | undefined;
  let codecPublished = false;
  const run = <T>(start: () => Promise<T>): Promise<T> => completion ? completion.start(start) : start();
  try {
  const searchOwner = admission?.search;
  const published = publishedMusicInput(selection);
  const music = inlineMusicInput(selection) ?? published;
  const usageContext = Object.freeze({ providerId: selection.provider.id, requestFormat: selection.endpoint.request_format, responseFormat: selection.endpoint.response_format });
  if (selection.endpoint.lifecycle || selection.endpoint.response_format === "replicate.prediction") {
    const { proxyManagedPrediction } = await import("./managed-predictions.ts");
    return proxyManagedPrediction(request, env, context, auth, selection, queryInput, admission?.wan);
  }
  const accountingContext = { context, env, auth, selection, request, compound, completion, search: searchOwner, startedAtMs: Date.now() };
  failureAccounting = owned ? createOwnedHttpAccounting(owned, accountingContext, true) : createProxyAccounting(accountingContext);
  let background: HttpBackground | undefined;
  let prepared: PreparedUpstream;
  let continuation: HttpContinuation | undefined;
  let googleContinuation: GoogleContinuation | undefined;
  let search: SearchSession | undefined;
  let grantFailover = false;
  let failedGrantKeys = owned ? ownedProxyInvocations!.get(owned)!.retry!.excluded : new Set(reservedBudget?.failedGrantKeys ?? []);
  try {
    // Published assets require an acknowledged reservation before their sole
    // destination claim. A soft-budget request cannot supply that authority.
    if (published && softBudgetPolicy(auth.policy)) throw new HttpError(400, "published_input_reservation_required", "published input forwarding requires authoritative budget reservation");
    const publishedPin = await published?.resolve(env, auth);
    if (isStandaloneSearch(selection.endpoint)) search = await SearchSession.resolve(env, auth, selection.body as Record<string, unknown>, selection.endpoint.id);
    continuation = await HttpContinuation.resolve(request, selection, auth, env);
    if (googleContinuationRoute(selection)) googleContinuation = await GoogleContinuation.resolve(request, selection, auth, env);
    const uploadGrant = nativeUploadGrants.get(selection);
    if (owned) {
      await run(() => prepareOwnedHttpAttempt(owned, request, env, selection, queryInput, request.signal));
      commitOwnedHttpAttempt(owned);
      prepared = ownedProxyInvocations!.get(owned)!.prepared!;
      if (!prepared) throw identityFailure("protocol");
    } else prepared = await run(() => prepareSelected(request, env, selection, queryInput, auth, failedGrantKeys, !uploadGrant && !published, reservedBudget?.connection, publishedPin ?? search?.pinned ?? continuation?.pinned ?? googleContinuation?.pinned ?? uploadGrant, "http", true, undefined, searchOwner, undefined, request.signal, reservedBudget?.grant));
    assertRequestTariffDestination(selection.endpoint, prepared.url);
    assertNativeResponseDestination(selection.nativeResponse, prepared.url);
    for (const key of prepared.failedGrantKeys ?? []) failedGrantKeys.add(key);
    grantFailover = failedGrantKeys.size > 0;
    if (prepared.continuation) continuation?.bind(prepared.continuation);
    if (prepared.continuation && googleContinuation) await googleContinuation.bind(prepared.continuation);
    if (search) {
      if (!prepared.continuation) throw new HttpError(503, "search_state_unavailable", "search owner is unavailable");
      prepared.requestBody = JSON.stringify({ ...selection.body, id: await search.bind(prepared.continuation) });
    }
    const cost = owned ? estimateOwnedHttpCost(owned, selection, auth, continuation?.parentTools)
      : estimateCost(selection.model, selection.body, policyRequestCost(auth.policy, selection.capability), selection.capability, selection.endpoint, continuation?.parentTools, selection.nativeResponse?.tariff, selection.provider.id);
    const options = { ...accountingContext, cost, grantKey: prepared.grantKey, grantLane: prepared.grantLane };
    accounting = owned ? createOwnedHttpAccounting(owned, options) : createProxyAccounting(options);
    if ("retireUnused" in failureAccounting) {
      await failureAccounting.retireUnused();
      failureAccounting = undefined;
    }
    if (reservedBudget && (reservedBudget.providerId !== selection.provider.id || reservedBudget.modelId !== selection.model?.id || reservedBudget.capability !== selection.capability || cost.reserveMicros > reservedBudget.cost.reserveMicros)) {
      reservedBudget.claim();
      accounting.fail(500, "provider_error", reservedBudget.reservation);
      return owned ? ownedErrorResponse(owned, "fusion_reservation_invalid", "fusion synthesizer reservation does not cover the final request", 500)
        : errorResponse("fusion_reservation_invalid", "fusion synthesizer reservation does not cover the final request", 500);
    }
    // Monetary coverage alone cannot prove that the final request remains priced.
    if (reservedBudget) validateBudgetReservation(selection.capability, cost, auth.policy.monthlyBudgetMicros, reservedBudget.connection, auth.policy.dailyBudgetMicros, auth.policy.limitHint, auth.policy.weeklyBudgetMicros);
  }
  catch (error) {
    if (isAccountingAdmissionFailure(error)) throw error;
    let failure = selectedFailure(search?.preflightError(error) ?? continuation?.preflightError(error) ?? googleContinuation?.preflightError(error) ?? error);
    if (isModelDiscovery(selection.endpoint) && failure.status === 400 && failure.code === "grant_transport_unavailable")
      failure = new HttpError(503, "upstream_grant_pool_unavailable", `provider ${selection.provider.id} has no available scoped upstream grant`);
    const status = failure.status === 403 ? "denied" : failure.status < 500 ? "client_error" : "provider_error";
    reservedBudget?.claim();
    const failureOwner = accounting ?? (owned ? ownedProxyInvocations!.get(owned)!.accounting : undefined) ?? failureAccounting;
    if (!failureOwner) throw identityFailure("protocol");
    failureOwner.fail(failure.status, status, reservedBudget?.reservation);
    return owned ? ownedErrorResponse(owned, failure.code, failure.message, failure.status, failure.headers?.["Retry-After"] ?? failure.headers?.["retry-after"])
      : errorResponse(failure.code, failure.message, failure.status, undefined, failure.headers);
  }
  const cost = owned ? ownedProxyInvocations!.get(owned)!.accountingCost! : (accounting as ReturnType<typeof createProxyAccounting>).cost;
  const requestId = accounting.requestId;
  const useSoft = !isModelDiscovery(selection.endpoint) && softBudgetPolicy(auth.policy) && !prepared.backgroundRecovery && !reservedBudget && compound?.stage !== "fusion_synthesizer";
  let softPlan: ReturnType<typeof prepareSoftBudget> | undefined;
  let reservePlan: ReturnType<typeof planBudgetReservation> | undefined;
  try {
    softPlan = useSoft ? prepareSoftBudget(auth, selection.capability, prepared.connection, owned ? (accounting as OwnedHttpAccountingCommand).eventId : (accounting as ReturnType<typeof createProxyAccounting>).facts.event.id, !!searchOwner) : undefined;
    reservePlan = !useSoft && !reservedBudget ? planBudgetReservation(auth, selection.capability, cost, prepared.connection) : undefined;
    if (owned) {
      const owner = ownedProxyInvocations!.get(owned)!;
      owner.accountingPlan = softPlan?.reservation ?? reservePlan ?? reservedBudget?.reservation;
      (accounting as OwnedHttpAccountingCommand).admitPlan(owner.accountingPlan, owner.upload!);
    }
    else admitAccountingFacts((accounting as ReturnType<typeof createProxyAccounting>).facts, softPlan?.reservation ?? reservePlan ?? reservedBudget?.reservation);
  } catch (error) {
    if (isAccountingAdmissionFailure(error)) throw error;
    // Pure planning moved before effects; ordinary monetary denials still own
    // their existing receipt. Never reconstruct a rejected accounting capsule.
    const failure = error instanceof HttpError ? error : new HttpError(503, "budget_store_unavailable", "budget ledger is unavailable");
    reservedBudget?.claim();
    accounting.fail(failure.status, failure.status === 402 ? "denied" : failure.status < 500 ? "client_error" : "provider_error", reservedBudget?.reservation);
    return owned ? ownedErrorResponse(owned, failure.code, failure.message, failure.status)
      : errorResponse(failure.code, failure.message, failure.status);
  }
  let soft: ReturnType<typeof softBudget> | undefined;
  let ownedSoft = false;
  let budgetMs = 0;
  let upstreamMs = 0;
  const budgetStart = performance.now();
  let reservation = reservedBudget?.reservation;
  try {
    if (music) {
      const pending = prepareInlineMusicRetention(env, auth, published?.retentionSelection() ?? selection, requestId, music.operation.signal);
      if (pending) music.retain(() => pending.discard());
      retention = pending;
    } else if (searchOwner) retention = await searchOwner.task(async () => {
      const pending = prepareContentRetention(env, auth, selection, requestId);
      await pending?.write(); return pending;
    });
    else retention = owned ? prepareOwnedHttpContentRetention(owned, env, auth, selection, requestId)
      : prepareContentRetention(env, auth, selection, requestId);
  }
  catch (error) {
    if (isAccountingAdmissionFailure(error)) throw error;
    reservedBudget?.claim();
    accounting.fail(503, "provider_error", reservation);
    return owned ? ownedErrorResponse(owned, "content_retention_unavailable", "required request-content retention is temporarily unavailable", 503)
      : errorResponse("content_retention_unavailable", "required request-content retention is temporarily unavailable", 503);
  }
  const content = retention?.contentRef ?? null;
  reservedBudget?.claim();
  if (prepared.backgroundRecovery) {
    try {
      if (!prepared.continuation || !continuation || reservedBudget) throw new HttpError(400, "background_unsupported", "this route cannot own background recovery");
      const pathParams = Object.fromEntries(selection.endpoint.path_params.map(name => [name, selection.pathParams[name]]));
      background = await HttpBackground.prepare(request, env, auth, prepared.continuation, (accounting as ReturnType<typeof createProxyAccounting>).facts, prepared.connection, pathParams, prepared.headers, !Array.isArray(selection.body) && selection.body.stream === true);
      await background.admit();
      continuation.background(background.admission.id);
    } catch (error) {
      const failure = selectedFailure(error);
      // Once a durable admission was attempted, only that owner may account it.
      if (!background) accounting.fail(failure.status, failure.status === 402 ? "denied" : "provider_error");
      return owned ? ownedErrorResponse(owned, failure.code, failure.message, failure.status)
      : errorResponse(failure.code, failure.message, failure.status);
    }
  } else if (!reservation && !useSoft) {
    try { reservation = await reserveBudget(env, auth, selection.capability, cost, prepared.connection, undefined, {
      // Fail-closed retention and stateful revalidation must finish before the
      // separate dispatch transition. Durable owners keep their own protocol.
      dispatched: !retention?.large && !prepared.revalidateAccount && !prepared.revalidateMedia, search: searchOwner, preparedPlan: reservePlan,
      ...(owned ? { ownedHttp: ownedHttpSinkOwner(owned) } : {}),
    }); }
    catch (error) {
      const failure = error instanceof HttpError ? error : new HttpError(503, "budget_store_unavailable", "budget ledger is unavailable");
      accounting.fail(failure.status, failure.status === 402 ? "denied" : failure.status < 500 ? "client_error" : "provider_error");
      return owned ? ownedErrorResponse(owned, failure.code, failure.message, failure.status)
      : errorResponse(failure.code, failure.message, failure.status);
    }
  }
  if (useSoft) {
    const denial = softBudgetPreflight(env, auth, selection.capability, prepared.connection);
    if (denial) {
      accounting.fail(402, "denied");
      return owned ? ownedErrorResponse(owned, denial.code, denial.message, 402) : errorResponse(denial.code, denial.message, 402);
    }
    if (owned) {
      growOwnedHttpRequest(owned, 256);
      const invocation = ownedProxyInvocations!.get(owned)!;
      invocation.softPlan = softPlan; invocation.softAttempt = invocation.upload;
      prepareOwnedHttpSoftBudget(owned, env, softPlan!);
    }
  }
  budgetMs = useSoft || !background && !reservation?.reservations.length ? 0 : performance.now() - budgetStart;
  try {
    // Durable background owners read the stored bytes, and expanded bodies must
    // not overlap transport memory: both keep the write ahead of dispatch.
    if (retention && !searchOwner && (background || retention.large)) await run(() => retention!.write());
  }
  catch {
    if (background) context.waitUntil(background.unsent(503, "provider_error", null));
    else accounting.fail(503, "provider_error", reservation);
    return owned ? ownedErrorResponse(owned, "content_retention_unavailable", "required request-content retention is temporarily unavailable", 503)
      : errorResponse("content_retention_unavailable", "required request-content retention is temporarily unavailable", 503);
  }
  if (retention && !searchOwner && !background && !retention.large) {
    // Best-effort and off the critical path: the timer lets dispatch start first,
    // so serialization and the R2 put overlap the upstream request.
    const pendingRetention = retention;
    retentionDeferred = true;
    if (owned) startOwnedProxyRetention(owned, context, completion!, pendingRetention, requestId);
    else registerProxyBackground(owned, context, () => run(() => new Promise(resolve => setTimeout(resolve, 0)).then(() => pendingRetention.write()).finally(() => { if (completion) pendingRetention.discardUnused?.(); })).catch(() => logCorrelationError("request content retention failed", requestId)));
  }
  if (owned) {
    const handoff = ownedProxyInvocations!.get(owned)!;
    handoff.terminalReservation = reservation ?? softPlan?.reservation;
    handoff.terminalContent = content;
    if ((handoff.accountingHandoff! & 7) === 1) handoff.accountingHandoff = handoff.accountingHandoff! & ~7 | 2;
  }
  try {
    const dispatchStart = performance.now();
    if (background) await background.dispatch(content);
    else if (!useSoft) await markBudgetDispatched(env, reservation!, undefined, searchOwner, owned ? ownedHttpSinkOwner(owned) : undefined);
    if (background || reservation?.reservations.length) budgetMs += performance.now() - dispatchStart;
  }
  catch {
    if (background) context.waitUntil(background.unsent(503, "provider_error", content));
    else accounting.fail(503, "provider_error", reservation, content);
    return owned ? ownedErrorResponse(owned, "accounting_unavailable", "Budget dispatch could not be recorded; no upstream request was sent.", 503)
      : errorResponse("accounting_unavailable", "Budget dispatch could not be recorded; no upstream request was sent.", 503);
  }
  const endpointTimeout = selection.endpoint.timeout_ms ?? 120_000;
  const operation = searchOwner?.operation ?? music?.operation ?? new HttpOperation(owned ? ownedHttpSignal(owned) : request.signal, Math.min(selection.timeoutMs ?? endpointTimeout, endpointTimeout));
  if (owned) {
    const invocation = ownedProxyInvocations!.get(owned)!;
    invocation.operation = operation; invocation.usageContext = usageContext; invocation.requestId = requestId;
  }
  const signal = operation.signal;
  // Stateful auxiliary operations requalify after budget/retention awaits, under the same
  // cancellation/deadline owner as transport. Interrupted reads are known-unsent.
  if ((prepared.revalidateAccount || prepared.revalidateMedia) && !searchOwner) {
    try { signal.throwIfAborted(); await operation.wait(run(() => prepared.revalidateMedia ? prepared.revalidateMedia(env, signal) : prepared.revalidateAccount!(signal))); }
    catch (error) {
      let failure;
      if (signal.aborted && owned) {
        const providerId = selection.provider.id;
        if (typeof providerId !== "string") throw identityFailure("protocol");
        admitOwnedHttpErrorText(owned, 36 + providerId.length);
        failure = ownedHttpError(owned, 502, "provider_unavailable", `upstream request to provider ${providerId} failed`);
      } else failure = signal.aborted ? new HttpError(502, "provider_unavailable", `upstream request to provider ${selection.provider.id} failed`) : selectedFailure(error);
      const status = operation.status ?? (failure.status < 500 ? "client_error" : "provider_error");
      operation.stop("upstream", error);
      accounting.fail(failure.status, status, reservation, content);
      return owned ? ownedErrorResponse(owned, failure.code, failure.message, failure.status)
      : errorResponse(failure.code, failure.message, failure.status);
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
  const discard = (response: Response, owner = completion): Promise<void> => {
    if (searchOwner) return searchOwner.discard(response);
    let pending = discarded?.get(response);
    if (!pending) {
      const dispose = async () => {
        if (!catalogInputs) {
          if (owned) await cancelOwnedHttpResponse(ownedHttpSinkOwner(owned), response);
          else if (owner) await response.body?.cancel(signal.reason);
          else await response.body?.cancel(signal.reason).catch(() => undefined);
          return;
        }
        if (!response.body) return;
        let input = catalogInputs.get(response.body);
        if (!input) {
          // A locked/used body without our owner is not a retirement receipt.
          if (response.bodyUsed || response.body.locked) throw new Error("catalog input ownership unavailable");
          input = inputRetirement(response.body.getReader());
          registerCatalogInput(input, response);
        }
        await input.retire("cancel", signal.reason);
      };
      // The private native codec may publish a late public Response after the
      // logical attempt sealed. Its prepaid sink custody remains open until
      // that codec's original output receipt settles; never reenter a sealed
      // logical completion merely to initiate its original cancellation.
      pending = owned ? dispose() : owner ? owner.start(dispose) : dispose();
      void pending.catch(() => undefined);
      (discarded ??= new WeakMap()).set(response, pending);
    }
    return pending;
  };
  const ordinaryFetch = (start: () => Promise<Response>): Promise<Response> => completion ? completion.start(children => {
    const work = start();
    // Enroll late-body cleanup before the fetch can settle or the caller can stop waiting.
    children.start(() => work.then(response => signal.aborted ? discard(response, children) : undefined, () => undefined));
    return work;
  }) : start();
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
  let ownedNativeRead: Promise<Response> | undefined;
  let nativeFetch: Promise<Response> | Promise<void> | undefined;
  let ownedFetch: OwnedHttpUpload | undefined;
  let ownedFetchPending: Promise<void> | undefined;
  let musicRead: Promise<unknown> | undefined;
  let imageRead: Promise<unknown> | undefined;
  let imageInput: ReturnType<typeof ownMiniMaxImageInput> | undefined;
  let dispatched = false;
  try {
    // A canceled preflight is known-unsent even if the ledger marks already landed.
    signal.throwIfAborted();
    if (owned && prepared.ownedVenice) checkOwnedVeniceChatCodec(prepared.ownedVenice, selection.nativeResponse!);
    else nativeLease = searchOwner ? undefined : music ? music.acquireResponse() : prepared.featherlessCatalog ? acquireFeatherlessCatalog() : selection.nativeResponse?.acquire() ?? prepared.acquireDiscovery?.();
    if (!nativeModelEligible(selection.endpoint.request_format, selection.model?.upstream)) throw new HttpError(400, "model_capability_unsupported", "selected model qualification expired before dispatch");
    dispatched = !searchOwner;
    if (owned) ownedProxyInvocations!.get(owned)!.accountingDispatched = dispatched;
    const upstreamStart = performance.now();
    if (owned) {
      ownedFetch = ownedPreparedUploads?.get(prepared);
      if (!ownedFetch) throw identityFailure("protocol");
      dispatchOwnedHttpUpload(ownedFetch);
      ownedFetchPending = startOwnedHttpProviderFetch(owned, ownedFetch, prepared.url, { method: selection.method, headers: prepared.headers, body: prepared.requestBody, signal, redirect: "manual" });
    }
    const pending = owned ? undefined : published ? published.dispatch(env, prepared.requestBody, { requestId, eventId: (accounting as ReturnType<typeof createProxyAccounting>).facts.event.id,
      reservedMicros: cost.reserveMicros, reservations: (reservation?.reservations ?? []).map(({ objectName, reservationId }) => ({ objectName, reservationId })) }) : prepared.featherlessCatalog
      ? featherlessCatalogResponse({ ...prepared.featherlessCatalog, registerInput: registerCatalogInput, registerFetch: registerCatalogFetch }, operation)
      : prepared.publicCatalog
      ? fetchPublicModelDiscovery({ ...prepared.publicCatalog, operation }).then(result => Response.json(
        manifestOnlyPublicCatalog(selection.endpoint.request_format) ? result : result.catalog,
        { headers: { "cache-control": "private, no-store" } }))
      : searchOwner ? searchOwner.providerFetch(async active => {
        await prepared.revalidateAccount?.(active);
        await prepared.revalidateMedia?.(env, active);
        active.throwIfAborted();
        dispatched = true;
        return fetch(prepared.url, { method: selection.method, headers: prepared.headers, body: prepared.requestBody, signal: active, redirect: "manual" });
      }) : ordinaryFetch(() => {
        return fetch(prepared.url, { method: selection.method, headers: prepared.headers, body: prepared.requestBody, signal, redirect: "manual" });
      });
    if (selection.nativeResponse) nativeFetch = owned ? ownedFetchPending : pending;
    if (prepared.featherlessCatalog) catalogWork = pending;
    else if (catalogInputs) registerCatalogFetch(pending!);
    if (useSoft) {
      if (owned) {
        startOwnedProxySoftBudget(owned, env, context, completion!, softPlan!, operation);
        ownedSoft = true; reservation = softPlan!.reservation;
      } else {
      const checking = completion?.fork();
      try {
        registerProxyBackground(owned, context, () => {
          soft = startSoftBudget(env, softPlan!, error => operation.stop("upstream", error), searchOwner);
          reservation = soft.reservation;
          if (checking) checking.start(() => soft!.check);
          return soft.check;
        });
      } catch (error) { checking?.fail(); throw error; }
      finally { checking?.seal(); }
      }
    }
    if (owned) {
      await operation.wait(ownedFetchPending!, "upstream");
      consumeOwnedHttpProviderResponse(ownedFetch!);
      const receiver = ownedProxyInvocations!.get(owned)!;
      response = receiver.incomingResponse!; receiver.incomingResponse = undefined;
    } else response = await operation.wait(pending!, "upstream", discard);
    if (completion && !owned) response = ownOrdinaryResponse(response, completion);
    if (music) {
      await music.completeUpload();
      prepared.requestBody = undefined;
    }
    let creditExhausted = false;
    const captureResponse = async (upstream: Response) => {
      creditExhausted = false;
      if (selection.provider.id === "anthropic" && upstream.status === 400 && prepared.grantKey) {
        const inspected = await inspectJsonError(upstream, operation);
        upstream = inspected.response;
        creditExhausted = providerCreditExhausted(selection.provider.id, upstream.status, inspected.body);
      }
      if (!searchOwner && !isModelDiscovery(selection.endpoint)) captureGrantRuntime(context, env, prepared.grantKey, prepared.grantRevision, selection.provider.quota, upstream, selection.provider.id, selectionUpstreamModel(selection), creditExhausted);
      return upstream;
    };
    accounting.observeUpstreamResponse(response, prepared.url);
    // Metadata permissions and rate limits do not establish inference health.
    if (owned) captureOwnedHttpRuntime(owned, request, env, prepared, selection, response);
    else response = await captureResponse(response);
    while (!accounting.upstreamChargePossible && !miniMaxAnthropicRoute(selection.provider, selection.endpoint) && selection.provider.id !== "anthropic-vertex" && selection.provider.id !== "gmi" && !selection.nativeResponse && !selection.endpoint.requestPricing && failedGrantKeys.size < MAX_GRANT_ATTEMPTS - 1 && !isModelDiscovery(selection.endpoint) && !background && !search && !continuation?.requested && !googleContinuation?.requested && shouldFailoverGrant(response.status, selection.method, selection.capability, prepared.grantKey, grantRoutingPolicy(auth.policy.grantRouting).failover, creditExhausted)) {
      let retry: PreparedUpstream | undefined;
      let capacityFailure: HttpError | undefined;
      signal.throwIfAborted();
      if (owned) {
        if (failedGrantKeys.has(prepared.grantKey!)) break;
        excludeOwnedHttpGrant(owned, prepared.grantKey!);
      } else failedGrantKeys.add(prepared.grantKey!);
      const preparation = owned ? run(() => prepareOwnedHttpAttempt(owned, request, env, selection, queryInput, signal))
        : run(() => prepareSelected(request, env, selection, queryInput, auth, failedGrantKeys, true, prepared.connection, undefined, "http", false, undefined, undefined, undefined, signal));
      const preparationSettled = preparation.then(() => {}, () => {});
      try {
        if (owned) {
          await operation.wait(preparation as Promise<void>);
          retry = ownedProxyInvocations!.get(owned)!.retry?.pending?.prepared;
        } else retry = await operation.wait(preparation as Promise<PreparedUpstream>);
      } catch (error) {
        if (isPreparationLimit(error) || isAccountingAdmissionFailure(error) || isIdentityFailure(error)) capacityFailure = error;
        // Ordinary selection failure leaves the original rejection available to the caller.
      } finally {
        // Join logical preparation even when the operation stopped waiting for it.
        await preparationSettled;
      }
      signal.throwIfAborted();
      if (capacityFailure) throw capacityFailure;
      if (retry) {
        signal.throwIfAborted();
        if (completion) void discard(response);
        else void response.body?.cancel().catch(() => undefined);
        signal.throwIfAborted();
        // The alternate may execute without returning headers. Its uncertainty
        // must not inherit the discarded attempt's nonbillable rejection.
        response = undefined;
        prepared = owned ? commitOwnedHttpAttempt(owned) : retry;
        for (const key of prepared.failedGrantKeys ?? []) failedGrantKeys.add(key);
        accounting.setGrant(prepared.grantKey, prepared.grantLane);
        if (owned) {
          ownedFetch = ownedPreparedUploads?.get(prepared); ownedFetchPending = undefined;
          if (!ownedFetch) throw identityFailure("protocol");
          dispatchOwnedHttpUpload(ownedFetch);
          ownedFetchPending = startOwnedHttpProviderFetch(owned, ownedFetch, prepared.url, { method: selection.method, headers: prepared.headers, body: prepared.requestBody, signal, redirect: "manual" });
          await operation.wait(ownedFetchPending, "upstream");
          consumeOwnedHttpProviderResponse(ownedFetch);
          const receiver = ownedProxyInvocations!.get(owned)!;
          response = receiver.incomingResponse!; receiver.incomingResponse = undefined;
        } else response = await operation.wait(ordinaryFetch(() => fetch(prepared.url, { method: selection.method, headers: prepared.headers, body: prepared.requestBody, signal, redirect: "manual" })), "upstream", discard);
        if (completion && !owned) response = ownOrdinaryResponse(response, completion);
        accounting.observeUpstreamResponse(response, prepared.url);
        if (owned) captureOwnedHttpRuntime(owned, request, env, prepared, selection, response);
        else response = await captureResponse(response);

        if (prepared.continuation) continuation?.bind(prepared.continuation);
        if (prepared.continuation && googleContinuation) await googleContinuation.bind(prepared.continuation);
        grantFailover = true;
      } else break;
    }
    if (owned) { closeOwnedHttpRetry(owned); failedGrantKeys = undefined as never; }
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
    // Final alternate selection and every synchronous pricing/serialization
    // consumer have finished. Facts, uploads and accounting keep their owners.
    if (owned) {
      retireOwnedHttpPricing(owned);
      ownedProxyInvocations!.get(owned)!.foregroundCommandsClosed = true;
      finishOwnedHttpForegroundCommands(owned);
    }
    if (owned && prepared.ownedVenice) {
      const receiver = ownedProxyInvocations!.get(owned)!;
      receiver.nativeResponse = response;
      receiver.nativeSignal = signal;
      ownedNativeRead = readOwnedVeniceChatResponse(prepared.ownedVenice, response, signal);
      response = await operation.wait(ownedNativeRead, "upstream", discard);
      forwardOwnedVeniceUsage(prepared.ownedVenice, owned, response);
      nativeUsage = receiver.nativeUsage;
      try { if (prepared.revalidateDelivery) await operation.wait(prepared.revalidateDelivery(signal), "publication"); }
      catch (error) { void discard(response); throw error; }
    } else if (selection.nativeResponse) {
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
    if (ownedSoft) {
      budgetMs = await beforeOwnedHttpSoftDelivery(owned!);
      const denial = ownedHttpSoftDenial(owned!); if (denial) throw denial;
    } else if (soft) {
      budgetMs = await soft.beforeDelivery();
      if (soft.denial) throw soft.denial;
    }
    if (!response.ok && !selection.nativeResponse) operation.acceptRejection(response.status);
    const streaming = Array.isArray(selection.body)
      ? selection.body.some(({ query }) => !!query && typeof query === "object" && "stream" in query && query.stream === true)
      : selection.body.stream === true;
    const errorFormat = selection.endpoint.request_format.startsWith("anthropic.") ? "anthropic" : selection.endpoint.request_format.startsWith("openai.") ? "openai" : undefined;
    const normalizeStreaming = !cost.requestTariff && streaming && !["audio.binary", "ollama.chat", "radius.messages"].includes(selection.endpoint.response_format);
    if (owned && prepared.ownedVenice) {
      codecConsumer = beginOwnedCodecConsumer(owned, prepared.ownedVenice, response, operation, streaming, requestId, nativeUsage, usageContext);
      ownedProxyInvocations!.get(owned)!.consumer = codecConsumer;
      response = await normalizeOwnedCodecPreStreamError(codecConsumer, response, normalizeStreaming, operation, errorFormat ? { format: errorFormat, requestId } : undefined);
    } else {
      if (completion) response = ownOrdinaryResponse(response, completion, owned);
      if (owned) {
        const invocation = ownedProxyInvocations!.get(owned)!;
        invocation.normalizingResponse = response;
        try { response = await normalizeOwnedHttpPreStreamError(owned, invocation.upload!, response, normalizeStreaming, operation, errorFormat ? { format: errorFormat, requestId } : undefined); }
        finally { invocation.normalizingResponse = undefined; }
      } else response = await normalizePreStreamError(response, normalizeStreaming, operation, errorFormat ? { format: errorFormat, requestId } : undefined);
    }
    // Price inspection reads delivery bytes, not initial-response headers.
    // Search retains its original deadline through delivery; other native paths
    // retire only the timer and keep caller cancellation connected through EOF.
    if (!searchOwner) operation.retireDeadline();
    if (selection.capability === "llm.messages" && selection.endpoint.request_format === "anthropic.messages" && reservation?.reservations.length && policyRequestCost(auth.policy, selection.capability) == null) {
      priceGuard = await guardAnthropicPrice(response, tokens => tokens?.billable === false || !!anthropicPricing(selection.model?.pricing, selection.model?.upstream, (accounting as ReturnType<typeof createProxyAccounting>).facts.anthropicRequest ?? {}, tokens?.anthropic ?? {}), operation, requestId);
      response = priceGuard.response;
    }
  } catch (error) {
    if (owned) { closeOwnedHttpRetry(owned); failedGrantKeys = undefined as never; }
    const ownedFetchRetirement = ownedFetch ? disposeOwnedHttpProviderResponse(ownedFetch) : undefined;
    if (codecConsumer) abandonOwnedCodecConsumer(codecConsumer);
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
    } else if (nativeRead || ownedNativeRead || nativeFetch) {
      // Cancellation/accounting can finish now. A qualified reader settles only
      // after input retirement; late fetch/results also retain their first cleanup.
      const retirement = (async () => {
        await nativeRead?.then(discardNative, () => undefined);
        await ownedNativeRead?.then(discard, () => undefined);
        if (owned) await ownedFetchRetirement;
        else await (nativeFetch as Promise<Response> | undefined)?.then(discard, () => undefined);
      })();
      context.waitUntil(retirement.then(() => failedLease?.release()));
    } else failedLease?.release();
    if (ownedSoft) closeOwnedHttpSoftBudget(owned!); else soft?.close();
    const softDenial = ownedSoft ? ownedHttpSoftDenial(owned!) : soft?.denial;
    if (softDenial) {
      operation.stop("upstream", softDenial);
      if (response) void discard(response);
      if (nativeUsage?.requestCostReceipt && cost.requestTariff) context.waitUntil(accounting.settle(402, "denied", true, null, reservation!, content, null, undefined, "unknown", nativeUsage.requestCostReceipt));
      else accounting.fail(402, "denied", (cost.requestTariff || selection.nativeResponse) ? reservation : undefined, content, !!(cost.requestTariff || selection.nativeResponse) && dispatched);
      return owned ? ownedErrorResponse(owned, softDenial.code, softDenial.message, 402) : errorResponse(softDenial.code, softDenial.message, 402);
    }
    if ((isPreparationLimit(error) || isAccountingAdmissionFailure(error) || isIdentityFailure(error)) && !signal.aborted) {
      operation.stop("upstream", error);
      if (response) void discard(response);
      // Alternate preparation never dispatched. The original received rejection
      // remains known nonbillable; capacity is not a credential rescue signal.
      accounting.fail(error.status, "provider_error", reservation, content, dispatched && response?.ok !== false);
      return owned ? ownedErrorResponse(owned, error.code, error.message, error.status) : errorResponse(error.code, error.message, error.status);
    }
    operation.stop("upstream", error);
    if (response) void discard(response);
    if (!dispatched && error instanceof HttpError) {
      accounting.fail(error.status, "provider_error", reservation, content);
      return owned ? ownedErrorResponse(owned, error.code, error.message, error.status) : errorResponse(error.code, error.message, error.status);
    }
    // A fetch failure can incur cost; a received rejection stays nonbillable
    // even if reading its SSE error body failed.
    if (background) {
      if (!dispatched || response?.ok === false) context.waitUntil(background.unsent(response?.status ?? 502, operation.status ?? "provider_error", content));
      // Unknown dispatched delivery remains collectible; it is not a terminal.
    } else accounting.fail(isModelDiscovery(selection.endpoint) && error instanceof HttpError ? error.status : 502, isModelDiscovery(selection.endpoint) && error instanceof HttpError && error.status === 403 ? "denied" : operation.status ?? "provider_error", reservation, content, dispatched && (!!cost.requestTariff || !!selection.nativeResponse || response?.ok !== false));
    if (isModelDiscovery(selection.endpoint) && error instanceof HttpError) return errorResponse(error.code, error.message, error.status, undefined, error.headers);
    if (owned) {
      const providerId = selection.provider.id;
      if (typeof providerId !== "string") throw identityFailure("protocol");
      admitOwnedHttpErrorText(owned, 36 + providerId.length);
      return ownedErrorResponse(owned, "provider_unavailable", `upstream request to provider ${providerId} failed`, 502);
    }
    return errorResponse("provider_unavailable", `upstream request to provider ${selection.provider.id} failed`, 502, undefined);
  }
  // Existing endpoint timers cover fetch and normalization. Search instead
  // keeps its operation deadline through downstream EOF or cancellation.
  if (!searchOwner) operation.retireDeadline();
  if (continuation && response.ok && !operation.receivedRejection && selection.capability !== "llm.responses.compact") {
    try { await operation.wait(run(() => continuation!.headers(response!)), "publication"); }
    catch (error) {
      operation.stop("publication", error);
      discard(response);
      const failure = selectedFailure(error);
      if (!background) context.waitUntil(accounting.settle(failure.status, operation.status ?? "provider_error", true, null, reservation!, content));
      return owned ? ownedErrorResponse(owned, failure.code, failure.message, failure.status)
      : errorResponse(failure.code, failure.message, failure.status);
    }
  }
  const inspection = response.ok && !operation.receivedRejection ? continuation?.inspect(response, selection.capability === "llm.responses.compact") ?? googleContinuation?.inspect(response) : undefined;
  if (inspection && background) {
    const job = background;
    Object.assign(inspection, { observe: async (fact: import("./token-usage.ts").ResponsesObservation) => { await job.observe(fact, response!.status); } });
  }
  let observed: ReturnType<typeof observeUsage> | undefined;
  let delivered: Response, retired: Promise<void>;
  if (codecConsumer) {
    if (owned) ownedProxyInvocations!.get(owned)!.terminalResponse = response;
    delivered = observeOwnedCodecUsage(codecConsumer, response, operation, nativeUsage, usageContext);
    retired = ownedCodecConsumerRetirement(codecConsumer);
  } else if (owned) {
    const owner = ownedProxyInvocations!.get(owned)!;
    if (inspection || background || priceGuard) throw identityFailure("protocol");
    owner.usageInput = response;
    try {
      owner.genericUsage = beginOwnedHttpGenericUsage(owned, owner.upload!, response, operation,
        selection.endpoint.response_format, cost.requestTariff, nativeUsage, usageContext, accounting as OwnedHttpAccountingCommand);
      delivered = observeOwnedGenericUsage(owner.genericUsage, response, operation, nativeUsage, usageContext);
      retired = ownedGenericUsageRetirement(owner.genericUsage);
    } finally { owner.usageInput = undefined; }
  } else {
    const observe = () => observeUsage(response!, operation, inspection, selection.endpoint.response_format, cost.requestTariff, nativeUsage, usageContext);
    if (completion) completion.start(() => { observed = observe(); return observed.retired; });
    else observed = observe();
    delivered = observed!.response; retired = observed!.retired;
  }
  if (nativeLease) {
    const deliveryLease = nativeLease;
    context.waitUntil(retired.then(() => deliveryLease.release()));
  }
  if (!completion && admission) admission.completion = observed!.result;
  if (searchOwner) searchOwner.track(retired);
  if (background) {
    if (!response.ok) context.waitUntil(background.unsent(response.status, operation.status ?? "provider_error", content));
    else if (operation.receivedRejection) {
      // Native HTTP-200 rejection evidence remains provisional until delivery:
      // a misbehaving upstream may send billable work after its error event.
      const job = background, statusCode = response.status;
      context.waitUntil(observed!.result.then(result => job.finishRejectedDelivery({
        statusCode, status: operation.status ?? "provider_error", billable: !result.nonbillable, tokens: result.tokens, contentRef: content,
      })));
    }
  } else {
    accountingDeferred = true;
    const terminalAccounting = accounting;
    if (owned && (codecConsumer || ownedProxyInvocations!.get(owned)!.genericUsage)) {
      startOwnedUsageAccounting(owned, context, completion!, codecConsumer ?? ownedProxyInvocations!.get(owned)!.genericUsage!,
        terminalAccounting as OwnedHttpAccountingCommand, delivered, reservation!, content);
    } else registerProxyBackground(owned, context, () => run(() => observed!.result.then(result => {
    const failure = priceGuard?.failure();
    // Replacing an unpriced response doesn't undo the dispatched work. Retain
    // the hard reservation and record the original usage, not a free rejection.
    return failure ? terminalAccounting.pricingFailure(failure.tokens, reservation!, content)
      : terminalAccounting.complete(observed!.response, result, reservation!, content, operation.status);
    }).finally(() => { if (completion) terminalAccounting.close(); })));
  }
  response = delivered;
  if (owned) {
    const publishedResponse = publishOwnedProxyResponse(owned, response, selection, auth, prepared, operation,
      budgetMs, upstreamMs, grantFailover, content, priceGuard, !!music);
    codecPublished = true; return publishedResponse;
  }
  const outputHeaders = proxyResponseHeaders(response, selection.provider.id);
  // Header sanitization strips upstream router-code spoofing. Only a verified
  // local JSON replacement may restore this diagnostic; SSE fails after headers.
  if (priceGuard?.failure() && response.status === 502) outputHeaders.set("x-clawrouter-error-code", "pricing_required");
  const cacheState = admissionCacheState(auth), credential = credentialWait(auth);
  outputHeaders.set("server-timing", `cr-admission;dur=${admissionDuration(auth).toFixed(1)}, cr-budget;dur=${budgetMs.toFixed(1)}, cr-upstream-ttfb;dur=${upstreamMs.toFixed(1)}${cacheState ? `, cr-cache;desc=${cacheState}` : ""}${credential ? `, cr-credential;dur=${credential.ms.toFixed(1)};desc=${credential.cache}` : ""}`);
  outputHeaders.set("x-clawrouter-grant-lane", prepared.grantLane);
  if (grantFailover) outputHeaders.set("x-clawrouter-grant-failover", "1");
  outputHeaders.set("x-clawrouter-content-retention", music ? content ? "on; retention-days=30" : "off" : retentionRequired(auth, selection.capability) ? "on; retention-days=30" : "off");
  if (owned) ownedProxyInvocations!.get(owned)!.publicBody = response.body;
  const publishedResponse = new Response(response.body, { status: response.status, statusText: response.statusText, headers: outputHeaders });
  codecPublished = true;
  return publishedResponse;
  } finally {
    if (owned) closeOwnedHttpRetry(owned);
    // Settle the logical publication barrier even when physical abandonment
    // throws; accounting never waits for its reader/upload/archive originals.
    try {
    if (codecConsumer && !codecPublished) abandonOwnedCodecConsumer(codecConsumer);
    if (owned && !codecPublished) {
      const owner = ownedProxyInvocations!.get(owned)!, usage = owner.genericUsage;
      if (usage) {
        abandonOwnedHttpGenericUsage(usage);
      }
    }
    } finally { if (owned) settleOwnedAccountingPublication(owned, codecPublished); }
    if (completion) {
      failureAccounting?.close();
      if (!accountingDeferred && !owned) accounting?.close();
      if (!retentionDeferred) retention?.discardUnused?.();
    }
  }
}

// Closed private publication uses the producer-bound Response/body, never an
// accounting result or a newly assigned publicBody as its authority.
function publishOwnedProxyResponse(http: OwnedHttpRequest, response: Response, selection: ProxySelection,
  auth: AuthorizedIdentity, prepared: PreparedUpstream, operation: HttpOperation, budgetMs: number, upstreamMs: number,
  grantFailover: boolean, content: string | null, priceGuard: AnthropicPriceGuard | undefined, music: boolean): Response {
  const owner = ownedProxyInvocations?.get(http);
  if (!owner || owner.selection !== selection || owner.identity !== auth || owner.prepared !== prepared || !owner.upload
    || !matchesOwnedHttpPublicationContext(http, owner.upload, operation)) throw identityFailure("protocol");
  const outputHeaders = beginOwnedHttpProxyPublicationHeaders(http, response, selection.provider.id);
  if (priceGuard?.failure() && response.status === 502) setOwnedHeader(outputHeaders, "x-clawrouter-error-code", "pricing_required");
  const cacheState = admissionCacheState(auth), credential = credentialWait(auth);
  setOwnedHeader(outputHeaders, "server-timing", `cr-admission;dur=${admissionDuration(auth).toFixed(1)}, cr-budget;dur=${budgetMs.toFixed(1)}, cr-upstream-ttfb;dur=${upstreamMs.toFixed(1)}${cacheState ? `, cr-cache;desc=${cacheState}` : ""}${credential ? `, cr-credential;dur=${credential.ms.toFixed(1)};desc=${credential.cache}` : ""}`);
  setOwnedHeader(outputHeaders, "x-clawrouter-grant-lane", prepared.grantLane);
  if (grantFailover) setOwnedHeader(outputHeaders, "x-clawrouter-grant-failover", "1");
  setOwnedHeader(outputHeaders, "x-clawrouter-content-retention", music ? content ? "on; retention-days=30" : "off" : retentionRequired(auth, selection.capability) ? "on; retention-days=30" : "off");
  const firstBody = response.body;
  checkOwnedHttpProxyPublicationBody(http, response, firstBody); owner.publicBody = firstBody;
  const body = response.body, status = response.status, statusText = response.statusText;
  return finishOwnedHttpProxyPublication(http, response, body, status, statusText, outputHeaders);
}

async function reserveSelected(request: Request, env: Env, context: ExecutionContext, mode: AuthMode, selection: ProxySelection, preauthenticated: AuthorizedIdentity | null, compound?: CompoundRequestContext): Promise<ReservedProxyBudget | Response> {
  const auth = await selectedAuth(request, env, mode, selection, preauthenticated);
  if (auth instanceof Response) return auth;
  const failureAccounting = createProxyAccounting({ context, env, auth, selection, request, compound });
  let prepared: PreparedUpstream;
  try {
    prepared = await prepareSelected(request, env, selection, {}, auth);
  } catch (error) {
    if (isAccountingAdmissionFailure(error)) throw error;
    const failure = selectedFailure(error);
    const status = failure.status === 403 ? "denied" : failure.status < 500 ? "client_error" : "provider_error";
    failureAccounting.fail(failure.status, status);
    return errorResponse(failure.code, failure.message, failure.status, undefined, failure.headers);
  }
  // Preparation can pin the API service tier. Admit that successful capsule
  // before reserve; the early owner is used only when preparation fails.
  const accounting = createProxyAccounting({ context, env, auth, selection, request, compound });
  const { cost } = accounting;
  try {
    const reservation = await reserveBudget(env, auth, selection.capability, cost, prepared.connection);
    let claimed = false, cleanup: Promise<void> | undefined;
    return { auth, reservation, cost, grant: { key: prepared.grantKey, revision: prepared.grantRevision }, failedGrantKeys: prepared.failedGrantKeys, providerId: selection.provider.id, modelId: selection.model?.id ?? null, capability: selection.capability, connection: prepared.connection,
      claim() { claimed = true; },
      finishUnclaimed() {
        if (claimed) return Promise.resolve();
        return cleanup ??= accounting.settle(500, "provider_error", false, null, reservation, null).then(ok => {
          if (!ok) throw new HttpError(503, "accounting_unavailable", "Fusion reservation cleanup could not finish");
        });
      },
    };
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

// This closes retry authority, not credential/upload/codec custody. The chosen
// prepared-to-upload association remains available to delivery and publication.
function closeOwnedHttpRetry(cap: OwnedHttpRequest): void {
  const owner = ownedProxyInvocations?.get(cap), retry = owner?.retry;
  if (!owner || !retry) return;
  if (retry.pending?.phase === 1) throw identityFailure("protocol");
  for (const port of retry.ports) {
    if (port.prepared) {
      ownedPreparedSelections?.delete(port.prepared);
      if (port.prepared !== owner.prepared) ownedPreparedUploads?.delete(port.prepared);
      delete port.prepared.failedGrantKeys;
    }
    delete port.input; delete port.signal; delete port.permit; delete port.prepared;
    delete port.upload; delete port.identity; delete port.credential; port.phase = 5;
  }
  retry.ports.length = 0; retry.excluded.clear(); delete retry.pending;
  owner.retryClosed = true; delete owner.required; delete owner.retry;
}

export function matchesOwnedHttpAttemptInput(cap: OwnedHttpRequest, request: Request, env: Env,
  input: import("./authority-admission.ts").AdmissionSelection, selection: ProxySelection, signal: AbortSignal, permit?: object): boolean {
  const owner = ownedProxyInvocations?.get(cap), port = owner?.retry?.pending;
  return !!owner && !owner.retryClosed && !!port && port.phase === 1 && owner.selection === selection && port.input === input && port.signal === signal
    && matchesOwnedHttpRequestInputs(cap, env, request) && (permit === undefined ? port.permit === undefined : port.permit === permit);
}
export function bindOwnedHttpAttemptPermit(cap: OwnedHttpRequest, request: Request, env: Env,
  input: import("./authority-admission.ts").AdmissionSelection, selection: ProxySelection, signal: AbortSignal, permit: object): void {
  if (!matchesOwnedHttpAttemptInput(cap, request, env, input, selection, signal) || !ownsOwnedHttpSelectionPermit(permit, cap)) throw identityFailure("protocol");
  ownedProxyInvocations!.get(cap)!.retry!.pending!.permit = permit;
}
export function bindOwnedHttpAttemptCredential(cap: OwnedHttpRequest, permit: object, credential: OwnedHttpCredential): void {
  const port = ownedProxyInvocations?.get(cap)?.retry?.pending;
  if (!port || port.phase !== 1 || port.permit !== permit || port.credential
    || !matchesOwnedHttpCredentialPreparation(credential, cap, permit)) throw identityFailure("protocol");
  port.credential = credential;
}
export function completeOwnedHttpAttemptProvider(cap: OwnedHttpRequest, permit: object): void {
  const owner = ownedProxyInvocations?.get(cap), port = owner?.retry?.pending;
  if (!owner || !port || port.phase !== 1 || port.permit !== permit || !port.credential || !port.prepared
    || ownsOwnedHttpSelectionPermit(permit, cap) || owner.preparingIdentity || owner.preparingUpstream || owner.preparingFields || owner.preparingAdmission)
    throw identityFailure("protocol");
  port.phase = 2;
}
export function matchesOwnedHttpCompletedPreparation(cap: OwnedHttpRequest, request: Request, credential: OwnedHttpCredential, permit: object): boolean {
  const owner = ownedProxyInvocations?.get(cap), port = owner?.retry?.pending, prepared = port?.prepared;
  return !!owner && !!port && port.phase === 2 && port.credential === credential && port.permit === permit
    && !ownsOwnedHttpSelectionPermit(permit, cap) && matchesOwnedHttpCredentialPreparation(credential, cap, permit, request)
    && !!prepared && !prepared.ownedVenice && !prepared.revalidateAccount && !prepared.revalidateMedia
    && !prepared.revalidateDiscovery && !prepared.revalidateDelivery && !prepared.acquireDiscovery && !prepared.continuation
    && owner.selection?.provider.id !== "venice" && owner.selection?.provider.id !== "gmi"
    && !owner.preparingIdentity && !owner.preparingUpstream && !owner.preparingFields && !owner.preparingAdmission
    && !!port.signal && !port.signal.aborted && canCompleteOwnedHttpPreparation(cap, request);
}
function excludeOwnedHttpGrant(cap: OwnedHttpRequest, key: string): void {
  const retry = ownedProxyInvocations?.get(cap)?.retry;
  if (!retry || typeof key !== "string" || retry.excluded.has(key) || retry.excluded.size >= MAX_GRANT_ATTEMPTS - 1) throw identityFailure("protocol");
  growOwnedHttpRequest(cap, 16 + 2 * key.length); retry.excluded.add(key);
}
function commitOwnedHttpAttempt(cap: OwnedHttpRequest): PreparedUpstream {
  const owner = ownedProxyInvocations?.get(cap), port = owner?.retry?.pending;
  if (!owner || !port || (port.phase & ~8) !== 2 || !port.prepared || !port.upload
    || !canCompleteOwnedHttpPreparation(cap)) throw identityFailure("protocol");
  port.signal!.throwIfAborted(); ownedHttpSignal(cap).throwIfAborted();
  owner.prepared = port.prepared; owner.upload = port.upload; owner.identity = port.identity; owner.archivePrepared = undefined;
  port.phase = 3 | (port.phase & 8); owner.retry!.pending = undefined;
  return port.prepared;
}
async function prepareOwnedHttpAttempt(cap: OwnedHttpRequest, request: Request, env: Env,
  selection: ProxySelection, query: ProxyQuery, signal: AbortSignal): Promise<void> {
  const invocation = ownedProxyInvocations?.get(cap), retry = invocation?.retry;
  if (!invocation?.required || invocation.retryClosed || !invocation.identity || !retry || retry.pending) throw identityFailure("protocol");
  const routing = grantRoutingPolicy(invocation.identity.policy.grantRouting);
  let firstFailure: SelectedGrantCredentialFailure | undefined;
  for (;;) {
    if (retry.next >= MAX_GRANT_ATTEMPTS) throw firstFailure ?? identityFailure("protocol");
    if (retry.excluded.size) signal.throwIfAborted();
    let units = 0, members = 0, primitives = 0;
    for (const key in invocation.required) if (Object.hasOwn(invocation.required, key)) {
      members++; units += key.length;
      const value = (invocation.required as unknown as Record<string, unknown>)[key];
      if (typeof value === "string") { primitives++; units += value.length; }
      else if (value === null || typeof value !== "object") primitives++;
    }
    for (const key of retry.excluded) units += key.length;
    growOwnedHttpRequest(cap, 8 * (2 + 2 * members + primitives + 2 * retry.excluded.size + 4) + 2 * (units + "excludedKeys".length));
    const port = retry.ports[retry.next++];
    port.phase = 1; port.signal = signal;
    port.input = { ...invocation.required, excludedKeys: Object.freeze([...retry.excluded]) as unknown as string[] };
    retry.pending = port;
    try {
      await prepareOwnedHttpProvider(cap, request, env, port.input, selection, query, true, false, signal);
      signal.throwIfAborted();
      if (!port.prepared || port.phase !== 2 || !canCompleteOwnedHttpPreparation(cap, request)) throw identityFailure("protocol");
      if (matchesOwnedHttpCompletedPreparation(cap, request, port.credential!, port.permit!)) {
        reduceOwnedHttpPreparedCredential(cap, request, port.credential!, port.permit!); port.phase |= 8;
      }
      if (!port.prepared.grantKey && retry.excluded.size && !routing.environmentFallback) throw firstFailure ?? ownedHttpError(cap, 503, "upstream_grant_pool_unavailable", "no eligible alternate grant");
      port.prepared.failedGrantKeys = port.input.excludedKeys;
      return;
    } catch (error) {
      port.phase = 4; retry.pending = undefined;
      if (isPreparationLimit(error) || isAccountingAdmissionFailure(error) || isIdentityFailure(error)) throw error;
      signal.throwIfAborted();
      if (!(error instanceof SelectedGrantCredentialFailure) || selection.provider.id === "anthropic-vertex"
        || miniMaxAnthropicRoute(selection.provider, selection.endpoint) || !routing.failover) throw firstFailure ?? error;
      firstFailure ??= error;
      if (retry.excluded.has(error.grantKey) || retry.excluded.size >= MAX_GRANT_ATTEMPTS - 1 || retry.next >= MAX_GRANT_ATTEMPTS) throw firstFailure;
      excludeOwnedHttpGrant(cap, error.grantKey);
    }
  }
}
function captureOwnedHttpRuntime(cap: OwnedHttpRequest, request: Request, env: Env,
  prepared: PreparedUpstream, selection: ProxySelection, response: Response): void {
  if (!prepared.grantKey) return;
  const selected = ownedPreparedSelections?.get(prepared); if (!selected) throw identityFailure("protocol");
  growOwnedHttpRequest(cap, 65536);
  if (response.status === 401 || response.status === 403) invalidateOwnedHttpSelectionCredentials(cap, selected);
  const state = observeProviderGrantQuota(selection.provider.id, response, selection.provider.quota, selectionUpstreamModel(selection));
  if (state) queueOwnedHttpSelectionRuntime(cap, request, env, selected, { ...state, grantRevision: prepared.grantRevision });
}

export async function prepareSelected(request: Request, env: Env, selection: ProxySelection, queryInput: ProxyQuery, auth: AuthorizedIdentity, excludedGrantKeys: ReadonlySet<string> = new Set(), recordSelection = true, resolvedConnection?: ProviderConnection, pinned?: PinnedGrant, transport: "http" | "websocket" = "http", recoverBackground = false, wan?: WanManagedOperation, searchOwner?: MiniMaxSearchOperation, video?: MiniMaxVideoOperation, signal = request.signal, reservedGrant?: PinnedGrant): Promise<PreparedUpstream> {
  // Direct prepareSelected callers are standalone preparation entries. Retain
  // the token on their selection for internal retries and subsequent calls.
  const preparation = selection.preparation ??= new PreparationAdmission();
  preparation.paths(selection.pathParams, selection.endpoint.path_param_styles);
  assertMultipartIntake(selection);
  // Fusion already materialized this owner for its reservation. Revalidate the
  // same authority first, rather than spending an uncounted fifth pool slot.
  // This preference is not a continuation pin: an ordinary credential failure
  // may still exclude it and use the remaining shared failover budget.
  const prepare = (excluded: ReadonlySet<string>) => {
    const reuseReserved = !pinned && reservedGrant && !(reservedGrant.key && excluded.has(reservedGrant.key));
    // Reservation already applied the routing policy and recorded its choice.
    // Revalidation must not advance routing again; a failed owner still allows
    // the next loop to choose and record a policy-driven alternate normally.
    return prepareSingleSelected(request, env, selection, queryInput, auth, excluded, recordSelection && !reuseReserved, resolvedConnection,
      pinned ?? (reuseReserved ? reservedGrant : undefined), transport, recoverBackground, wan, searchOwner, video, preparation, undefined, signal);
  };
  const excluded = new Set(excludedGrantKeys);
  const routing = grantRoutingPolicy(auth.policy.grantRouting);
  let firstFailure: SelectedGrantCredentialFailure | undefined;
  while (true) {
    if (excluded.size) signal.throwIfAborted();
    try {
      const prepared = await prepare(excluded);
      if (!prepared.grantKey && excluded.size && !routing.environmentFallback) throw firstFailure ?? new HttpError(503, "upstream_grant_pool_unavailable", "no eligible alternate grant");
      return excluded.size ? { ...prepared, failedGrantKeys: [...excluded] } : prepared;
    } catch (error) {
      if (isPreparationLimit(error) || isAccountingAdmissionFailure(error) || isIdentityFailure(error)) throw error;
      signal.throwIfAborted();
      if (!(error instanceof SelectedGrantCredentialFailure) || video || searchOwner || wan || wanCreate(selection.endpoint) || pinned || selection.provider.id === "anthropic-vertex" || inlineMusicInput(selection) || publishedMusicInput(selection) || openRouterPcmRequirement({ ...selection, model: selection.model?.upstream }) || isModelDiscovery(selection.endpoint) || nativeRawFormat(selection.endpoint.request_format) || isStandaloneSearch(selection.endpoint) || ["minimax.speech", "minimax.images", "minimax.music"].includes(selection.endpoint.request_format) || miniMaxAnthropicRoute(selection.provider, selection.endpoint) || !routing.failover) throw firstFailure ?? error;
      firstFailure ??= error;
      if (excluded.has(error.grantKey) || excluded.size >= MAX_GRANT_ATTEMPTS - 1) throw firstFailure;
      excluded.add(error.grantKey);
    }
  }
}

async function prepareSingleSelected(request: Request, env: Env, selection: ProxySelection, queryInput: ProxyQuery, auth: AuthorizedIdentity, excludedGrantKeys: ReadonlySet<string> = new Set(), recordSelection = true, resolvedConnection?: ProviderConnection, pinned?: PinnedGrant, transport: "http" | "websocket" = "http", recoverBackground = false, wan?: WanManagedOperation, searchOwner?: MiniMaxSearchOperation, video?: MiniMaxVideoOperation, preparation?: PreparationAdmission, owned?: { cap: OwnedHttpRequest; upstream: UpstreamAuth }, signal = request.signal): Promise<PreparedUpstream> {
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
  const stickyHash = owned ? null : await grantStickyHash(request, auth);
  try { upstream = owned ? owned.upstream : await upstreamAuth(selection.provider, auth, env, excludedGrantKeys, stickyHash, recordSelection, pinned, { provider: selection.provider, endpoint: selection.endpoint, mode: transport, model: selectionUpstreamModel(selection), managedLifecycle: !!selection.endpoint.lifecycle }, video?.controlSignal ?? searchOwner?.operation.signal ?? signal, wan, searchOwner, video, preparation); }
  catch (error) { throw error instanceof HttpError ? error : new HttpError(503, "provider_not_configured", "provider is not configured"); }
  try {
    if (compact) await assertCompactAccount(auth, env, upstream);
    if (search) await assertSingleOpenAiAccount(auth, env, upstream, "search");
    assertPolicyModel(auth.policy, selection);
    let priorTierBody = owned ? selection.body as Record<string, unknown> : undefined;
    assertServiceTier(auth, selection, upstream.transport);
    if (owned && selection.body !== priorTierBody) adoptOwnedHttpTierBody(owned.cap, priorTierBody!, selection.body as Record<string, unknown>);
    priorTierBody = undefined;
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
    if (selection.endpoint.lifecycle) assertOperationConfiguration({ provider: selection.provider, endpoint: selection.endpoint, mode: transport, managedLifecycle: true, ...(video ? { model: selection.model?.upstream } : {}) }, upstream.grant, env, preparation);
    if (backgroundRecovery) {
      assertOperationConfiguration(lifecycle, upstream.grant, env, preparation);
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
    const { headers, url, configuredOwnerUrl, requestBody, streamBody } = vertexAnthropic?.prepared ?? (owned ? prepareOwnedHttpTransport(owned.cap, request, env, selection, queryInput, upstream, preparation!)
      : prepareUpstreamRequest(request, env, selection, queryInput, upstream, transport, preparation));
    if (minimaxAnthropic) preparation?.headers(upstream.headers, true);
    minimaxAnthropic?.apply(url, headers);
    preparation?.headers(headers); preparation?.text(url.href, 16384);
    const revalidation = owned && (selection.provider.id === "gmi" || veniceChat(selection))
      ? beginOwnedHttpRevalidation(owned.cap, request, env, auth, selection, upstream, ownedProxyInvocations!.get(owned.cap)!.retry!.pending!.upload!, url, headers, preparation!) : undefined;
    const ownedGmiCheck = selection.provider.id === "gmi" && revalidation
      ? await prepareOwnedGmiOrganizationBinding(revalidation, request, env, auth, selection, upstream, url, headers) : undefined;
    const gmiCheck = selection.provider.id === "gmi" && !owned
      ? await prepareGmiOrganizationBinding(request, env, auth, selection, upstream, url, headers) : undefined;
    const discoveryCheck = gmiCheck ?? (["openai.models", REQUESTY_MODELS_FORMAT].includes(selection.endpoint.request_format) && selection.capability === "models.list"
      ? await prepareModelDiscoveryOwner(request, env, auth, selection, upstream, url, headers) : undefined);
    if (selection.provider.id === "opencode" || selection.provider.id === "opencode-go") {
      for (const name of openCodeSessionHeaders) headers.delete(name);
      const session = transport === "http" ? await openCodeSessionHeader(request, auth, selection, upstream, url) : null;
      if (session) preparationHeader(headers, session.name, session.value, preparation);
    }
    const signingRegion = !streamBody ? await signSigV4(selection.provider, url, selection.method, requestBody as string | undefined, headers, env, upstream.grant, undefined, preparation) : undefined;
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
      ? await (revalidation ? prepareOwnedVeniceChatAuthority(revalidation, env, auth, selection, upstream, url, headers)
        : prepareVeniceChatAuthority(env, auth, selection, upstream, url, headers)) : undefined;
    if (chatCheck) {
      selection.nativeResponse = prepareVeniceChatResponse(selection, chatCheck);
      if (revalidation) prepareOwnedVeniceChatCodec(revalidation, selection, selection.nativeResponse!);
    }
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
      ? await prepareMiniMaxMediaDispatch(selection, env, upstream, url, headers, auth, preparation) : undefined;
    let continuation: ContinuationOwner | undefined;
    if (selection.capability === "llm.responses" || compact || search || selection.endpoint.lifecycle || googleContinuationRoute(selection)) {
      if (upstream.grantKey && !upstream.grant?.credentialLineage && !googleContinuationRoute(selection)) throw new HttpError(503, "continuation_unavailable", "upstream credential ownership is unavailable");
      const create = compact ? selection.provider.endpoints.find(endpoint => endpoint.id === selection.provider.capabilities.find(capability => capability.id === "llm.responses")?.endpoint) : selection.endpoint;
      if (!create) throw new HttpError(503, "continuation_unavailable", "Responses creation ownership is unavailable");
      const ownerPath = compact ? upstreamPath(selection.provider, create, {}, env, upstream, preparation) : undefined;
      if (ownerPath !== undefined) preparation?.url(upstream.baseUrl, ownerPath);
      const ownerUrl = compact ? new URL(upstream.baseUrl.replace(/\/$/, "") + ownerPath) : configuredOwnerUrl;
      if (compact) upstream.query.forEach((value, name) => { preparation?.urlQuery(ownerUrl, name, value); ownerUrl.searchParams.set(name, value); });
      continuation = {
        providerId: selection.provider.id, endpointId: create.id, grantKey: upstream.grantKey,
        lineage: upstream.grant?.credentialLineage ?? null,
        // A WebSocket GET is only the handshake; both transports execute the
        // same logical Responses POST and must share continuation ownership.
        routeSha256: await responseRouteDigest(selection.provider, upstream, ownerUrl, headers, upstream.grantKey, selection.endpoint.lifecycle, env, selection.pathParams, selection.model?.upstream, preparation),
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
      ? wanCreateAuthority(env, auth, selection, upstream, configuredOwnerUrl, headers, continuation, wan, preparation) : undefined;
    return { ...(chatCheck && revalidation ? { ownedVenice: revalidation } : {}), headers, url, requestBody, grantKey: upstream.grantKey, grantLane: upstream.grantLane, grantRevision: upstream.grantRevision, connection, websocket: ["openai.responses", "openai.realtime"].includes(selection.endpoint.websocket ?? "") && upstream.transport === null, backgroundRecovery, continuation, ...(selection.endpoint.lifecycle ? { managedBaseUrl: upstream.baseUrl } : {}), ...(videoCheck ? { revalidateAccount: videoCheck } : tokenPlanCheck ? { revalidateAccount: tokenPlanCheck, revalidateDelivery: tokenPlanCheck } : wanCheck ? { revalidateAccount: wanCheck } : chatCheck ? { revalidateAccount: chatCheck.revalidate, ...(!Array.isArray(selection.body) && selection.body.stream === true ? {} : { revalidateDelivery: chatCheck.revalidate }) } : ownedGmiCheck ? { revalidateAccount: ownedGmiCheck } : discoveryCheck ? { revalidateAccount: async (signal: AbortSignal) => { await discoveryCheck(signal); }, ...(isModelDiscovery(selection.endpoint) ? { revalidateDiscovery: discoveryCheck, acquireDiscovery: () => nativeResponseLease(16 * 1024 * 1024) } : {}) } : catalogCheck ? { revalidateAccount: catalogCheck } : musicCheck ? { revalidateAccount: musicCheck.revalidate, revalidateDelivery: musicCheck.revalidate } : pcmCheck ? { revalidateAccount: pcmCheck } : vertexAnthropic ? { revalidateAccount: vertexAnthropic.revalidate } : minimaxAnthropic ? { revalidateAccount: minimaxAnthropic.revalidate } : imageCheck ? { revalidateAccount: imageCheck } : nativeMediaCheck ? { revalidateMedia: nativeMediaCheck } : compact || search ? { revalidateAccount: () => assertSingleOpenAiAccount(auth, env, upstream, search ? "search" : "compact") } : {}) };
  } catch (error) {
    throw error instanceof HttpError ? error : new HttpError(503, "provider_request_invalid", "provider request configuration is invalid");
  }
}

// The create keeps its selected key through durable waits. Metadata inspection
// never materializes a replacement secret or turns another grant into a retry.
function wanCreateAuthority(env: Env, auth: AuthorizedIdentity, selection: ProxySelection, upstream: UpstreamAuth,
  url: URL, headers: Headers, owner: ContinuationOwner, wan?: WanManagedOperation, preparation?: PreparationAdmission): (signal: AbortSignal) => Promise<void> {
  const caller = publicControlAuthorization(auth), selected = upstream.grant;
  const originalGeneration = selected?.credentialGeneration, originalLineage = selected?.credentialLineage;
  const unavailable = () => { throw new HttpError(503, "prediction_owner_unavailable", "the original Wan owner or destination is unavailable"); };
  return async signal => {
    const policy = await authorizeResponseControl(env, caller, owner, signal, undefined, wan);
    if (!policy) unavailable();
    assertPolicyModel(policy!, selection);
    const configured = configuredUpstream(selection.provider, selected, env, undefined, preparation);
    assertWanHeaders(configured.headers);
    const path = upstreamPath(selection.provider, selection.endpoint, selection.pathParams, env, configured, preparation);
    preparation?.url(configured.baseUrl, path);
    const destination = new URL(configured.baseUrl.replace(/\/$/, "") + path);
    configured.query.forEach((value, name) => { preparation?.urlQuery(destination, name, value); destination.searchParams.set(name, value); });
    if (destination.href !== url.href || await responseRouteDigest(selection.provider, configured, destination, headers,
      upstream.grantKey, selection.endpoint.lifecycle, env, selection.pathParams, undefined, preparation) !== owner.routeSha256) unavailable();
    if (upstream.grantKey) {
      const current = await inspectGrantCredentials(env, upstream.grantKey, signal, wan);
      if (!selected || !Number.isSafeInteger(originalGeneration) || !originalLineage
        || current.provider !== selected.provider || current.kind !== selected.kind || current.accountId !== selected.accountId
        || current.enabled !== true || current.revokedAt || current.credentialStatus !== "active"
        || current.credentialGeneration !== originalGeneration || current.credentialLineage !== originalLineage
        || current.updatedAt !== selected.updatedAt
        || current.expiresAt && (!Number.isFinite(Date.parse(current.expiresAt)) || Date.parse(current.expiresAt) <= Date.now())) unavailable();
      assertOperationConfiguration({ provider: selection.provider, endpoint: selection.endpoint, mode: "http", model: selection.model?.upstream, managedLifecycle: true }, current, env, preparation);
    } else {
      const current = configuredUpstream(selection.provider, null, env, undefined, preparation);
      assertWanHeaders(current.headers);
      if (current.baseUrl !== configured.baseUrl || current.query.toString() !== configured.query.toString()
        || [...current.headers].length !== [...configured.headers].length
        || [...current.headers].some(([name, value]) => configured.headers.get(name) !== value)) unavailable();
    }
    // Inspect is an await too: reject configuration movement after the earlier
    // digest check, without constructing another request or selecting a key.
    const final = configuredUpstream(selection.provider, selected, env, undefined, preparation);
    assertWanHeaders(final.headers);
    if (final.baseUrl !== configured.baseUrl || final.query.toString() !== configured.query.toString()
      || [...final.headers].length !== [...configured.headers].length
      || [...final.headers].some(([name, value]) => configured.headers.get(name) !== value)) unavailable();
    signal.throwIfAborted(); assertControlCallerLive(caller);
  };
}

export function captureGrantRuntime(context: ExecutionContext, env: Env, key: string | null, revision: string | null, quota: CompiledQuotaConfig, response: Pick<Response, "status" | "headers">, providerId?: string, model?: string | null, creditExhausted = false): void {
  if (!key) return;
  // A rejected credential must not keep serving from this isolate's cache.
  if (response.status === 401 || response.status === 403) evictGrantCredentials(key);
  const state = observeProviderGrantQuota(providerId, response, quota, model, Date.now(), creditExhausted);
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
