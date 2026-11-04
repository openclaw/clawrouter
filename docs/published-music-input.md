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

`POST /v1/input-assets/openrouter/music` authenticates a proxy key before reading
the body. It accepts the same native music plan with one inline image and a
bounded `Idempotency-Key`. It returns `{url, expiresAt, receiptId}` only after the
immutable archive and scoped receipt acknowledge publication. A repeated key
cannot mint a replacement URL, even after a lost response. No archive recovery
or automatic re-upload runs in the background.

The caller replaces only the image slot with that exact URL and submits the
same plan through the registered native or manifest music route. The receipt
pins the original managed key; environment and alternate-grant fallback are
forbidden. The forwarding slice requires reserve-mode admission. Unknown native
USD pricing remains denied under hard budgets; explicit policy-fixed cost is
recorded separately. Logging, when required by the current policy, replaces the
bearer URL with a non-secret receipt ID.

The credential owner validates bounded forwarding bytes before entering its
existing mutation ordering. Under that ordering it checks the original record,
current issuer/policy and fixed destination. The receipt's forwarding claim is
the last await. Synchronous expiry checks immediately precede the single fetch;
the credential ordering releases after fetch starts, not after the response.
The receipt owner never calls back into the held credential owner. A definitive
losing claim is unsent; an unavailable claim acknowledgment retains uncertainty.

Publication borrows the existing 64 MiB ingress charge through decoded-image
validation, hash snapshots, the bounded archive stream and actual cancellation.
Forwarding accepts at most 256 KiB of URL-bearing native JSON. Its phase transfer
holds 12 MiB for parsed/serialized input owners and 64 MiB for the existing
32 MiB wire/16 MiB audio quarantine. The credential-owner hop reserves 4 MiB
before preparation and holds it through actual upstream EOF/cancel. One
delegated GET reserves 16 MiB. These explicit charges total the existing 96 MiB
pool; contention refuses work before the paid attempt. GET uses bounded output
copies and never detaches the retained archive input backing.

The input and response leases retire after their respective real owners finish.
Upstream DONE does not release the response charge while the Worker still owns
downstream bytes. Test-controlled incoming cancellation is separate from a
physical host disconnect. Maximum-size actual workerd execution and all native
gates remain required; authored tests are not qualification or activation.

Permission normalization comes from `shared/input-publication.ts`. The runtime
binds its canonical sorted object and UTC precision. It does not claim to detect
duplicate serialized JSON member names; the existing admin parser remains
last-key-wins. Unknown fields and duplicate model entries remain denied by the
policy normalizer. Manifest metadata remains `https: false` until the separate
qualified declaration/consumer follow-through.
