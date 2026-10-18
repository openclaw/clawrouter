import type { AuthorizedIdentity } from "./types";

const durations = new WeakMap<AuthorizedIdentity, number>();
export function recordAdmissionDuration(identity: AuthorizedIdentity, start: number): void { durations.set(identity, performance.now() - start); }
export function admissionDuration(identity: AuthorizedIdentity): number { return durations.get(identity) ?? 0; }
