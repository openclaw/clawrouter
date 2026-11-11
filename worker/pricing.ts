import type { DeepSeekSearchRequestPricing } from "../shared/request-pricing.ts";
import type { ValidatedNativeUsage } from "./native-response.ts";
import { actualImageCost, estimateImageCost } from "./image-generation.ts";
import { googleImageRequest } from "./google-image-classification.ts";
import { googleAudioRequest } from "./google-audio-classification.ts";
import { jsonBodyBytes, privateArchiveWorkspaceBytes } from "./json-body.ts";
import { claudeImageBlockBound, type InlineImageBound } from "./image-input-bound.ts";
import type { CharacterPricing, CompiledEndpoint, ModelPricing, ServiceTierPricing, TokenPricing, TokenRates } from "./types";
import { googleField, googleInt32, googleRequestServiceTier, googleServiceTier } from "./google-protocol.ts";
import { retainedToolBase, type ToolKnowledge } from "./responses-tool-evidence.ts";
import type { ToolPricing } from "./types";
import type { XaiImageRequest } from "./xai-images.ts";
import { ExactBodyCharge } from "./body-budget.ts";
import { growOwnedHttpRequest, type OwnedHttpRequest } from "./http-identity-owner.ts";
import { matchesOwnedHttpPricingInput, ownedHttpHasToolPriceCard, ownedHttpMayDefaultServiceTier } from "./proxy.ts";
import { identityFailure } from "./identity-admission.ts";

interface OwnedHttpPricingPlan {
  body?: Record<string, unknown>;
  bytes: number;
  media: boolean;
  hour: boolean;
  cache: boolean;
  serializationBytes: number;
  mediaWorkspaceBytes: number;
  serializationCredits: number;
  mayDefaultTier: boolean;
  revision: number;
  retentionBytes: number;
  archiveCredits: number;
  toolScratchBytes: number;
  active: boolean;
}
interface OwnedHttpPricingWork extends OwnedHttpPricingPlan {
  queueCapacity: number;
  keyVectorBytes: number;
  slotBytes: number;
  mediaUnits: number;
  mediaSlots: number;
  graphBytes: number;
  maximumDepth: number;
  maximumScalarUnits: number;
}
let ownedPricing: WeakMap<OwnedHttpRequest, OwnedHttpPricingPlan> | undefined;
let activeOwnedPricing: WeakMap<object, OwnedHttpPricingPlan> | undefined;
let ownedPricingRegistry: ExactBodyCharge | undefined;
let ownedPricingCount = 0;
const ownedPricingMetadataBytes = 4096;
const ownedPricingArray = Array.isArray;
const ownedPricingOwn = Object.hasOwn;
function ownedPricingObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !ownedPricingArray(value);
}
// Existing accounting JSON profiles, expressed with the adopted DATA formula.
// These fund copies/serialization; accounting API/visitor products are CONTROL.
const ownedAccountingCapsuleBytes = 8 * (128 + 2 * 512 + 256 + 1024) + 2 * 32768;
const ownedAccountingIntentBytes = 8 * (64 + 2 * 128 + 64 + 256) + 2 * 8192;
const ownedAccountingBytes = 9 * ownedAccountingCapsuleBytes + 8 * ownedAccountingIntentBytes
  + 4 * 3 * 16384 + 3 * 65536;

// Only the compiled HTTP invocation's actual transformed Chat body can enter.
// Preparation runs before admission/selection effects. A synchronous activation
// later covers one existing accounting/pricing call, never an async interval.
export function prepareOwnedHttpPricing(cap: OwnedHttpRequest, body: Record<string, unknown>): void {
  if (!matchesOwnedHttpPricingInput(cap, body) || ownedPricing?.has(cap)) throw identityFailure("protocol");
  growOwnedHttpRequest(cap, ownedPricingMetadataBytes + 8); // Fixed products plus one paid variable-CONTROL queue container.
  const plan: OwnedHttpPricingWork = { body, bytes: 0, media: false, hour: false, cache: false, queueCapacity: 0,
    keyVectorBytes: 0, slotBytes: 8, mediaUnits: 0, mediaSlots: 0, serializationBytes: 0, mediaWorkspaceBytes: 0,
    serializationCredits: 0, mayDefaultTier: ownedHttpMayDefaultServiceTier(cap, body), revision: 0,
    graphBytes: 0, maximumDepth: 0, maximumScalarUnits: 0, retentionBytes: 0, archiveCredits: 0, toolScratchBytes: 0, active: false };
  const pending: object[] = [];
  let retained: OwnedHttpPricingPlan | undefined;
  try {
    measureOwnedHttpJson(cap, plan, body, pending);
    // The marker transaction retains an extra marker field/value per locator.
    // Its UUID prefix and at most16 decimal index units are admitted per actual
    // locator, not as a maximum-locator reservation on every request.
    plan.mediaWorkspaceBytes = 8 * (1 + plan.queueCapacity) + plan.slotBytes;
    const scan = plan.keyVectorBytes + plan.slotBytes;
    // The existing media serializer first scans key vectors/slot records. It
    // either returns null BEFORE whole JSON text, or builds pieces BEFORE a
    // streaming closure exists. Only pieces are captured by that closure.
    const serialize = plan.mediaUnits < 1024 * 1024 ? 3 * plan.bytes
      : Math.max(plan.slotBytes + 5 * plan.bytes + 2 * plan.mediaUnits + 272 * plan.mediaSlots + 1024,
        plan.bytes + 4 * plan.mediaUnits + 16 * plan.mediaSlots + 16 + 524288);
    plan.serializationBytes = 8 * (1 + plan.queueCapacity) + Math.max(scan, serialize);
    // Policy is not yet authenticated here. Fund the possible detached archive
    // before admission's initial choice: full body graph, one live scalar
    // descriptor, bounded record/key metadata, and the 32 KiB streaming path.
    // A later retain=false verdict never turns this credit into another owner.
    plan.retentionBytes = plan.graphBytes + privateArchiveWorkspaceBytes(plan.graphBytes, plan.maximumDepth)
      + 2 * plan.maximumScalarUnits + 81920 + 8192 + 262144;
    plan.toolScratchBytes = ownedToolScratchBytes(body, ownedHttpHasToolPriceCard(cap, body), plan.bytes);
    if (plan.mayDefaultTier) {
      // Existing assertServiceTier may create one additional shallow root.
      // Before selection effects, retain every spread occurrence plus the
      // temporary replacement value. Nested objects keep their source owner.
      growOwnedHttpRequest(cap, ownedTierRootBytes(body));
      // Appending service_tier:"default" adds at most25 wire bytes. Include
      // the larger five-W serializer branch, the root key-vector increment,
      // graph/scalar retention delta and the existing two-W tool allowance.
      plan.serializationBytes += 5 * 25 + 40;
      plan.retentionBytes += 62 + 14;
      plan.toolScratchBytes += 2 * 25;
    }
    plan.media = body.previous_response_id != null || body.conversation != null || body.prompt != null;
    if (!plan.media && body.input != null) plan.media = ownedContentHasMedia(cap, plan, body.input, pending);
    if (!plan.media && ownedPricingArray(body.messages)) {
      for (let index = 0; index < body.messages.length && !plan.media; index++) {
        const message = body.messages[index];
        if (ownedPricingObject(message)) plan.media = ownedContentHasMedia(cap, plan, message.content, pending);
      }
    }
    if (!plan.media && ownedPricingArray(body.tools)) {
      for (let index = 0; index < body.tools.length && !plan.media; index++) {
        const tool = body.tools[index];
        if (ownedPricingObject(tool)) plan.media = providerAddedTool(tool.type);
      }
    }
    if (!ownedPricing) {
      const charge = ExactBodyCharge.reserve(512);
      if (!charge) throw identityFailure("limit");
      try { ownedPricing = new WeakMap(); activeOwnedPricing = new WeakMap(); ownedPricingRegistry = charge; }
      catch (error) { ownedPricing = undefined; activeOwnedPricing = undefined; charge.release(); throw error; }
    }
    retained = { body, bytes: plan.bytes, media: plan.media, hour: plan.hour, cache: plan.cache,
      serializationBytes: plan.serializationBytes, mediaWorkspaceBytes: plan.mediaWorkspaceBytes, serializationCredits: 0,
      mayDefaultTier: plan.mayDefaultTier, revision: 0, retentionBytes: plan.retentionBytes, archiveCredits: 0, toolScratchBytes: plan.toolScratchBytes, active: false };
    ownedPricing.set(cap, retained); ownedPricingCount++;
  } catch (error) {
    if (retained) retained.body = undefined;
    if (!ownedPricingCount) {
      ownedPricing = undefined; activeOwnedPricing = undefined;
      const charge = ownedPricingRegistry; ownedPricingRegistry = undefined; charge?.release();
    }
    throw error;
  }
  finally {
    // Variable traversal CONTROL ends only after all queued source aliases
    // clear. Its executing frame/locals/arguments remain fixed CONTROL.
    pending.length = 0; plan.body = undefined; retained = undefined;
  }
}

