# Omni managed registry integration

The registry now selects `googleOmniManagedAdapter` for protocol
`google.omni_video` and create format `google.omni_video_create`. The existing
source-owned wrapper exposes its qualified file factory through the actual
`ManagedLifecycleAdapter.files` field. No second controller or file authority
store is introduced. This consumes the landed per-job permissions, managed file
runtime and Interactions/file schema contracts.

The wrapper retains original `background` and `store` flags. Unstored jobs expose
no retrieve control; stored foreground jobs expose retrieve only; background jobs
require storage and may expose cancellation. Native codec paths are translated to
the schema's `/v1beta` prefix. Completed files derive only from qualified original
successful observations; metadata and ACTIVE-only download remain bound to the
original caller/job/model/credential and selected origin/API prefix. Foreign URLs,
raw file IDs and output `_links` grant no authority. File failure does not prove
free generation; observation loss stops continuation without inventing a refund.

`worker/test/omni-registry.test.mjs` exercises the actual registry through create,
observation, file metadata, download preparation and output rewriting. Existing
wrapper/file tests now assert the registered factory. The new
`worker/test/omni-registry-compiler.test.mjs` compiles the published endpoint links
and runs the actual shared route/file helpers, including per-job public paths,
selected-origin checks and rejection of unbound outputs. It does not replace the
runtime owner's durable Worker/SQLite tests or source 6's consumer acceptance.

The existing Google manifest is unchanged. Source 3 owns the eventual Omni model
and linked endpoint declarations; source 6 owns snapshots and integration proof.
Registration is necessary routing code, not an advertised live offer. Unknown
upstream video costs remain closed under hard budgets and policy_fixed accounting
stays separate. No paid call, deployment, secret change, implicit previous-interaction
reference, upload binding or new model discovery is added. Retired Veo routes are
not registered or aliased; their fixtures remain historical-only.
