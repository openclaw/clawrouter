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
  private windows = { operation: false, source: false, read: false, terminal: false };
  private unknown = false;
  private constructor(private charge: ExactCharge) {}
  static reserve(arena?: PreflightInstanceArena): PreflightTicket {
    // Fixed table validation precedes the first per-ticket factory.
    if (!withinFactoryWindow("operation") || !withinFactoryWindow("source") || !withinFactoryWindow("read")
      || !withinFactoryWindow("terminal") || !withinFactoryWindow("synchronous")) throw identityFailure("protocol");
    const charge = arena ? arena.reserve(preflightPayloadBytes) : ExactBodyCharge.reserve(preflightPayloadBytes);
    if (!charge) throw identityFailure("limit");
    return new PreflightTicket(charge);
  }
  get bytes(): number { return this.charge.bytes; }
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
    if (this.unknown || this.windows.source || this.windows.read || this.windows.terminal) return;
    this.windows.operation = false;
    this.charge.release();
  }
}