// Every attempt gets a positive component before selection can count. The
// original serializer is unchanged; this command publishes no body/plan getter.
export function reserveOwnedHttpSerialization(cap: OwnedHttpRequest, body: Record<string, unknown>): void {
  const plan = ownedPricing?.get(cap);
  if (!plan || plan.body !== body || !matchesOwnedHttpPricingInput(cap, body)) throw identityFailure("protocol");
  growOwnedHttpRequest(cap, plan.serializationBytes + plan.retentionBytes + plan.toolScratchBytes + ownedAccountingBytes);
  plan.archiveCredits++; plan.serializationCredits++;
}

function ownedTierRootBytes(body: Record<string, unknown>): number {
  let members = 0, primitives = 0, units = 0;
  for (const key in body) if (ownedPricingOwn(body, key)) {
    members++; units += key.length;
    const value = body[key];
    if (value === null || typeof value !== "object") primitives++;
    if (typeof value === "string") units += value.length;
  }
  return 8 * (1 + 2 * members + primitives) + 2 * units
    + (ownedPricingOwn(body, "service_tier") ? 0 : 16 + 24) + 8 + 14;
}
// Called immediately after the unchanged resolved-transport tier helper. The
// old root is still a caller binding and retains its original funding.
export function adoptOwnedHttpTierBody(cap: OwnedHttpRequest, before: Record<string, unknown>, after: Record<string, unknown>): void {
  const plan = ownedPricing?.get(cap);
  if (!plan || plan.body !== before || plan.active || !plan.mayDefaultTier || plan.revision
    || !matchesOwnedHttpPricingInput(cap, after) || after.service_tier !== "default") throw identityFailure("protocol");
  const raw = before.service_tier;
  if (!(raw == null || typeof raw === "string" && raw.toLowerCase() === "auto")) throw identityFailure("protocol");
  const previous = ownedPricingOwn(before, "service_tier") ? ownedScalarJsonBytes(raw) : -1;
  let other = false;
  for (const key in before) if (key !== "service_tier" && ownedPricingOwn(before, key) && ownedScalarJsonBytes(before[key]) >= 0) { other = true; break; }
  const delta = previous < 0 ? 24 + (other ? 1 : 0) : 9 - previous;
  // No await, allocation, reservation or callback separates these publications.
  // The real extra root and the maximum serialization delta were paid earlier.
  plan.bytes += delta; plan.body = after; plan.revision = 1;
}
export function takeOwnedHttpMediaAdmission(cap: OwnedHttpRequest, body: Record<string, unknown>): import("./json-body.ts").PrivateMediaAdmission {
  const plan = ownedPricing?.get(cap);
  if (!plan || plan.body !== body || !plan.serializationCredits || !matchesOwnedHttpPricingInput(cap, body)) throw identityFailure("protocol");
  plan.serializationCredits--;
  return { workspaceBytes: plan.mediaWorkspaceBytes, serializationBytes: plan.serializationBytes, restorePending: false };
}

// No extra debit or new profile: each actual serialization reservation already
// pays one complete possible archive before selection. The fixed caller consumes
// that right once; disabled/unused retention never releases it for another owner.
export function claimOwnedHttpArchiveFunding(cap: OwnedHttpRequest, body: Record<string, unknown>): void {
  const plan = ownedPricing?.get(cap);
  if (!plan || !plan.archiveCredits || plan.body !== body || !matchesOwnedHttpPricingInput(cap, body)
    || !(plan.retentionBytes > 0)) throw identityFailure("protocol");
  plan.archiveCredits--;
}

