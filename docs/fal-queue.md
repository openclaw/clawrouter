# fal queue protocol

`worker/fal-queue.ts` and `providers/_fixtures/fal/queue-lifecycle.json` are the
concrete protocol slice for scoped async integration. They do not expose a provider
manifest or activate raw request-ID control routes. Run the dependency-free tests
with `node --test worker/test/fal-queue.test.mjs`.

The runtime must bind caller, policy, original credential, model endpoint, request
digest and accounting facts before exposing a submitted ID. A lost submit response
cannot safely be retried. Parse the submit ID independently of status, which older
envelopes omit. Construct control URLs from `FAL_QUEUE_ORIGIN` and `falQueuePaths`:
submit retains the model subpath; controls use only owner/app. Resolve ownership
before GET status/result or PUT cancel, keep the original credential, prohibit
redirects, and replace exposed URLs with scoped router routes. Never use URLs from
upstream envelopes to send credentials.

The adapter rejects submission queries and requests no upstream automatic retries.
Its 600-second start timeout does not limit runtime. Webhooks and status SSE need
separate integration. `COMPLETED` includes failures: retrieve the result and qualify
its model-specific schema before successful settlement. Cancel 200/OK means queued
removal; 202 means a cancellation signal that can race success. 400/ALREADY_COMPLETED
and 404/NOT_FOUND require observation, not a refund. See the
[queue reference](https://fal.ai/docs/api-reference/inference-api/queue/submit) and
[cancellation contract](https://fal.ai/docs/documentation/model-apis/inference/queue).

Parsers accept at most 1 MiB of JSON and 128-character ASCII IDs. The runtime must
bound the response stream before decoding, impose read/attempt deadlines, persist
only content-free observations, and freeze settlement once. Native result bodies,
media URLs and logs are transient. No helper downloads media.

Model APIs and serverless have different billing units. Inference seconds and queue
completion alone cannot establish cost. Hard budgets require a frozen model tariff
and proven whole-job bound, or an explicit `policy_fixed` tariff. No synthetic rate
or default free-cancel inference is supplied. See
[pricing](https://fal.ai/docs/documentation/model-apis/pricing).

Request history defaults to 90 days; CDN expiry is independently configurable.
These are vendor retention controls, not a router ownership TTL or a promise of
zero retention. See [retention](https://fal.ai/docs/documentation/model-apis/media-expiration).
Sources checked 2026-11-03. Real Worker durability, billing, model-specific output
validation and consumer acceptance remain integration requirements in the fixture.
