# Codex search production pilot proposal

Prepared locally; no production changes or paid calls authorized by this document.
Use the existing production deployment workflow and application authority. No new
Cloudflare Worker, namespace, queue, Access application or provider credential is
needed for this proposed pilot.

## Pricing and budget

Carry forward the tested canary charge: **$0.001 per standalone HTTP search
request**, including open/click/find, multi-command requests and HTTP-200 tool
errors. Inference uses model token rates. The upstream Alpha invoice remains
unqualified; these are router charges, not measured upstream search costs.

Use a dedicated **$25 shared monthly policy cap**, following the existing shared
production smoke limit. This replaces the canary experiment's $50 limit. Daily
and weekly caps remain unconfigured. Search and inference consume the same $25
allowance, with reserve-before-dispatch enforcement. A new policy has its own
allowance; it does not share another policy's balance. Preserve settled spend.

Proposed policy ID: `codex_search_pilot_20261023`. Check for absence before any
creation; never overwrite or revive an existing diagnostic ID. Policy API body:

```json
{
  "enabled": true,
  "providers": ["openai"],
  "models": ["openai/gpt-6.1-sol", "openai/gpt-6-astra"],
  "tenantId": "default",
  "monthlyBudgetMicros": 25000000,
  "dailyBudgetMicros": null,
  "weeklyBudgetMicros": null,
  "budgetScope": "policy",
  "budgetMode": "reserve",
  "requestCostMicros": null,
  "requestCostsMicros": {"search.web": 1000},
  "retainRequestContent": false,
  "poolStatus": "hidden",
  "grantRouting": {"failover": false, "environmentFallback": false}
}
```

In the admin form, enter `{"search.web":0.001}` in **Price per request by
capability ($) · JSON object** and leave **Fixed request cost ($)** blank.
Do not copy the canary provider-wide budget onto the shared production OpenAI
connection. Existing production policy prices, caps, bindings and credentials
remain unchanged by this proposal. In particular, do not replace existing general
inference tariffs merely to enable search.

Standalone search now requires its own `search.web` tariff in both discovery and
dispatch. A general request price alone cannot activate it. An explicit zero
price enables zero-charge router search; remove the entry to disable search.
Eligible new CLI profiles still default to cached search. Existing profiles keep
their saved modes; Desktop search remains disabled.

## Qualification and authorization sequence

1. Freeze the reviewed candidate against current main; require focused Worker,
   admin and CLI regression checks, local workerd accounting smoke and autoreview.
   Record the exact SHA and current production rollback version immediately
   before a separately authorized deployment. Publishing a PR does not deploy it.
2. Obtain approval to merge, wait for exact-main CI, and run the existing
   zero-traffic rehearsal. The production workflow requires main and automatically
   restores the previous version after zero-smoke; it does not pause for a native
   search pilot. A subsequent gradual code rollout needs separate approval and
   the existing asset, health and queue gates. This proposal does not add a pause
   or deploy an unmerged PR branch.
3. Once the approved code is serving, inspect the complete capability-price maps
   and obtain approval for the exact dedicated application policy and credential
   writes. Stop on unexpected existing search enablement. Use one fresh
   operator-only credential with a 24-hour expiry, stored through the credential
   manager; no secret values in source, arguments, logs or this document. No
   user/group bindings or broad distribution. Preserve the existing provider
   account. Read key inspection and `/v1/catalog` through that version before
   paid work. Require the proposed price/cap, retention off, positive remaining
   budget, and eligible native search offers for both selected models. Candidate
   catalog evaluation runs the same authority-backed single-account guard used
   for dispatch, without making provider requests. Inventory/readiness alone is
   insufficient. Stop on account/pool qualification failure; do not change grant
   membership, fallback or credentials automatically.
4. After separately authorizing bounded paid work, run one cached Sol/Astra
   known-content native workflow with strict WebSocket inference and no silent
   HTTP fallback. The existing deployed harness has a 32-operation ceiling and
   a 4096-token inference output ceiling. Set `--search-cost-micros 1000` and
   `--max-budget-micros 25000000`; these options validate router policy limits,
   not upstream invoice spend. Require useful tool output, reference reuse and
   exact policy-ledger/usage reconciliation. Do not repeat paid requests merely
   because reporting is delayed. Existing deployment gates include ordinary
   inference smoke outside this dedicated pilot allowance; disclose that in the
   approval request.
5. Widen the pilot only after its receipts agree. Further production policy enablement needs its
   own pricing/cap decision. Retain fresh-origin, strict cache-only and Alpha
   billing limitations; do not start another hosting/retrieval experiment.

For a stop or rollback, revoke the dedicated client credential through the
authority first. Removing the explicit tariff disables new and resumed search
dispatch; zeroing it does not. Restore the reviewed Worker baseline through the
normal workflow if required. Do not reset budgets or erase settled spend.

The shared deployment currently performs application-state-changing live smoke.
The sequence above requires explicit authorization for those writes and paid
requests; read-only preflight is not deployment authorization. Source and runtime
rehearsal results will be recorded separately from this proposal.
