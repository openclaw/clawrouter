# Claude Fable 5.2

Qualified on 2026-11-10; released 2026-11-09. Public model ID:
`anthropic/claude-fable-5-2`. Upstream ID: `claude-fable-5-2`.

## Contract and access

The [model overview](https://platform.claude.com/docs/en/models/fable-5-2/overview)
qualifies text/image input, a 1,000,000-token context, and 128,000-token maximum
output. Standard USD per million tokens: input 8, output 40, cache read 0.20,
five-minute cache write 10, one-hour cache write 16. These are new versioned
prices, not the Fable 5.1 card.

[Fast mode](https://platform.claude.com/docs/en/build-with-claude/fast-mode#pricing)
is opt-in (`speed: "fast"`), at 2x standard token rates, including caching.
[US inference](https://platform.claude.com/docs/en/manage-claude/data-residency#pricing)
adds 1.1x across token categories and stacks with fast mode. Existing conservative
reservation for omitted geography is unchanged. Priority and Batch are not
qualified by this synchronous Messages declaration.

The [plan support article](https://support.claude.com/en/articles/15424964-claude-fable-models-on-your-plan)
explicitly includes Fable 5.2 in Max/Ultra and premium Team/legacy seat-based
Enterprise subscriptions. Those plans share a separate Fable family limit of
50% of weekly usage. Pro and standard seats require usage credits from the
start; usage-based Enterprise and API access are metered. The support article
requires Claude Code 2.1.321 or later when using Fable 5.2 in that application.
That application-version requirement is not evidence that a raw Messages request
must claim that version in its user-agent or billing system block. The Messages
[migration guide](https://platform.claude.com/docs/en/models/fable-5-2/migration-guide)
identifies the model by `claude-fable-5-2`; it does not prescribe either version
field as a model-access requirement.

A hosted subscription request on 2026-11-11 was rejected because its
`claude-cli/2.1.288` HTTP User-Agent was below the upstream minimum of 2.1.290.
The router now advertises `claude-cli/2.1.322 (external, cli)` for subscription
requests. This observed HTTP-header requirement is separate from the documented
Claude Code application requirement above.

Keep the injected billing prefix at `cc_version=2.1.288`. Unlike the HTTP
User-Agent, that prefix is part of earlier requests' system content; changing it
would change the prefix preceding preserved thinking even when callers replay
unchanged tools and history. Regression tests exercise the actual transform for
Fable 5.1, Sonnet 5.5 and Opus 5.5, both reconstructing the historical prefix and
replaying already-transformed input without adding duplicate billing blocks.
These synthetic tests prove wire preservation, not cryptographic signature
acceptance or live Fable 5.2 subscription access under this client identity.

A declared subscription offer is transport compatibility, not proof that a
specific account has included usage, credits, fast-mode access, or permission to
spend. Existing grant, scoped quota, reserve, policy, and budget checks remain
authoritative. This change does not enable usage credits, extra usage, environment
fallback, or a new credential. Upstream remains the authority on account access.
Fable 5.2 requires 30-day upstream retention unless Anthropic expressly authorizes
ZDR; router content-retention settings do not waive that upstream requirement.

## Native request compatibility

The [migration guide](https://platform.claude.com/docs/en/models/fable-5-2/migration-guide)
requires adaptive thinking (always on), supports low/medium/high/xhigh/max effort
(default high), and requires omitting sampling parameters and assistant prefill.
Prefix/signature binding now applies to every account. Preserve thinking blocks
and their preceding system/tools/history unchanged. Start a new conversation when
changing the executor/advisor/tool contract; do not strip signatures or silently
opt into dropping bound blocks. Replay thinking through the account that produced
it, or a linked account; upstream drops blocks from unrelated accounts. This
declaration does not add an account-affinity guarantee to grant selection.
The old computer_20251124 tool is not supported
on this first-party endpoint; a Fable 5.2 executor needs a 5.2 Fable/Mythos advisor.

Existing Messages serialization already preserves these native fields. Tests
exercise declared model resolution through unified, native, and manifest routes,
with both API-key and subscription credentials; thinking/signature content is
unchanged. Synthetic JSON/SSE usage verifies standard/cache/fast/US settlement,
and native count_tokens remains free. No hosted-advisor pricing qualification,
account-affinity rewrite, paid upstream probe, or production deployment is implied.

## Why the catalogues differ

ClawRouter currently compiles `providers/*.provider.yaml` into
`worker/generated/provider-snapshot.json`. That owns explicit product offers,
endpoint/auth bindings, and qualified tariffs; `/v1/catalog` and `/v1/models`
then project it through caller policy and available grants. Generic native
passthrough alone neither publishes a model nor qualifies hard-budget pricing.

OpenClaw separately consumes the published `openclaw/catalog` bundle. That
repository's scheduled publisher runs OpenClaw's plugin-manifest catalogue
publisher and emits v1/v2/v3. ClawRouter has no existing import/sync job consuming
that feed. OpenClaw's `@openclaw/model-catalog-core` remains private with a
workspace-only normalization dependency at inspection, not a supported external
package to add here. The existing [shared-catalogue design](provider-contract-architecture.md)
is a proposal, not an implemented importer. Client model facts also cannot grant
router transport, product, price, or account eligibility.

Smallest existing-mechanism reuse: add the exact model and offers to the bundled
Anthropic declaration, use its existing manifest-qualified price modifiers, and
regenerate the snapshot. No runtime code or hot-path catalogue fetch is needed.
A supported shared-core release plus selected, provenance-pinned build-time
import remains separate work; copying its schema or exposing all feed rows would
not be a narrow fix for this missing declaration.
