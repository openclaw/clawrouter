# Read-only native rehearsal preflight

This is the missing secure runner entrypoint, not provisioning or qualification.
The existing qualification workflow consumes pre-uploaded isolated versions and
separate credentials; the local preparation helper only packages source. Neither
establishes whether the repository's existing Cloudflare credential can read the
account. Do not substitute a production deployment or a production tail session.

## Run after this source lands

A coordinator with Actions dispatch authority selects **Read-only native rehearsal
preflight**, branch **main**, and supplies the exact reviewed 40-character main
commit as expected_sha. No run is automatically triggered by a PR or push.
The inline guard checks repository, event, main ref and dispatch SHA **before
checkout or credential injection**; checkout pins that SHA without Git credentials.
The execution step verifies HEAD again. No package install, build, Wrangler,
provider request, native admin request or secret-management API is involved.

Only the metadata step receives the existing repository CLOUDFLARE_API_TOKEN and
CLOUDFLARE_ACCOUNT_ID. Do not add these to local files. Other mappings are evaluated
as booleans in Actions and only those booleans reach the script:

- NATIVE_QUALIFICATION_CF_API_TOKEN / NATIVE_QUALIFICATION_CF_ACCOUNT_ID
- NATIVE_QUALIFICATION_ADMIN_TOKEN
- NATIVE_QUALIFICATION_ACCESS_CLIENT_ID / NATIVE_QUALIFICATION_ACCESS_CLIENT_SECRET
- CLAWROUTER_NATIVE_ADMIN_TOKEN
- CLAWROUTER_NATIVE_ACCESS_CLIENT_ID / CLAWROUTER_NATIVE_ACCESS_CLIENT_SECRET

These reflect the current repository/eligible organization secret context, **not**
an environment's secrets, validity, credential equality or access. The job does
not select an environment, create tokens, change permissions, increase quotas,
subscribe to products or create/delete any Cloudflare resources.

## Receipt and decision boundary

The one-day native-preflight-<run>-<attempt> artifact contains only native-preflight.json.
An initial blocked receipt exists before checkout; normal execution replaces it.
Script failures exit nonzero and retain finite, fixed-category diagnostics. A
runner failure/cancellation can still prevent artifact upload: inspect the actual
Actions result, never infer a successful observation from an absent artifact.

Every receipt says qualified:false and provisioningAllowed:false. Even an
observed result is only a snapshot, never authorization or readiness to provision.
The coordinator must reconcile the following against the actual run/SHA and all
remaining qualification prerequisites before any later independently authorized
provisioning. This PR executes none of those later steps.

- Account access and exact account-ID consistency; only SHA-256 fingerprint leaves
  the process. An endpoint denial is not proof the stored credential is invalid.
  Independent metadata reads continue when one surface is unavailable.
- Latest production deployment distribution, each referenced version's validated
  existing native receipt, controlling source, native payload source and runtime
  digest. The deployment is reread to catch drift. Canonical DO/KV/R2/queue owner
  identities become SHA-256 fingerprints, never production raw IDs/settings.
- Prefix-matching Workers, DO namespaces by owning script, KV, queues, default-
  jurisdiction R2 buckets and container apps. Only prefix matches expose IDs/names;
  other resources are counted. Prefix matching is **not ownership authorization**.
  Production container identity is fingerprinted and its DO namespace checked
  against the deployed LARGE_HTTP_SLOTS fingerprint. Numeric app instance counts
  remain null when that API variant does not supply them.
- Containers live account resource maxima/usage, not billed usage or placement
  guarantees. No guessed zero: missing metrics are null/partial. Non-container
  quotas and non-default R2 jurisdictions remain explicitly unestablished.
- Subscription metadata projects only workers/containers-prefixed plan IDs,
  state, fixed price and frequency; other/unrecognized plans are counted, not
  disclosed. This is not the metered invoice or proof a product is enabled.
- Restricted Alpha GET billable usage: current-month-through-today default, only
  recognized Workers/Containers/R2/Queues/DO/KV product families, numeric quantity,
  allowlisted units, date interval and metric fingerprint. Unknown products are
  omitted/count-only; unknown units or accountless contract rows fail partial.
  GET does not return rated costs. Costs remain unknown; no POST fallback.

complete only describes the bounded endpoint scan, not all account resources or
all product meters. observedCount is a **lower bound** unless complete:true;
omittedCount includes unrelated and unrecognized rows. A zero matches list is
not proof of absence on partial/forbidden/unavailable scans. 401, 403, other HTTP
errors, malformed metadata, drift, deadlines and scan limits remain distinct
fixed diagnostics. Required denied/partial surfaces keep status:blocked. Never
turn an unknown capacity, subscription or billing observation into free headroom.

Bounds: five pages / 500 entries per inventory, 100 requested per paginated page,
2 MiB decoded response body, ten seconds per request including body consumption,
three minutes for all requests, five-minute job. No retries, redirects or response
body/error logging. All API calls are GET to the fixed Cloudflare management
origin; metadata only, never KV values, DO objects, R2 objects, queue messages,
Worker code, auth claims or secret-value endpoints. Returned version bindings and
container configuration are processed in memory with allowlisted projections;
raw configuration, free-text diagnostics and unrelated names never enter logs or
artifacts. Token/account collision detection fails closed before output.

## Official API contracts

Checked against Cloudflare's API reference on November 13, 2026. Least-privilege
read permission availability is endpoint-dependent; no token changes are part of
this runner. Account details and Workers version reads accept documented Workers
read permissions; KV, queues and R2 have their own read scopes. Subscriptions
require Billing Read (or existing Billing Write). Container and Alpha billing
availability must be established by the actual response, not inferred from a
successful production deployment.

- [Account details](https://developers.cloudflare.com/api/resources/accounts/methods/get/)
- [Deployments](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/list/) and [version metadata](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/get/)
- [Workers](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/list/), [DO namespaces](https://developers.cloudflare.com/api/resources/durable_objects/subresources/namespaces/methods/list/), [KV namespaces](https://developers.cloudflare.com/api/resources/kv/subresources/namespaces/methods/list/), [queues](https://developers.cloudflare.com/api/resources/queues/methods/list/)
- [R2 cursor pagination and jurisdiction](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/methods/list/)
- [Container application page tokens](https://developers.cloudflare.com/api/resources/containers/subresources/applications/methods/list/) and [live usage/maxima](https://developers.cloudflare.com/api/resources/containers/methods/usage/)
- [Subscriptions](https://developers.cloudflare.com/api/resources/accounts/subresources/subscriptions/methods/get/) and [GET account usage v2 limitations](https://developers.cloudflare.com/api/resources/billing/subresources/usage/methods/get_account_usage_v2/)

## Local verification

node --test test/preflight-native-rehearsal.test.mjs exercises the actual parser,
projection, pagination, transport bounds, denied/error paths, secret sentinels,
source refusal, CLI failure artifact and executable inline workflow guard. No
live Cloudflare credential is required or used. These tests and PR CI are **not
hosted credential, quota, provisioning or native qualification evidence**.
