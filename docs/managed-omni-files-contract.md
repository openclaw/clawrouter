# Managed Omni file wrapper

`worker/managed-file-adapters.ts` exports
`managedFileAdapter(protocol): ManagedFileAdapter | undefined` against the
published PR509 shared interface. Only `google.omni_video` resolves. It reuses
the source-owned Omni codec; no second file reader, account store or job index
is introduced.

The factory is not route activation. `worker/managed-google-omni-wrapper.ts`
exports `googleOmniManagedAdapter`, attaching the factory through the actual
optional `ManagedLifecycleAdapter.files` field from PR517 at
`03cbd8ca1839326491ead37030cccdd8f7bccacf`. The wrapper retains background/store,
restricts controls by those original flags and translates the exact schema
`/v1beta` prefix. PR517 has landed; PR518 builds on main without editing that runtime source.
Existing `managed-lifecycle-adapters.ts` and Google manifests remain unchanged. Do not
advertise a file or video offer until the original-job dispatcher and all linked
endpoints are qualified together.

## Descriptor and delivery contract

Call `describe` only on the original job's validated succeeded observation,
using its original selected base. It checks interaction/model/status identity,
validates every URI against the selected origin and API prefix, ignores inline
video and returns deduplicated `{id, mimeType}` descriptors. A subsequent inline
result returns an empty list; the existing durable append rules preserve earlier
URI descriptors. Neither a response-supplied URL nor `observation.files` becomes
authority.

`identify` accepts only `file_id`; metadata has no query, download requires exactly
`alt=media`. This parses a selector, not ownership. Runtime must first resolve
`x-clawrouter-job-id` through the authenticated caller's scoped original job and
require the file descriptor there. Never use an arbitrary raw file ID or a
current credential-pool fallback.

`control` verifies PR500's exact GET schema links under `/v1beta/files/`.
It returns only a path/query relative to the original selected base. Download
requires the same descriptor's validated ACTIVE state. Metadata readers retain
only native name/state; upstream URI/download fields cannot choose egress.
PROCESSING requires runtime-bounded polling. FAILED describes file delivery,
not generation execution, a new settlement or a refund.

The source byte reader preserves exact bytes under the runtime's chosen limit.
The wrapper additionally rejects content ranges and MIME drift. Redirects,
partial status, empty/truncated bodies and over-limit bytes fail. Runtime owns
AbortSignal/deadline enforcement for stalled streams and must enforce one total
deadline across metadata and content; these pure methods do not dispatch fetch.

`rewrite` substitutes only validated output-video URIs with trusted relative
download paths after descriptor binding. Unbound outputs fail. Inputs, thoughts,
inline bytes and the original body are preserved; public paths must not derive
from caller Host. Returned native file paths still require the original job
selector header at the actual client. Rewriting is not proof of authorization.

## Acceptance handoff

Fixture: `providers/_fixtures/google-omni/managed-files.json`, reusing native
lifecycle states from `providers/_fixtures/google-omni/video.json`.
Tests: `worker/test/managed-file-adapters.test.mjs`.

Source 11.1 owns lifecycle.files, dispatcher attachment points, authenticated
original-job/file selection, original credential/revocation checks, atomic
descriptor persistence, deadlines and Worker/SQLite cross-job and settlement
proof. Source 11.5 owns the factory and concrete lifecycle wrapper.
Source 11.3 owns existing Google declarations/endpoint links. Source 11.2 owns
the real consumer selector/header and byte delivery. Source 11.6 owns actual
client/Worker proof and serialized snapshot activation.

No live calls, deployment, credential creation or price qualification occur here.
Unknown upstream cost remains unknown; policy-fixed billing is a separate basis.
Retired Veo identities stay historical and cannot resolve through this factory.

PR517 limits actual delivery to manifest-declared HTTPS origins, 64KiB metadata,
16MiB content and one 30-second cancellation-aware deadline. A pure codec's
ability to validate a selected proxy prefix does not authorize custom proxy
dispatch. Native file delivery still requires final-head runtime/endpoint tests
and real consumer proof before registry activation.

Source contracts: [managed file binding](managed-file-binding.md),
[Omni schema](google-omni-lifecycle-schema.md) and
[Omni wire evidence](google-omni-video-contract.md).

