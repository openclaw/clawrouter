# Example provider plugin

Copy this directory to start a declarative provider integration. Replace the
`example` identity and reserved `.invalid` URL with your provider's documented
API. No live service is configured here. Do not put credentials in these files.

`clawrouter.plugin.json` describes the package. `example.provider.yaml` owns its
execution contract. `assets/` contains local branding; `fixtures/` contains
synthetic protocol examples, not executable tests or evidence of live support.

`fixtures/request.json` uses `clawrouter.provider-conformance.v1`. It describes
one synthetic JSON exchange: client request, expected upstream request, supplied
upstream response, and expected client response. The contract parser validates
its shape. A separate host runner executes this model-free native REST exchange.

From a ClawRouter checkout, validate this package's fixture declarations with:

```sh
node scripts/validate-provider-conformance.mjs --plugin <package-dir>/clawrouter.plugin.json
```

This checks schema and manifest references. To execute the supported exchange
through the Worker with synthetic credentials and intercepted upstream calls:

```sh
node scripts/run-provider-conformance.mjs --plugin <package-dir>/clawrouter.plugin.json
```

Run this development command in a separate process. The client path is relative
to `/v1/native/<provider-id>`. A pass proves the authored exchange only; it does
not establish live access or subscription, streaming, and lifecycle support.

See [the plugin contract](../../docs/provider-plugins.md) in the source tree.
When distributing a standalone copy, include your own setup and support docs.
