use clawrouter_core::{
    parse_proxy_key, AuthScheme, CompiledEndpoint, CompiledProvider, ProviderClass,
    ProviderSnapshot, UsageEvent, UsageStatus,
};
use serde::Deserialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicU64, Ordering};
use wasm_bindgen::JsValue;
use worker::*;

const PROVIDER_SNAPSHOT: &str = include_str!(concat!(env!("OUT_DIR"), "/provider-snapshot.json"));
static USAGE_EVENT_COUNTER: AtomicU64 = AtomicU64::new(0);

#[event(fetch)]
async fn fetch(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    let url = req.url()?;
    if req.method() == Method::Get && url.path() == "/v1/health" {
        return Response::from_json(&serde_json::json!({
            "ok": true,
            "service": "clawrouter-edge",
            "runtime": "rust-wasm"
        }));
    }

    if req.method() == Method::Get && url.path() == "/v1/providers" {
        let snapshot = provider_snapshot()?;
        return Response::from_json(&snapshot);
    }

    if url.path() == "/v1/key/inspect" {
        return inspect_proxy_key(req.headers(), &env).await;
    }

    if req.method() == Method::Post && is_openai_compatible_path(url.path()) {
        return proxy_openai_compatible(req, env, url.path()).await;
    }

    if req.method() == Method::Post && url.path().starts_with("/v1/proxy/") {
        return proxy_manifest_endpoint(req, env, url.path()).await;
    }

    Response::from_json(&serde_json::json!({
        "error": {
            "code": "route_not_found",
            "message": "route not found"
        }
    }))
    .map(|resp| resp.with_status(404))
}

async fn proxy_openai_compatible(mut req: Request, env: Env, path: &str) -> Result<Response> {
    let snapshot = provider_snapshot()?;
    let raw_body = req.text().await?;
    let mut body = serde_json::from_str::<Value>(&raw_body).map_err(|error| {
        Error::RustError(format!("request body must be a JSON object: {error}"))
    })?;
    let model = body
        .get("model")
        .and_then(Value::as_str)
        .map(str::to_string);
    let Some(model) = model else {
        return json_error(
            "invalid_request",
            "request body must include string field `model`",
            400,
        );
    };
    let Some(route) = select_model_route(&snapshot, &model) else {
        return json_error(
            "model_not_supported",
            "no OpenAI-compatible provider route is registered for this model",
            404,
        );
    };
    let Some(endpoint) = select_endpoint(route.provider, &route.capabilities, path) else {
        return json_error(
            "endpoint_not_supported",
            "provider does not expose this OpenAI-compatible endpoint",
            404,
        );
    };
    let auth = match authorize_proxy_key(req.headers(), &env, &route.provider.id).await? {
        AuthOutcome::Allowed(auth) => auth,
        AuthOutcome::Denied(response) => return Ok(response),
    };
    let request_id = request_id(req.headers(), "openai");
    let capability = capability_for_path(&route.capabilities, path).unwrap_or("llm.unknown");
    if let Some(response) = preflight_budget(&auth.policy, route.provider, capability)? {
        return Ok(response);
    }
    let upstream_url = upstream_url(route.provider, endpoint)?;
    body["model"] = Value::String(route.upstream_model.clone());
    let upstream_body = serde_json::to_string(&body)?;

    let headers = provider_headers(req.headers(), &env, route.provider, endpoint)?;

    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(JsValue::from_str(&upstream_body)));
    let upstream_req = Request::new_with_init(&upstream_url, &init)?;
    let response = Fetch::Request(upstream_req).send().await?;
    enqueue_usage(
        &env,
        UsageRecord {
            auth: &auth,
            provider: route.provider,
            capability,
            model: Some(model.as_str()),
            request_id: &request_id,
            status: usage_status(response.status_code()),
        },
    )
    .await;
    Ok(response)
}

