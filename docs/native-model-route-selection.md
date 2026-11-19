# Native model route selection

Native endpoints can share one public path, such as a model-qualified
`generateContent` path. The Worker resolves the operation from the registered
upstream model and its declared endpoint capability before reading the body.
Declaration order and caller body hints do not choose between registered
operations.

`nativeModelEndpoint(provider, matching, path, method)` in
`worker/proxy-selection.ts` returns the unique eligible compiled endpoint. It
uses existing `path_params`, `native_proxy`, methods, provider capabilities and
model capabilities. It adds no manifest or compiled property.

- Only multiple enabled native endpoints with a `model` or `deployment` path
  parameter participate. A single endpoint keeps its existing behavior.
- The path must name the registered upstream identity. Router aliases on an
  overlapping native path are rejected; explicit manifest routes keep their
  existing selector behavior.
- Multiple eligible operations return authenticated `409 native_route_ambiguous`
  before reservation or egress. Unknown models retain existing passthrough
  handling. Known stopped models remain non-executable.
- Lifecycle, Responses control and WebSocket bindings retain their existing
  resolvers. Managed retrieval continues to use the original scoped create route.
- The chosen endpoint still passes ordinary policy, model, original-credential,
  request validation, admission and accounting checks. This resolver grants no
  new credential, capability, tariff or provider availability.

An image-only registered model can therefore declare its image operation while
ordinary text models retain their text operation at the same native path. A
model declared for both operations is ambiguous: use the explicit manifest
endpoint until a separately qualified selector exists. This change does not
activate an image declaration or substitute a body-based routing protocol.

`worker/test/native-model-route-selection.test.mjs` covers both declaration
orders with environment and original grant credentials, authenticated
ambiguity, router aliases, passthrough versus stopped rows, disabled methods and
existing stateful resolution boundaries.
