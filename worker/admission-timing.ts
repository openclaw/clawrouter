import type { HotCacheState } from "./hot-cache.ts";
import type { AuthorizedIdentity } from "./types";

const durations = new WeakMap<AuthorizedIdentity, { ms: number; cache: HotCacheState }>();
export function recordAdmissionDuration(identity: AuthorizedIdentity, start: number, cache: HotCacheState = "off"): void { durations.set(identity, { ms: performance.now() - start, cache }); }
export function admissionDuration(identity: AuthorizedIdentity): number { return durations.get(identity)?.ms ?? 0; }
export function admissionCacheState(identity: AuthorizedIdentity): HotCacheState | undefined { return durations.get(identity)?.cache; }

// Credential owner wait for the selected grant (0 on an isolate cache hit).
const credentialWaits = new WeakMap<AuthorizedIdentity, { ms: number; cache: HotCacheState }>();
export function recordCredentialWait(identity: AuthorizedIdentity, cache: HotCacheState, ms: number): void { credentialWaits.set(identity, { ms, cache }); }
export function credentialWait(identity: AuthorizedIdentity): { ms: number; cache: HotCacheState } | undefined { return credentialWaits.get(identity); }