async fn proxy_manifest_endpoint(mut req: Request, env: Env, path: &str) -> Result<Response> {
    let snapshot = provider_snapshot()?;
    let Some(rest) = path.strip_prefix("/v1/proxy/") else {
        return json_error("route_not_found", "route not found", 404);
    };
    let Some((provider_id, endpoint_id)) = rest.split_once('/') else {
        return json_error(
            "invalid_proxy_route",
            "expected /v1/proxy/<provider>/<endpoint>",
            400,
        );
    };
    let Some(provider) = snapshot
        .providers
        .iter()
        .find(|provider| provider.id == provider_id)
    else {
        return json_error("provider_not_found", "provider is not registered", 404);
    };
    let Some(endpoint) = provider
        .endpoints
        .iter()
        .find(|endpoint| endpoint.id == endpoint_id)
    else {
        return json_error(
            "endpoint_not_found",
            "provider endpoint is not registered",
            404,
        );
    };
    let capability = provider
        .capabilities
        .iter()
        .find(|capability| capability.endpoint == endpoint.id)
        .map(|capability| capability.id.as_str())
        .unwrap_or("tool.invoke");
    let auth = match authorize_proxy_key(req.headers(), &env, &provider.id).await? {
        AuthOutcome::Allowed(auth) => auth,
        AuthOutcome::Denied(response) => return Ok(response),
    };
    if let Some(response) = preflight_budget(&auth.policy, provider, capability)? {
        return Ok(response);
    }

    let request_id = request_id(req.headers(), endpoint_id);
    let raw_body = req.text().await?;
    let proxy = match parse_proxy_request(&raw_body) {
        Ok(proxy) => proxy,
        Err(message) => return json_error("invalid_proxy_request", &message, 400),
    };
    let upstream_method = proxy
        .method
        .as_deref()
        .map(str::to_ascii_uppercase)
        .unwrap_or_else(|| endpoint.method.clone());
    if !endpoint
        .methods
        .iter()
        .any(|method| method == &upstream_method)
    {
        return json_error(
            "method_not_allowed",
            "requested upstream method is not allowed by provider manifest",
            405,
        );
    }
    if !supports_manifest_proxy(provider, endpoint) {
        return json_error(
            "provider_endpoint_not_supported",
            "provider endpoint requires edge support that is not configured yet",
            501,
        );
    }
    let upstream_url = match manifest_upstream_url(provider, endpoint, &proxy, Some(&env)) {
        Ok(url) => url,
        Err(ManifestProxyError::Client(message)) => {
            return json_error("invalid_proxy_request", &message, 400);
        }
        Err(ManifestProxyError::Runtime(error)) => return Err(error),
    };
    let upstream_body = serde_json::to_string(&proxy.body.unwrap_or(Value::Object(Map::new())))?;
    let headers = provider_headers(req.headers(), &env, provider, endpoint)?;

    let mut init = RequestInit::new();
    init.with_method(method_from_str(&upstream_method)?)
        .with_headers(headers);
    if upstream_method != "GET" {
        init.with_body(Some(JsValue::from_str(&upstream_body)));
    }
    let upstream_req = Request::new_with_init(&upstream_url, &init)?;
    let response = Fetch::Request(upstream_req).send().await?;
    enqueue_usage(
        &env,
        UsageRecord {
            auth: &auth,
            provider,
            capability,
            model: None,
            request_id: &request_id,
            status: usage_status(response.status_code()),
        },
    )
    .await;
    Ok(response)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KeyPolicy {
    enabled: bool,
    secret_sha256: String,
    #[serde(default)]
    providers: Vec<String>,
    #[serde(default)]
    tenant_id: Option<String>,
    #[serde(default)]
    monthly_budget_micros: Option<u64>,
}

struct AuthorizedKey {
    kid: String,
    policy: KeyPolicy,
}

enum AuthOutcome {
    Allowed(AuthorizedKey),
    Denied(Response),
}

async fn inspect_proxy_key(headers: &Headers, env: &Env) -> Result<Response> {
    let auth = headers.get("authorization")?.unwrap_or_default();
    let token = auth.strip_prefix("Bearer ").unwrap_or("");
    let key = match parse_proxy_key(token) {
        Ok(parts) => parts,
        Err(error) => {
            return Response::from_json(&serde_json::json!({
                "error": {
                    "code": "invalid_key_syntax",
                    "message": error.to_string()
                }
            }))
            .map(|resp| resp.with_status(400));
        }
    };
    let Ok(kv) = env.kv("POLICY_KV") else {
        return key_inspection_response(&key.kid, &format!("{:?}", key.mode), None, None);
    };
    let record = kv
        .get(&format!("keys/{}", key.kid))
        .text()
        .await
        .map_err(|error| Error::RustError(format!("failed to read key policy: {error}")))?;
    let Some(record) = record else {
        return key_inspection_response(
            &key.kid,
            &format!("{:?}", key.mode),
            None,
            Some("unknown_proxy_key"),
        );
    };
    let policy = serde_json::from_str::<KeyPolicy>(&record)
        .map_err(|error| Error::RustError(format!("key policy is invalid JSON: {error}")))?;
    let verification = key_verification(&key.secret, &policy);
    let verified_policy = inspect_policy_for_response(verification, &policy);
    key_inspection_response(
        &key.kid,
        &format!("{:?}", key.mode),
        verified_policy,
        Some(verification),
    )
}

fn key_verification(secret: &str, policy: &KeyPolicy) -> &'static str {
    (sha256_hex(secret) == policy.secret_sha256)
        .then_some("verified")
        .unwrap_or("invalid_secret")
}

