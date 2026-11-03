# Vydra Jobs protocol

`worker/vydra-jobs.ts` implements the bounded canonical Jobs codec; the synthetic
wire/result fixture is `providers/_fixtures/vydra/jobs.json`. Run
`node --test worker/test/vydra-jobs.test.mjs` without dependencies. This slice does
not register provider routes or implement Studio workflow runs.

Submit `POST /api/v1/jobs`, retrieve `GET /api/v1/jobs/{id}`, and cancel with
`DELETE /api/v1/jobs/{id}` at `https://www.vydra.ai` using bearer credentials.
Pin the original caller/policy/credential/workflow/model lineage and request digest
before dispatch. Bind the top-level response ID before exposing bytes. Creation
can return completed, but output still requires a scoped GET. Never replay an
uncertain POST; canonical Jobs does not inherit Studio's idempotency contract.

Only `completed`, `failed` and `cancelled` are terminal. `pending` and `running`
stay open even with output URLs. Delete acknowledgement does not contain a job ID
or terminal status: consume it only on an already bound control request and then
observe that job. Refund acknowledgement is not proof that upstream compute
stopped. Freeze one terminal settlement and do not apply late refunds twice.
See [Jobs API](https://www.vydra.ai/docs/jobs).

The codec limits envelopes to 1 MiB and IDs to 128 ASCII characters. The runtime
owns bounded stream reads, deadlines and polling no more often than every five
seconds. It must reject cross-owner/expired/rotated-credential controls before
fetch. Never follow `_links`; construct control paths from the bound ID. Keep
output and error text transient. Media downloaders need independent origin,
SSRF and byte limits without forwarding the Vydra credential.

API credit fields use integer ledger units: 50 units per customer credit in the
documented 2026-10-07 pricing version. Dollar value depends on the account offer.
The adapter preserves charged and refunded units separately, with missing values
unknown. Hard budgets require frozen model/settings prices and a whole-job bound,
or explicit `policy_fixed` pricing. No universal media-retention TTL or zero-cost
cancel rule is inferred. See [billing](https://www.vydra.ai/docs/billing).

Sources checked 2026-11-03. Runtime durability, model/result qualification,
credential-scoped client acceptance and actual upstream cost remain integration
requirements; the fixture does not claim live or end-to-end parity.
