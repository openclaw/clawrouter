# Provider plugins

Status: packaging contract, explicit local loader, compiler integration,
package-index generation, and scaffolding are implemented. Existing
`providers/*.provider.yaml` remain
the default production input. A descriptor does not activate itself.

## Start a provider

Generate a complete package in a new directory:

```sh
node scripts/create-provider-plugin.ts acme-ai ./acme-ai
node scripts/compile-providers.mjs --plugin ./acme-ai/clawrouter.plugin.json
```

The generator sets the provider ID, manifest filename, display name, protocol
namespace, and API-key binding name. It includes docs, a license placeholder,
a logo, and a synthetic request/response fixture. The URL uses the reserved
`.invalid` domain, so the generated package is not a live integration.

Existing destinations, including empty directories and symlinks, are refused.
The destination's parent directory must already exist. All template inputs are
prepared before creating the directory. If an I/O error interrupts creation,
partial files can remain. The descriptor is written last; treat a write error
as an incomplete package and inspect the new directory before retrying.

Alternatively, copy `examples/provider-plugin/` into a directory you own and
give the descriptor and manifest the same ID. Replace the example URL, endpoints,
auth declarations, documentation, license, and synthetic fixtures. Keep secrets
in deployment bindings or scoped credential storage, never package files.

```text
my-provider/
  clawrouter.plugin.json
  example.provider.yaml
  README.md
  LICENSE
  assets/logo.svg
  fixtures/request.json
```

The descriptor contract is exported from
`packages/provider-plugin-contract/src/index.ts`. The package is currently
private, source-only, and not registered as a workspace or published to npm.
Node 24+ can import the source using native TypeScript stripping. This first
contract needs no dependency install and performs no I/O.

```ts
import { parseProviderPluginDescriptor, providerPluginFiles } from
  "../packages/provider-plugin-contract/src/index.ts";

const descriptor = parseProviderPluginDescriptor(JSON.parse(descriptorText));
const declaredFiles = providerPluginFiles(descriptor);
```

Adjust the relative import to your checkout location. These functions validate
the descriptor and enumerate its payload files; they do not load those files,
validate the provider manifest, sanitize images, or certify upstream support.

### Compile an explicitly selected package

```sh
node scripts/compile-providers.mjs \
  --plugin examples/provider-plugin/clawrouter.plugin.json \
  --output /tmp/example-provider-snapshot.json
```

Repeat `--plugin` to select more packages. Existing manifest paths can appear
alongside package inputs. The compiler rejects collisions rather than allowing
a package to replace a bundled provider. The standard build and deploy commands
still select only the existing bundled manifests; package inclusion is opt-in.

The loader reads bounded regular files and rejects symlinked files or resource
directories. It hashes the descriptor and declared files. The compiler validates
the captured manifest, including its schema and matching provider identity.
Assets and fixtures are checked as files but are not rendered or executed.

## Build a package index

```sh
node scripts/provider-package-index.mjs \
  --plugin examples/provider-plugin/clawrouter.plugin.json \
  --output /tmp/provider-package-index.json
```

The versioned index contains validated provider names, package versions and
content digests. Documentation, licenses, fixtures, and light/dark logos are
package-relative references with byte sizes and SHA-256 hashes. It contains no
file contents, absolute paths, upstream URLs, credentials, or auth metadata.
The generator validates execution manifests with the existing compiler and
reads each package once, using the captured manifest for both validation and
metadata. Repeat `--plugin` to select packages explicitly.

This is a build-tool artifact, not a client catalogue or an admin API response.
Its hashes identify content; they do not authenticate publishers, sanitize SVG,
or authorize files for public serving. The Worker snapshot stays unchanged.
A later asset publishing step must verify the captured hashes and apply its own
admission rules before rendering or serving resources.

## Compiled provider contract

