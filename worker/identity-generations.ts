import { identityFailure } from "./identity-admission.ts";
import { identityJsonProfiles } from "./access-json.ts";
import type { PrivateCacheVector } from "./hot-cache.ts";

// Inactive, private representation helpers. Only credential-preflight's genuine
// owner registry can supply an admission graph to the generation lifecycle.
// These helpers grant no authority and never publish a caller-supplied graph.
export interface IdentityGenerationPreparation { dispose(): void }
export interface IdentityGenerationBorrow { dispose(): void }

// Worker-only phases, NOT the DO journal's 965-slot table plus imagined spare
// slots. The persistent rows remain live while the original RPC roots settle.
export const generationFactoryCharges = Object.freeze({
  persistent: Object.freeze({ registryThreeWeakMapsOwnerAndTwoChargeProducts: 6, partitionMapOwnerWeakEntryAndCharges: 5, entryMapCellOwnerAndCharges: 4,
    twoSlotFields: 2, slotOwnerChargeAndVectorReceipt: 4, initialBorrowCharge: 2, preparationWeakEntryCapabilityAndMethod: 3,
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
});

export function admitGenerationFactories(): void {
  const sum = (table: Readonly<Record<string, number>>) => { let n = 0; for (const key in table) n += table[key]; return n; };
  const persistent = sum(generationFactoryCharges.persistent);
  if (persistent + Math.max(sum(generationFactoryCharges.prepare), sum(generationFactoryCharges.rpc)) > 128
    || sum(generationFactoryCharges.source) > 128 || sum(generationFactoryCharges.read) > 128
    || sum(generationFactoryCharges.terminal) > 128
    || persistent + sum(generationFactoryCharges.handoff) > 512) throw identityFailure("protocol");
}

// Metadata layout is charged independently in the common arena before its
// factories. Strings count per retained occurrence, including property names.
// Map key + entry.kid are two occurrences; no string-interning discount.
export const generationMetadata = Object.freeze({
  registry: Object.freeze({ payload: 2 * "partitions,preparations,borrowers,count,funding,cache".replaceAll(",", "").length + 8, structure: 16 }),
  partition: Object.freeze({ payload: 2 * "binding,entries,funding,cache".replaceAll(",", "").length, structure: 10 }),
  entry: Object.freeze({ payload: 2 * "partition,kid,first,second,current,sequence,funding,cache".replaceAll(",", "").length + 8, structure: 18 }),
  slot: Object.freeze({ payload: 2 * ("entry,owner,continuation,handle,ready,published,borrowers,sequence,storedAt,maxAgeMs,funding,initialBorrowFunding,cache,graphCache".replaceAll(",", "").length
    + "binding,namespace,kid,digest,source,ticket,admission,bytes,text,values,containers,members,entries,units".replaceAll(",", "").length
    + "charge,worker,generationPayload,windows,unknown,operation,source,read,terminal,held".replaceAll(",", "").length
    + "serializedBytes,payloadBytes,structure".replaceAll(",", "").length
    + "charge,unknown,held,serialized,payload,fields,charge,metadata".replaceAll(",", "").length) + 8 + 16 * 8 + 1 + 4 * 8, structure: 77 }),
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