fn inspect_policy_for_response<'a>(
    verification: &str,
    policy: &'a KeyPolicy,
) -> Option<&'a KeyPolicy> {
    (verification == "verified").then_some(policy)
}

fn key_inspection_response(
    kid: &str,
    mode: &str,
    policy: Option<&KeyPolicy>,
    verification: Option<&str>,
) -> Result<Response> {
    Response::from_json(&serde_json::json!({
        "kid": kid,
        "mode": mode.to_lowercase(),
        "syntaxValid": true,
        "verified": verification == Some("verified"),
        "verification": verification.unwrap_or("policy_store_unavailable"),
        "enabled": policy.map(|policy| policy.enabled),
        "providers": policy.map(|policy| &policy.providers),
        "tenantId": policy.and_then(|policy| policy.tenant_id.as_deref()),
        "monthlyBudgetMicros": policy.and_then(|policy| policy.monthly_budget_micros)
    }))
}

async fn authorize_proxy_key(
    headers: &Headers,
    env: &Env,
    provider_id: &str,
) -> Result<AuthOutcome> {
    let auth = headers.get("authorization")?.unwrap_or_default();
    let token = auth.strip_prefix("Bearer ").unwrap_or("");
    let key = match parse_proxy_key(token) {
        Ok(key) => key,
        Err(_) => {
            return json_error(
                "invalid_proxy_key",
                "a valid ClawRouter proxy key is required",
                401,
            )
            .map(AuthOutcome::Denied);
        }
    };
    let kv = match env.kv("POLICY_KV") {
        Ok(kv) => kv,
        Err(_) => {
            return json_error(
                "policy_store_unavailable",
                "POLICY_KV binding is required for proxy requests",
                503,
            )
            .map(AuthOutcome::Denied);
        }
    };
    let record = kv
        .get(&format!("keys/{}", key.kid))
        .text()
        .await
        .map_err(|error| Error::RustError(format!("failed to read key policy: {error}")))?;
    let Some(record) = record else {
        return json_error("unknown_proxy_key", "proxy key is not registered", 401)
            .map(AuthOutcome::Denied);
    };
    let policy = serde_json::from_str::<KeyPolicy>(&record)
        .map_err(|error| Error::RustError(format!("key policy is invalid JSON: {error}")))?;
    if !policy.enabled {
        return json_error("proxy_key_revoked", "proxy key is revoked", 403)
            .map(AuthOutcome::Denied);
    }
    if sha256_hex(&key.secret) != policy.secret_sha256 {
        return json_error("invalid_proxy_key", "proxy key secret is invalid", 401)
            .map(AuthOutcome::Denied);
    }
    if !policy.providers.is_empty() && !policy.providers.iter().any(|id| id == provider_id) {
        return json_error(
            "provider_not_allowed",
            "proxy key is not allowed to use this provider",
            403,
        )
        .map(AuthOutcome::Denied);
    }
    Ok(AuthOutcome::Allowed(AuthorizedKey {
        kid: key.kid,
        policy,
    }))
}

fn provider_snapshot() -> Result<ProviderSnapshot> {
    serde_json::from_str(PROVIDER_SNAPSHOT).map_err(|error| {
        Error::RustError(format!("compiled provider snapshot is invalid: {error}"))
    })
}

fn is_openai_compatible_path(path: &str) -> bool {
    matches!(
        path,
        "/v1/chat/completions" | "/v1/responses" | "/v1/embeddings"
    )
}

struct SelectedRoute<'a> {
    provider: &'a CompiledProvider,
    upstream_model: String,
    capabilities: Vec<String>,
}

