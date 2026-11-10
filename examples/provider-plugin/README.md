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
its shape; a host conformance runner is not implemented yet.

See [the plugin contract](../../docs/provider-plugins.md) in the source tree.
When distributing a standalone copy, include your own setup and support docs.
