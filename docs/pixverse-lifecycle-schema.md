# PixVerse lifecycle schema

The closed `pixverse.video` declaration qualifies text-video creation and scoped
retrieval against `createPixVerseManagedAdapter("text")` and the actual native
fixture. It does not register an adapter, add a provider manifest/model or activate
a generated snapshot. The new PixVerse YAML remains owned by its provider lane.

| Action | Method and path | Request format | Response format |
| --- | --- | --- | --- |
| Create | POST `/openapi/v2/video/text/generate` | `pixverse.text_video` | `pixverse.video` |
| Retrieve | GET `/openapi/v2/video/result/${video_id}` | `pixverse.video_get` | `pixverse.video` |

Create declares `lifecycle: {protocol: pixverse.video, retrieve: <endpoint>}`.
No result/cancel/upload link is accepted. Retrieval has exactly one segment
parameter, no query, no independent capability and no endpoint credential/header
overrides. Regional bases are the source-qualified international and China origins;
authentication is the selected original `API-KEY` credential.

Every actual create/control attempt gets a new adapter-generated `Ai-trace-id`.
The runtime owns credential application and ignores that transient trace value
when checking durable route identity. Static manifest or caller-forwarded trace
headers are rejected. These compiler tests do not prove durable dispatch.

Status 6 is `observationUnavailable: deleted`, with no native terminal verdict or
refund. Status 5 stays pending even with an output URL. Generation success without
deliverable media is separate from delivery success. Preliminary credits never
establish dollars; unknown whole-request cost remains unqualified under upstream
hard budgets, with explicit policy-fixed charging separate.

Image creation/upload formats deliberately remain closed until the shared runtime
publishes and tests its durable original caller/policy/provider/region/credential
upload binding. A caller's `img_id` cannot become a trusted factory argument. The
image adapter's current rejection and mismatch behavior are executable prerequisites,
not proof that uploading is implemented. Combining text/image native retrieval
also requires the runtime to resolve the original create route from scoped job
ownership without choosing the first matching duplicate native path.

Activation requires registered wrappers, fresh per-control headers, the shared
observation-loss transition, original credential checks, deadlines, uncertain-create
no-replay behavior and exactly-once settlement. Actual Worker/client proof and
serialized snapshot integration follow those bindings. See the primary sources
and frozen model constraints in [the source contract](pixverse-lifecycle-contract.md).
