# Abliteration server credential binding

For the declared Abliteration API product at `https://api.abliteration.ai/v1`
with native `Authorization: Bearer` API-key authentication, `ABLIT_KEY` is the
canonical server configuration. `ABLITERATION_API_KEY` remains a compatibility
name. Declaring either name qualifies this exact pair; declaring both does not
require two credentials. No other product or arbitrary `_KEY` name gains this
behavior.

The canonical nonempty value takes precedence, regardless of declaration order.
A malformed canonical value fails closed rather than using the compatibility
value. Readiness uses the same selection and validation. Both credential names
are classified as secret configuration; readiness and errors contain no values.

A selected original grant takes precedence over both environment names. Missing
or malformed selected-grant material never falls back to environment credentials.
Caller headers are not an upstream key source. Existing scoped grant selection,
model policy and destination preparation remain responsible for dispatch.

The runtime tests cover canonical-only, compatibility-only and both-name server
configuration, native and manifest dispatch, original grants, malformed values,
foreign grants, readiness and sanitized zero-egress denial. This adds no live
credentials or provider/model declarations.