export function enterOwnedHttpPricing(cap: OwnedHttpRequest, body: Record<string, unknown>): void {
  const plan = ownedPricing?.get(cap);
  if (!plan || plan.body !== body || plan.active || activeOwnedPricing?.has(body)
    || !matchesOwnedHttpPricingInput(cap, body)) throw identityFailure("protocol");
  activeOwnedPricing!.set(body, plan); plan.active = true;
}
export function leaveOwnedHttpPricing(cap: OwnedHttpRequest, body: Record<string, unknown>): void {
  const plan = ownedPricing?.get(cap);
  if (!plan || plan.body !== body || !plan.active || activeOwnedPricing?.get(body) !== plan) throw identityFailure("protocol");
  activeOwnedPricing.delete(body); plan.active = false;
}
export function retireOwnedHttpPricing(cap: OwnedHttpRequest): void {
  const plan = ownedPricing?.get(cap);
  if (!plan) return;
  if (plan.active) throw identityFailure("protocol");
  plan.body = undefined; ownedPricing!.delete(cap);
  if (!--ownedPricingCount) {
    ownedPricing = undefined; activeOwnedPricing = undefined;
    const charge = ownedPricingRegistry; ownedPricingRegistry = undefined; charge!.release();
  }
}
function ownedHttpPricing(body: Record<string, unknown>, format: string | undefined): OwnedHttpPricingPlan | undefined {
  return format === "openai.chat_completions" ? activeOwnedPricing?.get(body) : undefined;
}
function reserveOwnedPricingQueue(cap: OwnedHttpRequest, plan: OwnedHttpPricingWork, count: number): void {
  if (count <= plan.queueCapacity) return;
  // PAYLOAD_GRAPH_TRAVERSAL_CONTROL: C=1 was prepaid before []; each
  // pending source reference is one P cell. The source graph remains additive.
  // This existing debit pays this workspace once, not a fixed-window exemption
  // for the active frame, operands, iterators or callbacks using it.
  growOwnedHttpRequest(cap, 8 * (count - plan.queueCapacity)); plan.queueCapacity = count;
}
function childObjects(value: object): number {
  let count = 0;
  if (ownedPricingArray(value)) {
    for (let index = 0; index < value.length; index++) if (value[index] !== null && typeof value[index] === "object") count++;
  } else for (const key in value) if (ownedPricingOwn(value, key)) {
    const item = (value as Record<string, unknown>)[key];
    if (item !== null && typeof item === "object") count++;
  }
  return count;
}
function queueOwnedChildren(value: object, pending: object[]): void {
  if (ownedPricingArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const item = value[index]; if (item !== null && typeof item === "object") pending.push(item);
    }
  } else for (const key in value) if (ownedPricingOwn(value, key)) {
    const item = (value as Record<string, unknown>)[key];
    if (item !== null && typeof item === "object") pending.push(item);
  }
}
function ownedContentHasMedia(cap: OwnedHttpRequest, plan: OwnedHttpPricingWork, root: unknown, pending: object[]): boolean {
  if (!root || typeof root !== "object") return false;
  reserveOwnedPricingQueue(cap, plan, 1); pending.push(root);
  try {
    while (pending.length) {
      const value = pending.pop()!;
      if (!ownedPricingArray(value)) {
        const item = value as Record<string, unknown>, type = typeof item.type === "string" ? item.type : "";
        if (type === "image" || type === "image_url" || type === "video_url" || type === "document" || type === "file"
          || type === "input_image" || type === "input_file" || type === "item_reference" || type === "computer_screenshot"
          || "image_url" in item || "video_url" in item || "file_id" in item) return true;
      }
      reserveOwnedPricingQueue(cap, plan, pending.length + childObjects(value));
      queueOwnedChildren(value, pending);
    }
    return false;
  } finally { pending.length = 0; }
}
function quotedOwnedJsonBytes(value: string): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) bytes += 2;
    else if (code < 32) bytes += 6;
    else if (code < 128) bytes++;
    else if (code < 2048) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { bytes += 4; index++; } else bytes += 6;
    } else bytes += code >= 0xdc00 && code <= 0xdfff ? 6 : 3;
  }
  return bytes;
}
function ownedScalarJsonBytes(value: unknown): number {
  if (typeof value === "string") return quotedOwnedJsonBytes(value);
  if (value === null) return 4;
  if (typeof value === "boolean") return value ? 4 : 5;
  if (typeof value === "number") return Number.isFinite(value) ? String(value).length : 4;
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") return -1;
  if (typeof value === "bigint") throw new TypeError("BigInt cannot be serialized as JSON");
  return 0; // A child container is counted when removed from the paid traversal queue.
}
function countOwnedMediaSlot(plan: OwnedHttpPricingWork, key: string | number, value: unknown): void {
  if (typeof value !== "string" || value.length < 64 * 1024) return;
  // Slot entry + {owner,key,value,marker}: C=1, P=9, N=3.
  // Both string-valued key/value occurrences have primitive cells. Field names
  // total19 units; the marker has a54-unit UUID prefix plus <=16 index units.
  plan.slotBytes += 8 * (1 + 9 + 3) + 2 * (19 + 70 + value.length + (typeof key === "string" ? key.length : 0));
  plan.mediaSlots++; plan.mediaUnits += value.length;
}
function countOwnedJsonScalar(plan: OwnedHttpPricingWork, value: unknown): void {
  if (typeof value === "string") {
    plan.graphBytes += 8 + 2 * value.length;
    plan.maximumScalarUnits = Math.max(plan.maximumScalarUnits, value.length);
  } else if (value === null || typeof value === "number" || typeof value === "boolean" || value === undefined) plan.graphBytes += 8;
}
function ownedToolScratchBytes(body: Record<string, unknown>, card: boolean, bytes: number): number {
  let topCells = 0, topPrimitives = 0, topUnits = 0, tagCells = 0, tagPrimitives = 0, tagUnits = 0;
  let types = 0, typeUnits = 0, largestType = 0, coerced = false;
  // These are the existing pricing helpers' exact two shallow inventories,
  // not a recursive tool/schema search. No copied array exists during admission.
  for (let phase = 0; phase < (card ? 2 : 1); phase++) {
    const count = phase === 0 ? 1 : ownedPricingArray(body.input) ? body.input.length : 0;
    for (let index = 0; index < count; index++) {
      let tools: unknown[] | undefined;
      if (phase === 0) tools = ownedPricingArray(body.tools) ? body.tools : undefined;
      else {
        const item = (body.input as unknown[])[index];
        if (ownedPricingObject(item) && (item.type === "additional_tools" || item.type === "tool_search_output") && ownedPricingArray(item.tools)) tools = item.tools;
      }
      if (!tools) continue;
      for (let itemIndex = 0; itemIndex < tools.length; itemIndex++) {
        const item = tools[itemIndex], primitive = typeof item === "string" || item === null || typeof item === "number" || typeof item === "boolean" || item === undefined;
        const units = typeof item === "string" ? item.length : 0;
        if (phase === 0) { topCells++; topPrimitives += primitive ? 1 : 0; topUnits += units; }
        else { tagCells++; tagPrimitives += primitive ? 1 : 0; tagUnits += units; }
        if (!ownedPricingObject(item)) continue;
        // Chat's ordinary fee classifier performs String(type). Only a passive
        // array can create a body-sized result; no caller hooks enter this body.
        if (phase === 0 && ownedPricingArray(item.type)) coerced = true;
        if (card && typeof item.type === "string" && /^web_search(?:_preview)?(?:_\d{4}_\d{2}_\d{2})?$/.test(item.type)) {
          types++; typeUnits += item.type.length; largestType = Math.max(largestType, item.type.length);
        }
      }
    }
  }
  // Copied string values need their own primitive cells even when empty.
  const top = 8 * (1 + topCells + topPrimitives) + 2 * topUnits;
  if (!card) return top + 8 + (coerced ? 2 * bytes : 0);
  const tagged = 8 * (1 + tagCells + tagPrimitives) + 2 * tagUnits;
  const combined = top + tagged - 8;
  const typed = 8 * (1 + 2 * types) + 2 * typeUnits;
  const singleton = 24 + 2 * largestType, rates = 8 + 16 * types;
  return Math.max(top + 8 + (coerced ? 2 * bytes : 0), tagged + typed + Math.max(combined + singleton, rates));
}
function measureOwnedHttpJson(cap: OwnedHttpRequest, plan: OwnedHttpPricingWork, root: object, pending: object[]): void {
  reserveOwnedPricingQueue(cap, plan, 1);
  // A parallel numeric depth vector is paid variable traversal CONTROL. Each
  // occupied index has both an entry cell and a number-value cell.
  growOwnedHttpRequest(cap, 24);
  const depths = [0]; let depthCapacity = 1;
  pending.push(root);
  try { while (pending.length) {
    const value = pending.pop()!, depth = depths.pop()!;
    if (depth > plan.maximumDepth) plan.maximumDepth = depth;
    const count = pending.length + childObjects(value);
    reserveOwnedPricingQueue(cap, plan, count);
    if (count > depthCapacity) { growOwnedHttpRequest(cap, 16 * (count - depthCapacity)); depthCapacity = count; }
    plan.bytes += 2; // brackets/braces; punctuation needs no continuation frames
    plan.graphBytes += 8;
    if (ownedPricingArray(value)) {
      plan.graphBytes += 8 * value.length;
      plan.keyVectorBytes = Math.max(plan.keyVectorBytes, 8 + 16 * value.length);
      if (value.length) plan.bytes += value.length - 1;
      for (let index = 0; index < value.length; index++) {
        const item = value[index], scalar = ownedScalarJsonBytes(item);
        countOwnedJsonScalar(plan, item);
        countOwnedMediaSlot(plan, index, item);
        if (item !== null && typeof item === "object") { pending.push(item); depths.push(depth + 1); }
        else plan.bytes += scalar < 0 ? 4 : scalar; // array omission is null
      }
    } else {
      const item = value as Record<string, unknown>;
      if ("cache_control" in item) plan.cache = true;
      if (ownedPricingObject(item.cache_control) && item.cache_control.ttl === "1h") plan.hour = true;
      let members = 0, keys = 0, keyUnits = 0;
      for (const key in item) if (ownedPricingOwn(item, key)) {
        keys++; keyUnits += key.length;
        const child = item[key], scalar = ownedScalarJsonBytes(child);
        plan.graphBytes += 16 + 2 * key.length;
        countOwnedJsonScalar(plan, child);
        countOwnedMediaSlot(plan, key, child);
        if (scalar < 0) continue;
        plan.bytes += quotedOwnedJsonBytes(key) + 1 + scalar;
        if (members++) plan.bytes++;
        if (child !== null && typeof child === "object") { pending.push(child); depths.push(depth + 1); }
      }
      plan.keyVectorBytes = Math.max(plan.keyVectorBytes, 8 + 16 * keys + 2 * keyUnits);
    }
  } } finally { depths.length = 0; }
}

export interface HostedSearchPrice { version: string; microsPerCall: number | null }
// Freeze the declared request tariff, not a guess from the response or model name.
// An inherited/opaque or mixed search generation has no qualified unit rate.
export function hostedSearchPrice(card: ToolPricing | undefined, body: unknown, upstream?: string, retained = false): HostedSearchPrice | undefined {
  if (!card || !isObject(body)) return undefined;
  const tagged = Array.isArray(body.input) ? body.input.flatMap(item => isObject(item) && ["additional_tools", "tool_search_output"].includes(item.type as string) && Array.isArray(item.tools) ? item.tools : []) : [];
  const types = (Array.isArray(body.tools) ? body.tools : []).concat(tagged)
    .flatMap(tool => isObject(tool) && typeof tool.type === "string" && /^web_search(?:_preview)?(?:_\d{4}_\d{2}_\d{2})?$/.test(tool.type) ? [tool.type] : []);
  if (!types.length) return undefined;
  // A current declaration cannot exclude a differently priced retained tool.
  // A witness classifies ancestry, not the precise retained search tariff.
  // Ordinary encrypted reasoning is not a ToolParam inventory; it does not
  // change the declared current-request tariff. Its token bound and any
  // compaction witness knowledge remain independently conservative.
  if (retained || body.previous_response_id != null || body.conversation != null || body.prompt != null
    || Array.isArray(body.input) && body.input.some(item => isObject(item) && ["compaction", "item_reference"].includes(item.type as string))
    || isObject(body.multi_agent) && body.multi_agent.enabled === true
    || (Array.isArray(body.tools) ? body.tools : []).concat(tagged).some(tool => isObject(tool) && (tool.type === "mcp" || tool.type === "programmatic_tool_calling" || tool.type === "tool_search" && tool.execution !== "client"))) return { version: card.version, microsPerCall: null };
  const rates = types.map(type => type.startsWith("web_search_preview") ? upstream && Object.hasOwn(card.previewMicrosPerCallByModel, upstream) ? card.previewMicrosPerCallByModel[upstream] : null : card.webSearchMicrosPerCall);
  return { version: card.version, microsPerCall: rates.every(rate => rate === rates[0]) ? rates[0] : null };
}

