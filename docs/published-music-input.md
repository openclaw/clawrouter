# Published OpenRouter music input

This work adds a distinct publication receipt for the existing OpenRouter music
reference-image slot. It does not grant permission to fetch arbitrary URLs or
reuse a PixVerse input. HTTPS route activation remains closed during qualification.

The caller policy must explicitly permit both publication and forwarding for
the selected `music_generate` endpoint and one of the two registered Lyria model
IDs. `inputPublication` is separate from request logging and upstream retention.
The receipt binds the exact permission digest, policy generation, issuer,
original managed API-key generation and lineage, route, model, slot, request
digest, image digest/MIME/size, public origin and minimum expiry.

The private scoped owner stores only bounded metadata. Publication transitions
from `pending` to `publication_unknown` before the single archive write. A
validated immutable object acknowledgment permits `published`. The single
destination attempt changes it to `forwarding_unknown` before the paid POST.
A lost acknowledgment never permits another write, a replacement verifier,
another paid POST or a refund. Expiry does not reset claims.

Publication records use the existing bounded `responses_background` table with
distinct phases and no due time. They are excluded from generation lookup,
listing, collection, alarms and financial replay. The scope retains expired
records as replay guards; capacity exhaustion denies new allocation. No new
store, index, queue or background asset recovery is introduced.

Bearer GET authority comes from a verifier-matched durable receipt, not a
fabricated caller identity. Its original issuer is checked against the existing
authoritative authorization snapshot. Local sessions also retain their current
logout check. The original grant is inspected without credential materialization
or fallback. Cloudflare Access expiry and local authority are checked; this does
not claim an instantaneous external IdP revocation check.

These are fresh-at-check guarantees. Revocation after an authoritative check
cannot retract an already authorized attempt or bytes already delivered. The
URL deliberately delegates bearer read authority and cannot identify its
retriever. Raw verifier URLs must not enter logging or retained request content.

The source3-owned permission module, public intake, immutable archive transport,
delegated GET and common forwarding integration are separate remaining pieces
of this same execution route. Private state tests alone do not qualify them.
