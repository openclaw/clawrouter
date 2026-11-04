# MiniMax image authorization

The prompt-only `minimax.images` runtime uses the existing native image wrapper
and the registered `image-01` model at
`https://api.minimax.io/v1/image_generation`. Native and manifest requests share
the same authorization and accounting path. Provider declarations and actual
client integration are separate work; this change adds no provider card.

An authorized administrator must explicitly set
`minimaxImageAuthorization: "minimax-global-image"` on the original MiniMax
API-key grant. This attests that the selected scalar `credential` is intended
for this global image operation. Speech, Messages, OAuth, TokenPlan, environment
configuration, caller headers and provider metadata cannot supply that authority.
The administrator can remove it with `minimaxImageAuthorization: null`.

The private owner stores `clawrouter.minimax-image.v1`, bound to the global origin,
`minimax.images`, `image-01`, API-key kind and the exact scalar credential slot.
Omitted intent preserves the binding only for the same owner, credential,
account, provider, kind and lineage. Replacement, key/account rotation, explicit
removal, revocation and OAuth completion do not inherit it. Legacy or forged
metadata projects a null binding. No secret value enters the routing projection
or public catalog.

Hard-budget validation precedes materialization. Dispatch qualifies current
caller policy and the original owner, then materializes only that exact owner
generation and lineage without credential-cache or environment fallback. After
all budget and retention waits, it repeats current policy and owner checks before
fetch. This is fresh-at-check authorization, not a claim of instantaneous
revocation between the owner reply and network dispatch.

The unchanged wrapper accepts at most 16 KiB JSON, rejects every
`subject_reference`, and returns complete validated native base64 JSON only.
It holds a 64 MiB response charge in the existing 96 MiB pool through downstream
EOF or cancellation. The image-only input relay also retains that charge until
the upstream read, cancellation acknowledgement and reader-lock retirement
finish; initiating cancellation alone does not retire input ownership.
The operational response limits remain 8 MiB JSON and
4 MiB combined decoded data; they are not vendor entitlements. No PNG/JPEG
binary response or playback claim is made.

There is no qualified upstream image tariff. Hard dollar budgets deny unknown
cost; an explicit policy-fixed charge is separately labeled. Known-unsent
failure settles zero. Possibly paid, malformed or interrupted responses retain
the conservative reservation and never trigger a paid retry. Tokens remain
unknown. References, URLs, CN routing and music authority remain closed.