[`shared/provider-snapshot.ts`](../shared/provider-snapshot.ts) owns the existing
v1 snapshot, endpoint, model, auth, and quota declarations. Build tools and
future package compilers can import these types without importing Worker
bindings, credential records, or adapter implementations. Existing imports from
`worker/types.ts` and `worker/managed-lifecycle-types.ts` remain supported through
type-only re-exports. The snapshot wire shape and runtime behavior are unchanged.

`GrantKind` preserves the legacy `api_key`, `oauth`, and `subscription` values.
It is a compatibility classification, not the future product or commercial
model. Product/offer normalization still needs its own migration and parity
checks. The shared module contains types only; it does not validate a snapshot
or qualify a provider capability.

### Explicit products

A service-provider v1 manifest can optionally declare `products`. A product ID
is local to its provider. Keep it stable across display-name changes. Commercial
model, authentication method, and execution binding are separate declarations:

```yaml
products:
  - id: platform-api
    displayName: Platform API
    commercialModel: metered
    authenticationMethod: api-key
    binding: { type: provider-default }
    endpoints: [invoke]
```

`provider-default` references the existing provider execution configuration; it
does not require environment credentials or exclude scoped grants. To describe
an already declared grant transport, use
`binding: { type: grant-transport, grantKind: subscription }`. The transport must
exist in `auth.grantTransports`, and every product endpoint must exist and be
allowed by that transport. Product declarations cannot supply endpoints, secret
bindings, adapters, or authorization URLs.

Commercial models are `metered`, `subscription`, `prepaid`, `unbilled`, and
`unknown`. Authentication methods are `api-key`, `oauth2`, `aws-sigv4`, `binding`,
`none`, and `unknown`. These are authored metadata: the compiler does not infer
commerce from grant kind or certify upstream terms, credentials, or onboarding.

The compiler rejects duplicate product IDs and invalid references, then sorts
products and endpoint references. Manifests without products retain the same
snapshot output. This first slice only preserves declarations in the compiled
snapshot. Discovery, routing, authorization, pricing, and budgets still use
their existing checks; products do not yet restrict or enable routes. A later
offer compiler must qualify model, protocol, lifecycle, and account compatibility
before these declarations can become execution authority.

## Descriptor v1

| Field | Requirement |
| --- | --- |
| `schema` | Exactly `clawrouter.provider-plugin.v1`. |
| `id` | Lowercase provider ID, digits and single hyphens, maximum 64 characters. |
| `version` | Exact stable `major.minor.patch`; no ranges or prereleases in v1. |
| `manifest` | Local `.provider.yaml` path. Payload uses the existing service-provider v1 schema. |
| `documentation` | Local Markdown path. Explain setup, operations, limits, and support ownership. |
| `license` | Local license file path. |
| `assets.logo.light` | Optional local SVG, PNG, or WebP path; required if `assets` is supplied. |
| `assets.logo.dark` | Optional dark-theme variant. |
| `fixtures` | Optional unique local JSON paths, at most 128. Data only; no executable fixtures. |

Unknown fields fail validation, including `scripts`, `adapter`, or remote asset
URLs. Paths use portable ASCII letters, digits, dots, underscores, hyphens, and
forward slashes. Absolute paths, empty segments, `.` and `..`, backslashes, URL
schemes, and percent-encoded spellings are rejected. A future loader must also
check real paths and symlinks; lexical checks alone are not containment.

The package version identifies an integration release. The descriptor schema
version identifies packaging semantics. The manifest schema identifies the
execution contract. These versions are independent. Host compatibility is
checked by supported descriptor and manifest schemas, not by guessing from the
integration package version.

## Plugin design and trust boundary

A plugin is a distribution unit, not a process or a remote extension service.
The host admits a configured list of local descriptors at build time. It reads
their data, validates manifests, resolves collisions, and compiles a static
Worker registry. Production requests do not scan directories, install packages,
load JavaScript dynamically, or contact a plugin registry.