fn select_model_route<'a>(
    snapshot: &'a ProviderSnapshot,
    model: &str,
) -> Option<SelectedRoute<'a>> {
    for provider in &snapshot.providers {
        if !supports_openai_compatible_proxy(provider) {
            continue;
        }
        if let Some(model_entry) = provider.models.iter().find(|entry| entry.id == model) {
            return Some(SelectedRoute {
                provider,
                upstream_model: model_entry.upstream.clone(),
                capabilities: model_entry.capabilities.clone(),
            });
        }
    }
    snapshot.providers.iter().find_map(|provider| {
        if !supports_openai_compatible_proxy(provider) {
            return None;
        }
        provider.routing.model_prefixes.iter().find_map(|prefix| {
            let upstream_model = model.strip_prefix(prefix)?;
            (!upstream_model.is_empty()).then(|| SelectedRoute {
                provider,
                upstream_model: upstream_model.to_string(),
                capabilities: provider
                    .capabilities
                    .iter()
                    .map(|capability| capability.id.clone())
                    .collect(),
            })
        })
    })
}

fn supports_openai_compatible_proxy(provider: &CompiledProvider) -> bool {
    provider.class == ProviderClass::OpenaiCompatible
        && provider.adapter.request.as_deref() == Some("openai")
        && provider.adapter.response.as_deref() == Some("openai")
        && !contains_template(
            provider
                .base_urls
                .get("default")
                .map(String::as_str)
                .unwrap_or(""),
        )
        && provider
            .endpoints
            .iter()
            .all(|endpoint| !contains_template(&endpoint.path))
        && provider
            .adapter
            .inject_query
            .values()
            .all(|value| !contains_template(value))
        && provider
            .adapter
            .inject_headers
            .values()
            .all(|value| !contains_template(value))
        && supports_edge_auth(provider)
}

fn select_endpoint<'a>(
    provider: &'a CompiledProvider,
    capabilities: &[String],
    request_path: &str,
) -> Option<&'a CompiledEndpoint> {
    let capability = capability_for_path(capabilities, request_path)?;
    let endpoint_id = provider
        .capabilities
        .iter()
        .find(|candidate| candidate.id == capability)?
        .endpoint
        .as_str();
    provider
        .endpoints
        .iter()
        .find(|endpoint| endpoint.id == endpoint_id && endpoint.methods.iter().any(|m| m == "POST"))
}

fn capability_for_path(capabilities: &[String], request_path: &str) -> Option<&'static str> {
    let capability = match request_path {
        "/v1/chat/completions" => "llm.chat",
        "/v1/responses" => "llm.responses",
        "/v1/embeddings" => "llm.embeddings",
        _ => return None,
    };
    capabilities
        .iter()
        .any(|candidate| candidate == capability)
        .then_some(capability)
}

fn upstream_url(provider: &CompiledProvider, endpoint: &CompiledEndpoint) -> Result<String> {
    let base = provider.base_urls.get("default").ok_or_else(|| {
        Error::RustError(format!(
            "provider `{}` has no default base URL",
            provider.id
        ))
    })?;
    Ok(format!("{}{}", base.trim_end_matches('/'), endpoint.path))
}

fn contains_template(value: &str) -> bool {
    value.contains("${")
}

fn supports_manifest_proxy(provider: &CompiledProvider, endpoint: &CompiledEndpoint) -> bool {
    !contains_template(
        provider
            .base_urls
            .get("default")
            .map(String::as_str)
            .unwrap_or(""),
    ) && provider
        .adapter
        .inject_headers
        .values()
        .all(|value| !contains_template(value))
        && provider
            .adapter
            .inject_query
            .values()
            .all(|value| !contains_template(value))
        && endpoint
            .headers
            .values()
            .all(|value| !contains_template(value))
        && endpoint
            .query
            .values()
            .all(|value| !contains_template(value))
        && supports_edge_auth(provider)
}

