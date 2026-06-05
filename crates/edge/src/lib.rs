use clawrouter_core::{
    parse_proxy_key, AuthScheme, CompiledEndpoint, CompiledProvider, ProviderSnapshot,
};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use wasm_bindgen::JsValue;
use worker::*;

const PROVIDER_SNAPSHOT: &str = include_str!(concat!(env!("OUT_DIR"), "/provider-snapshot.json"));

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
        let auth = req.headers().get("authorization")?.unwrap_or_default();
        let token = auth.strip_prefix("Bearer ").unwrap_or("");
        return match parse_proxy_key(token) {
            Ok(parts) => Response::from_json(&serde_json::json!({
                "kid": parts.kid,
                "mode": format!("{:?}", parts.mode).to_lowercase(),
                "syntaxValid": true,
                "verified": false,
                "verification": "not_implemented"
            })),
            Err(error) => Response::from_json(&serde_json::json!({
                "error": {
                    "code": "invalid_key_syntax",
                    "message": error.to_string()
                }
            }))
            .map(|resp| resp.with_status(400)),
        };
    }

    if req.method() == Method::Post && is_openai_compatible_path(url.path()) {
        return proxy_openai_compatible(req, env, url.path()).await;
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
        .ok_or_else(|| Error::RustError("request body must include string field `model`".into()))?
        .to_string();
    let route = select_model_route(&snapshot, &model).ok_or_else(|| {
        Error::RustError(format!(
            "no provider route is registered for model `{model}`"
        ))
    })?;
    let endpoint = select_endpoint(route.provider, &route.capabilities, path).ok_or_else(|| {
        Error::RustError(format!(
            "provider `{}` does not expose `{path}` for model `{model}`",
            route.provider.id
        ))
    })?;
    if let Some(response) = authorize_proxy_key(req.headers(), &env, &route.provider.id).await? {
        return Ok(response);
    }
    let upstream_url = upstream_url(route.provider, endpoint)?;
    body["model"] = Value::String(route.upstream_model.clone());
    let upstream_body = serde_json::to_string(&body)?;
    let secret = provider_secret(&env, route.provider)?;

    let headers = Headers::new();
    headers.set("content-type", "application/json")?;
    headers.set("authorization", &format!("Bearer {secret}"))?;
    for header in &route.provider.adapter.passthrough_headers {
        if let Some(value) = req.headers().get(header)? {
            headers.set(header, &value)?;
        }
    }

    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(JsValue::from_str(&upstream_body)));
    let upstream_req = Request::new_with_init(&upstream_url, &init)?;
    Fetch::Request(upstream_req).send().await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KeyPolicy {
    enabled: bool,
    secret_sha256: String,
    #[serde(default)]
    providers: Vec<String>,
}

async fn authorize_proxy_key(
    headers: &Headers,
    env: &Env,
    provider_id: &str,
) -> Result<Option<Response>> {
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
            .map(Some);
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
            .map(Some);
        }
    };
    let record = kv
        .get(&format!("keys/{}", key.kid))
        .cache_ttl(60)
        .text()
        .await
        .map_err(|error| Error::RustError(format!("failed to read key policy: {error}")))?;
    let Some(record) = record else {
        return json_error("unknown_proxy_key", "proxy key is not registered", 401).map(Some);
    };
    let policy = serde_json::from_str::<KeyPolicy>(&record)
        .map_err(|error| Error::RustError(format!("key policy is invalid JSON: {error}")))?;
    if !policy.enabled {
        return json_error("proxy_key_revoked", "proxy key is revoked", 403).map(Some);
    }
    if sha256_hex(&key.secret) != policy.secret_sha256 {
        return json_error("invalid_proxy_key", "proxy key secret is invalid", 401).map(Some);
    }
    if !policy.providers.is_empty() && !policy.providers.iter().any(|id| id == provider_id) {
        return json_error(
            "provider_not_allowed",
            "proxy key is not allowed to use this provider",
            403,
        )
        .map(Some);
    }
    Ok(None)
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
        if let Some(model_entry) = provider.models.iter().find(|entry| entry.id == model) {
            return Some(SelectedRoute {
                provider,
                upstream_model: model_entry.upstream.clone(),
                capabilities: model_entry.capabilities.clone(),
            });
        }
    }
    snapshot.providers.iter().find_map(|provider| {
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

fn provider_secret(env: &Env, provider: &CompiledProvider) -> Result<String> {
    for scheme in &provider.auth.schemes {
        match scheme {
            AuthScheme::Bearer { secret_kind, .. } | AuthScheme::ApiKey { secret_kind, .. } => {
                let binding = secret_binding_name(&provider.id, secret_kind);
                if let Ok(secret) = env.secret(&binding) {
                    return Ok(secret.to_string());
                }
                if let Ok(var) = env.var(&binding) {
                    return Ok(var.to_string());
                }
            }
            _ => {}
        }
    }
    Err(Error::RustError(format!(
        "missing Cloudflare secret for provider `{}`",
        provider.id
    )))
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
}