// Messages web tools have known tariffs but no qualified cumulative token bound.
// max_uses caps the search fee, not repeated model-input processing. Never use
// one context window (or max_content_tokens) to admit a hard-budget server loop.
const claudeSearchTypes = new Set(["web_search_20250305", "web_search_20260209", "web_search_20260318"]);
const claudeFetchTypes = new Set(["web_fetch_20250910", "web_fetch_20260209", "web_fetch_20260309", "web_fetch_20260318"]);
export interface AnthropicWebPrice extends HostedSearchPrice { search: boolean; usageComplete: boolean }
export function anthropicWebPrice(card: ToolPricing | undefined, body: unknown): AnthropicWebPrice | undefined {
  if (!card || !isObject(body) || !Array.isArray(body.tools)) return undefined;
  const tools = body.tools;
  const web = tools.filter(tool => isObject(tool) && (claudeSearchTypes.has(String(tool.type)) || claudeFetchTypes.has(String(tool.type))));
  if (!web.length) return undefined;
  // Other server tools, MCP and compaction keep their independent pricing gaps.
  // Top-level token counters cannot attest separately billed iterations.
  const usageComplete = requestPricingGap(undefined, { ...body, tools: tools.filter(tool => !web.includes(tool)) }, "anthropic.messages") === null;
  return { version: card.version, microsPerCall: card.webSearchMicrosPerCall, usageComplete, search: web.some(tool => isObject(tool) && claudeSearchTypes.has(String(tool.type))) };
}

export function hostedSearchCost(price: HostedSearchPrice | undefined, count: number): number | null {
  return price?.microsPerCall == null ? null : saturatingMultiply(price.microsPerCall, count);
}

// Source-qualified request component. Shared admission must freeze it alongside
// the inference bound; declaring it alone does not clear requestPricingGap.
export interface OutcomeRequestPricing {
  unit: "request";
  version: string;
  effectiveAt: string;
  source: "https://docs.x.ai/developers/pricing#usage-guidelines-violation-fee";
  outcome: "xai.responses_violation";
  maximumAdditionalMicros: 50000;
  receipt: "xai.usage.cost_in_usd_ticks";
}

export interface RequestCostReceipt {
  costMicros: number;
  basis: "provider_reported" | "manifest_request";
  pricingVersion: string;
}

// One qualified native Search dispatch can incur this fee regardless of count.
// This pure bound does not register admission or observe a billable outcome.
export function deepSeekSearchReserve(pricing: Readonly<DeepSeekSearchRequestPricing>): number | null {
  if (!isObject(pricing) || Object.keys(pricing).some(key => ![
    "unit", "protocol", "version", "effectiveAt", "source", "successfulNonemptyRequestMicros", "emptyRequestMicros",
  ].includes(key)) || pricing.unit !== "request" || pricing.protocol !== "deepseek.search"
    || typeof pricing.version !== "string" || !/^[a-zA-Z0-9._:-]{1,128}$/.test(pricing.version)
    || pricing.effectiveAt !== "2026-11-01T00:00:00+08:00"
    || pricing.source !== "https://api-docs.deepseek.com/guides/search/"
    || pricing.successfulNonemptyRequestMicros !== 750 || pricing.emptyRequestMicros !== 0) return null;
  return pricing.successfulNonemptyRequestMicros;
}

// Only the native reader's validated observation can select the empty rate.
// Missing or contradictory evidence leaves shared settlement holding its reserve.
export function deepSeekSearchCost(pricing: Readonly<DeepSeekSearchRequestPricing>, usage: ValidatedNativeUsage): RequestCostReceipt | null {
  if (deepSeekSearchReserve(pricing) === null || !isObject(usage) || usage.outcome !== "success") return null;
  const observed = usage.nativeRequestUsage;
  if (!isObject(observed) || observed.operation !== "deepseek.search" || observed.pricingVersion !== pricing.version
    || observed.billableRequests !== 0 && observed.billableRequests !== 1) return null;
  return { costMicros: observed.billableRequests === 0 ? pricing.emptyRequestMicros : pricing.successfulNonemptyRequestMicros,
    basis: "manifest_request", pricingVersion: pricing.version };
}

export interface ImageRequestPricing {
  unit: "image"; protocol: "xai.images"; version: string; effectiveAt: string;
  source: "https://docs.x.ai/developers/pricing";
  receipt: "xai.usage.cost_in_usd_ticks";
  alias: { selectedModel: "grok-imagine-image-quality"; servingModel: "grok-imagine-image-2.0"; quality: "low";
    effectiveAt: "2026-11-02"; source: "https://docs.x.ai/developers/migration/imagine-image-quality-nov-2" };
  rates: {
    "grok-imagine-image": { inputMicrosPerImage: number; outputMicrosPerImage: Record<"1k" | "2k", number> };
    "grok-imagine-image-2.0": { inputMicrosPerImage: number; outputMicrosPerImage: Record<"low" | "medium", Record<"1k" | "2k", number>> };
  };
}
// Freeze this projection only after prepareXaiImage validates the native body.
// It carries no prompt, image reference, credential or raw output bytes.
export type ImageRequestSelection = Pick<XaiImageRequest, "model" | "servingModel" | "mode" | "count" | "inputImages" | "resolution" | "quality" | "qualityBasis">;

export function imageRequestReserve(pricing: ImageRequestPricing, request: ImageRequestSelection): number | null {
  if (!qualifiedImageSelection(pricing, request)) return null;
  const card = pricing.rates[request.servingModel as keyof ImageRequestPricing["rates"]];
  if (!isObject(card) || !isObject(card.outputMicrosPerImage)) return null;
  const input = nonNegativeInteger(card.inputMicrosPerImage);
  const outputs = card.outputMicrosPerImage as Record<string, unknown>;
  const quality = request.qualityBasis === "service_default" ? ["low", "medium"] : [request.quality];
  const selected = request.qualityBasis === "legacy" ? [outputs[request.resolution]]
    : quality.map(key => key && isObject(outputs[key]) ? outputs[key][request.resolution] : undefined);
  const rates = selected.map(nonNegativeInteger);
  if (input == null || input === 0 || rates.some(rate => rate == null || rate === 0)) return null;
  // Bound every edit reference per requested output, without claiming that
  // this conservative multiplicity is the observed bill. Auto may choose
  // either qualified quality; the explicit upstream alias is always low.
  const reserve = (input * request.inputImages + Math.max(...rates as number[])) * request.count;
  return Number.isSafeInteger(reserve) ? reserve : null;
}

export function imageRequestCost(pricing: ImageRequestPricing, request: ImageRequestSelection, response: unknown, complete: boolean): RequestCostReceipt | null {
  if (imageRequestReserve(pricing, request) == null || !complete || !isObject(response)
    || response.model !== request.servingModel || response.error != null
    || response.status !== undefined && response.status !== "done" || !isObject(response.usage)) return null;
  // Cost is independent of successful image delivery. The shared runtime must
  // attest bounded original HTTP/JSON EOF and separately validate image bytes.
  // Never infer a refund from moderation, partial delivery or a missing receipt.
  return tickedCostReceipt(response.usage.cost_in_usd_ticks, pricing.version);
}