Third-party manifests control upstream destinations and credential injection.
Operators must review them before inclusion. A valid schema establishes shape,
not trust or permission. No automatic discovery from cwd, home directories,
`node_modules`, a marketplace, or the public model catalogue is planned.

The initial loader must reject missing, nonregular, escaping, and symlinked
declared files. It must bound descriptor and file sizes, accept only the v1
manifest schema, and require the manifest ID to match the descriptor ID. It
must reject duplicate provider IDs across legacy and plugin inputs. The host
must never silently replace a bundled provider by package load order.

Image validation and image rendering are different operations. Checking the
extension does not sanitize SVG. Until a dedicated asset admission/sanitization
step is implemented, package assets must not be injected into the admin DOM.
Auth buttons likewise come only from validated deployment and execution facts,
not from branding or a package's README.

The build trusts the operator-selected package directory as a stable input.
It is not a sandbox for a directory that another process actively mutates while
being compiled. Package install hooks and executable extensions are excluded.

## Relationship to the architecture RFC

See [provider products and the shared catalogue](provider-contract-architecture.md).
The initial plugin contract wraps today's execution manifest rather than
duplicating auth, model, pricing, and capability schemas in a second file.
Provider product and offer contracts can evolve within the manifest/compiler
boundary after parity tests are in place.

The intended layers are:

```text
operator-selected packages
  -> descriptor and filesystem validation
  -> provider manifest validation + shared catalogue facts
  -> product/operation/protocol compatibility resolution
  -> static offer registry
  -> existing Worker admission, credentials, budgets and dispatch
```

Neutral model facts should reuse OpenClaw's model-catalog core. Do not make
ClawRouter-only auth or runtime hooks dependencies of that shared core. A remote
model row cannot install a provider package, authorize a product, or enable a
new protocol. Price metadata cannot bypass router budget qualification.

Future source-code adapters require a separate, reviewed host API version.
Prefer a statically imported adapter at build time with explicit protocol hooks.
Do not offer an unrestricted `handleRequest(env)` hook: it would bypass policy,
tenant isolation, credential ownership, accounting, and output controls. Package
metadata must never determine its own secret, network, or storage permissions.

## Contributor contract tests

The starter fixture is intentionally generic JSON data. A future conformance
runner will own a versioned scenario schema and execute the host adapter, not
package-supplied test code. Required scenarios depend on declared features:

- auth injection and redaction;
- request and error mapping;
- streaming framing, termination, and bounded buffering;
- usage and quota units, including missing observations;
- model/endpoint compatibility and unknown-model behavior;
- lifecycle and retry eligibility where declared.

Recorded examples must use synthetic credentials and content. Live probes stay
opt-in and separate from deterministic conformance. A passed fixture is not
proof that an account is entitled to upstream access.

## Narrow implementation sequence

| Change | Landing policy | Boundary |
| --- | --- | --- |
| Packaging types, parser, example, architecture docs | Initial additive contracts may land after review | No runtime or compiler import. |
| Explicit local loader, filesystem validation, collision handling | Landed | Pure build tooling; no auto-discovery or active provider edits. |
| Compiler `--plugin` input alongside legacy inputs | Landed | Default CLI and snapshot stay equivalent; test mixed-input collisions. |
| Generated package asset index and setup metadata | Landed | Do not render untrusted SVG or add auth capabilities. |
| Complete-package scaffold command | Landed | Create only a new directory; never register or deploy a provider. |
| Product and offer normalization behind compatibility layer | Separate future draft | Shadow-check existing discovery and dispatch; preserve public aliases. |
| Shared model-catalog import and provenance | Separate future draft | Pin supported core release; qualify prices separately. |
| Credential/connection and accounting migration | Separate future drafts | Preserve refresh ownership, reservations, and delayed execution settlement. |

Do not move all existing provider files into package folders in the same PR.
The Fusion and provider-parity work can continue against their current paths.
Migrate one package only after the loader/compiler contract is accepted. Keep
the initial refactor PRs unmerged until the owner explicitly releases that hold.
