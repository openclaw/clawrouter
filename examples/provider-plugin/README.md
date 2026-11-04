# Example provider plugin

Copy this directory to start a declarative provider integration. Replace the
`example` identity and reserved `.invalid` URL with your provider's documented
API. No live service is configured here. Do not put credentials in these files.

`clawrouter.plugin.json` describes the package. `example.provider.yaml` owns its
execution contract. `assets/` contains local branding; `fixtures/` contains
synthetic protocol examples, not executable tests or evidence of live support.

See [the plugin contract](../../docs/provider-plugins.md) in the source tree.
When distributing a standalone copy, include your own setup and support docs.
