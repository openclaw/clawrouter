import type { ContinuationOwner, PricingEvidence } from "./continuation-store.ts";
import type { ResponseIdentity } from "./response-identities.ts";

export type WebSocketContinuationPin = { providerId: string; endpointId: string; key: string | null; revision: string | null };
type Witness = { scope: string; owner: ContinuationOwner; pin: WebSocketContinuationPin; evidence: PricingEvidence | null };
export const websocketContinuationWitnessLimit = 32;

/** Owned by one socket, containing only acknowledged bindings and final proof. */
export class WebSocketContinuationWitnesses {
  private readonly entries = new Map<string, Witness>();
  private closed = false;

  remember(scope: string, owner: ContinuationOwner, pin: WebSocketContinuationPin, identities: readonly ResponseIdentity[], evidence: PricingEvidence): void {
    if (this.closed || evidence.state !== "final" || pin.key !== owner.grantKey || pin.providerId !== owner.providerId || pin.endpointId !== owner.endpointId) return;
    for (const identity of identities) {
      const key = JSON.stringify([identity.kind, identity.value]);
      this.entries.delete(key);
      this.entries.set(key, { scope, owner: { ...owner }, pin: { ...pin }, evidence: identity.kind === "response" ? { ...evidence } : null });
      if (this.entries.size > websocketContinuationWitnessLimit) this.entries.delete(this.entries.keys().next().value!);
    }
  }

  resolve(identities: readonly ResponseIdentity[], scope: string, generation: string, providerId: string, endpointId: string, pin?: WebSocketContinuationPin): { owners: ContinuationOwner[]; evidence: Array<PricingEvidence | null> } | undefined {
    if (this.closed || !pin) return;
    const witnesses: Witness[] = [];
    for (const identity of identities) {
      const witness = this.entries.get(JSON.stringify([identity.kind, identity.value]));
      if (!witness || witness.scope !== scope || witness.owner.policyGeneration !== generation
        || witness.owner.providerId !== providerId || witness.owner.endpointId !== endpointId
        || witness.pin.providerId !== pin.providerId || witness.pin.endpointId !== pin.endpointId
        || witness.pin.key !== pin.key || witness.pin.revision !== pin.revision) return;
      witnesses.push(witness);
    }
    return { owners: witnesses.map(value => value.owner), evidence: witnesses.map(value => value.evidence) };
  }

  close(): void { this.closed = true; this.entries.clear(); }
}