fn supports_edge_auth(provider: &CompiledProvider) -> bool {
    provider.auth.schemes.iter().all(|scheme| match scheme {
        AuthScheme::Bearer { secret_kind, .. }
        | AuthScheme::ApiKey { secret_kind, .. }
        | AuthScheme::QueryApiKey { secret_kind, .. } => {
            provider_has_secret_candidate(provider, secret_kind)
        }
        AuthScheme::CloudflareBinding => true,
        AuthScheme::OAuth { .. } | AuthScheme::SigV4 { .. } => false,
    })
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestProxyRequest {
    #[serde(default)]
    method: Option<String>,
    #[serde(default)]
    path_params: Map<String, Value>,
    #[serde(default)]
    query: Map<String, Value>,
    #[serde(default)]
    body: Option<Value>,
}

#[derive(Debug)]
enum ManifestProxyError {
    Client(String),
    Runtime(Error),
}

fn parse_proxy_request(raw_body: &str) -> std::result::Result<ManifestProxyRequest, String> {
    if raw_body.trim().is_empty() {
        return Ok(ManifestProxyRequest::default());
    }
    serde_json::from_str(raw_body)
        .map_err(|error| format!("proxy request body is invalid JSON: {error}"))
}

fn manifest_upstream_url(
    provider: &CompiledProvider,
    endpoint: &CompiledEndpoint,
    proxy: &ManifestProxyRequest,
    env: Option<&Env>,
) -> std::result::Result<String, ManifestProxyError> {
    let base = provider.base_urls.get("default").ok_or_else(|| {
        ManifestProxyError::Runtime(Error::RustError(format!(
            "provider `{}` has no default base URL",
            provider.id
        )))
    })?;
    let mut path = endpoint.path.clone();
    for param in &endpoint.path_params {
        let Some(value) = proxy.path_params.get(param).and_then(Value::as_str) else {
            return Err(ManifestProxyError::Client(format!(
                "endpoint `{}` requires path param `{param}`",
                endpoint.id
            )));
        };
        let value =
            path_param_segment(endpoint, param, value).map_err(ManifestProxyError::Client)?;
        path = path.replace(&format!("${{{param}}}"), &value);
    }
    let mut url = format!("{}{}", base.trim_end_matches('/'), path);
    let mut query = endpoint.query.clone();
    for (name, value) in &proxy.query {
        if let Some(value) = query_value(value) {
            query.insert(name.clone(), value);
        }
    }
    for (name, value) in &provider.adapter.inject_query {
        query.insert(name.clone(), value.clone());
    }
    if let Some((param, secret)) =
        query_api_key(provider, env).map_err(ManifestProxyError::Runtime)?
    {
        query.insert(param, secret);
    }
    if !query.is_empty() {
        let pairs = query
            .iter()
            .map(|(name, value)| format!("{}={}", encode_component(name), encode_component(value)))
            .collect::<Vec<_>>()
            .join("&");
        url.push('?');
        url.push_str(&pairs);
    }
    Ok(url)
}

fn provider_headers(
    incoming: &Headers,
    env: &Env,
    provider: &CompiledProvider,
    endpoint: &CompiledEndpoint,
) -> Result<Headers> {
    let headers = Headers::new();
    headers.set("content-type", "application/json")?;
    for (name, value) in &provider.adapter.inject_headers {
        headers.set(name, value)?;
    }
    for (name, value) in &endpoint.headers {
        headers.set(name, value)?;
    }
    for header in &provider.adapter.passthrough_headers {
        if let Some(value) = incoming.get(header)? {
            headers.set(header, &value)?;
        }
    }
    apply_auth_headers(&headers, env, provider)?;
    Ok(headers)
}

fn path_param_segment(
    endpoint: &CompiledEndpoint,
    param: &str,
    value: &str,
) -> std::result::Result<String, String> {
    if value.is_empty()
        || value == "."
        || value == ".."
        || value.contains('/')
        || value.contains('\\')
        || value.contains('?')
        || value.contains('#')
        || value.chars().any(char::is_control)
    {
        return Err(format!(
            "endpoint `{}` path param `{param}` must be a single safe path segment",
            endpoint.id
        ));
    }
    Ok(encode_component(value))
}

fn provider_secret(env: &Env, provider: &CompiledProvider, secret_kind: &str) -> Result<String> {
    for binding in secret_binding_candidates(provider, secret_kind) {
        if let Ok(secret) = env.secret(&binding) {
            return Ok(secret.to_string());
        }
        if let Ok(var) = env.var(&binding) {
            return Ok(var.to_string());
        }
    }
    Err(Error::RustError(format!(
        "missing Cloudflare secret for provider `{}`",
        provider.id
    )))
}

fn secret_binding_candidates(provider: &CompiledProvider, secret_kind: &str) -> Vec<String> {
    let mut candidates = Vec::new();
    for key in &provider.config_keys {
        if config_key_matches_secret_kind(key, secret_kind) {
            candidates.push(key.clone());
        }
    }
    candidates.push(secret_binding_name(&provider.id, secret_kind));
    candidates.sort();
    candidates.dedup();
    candidates
}

fn config_key_matches_secret_kind(key: &str, secret_kind: &str) -> bool {
    match secret_kind {
        "api_token" => key.ends_with("_API_TOKEN") || key.ends_with("_TOKEN"),
        "api_key" => key.ends_with("_API_KEY") || key.ends_with("_API_TOKEN"),
        _ => key
            .to_ascii_uppercase()
            .ends_with(&secret_kind.to_ascii_uppercase()),
    }
}

fn provider_has_secret_candidate(provider: &CompiledProvider, secret_kind: &str) -> bool {
    secret_binding_candidates(provider, secret_kind)
        .iter()
        .any(|candidate| provider.config_keys.iter().any(|key| key == candidate))
}

fn apply_auth_headers(headers: &Headers, env: &Env, provider: &CompiledProvider) -> Result<()> {
    for scheme in &provider.auth.schemes {
        match scheme {
            AuthScheme::Bearer {
                header,
                format,
                secret_kind,
            } => {
                let secret = provider_secret(env, provider, secret_kind)?;
                headers.set(header, &format.replace("${secret}", &secret))?;
                return Ok(());
            }
            AuthScheme::ApiKey {
                header,
                secret_kind,
            } => {
                headers.set(header, &provider_secret(env, provider, secret_kind)?)?;
                return Ok(());
            }
            AuthScheme::QueryApiKey { .. } => {
                return Ok(());
            }
            AuthScheme::OAuth { .. } => {
                return Err(Error::RustError(format!(
                    "provider `{}` requires OAuth token storage, which is not wired yet",
                    provider.id
                )));
            }
            AuthScheme::SigV4 { .. } => {
                return Err(Error::RustError(format!(
                    "provider `{}` requires SigV4 signing, which is not wired yet",
                    provider.id
                )));
            }
            AuthScheme::CloudflareBinding => return Ok(()),
        }
    }
    Ok(())
}

fn query_api_key(
    provider: &CompiledProvider,
    env: Option<&Env>,
) -> Result<Option<(String, String)>> {
    let Some(env) = env else {
        return Ok(None);
    };
    for scheme in &provider.auth.schemes {
        if let AuthScheme::QueryApiKey { param, secret_kind } = scheme {
            return Ok(Some((
                param.clone(),
                provider_secret(env, provider, secret_kind)?,
            )));
        }
    }
    Ok(None)
}

fn method_from_str(method: &str) -> Result<Method> {
    match method {
        "GET" => Ok(Method::Get),
        "POST" => Ok(Method::Post),
        "PUT" => Ok(Method::Put),
        "PATCH" => Ok(Method::Patch),
        "DELETE" => Ok(Method::Delete),
        _ => Err(Error::RustError(format!("unsupported method `{method}`"))),
    }
}

fn secret_binding_name(provider_id: &str, secret_kind: &str) -> String {
    match (provider_id, secret_kind) {
        ("openai", "api_key") => "OPENAI_API_KEY".to_string(),
        ("openrouter", "api_key") => "OPENROUTER_API_KEY".to_string(),
        ("minimax", "api_key") => "MINIMAX_API_KEY".to_string(),
        ("tavily", "api_key") => "TAVILY_API_KEY".to_string(),
        _ => format!(
            "{}_{}",
            provider_id.replace('-', "_").to_uppercase(),
            "API_KEY"
        ),
    }
}

fn preflight_budget(
    policy: &KeyPolicy,
    _provider: &CompiledProvider,
    _capability: &str,
) -> Result<Option<Response>> {
    if policy.monthly_budget_micros == Some(0) {
        return json_error("budget_exhausted", "proxy key budget is exhausted", 402).map(Some);
    }
    Ok(None)
}

struct UsageRecord<'a> {
    auth: &'a AuthorizedKey,
    provider: &'a CompiledProvider,
    capability: &'a str,
    model: Option<&'a str>,
    request_id: &'a str,
    status: UsageStatus,
}

