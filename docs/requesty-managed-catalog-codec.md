# Requesty managed catalog leaf

This pure leaf is not an activated provider route. It declares no YAML/schema
format, dispatch registration, model card, price, entitlement or client support.

Exports from `worker/requesty-model-catalog.ts`:

```ts
requestyCatalogRequest(base: string, selectedApiKey: string, signal: AbortSignal): Request;
filterRequestyModels(payload: unknown, allows: (id: string) => boolean): RequestyModelCatalog;
readRequestyModels(response: Response, signal: AbortSignal, allows: (id: string) => boolean): Promise<RequestyModelCatalog>;
```

`REQUESTY_MODELS_FORMAT` is the unregistered marker `requesty.models_managed`.
The factory accepts only `https://router.requesty.ai/v1` with an optional trailing
slash and creates query-free `GET /v1/models/managed`. It uses only the supplied
original selected key as Bearer, with manual redirects, omitted cookies and the
original signal. It does not select credentials or establish managed ownership.
No alternate origin, anonymous request, EU/plan endpoint or retry is available.

The result preserves `{data: RequestyModelRow[]}`. The strict envelope has no
OpenAI list marker or pagination metadata. At most 4,096 input rows are scanned;
IDs are bounded to 512 characters. Malformed non-record/missing-ID rows are
skipped as in the frozen projection. Overlong/control/embedded-whitespace IDs
fail closed. Eligible IDs are trimmed, first-occurrence deduplicated, restricted
to `api === "chat"`, stripped of `@` regional policies and filtered by `allows`.
Bare policy names, hosting prefixes and case remain distinct. Empty stays empty.

Only the four native price observations, context/output limits and vision/
reasoning booleans survive projection. Missing or malformed optional values are
omitted, not replaced with defaults. Finite nonnegative numeric/decimal price
observations keep their original number/string representation. Explicit zero
and false survive, including zero limit observations; zero is not a usable
inference-limit or free-price claim. **All price units and current account rates
remain unqualified.** No conversion or inference tariff is produced.

The complete reader requires HTTP 200, nonredirected JSON without a content
range, valid UTF-8/JSON and complete declared length. It caps input at 2 MiB and
8,192 chunks including empty chunks, propagates cancellation and publishes only
after EOF. The caller supplies the existing operation's signal/deadline and owns
capacity through final serialization. The common runtime must freshly validate
the original caller/grant/credential/destination before each fetch and after
parsing, then intersect admitted IDs with current policy again before publishing.
Reader-time filtering alone does not authorize publication.

## Frozen provenance and remaining work

OpenClaw `31ad71a8addc1d42fbc5478f7e114860f5cbf6c7`:

- `extensions/requesty/provider-catalog.ts:4-9`: authenticated managed-policy discovery.
- `extensions/requesty/provider-models.ts:16-19,69-86`: path, trimmed IDs, Chat selection, duplicate and regional exclusions.
- `extensions/requesty/provider-models.test.ts:139-162`: data-only envelope and original Bearer key.
- `extensions/requesty/provider-models.ts:35-65`: historical USD/token interpretation and fallback behavior. This is not current primary pricing proof; its zero prices/default limits are not copied.
- `extensions/requesty/index.ts:11-15,39-60`: separate provider-owned stream attribution; this catalog leaf does not impersonate that client or forward arbitrary caller headers.

Source1 owns later native-format dispatch, original-owner freshness, admission,
pool/cancellation lifetime and final policy filtering. Source3 owns the format
compiler contract; source4 later owns its declaration. Source2 owns the actual
client; source6 owns serialized activation and consumer proof. Existing global
Chat/cards/auth and pending Bifrost/LiteLLM declarations are unchanged.
