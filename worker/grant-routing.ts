import { boundedPercent, GRANT_SELECTION_STRATEGIES } from "./grant-selection-strategies.ts";
import type { GrantRoutingPolicy } from "./types";

export const DEFAULT_GRANT_ROUTING: GrantRoutingPolicy = {
  strategy: "most_remaining",
  stickiness: "none",
  failover: true,
  environmentFallback: false,
  includedQuotaReservePercent: 0,
  staleState: "allow",
  staleAfterSeconds: 300,
  switchAtUsedPercent: 90,
  hysteresisPercent: 10,
  eligibleGrants: {},
};

export function grantRoutingPolicy(input: unknown): GrantRoutingPolicy {
  const value = input && typeof input === "object" && !Array.isArray(input) ? input as Partial<GrantRoutingPolicy> : {};
  const eligibleGrants: Record<string, string[]> = {};
  const sharedGrants: Record<string, string[]> = {};
  let sharedCount = 0;
  if (value.sharedGrants && typeof value.sharedGrants === "object" && !Array.isArray(value.sharedGrants)) {
    for (const [providerId, keys] of Object.entries(value.sharedGrants)) {
      if (!validGrantSegment(providerId) || !Array.isArray(keys)) continue;
      sharedGrants[providerId] = [...new Set(keys.filter((key): key is string => typeof key === "string" && validGrantKey(key)))].slice(0, 32 - sharedCount).sort();
      sharedCount += sharedGrants[providerId].length;
    }
  }
  if (value.eligibleGrants && typeof value.eligibleGrants === "object" && !Array.isArray(value.eligibleGrants)) {
    for (const [providerId, refs] of Object.entries(value.eligibleGrants)) {
      if (!validGrantSegment(providerId) || !Array.isArray(refs)) continue;
      eligibleGrants[providerId] = [...new Set(refs.filter((ref): ref is string => typeof ref === "string" && validGrantSegment(ref)))].slice(0, 32).sort();
    }
  }
  const strategy = (GRANT_SELECTION_STRATEGIES as readonly unknown[]).includes(value.strategy) ? value.strategy! : DEFAULT_GRANT_ROUTING.strategy;
  return {
    strategy,
    stickiness: strategy === "threshold" ? "none" : ["none", "identity", "session"].includes(value.stickiness ?? "") ? value.stickiness! : DEFAULT_GRANT_ROUTING.stickiness,
    failover: value.failover !== false,
    environmentFallback: value.environmentFallback === true,
    includedQuotaReservePercent: Number.isInteger(value.includedQuotaReservePercent) && value.includedQuotaReservePercent! >= 0 && value.includedQuotaReservePercent! <= 50 ? value.includedQuotaReservePercent! : 0,
    staleState: value.staleState === "deny" ? "deny" : "allow",
    staleAfterSeconds: Number.isSafeInteger(value.staleAfterSeconds) && value.staleAfterSeconds! >= 30 && value.staleAfterSeconds! <= 86_400 ? value.staleAfterSeconds! : DEFAULT_GRANT_ROUTING.staleAfterSeconds,
    switchAtUsedPercent: boundedPercent(value.switchAtUsedPercent, DEFAULT_GRANT_ROUTING.switchAtUsedPercent),
    hysteresisPercent: boundedPercent(value.hysteresisPercent, DEFAULT_GRANT_ROUTING.hysteresisPercent),
    eligibleGrants,
    ...(Object.keys(sharedGrants).length ? { sharedGrants } : {}),
  };
}

export function validGrantSegment(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !value.includes("/") && !/[\u0000-\u001f\u007f]/.test(value);
}

export function validGrantKey(value: string): boolean {
  const parts = value.split("/");
  return parts[0] === "oauth" && (parts[1] === "tenants" ? parts.length === 4 : parts.length === 3)
    && parts.slice(1).every(validGrantSegment);
}

// PRIVATE bridge only. No whole-key vector or slash-segment array is created.
// The ordinary exports above retain their original behavior.
export function privateGrantKey(value: string): boolean {
  if (value.length > 527 || !value.startsWith("oauth/")) return false;
  const middle = value.indexOf("/", 6);
  if (middle < 0) return false;
  const tenant = middle === 13 && value.startsWith("tenants", 6);
  const last = tenant ? value.indexOf("/", middle + 1) : middle;
  if (last < 0 || value.indexOf("/", last + 1) !== -1) return false;
  const segment = (start: number, end: number): boolean => {
    if (end - start < 1 || end - start > 256) return false;
    for (let i = start; i < end; i++) { const code = value.charCodeAt(i); if (code < 32 || code === 127 || code === 47) return false; }
    return true;
  };
  return segment(6, middle) && (!tenant || segment(middle + 1, last)) && segment(last + 1, value.length);
}

