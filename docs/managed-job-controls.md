# Per-job managed controls

The existing managed controller retains non-secret job flags in the scoped
BackgroundStore route, alongside declared URL parameters. These flags are not
URL placeholders, caller authorization or a new job index.

A source-owned adapter can declare `retainedParams` and a synchronous
`allowedControls(pathParams)` function. Declare both or neither. The function
returns a unique subset of the manifest's retrieve/result/cancel actions. Result
and cancellation require retrieval. The runtime validates the scalar bounds,
pins sorted flags and the permitted control routes in the original route digest,
and applies the subset before public preflight or original-credential dispatch.
Changing flags, policy, grant lineage, regional origin or route configuration
cannot promote a previously admitted job. Existing adapters without this opt-in
retain their existing route hashes.

`ManagedPublicPaths.retrieve` is optional: a completed unary operation can expose
no controls. Source wrappers must validate the paths their protocol requires.
An idempotent retry without a retrieve route returns the existing local job
locator, never repeats creation and never invents a polling URL.

## Gemini Omni wrapper handoff

Use the source-owned `googleOmniVideoManagedAdapter` from
`worker/managed-google-omni.ts`. The registry wrapper retains exactly
`["background", "store"]`. Validate their original boolean-string values and
reject background=true/store=false. Return:

- store=false: no controls;
- store=true/background=false: retrieve;
- store=true/background=true: retrieve and cancel.

Preserve the codec's unary defaults; do not silently enable upstream storage.
The common protocol union accepts `google.omni_video`; the compiled lifecycle
type also carries the source schema's optional `files: {metadata, download}` links.
Those links alone do not implement file dispatch. The three native statuses
requires_action, requires_continuation and incomplete already map to the existing
expired_or_unknown observation-loss transition. That transition stops polling,
freezes conservative policy_fixed accounting once and never replays creation.
It does not assert expiry, execution failure or free generation.

This foundation does not register a Google route or expose raw file IDs. File
state/download must bind descriptors extracted from the original interaction's
model_output to that same caller/job/model/credential before delivery. A later
inline GET must not erase the initial file descriptor. File processing failure
must not revise generation settlement. Schema, registry and serialized snapshot
activation remain with their existing owners after runtime qualification.
