import { bodyBudgetBytes, ExactBodyCharge } from "./body-budget.ts";
import { identityFailure } from "./identity-admission.ts";

export const preflightPayloadBytes = 32 * 1024 * 1024;

// Normative application accounting, NOT object sizes or engine/physical heap.
// Wire block records/views belong to the data vector, not the control windows.
export const preflightDataVector = Object.freeze({
  sourceBytes: 2097152, sourceText: 2097152, recordBytes: 1048576,
  values: 131072, containers: 32768, members: 65536, entries: 32768,
  combined: 98304, stringUnits: 2097152, scalarUnits: 1048576,
  wireBlocks: 8192, wireViews: 8192, wireEntries: 8192, wholeBacking: 16384,
  readsIncludingEof: 8192, headerPairs: 64, headerUnits: 8192,
  derivedKeyUnits: 28646, markerUnits: 180, queryUnits: 931,
  visitorDescriptors: 48, visitorFrames: 24, indexUnits: 5, numberUnits: 64,
});

// Fixed application factory charges, in CONTROL SLOTS, not bytes or sizeof.
// A row charges every listed simultaneously-live product. Native internal heap
// objects are excluded. All four 128-slot windows are funded at ticket creation;
// enter/leave only prevents reuse while an original phase still owns its roots.
export const preflightFactoryCharges = Object.freeze({
  operation: Object.freeze({
    ticketChargeWindowsAndOwner: 4, sourceCounterAndSnapshot: 2,
    entryAsyncAndRunPromises: 2, immediateObserverCallbacksAndProduct: 3, awaitContinuations: 6,
    bindingIdAndStub: 2, requestRecordInitHeadersAndHeaderPair: 4,
    originalFetchAndAcquisitionRoot: 2, fetchThenProductCallbacksOutcome: 4,
    protocolVisitorsArraysDescriptorsAndClosedCarriers: 18,
    prospectivePlanRecordCounterAndSixClosures: 8,
    proofAndWeakEntryAndExactSuccessor: 3, continuationAndTransferReturn: 2,
    resultCarrierAndReplyCounter: 2, errorConstructorsAndThrowOutcome: 4,
  }),
  source: Object.freeze({
    ownerAcquisitionRootAndOutcome: 3, acquisitionOriginalThenAndCallbacks: 4,
    consumeWrappersAndAwaitContinuations: 10, responseHeadersIteratorPair: 4,
    bodyReaderAdapterAndTwoMethods: 5,
    retirementOwnerPromiseExecutorResolversCatchCallbackAndProduct: 8,
    retirementReadAndRetireClosures: 2, decoderAndCurrentBackingView: 2,
    abortListenerAndRegistration: 2, finalGrammarVisitorsAndDescriptors: 18,
    closedCarrierAndSevenCounterRecord: 2, sourceResultAndFinallyContinuations: 4,
  }),
  read: Object.freeze({
    originalReadPromiseResultRootThenCallbacksAndOutcome: 7,
    inputPendingPromiseExecutorResolversFinallyCallbackAndProduct: 6,
    propagatedRootThenCallbacksAndOutcome: 5, pullThunkAndAwaitContinuation: 2,
    returnedViewAndReplacementBackingView: 2,
    readFailureAndTerminalPropagationRecords: 3,
  }),
  terminal: Object.freeze({
    finishAsyncAndMemoizedPromiseAndContinuations: 5,
    firstCancelRootOriginalPromiseThenCallbacksAndOutcome: 6,
    retirementRootThenCallbacksAndOutcome: 5,
    retirementAsyncThenProductAndAllSettledPromisePairAndTwoResults: 7,
    sourceJoinAndReadJoinContinuations: 4, unlockOutcomeAndListenerRemoval: 2,
    unknownRetirementPromiseAndExecutor: 2,
    orderedOriginVectorReasonVectorAggregateAndIterator: 5,
    lateSourceOwnerAndAcquisitionJoin: 4,
    replyEncoderBytesStreamUnderlyingSourceControllerStrategyHeadersResponse: 8,
    replyPullCancelFinishCallbacksAndApiPromises: 6,
    terminalFailureAndCatchProducts: 4,
  }),
  synchronous: Object.freeze({
    sqlCursorArrayRowObjects: 43, credentialWrappersAndTheirSlots: 20,
    normalizationObjectsAndTheirSlots: 24, sevenCounterRecords: 4,
    prospectiveVisitorDescriptors: 48, prospectiveVisitorFrames: 24,
    parseScannerScratchUnitsAsDataNotSlots: 0, parseScannerFrames: 24,
    prospectivePlanRecordsAndClosures: 16,
    stageRecordAndCommitClosure: 2, transactionClosureAndFinalReplyRecord: 2,
    grammarFieldDescriptors: 14, explicitFinallyAndOutcomeScratch: 16,
  }),
});
export const preflightControlSlots = Object.freeze({ operation: 128, source: 128, read: 128, terminal: 128, synchronous: 512 });
function withinFactoryWindow(window: keyof typeof preflightFactoryCharges): boolean {
  let slots = 0;
  const table = preflightFactoryCharges[window];
  for (const name in table) slots += (table as Readonly<Record<string, number>>)[name];
  return slots <= preflightControlSlots[window];
}