function qualifiedImageSelection(pricing: ImageRequestPricing, request: ImageRequestSelection): boolean {
  if (pricing.unit !== "image" || pricing.protocol !== "xai.images" || pricing.source !== "https://docs.x.ai/developers/pricing"
    || typeof pricing.version !== "string" || !pricing.version.length
    || pricing.receipt !== "xai.usage.cost_in_usd_ticks" || !isObject(pricing.rates) || !isObject(pricing.alias)
    || pricing.alias.selectedModel !== "grok-imagine-image-quality" || pricing.alias.servingModel !== "grok-imagine-image-2.0"
    || pricing.alias.quality !== "low" || pricing.alias.effectiveAt !== "2026-11-02"
    || pricing.alias.source !== "https://docs.x.ai/developers/migration/imagine-image-quality-nov-2"
    || !Number.isSafeInteger(request.count) || request.count < 1 || request.count > 4
    || !Number.isSafeInteger(request.inputImages) || request.inputImages < 0 || request.inputImages > 3
    || !["1k", "2k"].includes(request.resolution)
    || (request.mode === "generate" ? request.inputImages !== 0 : request.mode !== "edit" || request.inputImages === 0)) return false;
  if (request.model === pricing.alias.selectedModel) return request.servingModel === pricing.alias.servingModel && request.quality === "low" && request.qualityBasis === "retired_alias";
  if (request.model === "grok-imagine-image") return request.servingModel === request.model && request.quality === null && request.qualityBasis === "legacy";
  return request.model === "grok-imagine-image-2.0" && request.servingModel === request.model
    && ["low", "medium"].includes(request.quality as string) && ["explicit", "service_default"].includes(request.qualityBasis);
}

export function requestOutcomeReserve(pricing: OutcomeRequestPricing, inferenceMicros: number | null): number | null {
  if (!qualifiedOutcome(pricing) || inferenceMicros == null || !Number.isSafeInteger(inferenceMicros) || inferenceMicros < 0
    || inferenceMicros > Number.MAX_SAFE_INTEGER - pricing.maximumAdditionalMicros) return null;
  return inferenceMicros + pricing.maximumAdditionalMicros;
}

// Only a complete, original upstream Response can supply a total-charge receipt.
// An HTTP error, refusal text or even an exact $0.05 receipt does not identify
// a violation. Missing evidence remains unknown, never a zero-cost failure.
export function requestOutcomeCost(pricing: OutcomeRequestPricing, response: unknown, complete: boolean): RequestCostReceipt | null {
  if (!qualifiedOutcome(pricing) || !complete || !isObject(response) || response.object !== "response"
    || typeof response.id !== "string" || !response.id.length || response.id.length > 256
    || !["completed", "incomplete"].includes(response.status as string) || !isObject(response.usage)) return null;
  return tickedCostReceipt(response.usage.cost_in_usd_ticks, pricing.version);
}

function tickedCostReceipt(ticks: unknown, pricingVersion: string): RequestCostReceipt | null {
  if (typeof ticks !== "number" || !Number.isSafeInteger(ticks) || ticks < 0) return null;
  // 10^10 ticks/USD = 10^4 ticks/micro. Integer remainder avoids precision
  // loss near MAX_SAFE_INTEGER; never add the fee again to this whole bill.
  return { costMicros: Math.floor(ticks / 10000) + (ticks % 10000 === 0 ? 0 : 1), basis: "provider_reported", pricingVersion };
}

function qualifiedOutcome(pricing: OutcomeRequestPricing): boolean {
  return pricing.unit === "request" && pricing.outcome === "xai.responses_violation"
    && pricing.maximumAdditionalMicros === 50000 && pricing.receipt === "xai.usage.cost_in_usd_ticks";
}

export interface CostEstimate {
  reserveMicros: number;
  inputTokens: number | null;
  outputTokens: number | null;
  pricingAvailable?: false;
}

export interface PricedTokens {
  image?: { textInput: number; imageInput: number; imageOutput: number };
  serviceTier?: string | null;
  billable?: false;
  billedTokens?: { input: number | null; output: number | null };
  input: number | null;
  output: number | null;
  cached: number | null;
  cacheWrite: number | null;
  cacheWrite5m: number | null;
  cacheWrite1h: number | null;
}

interface Rates {
  input: number;
  output: number;
  cachedInput: number | null;
  cacheWriteInput: number | null;
  cacheWrite5mInput: number | null;
  cacheWrite1hInput: number | null;
}

export type PricingGap = "audio_upload_bound" | "model_request_fee" | "hosted_tool_fee" | "hosted_tool_usage" | "retained_tool_unknown" | "opaque_input_bound";

const unpricedGoogleRequestFormats = new Set(["google.grounded_search", "google.audio_understanding", "google.video_understanding"]);
const unpricedNativeAudioFormats = new Set(["groq.transcription", "mistral.transcription", "xai.stt", "xai.tts"]);

export function requestPricingGap(pricing: ModelPricing | null | undefined, body: Record<string, unknown>, requestFormat: string, parentTools?: ToolKnowledge, selectedUpstreamModel?: string | null): PricingGap | null {
  // These native uploads have neither a qualified duration bound nor a token tariff.
  // Keep OpenAI's separately qualified soft-token settlement exception separate.
  if (unpricedNativeAudioFormats.has(requestFormat)) return "opaque_input_bound";
  if (unpricedGoogleRequestFormats.has(requestFormat)) return requestFormat === "google.grounded_search" ? "hosted_tool_fee" : "opaque_input_bound";
  // Native media bounds do not qualify an image, music or speech tariff.
  if (googleAudioRequest(selectedUpstreamModel, body, requestFormat)
    || googleImageRequest(selectedUpstreamModel, body, requestFormat)) return "opaque_input_bound";
  if (requestFormat === "openai.standalone_search") return "hosted_tool_usage";
  const compact = requestFormat === "openai.responses_compact";
  if (compact) requestFormat = "openai.responses";
  // File/context caps do not qualify a whole-upload billable token ceiling.
  if (requestFormat === "openai.audio_transcriptions") return "audio_upload_bound";
  if (pricing?.unit == null && pricing?.unpricedCosts?.includes("request_fee")) return "model_request_fee";
  if (requestFormat === "openai.chat_completions" && isObject(body.web_search_options)) return "hosted_tool_fee";
  // Saved Responses prompts retain tools; an opaque reference cannot prove
  // that the effective request has only the declared token charges.
  if (requestFormat === "openai.responses" && body.prompt != null) return "hosted_tool_usage";
  if (requestFormat === "openai.responses" && isObject(body.multi_agent) && body.multi_agent.enabled === true) return "hosted_tool_usage";
  if (requestFormat === "anthropic.messages" && Array.isArray(body.mcp_servers) && body.mcp_servers.length) return "hosted_tool_usage";
  // Claude bills compaction iterations outside the ordinary top-level usage.
  if (requestFormat === "anthropic.messages" && (isObject(body.compaction) && body.compaction.type === "summarize"
    || isObject(body.context_management) && Array.isArray(body.context_management.edits) && body.context_management.edits.some((edit) => isObject(edit) && edit.type === "compact_20260112"))) return "hosted_tool_usage";
  // CachedContent retains tools and toolConfig. The reference alone cannot
  // prove that generation has only the token costs represented by this card.
  if (requestFormat === "google.generate_content" && googleField(body, "cachedContent", "cached_content") != null) return "hosted_tool_usage";
  // Responses Lite and tool search load executable declarations through tagged
  // input items. Do not search ordinary output data, content, or function schemas.
  const current = hostedToolPricingGap(requestDeclaredTools(body, requestFormat), requestFormat);
  if (current) return current;
  if (requestFormat === "openai.responses" && responsesHasOpaqueInput(body) && opaqueInputLimit(pricing) == null) return "opaque_input_bound";
  // C-S1 has no durable opaque-ancestry witness. Ciphertext and references
  // cannot prove that retained executable tools have only token charges.
  if (compact && (retainedToolBase(body, "token_only") !== "token_only"
    || body.tools !== undefined && retainedToolBase({ input: [{ type: "additional_tools", tools: body.tools }] }, "token_only") !== "token_only"
    || Array.isArray(body.input) && body.input.some(item => isObject(item) && (item.type === "compaction" || item.type === "item_reference" || item.type === "reasoning" && item.encrypted_content != null)))) return "retained_tool_unknown";
  if (requestFormat !== "openai.responses" || typeof body.previous_response_id !== "string" || body.previous_response_id === "") return null;
  // A response ID can retain executable declarations omitted from this delta.
  // Only final parent knowledge proves ordinary token pricing; omission is unknown.
  return parentTools === "token_only" ? null : parentTools === "hosted_tool_fee" || parentTools === "hosted_tool_usage" ? parentTools : "retained_tool_unknown";
}

