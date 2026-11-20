# Together managed route wrapper

`worker/managed-together-wrapper.ts` exports `togetherManagedAdapter` and the
common registry selects it for `together.video` / `together.video_create`.
It wraps the frozen codec from `worker/managed-together.ts`; it does not add a
second job store, controller, native client or tariff. The existing codec fixture
`providers/_fixtures/together/video.json` remains the wire contract.

The landed schema qualifies POST `/v2/videos` and original-job GET
`/v2/videos/${video_id}`. The wrapper checks the selected Together origin and native
Bearer header synchronously before every dispatch. `https://api.together.xyz` and
`https://api.together.ai` are individually eligible origins; this is not permission
to switch origins or accounts after creation. DashScope/Wan and MiniMax credentials
cannot substitute. The shared controller retains caller, original route, model,
credential, policy, reservation and idempotency authority. A raw video ID grants
no control access.

Both [create](https://docs.together.ai/reference/create-videos) and
[retrieve](https://docs.together.ai/reference/get-videos-id) document HTTP 200 JSON.
The wrapper requires a complete, nonredirected, nonrange response of at most 1 MiB,
valid UTF-8 and a consistent unencoded Content-Length. Only then does the existing
codec inspect the bounded internal JSON envelope. Controller deadlines and fetched
response cancellation remain runtime responsibilities; the wrapper performs no I/O
and never retries a POST. Prepared request bodies are detached from caller mutation.

Only original-job retrieval is supported. Result, cancellation and authenticated
file routes remain unavailable. Rewriting requires a valid scoped public retrieve
path and removes native control URLs. Output URLs remain transient opaque data;
this wrapper never fetches them or sends a Together credential to an asset host.
The three finite models and first-frame constraints are unchanged from the
[codec contract](together-video-contract.md).

ID-only create acknowledgments and `in_progress` are nonterminal. Only validated
`completed` or `failed` observations settle execution state. Missing output,
expired/unknown status, malformed transport, credential loss and identity mismatch
are not evidence of free generation, refunds or safe resubmission. Native output
cost hints do not become upstream-dollar prices. `policy_fixed` accounting remains
separate; unknown upstream cost must remain closed under upstream-dollar hard
budgets. No new retention guarantee is inferred.

## Activation handoff

- Source 3 owns the existing Together manifest: typed create/retrieve endpoints,
  the three explicit unpriced model rows and model/capability eligibility. Do not
  publish an independent raw-ID read capability or unsupported result/cancel route.
- Source 1 owns existing BackgroundStore admission, original-grant controls,
  uncertain-create handling, terminal settlement and outbox behavior.
- Source 2 owns the actual native consumer and bounded asset downloader. Source 6
  owns snapshot serialization and Worker/client integration evidence.

The registry now resolves this protocol to a concrete wrapper. The bundled Together
manifest still has no video declaration in this change, so registry availability
alone is not an activated offer or end-to-end parity proof. No live paid call,
production deployment, secret change or existing YAML change is included.

## Verification

`worker/test/managed-together-wrapper.test.mjs` exercises registry selection,
origin/auth/route fences, detached input, bound control paths, native state and
identity, complete transport, producer cancellation, required retrieve and opaque
outputs. Run it with `worker/test/managed-together.test.mjs` for the frozen codec
fixtures. Hosted native CI additionally checks the actual TypeScript graph and
repository integration gates.