// A borrowed JSON array is read only. Duplicate checks revisit source positions;
// the only retained prefix is the final generated output, never a Set/index.
export function* privateUniqueStrings(values: unknown[], maximum: number, valid: (value: string) => boolean): Generator<string> {
  let count = 0;
  for (let i = 0; i < values.length && count < maximum; i++) {
    const value = values[i];
    if (typeof value !== "string" || !valid(value) || values.indexOf(value) !== i) continue;
    count++; yield value;
  }
}
function privateRoutingInput(input: unknown): Partial<GrantRoutingPolicy> {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Partial<GrantRoutingPolicy> : {};
}
function privateRoutingScalars(value: Partial<GrantRoutingPolicy>) {
  const strategy = (GRANT_SELECTION_STRATEGIES as readonly unknown[]).includes(value.strategy) ? value.strategy! : DEFAULT_GRANT_ROUTING.strategy;
  return { strategy,
    stickiness: strategy === "threshold" ? "none" as const : ["none", "identity", "session"].includes(value.stickiness ?? "") ? value.stickiness! : DEFAULT_GRANT_ROUTING.stickiness,
    failover: value.failover !== false, environmentFallback: value.environmentFallback === true,
    includedQuotaReservePercent: Number.isInteger(value.includedQuotaReservePercent) && value.includedQuotaReservePercent! >= 0 && value.includedQuotaReservePercent! <= 50 ? value.includedQuotaReservePercent! : 0,
    staleState: value.staleState === "deny" ? "deny" as const : "allow" as const,
    staleAfterSeconds: Number.isSafeInteger(value.staleAfterSeconds) && value.staleAfterSeconds! >= 30 && value.staleAfterSeconds! <= 86_400 ? value.staleAfterSeconds! : DEFAULT_GRANT_ROUTING.staleAfterSeconds,
    switchAtUsedPercent: boundedPercent(value.switchAtUsedPercent, DEFAULT_GRANT_ROUTING.switchAtUsedPercent),
    hysteresisPercent: boundedPercent(value.hysteresisPercent, DEFAULT_GRANT_ROUTING.hysteresisPercent) };
}
// Structural planner is supplied by the private owner, avoiding a runtime import
// from the shared ordinary routing module back into authority/identity modules.
type PrivateRoutingPlan = Pick<ReturnType<typeof import("./identity-admission.ts").identityPlan>, "object" | "array">;
export function planPrivateGrantRouting(input: unknown, plan: PrivateRoutingPlan, depth: number): void {
  const value = privateRoutingInput(input), scalars = privateRoutingScalars(value);
  const eligible = value.eligibleGrants, shared = value.sharedGrants;
  let sharedOwn = false;
  if (shared && typeof shared === "object" && !Array.isArray(shared)) for (const key in shared) if (Object.hasOwn(shared, key) && key !== "__proto__" && validGrantSegment(key) && Array.isArray(shared[key])) { sharedOwn = true; break; }
  plan.object(depth, field => {
    for (const key in scalars) field(key, scalars[key as keyof typeof scalars]);
    field("eligibleGrants", undefined, () => plan.object(depth + 1, provider => {
      if (eligible && typeof eligible === "object" && !Array.isArray(eligible)) for (const key in eligible) {
        if (!Object.hasOwn(eligible, key) || !validGrantSegment(key) || !Array.isArray(eligible[key]) || key === "__proto__") continue;
        provider(key, undefined, () => plan.array(depth + 2, entry => { for (const ref of privateUniqueStrings(eligible[key], 32, validGrantSegment)) entry(ref); }));
      }
    }));
    if (sharedOwn) field("sharedGrants", undefined, () => plan.object(depth + 1, provider => {
      let total = 0;
      for (const key in shared) {
        if (!Object.hasOwn(shared, key) || !validGrantSegment(key) || !Array.isArray(shared![key])) continue;
        const maximum = 32 - total;
        if (key === "__proto__") { for (const _ of privateUniqueStrings(shared![key], maximum, privateGrantKey)) total++; continue; }
        provider(key, undefined, () => plan.array(depth + 2, entry => { for (const ref of privateUniqueStrings(shared![key], maximum, privateGrantKey)) { entry(ref); total++; } }));
      }
    }));
  });
}
export function privateGrantRoutingPolicy(input: unknown, admit: (emit: (plan: PrivateRoutingPlan, depth: number) => void) => void): GrantRoutingPolicy {
  // The complete generated dictionary/prefix vector is admitted BEFORE output
  // arrays/dictionaries. Fixed scalar/visitor products use the factory window.
  admit((plan, depth) => planPrivateGrantRouting(input, plan, depth));
  const value = privateRoutingInput(input), eligibleGrants: Record<string, string[]> = {}, sharedGrants: Record<string, string[]> = {};
  let sharedCount = 0, sharedOwn = false;
  if (value.sharedGrants && typeof value.sharedGrants === "object" && !Array.isArray(value.sharedGrants)) for (const key in value.sharedGrants) {
    if (!Object.hasOwn(value.sharedGrants, key) || !validGrantSegment(key) || !Array.isArray(value.sharedGrants[key])) continue;
    const prefix = Array.from(privateUniqueStrings(value.sharedGrants[key], 32 - sharedCount, privateGrantKey)); prefix.sort();
    sharedGrants[key] = prefix; sharedCount += prefix.length;
    if (key !== "__proto__") sharedOwn = true; // match Object.keys, including later EMPTY properties
  }
  if (value.eligibleGrants && typeof value.eligibleGrants === "object" && !Array.isArray(value.eligibleGrants)) for (const key in value.eligibleGrants) {
    if (!Object.hasOwn(value.eligibleGrants, key) || !validGrantSegment(key) || !Array.isArray(value.eligibleGrants[key])) continue;
    const prefix = Array.from(privateUniqueStrings(value.eligibleGrants[key], 32, validGrantSegment)); prefix.sort(); eligibleGrants[key] = prefix;
  }
  return { ...privateRoutingScalars(value), eligibleGrants, ...(sharedOwn ? { sharedGrants } : {}) };
}
