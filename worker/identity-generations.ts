import { identityFailure } from "./identity-admission.ts";
import { identityJsonProfiles } from "./access-json.ts";
import type { PrivateCacheVector } from "./hot-cache.ts";

// Inactive, private representation helpers. Only credential-preflight's genuine
// owner registry can supply an admission graph to the generation lifecycle.
// These helpers grant no authority and never publish a caller-supplied graph.
export interface IdentityGenerationPreparation { dispose(): void }
export interface IdentityGenerationBorrow { dispose(): void }

// These are requested facets, not an assertion that the caller owns them. Only
// credential-preflight's private slot can bind their frozen copy to a result.
export interface GenerationCoverage {
  providers: readonly { id: string; tokenRef: string }[];
  allConnections: boolean;
  snapshot?: "only" | "select";
  selection?: Readonly<import("./authority-admission.ts").AdmissionSelection>;
}
export interface GenerationAuthentication {
  dispose(): void;
  status(): number;
  code(): string | undefined;
}

// Explicit fields copied by the closed facet representation. Exclusion order
// matters, and undefined/null/pinned-environment remain distinct.
const coverageSelectionFields = ["providerId", "endpointId", "mode", "model", "catalogModelId", "capability", "sessionHash", "pinnedKey"] as const;
export function sameGenerationCoverage(owned: GenerationCoverage, required: GenerationCoverage): boolean {
  if (owned.allConnections !== required.allConnections || owned.snapshot !== required.snapshot
    || owned.providers.length !== required.providers.length) return false;
  for (let i = 0; i < owned.providers.length; i++) {
    if (owned.providers[i].id !== required.providers[i].id || owned.providers[i].tokenRef !== required.providers[i].tokenRef) return false;
  }
  const a = owned.selection, b = required.selection;
  if (!a || !b) return a === b;
  for (const key of coverageSelectionFields) if (a[key] !== b[key]) return false;
  if (!a.excludedKeys || !b.excludedKeys) return a.excludedKeys === b.excludedKeys;
  if (a.excludedKeys.length !== b.excludedKeys.length) return false;
  for (let i = 0; i < a.excludedKeys.length; i++) if (a.excludedKeys[i] !== b.excludedKeys[i]) return false;
  return true;
}

// Prospective retained layout: graph fields + the coverage owner/receipt.
// No whole-key vector, JSON text, digest, or caller graph is retained.
export function generationCoverageLayout(input: GenerationCoverage): { bytes: number; fields: number } {
  if (!Array.isArray(input.providers) || typeof input.allConnections !== "boolean"
    || input.snapshot !== undefined && input.snapshot !== "only" && input.snapshot !== "select") throw identityFailure("protocol");
  let bytes = 2 * "value,funding,cache,providers,allConnections,snapshot,selection".replaceAll(",", "").length + 1;
  let fields = 12;
  const scalar = (value: unknown): void => {
    if (typeof value === "string") bytes += 2 * value.length;
    else if (value === undefined || value === null) bytes++;
    else throw identityFailure("protocol");
  };
  scalar(input.snapshot);
  for (const provider of input.providers) {
    if (!provider || typeof provider.id !== "string" || typeof provider.tokenRef !== "string") throw identityFailure("protocol");
    bytes += 2 * ("idtokenRef".length + provider.id.length + provider.tokenRef.length); fields += 4;
  }
  const selection = input.selection;
  if (selection) {
    fields++;
    for (const key of coverageSelectionFields) { bytes += 2 * key.length; fields++; scalar(selection[key]); }
    if (typeof selection.providerId !== "string" || typeof selection.endpointId !== "string" || typeof selection.capability !== "string"
      || selection.mode !== "http" && selection.mode !== "websocket") throw identityFailure("protocol");
    bytes += 2 * "excludedKeys".length; fields++;
    if (selection.excludedKeys !== undefined) {
      if (!Array.isArray(selection.excludedKeys)) throw identityFailure("protocol");
      fields++;
      for (const key of selection.excludedKeys) { if (typeof key !== "string") throw identityFailure("protocol"); scalar(key); fields++; }
    }
  }
  if (!Number.isSafeInteger(bytes) || !Number.isSafeInteger(fields)) throw identityFailure("limit");
  return { bytes, fields };
}

