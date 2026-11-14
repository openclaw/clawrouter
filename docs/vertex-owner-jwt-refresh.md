# Owner-fenced Vertex service-account refresh

The canonical provider is `anthropic-vertex`. A privileged grant PUT may use
`vertexAnthropicAuthorization` with version `clawrouter.vertex-anthropic.v1`,
source `service_account`, explicit `project`, `location`, `clientEmail`, and an
optional `keyId`. The separate write-only `vertexServiceAccountPrivateKey` field
accepts a PKCS8 RSA signing key. Key replacement requires explicit authorization
in the same mutation. No key, assertion or token appears in routing projections,
admin responses, catalog metadata or logs.

The owner can start without an access token. Only the validated private owner
key creates signing capability. Generic OAuth metadata, expiry, environment
variables, refresh configuration and imported credentials do not. The existing
`access_token` source remains preprovisioned and never gains signing capability.
Omitted authorization preserves only the same owner credential/account/resource;
removal clears the key and binding. Replacement changes generation/lineage.
An uncertain exchange cannot be retried by resubmitting the same signing key.

Materialization and scheduled refresh reuse the existing owner row and
`refreshAttempt` fence. Reservation and fetch start occur under owner ordering;
the remote wait and bounded response read occur outside it. Settlement takes
ordering again and requires the original generation, lineage, binding and live
attempt. Revoke, disable, replacement and caller cancellation abort the active
operation; a late response cannot install credentials. Duplicate requests do
not create another exchange. The alarm never replays an uncertain fence.

The existing codec signs RS256 assertions with the fixed Google token URL and
cloud-platform scope. There is no refresh token. The response requires HTTP 200,
manual redirects, identity encoding, JSON MIME, strict UTF8, exact declared
length, full EOF, at most 32 KiB and 8192 chunks including empty chunks. Only the
codec's token fields are accepted. Expiry starts at the token request, not its
response; at least 60 seconds must remain before installation and inference.
Malformed, interrupted, redirected or otherwise uncertain exchanges retain the
fence. A lost storage acknowledgement may recover the exact committed row;
it never repeats the exchange. Failed projection publication repairs metadata
from that committed owner, not by exchanging again.

Vertex skips speculative credential prefetch. Hard-dollar admission runs before
materialization; unknown prices remain closed. Final inference authorization
still rechecks current caller policy and the original owner after awaited
preflight work. No alternate grant, environment credential or direct-Anthropic
price is substituted. Fixed policy charges remain separate from Google invoices.

Tests generate synthetic RSA keys. Node tests exercise storage/restart faults;
a separate workerd fixture holds actual intercepted token I/O while distinct
requests cancel, revoke or replace the owner. It tests controlled in-Worker
signals, not physical host disconnect. No test establishes live IAM entitlement,
ADC, federation, impersonation or account provisioning. Provider declarations,
actual clients and composed consumer proof remain separate original work.