// Opt in only after the shared runtime binds the qualified outcome tariff to
// admission and settlement. The ordinary classifier keeps its request-fee gap.
export function outcomeRequestPricingGap(pricing: ModelPricing | null | undefined, body: Record<string, unknown>, requestFormat: string, requestPricing: OutcomeRequestPricing, parentTools?: ToolKnowledge): PricingGap | null {
  if (!pricing || pricing.unit != null || requestFormat !== "openai.responses" || !qualifiedOutcome(requestPricing)) return "model_request_fee";
  // The native contract supports these ToolParam types. Unknown declarations
  // cannot be certified as client execution merely because no fee is known.
  const tools = requestDeclaredTools(body, requestFormat);
  if (body.tools != null && !Array.isArray(body.tools)
    || tools.some(tool => !isObject(tool) || !["function", "web_search", "x_search", "code_interpreter", "file_search", "image_generation", "mcp"].includes(tool.type as string))) return "hosted_tool_usage";
  // xAI automatically enables document search for native file attachments.
  // Inspect message content parts, never text, function schemas or arguments.
  if (Array.isArray(body.input) && body.input.some(item => isObject(item) && (item.type === "input_file"
    || Array.isArray(item.content) && item.content.some(part => isObject(part) && part.type === "input_file")))) return "hosted_tool_usage";
  // Legacy native search is an execution selector, not ordinary user JSON.
  if (body.search_parameters != null && (!isObject(body.search_parameters) || body.search_parameters.mode !== "off")) return "hosted_tool_usage";
  // Generic token-only history does not attest xAI's implicit file-search state.
  if (body.previous_response_id != null || body.conversation != null) return "retained_tool_unknown";
  return requestPricingGap({ ...pricing, unpricedCosts: pricing.unpricedCosts?.filter(cost => cost !== "request_fee") }, body, requestFormat, parentTools);
}

function requestDeclaredTools(body: Record<string, unknown>, requestFormat: string): unknown[] {
  const inputTools = requestFormat === "openai.responses" && Array.isArray(body.input)
    ? body.input.flatMap(item => isObject(item) && ["additional_tools", "tool_search_output"].includes(item.type as string) && Array.isArray(item.tools) ? item.tools : []) : [];
  return (Array.isArray(body.tools) ? body.tools : []).concat(inputTools);
}

// Classify known executable declarations only. A null result does not attest
// that an unknown or partially observed tool inventory is complete.
export function hostedToolPricingGap(tools: readonly unknown[], requestFormat: string): "hosted_tool_fee" | "hosted_tool_usage" | null {
  let usageGap = false;
  for (const tool of tools) {
    if (!isObject(tool)) continue;
    // Inspect protocol declarations, never function names or user JSON schemas.
    if (requestFormat === "openai.chat_completions" && ["browser_search", "code_interpreter"].includes(String(tool.type))) return "hosted_tool_fee";
    if (requestFormat === "openai.responses" && typeof tool.type === "string") {
      if (/^web_search(?:_preview)?(?:_\d{4}_\d{2}_\d{2})?$/.test(tool.type) || ["x_search", "file_search", "code_interpreter", "image_generation"].includes(tool.type)) return "hosted_tool_fee";
      if (tool.type === "shell" && isObject(tool.environment) && ["container_auto", "container_reference"].includes(String(tool.environment.type))) return "hosted_tool_fee";
      // Hosted search has no qualified cumulative bound; this is not a fee claim.
      if (["mcp", "programmatic_tool_calling"].includes(tool.type) || tool.type === "tool_search" && tool.execution !== "client") usageGap = true;
    }
    if (requestFormat === "anthropic.messages" && typeof tool.type === "string" && /^web_search_\d{8}$/.test(tool.type)) {
      if (!claudeSearchTypes.has(tool.type)) return "hosted_tool_fee";
      usageGap = true;
    }
    // Anthropic waives execution fees when these web-tool versions are present.
    // Their search fee, when applicable, is still handled by the branch above.
    if (requestFormat === "anthropic.messages" && typeof tool.type === "string" && /^code_execution_\d{8}$/.test(tool.type) && !tools.some((candidate) => isObject(candidate) && typeof candidate.type === "string" && /^web_(?:search|fetch)_\d{8}$/.test(candidate.type) && candidate.type.slice(-8) >= "20260209")) return "hosted_tool_fee";
    // A waived execution fee does not bound accumulated server-loop input.
    if (requestFormat === "anthropic.messages" && typeof tool.type === "string" && (/^(?:web_fetch|code_execution)_\d{8}$/.test(tool.type) || /^(?:tool_search_tool_regex|tool_search_tool_bm25)(?:_20251119)?$/.test(tool.type) || ["advisor_20260301", "mcp_toolset"].includes(tool.type))) usageGap = true;
    if (requestFormat === "google.generate_content") {
      if ([["googleSearch", "google_search"], ["googleSearchRetrieval", "google_search_retrieval"], ["googleMaps", "google_maps"]].some(([camel, proto]) => isObject(googleField(tool, camel, proto)))) return "hosted_tool_fee";
      // These tools have token charges rather than a flat tool fee, but their
      // server-side work is not covered by our ordinary prompt/output bounds.
      if ([["urlContext", "url_context"], ["fileSearch", "file_search"], ["codeExecution", "code_execution"]].some(([camel, proto]) => isObject(googleField(tool, camel, proto)))) usageGap = true;
      const servers = googleField(tool, "mcpServers", "mcp_servers");
      if (Array.isArray(servers) && servers.length) usageGap = true;
    }
  }
  return usageGap ? "hosted_tool_usage" : null;
}

export type PricingEndpoint = Pick<CompiledEndpoint, "request_format" | "outputTokenLimit"> & Partial<Pick<CompiledEndpoint, "id">> & {
  selectedUpstreamModel?: string | null;
};