export function copyGenerationCoverage(input: GenerationCoverage): GenerationCoverage {
  const providers: { id: string; tokenRef: string }[] = [];
  for (const provider of input.providers) providers.push(Object.freeze({ id: provider.id, tokenRef: provider.tokenRef }));
  const selection = input.selection && {
    providerId: input.selection.providerId, endpointId: input.selection.endpointId, mode: input.selection.mode,
    model: input.selection.model, catalogModelId: input.selection.catalogModelId, capability: input.selection.capability,
    sessionHash: input.selection.sessionHash, pinnedKey: input.selection.pinnedKey,
    excludedKeys: input.selection.excludedKeys?.slice(),
  };
  if (selection?.excludedKeys) Object.freeze(selection.excludedKeys);
  if (selection) Object.freeze(selection);
  return Object.freeze({ providers: Object.freeze(providers), allConnections: input.allConnections, snapshot: input.snapshot, selection });
}

// Worker-only phases, NOT the DO journal's 965-slot table plus imagined spare
// slots. The persistent rows remain live while the original RPC roots settle.
export const generationFactoryCharges = Object.freeze({
  persistent: Object.freeze({ registryThreeWeakMapsOwnerAndTwoChargeProducts: 6, partitionMapOwnerWeakEntryAndCharges: 5, entryMapCellOwnerAndCharges: 4,
    twoSlotFieldsAndPublicationWatermark: 3, slotOwnerChargeAndVectorReceipt: 4, demotedTemporaryOwnerField: 1, initialBorrowCharge: 2, preparationWeakEntryCapabilityAndMethod: 3,
    continuationCapabilityAndWeakEntry: 2, sourceOwnerCounterTicketWindowsAndCharge: 5 }),
  prepare: Object.freeze({ originalProofAndWeakEntry: 2, fundingAndTransferCallFrames: 12, tableVisitorAndArithmetic: 4, rollbackAndUnwind: 6 }),
  rpc: Object.freeze({ entryRunPromisesObserversAndAwaits: 18, requestPlanAndClosures: 16,
    stubIdInitHeadersAndCarrier: 8, replyHandleAndWeakEntry: 2, failureAndUnwind: 4 }),
  source: Object.freeze({ acquisitionFollowersConsumeAndAwaits: 15, headersIteratorPair: 4,
    readerAdapterMethods: 5, retirementOwnerClosuresAndProducts: 10,
    decoderWireAndBlocks: 4, listener: 2, grammarAndDescriptors: 66, terminalContinuation: 6 }),
  read: Object.freeze({ originalAndPropagatedFollowers: 10, pendingAndFinally: 6,
    pullAndAwait: 2, backingViews: 2, boundedFailure: 4 }),
  terminal: Object.freeze({ finishAndFirstCancel: 12, retirementAndOriginalJoins: 9,
    unlockAndListener: 4, unknownPromise: 2, boundedFailure: 2, unwind: 6 }),
  handoff: Object.freeze({ measurementRecordAndTwoVisitors: 3, measurementFrames: 28,
    enumerationFrames: 24, freezeFrames: 28, freezeEnumerationFrames: 24,
    numberAndIndexConversions: 2, vectorReceiptsWeakEntriesTransferAndRollbackFrames: 20,
    borrowerChargesOwnerWeakEntryCapabilityMethodAndReceipt: 7, publicationAndTransferFrames: 8,
    traversalScratchVectorOwnerLeaseCloseAndMethods: 24 }),
  hit: Object.freeze({ entryValidationAndFactoryAdmissionFrames: 8, metadataReserveOwnerAndExactCharge: 4,
    optionalAdoptionAndFitFrames: 3, demotionAndReplacementFrames: 5, replacementExactCharge: 1,
    ledgerReleaseAndPublicationFrames: 2, borrowerOwnerWeakEntryCapabilityAndMethod: 4,
    failureAndUnwindFrames: 4 }),
  retirement: Object.freeze({ borrowerLookupAndEntryFrames: 2, lastGraphOwnerAndTicketFrames: 10,
    cacheAndExactChargeReleaseFrames: 8, emptyEntryPartitionRegistryFrames: 6, protocolFailureAndUnwind: 4 }),
});