async fn enqueue_usage(env: &Env, record: UsageRecord<'_>) {
    let Ok(queue) = env.queue("USAGE_QUEUE") else {
        return;
    };
    let mut event = UsageEvent::new_success(
        usage_event_id(record.request_id),
        record
            .auth
            .policy
            .tenant_id
            .clone()
            .unwrap_or_else(|| "default".to_string()),
        record.auth.kid.clone(),
        record.request_id.to_string(),
        record.provider.id.clone(),
        record.capability.to_string(),
    );
    event.model = record.model.map(str::to_string);
    event.status = record.status;
    let _ = queue.send(event).await;
}

fn usage_event_id(request_id: &str) -> String {
    let seq = next_usage_event_sequence();
    format!("usage_{}_{}_{}", Date::now().as_millis(), seq, request_id)
}

fn next_usage_event_sequence() -> u64 {
    USAGE_EVENT_COUNTER.fetch_add(1, Ordering::Relaxed)
}

fn usage_status(status: u16) -> UsageStatus {
    match status {
        200..=299 => UsageStatus::Success,
        400..=499 => UsageStatus::ClientError,
        _ => UsageStatus::ProviderError,
    }
}

fn request_id(headers: &Headers, fallback: &str) -> String {
    headers
        .get("x-request-id")
        .ok()
        .flatten()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| format!("req_{}_{}", fallback, Date::now().as_millis()))
}

