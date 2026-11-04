# Preprovisioned Anthropic Vertex credentials

The `anthropic-vertex` runtime accepts an original durable-owner Bearer access
token with explicit expiry and explicit resource authorization. It does not
refresh that token, discover ADC, import a service account, or infer IAM access.

Use the existing privileged upstream-grant PUT with `kind: oauth`,
`tokenType: Bearer`, `accessToken`, `expiresAt`, and
`vertexAnthropicAuthorization`:

```json
{
  "version": "clawrouter.vertex-anthropic.v1",
  "source": "access_token",
  "project": "example-project",
  "location": "us-east5"
}
```

Only this explicit admin intent establishes the private owner binding. Generic
metadata, OAuth completion, legacy imports and environment credentials do not.
Omitting authorization preserves it only for the same credential, account,
expiry and owner. Explicit null removes it. Replacement requires renewed
attestation; changed bindings invalidate lineage and routing projections. No
secret or project binding is added to public model catalogs.

The finite caller route is POST `/v1/native/anthropic-vertex/v1/messages`, or the
manifest `messages` endpoint, with paired `anthropic.messages` formats. The
registered selected model and owner project/location determine the physical
Google resource. The existing codec owns the fixed regional/global host,
`publishers/anthropic` path, `rawPredict` or `streamRawPredict`, model removal and
`vertex-2023-10-16` body version. Request preparation is bounded to the existing
JSON request limit. Caller query/resource overrides and alternate transports
are denied. Caller/static credential headers cannot replace codec headers.

Admission requires more than 60 seconds of token life. The final pre-fetch check
runs after awaited budget and retention work, revalidates current caller policy,
and compares the original authoritative grant generation, lineage, binding and
expiry. It never refreshes or selects another credential. This is fresh-at-check
authorization; a later revocation cannot retract an already authorized fetch.

Unknown dollar prices deny before materialization or inference. An explicit
fixed policy charge remains a policy charge, not a Google invoice. Dispatched
errors and interrupted delivery retain conservative settlement; requests are
not replayed against another account. JSON/SSE usage stays with the selected
Vertex model, without importing direct-Anthropic rates.

Synthetic Node tests cover owner mutations and Worker routing. A separate actual
workerd fixture exercises admin PUT, durable-owner materialization, native JSON,
manifest SSE, and revocation after a real budget acknowledgement. Hosted results
are required; neither fixture proves live IAM or account entitlement.

Service-account JWT refresh is a required separate slice using the existing
owner fence and qualified codec. Its held-exchange cancellation and late-write
proof are not supplied by this preprovisioned implementation. Provider YAML,
actual-client integration and end-to-end consumer qualification remain separate.
