use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderManifest {
    pub schema: String,
    pub id: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub status: ProviderStatus,
    #[serde(default)]
    pub class: ProviderClass,
    #[serde(default)]
    pub service: ServiceBinding,
    pub auth: AuthConfig,
    #[serde(rename = "baseUrls")]
    pub base_urls: BTreeMap<String, String>,
    #[serde(default)]
    pub routing: RoutingConfig,
    #[serde(default)]
    pub adapter: AdapterConfig,
    #[serde(default)]
    pub capabilities: Vec<Capability>,
    #[serde(default)]
    pub endpoints: BTreeMap<String, Endpoint>,
    #[serde(default)]
    pub models: ModelCatalog,
    #[serde(default)]
    pub billing: BillingConfig,
    #[serde(default)]
    pub tests: ProviderTests,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderStatus {
    Experimental,
    #[default]
    Stable,
    Deprecated,
    Disabled,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderClass {
    #[default]
    OpenaiCompatible,
    AnthropicCompatible,
    RestJson,
    RestForm,
    OauthRestJson,
    CloudflareAiGateway,
    CustomAdapter,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ServiceKind {
    #[default]
    ApiProvider,
    ModelProvider,
    ToolProvider,
    OauthPlatform,
    MeteringPlatform,
    GatewayPlatform,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ServiceBinding {
    #[serde(default)]
    pub platform: Option<String>,
    #[serde(default)]
    pub kind: ServiceKind,
    #[serde(rename = "upstreamService", default)]
    pub upstream_service: Option<String>,
    #[serde(rename = "oauthProvider", default)]
    pub oauth_provider: Option<String>,
    #[serde(rename = "configKeys", default)]
    pub config_keys: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuthConfig {
    #[serde(default)]
    pub schemes: Vec<AuthScheme>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum AuthScheme {
    Bearer {
        header: String,
        format: String,
        #[serde(rename = "secretKind")]
        secret_kind: String,
    },
    ApiKey {
        header: String,
        #[serde(rename = "secretKind")]
        secret_kind: String,
    },
    QueryApiKey {
        param: String,
        #[serde(rename = "secretKind")]
        secret_kind: String,
    },
    #[serde(rename = "oauth")]
    OAuth {
        #[serde(default)]
        provider: Option<String>,
        scopes: Vec<String>,
        #[serde(rename = "tokenRef", default)]
        token_ref: Option<String>,
    },
    SigV4 {
        service: String,
        #[serde(rename = "regionParam", default)]
        region_param: Option<String>,
    },
    CloudflareBinding,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RoutingConfig {
    #[serde(rename = "nativePrefixes", default)]
    pub native_prefixes: Vec<String>,
    #[serde(rename = "modelPrefixes", default)]
    pub model_prefixes: Vec<String>,
    #[serde(rename = "baseUrlParam", default)]
    pub base_url_param: Option<String>,
    #[serde(rename = "serviceParam", default)]
    pub service_param: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AdapterConfig {
    #[serde(default)]
    pub request: Option<String>,
    #[serde(default)]
    pub response: Option<String>,
    #[serde(default)]
    pub stream: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(rename = "passthroughHeaders", default)]
    pub passthrough_headers: Vec<String>,
    #[serde(rename = "injectHeaders", default)]
    pub inject_headers: BTreeMap<String, String>,
    #[serde(rename = "injectQuery", default)]
    pub inject_query: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Capability {
    pub id: String,
    pub endpoint: String,
    #[serde(default)]
    pub methods: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Endpoint {
    pub path: String,
    #[serde(default = "default_post")]
    pub method: String,
    #[serde(default)]
    pub auth: Option<String>,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default)]
    pub query: BTreeMap<String, String>,
    #[serde(rename = "pathParams", default)]
    pub path_params: Vec<String>,
    #[serde(rename = "pathParamStyles", default)]
    pub path_param_styles: BTreeMap<String, PathParamStyle>,
    #[serde(rename = "requestFormat")]
    pub request_format: String,
    #[serde(rename = "responseFormat")]
    pub response_format: String,
    #[serde(default)]
    pub streaming: Option<String>,
    #[serde(rename = "timeoutMs", default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PathParamStyle {
    #[default]
    Segment,
    RelativePath,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelCatalog {
    #[serde(default)]
    pub entries: Vec<ModelEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelEntry {
    pub id: String,
    pub upstream: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(rename = "pricingRef", default)]
    pub pricing_ref: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BillingConfig {
    #[serde(default)]
    pub meter: Option<String>,
    #[serde(default)]
    pub dimensions: Vec<String>,
    #[serde(default)]
    pub counters: Vec<MeterCounter>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MeterCounter {
    pub name: String,
    pub source: String,
    #[serde(default)]
    pub unit: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderTests {
    #[serde(default)]
    pub fixtures: Vec<TestFixture>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TestFixture {
    pub name: String,
    pub request: String,
    pub response: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompiledProvider {
    pub id: String,
    pub display_name: String,
    pub status: ProviderStatus,
    pub class: ProviderClass,
    pub service_platform: String,
    pub service_kind: ServiceKind,
    pub config_keys: Vec<String>,
    pub auth: AuthConfig,
    pub auth_schemes: Vec<String>,
    pub base_urls: BTreeMap<String, String>,
    pub routing: RoutingConfig,
    pub native_prefixes: Vec<String>,
    pub adapter: AdapterConfig,
    pub capabilities: Vec<CompiledCapability>,
    pub endpoints: Vec<CompiledEndpoint>,
    pub models: Vec<CompiledModel>,
    pub billing: BillingConfig,
    pub meter: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompiledCapability {
    pub id: String,
    pub endpoint: String,
    pub methods: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompiledModel {
    pub id: String,
    pub upstream: String,
    pub capabilities: Vec<String>,
    pub pricing_ref: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompiledEndpoint {
    pub id: String,
    pub method: String,
    pub methods: Vec<String>,
    pub path: String,
    pub auth: Option<String>,
    pub headers: BTreeMap<String, String>,
    pub query: BTreeMap<String, String>,
    pub path_params: Vec<String>,
    pub path_param_styles: BTreeMap<String, PathParamStyle>,
    pub request_format: String,
    pub response_format: String,
    pub streaming: Option<String>,
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderSnapshot {
    pub version: String,
    pub providers: Vec<CompiledProvider>,
    pub capability_index: BTreeMap<String, Vec<CapabilityRoute>>,
    pub model_index: BTreeMap<String, ModelRoute>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CapabilityRoute {
    pub provider: String,
    pub endpoint: String,
    pub methods: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelRoute {
    pub provider: String,
    pub upstream: String,
    pub capabilities: Vec<String>,
    pub pricing_ref: Option<String>,
}

#[derive(Debug, Error)]
pub enum ProviderError {
    #[error("provider {provider} has unsupported schema {schema}")]
    UnsupportedSchema { provider: String, schema: String },
    #[error("provider id is empty")]
    EmptyProviderId,
    #[error("provider {0} has no auth schemes")]
    MissingAuth(String),
    #[error("provider {0} is missing baseUrls.default")]
    MissingDefaultBaseUrl(String),
    #[error("provider {0} has no endpoints")]
    MissingEndpoints(String),
    #[error("provider {0} has no capabilities")]
    MissingCapabilities(String),
    #[error("provider {provider} endpoint {endpoint} path must start with /")]
    InvalidEndpointPath { provider: String, endpoint: String },
    #[error("provider {provider} endpoint {endpoint} path parameter {param} is not declared")]
    MissingPathParam {
        provider: String,
        endpoint: String,
        param: String,
    },
    #[error("provider {provider} capability {capability} references missing endpoint {endpoint}")]
    MissingEndpoint {
        provider: String,
        capability: String,
        endpoint: String,
    },
    #[error("provider {provider} model {model} references missing capability {capability}")]
    MissingModelCapability {
        provider: String,
        model: String,
        capability: String,
    },
    #[error("duplicate provider id {0}")]
    DuplicateProvider(String),
    #[error("duplicate model id {0}")]
    DuplicateModel(String),
}

pub fn validate_provider_manifest(manifest: &ProviderManifest) -> Result<(), ProviderError> {
    if manifest.schema != "clawrouter.service-provider.v1" {
        return Err(ProviderError::UnsupportedSchema {
            provider: manifest.id.clone(),
            schema: manifest.schema.clone(),
        });
    }
    if manifest.id.trim().is_empty() {
        return Err(ProviderError::EmptyProviderId);
    }
    if manifest.auth.schemes.is_empty() {
        return Err(ProviderError::MissingAuth(manifest.id.clone()));
    }
    if !manifest.base_urls.contains_key("default") {
        return Err(ProviderError::MissingDefaultBaseUrl(manifest.id.clone()));
    }
    if manifest.endpoints.is_empty() {
        return Err(ProviderError::MissingEndpoints(manifest.id.clone()));
    }
    if manifest.capabilities.is_empty() {
        return Err(ProviderError::MissingCapabilities(manifest.id.clone()));
    }
    for (endpoint_id, endpoint) in &manifest.endpoints {
        if !endpoint.path.starts_with('/') {
            return Err(ProviderError::InvalidEndpointPath {
                provider: manifest.id.clone(),
                endpoint: endpoint_id.clone(),
            });
        }
        for param in template_placeholders(&endpoint.path) {
            if !endpoint
                .path_params
                .iter()
                .any(|declared| declared == &param)
            {
                return Err(ProviderError::MissingPathParam {
                    provider: manifest.id.clone(),
                    endpoint: endpoint_id.clone(),
                    param,
                });
            }
        }
        for param in endpoint.path_param_styles.keys() {
            if !endpoint
                .path_params
                .iter()
                .any(|declared| declared == param)
            {
                return Err(ProviderError::MissingPathParam {
                    provider: manifest.id.clone(),
                    endpoint: endpoint_id.clone(),
                    param: param.clone(),
                });
            }
        }
    }
    let capability_ids: BTreeSet<_> = manifest
        .capabilities
        .iter()
        .map(|capability| capability.id.as_str())
        .collect();
    for capability in &manifest.capabilities {
        if !manifest.endpoints.contains_key(&capability.endpoint) {
            return Err(ProviderError::MissingEndpoint {
                provider: manifest.id.clone(),
                capability: capability.id.clone(),
                endpoint: capability.endpoint.clone(),
            });
        }
    }
    for model in &manifest.models.entries {
        for capability in &model.capabilities {
            if !capability_ids.contains(capability.as_str()) {
                return Err(ProviderError::MissingModelCapability {
                    provider: manifest.id.clone(),
                    model: model.id.clone(),
                    capability: capability.clone(),
                });
            }
        }
    }
    Ok(())
}

pub fn compile_provider_snapshot(
    manifests: &[ProviderManifest],
) -> Result<ProviderSnapshot, ProviderError> {
    let mut seen = BTreeSet::new();
    let mut seen_models = BTreeSet::new();
    let mut providers = Vec::new();
    let mut capability_index: BTreeMap<String, Vec<CapabilityRoute>> = BTreeMap::new();
    let mut model_index = BTreeMap::new();

    for manifest in manifests {
        validate_provider_manifest(manifest)?;
        if !seen.insert(manifest.id.clone()) {
            return Err(ProviderError::DuplicateProvider(manifest.id.clone()));
        }
        for capability in &manifest.capabilities {
            let methods = effective_capability_methods(manifest, capability);
            capability_index
                .entry(capability.id.clone())
                .or_default()
                .push(CapabilityRoute {
                    provider: manifest.id.clone(),
                    endpoint: capability.endpoint.clone(),
                    methods,
                });
        }
        for model in &manifest.models.entries {
            if !seen_models.insert(model.id.clone()) {
                return Err(ProviderError::DuplicateModel(model.id.clone()));
            }
            model_index.insert(
                model.id.clone(),
                ModelRoute {
                    provider: manifest.id.clone(),
                    upstream: model.upstream.clone(),
                    capabilities: model.capabilities.clone(),
                    pricing_ref: model.pricing_ref.clone(),
                },
            );
        }
        let mut endpoint_methods: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
        for capability in &manifest.capabilities {
            let methods = endpoint_methods
                .entry(capability.endpoint.clone())
                .or_default();
            for method in &capability.methods {
                methods.insert(method.clone());
            }
        }
        let endpoints = manifest
            .endpoints
            .iter()
            .map(|(id, endpoint)| CompiledEndpoint {
                id: id.clone(),
                method: endpoint.method.clone(),
                methods: endpoint_methods
                    .get(id)
                    .map(|methods| methods.iter().cloned().collect())
                    .filter(|methods: &Vec<String>| !methods.is_empty())
                    .unwrap_or_else(|| vec![endpoint.method.clone()]),
                path: endpoint.path.clone(),
                auth: endpoint.auth.clone(),
                headers: endpoint.headers.clone(),
                query: endpoint.query.clone(),
                path_params: endpoint.path_params.clone(),
                path_param_styles: endpoint.path_param_styles.clone(),
                request_format: endpoint.request_format.clone(),
                response_format: endpoint.response_format.clone(),
                streaming: endpoint.streaming.clone(),
                timeout_ms: endpoint.timeout_ms,
            })
            .collect();
        providers.push(CompiledProvider {
            id: manifest.id.clone(),
            display_name: manifest.display_name.clone(),
            status: manifest.status.clone(),
            class: manifest.class.clone(),
            service_platform: manifest
                .service
                .platform
                .clone()
                .unwrap_or_else(|| manifest.id.clone()),
            service_kind: manifest.service.kind.clone(),
            config_keys: manifest.service.config_keys.clone(),
            auth: manifest.auth.clone(),
            auth_schemes: manifest.auth.schemes.iter().map(auth_scheme_id).collect(),
            base_urls: manifest.base_urls.clone(),
            routing: manifest.routing.clone(),
            native_prefixes: manifest.routing.native_prefixes.clone(),
            adapter: manifest.adapter.clone(),
            capabilities: manifest
                .capabilities
                .iter()
                .map(|cap| CompiledCapability {
                    id: cap.id.clone(),
                    endpoint: cap.endpoint.clone(),
                    methods: effective_capability_methods(manifest, cap),
                })
                .collect(),
            endpoints,
            models: manifest
                .models
                .entries
                .iter()
                .map(|model| CompiledModel {
                    id: model.id.clone(),
                    upstream: model.upstream.clone(),
                    capabilities: model.capabilities.clone(),
                    pricing_ref: model.pricing_ref.clone(),
                })
                .collect(),
            billing: manifest.billing.clone(),
            meter: manifest.billing.meter.clone(),
        });
    }

    Ok(ProviderSnapshot {
        version: "clawrouter.provider-snapshot.v1".to_string(),
        providers,
        capability_index,
        model_index,
    })
}

fn default_post() -> String {
    "POST".to_string()
}

fn auth_scheme_id(scheme: &AuthScheme) -> String {
    match scheme {
        AuthScheme::Bearer { secret_kind, .. } => format!("bearer:{secret_kind}"),
        AuthScheme::ApiKey { secret_kind, .. } => format!("api_key:{secret_kind}"),
        AuthScheme::QueryApiKey { secret_kind, .. } => format!("query_api_key:{secret_kind}"),
        AuthScheme::OAuth { provider, .. } => provider
            .as_ref()
            .map(|provider| format!("oauth:{provider}"))
            .unwrap_or_else(|| "oauth".to_string()),
        AuthScheme::SigV4 { service, .. } => format!("sigv4:{service}"),
        AuthScheme::CloudflareBinding => "cloudflare_binding".to_string(),
    }
}

fn effective_capability_methods(
    manifest: &ProviderManifest,
    capability: &Capability,
) -> Vec<String> {
    if !capability.methods.is_empty() {
        return capability.methods.clone();
    }
    manifest
        .endpoints
        .get(&capability.endpoint)
        .map(|endpoint| vec![endpoint.method.clone()])
        .unwrap_or_else(|| vec![default_post()])
}

fn template_placeholders(template: &str) -> Vec<String> {
    let mut params = Vec::new();
    let mut rest = template;
    while let Some(start) = rest.find("${") {
        let after_start = &rest[start + 2..];
        let Some(end) = after_start.find('}') else {
            break;
        };
        let param = &after_start[..end];
        if !param.is_empty() {
            params.push(param.to_string());
        }
        rest = &after_start[end + 1..];
    }
    params
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compiles_manifest_to_indexes() {
        let manifest: ProviderManifest = serde_yaml::from_str(
            r#"
schema: clawrouter.service-provider.v1
id: tavily
displayName: Tavily
class: rest_json
auth:
  schemes:
    - type: bearer
      header: Authorization
      format: "Bearer ${secret}"
      secretKind: api_key
baseUrls:
  default: https://api.tavily.com
routing:
  nativePrefixes: [clawrouter-tavily]
  modelPrefixes: [tavily/]
capabilities:
  - id: web.search
    endpoint: search
    methods: [GET, POST]
endpoints:
  search:
    path: /search
    pathParams: [query]
    requestFormat: tavily.search
    responseFormat: tavily.search
    timeoutMs: 120000
models:
  entries:
    - id: tavily/search
      upstream: search
      capabilities: [web.search]
billing:
  meter: clawrouter.requests
  dimensions: [provider, endpoint]
  counters:
    - name: request
      source: request.count
      unit: request
"#,
        )
        .unwrap();
        let snapshot = compile_provider_snapshot(&[manifest]).unwrap();
        assert_eq!(
            snapshot.capability_index["web.search"][0],
            CapabilityRoute {
                provider: "tavily".to_string(),
                endpoint: "search".to_string(),
                methods: vec!["GET".to_string(), "POST".to_string()]
            }
        );
        assert_eq!(snapshot.model_index["tavily/search"].provider, "tavily");
        assert_eq!(snapshot.model_index["tavily/search"].upstream, "search");
        assert_eq!(
            snapshot.providers[0].endpoints[0].path_params,
            vec!["query"]
        );
        assert_eq!(
            snapshot.providers[0].endpoints[0].methods,
            vec!["GET", "POST"]
        );
        assert_eq!(snapshot.providers[0].endpoints[0].timeout_ms, Some(120000));
        assert_eq!(
            snapshot.providers[0].routing.model_prefixes,
            vec!["tavily/"]
        );
        assert!(matches!(
            snapshot.providers[0].auth.schemes[0],
            AuthScheme::Bearer { .. }
        ));
        assert_eq!(
            snapshot.providers[0].billing.dimensions,
            vec!["provider", "endpoint"]
        );
        assert_eq!(snapshot.providers[0].billing.counters[0].name, "request");
    }

    #[test]
    fn rejects_model_capability_without_provider_capability() {
        let manifest: ProviderManifest = serde_yaml::from_str(
            r#"
schema: clawrouter.service-provider.v1
id: broken
displayName: Broken
auth:
  schemes:
    - type: bearer
      header: Authorization
      format: "Bearer ${secret}"
      secretKind: api_key
baseUrls:
  default: https://example.com
capabilities:
  - id: llm.chat
    endpoint: chat
endpoints:
  chat:
    path: /v1/chat/completions
    requestFormat: openai.chat_completions
    responseFormat: openai.chat_completions
models:
  entries:
    - id: broken/model
      upstream: model
      capabilities: [llm.responses]
"#,
        )
        .unwrap();
        let error = validate_provider_manifest(&manifest).unwrap_err();
        assert!(matches!(
            error,
            ProviderError::MissingModelCapability { .. }
        ));
    }

    #[test]
    fn rejects_unknown_manifest_fields() {
        let error = serde_yaml::from_str::<ProviderManifest>(
            r#"
schema: clawrouter.service-provider.v1
id: typo
displayName: Typo
auth:
  schemes:
    - type: bearer
      header: Authorization
      format: "Bearer ${secret}"
      secretKind: api_key
baseUrls:
  default: https://example.com
routing:
  modelPrefix: [typo/]
capabilities:
  - id: llm.chat
    endpoint: chat
endpoints:
  chat:
    path: /v1/chat/completions
    requestFormat: openai.chat_completions
    responseFormat: openai.chat_completions
"#,
        )
        .unwrap_err();
        assert!(error.to_string().contains("unknown field"));
    }

    #[test]
    fn rejects_manifest_without_capabilities() {
        let manifest: ProviderManifest = serde_yaml::from_str(
            r#"
schema: clawrouter.service-provider.v1
id: no-caps
displayName: No Caps
auth:
  schemes:
    - type: bearer
      header: Authorization
      format: "Bearer ${secret}"
      secretKind: api_key
baseUrls:
  default: https://example.com
capabilities: []
endpoints:
  chat:
    path: /v1/chat/completions
    requestFormat: openai.chat_completions
    responseFormat: openai.chat_completions
"#,
        )
        .unwrap();
        let error = validate_provider_manifest(&manifest).unwrap_err();
        assert!(matches!(error, ProviderError::MissingCapabilities(_)));
    }

    #[test]
    fn defaults_capability_methods_from_endpoint() {
        let manifest: ProviderManifest = serde_yaml::from_str(
            r#"
schema: clawrouter.service-provider.v1
id: default-method
displayName: Default Method
auth:
  schemes:
    - type: bearer
      header: Authorization
      format: "Bearer ${secret}"
      secretKind: api_key
baseUrls:
  default: https://example.com
capabilities:
  - id: llm.chat
    endpoint: chat
endpoints:
  chat:
    path: /v1/chat/completions
    requestFormat: openai.chat_completions
    responseFormat: openai.chat_completions
"#,
        )
        .unwrap();
        let snapshot = compile_provider_snapshot(&[manifest]).unwrap();
        assert_eq!(
            snapshot.capability_index["llm.chat"][0].methods,
            vec!["POST"]
        );
        assert_eq!(snapshot.providers[0].capabilities[0].methods, vec!["POST"]);
    }

    #[test]
    fn rejects_undeclared_path_template_params() {
        let manifest: ProviderManifest = serde_yaml::from_str(
            r#"
schema: clawrouter.service-provider.v1
id: bad-path
displayName: Bad Path
auth:
  schemes:
    - type: bearer
      header: Authorization
      format: "Bearer ${secret}"
      secretKind: api_key
baseUrls:
  default: https://example.com
capabilities:
  - id: tool.invoke
    endpoint: rest
endpoints:
  rest:
    path: /v1/${path}
    requestFormat: rest_json
    responseFormat: rest_json
"#,
        )
        .unwrap();
        let error = validate_provider_manifest(&manifest).unwrap_err();
        assert!(matches!(error, ProviderError::MissingPathParam { .. }));
    }

    #[test]
    fn rejects_undeclared_path_param_styles() {
        let manifest: ProviderManifest = serde_yaml::from_str(
            r#"
schema: clawrouter.service-provider.v1
id: bad-path-style
displayName: Bad Path Style
auth:
  schemes:
    - type: bearer
      header: Authorization
      format: "Bearer ${secret}"
      secretKind: api_key
baseUrls:
  default: https://example.com
capabilities:
  - id: tool.invoke
    endpoint: rest
endpoints:
  rest:
    path: /v1/${path}
    pathParams: [path]
    pathParamStyles:
      other: relative_path
    requestFormat: rest_json
    responseFormat: rest_json
"#,
        )
        .unwrap();
        let error = validate_provider_manifest(&manifest).unwrap_err();
        assert!(matches!(error, ProviderError::MissingPathParam { .. }));
    }
}