type Window = "operation" | "source" | "read" | "terminal";
const generationTransferAuthority = Symbol("ready Worker ticket transfer");
interface ExactCharge { readonly bytes: number; replace(bytes: number): ExactCharge | null; release(): void }
// A DO instance has its own arena. It never funds Worker tickets and never
// borrows the Worker's common body counter. Only the Worker default below does.
export class PreflightInstanceArena {
  #held = 0;
  reserve(bytes: number): ExactCharge | null {
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > bodyBudgetBytes - this.#held) return null;
    this.#held += bytes;
    return this.#charge(bytes);
  }
  #charge(bytes: number): ExactCharge {
    const arena = this; let held = bytes;
    return {
      get bytes() { return held; },
      replace(next) {
        if (!held || !Number.isSafeInteger(next) || next <= 0 || next > bodyBudgetBytes - arena.#held + held) return null;
        const result = arena.#charge(next);
        arena.#held += next - held; held = 0;
        return result;
      },
      release() { arena.#held -= held; held = 0; },
    };
  }
  get charged(): number { return this.#held; }
}
export class PreflightTicket {
  private charge: ExactCharge;
  #worker: boolean;
  #generationPayload = 0;
  private windows = { operation: false, source: false, read: false, terminal: false };
  private unknown = false;
  private constructor(charge: ExactCharge, worker: boolean) { this.charge = charge; this.#worker = worker; }
  static reserve(arena?: PreflightInstanceArena): PreflightTicket {
    // Fixed table validation precedes the first per-ticket factory.
    if (!withinFactoryWindow("operation") || !withinFactoryWindow("source") || !withinFactoryWindow("read")
      || !withinFactoryWindow("terminal") || !withinFactoryWindow("synchronous")) throw identityFailure("protocol");
    const charge = arena ? arena.reserve(preflightPayloadBytes) : ExactBodyCharge.reserve(preflightPayloadBytes);
    if (!charge) throw identityFailure("limit");
    return new PreflightTicket(charge, !arena);
  }
  get bytes(): number { return this.charge.bytes; }
  // Used only after the originating complete-admission promise has settled.
  // A response/graph assignment is not readiness; UNKNOWN never transfers.
  get generationReady(): boolean {
    return this.charge.bytes === preflightPayloadBytes && !this.unknown
      && !this.windows.source && !this.windows.read && !this.windows.terminal && !admissionScratchHeld(this);
  }
  get generationPayload(): number { return this.#generationPayload; }
  retainGenerationComponent(bytes: number): void {
    if (!this.#worker || !this.generationReady || !Number.isSafeInteger(bytes) || bytes <= 0 || bytes > preflightPayloadBytes) throw identityFailure("protocol");
    this.#generationPayload = bytes;
  }
  transferGeneration(bytes: number): GenerationRetainedCharge | null {
    if (!this.#worker || !this.generationReady) throw identityFailure("protocol");
    // replace invalidates the original charge. The successor is NEVER installed
    // in this ticket: an old dispose/release cannot retire the retained owner.
    const next = this.charge.replace(bytes);
    if (!next) return null;
    retireAdmissionScratch(this);
    this.#generationPayload = 0;
    this.windows.operation = false;
    return GenerationRetainedCharge.fromReadyWorker(next, generationTransferAuthority);
  }
  enter(window: Window): void {
    if (!this.charge.bytes || this.windows[window]) throw identityFailure("protocol");
    this.windows[window] = true;
  }
  leave(window: Window): void { this.windows[window] = false; }
  holdUnknown(): void { this.unknown = true; }
  // The caller must first join original roots and clear the retired component
  // references. This is a transfer of actual existing credit, not reacquisition.
  retainProof(bytes: number): void {
    if (this.unknown || this.windows.source || this.windows.read || this.windows.terminal
      || bytes >= 1024 * 1024) throw identityFailure("protocol");
    const next = this.charge.replace(bytes);
    if (!next) throw identityFailure("limit");
    this.charge = next;
  }
  expandForContinuation(): void {
    if (this.unknown || this.windows.source || this.windows.read || this.windows.terminal) throw identityFailure("protocol");
    const next = this.charge.replace(preflightPayloadBytes);
    if (!next) throw identityFailure("limit");
    this.charge = next;
  }
  release(): void {
    if (this.unknown || this.windows.source || this.windows.read || this.windows.terminal || admissionScratchHeld(this)) return;
    this.windows.operation = false;
    this.charge.release();
    this.#generationPayload = 0;
  }
}

export class GenerationRetainedCharge {
  private charge: ExactCharge;
  private unknown = false;
  private constructor(charge: ExactCharge) { this.charge = charge; }
  // The only factory call is the provenance-checked ticket transfer above.
  static fromReadyWorker(charge: ExactCharge, authority: symbol): GenerationRetainedCharge {
    if (authority !== generationTransferAuthority) throw identityFailure("protocol");
    return new GenerationRetainedCharge(charge);
  }
  get bytes(): number { return this.charge.bytes; }
  holdUnknown(): void { this.unknown = true; }
  expandForBorrow(): boolean {
    if (this.unknown || !this.charge.bytes) return false;
    // Reuse this exclusive Worker backing. Failure leaves the old debit intact;
    // no source credit is released before the full temporary owner exists.
    const next = this.charge.replace(preflightPayloadBytes);
    if (!next) return false;
    this.charge = next;
    return true;
  }
  release(): void { if (!this.unknown) this.charge.release(); }
}

// Small construction/index/borrower products have real exact common-arena
// backing, independently of the 32 MiB source ticket. No grow() floor/doubling.
// A cache-vector receipt may account this SAME funding without reacquiring it.
export class GenerationMetadataCharge {
  private charge: ExactBodyCharge;
  readonly payloadBytes: number;
  readonly structure: number;
  private constructor(charge: ExactBodyCharge, payloadBytes: number, structure: number) {
    this.charge = charge; this.payloadBytes = payloadBytes; this.structure = structure;
  }
  static reserve(payloadBytes: number, structure: number): GenerationMetadataCharge {
    if (!Number.isSafeInteger(payloadBytes) || payloadBytes <= 0 || !Number.isSafeInteger(structure) || structure <= 0) throw identityFailure("protocol");
    const charge = ExactBodyCharge.reserve(payloadBytes);
    if (!charge) throw identityFailure("limit");
    return new GenerationMetadataCharge(charge, payloadBytes, structure);
  }
  get bytes(): number { return this.charge.bytes; }
  release(): void { this.charge.release(); }
}

// A promoted ticket has zero payload credit. Every new consuming operation
// therefore acquires independent, positive COMMON Worker backing. Neither the
// DO arena nor an optional cache-coordinate receipt can create this lease.
export class GenerationConsumptionLease {
  private charge: ExactBodyCharge;
  private unknown = false;
  private constructor(charge: ExactBodyCharge) { this.charge = charge; }
  static reserve(bytes: number): GenerationConsumptionLease {
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > preflightPayloadBytes) throw identityFailure("limit");
    const charge = ExactBodyCharge.reserve(bytes);
    if (!charge) throw identityFailure("limit");
    return new GenerationConsumptionLease(charge);
  }
  get bytes(): number { return this.charge.bytes; }
  // Absolute complete simultaneous payload. Caller clears aliases before any
  // shrink; failed growth preserves this owner's exact debit and obligations.
  replace(bytes: number): void {
    if (this.unknown || !this.charge.bytes || !Number.isSafeInteger(bytes) || bytes <= 0 || bytes > preflightPayloadBytes) throw identityFailure("limit");
    const successor = this.charge.replace(bytes);
    if (!successor) throw identityFailure("limit");
    this.charge = successor;
  }
  holdUnknown(): void { this.unknown = true; }
  release(): void { if (!this.unknown) this.charge.release(); }
}

// NEW private bridge policy only. Existing PR974 factory/data accounting above
// does not use this map or acquire scratch leases. These are normative logical
// cells/units, never sizeof, native allocation or source-budget credit.
export interface AdmissionScratchVector { C: number; P: number; N: number; U: number; B: number }
export interface AdmissionScratchLease {
  readonly bytes: number;
  admit(vector: AdmissionScratchVector): void;
  retire(): void;
  retain(remaining?: AdmissionScratchVector): void;
  holdUnknown(): void;
}
type AdmissionScratchOwner = { base: number; active: number; retained: number; leases: number; unknown: boolean };
const admissionScratch = new WeakMap<PreflightTicket, AdmissionScratchOwner>();
export function admissionScratchBytes(vector: AdmissionScratchVector): number {
  if (!Number.isSafeInteger(vector.C) || vector.C < 0 || !Number.isSafeInteger(vector.P) || vector.P < 0
    || !Number.isSafeInteger(vector.N) || vector.N < 0 || !Number.isSafeInteger(vector.U) || vector.U < 0
    || !Number.isSafeInteger(vector.B) || vector.B < 0) throw identityFailure("protocol");
  const bytes = 8 * (vector.C + vector.P + vector.N) + 2 * vector.U + vector.B;
  if (!Number.isSafeInteger(bytes)) throw identityFailure("limit");
  return bytes;
}

// Closed prospective JSON plans already count every occurrence, including
// aliases. Counting ALL values as primitive occurrences is a conservative N
// bound; no traversal/copy or equality-based string discount occurs here.
export function admissionGraphPayload(counts: { containers: number; members: number; entries: number; values: number; units: number }): number {
  return admissionScratchBytes({ C: counts.containers, P: 2 * counts.members + counts.entries,
    N: counts.values, U: counts.units, B: 0 });
}
function admissionScratchHeld(ticket: PreflightTicket): boolean {
  const owner = admissionScratch.get(ticket);
  return !!owner && (owner.unknown || owner.leases > 0 || owner.retained > 0);
}
// Caller is a closed private factory site with a complete prospective vector.
// It must keep the referenced input/result graph under this SAME full ticket.
// All executions, iterators, callbacks, lease products and journal ownership
// remain CONTROL; no arbitrary values are traversed/reclassified by this API.
export function reserveAdmissionScratch(ticket: PreflightTicket, base: number, vector: AdmissionScratchVector): AdmissionScratchLease {
  let bytes = admissionScratchBytes(vector);
  if (!Number.isSafeInteger(base) || base < 0) throw identityFailure("protocol");
  if (ticket.bytes !== preflightPayloadBytes) throw identityFailure("protocol");
  let owner = admissionScratch.get(ticket);
  const held = owner ? owner.active + owner.retained : 0;
  // Retained/active borrowers prohibit reducing their already admitted base.
  // New generation metadata remains an explicit simultaneous COMPONENT of the
  // same 32 MiB payload, never passive DATA or free CONTROL. Ordinary tickets
  // have zero here; their admission and scratch behavior is unchanged.
  const requestedBase = base + ticket.generationPayload;
  const completeBase = held ? Math.max(requestedBase, owner!.base) : requestedBase;
  if (owner?.unknown || completeBase > preflightPayloadBytes - held - bytes) throw identityFailure("limit");
  if (!owner) { owner = { base: completeBase, active: 0, retained: 0, leases: 0, unknown: false }; admissionScratch.set(ticket, owner); }
  owner.base = completeBase; owner.active += bytes; owner.leases++;
  let live = true;
  const close = (retained: number) => {
    if (!live) throw identityFailure("protocol");
    live = false; owner!.active -= bytes; owner!.leases--;
    owner!.retained += retained;
  };
  return Object.freeze({ get bytes() { return bytes; },
    admit(next: AdmissionScratchVector) {
      if (!live || owner!.unknown) throw identityFailure("protocol");
      const required = admissionScratchBytes(next);
      if (required <= bytes) return;
      if (owner!.base + owner!.active + owner!.retained + required - bytes > preflightPayloadBytes) throw identityFailure("limit");
      owner!.active += required - bytes; bytes = required;
    },
    retire() { close(0); },
    retain(remaining?: AdmissionScratchVector) {
      const next = remaining ? admissionScratchBytes(remaining) : bytes;
      if (next > bytes) throw identityFailure("protocol");
      // Atomic shrink/transfer only after the original larger components clear.
      // The successor never passes through an unfunded release/reacquire gap.
      close(next);
    },
    holdUnknown() { if (!live) throw identityFailure("protocol"); owner!.unknown = true; ticket.holdUnknown(); },
  });
}
// Explicit owner handoff boundary: call only AFTER all retained scratch/data
// aliases are cleared. Active/UNKNOWN borrowers never receive release credit.
export function retireAdmissionScratch(ticket: PreflightTicket): void {
  const owner = admissionScratch.get(ticket);
  if (!owner) return;
  if (owner.unknown || owner.leases) return;
  owner.retained = 0; admissionScratch.delete(ticket);
}

// Closed private owner boundary, after every previous graph/journal alias has
// actually cleared. Preserve funding atomically for the outgoing representation;
// no release/reacquire and no reuse while an active/UNKNOWN borrower remains.
export function transferAdmissionScratch(ticket: PreflightTicket, vector: AdmissionScratchVector): void {
  const bytes = admissionScratchBytes(vector), owner = admissionScratch.get(ticket);
  if (ticket.bytes !== preflightPayloadBytes || owner?.unknown || owner?.leases) throw identityFailure("protocol");
  if (bytes > preflightPayloadBytes) throw identityFailure("limit");
  if (owner) { owner.base = 0; owner.retained = bytes; }
  else admissionScratch.set(ticket, { base: 0, active: 0, retained: bytes, leases: 0, unknown: false });
}

// PRIVATE bridge inventory. Entries are application control charges, not byte
// sizes. Parsed JSON fields/arrays and wire-block records have separate finite
// DATA vectors; the typed effect journal is charged here, including its indexes.
export const admissionBridgeFactoryCharges = Object.freeze({
  operation: Object.freeze({
    ticketChargeWindowsOwnerAndSource: 6, entryRunAndObserverProductsCallbacks: 12,
    bindingIdStubInitHeadersAndPairs: 8, closedCarriersAndPrivateHandleWeakEntry: 6,
    hydrationStoreAndItsCallbacks: 20, hydrationAwaitContinuations: 12,
    finalTransactionCallbackAndDecision: 4, hashOriginalsFollowersCallbacksOutcomesAndLeaseJoin: 16,
    recordReadLeaseAsyncAndFinally: 4,
    planRecordsAndClosures: 16, comparatorFrames: 24,
  }),
  source: Object.freeze({
    ownerAcquisitionFollowerCallbacksAndOutcome: 7, consumeAsyncAwaitAndCloseCallback: 8,
    responseHeadersIteratorAndPair: 4, readerAdapterMethods: 5,
    inputRetirementOwnerExecutorResolversCatchProductsAndClosures: 10,
    decoderBackingWireOwnerAndBlockArray: 4, signalListenerAndRegistration: 2,
    grammarVisitorsAndClosedCarriers: 18, prospectiveDescriptors: 48,
    sourceResultAndTerminalContinuations: 6,
  }),
  read: Object.freeze({
    originalFollowerCallbacksAndSanitizedOutcome: 5, propagatedOriginalObserverCallbacks: 5,
    inputPendingExecutorResolversFinallyProducts: 6, readAwaitAndPullThunk: 2,
    viewAndBackingReplacement: 2, boundedFailureAndCategoryScratch: 4,
    generatedVisitorClosuresAndFrames: 36, normalizedRecordScratchAndIterators: 24,
  }),
  terminal: Object.freeze({
    finishOriginalAndContinuationProducts: 6, firstCancelFollowerCallbacksOutcome: 6,
    retirementObserverProductsAndOutcome: 5, originalReadAndFirstCancelJoinContinuations: 4,
    unlockListenerRemovalAndCategoryScratch: 4, unknownHoldPromiseExecutor: 2,
    fixedFailureRecordAndError: 2, outboundEncoderBytesByteStreamControllerHeadersResponse: 8,
    pullCancelFinishCallbacksAndDiscardedApiPromises: 6,
    finalPlanVisitorRecordsAndClosures: 16, producerHandoffAndFinally: 6,
    bridgeTransferVectorAndOwnerFields: 14,
  }),
  synchronous: Object.freeze({
    journalArrayAndOwner: 2, journalEntries: 231, journalIndexSlots: 231,
    sqlCursorArrayRowAtOneProbe: 3, finalWrappersAndResultOwners: 12,
    seedAndProjectionScratch: 6, selectionPlanChoiceCursorTimeAttempted: 8,
    historyFoldCursorRowAndAccumulator: 4, markerAndExecutorIterators: 4,
    dependencyReceiptReplacementAndFinalProbe: 2,
    finalSegmentFrameProviderIteratorLoopAndUnwind: 4,

  }),
});
// The original source/read roots are joined before this synchronous window is
// reused. Passive choice/quota/configuration vectors now require a separate
// prospective D reservation inside the SAME ticket; none are free CONTROL.
export const admissionBridgeChoiceFactoryCharges = Object.freeze({
  source: Object.freeze({
    scratchVectorGuardWeakOwnerLeaseCloseAndMethods: 24,
    nestedScratchVectorLeaseCloseAndMethods: 16,
    preparationOwnerAndScalarState: 14,
    choiceRequirementFilterResultAndRecoveryOwners: 5,
    selectorChooseLoadCompleteAndRevisionCallbacks: 8,
    singletonFilterAndQuotaCallbacks: 8,
    liveArraySetAndGeneratorIterators: 8,
    preparationTextCsvTemplateAndHeaderCallbacks: 16,
    canonicalMaterializeGuardLeaseCloseVectorAndCallback: 24,
  }),
  read: Object.freeze({
    prospectivePlanRecordsCountersAndClosures: 16,
    prospectiveDescriptorsAndFrames: 72,
    bindingViewAndBoundedDescriptors: 7,
    headersUrlDateRandomViewAndRegExpProducts: 8,
    selectedAndStrategyResultOwners: 4,
    preparationAndIdentityFailureProducts: 4,
    generatedOutputTransferVectors: 12,
    canonicalSelectAndHistoryFoldCallbacks: 3,
    dependencyCaptureCallAndFinalProbeFrame: 2,
  }),
});
// Sequential private phases: these do NOT add a fifth live window. Principal
// hydration finishes before its cold await; snapshot output reservation transfers
// before selector factories; final projection comparison follows the last await.
// Their retained DATA is still charged concurrently with every later phase.
export const admissionBridgeBoundaryFactoryCharges = Object.freeze({
  source: Object.freeze({ scratchVectorGuardOwnerLeaseCloseAndMethods: 24,
    nestedCanonicalValueLeaseAndCallback: 24, metadataCursorArrayRow: 3,
    valueCursorArrayRow: 3, principalTransformAndRegExpProducts: 4,
    snapshotPlannerIteratorAndArithmeticFrames: 6, snapshotCursorOccurrenceAdmission: 2, finalProbeCallAndComparison: 4 }),
  read: Object.freeze({ planRecordsCountersAndClosures: 16,
    prospectiveDescriptorsAndFrames: 72, parseScannerAndOriginalValueFrames: 24,
    finalDependencyIteratorAndOutcome: 4 }),
});
// Prevalidation completes before copy/RPC and before the continuation transfers.
// Native accessor lookups construct no JS data-value descriptor. Three captured
// intrinsic references/call operands stay CONTROL; the fixed argument array and
// string occurrence are separately funded DATA. No callback graph is retained.
export const admissionBridgeSerializationFactoryCharges = Object.freeze({
  source: Object.freeze({ scratchVectorGuardOwnerLeaseCloseAndMethods: 24,
    visitorAndRecursiveCallFrames: 26, activeDataDescriptors: 24,
    ownPropertyIterators: 24, capturedIntrinsicReferences: 3, intrinsicCallAndPredicateFrames: 2, failureUnwindAndWindowProducts: 6 }),
});
// Worker pre-copy string-field pass, BEFORE source acquisition. It borrows the
// otherwise idle prepaid source window and clears all metadata before the string-keyed carrier.
// The original copy lease remains active until all request aliases clear.
export const admissionBridgeCopyFactoryCharges = Object.freeze({
  source: Object.freeze({ copyVector: 1, enumerationIterator: 1, copyLoopFrame: 1,
    helperAdmissionAndArithmeticFrames: 3, failureAndUnwindProducts: 2 }),
});
// Passive examples are explicit occurrence vectors, not a hidden control
// exemption. Guard/lease products above remain CONTROL. The selector funds the
// simultaneous sum; MAX reuse is allowed only after its actual last consumer.
export const admissionBridgePassiveExamples = Object.freeze({
  choices: Object.freeze({ C: 99, P: 686, N: 196, U: 102606, B: 0 }),
  quotaReset: Object.freeze({ C: 2, P: 256, N: 128, U: 0, B: 0 }),
  quotaRatio: Object.freeze({ C: 2, P: 129, N: 129, U: 0, B: 0 }),
});
export function admitBridgeFactories(): void {
  for (const key in admissionBridgeFactoryCharges) {
    const window = key as keyof typeof admissionBridgeFactoryCharges;
    let count = 0;
    const table: Readonly<Record<string, number>> = admissionBridgeFactoryCharges[window];
    for (const name in table) count += table[name];
    if (count > preflightControlSlots[window]) throw identityFailure("limit");
  }
  for (const key in admissionBridgeSerializationFactoryCharges) {
    const window = key as keyof typeof admissionBridgeSerializationFactoryCharges;
    const table: Readonly<Record<string, number>> = admissionBridgeSerializationFactoryCharges[window];
    let count = 0; for (const name in table) count += table[name];
    if (count > preflightControlSlots[window]) throw identityFailure("limit");
  }
  for (const key in admissionBridgeBoundaryFactoryCharges) {
    const window = key as keyof typeof admissionBridgeBoundaryFactoryCharges;
    const table: Readonly<Record<string, number>> = admissionBridgeBoundaryFactoryCharges[window];
    let count = 0; for (const name in table) count += table[name];
    if (count > preflightControlSlots[window]) throw identityFailure("limit");
  }
  for (const key in admissionBridgeChoiceFactoryCharges) {
    const window = key as keyof typeof admissionBridgeChoiceFactoryCharges;
    const table: Readonly<Record<string, number>> = admissionBridgeChoiceFactoryCharges[window];
    let count = 0; for (const name in table) count += table[name];
    if (count > preflightControlSlots[window]) throw identityFailure("limit");
  }
}

export function admitBridgeCopyFactories(): void {
  let count = 0;
  const table: Readonly<Record<string, number>> = admissionBridgeCopyFactoryCharges.source;
  for (const key in table) count += table[key];
  if (count > preflightControlSlots.source) throw identityFailure("limit");
}

// Named component bounds. These are NOT an aggregate fit declaration. Each
// factory also admits its actual retained base plus simultaneous scratch. In
// particular journal texts survive serialization/commit, and both hashes join
// before their phase credit can be reused by post-hash canonical work.
export const admissionBridgePhasePayload = Object.freeze({
  workerReply: Object.freeze({ admittedRepresentations: 16793600, flatten: 4194304, decodedChunk: 32768 }),
  hashes: Object.freeze({ prefixedStringsAndOriginalEncodedInputs: 6291507,
    twoDigestBackings: 64, twoHexNumericAndStringVectors: 1824, twoHexResults: 256 }),
  defaultKeysBeforeRepair: Object.freeze({ rejectedBorrowedComponentsOnly: 6291500 }),
});