export function estimateModelCost(pricing: ModelPricing, body: Record<string, unknown>, endpoint?: PricingEndpoint, requestPricing?: OutcomeRequestPricing): CostEstimate {
  const owned = ownedHttpPricing(body, endpoint?.request_format);
  if (unpricedGoogleRequestFormats.has(endpoint?.request_format ?? "") || unpricedNativeAudioFormats.has(endpoint?.request_format ?? ""))
    return { reserveMicros: 0, inputTokens: null, outputTokens: null, pricingAvailable: false };
  if (googleAudioRequest(endpoint?.selectedUpstreamModel, body, endpoint?.request_format ?? "")
    || googleImageRequest(endpoint?.selectedUpstreamModel, body, endpoint?.request_format ?? ""))
    return { reserveMicros: 0, inputTokens: null, outputTokens: null, pricingAvailable: false };
  if (requestPricing && (!qualifiedOutcome(requestPricing) || pricing.unit != null || endpoint?.request_format !== "openai.responses"))
    return { reserveMicros: 0, inputTokens: null, outputTokens: null, pricingAvailable: false };
  if (pricing.unit === "image_token") return estimateImageCost(pricing, body);
  if (pricing.unit === "character") {
    // UTF-8 bytes bound code points without assuming an upstream tokenizer.
    // Empty catalog probes retain the full bounded envelope; dispatch validates input.
    const bytes = typeof body.input === "string" ? new TextEncoder().encode(body.input).byteLength : pricing.maxInputCharacters * 4;
    return { reserveMicros: characterCost(bytes, pricing), inputTokens: null, outputTokens: null };
  }
  const google = endpoint?.request_format === "google.generate_content";
  const compact = endpoint?.request_format === "openai.responses_compact";
  // A GenerateContent continuation restores prior generated context upstream;
  // its token and repeated original prompt do not bound that context's size.
  const opaque = google ? googleField(body, "continuationToken", "continuation_token") != null
    : (!endpoint || endpoint.request_format === "openai.responses" || compact) && responsesHasOpaqueInput(body);
  const opaqueLimit = opaque ? opaqueInputLimit(pricing) : null;
  if (opaque && opaqueLimit == null) return { reserveMicros: 0, inputTokens: null, outputTokens: null, pricingAvailable: false };
  const inputLimit = opaqueLimit ?? pricing.maxRequestInputTokens ?? pricing.maxInputTokens;
  // Claude base64 images with a recognized header replace their encoded bytes
  // with their visual-token ceiling. Every other media input stays unbounded.
  const images: InlineImageBound | undefined = endpoint?.request_format === "anthropic.messages" ? { encodedBytes: 0, tokens: 0 } : undefined;
  const unbounded = opaque || (owned ? owned.media : google ? googleHasUnboundedInput(body) : requestHasUnboundedInput(body, images));
  // Opaque/history/media inputs already reserve the full bound; their encoded
  // size cannot refine it. Avoid serializing the conversation just to discard it.
  const bytes = unbounded ? 0 : owned ? owned.bytes : endpoint?.request_format === "anthropic.messages" ? jsonBodyBytes(body) : new TextEncoder().encode(JSON.stringify(body)).byteLength;
  const inputTokens = unbounded ? inputLimit
    : Math.min(inputLimit, saturatingAdd(saturatingAdd(bytes - (images?.encodedBytes ?? 0), images?.tokens ?? 0), pricing.inputTokenOverhead));
  const config = google ? googleField(body, "generationConfig", "generation_config") : undefined;
  // Native maxOutputTokens includes both thoughts and visible candidate tokens.
  // Only the selected wire format decides which caller limits are meaningful.
  const requestedOutput = (google ? [googleInt32(googleField(config, "maxOutputTokens", "max_output_tokens"))] : [body.max_output_tokens, body.max_completion_tokens, body.max_tokens])
    .map(nonNegativeInteger)
    .filter((value): value is number => value != null);
  const choices = Math.max(1, (google ? googleInt32(googleField(config, "candidateCount", "candidate_count")) : nonNegativeInteger(body.n)) ?? 1);
  const limit = endpoint?.outputTokenLimit;
  const declaredOutput = limit ? nonNegativeInteger(body[limit.field]) : null;
  // Undocumented aliases and malformed/omitted limits cannot lower a declared
  // endpoint bound. This qualifies the estimate; the upstream body is unchanged.
  const output = limit ? declaredOutput != null && declaredOutput >= limit.minimum && declaredOutput <= limit.maximum ? declaredOutput : limit.maximum
    : requestedOutput.length ? Math.max(...requestedOutput) : pricing.defaultMaxOutputTokens;
  // No caller output-limit contract exists for compact. Use the authoritative
  // model maximum even if chat/ordinary-Responses-looking fields are present.
  // xAI's qualified Responses max_output_tokens bounds visible output only,
  // excluding reasoning/function calls. Keep the full model output envelope.
  const outputTokens = compact || requestPricing ? pricing.defaultMaxOutputTokens : saturatingMultiply(output, choices);
  const rates = resolveRates(pricing, inputTokens, google ? googleRequestServiceTier(body) : body.service_tier, true, google);
  if (!rates) return { reserveMicros: 0, inputTokens, outputTokens, pricingAvailable: false };
  const inputRate = reservationInputRate(body, rates, owned);
  const inferenceMicros = saturatingAdd(tokenCost(inputTokens, inputRate), tokenCost(outputTokens, rates.output));
  const reserveMicros = requestPricing ? requestOutcomeReserve(requestPricing, inferenceMicros) : inferenceMicros;
  return reserveMicros == null ? { reserveMicros: 0, inputTokens, outputTokens, pricingAvailable: false } : { reserveMicros, inputTokens, outputTokens };
}

// Bounds without a request: inspect every declared tier/context, including cache
// rates. A zero balance alone cannot exclude output-only or zero-price requests.
export function modelReservationBounds(pricing: ModelPricing): { minimumMicros: number; zero: boolean } {
  if (pricing.unit === "image_token") return { minimumMicros: pricing.imageOutputMicrosPerMillion > 0 ? 1 : 0, zero: pricing.textInputMicrosPerMillion === 0 && pricing.imageInputMicrosPerMillion === 0 && pricing.imageOutputMicrosPerMillion === 0 };
  if (pricing.unit === "character") return { minimumMicros: characterCost(1, pricing), zero: pricing.inputMicrosPerMillionCharacters === 0 };
  const cards = pricing.serviceTiers?.length ? pricing.serviceTiers : [pricing];
  const rates = cards.flatMap((card) => [card, ...(card.longContext ? [card.longContext] : [])]).map(ratesFromPricing);
  const zero = rates.every((rate) => Object.values(rate).every((value) => value == null || value === 0));
  return { minimumMicros: rates.every((rate) => reservationInputRate({}, rate) > 0) ? 1 : 0, zero };
}

export function actualModelCost(pricing: ModelPricing, tokens: PricedTokens, requestFormat?: string): number | null {
  if (unpricedGoogleRequestFormats.has(requestFormat ?? "") || unpricedNativeAudioFormats.has(requestFormat ?? "")) return null;
  if (requestFormat === "google.image_generate" || requestFormat === "google.music_generate"
    || requestFormat === "google.speech_generate_content" || requestFormat === "google.speech_interactions") return null;
  if (pricing.unit === "image_token") return requestFormat === "openai.images_generations" ? actualImageCost(pricing, tokens) : null;
  if (pricing.unit === "character") return null;
  if (tokens.billable === false) return 0;
  if (requestFormat === "cohere.chat" || tokens.billedTokens !== undefined) {
    if (!tokens.billedTokens) return null;
    tokens = { ...tokens, ...tokens.billedTokens, cached: null, cacheWrite: null, cacheWrite5m: null, cacheWrite1h: null };
  }
  if (tokens.input == null) return null;
  const rates = resolveRates(pricing, tokens.input, tokens.serviceTier, false, requestFormat === "google.generate_content");
  if (!rates) return null;
  if (tokens.output == null && rates.output > 0) return null;
  if (rates.cacheWriteInput != null && tokens.cacheWrite == null) return null;
  const cached = Math.min(tokens.input, tokens.cached ?? 0);
  let remaining = Math.max(0, tokens.input - cached);
  const write5m = Math.min(remaining, tokens.cacheWrite5m ?? 0); remaining -= write5m;
  const write1h = Math.min(remaining, tokens.cacheWrite1h ?? 0); remaining -= write1h;
  const genericWrite = Math.min(remaining, Math.max(0, (tokens.cacheWrite ?? 0) - write5m - write1h)); remaining -= genericWrite;
  const write5mRate = rates.cacheWrite5mInput ?? rates.input;
  const write1hRate = rates.cacheWrite1hInput ?? write5mRate;
  const genericWriteRate = rates.cacheWriteInput ?? Math.max(write5mRate, write1hRate);
  return weightedTokenCost([
    [remaining, rates.input],
    [cached, rates.cachedInput ?? rates.input],
    [write5m, write5mRate],
    [write1h, write1hRate],
    [genericWrite, genericWriteRate],
    [tokens.output ?? 0, rates.output],
  ]);
}

export function actualCharacterCost(pricing: ModelPricing | null | undefined, input: unknown): number | null {
  return pricing?.unit === "character" && typeof input === "string"
    ? characterCost([...input].length, pricing) : null;
}

function characterCost(characters: number, pricing: CharacterPricing): number {
  return Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(characters * pricing.inputMicrosPerMillionCharacters / 1_000_000));
}

// Requested tiers choose admission bounds; only the served tier can choose a
// settlement price. OpenAI omitted/auto requests can inherit a paid default;
// native Gemini defaults to Standard and never upgrades Flex.
function resolveRates(pricing: TokenPricing & { autoServiceTier?: "unpriced" }, inputTokens: number, tier: unknown, reserve: boolean, google = false): Rates | null {
  if (google) {
    tier = googleServiceTier(tier);
    if (tier == null) return null;
  }
  const tiers = pricing.serviceTiers;
  // Automatic selection can include contracts absent from the published cards.
  if (tier === "auto" && pricing.autoServiceTier === "unpriced") return null;
  if (!tiers?.length) return !google || tier === "standard" ? contextRates(pricing, inputTokens, reserve) : null;
  const selected = tiers.find((card) => card.id === tier || card.aliases.includes(tier as string));
  if (!reserve) return selected && (selected.maxInputTokens == null || inputTokens <= selected.maxInputTokens)
    ? contextRates(selected, inputTokens, false) : null;
  if (tier != null && tier !== "auto" && !selected) return null;
  const candidates = selected ? tiers.filter((card) => card === selected || ((!google || tier === "priority") && card.id === "default")) : tiers;
  // A byte upper bound may cross a tier's published context limit while actual
  // tokens do not. Its short rates must remain in the admission envelope.
  return candidates.map((card) => contextRates(card, Math.min(inputTokens, card.maxInputTokens ?? inputTokens), true)).reduce(maxRates);
}