fn query_value(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::Bool(value) => Some(value.to_string()),
        Value::Number(value) => Some(value.to_string()),
        Value::String(value) => Some(value.clone()),
        _ => Some(value.to_string()),
    }
}

fn encode_component(value: &str) -> String {
    value
        .bytes()
        .flat_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                vec![byte as char]
            }
            _ => format!("%{byte:02X}").chars().collect(),
        })
        .collect()
}

fn sha256_hex(input: &str) -> String {
    let digest = Sha256::digest(input.as_bytes());
    let mut output = String::with_capacity(digest.len() * 2);
    for byte in digest {
        output.push_str(&format!("{byte:02x}"));
    }
    output
}

fn json_error(code: &str, message: &str, status: u16) -> Result<Response> {
    Response::from_json(&serde_json::json!({
        "error": {
            "code": code,
            "message": message
        }
    }))
    .map(|response| response.with_status(status))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefix_models_keep_requested_upstream_model() {
        let snapshot = provider_snapshot().unwrap();
        let route = select_model_route(&snapshot, "openai/gpt-new").unwrap();
        assert_eq!(route.provider.id, "openai");
        assert_eq!(route.upstream_model, "gpt-new");
        assert!(route.capabilities.iter().any(|cap| cap == "llm.chat"));
        assert!(
            select_endpoint(route.provider, &route.capabilities, "/v1/chat/completions").is_some()
        );
    }

    #[test]
    fn catalog_models_use_mapped_upstream_model() {
        let snapshot = provider_snapshot().unwrap();
        let route = select_model_route(&snapshot, "openai/gpt-5.5-mini").unwrap();
        assert_eq!(route.provider.id, "openai");
        assert_eq!(route.upstream_model, "gpt-5.5-mini");
    }

    #[test]
    fn openai_proxy_excludes_template_and_non_openai_adapters() {
        let snapshot = provider_snapshot().unwrap();
        assert!(select_model_route(&snapshot, "azure-openai/my-deployment").is_none());
        assert!(select_model_route(&snapshot, "cohere/default").is_none());
        assert!(select_model_route(&snapshot, "cloudflare-ai-gateway/auto").is_none());
    }

    #[test]
    fn openai_proxy_support_filter_requires_openai_adapter_without_templates() {
        let snapshot = provider_snapshot().unwrap();
        let openai = snapshot
            .providers
            .iter()
            .find(|provider| provider.id == "openai")
            .unwrap();
        let azure = snapshot
            .providers
            .iter()
            .find(|provider| provider.id == "azure-openai")
            .unwrap();
        assert!(supports_openai_compatible_proxy(openai));
        assert!(!supports_openai_compatible_proxy(azure));
    }

    #[test]
    fn openai_proxy_support_filter_rejects_templated_headers() {
        let snapshot = provider_snapshot().unwrap();
        let openrouter = snapshot
            .providers
            .iter()
            .find(|provider| provider.id == "openrouter")
            .unwrap();
        assert!(!supports_openai_compatible_proxy(openrouter));
    }

    #[test]
    fn manifest_proxy_rejects_unresolved_base_templates() {
        let snapshot = provider_snapshot().unwrap();
        let provider = snapshot
            .providers
            .iter()
            .find(|provider| provider.id == "azure-openai")
            .unwrap();
        let endpoint = provider
            .endpoints
            .iter()
            .find(|endpoint| endpoint.id == "chat_completions")
            .unwrap();
        assert!(!supports_manifest_proxy(provider, endpoint));
    }

    #[test]
    fn manifest_proxy_rejects_oauth_until_token_storage_exists() {
        let snapshot = provider_snapshot().unwrap();
        let provider = snapshot
            .providers
            .iter()
            .find(|provider| provider.id == "github")
            .unwrap();
        let endpoint = provider
            .endpoints
            .iter()
            .find(|endpoint| endpoint.id == "rest")
            .unwrap();
        assert!(!supports_manifest_proxy(provider, endpoint));
    }

    #[test]
    fn manifest_proxy_uses_manifest_secret_bindings() {
        let snapshot = provider_snapshot().unwrap();
        let huggingface = snapshot
            .providers
            .iter()
            .find(|provider| provider.id == "huggingface")
            .unwrap();
        let replicate = snapshot
            .providers
            .iter()
            .find(|provider| provider.id == "replicate")
            .unwrap();
        let google = snapshot
            .providers
            .iter()
            .find(|provider| provider.id == "google-gemini")
            .unwrap();

        assert!(secret_binding_candidates(huggingface, "api_token")
            .iter()
            .any(|binding| binding == "HUGGINGFACE_API_TOKEN"));
        assert!(secret_binding_candidates(replicate, "api_token")
            .iter()
            .any(|binding| binding == "REPLICATE_API_TOKEN"));
        assert!(secret_binding_candidates(google, "api_key")
            .iter()
            .any(|binding| binding == "GOOGLE_API_KEY"));
    }

    #[test]
    fn manifest_proxy_parse_errors_are_client_errors() {
        let error = parse_proxy_request("{not json").unwrap_err();
        assert!(error.contains("invalid JSON"));
    }

    #[test]
    fn key_verification_matches_registered_secret_hash() {
        let policy = KeyPolicy {
            enabled: true,
            secret_sha256: sha256_hex("secret"),
            providers: vec!["openai".to_string()],
            tenant_id: Some("team_docs".to_string()),
            monthly_budget_micros: Some(100),
        };

        assert_eq!(key_verification("secret", &policy), "verified");
        assert_eq!(key_verification("wrong", &policy), "invalid_secret");
        assert!(inspect_policy_for_response("verified", &policy).is_some());
        assert!(inspect_policy_for_response("invalid_secret", &policy).is_none());
    }

    #[test]
    fn manifest_proxy_builds_provider_endpoint_url() {
        let snapshot = provider_snapshot().unwrap();
        let provider = snapshot
            .providers
            .iter()
            .find(|provider| provider.id == "tavily")
            .unwrap();
        let endpoint = provider
            .endpoints
            .iter()
            .find(|endpoint| endpoint.id == "search")
            .unwrap();
        let proxy = ManifestProxyRequest {
            method: Some("POST".to_string()),
            query: Map::from_iter([("topic".to_string(), Value::String("news".to_string()))]),
            ..ManifestProxyRequest::default()
        };
        let url = manifest_upstream_url(provider, endpoint, &proxy, None).unwrap();
        assert_eq!(url, "https://api.tavily.com/search?topic=news");
    }

    #[test]
    fn manifest_proxy_encodes_safe_path_params() {
        let snapshot = provider_snapshot().unwrap();
        let provider = snapshot
            .providers
            .iter()
            .find(|provider| provider.id == "replicate")
            .unwrap();
        let endpoint = provider
            .endpoints
            .iter()
            .find(|endpoint| endpoint.id == "prediction")
            .unwrap();
        let proxy = ManifestProxyRequest {
            method: Some("GET".to_string()),
            path_params: Map::from_iter([(
                "prediction_id".to_string(),
                Value::String("abc 123".to_string()),
            )]),
            ..ManifestProxyRequest::default()
        };
        let url = manifest_upstream_url(provider, endpoint, &proxy, None).unwrap();
        assert_eq!(url, "https://api.replicate.com/v1/predictions/abc%20123");
    }

    #[test]
    fn manifest_proxy_rejects_path_params_that_escape_segments() {
        let snapshot = provider_snapshot().unwrap();
        let provider = snapshot
            .providers
            .iter()
            .find(|provider| provider.id == "github")
            .unwrap();
        let endpoint = provider
            .endpoints
            .iter()
            .find(|endpoint| endpoint.id == "rest")
            .unwrap();
        let proxy = ManifestProxyRequest {
            method: Some("GET".to_string()),
            path_params: Map::from_iter([(
                "path".to_string(),
                Value::String("repos/openclaw/clawrouter".to_string()),
            )]),
            ..ManifestProxyRequest::default()
        };
        let error = manifest_upstream_url(provider, endpoint, &proxy, None).unwrap_err();
        match error {
            ManifestProxyError::Client(message) => {
                assert!(message.contains("safe path segment"));
            }
            ManifestProxyError::Runtime(_) => panic!("expected client error"),
        }
    }

    #[test]
    fn usage_event_ids_include_a_sequence_component() {
        let first = next_usage_event_sequence();
        let second = next_usage_event_sequence();
        assert_ne!(first, second);
    }
}
