# Temporary FakeCo BIC comparison

Status: completed with user approval, 2026-10-23 06:36–06:38 UTC. One search
attempt returned Internal Error; result inconclusive. Temporary rule deleted,
absence and original configuration verified. The temporary FakeCo exception
is no longer deployed.
The procedure below is the approved experiment record, not standing permission
to repeat it. See [results](search-semantics-validation.md#approved-temporary-bic-health-comparison).

Purpose: test whether retrieval of the existing public fixture health URL starts
working while a narrow Browser Integrity Check (BIC) exception is active. BIC is
a candidate, not an established cause. The stable IANA control succeeded; both
fresh fixture pages and the same-host health control returned Internal Error.
See [recorded controls](search-semantics-validation.md).

## Exact proposed change

[Rule payload](../config/search-semantics-bic-probe.json). Deploy as a new, last
Configuration Rule in the zone-level `http_config_settings` phase:

```text
Name: FakeCo temporary BIC health probe 20261022
Host: clawrouter-fakeco.openclaw.ai
Methods: GET, HEAD
Paths: /search-semantics/health, /robots.txt
Query: empty
Setting: Browser Integrity Check off
Order: last
```

Both HTTP and HTTPS match. Robots is included because a rejected prerequisite
robots fetch could confound a health-only exception. These paths already have
public responses: health returns fixture JSON; root robots returns router 404.
The exception changes no response content or access policy. Registered fixture
pages, control endpoints, dashboard, API and other hosts do not match.

Account `OpenClaw`, `91b59577e757131d68d55a471fe32aca`.
Zone `openclaw.ai`, `72b20df9e990ac41365dadace6499187`.

Cloudflare documents [`set_config`, the zone phase](https://developers.cloudflare.com/rules/configuration-rules/create-api/)
and the [`bic` boolean parameter](https://developers.cloudflare.com/rules/configuration-rules/settings/).
Its [single-rule creation](https://developers.cloudflare.com/ruleset-engine/rulesets-api/add-rule/)
and [single-rule deletion](https://developers.cloudflare.com/ruleset-engine/rulesets-api/delete-rule/)
operations preserve other rules; never replace or delete the phase ruleset.

## Read-only qualification

2026-10-23 06:32 UTC, existing account-owned token:

- Zone identity matched account and zone above.
- `GET /zones/{zone}/settings/browser_check`: 200, value `on`, editable true.
- `GET /zones/{zone}/rulesets/phases/http_config_settings/entrypoint`:
  403, Cloudflare error code 10000. No credential fallback or mutation attempted.

The authorized existing Safari session independently showed one active
Configuration Rule. Its editor was opened, inspected and cancelled unchanged:

```text
Catalog public API clients
Rule ID: a260a98b2a824554a8eacbb7eabcb095
Expression: (http.host eq "catalog.openclaw.ai")
Only added setting: Browser Integrity Check off
Order: first (only rule)
```

During preparation, the proposed new form was populated in Safari, including
BIC off and last order. Neither Deploy nor Save as Draft was clicked then.
A populated form does not prove
server acceptance or create/delete permission. The phase ruleset ID remains
unknown; the existing editor URL identifies a rule, not a ruleset. API execution
is unavailable with the qualified token. Subsequent approved browser creation
and deletion succeeded for this rule; this does not qualify API permissions.
Do not switch to Wrangler OAuth or another credential to bypass the 403.

Cloudflare documents a [non-persisting Rulesets API dry run](https://developers.cloudflare.com/ruleset-engine/rulesets-api/dry-run/).
None was attempted after the permission failure; no claim of server validation.

## Approved experiment procedure

1. Immediately before deployment, refresh the rule inventory and zone BIC value.
   Require the baseline above, no rule with the proposed name, and the exact
   prepared expression/action. If a new overlapping rule or unexpected setting
   appears, stop and reassess. Recheck ordinary public health GET returns 200
   with `ok: true`, environment `fakeco`, fixture `search-semantics-v1`.
2. Obtain approval for this temporary security exception, one Sol search call
   and removal of this named disposable rule. In Safari, deploy the prepared
   new rule once. Record its rule ID/editor URL and deployment UTC immediately.
   If the outcome is ambiguous, inspect the list by exact name before any retry.
   Never deploy a duplicate or alter the Catalog rule.
3. Reopen the new rule read-only. Verify exact name, expression, BIC off, last
   order and active status. Verify Catalog remains unchanged. Allow 60 seconds
   to settle; this delay and dashboard state do not prove propagation to the
   provider's edge. Check ordinary public health and robots again. Stop on any
   identity mismatch, challenge or unexpected redirect and proceed to cleanup.
4. Make **one** direct `gpt-6.1-sol` call to
   `https://api.openai.com/v1/alpha/search`, using the existing
   `directSearchProbe` in `scripts/standalone-search-probe.mjs`. Fresh UUID session;
   request body:

   ```json
   {
     "id": "<new UUID generated in memory>",
     "model": "gpt-6.1-sol",
     "commands": {
       "open": [{"ref_id": "https://clawrouter-fakeco.openclaw.ai/search-semantics/health"}],
       "response_length": "short"
     },
     "settings": {"external_web_access": true}
   }
   ```

   Check OpenAI item metadata/access instructions first. Read only
   `op://Agent Secrets/OpenAI/OPENAI_API_KEY` in memory, using the existing
   1Password helper. Preserve its scope; no auth fallback. Use the probe's
   redirect rejection, 90-second timeout and 2 MiB response bound. Count the
   attempt before dispatch; no retry after a timeout or ambiguous result.
   No inference, router registration, fixture run creation or broader matrix.
5. Save a new, exclusive receipt under ignored operator artifacts, containing
   UTC times, target/model, new rule ID, baseline request ID
   `req_1969c4ec241d43d3b9af621f3f5b2f1a`, request count, HTTP status,
   sanitized provider request ID, output length, tool-error booleans and checks
   for `search-semantics-v1`, `fakeco`, and `ok: true`. Keep credentials, raw or
   encrypted output in memory only. Label billing and live-origin-fetch
   qualification false. A search reference alone is not successful retrieval.
6. Start cleanup immediately on completion or failure, including credential or
   local preflight failure. Target active exposure under five minutes; this is
   an operator limit, **not automatic expiry**. If the session is interrupted,
   the rule persists until manually disabled/deleted. Do not start if the
   operator cannot remain available for cleanup.

## Cleanup and recovery

Before deployment, keep the Configuration Rules page available for manual
recovery. After creation, record the new rule's ID in the receipt before the
paid call. API permissions remain unqualified; cleanup must not depend on the
API token working.

1. In Safari > openclaw.ai > Rules > Overview > Configuration Rules, find the
   exact new name. Inspect the editor and require recorded ID, exact expression
   and BIC-only action. Never target the Catalog rule or the phase ruleset.
2. Remove only the new disposable rule through its row menu, confirming its
   identity in any deletion dialog. If a separate action-time confirmation is
   required, request it at that point. If deletion fails, disable that same rule
   as the immediate fallback and report deletion outstanding. If it has been
   unexpectedly edited, preserve the observed state, stop before deleting and
   ask the user how to resolve ownership; do not overwrite a concurrent edit.
3. Refresh inventory: owned rule absent, Catalog present/active with original
   expression and BIC off. Record any unrelated concurrent changes without
   reverting them. Confirm zone-wide BIC still on via the dashboard and public
   health still returns the expected 200 JSON. List absence proves configuration
   cleanup, not instantaneous global edge propagation.
4. Record cleanup UTC, owned ID, absence check and any failures. If browser
   access is lost, tell the user immediately and provide the name, ID and exact
   Configuration Rules path for manual disable/delete. Never claim cleanup
   complete without verification.

No Worker deploy, route, DNS, Access, credential, budget or fixture namespace
change belongs to this experiment.

## Interpretation and stop point

- Expected health content returned without tool errors: evidence that retrieval
  works during the exception; consistent with a BIC-related problem. A single
  before/after observation does not establish causality or prove live fetching.
- Internal/fetch error or missing expected content: inconclusive. Edge
  propagation, robots/provider caching, inherited restrictions, provider safety
  and other failures remain possible. Do not broaden the exception or retry.
- Cleanup is required for either outcome. Report results and seek separate
  approval for any further experiment. This health comparison does not validate
  cached/live search semantics, navigation, other models or alpha/search billing.