export function admitGenerationFactories(): void {
  const sum = (table: Readonly<Record<string, number>>) => { let n = 0; for (const key in table) n += table[key]; return n; };
  const persistent = sum(generationFactoryCharges.persistent);
  if (persistent + Math.max(sum(generationFactoryCharges.prepare), sum(generationFactoryCharges.rpc)) > 128
    || sum(generationFactoryCharges.source) > 128 || sum(generationFactoryCharges.read) > 128
    || sum(generationFactoryCharges.terminal) > 128
    || persistent + Math.max(sum(generationFactoryCharges.handoff), sum(generationFactoryCharges.hit), sum(generationFactoryCharges.retirement)) > 512) throw identityFailure("protocol");
}

// New consuming operations have their own inventory. The retained foundation's
// 715 total is NOT available credit. These are conservative simultaneously-live
// application factory/field ceilings, not sizeof or a native heap guarantee.
// A claimed observation includes its independently funded borrower and indexes;
// no execution record is moved into the passive DATA vector.
export const generationConsumptionFactoryCharges = Object.freeze({
  operation: Object.freeze({
    admissionVisitorAndCallFrames: 6,
    exactChargeLeaseAndReplacementProducts: 8,
    entryRunOriginalPromisesAndAwaitContinuations: 12,
    backgroundStartClosureScalarRegistrationSettlerThenAndCallbacks: 7,
    completionPromiseExecutorResolversAndImmediateBothOutcomeObserver: 7,
    originalLoadOrCohortThenCallbacksAndFollower: 4,
    cacheLoadLoaderClosureAndAsyncPromise: 4,
    publicationTokenMapAndSetCellsAndFinallyFrame: 5,
    ownPublicationPollPromisePredicateTimerExecutorResolverAndAwait: 10,
    materializeOwnerCallAndReadResponseAsyncPromisesAndAwaits: 10,
    originalFetchPromiseIdStubRequestInitHeaderCarrierAndStartClosure: 9,
    sourceBudgetWireOwnerAndResponseHandoff: 5,
    receiptAndFrozenCapabilityProducts: 4,
    registrationFailureOriginAndCleanupCallFrames: 8,
  }),
  source: Object.freeze({
    originalAcquisitionPromiseExecutorResolversObserverAndFollower: 8,
    responseBodyReaderInputOwnerAndAdapters: 8,
    sourceReadRetireClosuresAndApiProducts: 8,
    inputRetirementOwnerPromiseExecutorResolversCatchAndMethods: 10,
    headerIteratorCurrentPairAndAdmissionFrames: 5,
    textAsyncDecoderBackingAppendClosureAndWireOwner: 7,
    sourceBudgetAndParserBudgetRecords: 2,
    parserRecursiveFrames: 24,
    parserVisitorDescriptors: 48,
    sourceReplyLoadedCarrierAndFinallyFrames: 5,
  }),
  read: Object.freeze({
    originalReadPromiseActualExecutorResolversAndObserver: 7,
    inputReadPromiseExecutorResolversFinallyAndProduct: 7,
    pullStartClosureAwaitAndOutcome: 4,
    wholeBackingViewReturnedViewAndWireSlice: 4,
    decoderAppendAndWireIteratorFrames: 5,
    ackReadFailureAndSanitizedPropagation: 5,
  }),
  terminal: Object.freeze({
    finishPromiseExecutorResolversCatchAndAsyncFollower: 9,
    firstCancelPromiseExecutorResolverOriginalThenAndCallbacks: 8,
    inputRetirementOriginalReadCancelAllSettledArrayAndResults: 9,
    unlockListenerAndUnknownPendingProducts: 5,
    materializeLoadPublicationFinallyAndCompletionContinuations: 8,
    clearCommandHintSelectionAuthenticationAndBorrowFrames: 12,
    registryEntryPartitionSlotAndMetadataRetirementFrames: 14,
    independentFailureListsCellsAndAggregateProducts: 28,
    receiptResolveRejectCallbacksAndTerminalFrames: 8,
  }),
  // The phase rows below replace each other only after their last consumers
  // return. Persistent is added to EACH row, including across original awaits.
  persistent: Object.freeze({
    retainedFoundationRegistryPartitionEntrySlotOwners: 35,
    coverageOwnerReceiptAndAddedSlotFields: 11,
    authenticationOwnerCapabilityRegistryLeaseAndParentProducts: 53,
    selectionOwnerCapabilityRegistryLeaseAndWeakEntry: 21,
    hintOwnerCapabilityRegistryLeaseAndWeakEntry: 12,
  }),
  coverage: Object.freeze({
    prevalidationFrameLeasePlanAndSerializationGuardProducts: 26,
    identityPlanRecursiveFramesAndDescriptors: 72,
    coveragePlannerCopyFreezeIteratorAndReturnFrames: 18,
    coverageChargeReceiptRollbackAndHydrationCallerFrames: 16,
  }),
  authentication: Object.freeze({
    frameAndResultLeaseAdmissionProducts: 12,
    identityPlanRecordCounterMethodsClosuresAndRecursiveProducts: 80,
    effectivePolicyVisitorsAndCopyCallFrames: 30,
    lifecycleDigestModelVerdictAndHttpErrorProducts: 18,
    replacementOwnerAndRollbackProducts: 32,
  }),
  selection: Object.freeze({
    workingLeaseScratchGuardAndReplacementProducts: 16,
    plannerSelectorChooserRevisionCallbacksAndCallFrames: 28,
    prospectivePlanRecordClosuresFramesAndDescriptors: 80,
    configurationPreparationOwnerAndTerminalProducts: 38,
    profileOverlayNestedVisitorsClosuresAndCounterCarriers: 32,
    copyFreezeTraversalAndEnumerationFrames: 48,
    newOverlayOwnerMapsAndCommitFrames: 18,
    pendingRecordPreparationAndParentBorrowFrames: 20,
  }),
  runtime: Object.freeze({
    independentWorkLocalPendingLeasesAndReplacementProducts: 20,
    copyMeasurementRecursiveFramesAndLookupIntrinsicCalls: 28,
    ordinaryMergeCallbacksIteratorsAndFrames: 22,
    generatedTimestampPlannerCallbackIteratorsAndFrames: 6,
    prospectiveOverlayPlanClosuresFramesAndDescriptors: 104,
    copyFreezeTraversalAndEnumerationFrames: 48,
    replacementPendingOwnerParentIndexesAndCleanupFrames: 64,
  }),
  cohort: Object.freeze({
    // 4 * (record+11 fields, lease+exact charge 5, borrower+funding 28,
    // two ownership Map cells 4, one cohort list cell 1). Feedback is smaller.
    fourClaimedRecordsTheirParentsLeasesAndOwnershipCells: 200,
    cohortOwnerFieldsLeaseExactChargeAndParent: 46,
    twoClaimArraysFailureArrayAndReceipt: 6,
    simultaneousCallerPlanOverlayAndCommitFrames: 30,
    claimScanCursorDecisionAndValidationFrames: 12,
    independentFailureCellsAggregateAndUnwindFrames: 28,
    prospectiveEnvelopePlanClosuresAndNestedFrames: 24,
  }),
  prefetch: Object.freeze({
    capOwnerFieldsLeaseRegistryWeakEntryAndCapability: 24,
    permitRunFieldsRegistryWeakEntryAndCommand: 24,
    idAndConfigurationPlanningFrames: 16,
    retainedOriginalRequestEnvelopeAndLoaderCarrierFields: 32,
    prospectivePlanFramesAndDescriptors: 80,
    parserFreezePublicationAndFailureCallerOverlap: 32,
  }),
});
export function admitGenerationConsumptionFactories(): void {
  const sum = (table: Readonly<Record<string, number>>) => { let result = 0; for (const key in table) result += table[key]; return result; };
  const table = generationConsumptionFactoryCharges, persistent = sum(table.persistent);
  if (sum(table.operation) > 128 || sum(table.source) > 128 || sum(table.read) > 128 || sum(table.terminal) > 128
    || persistent + Math.max(sum(table.coverage), sum(table.authentication), sum(table.selection), sum(table.runtime), sum(table.cohort), sum(table.prefetch)) > 512) throw identityFailure("protocol");
}

