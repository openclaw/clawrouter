# Anthropic Vertex identity and request contract

`worker/provider-vertex.ts` implements Google service-account JWT construction,
token-request/response codecs and the Google-managed Anthropic resource request.
It performs no fetch, credential discovery, login, provisioning or deployment.

## Credential owner integration

The shared credential owner imports an explicitly selected PKCS8 service-account
key with `importVertexServiceAccountKey`, builds an assertion with
`createVertexAssertion`, and sends `vertexTokenRequest` through its bounded refresh
transport. Only `https://oauth2.googleapis.com/token` is used. Redirects are manual;
the owner must reject them, cancel unsuccessful bodies, bound JSON response size
and avoid logging assertions, keys, tokens or token-response bodies.

`decodeVertexAccessToken` validates the returned token and explicit expiration.
Its timestamp is the request start, so response latency cannot extend the token's
life. Store it under the selected grant/identity version and refresh before expiry.
The proxy warm path uses the materialized token without a foreground OAuth call.
Revocation, refresh concurrency and policy cache limits remain runtime-owned.

This implementation does not discover local ADC, exchange a user refresh token,
perform workload-identity federation or impersonate another account. Those are
separate credential source adapters. An already materialized Google access token
can use the request builder; an Anthropic API key cannot substitute for it.

## Inference integration

`prepareVertexAnthropicRequest` takes the selected project, location, model and
unexpired access token. It binds those values into the Google resource path, moves
the version into the native body, omits the model from that body and uses Bearer
authentication. It supports unary `rawPredict` and streaming `streamRawPredict`.
Tools, thinking and message content keep their Anthropic shape. Shared runtime must
preserve Messages JSON/SSE bytes, perform normal policy/budget checks and account
for the selected cloud product's tariff, not a direct Anthropic tariff by inference.

Global, US/EU multi-region and regional locations have distinct hosts. No region
or project is chosen by default. This slice pins body version
`vertex-2023-10-16`; the newer `2026-10-21` contract requires its own qualification.
Model availability and IAM permission are live resource facts, not inferred from
the URL builder. No new provider manifest or native capability badge is registered
by this module alone.

Primary references checked on 2026-11-03:
[Google service-account OAuth](https://developers.google.com/identity/protocols/oauth2/service-account)
and [Google-managed Claude requests](https://platform.claude.com/docs/en/build-with-claude/claude-models-on-google-cloud/google-managed).
The consumer comparison is pinned to OpenClaw
`31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`'s `anthropic-vertex` extension.

Run `node --test worker/test/provider-vertex.test.mjs`. Tests generate an ephemeral
RSA key in memory, verify the signature and fixed claims, validate token lifetimes
and check selected resource/auth binding. No key material is written or printed.
Shared runtime and actual client integration still need end-to-end proof.