function contextRates(pricing: Pick<TokenPricing, keyof TokenRates | "longContext"> | ServiceTierPricing, inputTokens: number, reserve: boolean): Rates {
  const base = ratesFromPricing(pricing), long = pricing.longContext;
  if (!long || inputTokens <= long.thresholdInputTokens) return base;
  const extended = ratesFromPricing(long);
  return reserve ? maxRates(base, extended) : extended;
}

function maxRates(base: Rates, extended: Rates): Rates {
  return {
    input: Math.max(base.input, extended.input),
    output: Math.max(base.output, extended.output),
    cachedInput: maxOptional(base.cachedInput, extended.cachedInput),
    cacheWriteInput: maxOptional(base.cacheWriteInput, extended.cacheWriteInput),
    cacheWrite5mInput: maxOptional(base.cacheWrite5mInput, extended.cacheWrite5mInput),
    cacheWrite1hInput: maxOptional(base.cacheWrite1hInput, extended.cacheWrite1hInput),
  };
}

function reservationInputRate(body: unknown, rates: Rates, owned?: OwnedHttpPricingPlan): number {
  let rate = Math.max(rates.input, rates.cachedInput ?? rates.input, rates.cacheWriteInput ?? rates.input);
  if (owned) {
    // Preserve the ordinary ONE-hour early return, including a larger five-minute
    // rate elsewhere in the same body. These are alternatives, not a combined max.
    if (owned.hour) return Math.max(rate, rates.cacheWrite1hInput ?? rates.input);
    return owned.cache ? Math.max(rate, rates.cacheWrite5mInput ?? rates.input) : rate;
  }
  if (jsonHasCacheTtl(body, "1h")) return Math.max(rate, rates.cacheWrite1hInput ?? rates.input);
  if (jsonHasKey(body, "cache_control")) rate = Math.max(rate, rates.cacheWrite5mInput ?? rates.input);
  return rate;
}

function ratesFromPricing(pricing: TokenRates): Rates {
  return { input: pricing.inputMicrosPerMillion, output: pricing.outputMicrosPerMillion, cachedInput: pricing.cachedInputMicrosPerMillion, cacheWriteInput: pricing.cacheWriteInputMicrosPerMillion, cacheWrite5mInput: pricing.cacheWrite5mInputMicrosPerMillion, cacheWrite1hInput: pricing.cacheWrite1hInputMicrosPerMillion };
}

// Only Responses protocol input items carry this state. Never search literal
// text, function arguments, schemas, or compaction/output-request controls.
// Ciphertext size (including malformed/empty state) cannot bound decoded input.
function responsesHasOpaqueInput(body: Record<string, unknown>): boolean {
  return Array.isArray(body.input) && body.input.some((item) => isObject(item)
    && (item.type === "compaction" || item.type === "reasoning" && Object.hasOwn(item, "encrypted_content")));
}

function opaqueInputLimit(pricing: ModelPricing | null | undefined): number | null {
  if (!pricing || pricing.unit != null) return null;
  const limit = pricing.maxRequestInputTokens ?? pricing.maxInputTokens;
  return typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0 ? limit : null;
}

function requestHasUnboundedInput(body: Record<string, unknown>, images?: InlineImageBound): boolean {
  if (["previous_response_id", "conversation", "prompt"].some((key) => body[key] != null)) return true;
  if (body.input != null && contentHasUnboundedInput(body.input)) return true;
  if (Array.isArray(body.messages) && body.messages.some((message) => isObject(message) && (images && message.role === "user"
    ? claudeUserContentHasUnboundedInput(message.content, images)
    : contentHasUnboundedInput(message.content)))) return true;
  return Array.isArray(body.tools) && body.tools.some((tool) => isObject(tool) && providerAddedTool(tool.type));
}

function googleHasUnboundedInput(body: Record<string, unknown>): boolean {
  if (googleField(body, "cachedContent", "cached_content")) return true;
  return googleContentHasMedia(body.contents) || googleContentHasMedia(googleField(body, "systemInstruction", "system_instruction"));
}

function googleContentHasMedia(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(googleContentHasMedia);
  if (!isObject(value) || !Array.isArray(value.parts)) return false;
  return value.parts.some(part => isObject(part) && (
    googleField(part, "fileData", "file_data") != null || googleField(part, "inlineData", "inline_data") != null
    || googleContentHasMedia(googleField(part, "functionResponse", "function_response"))
  ));
}

// Claude bills an image block as visual tokens only as a direct block of user
// content or of a user tool_result's content. Qualified blocks accumulate into
// `images`; an image-shaped object anywhere else (tool_use input, unknown fields,
// nested results) is billed as text or rejected and keeps the unbounded check.
function claudeUserContentHasUnboundedInput(content: unknown, images: InlineImageBound): boolean {
  if (!Array.isArray(content)) return contentHasUnboundedInput(content);
  return content.some((block) => {
    if (!isObject(block)) return false;
    if (block.type === "tool_result" && Array.isArray(block.content)) {
      return Object.entries(block).some(([key, item]) => key !== "content" && contentHasUnboundedInput(item))
        || block.content.some((item) => !qualifiedClaudeImage(item, images) && contentHasUnboundedInput(item));
    }
    return !qualifiedClaudeImage(block, images) && contentHasUnboundedInput(block);
  });
}

function qualifiedClaudeImage(block: unknown, images: InlineImageBound): boolean {
  const image = isObject(block) ? claudeImageBlockBound(block) : null;
  if (!image) return false;
  images.encodedBytes += image.encodedBytes;
  images.tokens = saturatingAdd(images.tokens, image.tokens);
  return true;
}

function contentHasUnboundedInput(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(contentHasUnboundedInput);
  if (!isObject(value)) return false;
  const kind = typeof value.type === "string" ? value.type : "";
  if (["image", "image_url", "video_url", "document", "file", "input_image", "input_file", "item_reference", "computer_screenshot"].includes(kind)) return true;
  if ("image_url" in value || "video_url" in value || "file_id" in value) return true;
  return Object.values(value).some(contentHasUnboundedInput);
}

function providerAddedTool(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return value.startsWith("web_fetch_") || ["bash_", "text_editor_", "computer_", "memory_"].some((prefix) => value.startsWith(prefix));
}

function jsonHasKey(value: unknown, target: string): boolean {
  if (Array.isArray(value)) return value.some((item) => jsonHasKey(item, target));
  return isObject(value) && (target in value || Object.values(value).some((item) => jsonHasKey(item, target)));
}

function jsonHasCacheTtl(value: unknown, ttl: string): boolean {
  if (Array.isArray(value)) return value.some((item) => jsonHasCacheTtl(item, ttl));
  if (!isObject(value)) return false;
  if (isObject(value.cache_control) && value.cache_control.ttl === ttl) return true;
  return Object.values(value).some((item) => jsonHasCacheTtl(item, ttl));
}

function weightedTokenCost(components: Array<[number, number]>): number {
  return Math.ceil(components.reduce((total, [tokens, rate]) => total + tokens * rate, 0) / 1_000_000);
}

function tokenCost(tokens: number, rate: number): number { return Math.ceil(tokens * rate / 1_000_000); }
function nonNegativeInteger(value: unknown): number | null { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null; }
function saturatingAdd(left: number, right: number): number { return Math.min(Number.MAX_SAFE_INTEGER, left + right); }
function saturatingMultiply(left: number, right: number): number { return left === 0 || right === 0 ? 0 : Math.min(Number.MAX_SAFE_INTEGER, left * right); }
function maxOptional(left: number | null, right: number | null): number | null { return left == null ? right : right == null ? left : Math.max(left, right); }
function isObject(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