// Metadata layout is charged independently in the common arena before its
// factories. Strings count per retained occurrence, including property names.
// Map key + entry.kid are two occurrences; no string-interning discount.
export const generationMetadata = Object.freeze({
  registry: Object.freeze({ payload: 2 * "partitions,preparations,borrowers,count,funding,cache".replaceAll(",", "").length + 8, structure: 16 }),
  partition: Object.freeze({ payload: 2 * "binding,entries,funding,cache".replaceAll(",", "").length, structure: 10 }),
  entry: Object.freeze({ payload: 2 * "partition,kid,first,second,current,sequence,publishedSequence,funding,cache".replaceAll(",", "").length + 2 * 8, structure: 19 }),
  slot: Object.freeze({ payload: 2 * ("entry,owner,continuation,handle,ready,published,borrowers,sequence,storedAt,maxAgeMs,funding,initialBorrowFunding,cache,graphCache,temporaryCharge".replaceAll(",", "").length
    + "binding,namespace,kid,digest,source,ticket,admission,bytes,text,values,containers,members,entries,units".replaceAll(",", "").length
    + "charge,worker,generationPayload,windows,unknown,operation,source,read,terminal,held".replaceAll(",", "").length
    + "serializedBytes,payloadBytes,structure".replaceAll(",", "").length
    + "charge,unknown,held,serialized,payload,fields,charge,metadata".replaceAll(",", "").length
    + "held".length) + 8 + 16 * 8 + 1 + 5 * 8, structure: 80 }),
  borrower: Object.freeze({ payload: 2 * "slot,funding,cache,dispose".replaceAll(",", "").length, structure: 10 }),
  // Charge/vector receipt fields, weak association, methods, and scalar cells.
  funding: Object.freeze({ payload: 2 * "charge,payloadBytes,structure,held,serialized,payload,fields,charge,metadata".replaceAll(",", "").length + 6 * 8, structure: 18 }),
});

