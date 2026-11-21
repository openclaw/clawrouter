# Input publication policy

`AccessPolicy.inputPublication` is an optional, default-deny permission, separate
from upstream retention, router content logging, PixVerse input ownership and
credential configuration. It does not publish data or authorize a receipt,
credential, grant, storage object or upstream request by itself.

```ts
interface InputPublicationPolicy {
  version: "clawrouter.input-publication.v1";
  allow: Array<{
    providerId: "openrouter";
    endpointId: "music_generate";
    modelId: "openrouter/google/lyria-3-pro-preview" | "openrouter/google/lyria-3-clip-preview";
    publish: boolean;
    forward: boolean;
    expiresAt: string;
  }>;
}
```

The closed record accepts at most two distinct model entries. Both booleans must
be present; neither implies the other. Combined music publication and forwarding
requires both to be `true` for the exact selected provider, endpoint and model.
Unknown fields, versions, models, duplicate model entries and invalid or expired
timestamps invalidate the whole record. An empty list permits nothing.

Expiry is strict UTC: `YYYY-MM-DDTHH:mm:ssZ` or
`YYYY-MM-DDTHH:mm:ss.SSSZ`, with a valid calendar date and a finite instant strictly
after the check time. Normalization clones entries, sorts by model ID and renders
expiry with millisecond precision. Source owners can bind a digest of this
canonical value without depending on caller field order or optional zero precision.

`shared/input-publication.ts` exports:

- `normalizeInputPublicationPolicy(value, now?)`: strict write validation; null or
  absent input clears permission, invalid explicit input throws.
- `readInputPublicationPolicy(value, now?)`: the canonical record or `null` on any
  invalid, absent or expired input.
- `allowsInputPublicationAndForwarding(value, providerId, endpointId, modelId, now?)`:
  checks the exact target and both permissions, including expiry at each use.

Admin writes retain an omitted existing valid permission and clear explicit
`null`. Malformed or expired existing permission is dropped on unrelated updates
and reads. Policy materialization uses the same fail-closed reader. Old policies
remain compatible; other policy fields and defaults are unchanged.

Admin JSON parsing retains existing last-key-wins semantics. Object validation
does **not** detect duplicate serialized JSON member names. Wire duplicate-name
detection is a separate existing-parser follow-up, not proof supplied here.

Publication runtime remains separately owned. It must bind the canonical
permission and original policy generation, caller, grant lineage, destination and
expiry, with fresh checks at publication and forwarding. This policy-only change
does not activate provider declarations, receipts, public URLs or snapshot offers.