// Genuine graphs are produced by the closed JSON parser: no aliases, accessors,
// symbols, hooks, arbitrary prototypes or byte views. No key vector, descriptor
// value carrier, encoding or stringify is needed to measure escaped wire bytes.
export function measureGenerationGraph(value: unknown): PrivateCacheVector {
  const vector = { serializedBytes: 0, payloadBytes: 0, structure: 0 };
  const string = (text: string) => {
    vector.payloadBytes += 2 * text.length; vector.serializedBytes += 2;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 34 || c === 92 || c === 8 || c === 9 || c === 10 || c === 12 || c === 13) vector.serializedBytes += 2;
      else if (c < 32) vector.serializedBytes += 6;
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { vector.serializedBytes += 4; i++; }
      else vector.serializedBytes += c >= 0xd800 && c <= 0xdfff ? 6 : c < 128 ? 1 : c < 2048 ? 2 : 3;
    }
  };
  const visit = (item: unknown, depth: number): void => {
    if (typeof item === "string") return string(item);
    if (item === null || typeof item === "boolean") { vector.payloadBytes++; vector.serializedBytes += item === true ? 4 : item === false ? 5 : 4; return; }
    if (typeof item === "number") { vector.payloadBytes += 8; vector.serializedBytes += Number.isFinite(item) ? String(item).length : 4; return; }
    if (!item || typeof item !== "object" || depth >= identityJsonProfiles.complete.depth) throw identityFailure("protocol");
    vector.structure++; vector.serializedBytes += 2;
    let count = 0;
    if (Array.isArray(item)) {
      for (let i = 0; i < item.length; i++) { vector.structure++; if (count++) vector.serializedBytes++; visit(item[i], depth + 1); }
    } else for (const key in item) if (Object.hasOwn(item, key)) {
      vector.structure++; if (count++) vector.serializedBytes++; string(key); vector.serializedBytes++;
      visit((item as Record<string, unknown>)[key], depth + 1);
    }
  };
  visit(value, 0);
  return vector;
}

export function freezeGenerationGraph(value: unknown, depth = 0): void {
  if (value === null || typeof value !== "object") return;
  if (depth >= identityJsonProfiles.complete.depth) throw identityFailure("protocol");
  if (Array.isArray(value)) { for (let i = 0; i < value.length; i++) freezeGenerationGraph(value[i], depth + 1); }
  else for (const key in value) if (Object.hasOwn(value, key)) freezeGenerationGraph((value as Record<string, unknown>)[key], depth + 1);
  Object.freeze(value);
}
