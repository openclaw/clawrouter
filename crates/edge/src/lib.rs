use clawrouter_core::{
    parse_proxy_key, AuthAuthorizationConfig, AuthScheme, CompiledEndpoint, CompiledModel,
    CompiledProvider, GrantTransportConfig, ModelPricing, PathParamStyle, PricedTokenUsage,
    ProviderClass, ProviderSnapshot, ProxyKeyParts, RequestCostEstimate, UsageEvent, UsageStatus,
};
use futures_channel::oneshot;
use futures_util::{future::try_join_all, Stream};
use hmac::{Hmac, Mac};
use js_sys::{Array, Function, Object, Promise, Reflect, Uint8Array};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::task::{Context as TaskContext, Poll};
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;
use worker::*;

const PROVIDER_SNAPSHOT: &str = include_str!(concat!(env!("OUT_DIR"), "/provider-snapshot.json"));
#[cfg(test)]
const PROVIDER_ICONS: &str = include_str!("provider-icons.json");
include!(concat!(env!("OUT_DIR"), "/admin-assets.rs"));
static USAGE_EVENT_COUNTER: AtomicU64 = AtomicU64::new(0);
const MAX_SQL_BUDGET_MICROS: u64 = 9_007_199_254_740_991;
const BUDGET_SETTLEMENT_ATTEMPTS: usize = 3;
const BUDGET_RESERVATION_LEASE_MS: u64 = 15 * 60 * 1_000;
const BUDGET_CHARGE_RETENTION_MS: u64 = 45 * 86_400_000;
const BUDGET_CLEANUP_INTERVAL_MS: i64 = 86_400_000;
const PROVIDER_HEALTH_MAX_AGE_MS: f64 = 86_400_000.0;
const OAUTH_AUTHORIZATION_TTL_MS: u64 = 10 * 60 * 1_000;
const UPSTREAM_GRANT_REFRESH_WINDOW_MS: f64 = 5.0 * 60.0 * 1_000.0;
const USAGE_EVENT_LIMIT: usize = 100;
const USAGE_EVENT_RETENTION_MS: u64 = 30 * 86_400_000;
const CONTENT_RETENTION_DAYS: u64 = 30;
const CONTENT_RETENTION_MS: u64 = CONTENT_RETENTION_DAYS * 86_400_000;
const CONTENT_RETENTION_HEADER: &str = "x-clawrouter-content-retention";
const USAGE_CLEANUP_INTERVAL_MS: i64 = 86_400_000;
const USAGE_AUDIT_FIELD_MAX_BYTES: usize = 256;
const USAGE_AUDIT_PRINCIPAL_MAX_BYTES: usize = 320;
const USAGE_AUDIT_MODEL_MAX_BYTES: usize = 512;
const USAGE_TOKEN_RESPONSE_MAX_BYTES: usize = 2 * 1024 * 1024;
const USAGE_SSE_EVENT_MAX_BYTES: usize = 256 * 1024;
const USAGE_SSE_EVENT_TAIL_BYTES: usize = 64 * 1024;
const NATIVE_JSON_INSPECTION_MAX_BYTES: usize = 8 * 1024 * 1024;
const ANTHROPIC_1M_CONTEXT_MIN_INPUT_TOKENS: u64 = 1_000_000;
const KV_BULK_GET_MAX_KEYS: usize = 100;
const UPSTREAM_PROVIDER_HEADER: &str = "x-clawrouter-upstream-provider";
const CORS_ALLOW_ORIGIN: &str = "*";
const CORS_ALLOW_METHODS: &str = "GET,POST,PUT,OPTIONS";
const CORS_ALLOW_HEADERS: &str = concat!(
    "authorization,content-type,x-api-key,anthropic-beta,anthropic-version,x-request-id,",
    "session-id,thread-id,session_id,x-clawrouter-session-id,x-clawrouter-agent-id,",
    "x-clawrouter-parent-agent-id,x-clawrouter-project-id,x-clawrouter-client,",
    "anthropic-dangerous-direct-browser-access,x-stainless-retry-count,",
    "x-stainless-timeout,x-stainless-lang,x-stainless-package-version,x-stainless-os,",
    "x-stainless-arch,x-stainless-runtime,x-stainless-runtime-version,",
    "x-stainless-helper-method,x-stainless-helper"
);
const CORS_MAX_AGE: &str = "600";
const ROOT_REDIRECT_PATH: &str = "/dashboard";
const POLICY_KV_ENTITLEMENTS_REQUIRED: &str =
    "POLICY_KV binding is required for Access entitlements";
type HmacSha256 = Hmac<Sha256>;
const MISSING_ADMIN_HTML: &str = r##"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ClawRouter Console Missing</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f8fafc; color: #111827; font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { width: min(520px, calc(100vw - 32px)); border: 1px solid #dbe3f0; border-radius: 6px; background: #fff; padding: 20px; }
    h1 { margin: 0 0 8px; font-size: 18px; line-height: 1.2; }
    p { margin: 0; color: #64748b; }
    code { border: 1px solid #e2e8f0; border-radius: 4px; background: #f8fafc; padding: 1px 4px; color: #111827; }
  </style>
</head>
<body>
  <main>
    <h1>Admin bundle missing</h1>
    <p>This Worker authenticated your Cloudflare Access session, but no built admin assets were embedded. Run <code>pnpm --dir admin build</code> and redeploy ClawRouter.</p>
  </main>
</body>
</html>"##;

#[event(fetch)]
async fn fetch(req: Request, env: Env, ctx: Context) -> Result<Response> {
    let url = req.url()?;
    let request_path = url.path().to_string();
    let api_path = canonical_api_path(&request_path);
    if req.method() == Method::Options && cors_enabled_path(&api_path) {
        return cors_preflight();
    }
    if req.method() == Method::Get && request_path == "/" {
        return redirect_to(&redirect_location(ROOT_REDIRECT_PATH, url.query()));
    }
    if req.method() == Method::Get && request_path == ROOT_REDIRECT_PATH {
        return redirect_to(&redirect_location("/dashboard/home", url.query()));
    }
    if req.method() == Method::Get {
        if let Some(target) = legacy_interface_redirect(url.path()) {
            let query = url
                .query()
                .map(|value| format!("?{value}"))
                .unwrap_or_default();
            return redirect_to(&format!("{target}{query}"));
        }
    }
    if req.method() == Method::Get && url.path() == "/v1" {
        return service_index().and_then(with_cors);
    }
    if req.method() == Method::Get {
        if let Some(response) = admin_asset_response(url.path())? {
            return Ok(response);
        }
    }
    if req.method() == Method::Get && interface_path(url.path()) {
        return protected_interface_shell(req.headers(), &env).await;
    }
    if req.method() == Method::Get && url.path() == "/v1/health" {
        return Response::from_json(&serde_json::json!({
            "ok": true,
            "service": "clawrouter-edge",
            "runtime": "rust-wasm"
        }))
        .and_then(with_cors);
    }

    if req.method() == Method::Get && url.path() == "/v1/providers" {
        let snapshot = provider_snapshot()?;
        return Response::from_json(&snapshot).and_then(with_cors);
    }

    if req.method() == Method::Get && api_path == "/v1/routes" {
        let snapshot = provider_snapshot()?;
        return Response::from_json(&route_catalog(&snapshot)).and_then(with_cors);
    }

    if req.method() == Method::Get && api_path == "/v1/session" {
        return session_profile(req.headers(), &env)
            .await
            .and_then(with_cors);
    }

    if req.method() == Method::Get && api_path == "/v1/session/avatar" {
        return session_avatar(req.headers(), &env)
            .await
            .and_then(with_cors);
    }

    if req.method() == Method::Get && api_path == "/v1/entitlements" {
        return access_entitlements(req.headers(), &env)
            .await
            .and_then(with_cors);
    }

    if req.method() == Method::Get && api_path == "/v1/session/usage" {
        return access_session_usage(req.headers(), &env)
            .await
            .and_then(with_cors);
    }

    if req.method() == Method::Get && api_path == "/v1/me" {
        return user_profile(req.headers(), &env).await.and_then(with_cors);
    }

    if req.method() == Method::Get && api_path == "/v1/usage" {
        return user_usage(req.headers(), &env).await.and_then(with_cors);
    }

    if req.method() == Method::Get && api_path == "/v1/models" {
        return client_models(req.headers(), &env).await.and_then(with_cors);
    }

    if req.method() == Method::Get && api_path == "/v1/catalog" {
        return client_catalog(req.headers(), &env)
            .await
            .and_then(with_cors);
    }

    if req.method() == Method::Get && api_path == "/v1/oauth/callback" {
        return oauth_authorization_callback(req, env).await;
    }

    if api_path.starts_with("/v1/admin/") {
        return admin_api(req, env, &api_path).await.and_then(with_cors);
    }

    if url.path() == "/v1/key/inspect" {
        return inspect_proxy_key(req.headers(), &env)
            .await
            .and_then(with_cors);
    }

    if req.method() == Method::Post {
        if let Some(playground_path) = api_path.strip_prefix("/v1/playground") {
            if is_openai_compatible_path(playground_path) {
                if !access_admin_csrf_allowed(&req.method(), req.headers(), &url)? {
                    return json_error(
                        "access_csrf_required",
                        "Cloudflare Access playground requests require a same-origin browser request",
                        403,
                    );
                }
                return proxy_openai_compatible(
                    req,
                    env,
                    &ctx,
                    playground_path,
                    ProxyAuthMode::AccessSession,
                )
                .await
                .and_then(with_cors);
            }
            if playground_path.starts_with("/proxy/") {
                if !access_admin_csrf_allowed(&req.method(), req.headers(), &url)? {
                    return json_error(
                        "access_csrf_required",
                        "Cloudflare Access playground requests require a same-origin browser request",
                        403,
                    );
                }
                return proxy_manifest_endpoint(
                    req,
                    env,
                    &ctx,
                    &format!("/v1{playground_path}"),
                    ProxyAuthMode::AccessSession,
                )
                .await
                .and_then(with_cors);
            }
        }
    }

    if req.method() == Method::Post && is_openai_compatible_path(url.path()) {
        return proxy_openai_compatible(req, env, &ctx, url.path(), ProxyAuthMode::ProxyKey)
            .await
            .and_then(with_cors);
    }

    if req.method() == Method::Post
        && matches!(url.path(), "/v1/messages" | "/v1/messages/count_tokens")
    {
        let native_path = format!("/v1/native/anthropic{}", url.path());
        return proxy_native_provider(req, env, &ctx, &native_path, ProxyAuthMode::ProxyKey)
            .await
            .and_then(with_cors);
    }

    if req.method() == Method::Post && url.path().starts_with("/v1/proxy/") {
        return proxy_manifest_endpoint(req, env, &ctx, url.path(), ProxyAuthMode::ProxyKey)
            .await
            .and_then(with_cors);
    }

    if url.path().starts_with("/v1/native/") {
        return proxy_native_provider(req, env, &ctx, url.path(), ProxyAuthMode::ProxyKey)
            .await
            .and_then(with_cors);
    }

    Response::from_json(&serde_json::json!({
        "error": {
            "code": "route_not_found",
            "message": "route not found"
        }
    }))
    .map(|resp| resp.with_status(404))
}

#[event(queue)]
async fn queue(batch: MessageBatch<QueueMessage>, env: Env, _ctx: Context) -> Result<()> {
    let usage_namespace = env.durable_object("USAGE_LEDGER");
    let budget_namespace = env.durable_object("BUDGET_LEDGER");
    for message in batch.messages()? {
        match message.body() {
            QueueMessage::Usage(event) => {
                let result = match usage_namespace.as_ref() {
                    Ok(namespace) => persist_usage_event(namespace, event).await,
                    Err(error) => Err(Error::RustError(format!(
                        "USAGE_LEDGER Durable Object binding is required for usage events: {error}"
                    ))),
                };
                match result {
                    Ok(()) => message.ack(),
                    Err(error) => {
                        console_error!("failed to persist usage event {}: {}", event.id, error);
                        message.retry();
                    }
                }
            }
            QueueMessage::Job(QueueJob::BudgetSettlement {
                tenant_id,
                policy_id,
                request,
            }) => {
                let result = match budget_namespace.as_ref() {
                    Ok(namespace) => {
                        persist_budget_settlement(namespace, tenant_id, policy_id, request).await
                    }
                    Err(error) => Err(Error::RustError(format!(
                        "BUDGET_LEDGER Durable Object binding is required for budget settlement retries: {error}"
                    ))),
                };
                match result {
                    Ok(()) => message.ack(),
                    Err(error) => {
                        console_error!(
                            "failed to replay budget settlement {}: {}",
                            request.reservation_id,
                            error
                        );
                        message.retry();
                    }
                }
            }
        }
    }
    Ok(())
}

fn service_index() -> Result<Response> {
    Response::from_json(&serde_json::json!({
        "ok": true,
        "service": "clawrouter-edge",
        "runtime": "rust-wasm",
        "interface": {
            "root": "/",
            "dashboard": "/dashboard",
            "playground": "/playground",
            "admin": "/admin",
            "account": "/account"
        },
        "endpoints": {
            "health": "/v1/health",
            "providers": "/v1/providers",
            "routes": "/v1/routes",
            "session": "/v1/session",
            "entitlements": "/v1/entitlements",
            "sessionUsage": "/v1/session/usage",
            "me": "/v1/me",
            "usage": "/v1/usage",
            "models": "/v1/models",
            "catalog": "/v1/catalog",
            "anthropicMessages": "/v1/messages",
            "anthropicCountTokens": "/v1/messages/count_tokens",
            "keyInspect": "/v1/key/inspect",
            "adminOverview": "/v1/admin/overview",
            "adminUsers": "/v1/admin/users",
            "adminUsage": "/v1/admin/usage",
            "adminContent": "/v1/admin/content?tenant={tenant}&ref={contentRef}",
            "adminAccessUsers": "/v1/admin/access-users",
            "adminAccessUserGrants": "/v1/admin/access-user-grants/{email}",
            "adminKeys": "/v1/admin/keys",
            "adminPolicies": "/v1/admin/policies",
            "adminCredentials": "/v1/admin/credentials",
            "adminConnections": "/v1/admin/connections",
            "adminUpstreamGrants": "/v1/admin/upstream-grants",
            "oauthCallback": "/v1/oauth/callback",
            "adminAssignmentRules": "/v1/admin/assignment-rules",
            "apiAliases": {
                "routes": ["/api/route", "/api/routes"],
                "session": "/api/session",
                "me": "/api/me",
                "usage": "/api/usage",
                "admin": "/api/admin/*"
            },
            "openaiCompatible": [
                "/v1/chat/completions",
                "/v1/responses",
                "/v1/embeddings"
            ],
            "manifestProxy": "/v1/proxy/{provider}/{endpoint}"
            ,"nativeProxy": "/v1/native/{provider}/{provider-native-path}"
        }
    }))
}

fn interface_path(path: &str) -> bool {
    path.starts_with("/dashboard/")
}

fn legacy_interface_redirect(path: &str) -> Option<&'static str> {
    match path {
        "/access" | "/admin" | "/policies" => Some("/dashboard/access"),
        "/account" | "/users" => Some("/dashboard/users"),
        "/catalog" | "/console" | "/routes" => Some("/dashboard/catalog"),
        "/playground" => Some("/dashboard/playground"),
        "/usage" => Some("/dashboard/usage"),
        _ => None,
    }
}

fn canonical_api_path(path: &str) -> String {
    match path {
        "/api/route" | "/api/routes" => "/v1/routes".to_string(),
        "/api/session" => "/v1/session".to_string(),
        "/api/entitlements" => "/v1/entitlements".to_string(),
        "/api/me" => "/v1/me".to_string(),
        "/api/usage" => "/v1/usage".to_string(),
        _ if path.starts_with("/api/admin/") => format!("/v1{}", path.trim_start_matches("/api")),
        _ => path.to_string(),
    }
}

async fn protected_interface_shell(headers: &Headers, env: &Env) -> Result<Response> {
    if verified_access_session(headers, env).await?.is_some() {
        return interface_shell();
    }
    json_error(
        "access_session_required",
        "ClawRouter console requires a verified Cloudflare Access session",
        401,
    )
}

fn interface_shell() -> Result<Response> {
    if let Some(html) = ADMIN_INDEX_HTML {
        let mut response = Response::from_html(html)?;
        response
            .headers_mut()
            .set("cache-control", "no-store, max-age=0")?;
        return Ok(response);
    }
    let mut response = Response::from_html(MISSING_ADMIN_HTML)?;
    response
        .headers_mut()
        .set("cache-control", "no-store, max-age=0")?;
    Ok(response)
}

fn admin_asset_response(path: &str) -> Result<Option<Response>> {
    let Some((_, content_type, bytes)) = ADMIN_ASSETS
        .iter()
        .copied()
        .find(|(asset_path, _, _)| *asset_path == path)
    else {
        return Ok(None);
    };
    let mut response = Response::from_bytes(bytes.to_vec())?;
    response.headers_mut().set("content-type", content_type)?;
    response
        .headers_mut()
        .set("cache-control", "public, max-age=31536000, immutable")?;
    Ok(Some(response))
}

fn redirect_to(location: &str) -> Result<Response> {
    let mut response = Response::empty()?.with_status(302);
    response.headers_mut().set("location", location)?;
    response
        .headers_mut()
        .set("cache-control", "no-store, max-age=0")?;
    Ok(response)
}

fn redirect_location(location: &str, query: Option<&str>) -> String {
    query
        .map(|value| format!("{location}?{value}"))
        .unwrap_or_else(|| location.to_string())
}

fn route_catalog(snapshot: &ProviderSnapshot) -> Value {
    let openai_compatible = snapshot
        .providers
        .iter()
        .filter(|provider| supports_openai_compatible_proxy(provider))
        .map(|provider| {
            let provider_capabilities = provider
                .capabilities
                .iter()
                .map(|capability| capability.id.clone())
                .collect::<Vec<_>>();
            serde_json::json!({
                "provider": provider.id,
                "models": provider.models.iter().map(|model| {
                    serde_json::json!({
                        "id": &model.id,
                        "capabilities": &model.capabilities,
                        "endpoints": openai_compatible_endpoint_paths(provider, &model.capabilities)
                    })
                }).collect::<Vec<_>>(),
                "modelPrefixes": &provider.routing.model_prefixes,
                "endpoints": openai_compatible_endpoint_paths(provider, &provider_capabilities)
            })
        })
        .collect::<Vec<_>>();
    let manifest_proxy = snapshot
        .providers
        .iter()
        .flat_map(|provider| {
            provider.endpoints.iter().map(move |endpoint| {
                let endpoint_capabilities = provider
                    .capabilities
                    .iter()
                    .filter(|capability| capability.endpoint == endpoint.id)
                    .map(|capability| capability.id.as_str())
                    .collect::<Vec<_>>();
                let sample_model = provider.models.iter().find(|model| {
                    model
                        .capabilities
                        .iter()
                        .any(|capability| endpoint_capabilities.contains(&capability.as_str()))
                });
                let models = provider
                    .models
                    .iter()
                    .filter(|model| {
                        model
                            .capabilities
                            .iter()
                            .any(|capability| endpoint_capabilities.contains(&capability.as_str()))
                    })
                    .map(|model| {
                        serde_json::json!({
                            "id": &model.id,
                            "capabilities": &model.capabilities
                        })
                    })
                    .collect::<Vec<_>>();
                serde_json::json!({
                    "provider": provider.id,
                    "endpoint": endpoint.id,
                    "route": format!("/v1/proxy/{}/{}", provider.id, endpoint.id),
                    "methods": &endpoint.methods,
                    "pathParams": &endpoint.path_params,
                    "requestFormat": &endpoint.request_format,
                    "sampleModel": sample_model.map(|model| model.id.as_str()),
                    "models": models,
                    "streaming": &endpoint.streaming
                })
            })
        })
        .collect::<Vec<_>>();
    let native_proxy = snapshot
        .providers
        .iter()
        .flat_map(|provider| {
            provider
                .endpoints
                .iter()
                .filter(|endpoint| endpoint.native_proxy)
                .map(move |endpoint| {
                    serde_json::json!({
                        "provider": provider.id,
                        "endpoint": endpoint.id,
                        "route": format!("/v1/native/{}{}", provider.id, endpoint.path),
                        "methods": &endpoint.methods,
                        "path": &endpoint.path,
                        "streaming": &endpoint.streaming
                    })
                })
        })
        .collect::<Vec<_>>();

    serde_json::json!({
        "version": "clawrouter.route-catalog.v1",
        "openaiCompatible": openai_compatible,
        "manifestProxy": manifest_proxy,
        "nativeProxy": native_proxy
    })
}

fn openai_compatible_endpoint_paths(
    provider: &CompiledProvider,
    capabilities: &[String],
) -> Vec<&'static str> {
    ["/v1/chat/completions", "/v1/responses", "/v1/embeddings"]
        .into_iter()
        .filter(|path| select_endpoint(provider, capabilities, path).is_some())
        .collect()
}

#[derive(Clone, Copy)]
enum ProxyAuthMode {
    ProxyKey,
    AccessSession,
}

async fn proxy_openai_compatible(
    mut req: Request,
    env: Env,
    ctx: &Context,
    path: &str,
    auth_mode: ProxyAuthMode,
) -> Result<Response> {
    let snapshot = provider_snapshot()?;
    let attribution = request_attribution(req.headers())?;
    let raw_body = req.text().await?;
    let mut body = serde_json::from_str::<Value>(&raw_body).map_err(|error| {
        Error::RustError(format!("request body must be a JSON object: {error}"))
    })?;
    let retained_body = body.clone();
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
    let auth = match authorize_request(
        req.headers(),
        &env,
        &route.provider.id,
        auth_mode,
        &attribution,
    )
    .await?
    {
        AuthOutcome::Allowed(auth) => auth,
        AuthOutcome::Denied(response) => return Ok(response),
    };
    let request_id = request_id(req.headers(), "openai");
    let capability = capability_for_path(&route.capabilities, path).unwrap_or("llm.unknown");
    let audit = ProxyAuditContext {
        env: &env,
        auth: &auth,
        provider: &route.provider.id,
        capability,
        model: Some(model.as_str()),
        request_id: &request_id,
        attribution: &attribution,
    };
    if let Some(response) = disabled_provider_connection_response(&env, &route.provider.id).await? {
        enqueue_denied_usage(
            &env,
            DeniedUsageRecord {
                auth: &auth,
                provider: &route.provider.id,
                capability,
                model: Some(model.as_str()),
                request_id: &request_id,
                status_code: response.status_code(),
                attribution: Some(&attribution),
            },
        )
        .await;
        return Ok(response);
    }
    if let Some(response) = preflight_static_budget(&auth.policy)? {
        enqueue_denied_usage(
            &env,
            DeniedUsageRecord {
                auth: &auth,
                provider: &route.provider.id,
                capability,
                model: Some(model.as_str()),
                request_id: &request_id,
                status_code: response.status_code(),
                attribution: Some(&attribution),
            },
        )
        .await;
        return Ok(response);
    }
    let upstream_model = match resolve_selected_upstream_model(&route, |provider, template| {
        resolve_template_value(provider, template, Some(&env))
    }) {
        Ok(value) => value,
        Err(error) => {
            let response = provider_runtime_error_response(error)?;
            return audit.failure_response(response).await;
        }
    };
    if let Err(error) = openai_endpoint_path(endpoint, &upstream_model) {
        let response = match error {
            OpenAiProxyUrlError::Client(message) => json_error("invalid_model", &message, 400)?,
            OpenAiProxyUrlError::Runtime(error) => provider_runtime_error_response(error)?,
        };
        return audit.failure_response(response).await;
    }
    let grant = match upstream_grant_for_request(&env, route.provider, endpoint, &auth).await {
        Ok(value) => value,
        Err(HeaderBuildError::Client {
            code,
            message,
            status,
        }) => {
            let response = json_error(code, message, status)?;
            return audit.failure_response(response).await;
        }
        Err(HeaderBuildError::Runtime(error)) => {
            let response = provider_runtime_error_response(error)?;
            return audit.failure_response(response).await;
        }
    };
    let (grant, transport_path) = match endpoint_upstream_grant(route.provider, endpoint, grant) {
        Ok(value) => value,
        Err(HeaderBuildError::Client {
            code,
            message,
            status,
        }) => {
            let response = json_error(code, message, status)?;
            return audit.failure_response(response).await;
        }
        Err(HeaderBuildError::Runtime(error)) => {
            let response = provider_runtime_error_response(error)?;
            return audit.failure_response(response).await;
        }
    };
    let query_auth = match query_api_key_for_grant(route.provider, &env, grant.as_ref()) {
        Ok(value) => value,
        Err(HeaderBuildError::Client {
            code,
            message,
            status,
        }) => {
            let response = json_error(code, message, status)?;
            return audit.failure_response(response).await;
        }
        Err(HeaderBuildError::Runtime(error)) => {
            let response = provider_runtime_error_response(error)?;
            return audit.failure_response(response).await;
        }
    };
    let upstream_url = match openai_upstream_url(
        route.provider,
        endpoint,
        &env,
        &upstream_model,
        query_auth,
        grant.as_ref(),
        transport_path.as_deref(),
    ) {
        Ok(url) => url,
        Err(OpenAiProxyUrlError::Client(message)) => {
            let response = json_error("invalid_model", &message, 400)?;
            return audit.failure_response(response).await;
        }
        Err(OpenAiProxyUrlError::Runtime(error)) => {
            let response = provider_runtime_error_response(error)?;
            return audit.failure_response(response).await;
        }
    };
    body["model"] = Value::String(upstream_model.clone());
    normalize_openai_proxy_body(route.provider, path, &upstream_model, Some(&env), &mut body);
    if let Err(message) = normalize_list_pricing_request(
        route.provider,
        path,
        route.pricing.is_some() && auth.policy.request_cost_micros.is_none(),
        &mut body,
    ) {
        return audit
            .failure_response(json_error("unsupported_pricing_mode", message, 400)?)
            .await;
    }
    if let Err(message) = validate_request_tool_pricing(
        &auth.policy,
        route.pricing.as_ref(),
        provider_tool_dialect(route.provider),
        capability,
        &body,
    ) {
        return audit
            .failure_response(json_error("fixed_price_required", message, 400)?)
            .await;
    }
    let upstream_body = serde_json::to_string(&body)?;
    let request_cost = RequestCost::for_capability(
        capability,
        &auth.policy,
        route.pricing_ref.as_deref(),
        route.pricing.as_ref(),
        upstream_body.as_bytes(),
        Some(&body),
    );

    let header_context = HeaderRequestContext {
        method: "POST",
        url: &upstream_url,
        body: Some(upstream_body.as_bytes()),
    };
    let headers = match provider_headers(
        req.headers(),
        &env,
        route.provider,
        endpoint,
        grant.as_ref(),
        header_context,
    )
    .await
    {
        Ok(headers) => headers,
        Err(HeaderBuildError::Client {
            code,
            message,
            status,
        }) => {
            let response = json_error(code, message, status)?;
            return audit.failure_response(response).await;
        }
        Err(HeaderBuildError::Runtime(error)) => {
            let response = provider_runtime_error_response(error)?;
            return audit.failure_response(response).await;
        }
    };

    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(JsValue::from_str(&upstream_body)));
    let upstream_req = match Request::new_with_init(&upstream_url, &init) {
        Ok(request) => request,
        Err(error) => {
            console_error!(
                "failed to build upstream request for provider {}: {}",
                route.provider.id,
                error
            );
            let response = json_error(
                "proxy_request_build_failed",
                "failed to build upstream provider request",
                500,
            )?;
            return audit.failure_response(response).await;
        }
    };
    let budget = match preflight_budget(&env, &auth, capability, &request_cost).await? {
        BudgetPreflight::Allowed(budget) => budget,
        BudgetPreflight::Denied(response) => {
            enqueue_denied_usage(
                &env,
                DeniedUsageRecord {
                    auth: &auth,
                    provider: &route.provider.id,
                    capability,
                    model: Some(model.as_str()),
                    request_id: &request_id,
                    status_code: response.status_code(),
                    attribution: Some(&attribution),
                },
            )
            .await;
            return Ok(response);
        }
    };
    let content_ref = match retain_request_content(
        &env,
        &auth,
        &route.provider.id,
        capability,
        Some(&model),
        &request_id,
        retained_body,
    )
    .await
    {
        Ok(content_ref) => content_ref,
        Err(_) => {
            settle_budget_after_response(&env, &auth, budget, 0).await;
            return audit
                .failure_response(json_error(
                    "content_retention_unavailable",
                    "request content retention is required but unavailable",
                    503,
                )?)
                .await;
        }
    };
    let started_at_ms = Date::now().as_millis();
    let response = send_upstream_request(upstream_req, &route.provider.id).await?;
    let status_code = response.status_code();
    finalize_proxy_response(
        response,
        ctx,
        ProxyCompletion {
            env: env.clone(),
            auth,
            attribution,
            provider: route.provider.id.clone(),
            capability: capability.to_string(),
            model: Some(model),
            request_id,
            budget,
            request_cost,
            status_code,
            started_at_ms,
            stream_requires_terminal_marker: usage_stream_requires_terminal_marker(
                route.provider.adapter.stream.as_deref(),
            ),
            content_ref,
        },
    )
    .await
}

async fn proxy_manifest_endpoint(
    mut req: Request,
    env: Env,
    ctx: &Context,
    path: &str,
    mode: ProxyAuthMode,
) -> Result<Response> {
    let snapshot = provider_snapshot()?;
    let attribution = request_attribution(req.headers())?;
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
    let auth =
        match authorize_request(req.headers(), &env, &provider.id, mode, &attribution).await? {
            AuthOutcome::Allowed(auth) => auth,
            AuthOutcome::Denied(response) => return Ok(response),
        };
    let request_id = request_id(req.headers(), endpoint_id);
    let audit = ProxyAuditContext {
        env: &env,
        auth: &auth,
        provider: &provider.id,
        capability,
        model: None,
        request_id: &request_id,
        attribution: &attribution,
    };
    if let Some(response) = disabled_provider_connection_response(&env, &provider.id).await? {
        enqueue_denied_usage(
            &env,
            DeniedUsageRecord {
                auth: &auth,
                provider: &provider.id,
                capability,
                model: None,
                request_id: &request_id,
                status_code: response.status_code(),
                attribution: Some(&attribution),
            },
        )
        .await;
        return Ok(response);
    }
    if let Some(response) = preflight_static_budget(&auth.policy)? {
        enqueue_denied_usage(
            &env,
            DeniedUsageRecord {
                auth: &auth,
                provider: &provider.id,
                capability,
                model: None,
                request_id: &request_id,
                status_code: response.status_code(),
                attribution: Some(&attribution),
            },
        )
        .await;
        return Ok(response);
    }
    let raw_body = match req.text().await {
        Ok(body) => body,
        Err(error) => {
            console_error!(
                "failed to read proxy request body for provider {}: {}",
                provider.id,
                error
            );
            let response = json_error(
                "invalid_proxy_request",
                "failed to read proxy request body",
                400,
            )?;
            return audit.failure_response(response).await;
        }
    };
    let retained_body = serde_json::from_str::<Value>(&raw_body).ok();
    let mut proxy = match parse_proxy_request(&raw_body) {
        Ok(proxy) => proxy,
        Err(message) => {
            let response = json_error("invalid_proxy_request", &message, 400)?;
            return audit.failure_response(response).await;
        }
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
        let response = json_error(
            "method_not_allowed",
            "requested upstream method is not allowed by provider manifest",
            405,
        )?;
        return audit.failure_response(response).await;
    }
    if !supports_manifest_proxy(provider, endpoint) {
        let response = json_error(
            "provider_endpoint_not_supported",
            "provider endpoint requires edge support that is not configured yet",
            501,
        )?;
        return audit.failure_response(response).await;
    }
    let path_model_selection =
        normalize_manifest_path_model(provider, endpoint, &mut proxy, |template| {
            resolve_template_value(provider, template, Some(&env)).ok()
        });
    let upstream_worker_method = match method_from_str(&upstream_method) {
        Ok(method) => method,
        Err(error) => {
            console_error!(
                "provider {} endpoint {} declares unsupported method: {}",
                provider.id,
                endpoint.id,
                error
            );
            let response = json_error(
                "provider_endpoint_not_supported",
                "provider endpoint method is not supported by the edge runtime",
                501,
            )?;
            return audit.failure_response(response).await;
        }
    };
    if let Err(ManifestProxyError::Client(message)) =
        validate_manifest_path_params(endpoint, &proxy)
    {
        let response = json_error("invalid_proxy_request", &message, 400)?;
        return audit.failure_response(response).await;
    }
    let grant = match upstream_grant_for_request(&env, provider, endpoint, &auth).await {
        Ok(value) => value,
        Err(HeaderBuildError::Client {
            code,
            message,
            status,
        }) => {
            let response = json_error(code, message, status)?;
            return audit.failure_response(response).await;
        }
        Err(HeaderBuildError::Runtime(error)) => {
            let response = provider_runtime_error_response(error)?;
            return audit.failure_response(response).await;
        }
    };
    let (grant, transport_path) = match endpoint_upstream_grant(provider, endpoint, grant) {
        Ok(value) => value,
        Err(HeaderBuildError::Client {
            code,
            message,
            status,
        }) => {
            let response = json_error(code, message, status)?;
            return audit.failure_response(response).await;
        }
        Err(HeaderBuildError::Runtime(error)) => {
            let response = provider_runtime_error_response(error)?;
            return audit.failure_response(response).await;
        }
    };
    let query_auth = match query_api_key_for_grant(provider, &env, grant.as_ref()) {
        Ok(value) => value,
        Err(HeaderBuildError::Client {
            code,
            message,
            status,
        }) => {
            let response = json_error(code, message, status)?;
            return audit.failure_response(response).await;
        }
        Err(HeaderBuildError::Runtime(error)) => {
            let response = provider_runtime_error_response(error)?;
            return audit.failure_response(response).await;
        }
    };
    let upstream_url = match manifest_upstream_url(
        provider,
        endpoint,
        &proxy,
        Some(&env),
        query_auth,
        grant.as_ref(),
        transport_path.as_deref(),
    ) {
        Ok(url) => url,
        Err(ManifestProxyError::Client(message)) => {
            let response = json_error("invalid_proxy_request", &message, 400)?;
            return audit.failure_response(response).await;
        }
        Err(ManifestProxyError::Runtime(error)) => {
            let response = provider_runtime_error_response(error)?;
            return audit.failure_response(response).await;
        }
    };
    let mut upstream_body_json = method_allows_body(&upstream_method)
        .then(|| proxy.body.unwrap_or(Value::Object(Map::new())));
    let body_model_selection = upstream_body_json.as_mut().and_then(|body| {
        normalize_manifest_body_model(provider, body, |template| {
            resolve_template_value(provider, template, Some(&env)).ok()
        })
    });
    let model_selection = path_model_selection.or(body_model_selection);
    if let Some(upstream_body_json) = upstream_body_json.as_mut() {
        if let Some(selection) = model_selection.as_ref() {
            normalize_openai_proxy_body(
                provider,
                manifest_transform_path(endpoint),
                &selection.upstream_model,
                Some(&env),
                upstream_body_json,
            );
        }
        let listed_pricing = model_selection
            .as_ref()
            .and_then(|selection| selection.pricing.as_ref())
            .is_some()
            && auth.policy.request_cost_micros.is_none();
        if let Err(message) = normalize_list_pricing_request(
            provider,
            &endpoint.path,
            listed_pricing,
            upstream_body_json,
        ) {
            return audit
                .failure_response(json_error("unsupported_pricing_mode", message, 400)?)
                .await;
        }
        let anthropic_beta = req.headers().get("anthropic-beta")?;
        if let Err(message) = validate_request_beta_pricing(
            &auth.policy,
            model_selection
                .as_ref()
                .and_then(|selection| selection.pricing.as_ref()),
            provider_tool_dialect(provider),
            capability,
            anthropic_beta.as_deref(),
        ) {
            return audit
                .failure_response(json_error("fixed_price_required", message, 400)?)
                .await;
        }
        if let Err(message) = validate_request_tool_pricing(
            &auth.policy,
            model_selection
                .as_ref()
                .and_then(|selection| selection.pricing.as_ref()),
            provider_tool_dialect(provider),
            capability,
            upstream_body_json,
        ) {
            return audit
                .failure_response(json_error("fixed_price_required", message, 400)?)
                .await;
        }
    }
    let upstream_body = upstream_body_json
        .as_ref()
        .map(serde_json::to_string)
        .transpose()?;
    let request_cost = RequestCost::for_capability(
        capability,
        &auth.policy,
        model_selection
            .as_ref()
            .and_then(|selection| selection.pricing_ref.as_deref()),
        model_selection
            .as_ref()
            .and_then(|selection| selection.pricing.as_ref()),
        upstream_body.as_deref().unwrap_or_default().as_bytes(),
        upstream_body_json.as_ref(),
    );
    let header_context = HeaderRequestContext {
        method: &upstream_method,
        url: &upstream_url,
        body: upstream_body.as_deref().map(str::as_bytes),
    };
    let headers = match provider_headers(
        req.headers(),
        &env,
        provider,
        endpoint,
        grant.as_ref(),
        header_context,
    )
    .await
    {
        Ok(headers) => headers,
        Err(HeaderBuildError::Client {
            code,
            message,
            status,
        }) => {
            let response = json_error(code, message, status)?;
            return audit.failure_response(response).await;
        }
        Err(HeaderBuildError::Runtime(error)) => {
            let response = provider_runtime_error_response(error)?;
            return audit.failure_response(response).await;
        }
    };

    let mut init = RequestInit::new();
    init.with_method(upstream_worker_method)
        .with_headers(headers);
    if let Some(upstream_body) = upstream_body {
        init.with_body(Some(JsValue::from_str(&upstream_body)));
    }
    let upstream_req = match Request::new_with_init(&upstream_url, &init) {
        Ok(request) => request,
        Err(error) => {
            console_error!(
                "failed to build upstream request for provider {}: {}",
                provider.id,
                error
            );
            let response = json_error(
                "proxy_request_build_failed",
                "failed to build upstream provider request",
                500,
            )?;
            return audit.failure_response(response).await;
        }
    };
    let budget = match preflight_budget(&env, &auth, capability, &request_cost).await? {
        BudgetPreflight::Allowed(budget) => budget,
        BudgetPreflight::Denied(response) => {
            enqueue_denied_usage(
                &env,
                DeniedUsageRecord {
                    auth: &auth,
                    provider: &provider.id,
                    capability,
                    model: None,
                    request_id: &request_id,
                    status_code: response.status_code(),
                    attribution: Some(&attribution),
                },
            )
            .await;
            return Ok(response);
        }
    };
    let content_ref = if let Some(retained_body) = retained_body {
        match retain_request_content(
            &env,
            &auth,
            &provider.id,
            capability,
            model_selection
                .as_ref()
                .map(|selection| selection.model.as_str()),
            &request_id,
            retained_body,
        )
        .await
        {
            Ok(content_ref) => content_ref,
            Err(_) => {
                settle_budget_after_response(&env, &auth, budget, 0).await;
                return audit
                    .failure_response(json_error(
                        "content_retention_unavailable",
                        "request content retention is required but unavailable",
                        503,
                    )?)
                    .await;
            }
        }
    } else {
        None
    };
    let started_at_ms = Date::now().as_millis();
    let response = send_upstream_request(upstream_req, &provider.id).await?;
    let status_code = response.status_code();
    finalize_proxy_response(
        response,
        ctx,
        ProxyCompletion {
            env: env.clone(),
            auth,
            attribution,
            provider: provider.id.clone(),
            capability: capability.to_string(),
            model: model_selection.map(|selection| selection.model),
            request_id,
            budget,
            request_cost,
            status_code,
            started_at_ms,
            stream_requires_terminal_marker: usage_stream_requires_terminal_marker(
                provider.adapter.stream.as_deref(),
            ),
            content_ref,
        },
    )
    .await
}

async fn proxy_native_provider(
    mut req: Request,
    env: Env,
    ctx: &Context,
    path: &str,
    auth_mode: ProxyAuthMode,
) -> Result<Response> {
    let snapshot = provider_snapshot()?;
    let attribution = request_attribution(req.headers())?;
    let Some(rest) = path.strip_prefix("/v1/native/") else {
        return json_error("route_not_found", "route not found", 404);
    };
    let Some((provider_id, native_rest)) = rest.split_once('/') else {
        return json_error(
            "invalid_native_route",
            "expected /v1/native/<provider>/<provider-native-path>",
            400,
        );
    };
    let native_path = format!("/{native_rest}");
    let Some(provider) = snapshot
        .providers
        .iter()
        .find(|provider| provider.id == provider_id)
    else {
        return json_error("provider_not_found", "provider is not registered", 404);
    };
    let method = req.method().to_string().to_ascii_uppercase();
    let Some(endpoint) = select_native_endpoint(provider, &method, &native_path) else {
        return json_error(
            "native_route_not_allowed",
            "provider-native path or method is not declared by the provider manifest",
            404,
        );
    };
    if !supports_native_proxy(provider, endpoint) {
        return json_error(
            "provider_endpoint_not_supported",
            "provider-native endpoint requires edge support that is not configured yet",
            501,
        );
    }
    let capability = provider
        .capabilities
        .iter()
        .find(|candidate| {
            candidate.endpoint == endpoint.id
                && candidate
                    .methods
                    .iter()
                    .any(|candidate| candidate == &method)
        })
        .or_else(|| {
            provider
                .capabilities
                .iter()
                .find(|candidate| candidate.endpoint == endpoint.id)
        })
        .map(|capability| capability.id.as_str())
        .unwrap_or("tool.invoke");
    let auth = match authorize_request(req.headers(), &env, &provider.id, auth_mode, &attribution)
        .await?
    {
        AuthOutcome::Allowed(auth) => auth,
        AuthOutcome::Denied(response) => return Ok(response),
    };
    let request_id = request_id(req.headers(), endpoint.id.as_str());
    let audit = ProxyAuditContext {
        env: &env,
        auth: &auth,
        provider: &provider.id,
        capability,
        model: None,
        request_id: &request_id,
        attribution: &attribution,
    };
    if let Some(response) = disabled_provider_connection_response(&env, &provider.id).await? {
        enqueue_denied_usage(
            &env,
            DeniedUsageRecord {
                auth: &auth,
                provider: &provider.id,
                capability,
                model: None,
                request_id: &request_id,
                status_code: response.status_code(),
                attribution: Some(&attribution),
            },
        )
        .await;
        return Ok(response);
    }
    if let Some(response) = preflight_static_budget(&auth.policy)? {
        enqueue_denied_usage(
            &env,
            DeniedUsageRecord {
                auth: &auth,
                provider: &provider.id,
                capability,
                model: None,
                request_id: &request_id,
                status_code: response.status_code(),
                attribution: Some(&attribution),
            },
        )
        .await;
        return Ok(response);
    }
    let incoming_url = req.url()?;
    let compatibility_route = matches!(
        incoming_url.path(),
        "/v1/messages" | "/v1/messages/count_tokens"
    );
    let grant = match upstream_grant_for_request(&env, provider, endpoint, &auth).await {
        Ok(value) => value,
        Err(HeaderBuildError::Client {
            code,
            message,
            status,
        }) => {
            let response = json_error(code, message, status)?;
            return audit.failure_response(response).await;
        }
        Err(HeaderBuildError::Runtime(error)) => {
            let response = provider_runtime_error_response(error)?;
            return audit.failure_response(response).await;
        }
    };
    let (grant, transport_path) = match endpoint_upstream_grant(provider, endpoint, grant) {
        Ok(value) => value,
        Err(HeaderBuildError::Client {
            code,
            message,
            status,
        }) => {
            let response = json_error(code, message, status)?;
            return audit.failure_response(response).await;
        }
        Err(HeaderBuildError::Runtime(error)) => {
            let response = provider_runtime_error_response(error)?;
            return audit.failure_response(response).await;
        }
    };
    let query_auth = match query_api_key_for_grant(provider, &env, grant.as_ref()) {
        Ok(value) => value,
        Err(HeaderBuildError::Client {
            code,
            message,
            status,
        }) => {
            let response = json_error(code, message, status)?;
            return audit.failure_response(response).await;
        }
        Err(HeaderBuildError::Runtime(error)) => {
            let response = provider_runtime_error_response(error)?;
            return audit.failure_response(response).await;
        }
    };
    let upstream_url = match native_upstream_url(
        provider,
        endpoint,
        &env,
        NativeUpstreamContext {
            native_path: &native_path,
            incoming_query: incoming_url.query(),
            query_auth,
            grant: grant.as_ref(),
            transport_path: transport_path.as_deref(),
        },
    ) {
        Ok(url) => url,
        Err(error) => {
            return audit
                .failure_response(provider_runtime_error_response(error)?)
                .await
        }
    };
    let mut body = if method_allows_body(&method) {
        Some(req.bytes().await?)
    } else {
        None
    };
    let retained_body = if content_retention_view(&auth).enabled && capability.starts_with("llm.") {
        match body.as_deref() {
            Some(body) => match serde_json::from_slice::<Value>(body) {
                Ok(body) => Some(body),
                Err(_) => {
                    return audit
                        .failure_response(json_error(
                            "invalid_json_body",
                            "request body must be valid JSON when content retention is enabled",
                            400,
                        )?)
                        .await;
                }
            },
            None => {
                return audit
                    .failure_response(json_error(
                        "invalid_json_body",
                        "request body is required when content retention is enabled",
                        400,
                    )?)
                    .await;
            }
        }
    } else {
        None
    };
    let inspect_json =
        native_request_needs_json_inspection(compatibility_route, capability, &auth.policy);
    if inspect_json
        && body
            .as_ref()
            .is_some_and(|body| body.len() > NATIVE_JSON_INSPECTION_MAX_BYTES)
    {
        return audit
            .failure_response(json_error(
                "request_body_too_large",
                "native JSON bodies requiring model and pricing inspection are limited to 8 MiB; use a fixed request price on the provider-native route for larger payloads",
                413,
            )?)
            .await;
    }
    let mut request_json = if inspect_json {
        match body.as_deref() {
            Some(body) => match serde_json::from_slice::<Value>(body) {
                Ok(value) => Some(value),
                Err(_) => {
                    return audit
                        .failure_response(json_error(
                            "invalid_json_body",
                            "request body must be valid JSON",
                            400,
                        )?)
                        .await
                }
            },
            None => None,
        }
    } else {
        None
    };
    let model_selection = if compatibility_route {
        request_json
            .as_mut()
            .and_then(|body| normalize_native_model(provider, body))
    } else {
        request_json
            .as_ref()
            .and_then(|body| select_native_model(provider, body))
    };
    if let Some(request_json) = request_json.as_mut() {
        let listed_pricing = model_selection
            .as_ref()
            .and_then(|selection| selection.pricing.as_ref())
            .is_some()
            && auth.policy.request_cost_micros.is_none();
        let pricing_mode_result = if compatibility_route {
            normalize_list_pricing_request(provider, &native_path, listed_pricing, request_json)
        } else {
            validate_native_list_pricing_request(
                provider,
                &native_path,
                listed_pricing,
                request_json,
            )
        };
        if let Err(message) = pricing_mode_result {
            return audit
                .failure_response(json_error("unsupported_pricing_mode", message, 400)?)
                .await;
        }
        let anthropic_beta = req.headers().get("anthropic-beta")?;
        if let Err(message) = validate_request_beta_pricing(
            &auth.policy,
            model_selection
                .as_ref()
                .and_then(|selection| selection.pricing.as_ref()),
            provider_tool_dialect(provider),
            capability,
            anthropic_beta.as_deref(),
        ) {
            return audit
                .failure_response(json_error("fixed_price_required", message, 400)?)
                .await;
        }
        if let Err(message) = validate_request_tool_pricing(
            &auth.policy,
            model_selection
                .as_ref()
                .and_then(|selection| selection.pricing.as_ref()),
            provider_tool_dialect(provider),
            capability,
            request_json,
        ) {
            return audit
                .failure_response(json_error("fixed_price_required", message, 400)?)
                .await;
        }
    }
    if compatibility_route {
        if let Some(request_json) = request_json.as_ref() {
            body = Some(serde_json::to_vec(request_json)?);
        }
    }
    let request_cost = RequestCost::for_capability(
        capability,
        &auth.policy,
        model_selection
            .as_ref()
            .and_then(|selection| selection.pricing_ref.as_deref()),
        model_selection
            .as_ref()
            .and_then(|selection| selection.pricing.as_ref()),
        body.as_deref().unwrap_or_default(),
        request_json.as_ref(),
    );
    drop(request_json);
    let header_context = HeaderRequestContext {
        method: &method,
        url: &upstream_url,
        body: body.as_deref(),
    };
    let headers = match native_provider_headers(
        req.headers(),
        &env,
        provider,
        endpoint,
        grant.as_ref(),
        header_context,
    )
    .await
    {
        Ok(headers) => headers,
        Err(HeaderBuildError::Client {
            code,
            message,
            status,
        }) => {
            let response = json_error(code, message, status)?;
            return audit.failure_response(response).await;
        }
        Err(HeaderBuildError::Runtime(error)) => {
            let response = provider_runtime_error_response(error)?;
            return audit.failure_response(response).await;
        }
    };
    let mut init = RequestInit::new();
    init.with_method(method_from_str(&method)?)
        .with_headers(headers);
    if let Some(body) = body.as_ref() {
        init.with_body(Some(Uint8Array::from(body.as_slice()).into()));
    }
    let upstream_req = match Request::new_with_init(&upstream_url, &init) {
        Ok(request) => request,
        Err(error) => {
            console_error!(
                "failed to build native upstream request for provider {}: {}",
                provider.id,
                error
            );
            let response = json_error(
                "proxy_request_build_failed",
                "failed to build upstream provider request",
                500,
            )?;
            return audit.failure_response(response).await;
        }
    };
    let budget = match preflight_budget(&env, &auth, capability, &request_cost).await? {
        BudgetPreflight::Allowed(budget) => budget,
        BudgetPreflight::Denied(response) => {
            enqueue_denied_usage(
                &env,
                DeniedUsageRecord {
                    auth: &auth,
                    provider: &provider.id,
                    capability,
                    model: None,
                    request_id: &request_id,
                    status_code: response.status_code(),
                    attribution: Some(&attribution),
                },
            )
            .await;
            return Ok(response);
        }
    };
    let content_ref = if let Some(retained_body) = retained_body {
        match retain_request_content(
            &env,
            &auth,
            &provider.id,
            capability,
            model_selection
                .as_ref()
                .map(|selection| selection.model.as_str()),
            &request_id,
            retained_body,
        )
        .await
        {
            Ok(content_ref) => content_ref,
            Err(_) => {
                settle_budget_after_response(&env, &auth, budget, 0).await;
                return audit
                    .failure_response(json_error(
                        "content_retention_unavailable",
                        "request content retention is required but unavailable",
                        503,
                    )?)
                    .await;
            }
        }
    } else {
        None
    };
    let started_at_ms = Date::now().as_millis();
    let response = send_upstream_request(upstream_req, &provider.id).await?;
    let status_code = response.status_code();
    let response = sanitize_native_response(response, endpoint)?;
    finalize_proxy_response(
        response,
        ctx,
        ProxyCompletion {
            env: env.clone(),
            auth,
            attribution,
            provider: provider.id.clone(),
            capability: capability.to_string(),
            model: model_selection.map(|selection| selection.model),
            request_id,
            budget,
            request_cost,
            status_code,
            started_at_ms,
            stream_requires_terminal_marker: usage_stream_requires_terminal_marker(
                provider.adapter.stream.as_deref(),
            ),
            content_ref,
        },
    )
    .await
}

fn select_native_endpoint<'a>(
    provider: &'a CompiledProvider,
    method: &str,
    path: &str,
) -> Option<&'a CompiledEndpoint> {
    provider.endpoints.iter().find(|endpoint| {
        endpoint.native_proxy
            && endpoint.methods.iter().any(|candidate| candidate == method)
            && native_endpoint_path_matches(endpoint, path)
    })
}

fn native_endpoint_path_matches(endpoint: &CompiledEndpoint, path: &str) -> bool {
    native_endpoint_path(endpoint, path).is_some()
}

fn native_endpoint_path(endpoint: &CompiledEndpoint, path: &str) -> Option<String> {
    let mut template_rest = endpoint.path.as_str();
    let mut path_rest = path;
    let mut normalized = String::with_capacity(path.len());
    while let Some(start) = template_rest.find("${") {
        let literal = &template_rest[..start];
        let after_literal = path_rest.strip_prefix(literal)?;
        normalized.push_str(literal);
        let after_start = &template_rest[start + 2..];
        let end = after_start.find('}')?;
        let param = &after_start[..end];
        let next_template = &after_start[end + 1..];
        let next_literal_end = next_template.find("${").unwrap_or(next_template.len());
        let next_literal = &next_template[..next_literal_end];
        let capture_end = if next_literal.is_empty() {
            after_literal.len()
        } else {
            after_literal.find(next_literal)?
        };
        let capture = &after_literal[..capture_end];
        let decoded = percent_decode_path_segment(capture)?;
        let encoded = path_param_value(endpoint, param, &decoded).ok()?;
        normalized.push_str(&encoded);
        path_rest = &after_literal[capture_end..];
        template_rest = next_template;
    }
    if path_rest != template_rest {
        return None;
    }
    normalized.push_str(template_rest);
    Some(normalized)
}

fn supports_native_proxy(provider: &CompiledProvider, endpoint: &CompiledEndpoint) -> bool {
    endpoint.native_proxy && supports_manifest_proxy(provider, endpoint)
}

struct NativeUpstreamContext<'a> {
    native_path: &'a str,
    incoming_query: Option<&'a str>,
    query_auth: Option<(String, String)>,
    grant: Option<&'a UpstreamGrantRecord>,
    transport_path: Option<&'a str>,
}

fn native_upstream_url(
    provider: &CompiledProvider,
    endpoint: &CompiledEndpoint,
    env: &Env,
    context: NativeUpstreamContext<'_>,
) -> Result<String> {
    let native_path = native_endpoint_path(endpoint, context.native_path).ok_or_else(|| {
        Error::RustError(format!(
            "provider-native path is not allowed for endpoint `{}`",
            endpoint.id
        ))
    })?;
    let base = provider_upstream_base_url(provider, context.grant)?;
    let base = resolve_template_value(provider, base, Some(env))?;
    let mut url = format!(
        "{}{}",
        base.trim_end_matches('/'),
        context.transport_path.unwrap_or(&native_path)
    );
    let mut injected = resolved_template_map(provider, &endpoint.query, Some(env))?;
    for (name, value) in resolved_template_map(provider, &provider.adapter.inject_query, Some(env))?
    {
        injected.insert(name, value);
    }
    if let Some((param, secret)) = context.query_auth {
        injected.insert(param, secret);
    }
    append_native_query(&mut url, context.incoming_query, injected)?;
    Ok(url)
}

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct AccessPolicy {
    enabled: bool,
    #[serde(default = "legacy_policy_generation")]
    generation: String,
    #[serde(default)]
    providers: Vec<String>,
    #[serde(default)]
    tenant_id: Option<String>,
    #[serde(default)]
    token_role: Option<String>,
    #[serde(default)]
    monthly_budget_micros: Option<u64>,
    #[serde(default)]
    request_cost_micros: Option<u64>,
    #[serde(default = "default_true")]
    retain_request_content: bool,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProxyCredential {
    enabled: bool,
    secret_sha256: String,
    policy_id: String,
    #[serde(default = "legacy_policy_generation")]
    policy_generation: String,
    #[serde(default)]
    principal_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct LegacyKeyPolicy {
    enabled: bool,
    secret_sha256: String,
    #[serde(default = "legacy_policy_generation")]
    generation: String,
    #[serde(default)]
    providers: Vec<String>,
    #[serde(default)]
    tenant_id: Option<String>,
    #[serde(default)]
    token_role: Option<String>,
    #[serde(default)]
    monthly_budget_micros: Option<u64>,
    #[serde(default)]
    request_cost_micros: Option<u64>,
    #[serde(default = "default_true")]
    retain_request_content: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderConnectionRecord {
    #[serde(default)]
    provider_id: String,
    #[serde(default = "default_true")]
    enabled: bool,
    #[serde(default)]
    label: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderHealthRecord {
    provider_id: String,
    status: String,
    checked_at: String,
    #[serde(default)]
    latency_ms: Option<u64>,
    #[serde(default)]
    status_code: Option<u16>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AdminKeyPolicyRequest {
    #[serde(default)]
    secret_sha256: Option<String>,
    #[serde(default)]
    providers: Option<Vec<String>>,
    #[serde(default)]
    all_providers: bool,
    #[serde(default)]
    tenant_id: Option<String>,
    #[serde(default)]
    token_role: Option<String>,
    #[serde(default)]
    monthly_budget_micros: Option<u64>,
    #[serde(default)]
    request_cost_micros: Option<u64>,
    #[serde(default = "default_true")]
    retain_request_content: bool,
    #[serde(default = "default_true")]
    enabled: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AdminAccessPolicyRequest {
    #[serde(default)]
    providers: Option<Vec<String>>,
    #[serde(default)]
    all_providers: bool,
    #[serde(default)]
    tenant_id: Option<String>,
    #[serde(default)]
    token_role: Option<String>,
    #[serde(default)]
    monthly_budget_micros: Option<u64>,
    #[serde(default)]
    request_cost_micros: Option<u64>,
    #[serde(default = "default_true")]
    retain_request_content: bool,
    #[serde(default = "default_true")]
    enabled: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AdminKeyPolicyResponse {
    kid: String,
    policy_id: String,
    enabled: bool,
    providers: Vec<String>,
    tenant_id: Option<String>,
    token_role: Option<String>,
    monthly_budget_micros: Option<u64>,
    request_cost_micros: Option<u64>,
    retain_request_content: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AdminAccessPolicyResponse {
    policy_id: String,
    enabled: bool,
    providers: Vec<String>,
    tenant_id: Option<String>,
    token_role: Option<String>,
    monthly_budget_micros: Option<u64>,
    request_cost_micros: Option<u64>,
    retain_request_content: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AdminCredentialResponse {
    credential_id: String,
    policy_id: String,
    enabled: bool,
    policy_enabled: bool,
    generation_matches: bool,
    active: bool,
    principal_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct KeyProfileResponse {
    kid: String,
    policy_id: String,
    enabled: bool,
    providers: Vec<String>,
    tenant_id: String,
    token_role: Option<String>,
    monthly_budget_micros: Option<u64>,
    request_cost_micros: Option<u64>,
    content_retention: ContentRetentionView,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ContentRetentionView {
    enabled: bool,
    retention_days: u64,
    policy_enabled: bool,
    user_exempt: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RetainedRequestContent {
    version: &'static str,
    content_ref: String,
    request_id: String,
    occurred_at_ms: u64,
    expires_at_ms: u64,
    tenant_id: String,
    policy_id: String,
    credential_id: Option<String>,
    principal_id: Option<String>,
    provider: String,
    capability: String,
    model: Option<String>,
    body: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BudgetStatusView {
    configured: bool,
    ledger: &'static str,
    window_key: Option<String>,
    limit_micros: Option<u64>,
    spent_micros: Option<u64>,
    remaining_micros: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AdminOverviewResponse {
    policies_total: usize,
    policies_active: usize,
    keys_total: usize,
    keys_active: usize,
    tenants_total: usize,
    provider_count: usize,
    openai_compatible_providers: usize,
    manifest_routes: usize,
    monthly_budget_micros: u64,
    request_cost_micros: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AdminTenantSummary {
    tenant_id: String,
    policies: usize,
    active_policies: usize,
    keys: usize,
    active_keys: usize,
    providers: Vec<String>,
    all_providers: bool,
    monthly_budget_micros: u64,
    request_cost_micros: u64,
}

#[derive(Debug, Default)]
struct TenantAccumulator {
    policies: usize,
    active_policies: usize,
    keys: usize,
    active_keys: usize,
    providers: BTreeSet<String>,
    all_providers: bool,
    monthly_budget_micros: u64,
    request_cost_micros: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AdminUsageRow {
    policy_id: String,
    kid: String,
    tenant_id: String,
    enabled: bool,
    providers: Vec<String>,
    token_role: Option<String>,
    monthly_budget_micros: Option<u64>,
    request_cost_micros: Option<u64>,
    budget: BudgetStatusView,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct UsageSummary {
    request_count: u64,
    success_count: u64,
    error_count: u64,
    input_tokens: u64,
    output_tokens: u64,
    total_tokens: u64,
    actual_cost_micros: u64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderUsageSummary {
    provider: String,
    request_count: u64,
    success_count: u64,
    error_count: u64,
    total_tokens: u64,
    actual_cost_micros: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct UsageSnapshot {
    ledger: String,
    summary: UsageSummary,
    providers: Vec<ProviderUsageSummary>,
    events: Vec<UsageEvent>,
}

#[derive(Debug, Deserialize)]
struct UsageEventJsonRow {
    event_json: String,
}

#[derive(Debug, Deserialize)]
struct UsageEventCountRow {
    event_count: i64,
}

#[derive(Debug, Default, Deserialize)]
struct UsageSummarySqlRow {
    request_count: i64,
    success_count: i64,
    error_count: i64,
    input_tokens: i64,
    output_tokens: i64,
    total_tokens: i64,
    actual_cost_micros: i64,
}

#[derive(Debug, Deserialize)]
struct ProviderUsageSummarySqlRow {
    provider: String,
    request_count: i64,
    success_count: i64,
    error_count: i64,
    total_tokens: i64,
    actual_cost_micros: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderReadinessResponse {
    providers: Vec<ProviderReadinessRow>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderReadinessRow {
    id: String,
    display_name: String,
    class: String,
    service_kind: String,
    required_config: Vec<String>,
    optional_config: Vec<String>,
    missing_config: Vec<String>,
    config_present: bool,
    connection_enabled: bool,
    oauth_grant_required: bool,
    oauth_grant_count: usize,
    upstream_grant_count: usize,
    openai_compatible: bool,
    manifest_routes: usize,
    executable_endpoints: Vec<String>,
    model_count: usize,
    executable: bool,
    verified: bool,
    last_checked_at: Option<String>,
    latency_ms: Option<u64>,
    status: String,
    reasons: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EntitlementsResponse {
    session: AccessSession,
    providers: Vec<EntitlementProviderRow>,
    content_retention: ContentRetentionView,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionProfileResponse {
    #[serde(flatten)]
    session: AccessSession,
    #[serde(skip_serializing_if = "Option::is_none")]
    entitlements: Option<SessionEntitlements>,
    #[serde(skip_serializing_if = "Option::is_none")]
    entitlements_error: Option<String>,
    content_retention: ContentRetentionView,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionEntitlements {
    providers: Vec<EntitlementProviderRow>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EntitlementProviderRow {
    provider: String,
    display_name: String,
    service_kind: String,
    allowed: bool,
    policies: Vec<String>,
    readiness: ProviderReadinessRow,
}

#[derive(Clone, Debug)]
struct OAuthGrantRecord {
    key: String,
    kind: UpstreamGrantKind,
    provider: Option<String>,
    enabled: bool,
    usable: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AdminUpstreamGrantResponse {
    key: String,
    scope: String,
    scope_id: String,
    token_ref: String,
    version: u8,
    enabled: bool,
    kind: UpstreamGrantKind,
    provider: Option<String>,
    label: Option<String>,
    token_type: String,
    expires_at: Option<String>,
    scopes: Vec<String>,
    account_id: Option<String>,
    subscription: Option<UpstreamGrantSubscription>,
    created_at: Option<String>,
    updated_at: Option<String>,
    revoked_at: Option<String>,
    has_credential: bool,
    credential_fields: Vec<String>,
    has_access_token: bool,
    has_refresh_token: bool,
    refresh_configured: bool,
    refresh_token_url: Option<String>,
    client_id_config: Option<String>,
    client_secret_config: Option<String>,
    usable: bool,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum AssignmentRuleKind {
    #[default]
    ExactEmail,
    EmailDomain,
    GithubOrg,
    GithubTeam,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AssignmentRuleRecord {
    #[serde(default = "default_assignment_rule_version")]
    version: u8,
    #[serde(default = "default_true")]
    enabled: bool,
    #[serde(default)]
    kind: AssignmentRuleKind,
    subject: String,
    #[serde(default)]
    groups: Vec<String>,
    #[serde(default)]
    policy_ids: Vec<String>,
    #[serde(default = "default_binding_priority")]
    priority: u16,
    #[serde(default = "default_true")]
    revoke_on_loss: bool,
    provenance: String,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    updated_at: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AdminAssignmentRuleResponse {
    rule_id: String,
    #[serde(flatten)]
    rule: AssignmentRuleRecord,
    generated_group: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AssignmentEvidence {
    #[serde(default)]
    source: String,
    #[serde(default)]
    verified: bool,
    #[serde(default)]
    github_orgs: Vec<String>,
    #[serde(default)]
    github_teams: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AssignmentReconcileRequest {
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    all: bool,
    #[serde(default)]
    evidence: Option<AssignmentEvidence>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AssignmentStateEntry {
    #[serde(default)]
    groups: Vec<String>,
    #[serde(default = "default_true")]
    revoke_on_loss: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AssignmentStateRecord {
    #[serde(default = "default_assignment_rule_version")]
    version: u8,
    #[serde(default)]
    assignments: BTreeMap<String, AssignmentStateEntry>,
    #[serde(default)]
    updated_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AssignmentReconcileResult {
    email: String,
    matched_rule_ids: Vec<String>,
    retained_rule_ids: Vec<String>,
    groups: Vec<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum AccessRole {
    Admin,
    User,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AccessSession {
    authenticated: bool,
    auth: &'static str,
    role: AccessRole,
    email: String,
    subject: Option<String>,
    tenant_id: String,
    groups: Vec<String>,
    #[serde(skip_serializing)]
    content_retention_disabled: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AccessUserRecord {
    #[serde(default = "default_access_user_role")]
    role: AccessRole,
    #[serde(default)]
    tenant_id: Option<String>,
    #[serde(default)]
    enabled: Option<bool>,
    #[serde(default)]
    groups: Vec<String>,
    #[serde(default)]
    content_retention_disabled: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AdminAccessUserPatchRequest {
    #[serde(default)]
    tenant_id: Option<String>,
    #[serde(default)]
    enabled: Option<bool>,
    #[serde(default)]
    groups: Option<Vec<String>>,
    #[serde(default)]
    content_retention_disabled: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AdminAccessUserGrantsRequest {
    #[serde(flatten)]
    record: AccessUserRecord,
    #[serde(default)]
    policy_ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AdminAccessUserResponse {
    email: String,
    role: AccessRole,
    tenant_id: String,
    enabled: bool,
    groups: Vec<String>,
    content_retention_disabled: bool,
}

struct AccessUserIdentity {
    role: AccessRole,
    tenant_id: String,
    groups: Vec<String>,
    content_retention_disabled: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum PrincipalType {
    User,
    Group,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PolicyBindingRecord {
    policy_id: String,
    principal_type: PrincipalType,
    principal_id: String,
    #[serde(default = "default_true")]
    enabled: bool,
    #[serde(default = "default_binding_priority")]
    priority: u16,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PolicyBindingPrincipal {
    principal_type: PrincipalType,
    principal_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PolicyBindingIndexSeed {
    principal: PolicyBindingPrincipal,
    bindings: Vec<PolicyBindingRecord>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PolicyBindingIndexResolveRequest {
    principals: Vec<PolicyBindingPrincipal>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PolicyBindingIndexResolveResponse {
    bindings: Vec<PolicyBindingRecord>,
    missing_principals: Vec<PolicyBindingPrincipal>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PolicyBindingIndexListResponse {
    initialized: bool,
    bindings: Vec<PolicyBindingRecord>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PolicyBindingIndexMutationRequest {
    seed: PolicyBindingIndexSeed,
    binding: PolicyBindingRecord,
}

#[derive(Debug, Deserialize)]
struct PolicyBindingIndexCountRow {
    principal_count: i64,
}

#[derive(Debug, Deserialize)]
struct PolicyBindingIndexEntryRow {
    binding_json: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AccessControlUser {
    email: String,
    record: AccessUserRecord,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AccessControlUserBindingsPutRequest {
    user: AccessControlUser,
    policy_ids: Vec<String>,
    seed: PolicyBindingIndexSeed,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AccessControlUserBindingsPutResponse {
    bindings: Vec<PolicyBindingRecord>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AccessControlUsersResolveRequest {
    emails: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AccessControlUsersResolveResponse {
    users: Vec<AccessControlUser>,
    missing_emails: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AccessControlUsersListResponse {
    initialized: bool,
    users: Vec<AccessControlUser>,
}

#[derive(Debug, Deserialize)]
struct AccessControlUserRow {
    user_json: String,
}

#[derive(Debug, Deserialize)]
struct AccessControlUserListRow {
    email: String,
    user_json: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AccessControlConnectionsResolveRequest {
    provider_ids: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AccessControlConnectionsResolveResponse {
    connections: Vec<ProviderConnectionRecord>,
    missing_provider_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct AccessControlConnectionRow {
    connection_json: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AccessControlPoliciesResolveRequest {
    policy_ids: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AccessControlPoliciesResolveResponse {
    policies: Vec<AccessPolicyEntry>,
    missing_policy_ids: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AccessControlPoliciesListResponse {
    policies: Vec<AccessPolicyEntry>,
}

#[derive(Debug, Deserialize)]
struct AccessControlPolicyRow {
    policy_json: String,
}

#[derive(Debug, Deserialize)]
struct AccessControlPolicyListRow {
    policy_id: String,
    policy_json: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProxyCredentialEntry {
    credential_id: String,
    credential: ProxyCredential,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AccessControlPolicyCredentialPutRequest {
    policy: AccessPolicyEntry,
    credential: ProxyCredentialEntry,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AccessControlCredentialsResolveRequest {
    credential_ids: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AccessControlCredentialsResolveResponse {
    credentials: Vec<ProxyCredentialEntry>,
    missing_credential_ids: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AccessControlCredentialsListResponse {
    credentials: Vec<ProxyCredentialEntry>,
}

#[derive(Debug, Deserialize)]
struct AccessControlCredentialRow {
    credential_json: String,
}

#[derive(Debug, Deserialize)]
struct AccessControlCredentialListRow {
    credential_id: String,
    credential_json: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct OAuthAuthorizationState {
    state: String,
    verifier: String,
    actor_email: String,
    grant_key: String,
    provider: String,
    redirect_uri: String,
    expires_at_ms: u64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct OAuthAuthorizationStateConsumeRequest {
    state: String,
    actor_email: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct OAuthAuthorizationStateConsumeResponse {
    state: Option<OAuthAuthorizationState>,
}

#[derive(Debug, Deserialize)]
struct OAuthAuthorizationStateRow {
    state_json: String,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum AccessAud {
    One(String),
    Many(Vec<String>),
}

#[derive(Debug, Deserialize)]
struct AccessJwtPayload {
    aud: Option<AccessAud>,
    email: Option<String>,
    exp: Option<u64>,
    iat: Option<u64>,
    iss: Option<String>,
    nbf: Option<u64>,
    sub: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AccessJwtHeader {
    alg: Option<String>,
    kid: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AccessCerts {
    keys: Vec<AccessPublicJwk>,
}

#[derive(Debug, Deserialize)]
struct AccessPublicJwk {
    kid: Option<String>,
    kty: Option<String>,
    n: Option<String>,
    e: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum UpstreamGrantKind {
    ApiKey,
    #[default]
    OAuth,
    Subscription,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpstreamGrantSubscription {
    #[serde(default)]
    plan: Option<String>,
    #[serde(default)]
    subject: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpstreamGrantRefresh {
    token_url: String,
    #[serde(default)]
    client_id: Option<String>,
    #[serde(default)]
    client_id_config: Option<String>,
    #[serde(default)]
    client_secret_config: Option<String>,
    #[serde(default)]
    extra_params: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpstreamGrantRecord {
    #[serde(default = "default_upstream_grant_version")]
    version: u8,
    #[serde(default = "default_true")]
    enabled: bool,
    #[serde(default)]
    kind: UpstreamGrantKind,
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    credential: Option<String>,
    #[serde(default)]
    credentials: BTreeMap<String, String>,
    #[serde(default, alias = "access_token")]
    access_token: Option<String>,
    #[serde(default, alias = "refresh_token")]
    refresh_token: Option<String>,
    #[serde(default = "default_oauth_token_type", alias = "token_type")]
    token_type: String,
    #[serde(default, alias = "expires_at")]
    expires_at: Option<String>,
    #[serde(default)]
    scopes: Vec<String>,
    #[serde(default, alias = "account_id")]
    account_id: Option<String>,
    #[serde(default)]
    subscription: Option<UpstreamGrantSubscription>,
    #[serde(default)]
    refresh: Option<UpstreamGrantRefresh>,
    #[serde(default, alias = "created_at")]
    created_at: Option<String>,
    #[serde(default, alias = "updated_at")]
    updated_at: Option<String>,
    #[serde(default, alias = "revoked_at")]
    revoked_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OAuthRefreshResponse {
    access_token: String,
    #[serde(default)]
    id_token: Option<String>,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    token_type: Option<String>,
    #[serde(default)]
    expires_in: Option<u64>,
    #[serde(default)]
    scope: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OAuthAuthorizationStartRequest {
    provider: String,
}

#[derive(Clone)]
struct AuthorizedKey {
    credential_id: Option<String>,
    principal_id: Option<String>,
    auth_type: &'static str,
    policy_id: String,
    policy: AccessPolicy,
    content_retention_disabled: bool,
}

enum AuthOutcome {
    Allowed(AuthorizedKey),
    Denied(Response),
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AccessPolicyEntry {
    policy_id: String,
    policy: AccessPolicy,
}

async fn session_profile(headers: &Headers, env: &Env) -> Result<Response> {
    if let Some(session) = verified_access_session(headers, env).await? {
        let content_retention = session_content_retention(env, &session).await?;
        let (entitlements, entitlements_error) =
            match access_entitlement_rows_for_session(&session, env).await {
                Ok(providers) => (Some(SessionEntitlements { providers }), None),
                Err(error) => (None, Some(provider_runtime_error_summary(&error))),
            };
        return Response::from_json(&SessionProfileResponse {
            session,
            entitlements,
            entitlements_error,
            content_retention,
        });
    }
    Response::from_json(&serde_json::json!({
        "authenticated": false,
        "auth": "none",
        "role": "user",
        "email": null,
        "subject": null,
        "tenantId": null
    }))
}

async fn session_avatar(headers: &Headers, env: &Env) -> Result<Response> {
    let Some(session) = verified_access_session(headers, env).await? else {
        return json_error(
            "access_session_required",
            "avatar access requires a verified Cloudflare Access session",
            401,
        );
    };
    let request = Request::new(&gravatar_avatar_url(&session.email), Method::Get)?;
    let mut upstream = match Fetch::Request(request).send().await {
        Ok(response) => response,
        Err(_) => return private_avatar_error(502),
    };
    if upstream.status_code() != 200 {
        return private_avatar_error(404);
    }
    let content_type = upstream
        .headers()
        .get("content-type")?
        .and_then(|value| value.split(';').next().map(str::trim).map(str::to_string));
    let Some(content_type) = content_type.filter(|value| {
        matches!(
            value.as_str(),
            "image/gif" | "image/jpeg" | "image/png" | "image/webp"
        )
    }) else {
        return private_avatar_error(502);
    };
    let bytes = upstream.bytes().await?;
    if bytes.len() > 1024 * 1024 {
        return private_avatar_error(502);
    }
    let mut response = Response::from_bytes(bytes)?;
    response.headers_mut().set("content-type", &content_type)?;
    response
        .headers_mut()
        .set("cache-control", "private, no-store, max-age=0")?;
    response.headers_mut().set(
        "vary",
        "cf-access-jwt-assertion, cf-access-authenticated-user-email",
    )?;
    Ok(response)
}

fn gravatar_avatar_url(email: &str) -> String {
    let hash = sha256_hex(&email.trim().to_ascii_lowercase());
    format!("https://www.gravatar.com/avatar/{hash}?s=60&d=identicon&r=g")
}

fn private_avatar_error(status: u16) -> Result<Response> {
    let mut response = Response::empty()?.with_status(status);
    response
        .headers_mut()
        .set("cache-control", "private, no-store, max-age=0")?;
    Ok(response)
}

async fn access_entitlements(headers: &Headers, env: &Env) -> Result<Response> {
    let Some(session) = verified_access_session(headers, env).await? else {
        return json_error(
            "access_session_required",
            "entitlements require a verified Cloudflare Access session",
            401,
        );
    };
    let providers = match access_entitlement_rows_for_session(&session, env).await {
        Ok(providers) => providers,
        Err(Error::RustError(message)) if message == POLICY_KV_ENTITLEMENTS_REQUIRED => {
            return json_error("policy_store_unavailable", &message, 503);
        }
        Err(error) => return Err(error),
    };
    let content_retention = session_content_retention(env, &session).await?;
    Response::from_json(&EntitlementsResponse {
        session,
        providers,
        content_retention,
    })
}

async fn session_content_retention(
    env: &Env,
    session: &AccessSession,
) -> Result<ContentRetentionView> {
    let kv = env.kv("POLICY_KV").map_err(|error| {
        Error::RustError(format!(
            "POLICY_KV binding is required for retention disclosure: {error}"
        ))
    })?;
    let policy_enabled = list_session_policy_entries(&kv, env, session)
        .await?
        .iter()
        .any(|entry| entry.policy.enabled && entry.policy.retain_request_content);
    Ok(ContentRetentionView {
        enabled: policy_enabled && !session.content_retention_disabled,
        retention_days: CONTENT_RETENTION_DAYS,
        policy_enabled,
        user_exempt: session.content_retention_disabled,
    })
}

async fn access_entitlement_rows_for_session(
    session: &AccessSession,
    env: &Env,
) -> Result<Vec<EntitlementProviderRow>> {
    let kv = match env.kv("POLICY_KV") {
        Ok(kv) => kv,
        Err(_) => {
            return Err(Error::RustError(
                POLICY_KV_ENTITLEMENTS_REQUIRED.to_string(),
            ));
        }
    };

    let entries = list_session_policy_entries(&kv, env, session).await?;
    entitlement_rows_for_entries(&entries, env, &kv).await
}

async fn entitlement_rows_for_policy(
    policy_id: &str,
    policy: &AccessPolicy,
    env: &Env,
) -> Result<Vec<EntitlementProviderRow>> {
    let kv = env.kv("POLICY_KV").map_err(|_| {
        Error::RustError("POLICY_KV binding is required for client discovery".to_string())
    })?;
    entitlement_rows_for_entries(
        &[AccessPolicyEntry {
            policy_id: policy_id.to_string(),
            policy: policy.clone(),
        }],
        env,
        &kv,
    )
    .await
}

async fn entitlement_rows_for_entries(
    entries: &[AccessPolicyEntry],
    env: &Env,
    kv: &KvStore,
) -> Result<Vec<EntitlementProviderRow>> {
    let snapshot = provider_snapshot()?;
    let grants = list_oauth_grants(kv).await?;
    let connections = list_provider_connections(env, kv, &snapshot).await?;
    let health = list_provider_health(kv).await?;
    Ok(snapshot
        .providers
        .iter()
        .map(|provider| {
            let matching_entries = entries
                .iter()
                .filter(|entry| policy_allows_provider(&entry.policy, &provider.id))
                .collect::<Vec<_>>();
            let matching_policies = matching_entries
                .iter()
                .map(|entry| entry.policy_id.clone())
                .collect::<Vec<_>>();
            let scoped_grants = entitlement_oauth_grants(&grants, &matching_entries);
            let readiness = provider_readiness_row(
                provider,
                env,
                &scoped_grants,
                provider_connection_enabled(&connections, &provider.id),
                health.get(&provider.id),
            );
            EntitlementProviderRow {
                provider: provider.id.clone(),
                display_name: provider.display_name.clone(),
                service_kind: enum_label(&provider.service_kind),
                allowed: !matching_policies.is_empty(),
                policies: matching_policies,
                readiness,
            }
        })
        .collect())
}

async fn client_entitlement_rows(
    headers: &Headers,
    env: &Env,
) -> std::result::Result<Vec<EntitlementProviderRow>, Response> {
    if proxy_key_header_present(headers).map_err(internal_error_response)? {
        let auth = match authorize_proxy_key_identity(headers, env)
            .await
            .map_err(internal_error_response)?
        {
            AuthOutcome::Allowed(auth) => auth,
            AuthOutcome::Denied(response) => return Err(response),
        };
        return entitlement_rows_for_policy(&auth.policy_id, &auth.policy, env)
            .await
            .map_err(internal_error_response);
    }
    let session = verified_access_session(headers, env)
        .await
        .map_err(internal_error_response)?
        .ok_or_else(|| {
            json_error(
                "client_auth_required",
                "a valid ClawRouter proxy key or Cloudflare Access session is required",
                401,
            )
            .unwrap_or_else(|_| Response::error("client authentication required", 401).unwrap())
        })?;
    access_entitlement_rows_for_session(&session, env)
        .await
        .map_err(internal_error_response)
}

async fn client_models(headers: &Headers, env: &Env) -> Result<Response> {
    let rows = match client_entitlement_rows(headers, env).await {
        Ok(rows) => rows,
        Err(response) => return Ok(response),
    };
    let snapshot = provider_snapshot()?;
    let value = if headers.get("anthropic-version")?.is_some() {
        anthropic_models_value(&snapshot, &rows)
    } else {
        client_models_value(&snapshot, &rows)
    };
    private_json_response(&value)
}

fn client_models_value(snapshot: &ProviderSnapshot, rows: &[EntitlementProviderRow]) -> Value {
    let allowed = rows
        .iter()
        .filter(|row| row.allowed && row.readiness.executable)
        .map(|row| (row.provider.as_str(), &row.readiness.executable_endpoints))
        .collect::<BTreeMap<_, _>>();
    let data = snapshot
        .providers
        .iter()
        .filter_map(|provider| {
            allowed
                .get(provider.id.as_str())
                .map(|endpoints| (provider, *endpoints))
        })
        .flat_map(|provider| {
            let (provider, endpoints) = provider;
            provider.models.iter().filter_map(|model| {
                let capabilities = executable_model_capabilities(provider, model, endpoints);
                (!capabilities.is_empty()).then(|| {
                    serde_json::json!({
                        "id": model.id,
                        "object": "model",
                        "owned_by": provider.id,
                        "display_name": format!("{} · {}", provider.display_name, model.id),
                        "capabilities": capabilities
                    })
                })
            })
        })
        .collect::<Vec<_>>();
    serde_json::json!({
        "object": "list",
        "data": data
    })
}

fn anthropic_models_value(snapshot: &ProviderSnapshot, rows: &[EntitlementProviderRow]) -> Value {
    let allowed = rows
        .iter()
        .filter(|row| row.allowed && row.readiness.executable)
        .map(|row| (row.provider.as_str(), &row.readiness.executable_endpoints))
        .collect::<BTreeMap<_, _>>();
    let data = snapshot
        .providers
        .iter()
        .filter_map(|provider| {
            allowed
                .get(provider.id.as_str())
                .map(|endpoints| (provider, *endpoints))
        })
        .flat_map(|(provider, endpoints)| {
            provider.models.iter().filter_map(|model| {
                let capabilities = executable_model_capabilities(provider, model, endpoints);
                capabilities
                    .iter()
                    .any(|capability| capability == "llm.messages")
                    .then(|| {
                        let (max_input_tokens, max_tokens) = model
                            .pricing
                            .as_ref()
                            .map(|pricing| {
                                (pricing.max_input_tokens, pricing.default_max_output_tokens)
                            })
                            .unwrap_or_default();
                        serde_json::json!({
                            "id": model.id,
                            "type": "model",
                            "display_name": format!("{} · {}", provider.display_name, model.id),
                            "created_at": "1970-01-01T00:00:00Z",
                            // Anthropic's ModelInfo schema explicitly permits null when
                            // model capability metadata is unavailable.
                            "capabilities": Value::Null,
                            "max_input_tokens": max_input_tokens,
                            "max_tokens": max_tokens
                        })
                    })
            })
        })
        .collect::<Vec<_>>();
    let first_id = data
        .first()
        .and_then(|model| model.get("id"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let last_id = data
        .last()
        .and_then(|model| model.get("id"))
        .and_then(Value::as_str)
        .map(str::to_string);
    serde_json::json!({
        "data": data,
        "first_id": first_id,
        "has_more": false,
        "last_id": last_id
    })
}

async fn client_catalog(headers: &Headers, env: &Env) -> Result<Response> {
    let rows = match client_entitlement_rows(headers, env).await {
        Ok(rows) => rows,
        Err(response) => return Ok(response),
    };
    let snapshot = provider_snapshot()?;
    private_json_response(&client_catalog_value(&snapshot, rows))
}

fn client_catalog_value(snapshot: &ProviderSnapshot, rows: Vec<EntitlementProviderRow>) -> Value {
    let providers = rows
        .into_iter()
        .filter(|row| row.allowed)
        .filter_map(|row| {
            let provider = snapshot
                .providers
                .iter()
                .find(|provider| provider.id == row.provider)?;
            let executable_endpoints = &row.readiness.executable_endpoints;
            let openai_compatible =
                row.readiness.executable && supports_openai_compatible_proxy(provider);
            Some(serde_json::json!({
                "id": provider.id,
                "displayName": provider.display_name,
                "allowed": true,
                "executable": row.readiness.executable,
                "openaiCompatible": openai_compatible,
                "nativeBaseUrl": format!("/v1/native/{}", provider.id),
                "policies": row.policies,
                "readiness": row.readiness,
                "connectionTypes": provider_connection_types(provider),
                "routes": provider.endpoints.iter().filter(|endpoint| {
                    endpoint.native_proxy && executable_endpoints.contains(&endpoint.id)
                }).map(|endpoint| {
                    serde_json::json!({
                        "endpoint": endpoint.id,
                        "methods": endpoint.methods,
                        "path": endpoint.path,
                        "requestFormat": endpoint.request_format,
                        "responseFormat": endpoint.response_format,
                        "streaming": endpoint.streaming
                    })
                }).collect::<Vec<_>>(),
                "models": provider.models.iter().filter_map(|model| {
                    let capabilities =
                        executable_model_capabilities(provider, model, executable_endpoints);
                    (!capabilities.is_empty()).then(|| {
                        serde_json::json!({
                            "id": model.id,
                            "upstream": model.upstream,
                            "capabilities": capabilities,
                            "pricing_ref": model.pricing_ref,
                            "pricing": model.pricing
                        })
                    })
                }).collect::<Vec<_>>()
            }))
        })
        .collect::<Vec<_>>();
    serde_json::json!({
        "version": "clawrouter.client-catalog.v1",
        "providers": providers
    })
}

fn executable_model_capabilities(
    provider: &CompiledProvider,
    model: &CompiledModel,
    executable_endpoints: &[String],
) -> Vec<String> {
    model
        .capabilities
        .iter()
        .filter(|capability| {
            provider
                .capabilities
                .iter()
                .find(|candidate| candidate.id == **capability)
                .is_some_and(|candidate| executable_endpoints.contains(&candidate.endpoint))
        })
        .cloned()
        .collect()
}

fn provider_connection_types(provider: &CompiledProvider) -> Vec<&'static str> {
    let mut types = BTreeSet::new();
    for scheme in &provider.auth.schemes {
        match scheme {
            AuthScheme::OAuth { .. } => {
                types.insert("oauth");
                types.insert("subscription");
            }
            AuthScheme::Bearer { .. }
            | AuthScheme::ApiKey { .. }
            | AuthScheme::QueryApiKey { .. } => {
                types.insert("api_key");
                types.insert("oauth");
                types.insert("subscription");
            }
            AuthScheme::SigV4 { .. } => {
                types.insert("api_key");
            }
            AuthScheme::CloudflareBinding => {
                types.insert("cloudflare_binding");
            }
        }
    }
    types.into_iter().collect()
}

fn private_json_response(value: &Value) -> Result<Response> {
    let raw = serde_json::to_vec(value)?;
    let mut response = Response::from_bytes(raw)?;
    response
        .headers_mut()
        .set("content-type", "application/json")?;
    response
        .headers_mut()
        .set("cache-control", "private, no-store, max-age=0")?;
    response.headers_mut().set(
        "vary",
        "authorization, x-api-key, x-goog-api-key, api-key, cf-access-jwt-assertion, anthropic-version",
    )?;
    Ok(response)
}

fn internal_error_response(error: Error) -> Response {
    console_error!("client discovery failed: {}", error);
    json_error(
        "client_discovery_unavailable",
        "client discovery is temporarily unavailable",
        503,
    )
    .unwrap_or_else(|_| Response::error("client discovery unavailable", 503).unwrap())
}

fn provider_runtime_error_summary(error: &Error) -> String {
    match error {
        Error::RustError(message) => message.clone(),
        _ => "entitlements unavailable".to_string(),
    }
}

async fn admin_api(mut req: Request, env: Env, path: &str) -> Result<Response> {
    let url = req.url()?;
    if let Some(response) = authorize_admin(&req.method(), req.headers(), &url, &env).await? {
        return Ok(response);
    }
    let kv = match env.kv("POLICY_KV") {
        Ok(kv) => kv,
        Err(_) => {
            return json_error(
                "policy_store_unavailable",
                "POLICY_KV binding is required for admin requests",
                503,
            );
        }
    };

    if req.method() == Method::Get && path == "/v1/admin/content" {
        let params = url.query_pairs().collect::<BTreeMap<_, _>>();
        let tenant_id = params
            .get("tenant")
            .map(|value| value.trim())
            .filter(|value| !value.is_empty() && value.len() <= 256);
        let content_ref = params
            .get("ref")
            .map(|value| value.trim())
            .filter(|value| !value.is_empty() && value.len() <= 256);
        let (Some(tenant_id), Some(content_ref)) = (tenant_id, content_ref) else {
            return json_error(
                "invalid_content_lookup",
                "tenant and ref query parameters are required",
                400,
            );
        };
        let bucket = env.bucket("CONTENT_ARCHIVE").map_err(|error| {
            Error::RustError(format!("CONTENT_ARCHIVE binding is unavailable: {error}"))
        })?;
        let Some(object) = bucket
            .get(content_archive_key(tenant_id, content_ref))
            .execute()
            .await?
        else {
            return json_error(
                "content_not_found",
                "retained request content was not found",
                404,
            );
        };
        let body = object
            .body()
            .ok_or_else(|| Error::RustError("retained request body is unavailable".to_string()))?
            .text()
            .await?;
        let record = serde_json::from_str::<Value>(&body).map_err(|error| {
            Error::RustError(format!("retained request content is invalid JSON: {error}"))
        })?;
        return private_json_response(&record);
    }

    if req.method() == Method::Get && path == "/v1/admin/overview" {
        let reporting = admin_reporting_snapshot(&env, &kv).await?;
        let snapshot = provider_snapshot()?;
        return Response::from_json(&admin_overview(
            &reporting.policies,
            &reporting.keys,
            &snapshot,
        ));
    }

    if req.method() == Method::Get && (path == "/v1/admin/tenants" || path == "/v1/admin/users") {
        let reporting = admin_reporting_snapshot(&env, &kv).await?;
        return Response::from_json(&serde_json::json!({
            "tenants": admin_tenant_summaries(&reporting.policies, &reporting.keys)
        }));
    }

    if req.method() == Method::Get && path == "/v1/admin/usage" {
        let entries = list_admin_policy_reports(&env, &kv).await?;
        let usage = usage_snapshot(&env, None, USAGE_EVENT_LIMIT).await?;
        let mut rows = Vec::new();
        for entry in entries {
            rows.push(admin_usage_row(&env, entry).await?);
        }
        return Response::from_json(&serde_json::json!({
            "policies": &rows,
            "keys": &rows,
            "usage": usage
        }));
    }

    if req.method() == Method::Get && path == "/v1/admin/access-users" {
        let users = list_admin_access_users(&env, &kv).await?;
        return Response::from_json(&serde_json::json!({ "users": users }));
    }

    if path == "/v1/admin/policy-bindings" {
        if req.method() == Method::Get {
            let bindings = list_policy_bindings(&env, &kv).await?;
            return Response::from_json(&serde_json::json!({ "bindings": bindings }));
        }
        if req.method() == Method::Put {
            let request = match serde_json::from_str::<PolicyBindingRecord>(&req.text().await?) {
                Ok(request) => request,
                Err(error) => {
                    return json_error(
                        "invalid_policy_binding_request",
                        &format!("request body must be a JSON policy binding: {error}"),
                        400,
                    );
                }
            };
            let binding = match normalize_policy_binding(request) {
                Ok(binding) => binding,
                Err(message) => return json_error("invalid_policy_binding", message, 400),
            };
            if authoritative_access_policy(&env, &kv, &binding.policy_id)
                .await?
                .is_none()
            {
                return json_error("unknown_policy", "bound policy does not exist", 404);
            }
            put_policy_binding_record(&env, &kv, &binding).await?;
            return Response::from_json(&binding);
        }
        return json_error("method_not_allowed", "admin method is not allowed", 405);
    }

    if req.method() == Method::Get && path == "/v1/admin/assignment-rules" {
        let rules = list_assignment_rules(&kv)
            .await?
            .into_iter()
            .map(|(rule_id, rule)| admin_assignment_rule_response(&rule_id, rule))
            .collect::<Vec<_>>();
        return Response::from_json(&serde_json::json!({ "rules": rules }));
    }

    if req.method() == Method::Post && path == "/v1/admin/assignment-rules/reconcile" {
        let request = match serde_json::from_str::<AssignmentReconcileRequest>(&req.text().await?) {
            Ok(request) => request,
            Err(error) => {
                return json_error(
                    "invalid_assignment_reconcile_request",
                    &format!("request body must be assignment reconciliation JSON: {error}"),
                    400,
                );
            }
        };
        let results = match reconcile_assignment_request(&env, &kv, request).await {
            Ok(results) => results,
            Err(AssignmentReconcileError::Client(message)) => {
                return json_error("invalid_assignment_reconcile_request", &message, 400);
            }
            Err(AssignmentReconcileError::Runtime(error)) => return Err(error),
        };
        return Response::from_json(&serde_json::json!({ "results": results }));
    }

    if let Some(rule_id) = path.strip_prefix("/v1/admin/assignment-rules/") {
        if req.method() != Method::Put {
            return json_error("method_not_allowed", "admin method is not allowed", 405);
        }
        let rule_id = match validate_assignment_rule_id(rule_id) {
            Ok(rule_id) => rule_id,
            Err(message) => return json_error("invalid_assignment_rule", message, 400),
        };
        let request = match serde_json::from_str::<AssignmentRuleRecord>(&req.text().await?) {
            Ok(request) => request,
            Err(error) => {
                return json_error(
                    "invalid_assignment_rule_request",
                    &format!("request body must be assignment-rule JSON: {error}"),
                    400,
                );
            }
        };
        let existing = get_assignment_rule(&kv, &rule_id).await?;
        let rule = match normalize_assignment_rule(&rule_id, request, existing.as_ref()) {
            Ok(rule) => rule,
            Err(message) => return json_error("invalid_assignment_rule", &message, 400),
        };
        let policies = authoritative_access_policies(&env, &kv, &rule.policy_ids).await?;
        let missing_policy_ids = rule
            .policy_ids
            .iter()
            .filter(|policy_id| !policies.contains_key(*policy_id))
            .cloned()
            .collect::<Vec<_>>();
        if !missing_policy_ids.is_empty() {
            return json_error(
                "unknown_policy",
                &format!(
                    "assignment-rule policies do not exist: {}",
                    missing_policy_ids.join(",")
                ),
                404,
            );
        }
        put_kv_record(
            &kv,
            &assignment_rule_key(&rule_id),
            &rule,
            "assignment rule",
        )
        .await?;
        sync_assignment_rule_bindings(&env, &kv, &rule_id, existing.as_ref(), &rule).await?;
        return Response::from_json(&admin_assignment_rule_response(&rule_id, rule));
    }

    if req.method() == Method::Get && path == "/v1/admin/provider-status" {
        let snapshot = provider_snapshot()?;
        let grants = list_oauth_grants(&kv).await?;
        let connections = list_provider_connections(&env, &kv, &snapshot).await?;
        let health = list_provider_health(&kv).await?;
        return Response::from_json(&ProviderReadinessResponse {
            providers: provider_readiness_rows(&snapshot, &env, &grants, &connections, &health),
        });
    }

    if req.method() == Method::Get && path == "/v1/admin/provider-health" {
        let health = list_provider_health(&kv).await?;
        return Response::from_json(&serde_json::json!({
            "providers": health.into_values().collect::<Vec<_>>()
        }));
    }

    if req.method() == Method::Get && path == "/v1/admin/upstream-grants" {
        let grants = list_admin_upstream_grants(&kv).await?;
        return Response::from_json(&serde_json::json!({ "grants": grants }));
    }

    if let Some(rest) = path.strip_prefix("/v1/admin/upstream-grants/") {
        let route = match parse_admin_upstream_grant_route(rest) {
            Ok(route) => route,
            Err(message) => return json_error("invalid_upstream_grant_route", message, 400),
        };
        if req.method() == Method::Put && route.action.is_none() {
            let request = match serde_json::from_str::<UpstreamGrantRecord>(&req.text().await?) {
                Ok(request) => request,
                Err(_) => {
                    return json_error(
                        "invalid_upstream_grant_request",
                        "request body must be a JSON upstream grant record",
                        400,
                    );
                }
            };
            let existing = get_upstream_grant(&kv, &route.key).await?;
            let grant = match normalize_upstream_grant(request, existing.as_ref()) {
                Ok(grant) => grant,
                Err(message) => return json_error("invalid_upstream_grant", &message, 400),
            };
            put_kv_record(&kv, &route.key, &grant, "upstream grant").await?;
            return Response::from_json(&admin_upstream_grant_response(&route.key, &grant)?);
        }
        if req.method() == Method::Post && route.action.as_deref() == Some("revoke") {
            let Some(mut grant) = get_upstream_grant(&kv, &route.key).await? else {
                return json_error(
                    "unknown_upstream_grant",
                    "upstream grant is not registered",
                    404,
                );
            };
            revoke_upstream_grant(&mut grant);
            put_kv_record(&kv, &route.key, &grant, "upstream grant tombstone").await?;
            return Response::from_json(&admin_upstream_grant_response(&route.key, &grant)?);
        }
        if req.method() == Method::Post && route.action.as_deref() == Some("refresh") {
            let Some(grant) = get_upstream_grant(&kv, &route.key).await? else {
                return json_error(
                    "unknown_upstream_grant",
                    "upstream grant is not registered",
                    404,
                );
            };
            let grant = match refresh_upstream_grant(&env, &kv, &route.key, grant, true).await {
                Ok(grant) => grant,
                Err(HeaderBuildError::Client {
                    code,
                    message,
                    status,
                }) => return json_error(code, message, status),
                Err(HeaderBuildError::Runtime(error)) => return Err(error),
            };
            return Response::from_json(&admin_upstream_grant_response(&route.key, &grant)?);
        }
        if req.method() == Method::Post && route.action.as_deref() == Some("authorize") {
            let Some(session) = verified_access_session(req.headers(), &env).await? else {
                return json_error(
                    "access_admin_required",
                    "browser OAuth authorization requires a verified Cloudflare Access admin session",
                    403,
                );
            };
            if session.role != AccessRole::Admin {
                return json_error(
                    "access_admin_required",
                    "browser OAuth authorization requires a verified Cloudflare Access admin session",
                    403,
                );
            }
            let request =
                match serde_json::from_str::<OAuthAuthorizationStartRequest>(&req.text().await?) {
                    Ok(request) => request,
                    Err(_) => {
                        return json_error(
                            "invalid_oauth_authorization_request",
                            "request body must identify a provider",
                            400,
                        );
                    }
                };
            return start_oauth_authorization(
                &env,
                &url,
                &route.key,
                &session.email,
                request.provider.trim(),
            )
            .await;
        }
        return json_error("method_not_allowed", "admin method is not allowed", 405);
    }

    if req.method() == Method::Get && path == "/v1/admin/policies" {
        let policies = list_access_policy_records(&env, &kv)
            .await?
            .into_iter()
            .map(|entry| admin_access_policy_response(&entry.policy_id, &entry.policy))
            .collect::<Vec<_>>();
        return Response::from_json(&serde_json::json!({ "policies": policies }));
    }

    if let Some(rest) = path.strip_prefix("/v1/admin/policies/") {
        if req.method() == Method::Put {
            let policy_id = match validate_admin_kid(rest) {
                Ok(policy_id) => policy_id,
                Err(message) => return json_error("invalid_policy", message, 400),
            };
            let existing_policy = authoritative_access_policy(&env, &kv, &policy_id).await?;
            let mut policy =
                match serde_json::from_str::<AdminAccessPolicyRequest>(&req.text().await?)
                    .map_err(|error| error.to_string())
                    .and_then(|request| request.try_into_policy().map_err(str::to_string))
                {
                    Ok(policy) => policy,
                    Err(error) => {
                        return json_error(
                            "invalid_policy_request",
                            &format!("request body must be a JSON access policy: {error}"),
                            400,
                        );
                    }
                };
            preserve_existing_policy_generation(&mut policy, existing_policy.as_ref());
            if let Err(message) = validate_policy_providers(&policy) {
                return json_error("invalid_policy", &message, 400);
            }
            if let Err(message) = validate_policy_budget(&policy) {
                return json_error("invalid_policy", message, 400);
            }
            put_authoritative_access_policy(&env, &kv, &policy_id, &policy).await?;
            return Response::from_json(&admin_access_policy_response(&policy_id, &policy));
        }
        if req.method() == Method::Post {
            let Some(policy_id) = rest.strip_suffix("/revoke") else {
                return json_error("route_not_found", "route not found", 404);
            };
            let policy_id = match validate_admin_kid(policy_id.trim_end_matches('/')) {
                Ok(policy_id) => policy_id,
                Err(message) => return json_error("invalid_policy", message, 400),
            };
            let Some(mut policy) = authoritative_access_policy(&env, &kv, &policy_id).await? else {
                return json_error("unknown_policy", "access policy is not registered", 404);
            };
            policy.enabled = false;
            put_authoritative_access_policy(&env, &kv, &policy_id, &policy).await?;
            return Response::from_json(&admin_access_policy_response(&policy_id, &policy));
        }
        return json_error("method_not_allowed", "admin method is not allowed", 405);
    }

    if req.method() == Method::Get && path == "/v1/admin/credentials" {
        let credentials = list_proxy_credentials(&env, &kv).await?;
        let policy_ids = credentials
            .iter()
            .map(|(_, credential)| credential.policy_id.clone())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        let policies = authoritative_access_policies(&env, &kv, &policy_ids).await?;
        let credentials = admin_credential_responses(credentials, &policies);
        return Response::from_json(&serde_json::json!({ "credentials": credentials }));
    }

    if let Some(rest) = path.strip_prefix("/v1/admin/credentials/") {
        if req.method() == Method::Put {
            let credential_id = match validate_admin_kid(rest) {
                Ok(credential_id) => credential_id,
                Err(message) => return json_error("invalid_credential", message, 400),
            };
            let mut credential = match serde_json::from_str::<ProxyCredential>(&req.text().await?) {
                Ok(credential) => credential,
                Err(error) => {
                    return json_error(
                        "invalid_credential_request",
                        &format!("request body must be a JSON proxy credential: {error}"),
                        400,
                    );
                }
            };
            if !is_sha256_hex(&credential.secret_sha256) {
                return json_error(
                    "invalid_credential",
                    "secretSha256 must be a 64-character hex string",
                    400,
                );
            }
            credential.secret_sha256 = credential.secret_sha256.to_ascii_lowercase();
            credential.principal_id = match credential.principal_id.take() {
                Some(principal_id) => match normalize_access_email(&principal_id) {
                    Ok(principal_id) => Some(principal_id),
                    Err(message) => return json_error("invalid_credential", message, 400),
                },
                None => None,
            };
            if validate_admin_kid(&credential.policy_id).is_err() {
                return json_error("unknown_policy", "credential policy is not registered", 404);
            };
            let Some(policy) =
                authoritative_access_policy(&env, &kv, &credential.policy_id).await?
            else {
                return json_error("unknown_policy", "credential policy is not registered", 404);
            };
            credential.policy_generation.clone_from(&policy.generation);
            put_authoritative_proxy_credential(&env, &kv, &credential_id, &credential).await?;
            sync_legacy_compatibility_tombstone_best_effort(
                &kv,
                &credential_id,
                &policy,
                &credential,
            )
            .await;
            return Response::from_json(&admin_credential_response(
                &credential_id,
                &credential,
                Some(&policy),
            ));
        }
        if req.method() == Method::Post {
            let Some(credential_id) = rest.strip_suffix("/revoke") else {
                return json_error("route_not_found", "route not found", 404);
            };
            let credential_id = match validate_admin_kid(credential_id.trim_end_matches('/')) {
                Ok(credential_id) => credential_id,
                Err(message) => return json_error("invalid_credential", message, 400),
            };
            let Some(mut credential) =
                authoritative_proxy_credential(&env, &kv, &credential_id).await?
            else {
                return json_error(
                    "unknown_proxy_key",
                    "proxy credential is not registered",
                    404,
                );
            };
            credential.enabled = false;
            put_authoritative_proxy_credential(&env, &kv, &credential_id, &credential).await?;
            let policy = authoritative_access_policy(&env, &kv, &credential.policy_id).await?;
            if let Some(policy) = policy.as_ref() {
                sync_legacy_compatibility_tombstone_best_effort(
                    &kv,
                    &credential_id,
                    policy,
                    &credential,
                )
                .await;
            } else {
                disable_legacy_key_record_best_effort(&kv, &credential_id).await;
            }
            return Response::from_json(&admin_credential_response(
                &credential_id,
                &credential,
                policy.as_ref(),
            ));
        }
        return json_error("method_not_allowed", "admin method is not allowed", 405);
    }

    if req.method() == Method::Get && path == "/v1/admin/connections" {
        let snapshot = provider_snapshot()?;
        let connections = list_provider_connections(&env, &kv, &snapshot).await?;
        return Response::from_json(&serde_json::json!({ "connections": connections }));
    }

    if let Some(provider_id) = path.strip_prefix("/v1/admin/connections/") {
        if req.method() != Method::Put {
            return json_error("method_not_allowed", "admin method is not allowed", 405);
        }
        let snapshot = provider_snapshot()?;
        if !snapshot
            .providers
            .iter()
            .any(|provider| provider.id == provider_id)
        {
            return json_error("unknown_provider", "provider is not declared", 404);
        }
        let mut connection =
            match serde_json::from_str::<ProviderConnectionRecord>(&req.text().await?) {
                Ok(connection) => connection,
                Err(error) => {
                    return json_error(
                        "invalid_connection_request",
                        &format!("request body must be a JSON provider connection: {error}"),
                        400,
                    );
                }
            };
        connection.provider_id = provider_id.to_string();
        connection.label = match normalize_optional_label(connection.label) {
            Ok(label) => label,
            Err(message) => return json_error("invalid_connection", message, 400),
        };
        let namespace = access_control_namespace(&env)?;
        put_access_control_connection(
            &namespace,
            &provider_connection_object_name(provider_id),
            &connection,
        )
        .await?;
        sync_kv_record_best_effort(
            &kv,
            &format!("connections/{provider_id}"),
            &connection,
            "provider connection compatibility record",
        )
        .await;
        return Response::from_json(&connection);
    }

    if let Some(email) = path.strip_prefix("/v1/admin/access-user-grants/") {
        if req.method() != Method::Put {
            return json_error("method_not_allowed", "admin method is not allowed", 405);
        }
        let email = match decode_access_user_email(email) {
            Ok(email) => email,
            Err(message) => return json_error("invalid_access_user", message, 400),
        };
        let mut request =
            match serde_json::from_str::<AdminAccessUserGrantsRequest>(&req.text().await?) {
                Ok(request) => request,
                Err(error) => {
                    return json_error(
                        "invalid_access_user_grants_request",
                        &format!("request body must be a JSON access user grant record: {error}"),
                        400,
                    );
                }
            };
        request.record.role = AccessRole::User;
        request.record.groups = match normalize_access_groups(request.record.groups) {
            Ok(groups) => groups,
            Err(message) => return json_error("invalid_access_user", &message, 400),
        };
        let mut desired_policy_ids = BTreeSet::new();
        for policy_id in request.policy_ids {
            let policy_id = match validate_admin_kid(policy_id.trim()) {
                Ok(policy_id) => policy_id,
                Err(message) => return json_error("invalid_policy", message, 400),
            };
            desired_policy_ids.insert(policy_id);
        }
        let policy_ids = desired_policy_ids.iter().cloned().collect::<Vec<_>>();
        let policies = authoritative_access_policies(&env, &kv, &policy_ids).await?;
        let missing_policy_ids = policy_ids
            .iter()
            .filter(|policy_id| !policies.contains_key(*policy_id))
            .cloned()
            .collect::<Vec<_>>();
        if !missing_policy_ids.is_empty() {
            return json_error(
                "unknown_policy",
                &format!(
                    "bound policies do not exist: {}",
                    missing_policy_ids.join(",")
                ),
                404,
            );
        }
        let user = AccessControlUser {
            email: email.clone(),
            record: request.record.clone(),
        };
        let bindings =
            put_authoritative_access_user_bindings(&env, &kv, &user, &policy_ids).await?;
        return Response::from_json(&serde_json::json!({
            "user": access_user_response(&email, request.record, &env)?,
            "bindings": bindings
        }));
    }

    if let Some(email) = path.strip_prefix("/v1/admin/access-users/") {
        if req.method() != Method::Put {
            return json_error("method_not_allowed", "admin method is not allowed", 405);
        }
        let email = match decode_access_user_email(email) {
            Ok(email) => email,
            Err(message) => return json_error("invalid_access_user", message, 400),
        };
        let patch = match serde_json::from_str::<AdminAccessUserPatchRequest>(&req.text().await?) {
            Ok(request) => request,
            Err(error) => {
                return json_error(
                    "invalid_access_user_request",
                    &format!("request body must be a JSON access user patch record: {error}"),
                    400,
                );
            }
        };
        let existing =
            access_control_user_record(&env, &email, &default_access_tenant(&env)).await?;
        let request = match apply_access_user_patch(existing, patch) {
            Ok(request) => request,
            Err(message) => return json_error("invalid_access_user", &message, 400),
        };
        let namespace = access_control_namespace(&env)?;
        let user = AccessControlUser {
            email: email.clone(),
            record: request.clone(),
        };
        put_access_control_user(&namespace, &user).await?;
        sync_kv_record_best_effort(
            &kv,
            &format!("access/users/{email}"),
            &request,
            "access user compatibility record",
        )
        .await;
        return Response::from_json(&access_user_response(&email, request, &env)?);
    }

    if req.method() == Method::Get && path == "/v1/admin/keys" {
        let entries = list_admin_key_policies(&env, &kv).await?;
        return Response::from_json(&serde_json::json!({ "keys": entries }));
    }

    let Some(rest) = path.strip_prefix("/v1/admin/keys/") else {
        return json_error("route_not_found", "route not found", 404);
    };
    if req.method() == Method::Put {
        let kid = match validate_admin_kid(rest) {
            Ok(kid) => kid,
            Err(message) => return json_error("invalid_admin_key", message, 400),
        };
        let request = match serde_json::from_str::<AdminKeyPolicyRequest>(&req.text().await?) {
            Ok(request) => request,
            Err(error) => {
                return json_error(
                    "invalid_admin_request",
                    &format!("request body must be a JSON policy: {error}"),
                    400,
                );
            }
        };
        let existing_policy = authoritative_access_policy(&env, &kv, &kid).await?;
        let existing_credential = authoritative_proxy_credential(&env, &kv, &kid).await?;
        let existing_secret_sha256 = if request.secret_sha256.is_none() {
            existing_credential
                .as_ref()
                .map(|credential| credential.secret_sha256.clone())
        } else {
            None
        };
        let existing_all_providers = existing_policy
            .as_ref()
            .is_some_and(|policy| policy.providers.is_empty());
        let mut legacy =
            match request.try_into_policy(existing_secret_sha256, existing_all_providers) {
                Ok(legacy) => legacy,
                Err(message) => return json_error("invalid_admin_policy", message, 400),
            };
        preserve_existing_legacy_generation(&mut legacy, existing_policy.as_ref());
        let policy = legacy.access_policy();
        let credential = legacy.credential(&kid);
        if legacy_key_update_changes_policy_and_secret(
            existing_policy.as_ref(),
            existing_credential.as_ref(),
            &policy,
            &credential,
        ) {
            return json_error(
                "unsafe_legacy_key_update",
                "legacy key updates cannot change policy scope and secret together; use canonical policy and credential endpoints",
                409,
            );
        }
        if let Err(message) = validate_policy_providers(&policy) {
            return json_error("invalid_admin_policy", &message, 400);
        }
        let mut tombstone_legacy = legacy.clone();
        tombstone_legacy.enabled = false;
        put_authoritative_policy_and_credential(&env, &kv, &kid, &policy, &kid, &credential)
            .await?;
        sync_kv_record_best_effort(
            &kv,
            &format!("keys/{kid}"),
            &tombstone_legacy,
            "legacy key compatibility tombstone",
        )
        .await;
        return Response::from_json(&admin_policy_response(&kid, &kid, &policy));
    }

    if req.method() == Method::Post {
        let Some(kid) = rest.strip_suffix("/revoke") else {
            return json_error("route_not_found", "route not found", 404);
        };
        let kid = match validate_admin_kid(kid.trim_end_matches('/')) {
            Ok(kid) => kid,
            Err(message) => return json_error("invalid_admin_key", message, 400),
        };
        let Some(mut credential) = authoritative_proxy_credential(&env, &kv, &kid).await? else {
            return json_error("unknown_proxy_key", "proxy key is not registered", 404);
        };
        let policy_id = credential.policy_id.clone();
        // Legacy key ids can reference shared policies, so revocation is credential-scoped.
        credential.enabled = false;
        put_authoritative_proxy_credential(&env, &kv, &kid, &credential).await?;
        disable_legacy_key_record_best_effort(&kv, &kid).await;
        if let Some(policy) = authoritative_access_policy(&env, &kv, &policy_id).await? {
            let mut response = admin_policy_response(&kid, &policy_id, &policy);
            response.enabled = credential.enabled
                && policy.enabled
                && credential_policy_generation_matches(&credential, &policy);
            return Response::from_json(&response);
        }
        return Response::from_json(&admin_credential_response(&kid, &credential, None));
    }

    json_error("method_not_allowed", "admin method is not allowed", 405)
}

async fn verified_access_session(headers: &Headers, env: &Env) -> Result<Option<AccessSession>> {
    let Some(payload) = verified_access_payload(headers, env).await? else {
        return Ok(None);
    };
    let Some(email) = payload
        .email
        .as_deref()
        .map(str::trim)
        .filter(|email| !email.is_empty())
    else {
        return Ok(None);
    };
    let normalized_email = email.to_ascii_lowercase();
    let Some(identity) = access_role_for_email(env, &normalized_email, payload.iat).await? else {
        return Ok(None);
    };
    Ok(Some(AccessSession {
        authenticated: true,
        auth: "cloudflare_access",
        role: identity.role,
        email: normalized_email,
        subject: payload.sub,
        tenant_id: identity.tenant_id,
        groups: identity.groups,
        content_retention_disabled: identity.content_retention_disabled,
    }))
}

async fn verified_access_payload(headers: &Headers, env: &Env) -> Result<Option<AccessJwtPayload>> {
    let jwt = headers.get("cf-access-jwt-assertion")?.unwrap_or_default();
    let team_domain =
        normalized_access_team_domain(&optional_env_value(env, "CLAWROUTER_ACCESS_TEAM_DOMAIN")?);
    let expected_aud = optional_env_value(env, "CLAWROUTER_ACCESS_AUD")?;
    if jwt.is_empty() || team_domain.is_empty() || expected_aud.is_empty() {
        return Ok(None);
    }
    let Some((encoded_header, encoded_payload, encoded_signature)) = split_jwt(&jwt) else {
        return Ok(None);
    };
    let Some(header_bytes) = access_jwt_part(encoded_header) else {
        return Ok(None);
    };
    let header = match serde_json::from_slice::<AccessJwtHeader>(&header_bytes) {
        Ok(header) => header,
        Err(_) => return Ok(None),
    };
    if header.alg.as_deref() != Some("RS256") {
        return Ok(None);
    }
    let Some(kid) = header.kid.as_deref().filter(|kid| !kid.is_empty()) else {
        return Ok(None);
    };
    let cert = match access_cert(&team_domain, kid).await? {
        Some(cert) => cert,
        None => return Ok(None),
    };
    let Some(signature) = access_jwt_part(encoded_signature) else {
        return Ok(None);
    };
    if !verify_access_signature(
        &cert,
        format!("{encoded_header}.{encoded_payload}").as_bytes(),
        &signature,
    )
    .await?
    {
        return Ok(None);
    }
    let Some(payload_bytes) = access_jwt_part(encoded_payload) else {
        return Ok(None);
    };
    let payload = match serde_json::from_slice::<AccessJwtPayload>(&payload_bytes) {
        Ok(payload) => payload,
        Err(_) => return Ok(None),
    };
    if valid_access_payload(&payload, &team_domain, &expected_aud) {
        Ok(Some(payload))
    } else {
        Ok(None)
    }
}

async fn access_cert(team_domain: &str, kid: &str) -> Result<Option<AccessPublicJwk>> {
    let mut init = RequestInit::new();
    init.with_method(Method::Get);
    let request = Request::new_with_init(
        &format!("https://{team_domain}/cdn-cgi/access/certs"),
        &init,
    )?;
    let mut response = Fetch::Request(request).send().await?;
    if response.status_code() != 200 {
        return Ok(None);
    }
    let certs = response.json::<AccessCerts>().await?;
    Ok(certs
        .keys
        .into_iter()
        .find(|key| key.kid.as_deref() == Some(kid)))
}

async fn verify_access_signature(
    cert: &AccessPublicJwk,
    signing_input: &[u8],
    signature: &[u8],
) -> Result<bool> {
    if cert.kty.as_deref() != Some("RSA") {
        return Ok(false);
    }
    let Some(n) = cert.n.as_deref() else {
        return Ok(false);
    };
    let Some(e) = cert.e.as_deref() else {
        return Ok(false);
    };
    let jwk = Object::new();
    js_set(&jwk, "kty", "RSA")?;
    js_set(&jwk, "n", n)?;
    js_set(&jwk, "e", e)?;
    js_set(&jwk, "alg", "RS256")?;
    js_set(&jwk, "ext", true)?;

    let algorithm = Object::new();
    js_set(&algorithm, "name", "RSASSA-PKCS1-v1_5")?;
    js_set(&algorithm, "hash", "SHA-256")?;

    let usages = Array::new();
    usages.push(&JsValue::from_str("verify"));
    let subtle = subtle_crypto()?;
    let import_key = js_function(&subtle, "importKey")?;
    let key_promise = import_key
        .call5(
            &subtle,
            &JsValue::from_str("jwk"),
            &jwk,
            &algorithm,
            &JsValue::FALSE,
            &usages,
        )
        .map_err(js_error)?;
    let key = JsFuture::from(Promise::from(key_promise))
        .await
        .map_err(js_error)?;

    let verify = js_function(&subtle, "verify")?;
    let signature = Uint8Array::from(signature);
    let data = Uint8Array::from(signing_input);
    let verified = verify
        .call4(&subtle, &algorithm, &key, &signature, &data)
        .map_err(js_error)?;
    Ok(JsFuture::from(Promise::from(verified))
        .await
        .map_err(js_error)?
        .as_bool()
        .unwrap_or(false))
}

fn valid_access_payload(payload: &AccessJwtPayload, team_domain: &str, expected_aud: &str) -> bool {
    let now = js_sys::Date::now() as u64 / 1000;
    access_audiences(payload).contains(&expected_aud)
        && payload.iss.as_deref() == Some(&format!("https://{team_domain}"))
        && payload.exp.is_some_and(|exp| exp > now)
        && payload.nbf.is_none_or(|nbf| nbf <= now)
}

fn access_audiences(payload: &AccessJwtPayload) -> Vec<&str> {
    match payload.aud.as_ref() {
        Some(AccessAud::One(audience)) => vec![audience.as_str()],
        Some(AccessAud::Many(audiences)) => audiences.iter().map(String::as_str).collect(),
        None => Vec::new(),
    }
}

async fn access_role_for_email(
    env: &Env,
    email: &str,
    access_issued_at: Option<u64>,
) -> Result<Option<AccessUserIdentity>> {
    let default_tenant = default_access_tenant(env);
    let user = access_control_user_record(env, email, &default_tenant).await?;
    let user =
        reconcile_access_user_assignments_for_access_session(env, email, user, access_issued_at)
            .await;
    if !user.enabled.unwrap_or(true) {
        return Ok(None);
    }
    let content_retention_disabled = user.content_retention_disabled;
    let tenant_id = user
        .tenant_id
        .filter(|tenant| !tenant.trim().is_empty())
        .unwrap_or_else(|| default_tenant.clone());
    let groups = normalize_access_groups(user.groups).map_err(Error::RustError)?;
    let role = if access_admin_for_email(env, email)? {
        AccessRole::Admin
    } else {
        AccessRole::User
    };
    Ok(Some(AccessUserIdentity {
        role,
        tenant_id,
        groups,
        content_retention_disabled,
    }))
}

async fn access_control_user_record(
    env: &Env,
    email: &str,
    default_tenant: &str,
) -> Result<AccessUserRecord> {
    let namespace = access_control_namespace(env)?;
    let mut response = resolve_access_control_users(&namespace, vec![email.to_string()]).await?;
    if let Some(user) = response.users.pop() {
        // Existing users reconcile only through the Access JWT issued-at gate or an admin request.
        return Ok(user.record);
    }
    let kv = env.kv("POLICY_KV").map_err(|error| {
        Error::RustError(format!(
            "POLICY_KV binding is required before initializing an access user: {error}"
        ))
    })?;
    let record = existing_access_user_record(&kv, email)
        .await?
        .unwrap_or_else(|| default_access_user_record(default_tenant));
    let user = AccessControlUser {
        email: email.to_string(),
        record,
    };
    initialize_access_control_users(&namespace, std::slice::from_ref(&user)).await?;
    let mut response = resolve_access_control_users(&namespace, vec![email.to_string()]).await?;
    let user = response.users.pop().ok_or_else(|| {
        Error::RustError("access user authority did not initialize the requested user".to_string())
    })?;
    sync_kv_record_best_effort(
        &kv,
        &format!("access/users/{email}"),
        &user.record,
        "access user compatibility record",
    )
    .await;
    let record = user.record;
    match reconcile_access_user_assignments(env, &kv, email, record.clone(), None).await {
        Ok((record, _)) => Ok(record),
        Err(error) => {
            console_error!(
                "login assignment reconciliation failed for {}: {}",
                email,
                error
            );
            Ok(record)
        }
    }
}

async fn reconcile_access_user_assignments_for_access_session(
    env: &Env,
    email: &str,
    record: AccessUserRecord,
    access_issued_at: Option<u64>,
) -> AccessUserRecord {
    let Some(issued_at) = access_issued_at
        .and_then(|issued_at| issued_at.checked_mul(1_000))
        .map(timestamp_from_epoch_ms)
    else {
        return record;
    };
    let kv = match env.kv("POLICY_KV") {
        Ok(kv) => kv,
        Err(error) => {
            console_error!(
                "login assignment state lookup failed for {}: {}",
                email,
                error
            );
            return record;
        }
    };
    let state = match get_assignment_state(&kv, email).await {
        Ok(state) => state,
        Err(error) => {
            console_error!(
                "login assignment state lookup failed for {}: {}",
                email,
                error
            );
            return record;
        }
    };
    if !assignment_state_predates_issued_at(&state, &issued_at) {
        return record;
    }
    match reconcile_access_user_assignments(env, &kv, email, record.clone(), None).await {
        Ok((record, _)) => record,
        Err(error) => {
            console_error!(
                "login assignment reconciliation failed for {}: {}",
                email,
                error
            );
            record
        }
    }
}

fn assignment_state_predates_issued_at(state: &AssignmentStateRecord, issued_at: &str) -> bool {
    state
        .updated_at
        .as_deref()
        .is_none_or(|updated_at| updated_at < issued_at)
}

fn default_access_user_record(default_tenant: &str) -> AccessUserRecord {
    AccessUserRecord {
        role: AccessRole::User,
        tenant_id: Some(default_tenant.to_string()),
        enabled: Some(true),
        groups: Vec::new(),
        content_retention_disabled: false,
    }
}

fn apply_access_user_patch(
    mut record: AccessUserRecord,
    patch: AdminAccessUserPatchRequest,
) -> std::result::Result<AccessUserRecord, String> {
    record.role = AccessRole::User;
    if let Some(tenant_id) = patch.tenant_id {
        record.tenant_id = Some(tenant_id);
    }
    if let Some(enabled) = patch.enabled {
        record.enabled = Some(enabled);
    }
    if let Some(groups) = patch.groups {
        record.groups = normalize_access_groups(groups)?;
    }
    if let Some(disabled) = patch.content_retention_disabled {
        record.content_retention_disabled = disabled;
    }
    Ok(record)
}

async fn existing_access_user_record(
    kv: &KvStore,
    email: &str,
) -> Result<Option<AccessUserRecord>> {
    let Some(record) = kv
        .get(&format!("access/users/{email}"))
        .text()
        .await
        .map_err(|error| Error::RustError(format!("failed to read access user: {error}")))?
    else {
        return Ok(None);
    };
    serde_json::from_str::<AccessUserRecord>(&record)
        .map(Some)
        .map_err(|error| Error::RustError(format!("access user is invalid JSON: {error}")))
}

async fn user_profile(headers: &Headers, env: &Env) -> Result<Response> {
    let auth = match authorize_proxy_key_identity(headers, env).await? {
        AuthOutcome::Allowed(auth) => auth,
        AuthOutcome::Denied(response) => return Ok(response),
    };
    Response::from_json(&serde_json::json!({
        "key": key_profile_response(&auth)
    }))
}

async fn user_usage(headers: &Headers, env: &Env) -> Result<Response> {
    let auth = match authorize_proxy_key_identity(headers, env).await? {
        AuthOutcome::Allowed(auth) => auth,
        AuthOutcome::Denied(response) => return Ok(response),
    };
    let tenant_id = tenant_id(&auth);
    let budget = budget_status_for_key(
        env,
        &tenant_id,
        &auth.policy_id,
        auth.policy.monthly_budget_micros,
    )
    .await?;
    let mut usage = usage_snapshot(env, Some(&auth.policy_id), 50).await?;
    usage.events.clear();
    Response::from_json(&serde_json::json!({
        "key": key_profile_response(&auth),
        "budget": budget,
        "usage": usage
    }))
}

async fn access_session_usage(headers: &Headers, env: &Env) -> Result<Response> {
    let Some(session) = verified_access_session(headers, env).await? else {
        return json_error(
            "access_session_required",
            "usage requires a verified Cloudflare Access session",
            401,
        );
    };
    let kv = match env.kv("POLICY_KV") {
        Ok(kv) => kv,
        Err(_) => {
            return json_error(
                "policy_store_unavailable",
                POLICY_KV_ENTITLEMENTS_REQUIRED,
                503,
            );
        }
    };
    let entries = list_session_policy_entries(&kv, env, &session).await?;
    let mut policies = Vec::with_capacity(entries.len());
    let mut usage = empty_usage_snapshot("durable_object");
    for entry in entries {
        if !entry.policy.enabled {
            continue;
        }
        let policy_id = entry.policy_id;
        let policy = entry.policy;
        policies.push(
            admin_usage_row(env, admin_policy_response(&policy_id, &policy_id, &policy)).await?,
        );
        merge_usage_snapshot(&mut usage, usage_snapshot(env, Some(&policy_id), 0).await?);
    }
    usage.events.clear();
    Response::from_json(&serde_json::json!({
        "policies": policies,
        "usage": usage
    }))
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
    let Some(credential) = authoritative_proxy_credential(env, &kv, &key.kid).await? else {
        return key_inspection_response(
            &key.kid,
            &format!("{:?}", key.mode),
            None,
            Some("unknown_proxy_key"),
        );
    };
    let Some(policy) = authoritative_access_policy(env, &kv, &credential.policy_id).await? else {
        return key_inspection_response(
            &key.kid,
            &format!("{:?}", key.mode),
            None,
            Some("unknown_policy"),
        );
    };
    let verification = key_inspection_verification(&key.secret, &credential, &policy);
    let verified_policy = inspect_policy_for_response(verification, &policy);
    key_inspection_response(
        &key.kid,
        &format!("{:?}", key.mode),
        verified_policy,
        Some(verification),
    )
}

fn key_verification(secret: &str, credential: &ProxyCredential) -> &'static str {
    if sha256_hex(secret) == credential.secret_sha256 {
        "verified"
    } else {
        "invalid_secret"
    }
}

fn key_inspection_verification(
    secret: &str,
    credential: &ProxyCredential,
    policy: &AccessPolicy,
) -> &'static str {
    if !credential.enabled {
        return "revoked";
    }
    let verification = key_verification(secret, credential);
    if verification == "verified" && !credential_policy_generation_matches(credential, policy) {
        "policy_generation_mismatch"
    } else if verification == "verified" && !policy.enabled {
        "policy_revoked"
    } else {
        verification
    }
}

impl AdminKeyPolicyRequest {
    fn try_into_policy(
        self,
        existing_secret_sha256: Option<String>,
        existing_all_providers: bool,
    ) -> std::result::Result<LegacyKeyPolicy, &'static str> {
        let secret_sha256 = match self.secret_sha256 {
            Some(secret_sha256) if is_sha256_hex(&secret_sha256) => secret_sha256,
            Some(_) => return Err("secretSha256 must be a 64-character hex string"),
            None => existing_secret_sha256
                .filter(|value| is_sha256_hex(value))
                .ok_or("secretSha256 is required for new proxy keys")?,
        };
        let providers = self.providers.ok_or("providers is required")?;
        if providers.is_empty() && !self.all_providers && !existing_all_providers {
            return Err("providers must contain at least one provider id");
        }
        if !providers.is_empty() && self.all_providers {
            return Err("allProviders cannot be combined with provider ids");
        }
        if let Some(value) = self.monthly_budget_micros {
            validate_admin_budget(value, "monthlyBudgetMicros")?;
        }
        if let Some(value) = self.request_cost_micros {
            validate_admin_budget(value, "requestCostMicros")?;
        }
        let token_role = normalize_token_role(self.token_role)?;
        Ok(LegacyKeyPolicy {
            enabled: self.enabled,
            secret_sha256: secret_sha256.to_ascii_lowercase(),
            generation: new_policy_generation(),
            providers,
            tenant_id: self.tenant_id,
            token_role,
            monthly_budget_micros: self.monthly_budget_micros,
            request_cost_micros: self.request_cost_micros,
            retain_request_content: self.retain_request_content,
        })
    }
}

impl AdminAccessPolicyRequest {
    fn try_into_policy(self) -> std::result::Result<AccessPolicy, &'static str> {
        let providers = self.providers.ok_or("providers is required")?;
        if providers.is_empty() && !self.all_providers {
            return Err("allProviders must be true for wildcard provider access");
        }
        if !providers.is_empty() && self.all_providers {
            return Err("allProviders cannot be combined with provider ids");
        }
        Ok(AccessPolicy {
            enabled: self.enabled,
            generation: new_policy_generation(),
            providers,
            tenant_id: self.tenant_id,
            token_role: normalize_token_role(self.token_role)?,
            monthly_budget_micros: self.monthly_budget_micros,
            request_cost_micros: self.request_cost_micros,
            retain_request_content: self.retain_request_content,
        })
    }
}

impl LegacyKeyPolicy {
    fn access_policy(&self) -> AccessPolicy {
        AccessPolicy {
            enabled: self.enabled,
            generation: self.generation.clone(),
            providers: self.providers.clone(),
            tenant_id: self.tenant_id.clone(),
            token_role: self.token_role.clone(),
            monthly_budget_micros: self.monthly_budget_micros,
            request_cost_micros: self.request_cost_micros,
            retain_request_content: self.retain_request_content,
        }
    }

    fn credential(&self, policy_id: &str) -> ProxyCredential {
        ProxyCredential {
            enabled: self.enabled,
            secret_sha256: self.secret_sha256.clone(),
            policy_id: policy_id.to_string(),
            policy_generation: self.generation.clone(),
            principal_id: None,
        }
    }
}

fn validate_admin_budget(value: u64, name: &'static str) -> std::result::Result<(), &'static str> {
    (value <= MAX_SQL_BUDGET_MICROS)
        .then_some(())
        .ok_or(match name {
            "monthlyBudgetMicros" => "monthlyBudgetMicros exceeds the durable ledger limit",
            "requestCostMicros" => "requestCostMicros exceeds the durable ledger limit",
            _ => "budget value exceeds the durable ledger limit",
        })
}

fn normalize_token_role(
    value: Option<String>,
) -> std::result::Result<Option<String>, &'static str> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    if value.len() > 32
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return Err(
            "tokenRole must be 32 or fewer ASCII letters, numbers, underscores, or hyphens",
        );
    }
    Ok(Some(value.to_ascii_lowercase()))
}

fn normalize_optional_label(
    value: Option<String>,
) -> std::result::Result<Option<String>, &'static str> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    if value.len() > 80 || value.bytes().any(|byte| byte.is_ascii_control()) {
        return Err("label must be 80 or fewer characters without control characters");
    }
    Ok(Some(value.to_string()))
}

fn validate_policy_providers(policy: &AccessPolicy) -> std::result::Result<(), String> {
    if policy.providers.is_empty() {
        return Ok(());
    }
    let snapshot = provider_snapshot().map_err(|error| error.to_string())?;
    for provider_id in &policy.providers {
        if !snapshot
            .providers
            .iter()
            .any(|provider| provider.id == *provider_id)
        {
            return Err(format!("unknown provider `{provider_id}`"));
        }
    }
    Ok(())
}

fn validate_policy_budget(policy: &AccessPolicy) -> std::result::Result<(), &'static str> {
    if let Some(value) = policy.monthly_budget_micros {
        validate_admin_budget(value, "monthlyBudgetMicros")?;
    }
    if let Some(value) = policy.request_cost_micros {
        validate_admin_budget(value, "requestCostMicros")?;
    }
    Ok(())
}

fn validate_admin_kid(value: &str) -> std::result::Result<String, &'static str> {
    if value.len() < 4
        || value.contains('/')
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_')
    {
        return Err(
            "key id must be at least 4 alphanumeric or underscore characters and must not contain `-` or `/`",
        );
    }
    Ok(value.to_string())
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn admin_policy_response(
    kid: &str,
    policy_id: &str,
    policy: &AccessPolicy,
) -> AdminKeyPolicyResponse {
    AdminKeyPolicyResponse {
        kid: kid.to_string(),
        policy_id: policy_id.to_string(),
        enabled: policy.enabled,
        providers: policy.providers.clone(),
        tenant_id: policy.tenant_id.clone(),
        token_role: policy.token_role.clone(),
        monthly_budget_micros: policy.monthly_budget_micros,
        request_cost_micros: policy.request_cost_micros,
        retain_request_content: policy.retain_request_content,
    }
}

fn admin_access_policy_response(
    policy_id: &str,
    policy: &AccessPolicy,
) -> AdminAccessPolicyResponse {
    AdminAccessPolicyResponse {
        policy_id: policy_id.to_string(),
        enabled: policy.enabled,
        providers: policy.providers.clone(),
        tenant_id: policy.tenant_id.clone(),
        token_role: policy.token_role.clone(),
        monthly_budget_micros: policy.monthly_budget_micros,
        request_cost_micros: policy.request_cost_micros,
        retain_request_content: policy.retain_request_content,
    }
}

fn admin_credential_response(
    credential_id: &str,
    credential: &ProxyCredential,
    policy: Option<&AccessPolicy>,
) -> AdminCredentialResponse {
    let policy_enabled = policy.is_some_and(|policy| policy.enabled);
    let generation_matches =
        policy.is_some_and(|policy| credential_policy_generation_matches(credential, policy));
    AdminCredentialResponse {
        credential_id: credential_id.to_string(),
        policy_id: credential.policy_id.clone(),
        enabled: credential.enabled,
        policy_enabled,
        generation_matches,
        active: credential.enabled && policy_enabled && generation_matches,
        principal_id: credential.principal_id.clone(),
    }
}

fn key_profile_response(auth: &AuthorizedKey) -> KeyProfileResponse {
    KeyProfileResponse {
        kid: auth
            .credential_id
            .clone()
            .unwrap_or_else(|| auth.policy_id.clone()),
        policy_id: auth.policy_id.clone(),
        enabled: auth.policy.enabled,
        providers: auth.policy.providers.clone(),
        tenant_id: tenant_id(auth),
        token_role: auth.policy.token_role.clone(),
        monthly_budget_micros: auth.policy.monthly_budget_micros,
        request_cost_micros: auth.policy.request_cost_micros,
        content_retention: content_retention_view(auth),
    }
}

fn admin_overview(
    policies: &[AdminKeyPolicyResponse],
    keys: &[AdminKeyPolicyResponse],
    snapshot: &ProviderSnapshot,
) -> AdminOverviewResponse {
    let route_catalog = route_catalog(snapshot);
    AdminOverviewResponse {
        policies_total: policies.len(),
        policies_active: policies.iter().filter(|entry| entry.enabled).count(),
        keys_total: keys.len(),
        keys_active: keys.iter().filter(|entry| entry.enabled).count(),
        tenants_total: admin_tenant_summaries(policies, keys).len(),
        provider_count: snapshot.providers.len(),
        openai_compatible_providers: route_catalog
            .get("openaiCompatible")
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or_default(),
        manifest_routes: route_catalog
            .get("manifestProxy")
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or_default(),
        monthly_budget_micros: sum_optional_micros(
            policies.iter().map(|entry| entry.monthly_budget_micros),
        ),
        request_cost_micros: sum_optional_micros(
            policies.iter().map(|entry| entry.request_cost_micros),
        ),
    }
}

fn admin_tenant_summaries(
    policies: &[AdminKeyPolicyResponse],
    keys: &[AdminKeyPolicyResponse],
) -> Vec<AdminTenantSummary> {
    let mut tenants = BTreeMap::<String, TenantAccumulator>::new();
    for entry in policies {
        let tenant_id = response_tenant_id(entry);
        let summary = tenants.entry(tenant_id).or_default();
        summary.policies += 1;
        if entry.enabled {
            summary.active_policies += 1;
        }
        summary.monthly_budget_micros = summary
            .monthly_budget_micros
            .saturating_add(entry.monthly_budget_micros.unwrap_or_default());
        summary.request_cost_micros = summary
            .request_cost_micros
            .saturating_add(entry.request_cost_micros.unwrap_or_default());
        if entry.enabled {
            if entry.providers.is_empty() {
                summary.all_providers = true;
            } else {
                summary.providers.extend(entry.providers.iter().cloned());
            }
        }
    }
    for entry in keys {
        let summary = tenants.entry(response_tenant_id(entry)).or_default();
        summary.keys += 1;
        if entry.enabled {
            summary.active_keys += 1;
        }
    }
    tenants
        .into_iter()
        .map(|(tenant_id, summary)| AdminTenantSummary {
            tenant_id,
            policies: summary.policies,
            active_policies: summary.active_policies,
            keys: summary.keys,
            active_keys: summary.active_keys,
            providers: summary.providers.into_iter().collect(),
            all_providers: summary.all_providers,
            monthly_budget_micros: summary.monthly_budget_micros,
            request_cost_micros: summary.request_cost_micros,
        })
        .collect()
}

async fn admin_usage_row(env: &Env, entry: AdminKeyPolicyResponse) -> Result<AdminUsageRow> {
    let tenant_id = response_tenant_id(&entry);
    let budget = budget_status_for_key(
        env,
        &tenant_id,
        &entry.policy_id,
        entry.monthly_budget_micros,
    )
    .await?;
    Ok(AdminUsageRow {
        policy_id: entry.policy_id,
        kid: entry.kid,
        tenant_id,
        enabled: entry.enabled,
        providers: entry.providers,
        token_role: entry.token_role,
        monthly_budget_micros: entry.monthly_budget_micros,
        request_cost_micros: entry.request_cost_micros,
        budget,
    })
}

async fn usage_snapshot(env: &Env, policy_id: Option<&str>, limit: usize) -> Result<UsageSnapshot> {
    let Ok(namespace) = env.durable_object("USAGE_LEDGER") else {
        return Ok(empty_usage_snapshot("unavailable"));
    };
    let stub = namespace.get_by_name(usage_object_name())?;
    let mut url = format!(
        "https://clawrouter.internal/snapshot?limit={}",
        limit.min(USAGE_EVENT_LIMIT)
    );
    if let Some(policy_id) = policy_id {
        url.push_str("&policy_id=");
        url.push_str(&encode_component(policy_id));
    }
    let mut init = RequestInit::new();
    init.with_method(Method::Get);
    let req = Request::new_with_init(&url, &init)?;
    let mut response = stub.fetch_with_request(req).await?;
    let status = response.status_code();
    let text = response.text().await?;
    if !(200..=299).contains(&status) {
        return Err(Error::RustError(format!(
            "usage ledger rejected snapshot request with HTTP {status}: {text}"
        )));
    }
    serde_json::from_str::<UsageSnapshot>(&text)
        .map_err(|error| Error::RustError(format!("usage snapshot is invalid JSON: {error}")))
}

fn empty_usage_snapshot(ledger: &str) -> UsageSnapshot {
    UsageSnapshot {
        ledger: ledger.to_string(),
        summary: UsageSummary::default(),
        providers: Vec::new(),
        events: Vec::new(),
    }
}

fn merge_usage_snapshot(target: &mut UsageSnapshot, source: UsageSnapshot) {
    if source.ledger != "durable_object" {
        target.ledger = source.ledger;
    }
    target.summary.request_count = target
        .summary
        .request_count
        .saturating_add(source.summary.request_count);
    target.summary.success_count = target
        .summary
        .success_count
        .saturating_add(source.summary.success_count);
    target.summary.error_count = target
        .summary
        .error_count
        .saturating_add(source.summary.error_count);
    target.summary.input_tokens = target
        .summary
        .input_tokens
        .saturating_add(source.summary.input_tokens);
    target.summary.output_tokens = target
        .summary
        .output_tokens
        .saturating_add(source.summary.output_tokens);
    target.summary.total_tokens = target
        .summary
        .total_tokens
        .saturating_add(source.summary.total_tokens);
    target.summary.actual_cost_micros = target
        .summary
        .actual_cost_micros
        .saturating_add(source.summary.actual_cost_micros);
    for provider in source.providers {
        if let Some(existing) = target
            .providers
            .iter_mut()
            .find(|existing| existing.provider == provider.provider)
        {
            existing.request_count = existing
                .request_count
                .saturating_add(provider.request_count);
            existing.success_count = existing
                .success_count
                .saturating_add(provider.success_count);
            existing.error_count = existing.error_count.saturating_add(provider.error_count);
            existing.total_tokens = existing.total_tokens.saturating_add(provider.total_tokens);
            existing.actual_cost_micros = existing
                .actual_cost_micros
                .saturating_add(provider.actual_cost_micros);
        } else {
            target.providers.push(provider);
        }
    }
    target.providers.sort_by(|a, b| {
        b.request_count
            .cmp(&a.request_count)
            .then_with(|| a.provider.cmp(&b.provider))
    });
}

fn response_tenant_id(entry: &AdminKeyPolicyResponse) -> String {
    entry
        .tenant_id
        .clone()
        .unwrap_or_else(|| "default".to_string())
}

fn sum_optional_micros(values: impl Iterator<Item = Option<u64>>) -> u64 {
    values.fold(0_u64, |sum, value| {
        sum.saturating_add(value.unwrap_or_default())
    })
}

async fn existing_proxy_credential(
    kv: &KvStore,
    credential_id: &str,
) -> Result<Option<ProxyCredential>> {
    if let Some(record) = kv
        .get(&format!("credentials/{credential_id}"))
        .text()
        .await
        .map_err(|error| Error::RustError(format!("failed to read proxy credential: {error}")))?
    {
        let credential = serde_json::from_str::<ProxyCredential>(&record).map_err(|error| {
            Error::RustError(format!("proxy credential is invalid JSON: {error}"))
        })?;
        return Ok(Some(credential));
    }
    Ok(existing_legacy_key_policy(kv, credential_id)
        .await?
        .filter(is_pre_migration_legacy_key_policy)
        .map(|legacy| legacy.credential(credential_id)))
}

async fn existing_legacy_key_policy(kv: &KvStore, kid: &str) -> Result<Option<LegacyKeyPolicy>> {
    let Some(record) = kv
        .get(&format!("keys/{kid}"))
        .text()
        .await
        .map_err(|error| Error::RustError(format!("failed to read legacy key policy: {error}")))?
    else {
        return Ok(None);
    };
    let policy = serde_json::from_str::<LegacyKeyPolicy>(&record)
        .map_err(|error| Error::RustError(format!("legacy key policy is invalid JSON: {error}")))?;
    Ok(Some(policy))
}

struct AdminReportingSnapshot {
    policies: Vec<AdminKeyPolicyResponse>,
    keys: Vec<AdminKeyPolicyResponse>,
}

async fn admin_reporting_snapshot(env: &Env, kv: &KvStore) -> Result<AdminReportingSnapshot> {
    let policy_entries = list_access_policy_records(env, kv).await?;
    let policies = policy_entries
        .iter()
        .map(|entry| (entry.policy_id.clone(), entry.policy.clone()))
        .collect::<BTreeMap<_, _>>();
    let policy_reports = admin_policy_reports(policy_entries);
    let key_reports = admin_key_policy_responses(list_proxy_credentials(env, kv).await?, &policies);
    Ok(AdminReportingSnapshot {
        policies: policy_reports,
        keys: key_reports,
    })
}

async fn list_admin_policy_reports(env: &Env, kv: &KvStore) -> Result<Vec<AdminKeyPolicyResponse>> {
    Ok(admin_policy_reports(
        list_access_policy_records(env, kv).await?,
    ))
}

fn admin_policy_reports(entries: Vec<AccessPolicyEntry>) -> Vec<AdminKeyPolicyResponse> {
    let mut reports = entries
        .into_iter()
        .map(|entry| admin_policy_response(&entry.policy_id, &entry.policy_id, &entry.policy))
        .collect::<Vec<_>>();
    reports.sort_by(|a, b| a.policy_id.cmp(&b.policy_id));
    reports
}

async fn list_admin_key_policies(env: &Env, kv: &KvStore) -> Result<Vec<AdminKeyPolicyResponse>> {
    let credentials = list_proxy_credentials(env, kv).await?;
    let policy_ids = credentials
        .iter()
        .map(|(_, credential)| credential.policy_id.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let policies = authoritative_access_policies(env, kv, &policy_ids).await?;
    Ok(admin_key_policy_responses(credentials, &policies))
}

fn admin_key_policy_responses(
    credentials: Vec<(String, ProxyCredential)>,
    policies: &BTreeMap<String, AccessPolicy>,
) -> Vec<AdminKeyPolicyResponse> {
    let mut entries = credentials
        .into_iter()
        .filter_map(|(credential_id, credential)| {
            let policy = policies.get(&credential.policy_id)?;
            let mut response = admin_policy_response(&credential_id, &credential.policy_id, policy);
            response.enabled = credential.enabled
                && policy.enabled
                && credential_policy_generation_matches(&credential, policy);
            Some(response)
        })
        .collect::<Vec<_>>();
    entries.sort_by(|a, b| a.kid.cmp(&b.kid));
    entries
}

fn admin_credential_responses(
    credentials: Vec<(String, ProxyCredential)>,
    policies: &BTreeMap<String, AccessPolicy>,
) -> Vec<AdminCredentialResponse> {
    let mut responses = credentials
        .into_iter()
        .map(|(credential_id, credential)| {
            admin_credential_response(
                &credential_id,
                &credential,
                policies.get(&credential.policy_id),
            )
        })
        .collect::<Vec<_>>();
    responses.sort_by(|a, b| a.credential_id.cmp(&b.credential_id));
    responses
}

async fn list_access_policy_records_from_kv(kv: &KvStore) -> Result<Vec<AccessPolicyEntry>> {
    let mut entries = Vec::new();
    let mut policy_ids = BTreeSet::new();
    let mut cursor = None;
    loop {
        let mut request = kv.list().prefix("policies/".to_string()).limit(1000);
        if let Some(next_cursor) = cursor.take() {
            request = request.cursor(next_cursor);
        }
        let list = request.execute().await.map_err(|error| {
            Error::RustError(format!("failed to list access policies: {error}"))
        })?;
        for key in list.keys {
            let Some(policy_id) = key.name.strip_prefix("policies/") else {
                continue;
            };
            let Some(record) = kv.get(&key.name).text().await.map_err(|error| {
                Error::RustError(format!("failed to read access policy: {error}"))
            })?
            else {
                continue;
            };
            let policy = serde_json::from_str::<AccessPolicy>(&record).map_err(|error| {
                Error::RustError(format!("access policy is invalid JSON: {error}"))
            })?;
            policy_ids.insert(policy_id.to_string());
            entries.push(AccessPolicyEntry {
                policy_id: policy_id.to_string(),
                policy,
            });
        }
        if list.list_complete {
            break;
        }
        let Some(next_cursor) = list.cursor else {
            break;
        };
        cursor = Some(next_cursor);
    }
    for (kid, legacy) in list_legacy_key_policies(kv)
        .await?
        .into_iter()
        .filter(|(_, legacy)| is_pre_migration_legacy_key_policy(legacy))
    {
        if policy_ids.insert(kid.clone()) {
            entries.push(AccessPolicyEntry {
                policy_id: kid,
                policy: legacy.access_policy(),
            });
        }
    }
    entries.sort_by(|a, b| a.policy_id.cmp(&b.policy_id));
    Ok(entries)
}

async fn list_legacy_key_policies(kv: &KvStore) -> Result<Vec<(String, LegacyKeyPolicy)>> {
    let mut entries = Vec::new();
    let mut cursor = None;
    loop {
        let mut request = kv.list().prefix("keys/".to_string()).limit(1000);
        if let Some(next_cursor) = cursor.take() {
            request = request.cursor(next_cursor);
        }
        let list = request.execute().await.map_err(|error| {
            Error::RustError(format!("failed to list legacy key policies: {error}"))
        })?;
        for key in list.keys {
            let Some(kid) = key.name.strip_prefix("keys/") else {
                continue;
            };
            let Some(record) = kv.get(&key.name).text().await.map_err(|error| {
                Error::RustError(format!("failed to read legacy key policy: {error}"))
            })?
            else {
                continue;
            };
            let policy = serde_json::from_str::<LegacyKeyPolicy>(&record).map_err(|error| {
                Error::RustError(format!("legacy key policy is invalid JSON: {error}"))
            })?;
            entries.push((kid.to_string(), policy));
        }
        if list.list_complete {
            break;
        }
        let Some(next_cursor) = list.cursor else {
            break;
        };
        cursor = Some(next_cursor);
    }
    Ok(entries)
}

async fn list_proxy_credentials_from_kv(kv: &KvStore) -> Result<Vec<(String, ProxyCredential)>> {
    let mut entries = Vec::new();
    let mut credential_ids = BTreeSet::new();
    let mut cursor = None;
    loop {
        let mut request = kv.list().prefix("credentials/".to_string()).limit(1000);
        if let Some(next_cursor) = cursor.take() {
            request = request.cursor(next_cursor);
        }
        let list = request.execute().await.map_err(|error| {
            Error::RustError(format!("failed to list proxy credentials: {error}"))
        })?;
        for key in list.keys {
            let Some(credential_id) = key.name.strip_prefix("credentials/") else {
                continue;
            };
            let Some(record) = kv.get(&key.name).text().await.map_err(|error| {
                Error::RustError(format!("failed to read proxy credential: {error}"))
            })?
            else {
                continue;
            };
            let credential = serde_json::from_str::<ProxyCredential>(&record).map_err(|error| {
                Error::RustError(format!("proxy credential is invalid JSON: {error}"))
            })?;
            credential_ids.insert(credential_id.to_string());
            entries.push((credential_id.to_string(), credential));
        }
        if list.list_complete {
            break;
        }
        let Some(next_cursor) = list.cursor else {
            break;
        };
        cursor = Some(next_cursor);
    }
    for (kid, legacy) in list_legacy_key_policies(kv)
        .await?
        .into_iter()
        .filter(|(_, legacy)| is_pre_migration_legacy_key_policy(legacy))
    {
        if credential_ids.insert(kid.clone()) {
            entries.push((kid.clone(), legacy.credential(&kid)));
        }
    }
    entries.sort_by(|(id_a, _), (id_b, _)| id_a.cmp(id_b));
    Ok(entries)
}

async fn authoritative_access_policy(
    env: &Env,
    kv: &KvStore,
    policy_id: &str,
) -> Result<Option<AccessPolicy>> {
    let mut policies = authoritative_access_policies(env, kv, &[policy_id.to_string()]).await?;
    Ok(policies.remove(policy_id))
}

async fn authoritative_access_policies(
    env: &Env,
    kv: &KvStore,
    policy_ids: &[String],
) -> Result<BTreeMap<String, AccessPolicy>> {
    if policy_ids.is_empty() {
        return Ok(BTreeMap::new());
    }
    let namespace = access_control_namespace(env)?;
    let mut response = resolve_access_control_policies(&namespace, policy_ids.to_vec()).await?;
    if !response.missing_policy_ids.is_empty() {
        let fallback = read_access_policies_from_kv(kv, &response.missing_policy_ids).await?;
        let policies = response
            .missing_policy_ids
            .iter()
            .filter_map(|policy_id| {
                fallback
                    .get(policy_id)
                    .cloned()
                    .map(|policy| AccessPolicyEntry {
                        policy_id: policy_id.clone(),
                        policy,
                    })
            })
            .collect::<Vec<_>>();
        if !policies.is_empty() {
            initialize_access_control_policies(&namespace, &policies).await?;
        }
        response = resolve_access_control_policies(&namespace, policy_ids.to_vec()).await?;
    }
    Ok(response
        .policies
        .into_iter()
        .map(|entry| (entry.policy_id, entry.policy))
        .collect())
}

async fn list_access_policy_records(env: &Env, kv: &KvStore) -> Result<Vec<AccessPolicyEntry>> {
    let namespace = access_control_namespace(env)?;
    let fallback = list_access_policy_records_from_kv(kv).await?;
    if !fallback.is_empty() {
        initialize_access_control_policies(&namespace, &fallback).await?;
    }
    let mut response = list_access_control_policies(&namespace).await?;
    response
        .policies
        .sort_by(|a, b| a.policy_id.cmp(&b.policy_id));
    Ok(response.policies)
}

async fn put_authoritative_access_policy(
    env: &Env,
    kv: &KvStore,
    policy_id: &str,
    policy: &AccessPolicy,
) -> Result<()> {
    let namespace = access_control_namespace(env)?;
    put_access_control_policy(
        &namespace,
        &AccessPolicyEntry {
            policy_id: policy_id.to_string(),
            policy: policy.clone(),
        },
    )
    .await?;
    sync_kv_record_best_effort(
        kv,
        &format!("policies/{policy_id}"),
        policy,
        "access policy compatibility record",
    )
    .await;
    Ok(())
}

async fn put_authoritative_policy_and_credential(
    env: &Env,
    kv: &KvStore,
    policy_id: &str,
    policy: &AccessPolicy,
    credential_id: &str,
    credential: &ProxyCredential,
) -> Result<()> {
    let namespace = access_control_namespace(env)?;
    put_access_control_policy_and_credential(
        &namespace,
        &AccessControlPolicyCredentialPutRequest {
            policy: AccessPolicyEntry {
                policy_id: policy_id.to_string(),
                policy: policy.clone(),
            },
            credential: ProxyCredentialEntry {
                credential_id: credential_id.to_string(),
                credential: credential.clone(),
            },
        },
    )
    .await?;
    sync_kv_record_best_effort(
        kv,
        &format!("policies/{policy_id}"),
        policy,
        "access policy compatibility record",
    )
    .await;
    sync_kv_record_best_effort(
        kv,
        &format!("credentials/{credential_id}"),
        credential,
        "proxy credential compatibility record",
    )
    .await;
    Ok(())
}

async fn authoritative_proxy_credential(
    env: &Env,
    kv: &KvStore,
    credential_id: &str,
) -> Result<Option<ProxyCredential>> {
    let namespace = access_control_namespace(env)?;
    let mut response =
        resolve_access_control_credentials(&namespace, vec![credential_id.to_string()]).await?;
    if !response.missing_credential_ids.is_empty() {
        if let Some(credential) = existing_proxy_credential(kv, credential_id).await? {
            initialize_access_control_credentials(
                &namespace,
                &[ProxyCredentialEntry {
                    credential_id: credential_id.to_string(),
                    credential,
                }],
            )
            .await?;
        }
        response =
            resolve_access_control_credentials(&namespace, vec![credential_id.to_string()]).await?;
    }
    Ok(response.credentials.pop().map(|entry| entry.credential))
}

async fn list_proxy_credentials(env: &Env, kv: &KvStore) -> Result<Vec<(String, ProxyCredential)>> {
    let namespace = access_control_namespace(env)?;
    let fallback = list_proxy_credentials_from_kv(kv)
        .await?
        .into_iter()
        .map(|(credential_id, credential)| ProxyCredentialEntry {
            credential_id,
            credential,
        })
        .collect::<Vec<_>>();
    if !fallback.is_empty() {
        initialize_access_control_credentials(&namespace, &fallback).await?;
    }
    let mut credentials = list_access_control_credentials(&namespace)
        .await?
        .credentials
        .into_iter()
        .map(|entry| (entry.credential_id, entry.credential))
        .collect::<Vec<_>>();
    credentials.sort_by(|(id_a, _), (id_b, _)| id_a.cmp(id_b));
    Ok(credentials)
}

async fn put_authoritative_proxy_credential(
    env: &Env,
    kv: &KvStore,
    credential_id: &str,
    credential: &ProxyCredential,
) -> Result<()> {
    let namespace = access_control_namespace(env)?;
    put_access_control_credential(
        &namespace,
        &ProxyCredentialEntry {
            credential_id: credential_id.to_string(),
            credential: credential.clone(),
        },
    )
    .await?;
    sync_kv_record_best_effort(
        kv,
        &format!("credentials/{credential_id}"),
        credential,
        "proxy credential compatibility record",
    )
    .await;
    Ok(())
}

async fn existing_provider_connection(
    kv: &KvStore,
    provider_id: &str,
) -> Result<ProviderConnectionRecord> {
    let Some(record) = kv
        .get(&format!("connections/{provider_id}"))
        .text()
        .await
        .map_err(|error| {
            Error::RustError(format!("failed to read provider connection: {error}"))
        })?
    else {
        return Ok(ProviderConnectionRecord {
            provider_id: provider_id.to_string(),
            enabled: true,
            label: None,
        });
    };
    let mut connection =
        serde_json::from_str::<ProviderConnectionRecord>(&record).map_err(|error| {
            Error::RustError(format!("provider connection is invalid JSON: {error}"))
        })?;
    connection.provider_id = provider_id.to_string();
    Ok(connection)
}

async fn list_provider_connections(
    env: &Env,
    kv: &KvStore,
    snapshot: &ProviderSnapshot,
) -> Result<Vec<ProviderConnectionRecord>> {
    let provider_ids = snapshot
        .providers
        .iter()
        .map(|provider| provider.id.clone())
        .collect::<Vec<_>>();
    authoritative_provider_connections(env, kv, provider_ids).await
}

async fn authoritative_provider_connections(
    env: &Env,
    kv: &KvStore,
    provider_ids: Vec<String>,
) -> Result<Vec<ProviderConnectionRecord>> {
    let futures = provider_ids
        .into_iter()
        .map(|provider_id| authoritative_provider_connection(env, kv, provider_id));
    let mut connections = try_join_all(futures).await?;
    connections.sort_by(|a, b| a.provider_id.cmp(&b.provider_id));
    Ok(connections)
}

async fn authoritative_provider_connection(
    env: &Env,
    kv: &KvStore,
    provider_id: String,
) -> Result<ProviderConnectionRecord> {
    let namespace = access_control_namespace(env)?;
    let object_name = provider_connection_object_name(&provider_id);
    let mut response =
        resolve_access_control_connections(&namespace, &object_name, vec![provider_id.clone()])
            .await?;
    if response.missing_provider_ids.is_empty() {
        return response.connections.pop().ok_or_else(|| {
            Error::RustError(format!(
                "provider connection authority omitted `{provider_id}`"
            ))
        });
    }

    let mut legacy = resolve_access_control_connections(
        &namespace,
        access_control_object_name(),
        vec![provider_id.clone()],
    )
    .await?;
    let connection = match legacy.connections.pop() {
        Some(connection) => connection,
        None => existing_provider_connection(kv, &provider_id).await?,
    };
    initialize_access_control_connections(
        &namespace,
        &object_name,
        std::slice::from_ref(&connection),
    )
    .await?;
    let mut response =
        resolve_access_control_connections(&namespace, &object_name, vec![provider_id.clone()])
            .await?;
    response.connections.pop().ok_or_else(|| {
        Error::RustError(format!(
            "provider connection authority did not initialize `{provider_id}`"
        ))
    })
}

async fn list_provider_health(kv: &KvStore) -> Result<BTreeMap<String, ProviderHealthRecord>> {
    let mut health = BTreeMap::new();
    let mut cursor = None;
    loop {
        let mut request = kv
            .list()
            .prefix("health/providers/".to_string())
            .limit(1000);
        if let Some(next_cursor) = cursor.take() {
            request = request.cursor(next_cursor);
        }
        let list = request.execute().await.map_err(|error| {
            Error::RustError(format!("failed to list provider health: {error}"))
        })?;
        for key in list.keys {
            let Some(provider_id) = key.name.strip_prefix("health/providers/") else {
                continue;
            };
            let Some(record) = kv.get(&key.name).text().await.map_err(|error| {
                Error::RustError(format!("failed to read provider health: {error}"))
            })?
            else {
                continue;
            };
            let record =
                serde_json::from_str::<ProviderHealthRecord>(&record).map_err(|error| {
                    Error::RustError(format!("provider health is invalid JSON: {error}"))
                })?;
            health.insert(provider_id.to_string(), record);
        }
        if list.list_complete {
            break;
        }
        let Some(next_cursor) = list.cursor else {
            break;
        };
        cursor = Some(next_cursor);
    }
    Ok(health)
}

async fn put_kv_record<T: Serialize>(kv: &KvStore, key: &str, value: &T, kind: &str) -> Result<()> {
    let value = serde_json::to_string(value)?;
    kv.put(key, value)
        .map_err(|error| Error::RustError(format!("failed to prepare {kind}: {error}")))?
        .execute()
        .await
        .map_err(|error| Error::RustError(format!("failed to write {kind}: {error}")))
}

async fn sync_kv_record_best_effort<T: Serialize>(kv: &KvStore, key: &str, value: &T, kind: &str) {
    if let Err(error) = put_kv_record(kv, key, value, kind).await {
        console_error!("failed to sync {} {}: {}", kind, key, error);
    }
}

async fn sync_legacy_compatibility_tombstone(
    kv: &KvStore,
    credential_id: &str,
    policy: &AccessPolicy,
    credential: &ProxyCredential,
) -> Result<()> {
    if existing_legacy_key_policy(kv, credential_id)
        .await?
        .is_none()
    {
        return Ok(());
    }
    let legacy = legacy_compatibility_tombstone(policy, credential);
    put_kv_record(
        kv,
        &format!("keys/{credential_id}"),
        &legacy,
        "legacy compatibility tombstone",
    )
    .await
}

async fn disable_legacy_key_record(kv: &KvStore, credential_id: &str) -> Result<()> {
    let Some(mut legacy) = existing_legacy_key_policy(kv, credential_id).await? else {
        return Ok(());
    };
    legacy.enabled = false;
    put_kv_record(
        kv,
        &format!("keys/{credential_id}"),
        &legacy,
        "legacy compatibility tombstone",
    )
    .await
}

async fn sync_legacy_compatibility_tombstone_best_effort(
    kv: &KvStore,
    credential_id: &str,
    policy: &AccessPolicy,
    credential: &ProxyCredential,
) {
    if let Err(error) =
        sync_legacy_compatibility_tombstone(kv, credential_id, policy, credential).await
    {
        console_error!(
            "failed to sync legacy compatibility tombstone keys/{}: {}",
            credential_id,
            error
        );
    }
}

async fn disable_legacy_key_record_best_effort(kv: &KvStore, credential_id: &str) {
    if let Err(error) = disable_legacy_key_record(kv, credential_id).await {
        console_error!(
            "failed to disable legacy compatibility record keys/{}: {}",
            credential_id,
            error
        );
    }
}

fn legacy_compatibility_tombstone(
    policy: &AccessPolicy,
    credential: &ProxyCredential,
) -> LegacyKeyPolicy {
    LegacyKeyPolicy {
        enabled: false,
        secret_sha256: credential.secret_sha256.clone(),
        generation: policy.generation.clone(),
        providers: policy.providers.clone(),
        tenant_id: policy.tenant_id.clone(),
        token_role: policy.token_role.clone(),
        monthly_budget_micros: policy.monthly_budget_micros,
        request_cost_micros: policy.request_cost_micros,
        retain_request_content: policy.retain_request_content,
    }
}

async fn list_policy_bindings(env: &Env, kv: &KvStore) -> Result<Vec<PolicyBindingRecord>> {
    let namespace = access_control_namespace(env)?;
    let mut response = list_policy_binding_index(&namespace).await?;
    if !response.initialized {
        let legacy_bindings = list_policy_bindings_for_prefix(kv, "access/bindings/").await?;
        initialize_all_policy_bindings(&namespace, &legacy_bindings).await?;
        response = list_policy_binding_index(&namespace).await?;
    }
    sort_policy_bindings(&mut response.bindings);
    Ok(response.bindings)
}

async fn list_policy_bindings_for_prefix(
    kv: &KvStore,
    prefix: &str,
) -> Result<Vec<PolicyBindingRecord>> {
    let key_names = list_policy_binding_keys(kv, prefix).await?;
    read_policy_bindings(kv, &key_names).await
}

async fn list_policy_binding_keys(kv: &KvStore, prefix: &str) -> Result<Vec<String>> {
    let mut key_names = Vec::new();
    let mut cursor = None;
    loop {
        let mut request = kv.list().prefix(prefix.to_string()).limit(1000);
        if let Some(next_cursor) = cursor.take() {
            request = request.cursor(next_cursor);
        }
        let list = request.execute().await.map_err(|error| {
            Error::RustError(format!("failed to list policy bindings: {error}"))
        })?;
        for key in list.keys {
            key_names.push(key.name);
        }
        if list.list_complete {
            break;
        }
        let Some(next_cursor) = list.cursor else {
            break;
        };
        cursor = Some(next_cursor);
    }
    Ok(key_names)
}

async fn put_policy_binding_record(
    env: &Env,
    kv: &KvStore,
    binding: &PolicyBindingRecord,
) -> Result<()> {
    let principal = PolicyBindingPrincipal {
        principal_type: binding.principal_type,
        principal_id: binding.principal_id.clone(),
    };
    let namespace = access_control_namespace(env)?;
    let seed = policy_binding_index_seed(kv, principal).await?;
    initialize_policy_binding_index(&namespace, std::slice::from_ref(&seed)).await?;
    let mutation = PolicyBindingIndexMutationRequest {
        seed,
        binding: binding.clone(),
    };
    // The Durable Object is authoritative; compatibility KV must never outlive a failed mutation.
    mutate_policy_binding_index(&namespace, mutation).await?;
    sync_policy_binding_compatibility_best_effort(kv, binding).await;
    Ok(())
}

async fn sync_policy_binding_compatibility_best_effort(
    kv: &KvStore,
    binding: &PolicyBindingRecord,
) {
    let binding_key = policy_binding_key(binding);
    let compatibility_kind = if binding.enabled {
        "policy binding compatibility record"
    } else {
        "policy binding compatibility tombstone"
    };
    sync_kv_record_best_effort(kv, &binding_key, binding, compatibility_kind).await;
}

fn reconcile_user_policy_bindings(
    email: &str,
    current: Vec<PolicyBindingRecord>,
    desired_policy_ids: &BTreeSet<String>,
) -> Vec<PolicyBindingRecord> {
    let mut bindings = current
        .into_iter()
        .filter(|binding| {
            binding.principal_type == PrincipalType::User && binding.principal_id == email
        })
        .map(|binding| (binding.policy_id.clone(), binding))
        .collect::<BTreeMap<_, _>>();
    for policy_id in desired_policy_ids {
        bindings
            .entry(policy_id.clone())
            .or_insert_with(|| PolicyBindingRecord {
                policy_id: policy_id.clone(),
                principal_type: PrincipalType::User,
                principal_id: email.to_string(),
                enabled: true,
                priority: default_binding_priority(),
            });
    }
    for binding in bindings.values_mut() {
        binding.enabled = desired_policy_ids.contains(&binding.policy_id);
    }
    let mut bindings = bindings.into_values().collect::<Vec<_>>();
    sort_policy_bindings(&mut bindings);
    bindings
}

async fn put_authoritative_access_user_bindings(
    env: &Env,
    kv: &KvStore,
    user: &AccessControlUser,
    policy_ids: &[String],
) -> Result<Vec<PolicyBindingRecord>> {
    let namespace = access_control_namespace(env)?;
    let seed = policy_binding_index_seed(
        kv,
        PolicyBindingPrincipal {
            principal_type: PrincipalType::User,
            principal_id: user.email.clone(),
        },
    )
    .await?;
    let bindings = put_access_control_user_bindings(
        &namespace,
        &AccessControlUserBindingsPutRequest {
            user: user.clone(),
            policy_ids: policy_ids.to_vec(),
            seed,
        },
    )
    .await?;
    sync_kv_record_best_effort(
        kv,
        &format!("access/users/{}", user.email),
        &user.record,
        "access user compatibility record",
    )
    .await;
    for binding in &bindings {
        sync_policy_binding_compatibility_best_effort(kv, binding).await;
    }
    Ok(bindings)
}

async fn policy_binding_index_seed(
    kv: &KvStore,
    principal: PolicyBindingPrincipal,
) -> Result<PolicyBindingIndexSeed> {
    let bindings = list_policy_bindings_for_prefix(
        kv,
        &policy_binding_prefix(principal.principal_type, &principal.principal_id),
    )
    .await?;
    Ok(PolicyBindingIndexSeed {
        principal,
        bindings,
    })
}

fn access_control_namespace(env: &Env) -> Result<ObjectNamespace> {
    env.durable_object("ACCESS_CONTROL").map_err(|error| {
        Error::RustError(format!(
            "ACCESS_CONTROL Durable Object binding is required for access authorization: {error}"
        ))
    })
}

async fn resolve_policy_binding_index(
    namespace: &ObjectNamespace,
    principals: Vec<PolicyBindingPrincipal>,
) -> Result<PolicyBindingIndexResolveResponse> {
    let body = access_control_request(
        namespace,
        "/resolve",
        &PolicyBindingIndexResolveRequest { principals },
    )
    .await?;
    serde_json::from_str::<PolicyBindingIndexResolveResponse>(&body).map_err(|error| {
        Error::RustError(format!(
            "policy binding index response is invalid JSON: {error}"
        ))
    })
}

async fn initialize_policy_binding_index(
    namespace: &ObjectNamespace,
    seeds: &[PolicyBindingIndexSeed],
) -> Result<()> {
    access_control_request(namespace, "/initialize", seeds)
        .await
        .map(|_| ())
}

async fn initialize_all_policy_bindings(
    namespace: &ObjectNamespace,
    bindings: &[PolicyBindingRecord],
) -> Result<()> {
    access_control_request(namespace, "/initialize-all", bindings)
        .await
        .map(|_| ())
}

async fn mutate_policy_binding_index(
    namespace: &ObjectNamespace,
    request: PolicyBindingIndexMutationRequest,
) -> Result<()> {
    access_control_request(namespace, "/mutate", &request)
        .await
        .map(|_| ())
}

async fn list_policy_binding_index(
    namespace: &ObjectNamespace,
) -> Result<PolicyBindingIndexListResponse> {
    let body = access_control_request(namespace, "/list", &()).await?;
    serde_json::from_str::<PolicyBindingIndexListResponse>(&body).map_err(|error| {
        Error::RustError(format!(
            "policy binding index list response is invalid JSON: {error}"
        ))
    })
}

async fn resolve_access_control_users(
    namespace: &ObjectNamespace,
    emails: Vec<String>,
) -> Result<AccessControlUsersResolveResponse> {
    let body = access_control_request(
        namespace,
        "/users/resolve",
        &AccessControlUsersResolveRequest { emails },
    )
    .await?;
    serde_json::from_str::<AccessControlUsersResolveResponse>(&body).map_err(|error| {
        Error::RustError(format!(
            "access user authority response is invalid JSON: {error}"
        ))
    })
}

async fn initialize_access_control_users(
    namespace: &ObjectNamespace,
    users: &[AccessControlUser],
) -> Result<()> {
    access_control_request(namespace, "/users/initialize", users)
        .await
        .map(|_| ())
}

async fn initialize_all_access_control_users(
    namespace: &ObjectNamespace,
    users: &[AccessControlUser],
) -> Result<()> {
    access_control_request(namespace, "/users/initialize-all", users)
        .await
        .map(|_| ())
}

async fn put_access_control_user(
    namespace: &ObjectNamespace,
    user: &AccessControlUser,
) -> Result<()> {
    access_control_request(namespace, "/users/put", user)
        .await
        .map(|_| ())
}

async fn put_access_control_user_bindings(
    namespace: &ObjectNamespace,
    request: &AccessControlUserBindingsPutRequest,
) -> Result<Vec<PolicyBindingRecord>> {
    let body = access_control_request(namespace, "/users/put-bindings", request).await?;
    serde_json::from_str::<AccessControlUserBindingsPutResponse>(&body)
        .map(|response| response.bindings)
        .map_err(|error| {
            Error::RustError(format!(
                "access user and bindings put response is invalid JSON: {error}"
            ))
        })
}

async fn list_access_control_users(
    namespace: &ObjectNamespace,
) -> Result<AccessControlUsersListResponse> {
    let body = access_control_request(namespace, "/users/list", &()).await?;
    serde_json::from_str::<AccessControlUsersListResponse>(&body).map_err(|error| {
        Error::RustError(format!(
            "access user authority list response is invalid JSON: {error}"
        ))
    })
}

async fn resolve_access_control_policies(
    namespace: &ObjectNamespace,
    policy_ids: Vec<String>,
) -> Result<AccessControlPoliciesResolveResponse> {
    let body = access_control_request(
        namespace,
        "/policies/resolve",
        &AccessControlPoliciesResolveRequest { policy_ids },
    )
    .await?;
    serde_json::from_str::<AccessControlPoliciesResolveResponse>(&body).map_err(|error| {
        Error::RustError(format!(
            "access policy authority response is invalid JSON: {error}"
        ))
    })
}

async fn initialize_access_control_policies(
    namespace: &ObjectNamespace,
    policies: &[AccessPolicyEntry],
) -> Result<()> {
    access_control_request(namespace, "/policies/initialize", policies)
        .await
        .map(|_| ())
}

async fn put_access_control_policy(
    namespace: &ObjectNamespace,
    policy: &AccessPolicyEntry,
) -> Result<()> {
    access_control_request(namespace, "/policies/put", policy)
        .await
        .map(|_| ())
}

async fn put_access_control_policy_and_credential(
    namespace: &ObjectNamespace,
    request: &AccessControlPolicyCredentialPutRequest,
) -> Result<()> {
    access_control_request(namespace, "/policy-credentials/put", request)
        .await
        .map(|_| ())
}

async fn list_access_control_policies(
    namespace: &ObjectNamespace,
) -> Result<AccessControlPoliciesListResponse> {
    let body = access_control_request(namespace, "/policies/list", &()).await?;
    serde_json::from_str::<AccessControlPoliciesListResponse>(&body).map_err(|error| {
        Error::RustError(format!(
            "access policy authority list response is invalid JSON: {error}"
        ))
    })
}

async fn resolve_access_control_credentials(
    namespace: &ObjectNamespace,
    credential_ids: Vec<String>,
) -> Result<AccessControlCredentialsResolveResponse> {
    let body = access_control_request(
        namespace,
        "/credentials/resolve",
        &AccessControlCredentialsResolveRequest { credential_ids },
    )
    .await?;
    serde_json::from_str::<AccessControlCredentialsResolveResponse>(&body).map_err(|error| {
        Error::RustError(format!(
            "proxy credential authority response is invalid JSON: {error}"
        ))
    })
}

async fn initialize_access_control_credentials(
    namespace: &ObjectNamespace,
    credentials: &[ProxyCredentialEntry],
) -> Result<()> {
    access_control_request(namespace, "/credentials/initialize", credentials)
        .await
        .map(|_| ())
}

async fn put_access_control_credential(
    namespace: &ObjectNamespace,
    credential: &ProxyCredentialEntry,
) -> Result<()> {
    access_control_request(namespace, "/credentials/put", credential)
        .await
        .map(|_| ())
}

async fn list_access_control_credentials(
    namespace: &ObjectNamespace,
) -> Result<AccessControlCredentialsListResponse> {
    let body = access_control_request(namespace, "/credentials/list", &()).await?;
    serde_json::from_str::<AccessControlCredentialsListResponse>(&body).map_err(|error| {
        Error::RustError(format!(
            "proxy credential authority list response is invalid JSON: {error}"
        ))
    })
}

async fn put_oauth_authorization_state(
    namespace: &ObjectNamespace,
    state: &OAuthAuthorizationState,
) -> Result<()> {
    access_control_request(namespace, "/oauth-states/put", state)
        .await
        .map(|_| ())
}

async fn consume_oauth_authorization_state(
    namespace: &ObjectNamespace,
    state: String,
    actor_email: String,
) -> Result<Option<OAuthAuthorizationState>> {
    let body = access_control_request(
        namespace,
        "/oauth-states/consume",
        &OAuthAuthorizationStateConsumeRequest { state, actor_email },
    )
    .await?;
    serde_json::from_str::<OAuthAuthorizationStateConsumeResponse>(&body)
        .map(|response| response.state)
        .map_err(|error| {
            Error::RustError(format!(
                "OAuth authorization state response is invalid JSON: {error}"
            ))
        })
}

async fn resolve_access_control_connections(
    namespace: &ObjectNamespace,
    object_name: &str,
    provider_ids: Vec<String>,
) -> Result<AccessControlConnectionsResolveResponse> {
    let body = access_control_request_for_object(
        namespace,
        object_name,
        "/connections/resolve",
        &AccessControlConnectionsResolveRequest { provider_ids },
    )
    .await?;
    serde_json::from_str::<AccessControlConnectionsResolveResponse>(&body).map_err(|error| {
        Error::RustError(format!(
            "provider connection authority response is invalid JSON: {error}"
        ))
    })
}

async fn initialize_access_control_connections(
    namespace: &ObjectNamespace,
    object_name: &str,
    connections: &[ProviderConnectionRecord],
) -> Result<()> {
    access_control_request_for_object(
        namespace,
        object_name,
        "/connections/initialize",
        connections,
    )
    .await
    .map(|_| ())
}

async fn put_access_control_connection(
    namespace: &ObjectNamespace,
    object_name: &str,
    connection: &ProviderConnectionRecord,
) -> Result<()> {
    access_control_request_for_object(namespace, object_name, "/connections/put", connection)
        .await
        .map(|_| ())
}

async fn access_control_request<T: Serialize + ?Sized>(
    namespace: &ObjectNamespace,
    path: &str,
    body: &T,
) -> Result<String> {
    access_control_request_for_object(namespace, access_control_object_name(), path, body).await
}

async fn access_control_request_for_object<T: Serialize + ?Sized>(
    namespace: &ObjectNamespace,
    object_name: &str,
    path: &str,
    body: &T,
) -> Result<String> {
    let stub = namespace.get_by_name(object_name)?;
    let body = serde_json::to_string(body)?;
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_body(Some(JsValue::from_str(&body)));
    let req = Request::new_with_init(&format!("https://clawrouter.internal{path}"), &init)?;
    let mut response = stub.fetch_with_request(req).await?;
    let status = response.status_code();
    let text = response.text().await?;
    if !(200..=299).contains(&status) {
        return Err(Error::RustError(format!(
            "access control authority rejected {path} with HTTP {status}: {text}"
        )));
    }
    Ok(text)
}

async fn read_policy_bindings(
    kv: &KvStore,
    key_names: &[String],
) -> Result<Vec<PolicyBindingRecord>> {
    let records = bulk_read_kv_text(kv, key_names, "policy binding").await?;
    let mut bindings = records
        .into_values()
        .map(|record| {
            serde_json::from_str::<PolicyBindingRecord>(&record).map_err(|error| {
                Error::RustError(format!("policy binding is invalid JSON: {error}"))
            })
        })
        .collect::<Result<Vec<_>>>()?;
    sort_policy_bindings(&mut bindings);
    Ok(bindings)
}

fn sort_policy_bindings(bindings: &mut [PolicyBindingRecord]) {
    bindings.sort_by(|a, b| {
        a.priority
            .cmp(&b.priority)
            .then_with(|| {
                principal_type_label(a.principal_type).cmp(principal_type_label(b.principal_type))
            })
            .then_with(|| a.principal_id.cmp(&b.principal_id))
            .then_with(|| a.policy_id.cmp(&b.policy_id))
    });
}

async fn bulk_read_kv_text(
    kv: &KvStore,
    key_names: &[String],
    kind: &str,
) -> Result<BTreeMap<String, String>> {
    let mut records = BTreeMap::new();
    for keys in key_names.chunks(KV_BULK_GET_MAX_KEYS) {
        let values =
            kv.get_bulk(keys).text().await.map_err(|error| {
                Error::RustError(format!("failed to read {kind} records: {error}"))
            })?;
        records.extend(
            values
                .into_iter()
                .filter_map(|(key, value)| value.map(|record| (key, record))),
        );
    }
    Ok(records)
}

async fn list_session_policy_entries(
    kv: &KvStore,
    env: &Env,
    session: &AccessSession,
) -> Result<Vec<AccessPolicyEntry>> {
    let bindings = session_policy_bindings(kv, env, session).await?;
    let priorities = session_binding_priorities(session, &bindings);
    let policy_ids = priorities.keys().cloned().collect::<Vec<_>>();
    let policies = authoritative_access_policies(env, kv, &policy_ids).await?;
    let mut entries = Vec::new();
    for (policy_id, priority) in priorities {
        if let Some(policy) = policies.get(&policy_id) {
            entries.push((
                priority,
                AccessPolicyEntry {
                    policy_id,
                    policy: policy.clone(),
                },
            ));
        }
    }
    entries.sort_by(|(priority_a, entry_a), (priority_b, entry_b)| {
        priority_a
            .cmp(priority_b)
            .then_with(|| entry_a.policy_id.cmp(&entry_b.policy_id))
    });
    Ok(entries.into_iter().map(|(_, entry)| entry).collect())
}

async fn session_policy_bindings(
    kv: &KvStore,
    env: &Env,
    session: &AccessSession,
) -> Result<Vec<PolicyBindingRecord>> {
    let namespace = access_control_namespace(env)?;
    let principals = session_binding_principals(session);
    let mut response = resolve_policy_binding_index(&namespace, principals.clone()).await?;
    if !response.missing_principals.is_empty() {
        let mut seeds = Vec::with_capacity(response.missing_principals.len());
        for principal in response.missing_principals {
            seeds.push(policy_binding_index_seed(kv, principal).await?);
        }
        initialize_policy_binding_index(&namespace, &seeds).await?;
        response = resolve_policy_binding_index(&namespace, principals).await?;
    }
    sort_policy_bindings(&mut response.bindings);
    Ok(response.bindings)
}

fn session_binding_priorities(
    session: &AccessSession,
    bindings: &[PolicyBindingRecord],
) -> BTreeMap<String, u16> {
    let groups = session
        .groups
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    let mut priorities = BTreeMap::<String, u16>::new();
    for binding in bindings {
        let matches_principal = match binding.principal_type {
            PrincipalType::User => binding.principal_id == session.email,
            PrincipalType::Group => groups.contains(binding.principal_id.as_str()),
        };
        if !binding.enabled || !matches_principal {
            continue;
        }
        priorities
            .entry(binding.policy_id.clone())
            .and_modify(|priority| *priority = (*priority).min(binding.priority))
            .or_insert(binding.priority);
    }
    priorities
}

async fn read_access_policies_from_kv(
    kv: &KvStore,
    policy_ids: &[String],
) -> Result<BTreeMap<String, AccessPolicy>> {
    let canonical_keys = policy_ids
        .iter()
        .map(|policy_id| format!("policies/{policy_id}"))
        .collect::<Vec<_>>();
    let canonical_records = bulk_read_kv_text(kv, &canonical_keys, "access policy").await?;
    let mut policies = BTreeMap::new();
    for policy_id in policy_ids {
        let Some(record) = canonical_records.get(&format!("policies/{policy_id}")) else {
            continue;
        };
        let policy = serde_json::from_str::<AccessPolicy>(record)
            .map_err(|error| Error::RustError(format!("access policy is invalid JSON: {error}")))?;
        policies.insert(policy_id.clone(), policy);
    }

    let legacy_keys = policy_ids
        .iter()
        .filter(|policy_id| !policies.contains_key(*policy_id))
        .map(|policy_id| format!("keys/{policy_id}"))
        .collect::<Vec<_>>();
    for (key, record) in bulk_read_kv_text(kv, &legacy_keys, "legacy key policy").await? {
        let policy_id = key.strip_prefix("keys/").unwrap_or(&key);
        let legacy = serde_json::from_str::<LegacyKeyPolicy>(&record).map_err(|error| {
            Error::RustError(format!("legacy key policy is invalid JSON: {error}"))
        })?;
        if is_pre_migration_legacy_key_policy(&legacy) {
            policies.insert(policy_id.to_string(), legacy.access_policy());
        }
    }
    Ok(policies)
}

fn session_binding_principals(session: &AccessSession) -> Vec<PolicyBindingPrincipal> {
    let mut principals = vec![PolicyBindingPrincipal {
        principal_type: PrincipalType::User,
        principal_id: session.email.clone(),
    }];
    principals.extend(session.groups.iter().map(|group| PolicyBindingPrincipal {
        principal_type: PrincipalType::Group,
        principal_id: group.clone(),
    }));
    principals
}

async fn list_oauth_grants(kv: &KvStore) -> Result<Vec<OAuthGrantRecord>> {
    let mut grants = Vec::new();
    let mut cursor = None;
    loop {
        let mut request = kv.list().prefix("oauth/".to_string()).limit(1000);
        if let Some(next_cursor) = cursor.take() {
            request = request.cursor(next_cursor);
        }
        let list = request
            .execute()
            .await
            .map_err(|error| Error::RustError(format!("failed to list OAuth grants: {error}")))?;
        for key in list.keys {
            let Some(record) = kv.get(&key.name).text().await.map_err(|error| {
                Error::RustError(format!("failed to read OAuth grant: {error}"))
            })?
            else {
                continue;
            };
            let token = parse_upstream_grant_record(&record)?;
            grants.push(OAuthGrantRecord {
                key: key.name,
                kind: token.kind,
                provider: token.provider.clone(),
                enabled: token.enabled,
                usable: upstream_grant_usable_by_declared_provider(&token),
            });
        }
        if list.list_complete {
            break;
        }
        let Some(next_cursor) = list.cursor else {
            break;
        };
        cursor = Some(next_cursor);
    }
    Ok(grants)
}

#[derive(Debug)]
struct AdminUpstreamGrantRoute {
    key: String,
    action: Option<String>,
}

fn parse_admin_upstream_grant_route(
    rest: &str,
) -> std::result::Result<AdminUpstreamGrantRoute, &'static str> {
    let mut parts = rest.split('/').collect::<Vec<_>>();
    let action = if parts
        .last()
        .is_some_and(|value| matches!(*value, "authorize" | "revoke" | "refresh"))
    {
        parts.pop().map(str::to_string)
    } else {
        None
    };
    if parts.len() != 3 {
        return Err("expected /v1/admin/upstream-grants/<policies|tenants>/<scope-id>/<token-ref>");
    }
    let scope = parts[0];
    if !matches!(scope, "policies" | "tenants") {
        return Err("upstream grant scope must be `policies` or `tenants`");
    }
    let scope_id = validate_upstream_grant_component(parts[1])?;
    let token_ref = validate_upstream_grant_component(parts[2])?;
    let key = if scope == "tenants" {
        format!("oauth/tenants/{scope_id}/{token_ref}")
    } else {
        format!("oauth/{scope_id}/{token_ref}")
    };
    Ok(AdminUpstreamGrantRoute { key, action })
}

fn validate_upstream_grant_component(value: &str) -> std::result::Result<String, &'static str> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
    {
        return Err(
            "upstream grant identifiers must be 1-128 ASCII letters, numbers, underscores, hyphens, or dots",
        );
    }
    Ok(value.to_string())
}

async fn start_oauth_authorization(
    env: &Env,
    request_url: &Url,
    grant_key: &str,
    actor_email: &str,
    provider_id: &str,
) -> Result<Response> {
    let snapshot = provider_snapshot()?;
    let Some(provider) = snapshot
        .providers
        .iter()
        .find(|provider| provider.id == provider_id)
    else {
        return json_error(
            "unknown_provider",
            "OAuth authorization provider is not registered",
            404,
        );
    };
    let Some(authorization) = provider.auth.authorization.as_ref() else {
        return json_error(
            "oauth_authorization_unsupported",
            "provider does not declare a browser OAuth authorization flow",
            409,
        );
    };
    let client_id = oauth_authorization_client_id(env, authorization).map_err(|_| {
        Error::RustError("OAuth authorization client configuration is missing".to_string())
    })?;
    let state_value = random_hex(32)?;
    let verifier = random_hex(32)?;
    let challenge = base64_url_encode(&Sha256::digest(verifier.as_bytes()));
    let redirect_uri = format!("{}/v1/oauth/callback", request_origin(request_url));
    let expires_at_ms = Date::now().as_millis() + OAUTH_AUTHORIZATION_TTL_MS;
    let state = OAuthAuthorizationState {
        state: state_value.clone(),
        verifier,
        actor_email: actor_email.to_string(),
        grant_key: grant_key.to_string(),
        provider: provider.id.clone(),
        redirect_uri: redirect_uri.clone(),
        expires_at_ms,
    };
    put_oauth_authorization_state(&access_control_namespace(env)?, &state).await?;

    let mut authorization_url = Url::parse(&authorization.authorize_url).map_err(|error| {
        Error::RustError(format!("OAuth authorization URL is invalid: {error}"))
    })?;
    {
        let mut query = authorization_url.query_pairs_mut();
        for (name, value) in &authorization.extra_authorize_params {
            query.append_pair(name, value);
        }
        query.append_pair("response_type", "code");
        query.append_pair("client_id", &client_id);
        query.append_pair("redirect_uri", &redirect_uri);
        query.append_pair("scope", &authorization.scopes.join(" "));
        query.append_pair("code_challenge", &challenge);
        query.append_pair("code_challenge_method", "S256");
        query.append_pair("state", &state_value);
    }
    Response::from_json(&serde_json::json!({
        "authorizationUrl": authorization_url.as_str(),
        "expiresAt": timestamp_from_epoch_ms(expires_at_ms),
        "provider": provider.id,
    }))
}

async fn oauth_authorization_callback(req: Request, env: Env) -> Result<Response> {
    let url = req.url()?;
    let Some(session) = verified_access_session(req.headers(), &env).await? else {
        return json_error(
            "access_admin_required",
            "OAuth callback requires the initiating Cloudflare Access admin session",
            403,
        );
    };
    if session.role != AccessRole::Admin {
        return json_error(
            "access_admin_required",
            "OAuth callback requires the initiating Cloudflare Access admin session",
            403,
        );
    }
    let Some(state_value) = query_param(&url, "state").filter(|value| !value.is_empty()) else {
        return json_error(
            "invalid_oauth_callback",
            "OAuth callback state is missing",
            400,
        );
    };
    let Some(state) = consume_oauth_authorization_state(
        &access_control_namespace(&env)?,
        state_value,
        session.email,
    )
    .await?
    else {
        return json_error(
            "invalid_oauth_callback",
            "OAuth callback state is invalid, expired, or already used",
            400,
        );
    };
    if query_param(&url, "error").is_some() {
        return oauth_authorization_result_redirect("failed", &state.provider);
    }
    let Some(code) = query_param(&url, "code").filter(|value| !value.is_empty()) else {
        return json_error(
            "invalid_oauth_callback",
            "OAuth callback authorization code is missing",
            400,
        );
    };
    complete_oauth_authorization(&env, state.clone(), &code).await?;
    oauth_authorization_result_redirect("connected", &state.provider)
}

async fn complete_oauth_authorization(
    env: &Env,
    state: OAuthAuthorizationState,
    code: &str,
) -> Result<()> {
    let snapshot = provider_snapshot()?;
    let provider = snapshot
        .providers
        .iter()
        .find(|provider| provider.id == state.provider)
        .ok_or_else(|| Error::RustError("OAuth authorization provider is not registered".into()))?;
    let authorization = provider.auth.authorization.as_ref().ok_or_else(|| {
        Error::RustError("provider does not declare a browser OAuth authorization flow".into())
    })?;
    let client_id = oauth_authorization_client_id(env, authorization)?;
    let client_secret = authorization
        .client_secret_config
        .as_deref()
        .map(|name| exact_runtime_config_value(env, name))
        .transpose()?;
    let mut form = authorization.extra_token_params.clone();
    form.insert("grant_type".to_string(), "authorization_code".to_string());
    form.insert("client_id".to_string(), client_id);
    form.insert("code".to_string(), code.to_string());
    form.insert("code_verifier".to_string(), state.verifier);
    form.insert("redirect_uri".to_string(), state.redirect_uri);
    if let Some(client_secret) = client_secret {
        form.insert("client_secret".to_string(), client_secret);
    }

    let headers = Headers::new();
    headers.set("accept", "application/json")?;
    headers.set("content-type", "application/x-www-form-urlencoded")?;
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(JsValue::from_str(&form_urlencoded(&form))));
    let request = Request::new_with_init(&authorization.token_url, &init)?;
    let mut response = Fetch::Request(request).send().await.map_err(|_| {
        Error::RustError("upstream OAuth authorization exchange request failed".to_string())
    })?;
    if !(200..=299).contains(&response.status_code()) {
        return Err(Error::RustError(
            "upstream OAuth authorization exchange was rejected".to_string(),
        ));
    }
    let token = response.json::<OAuthRefreshResponse>().await.map_err(|_| {
        Error::RustError("upstream OAuth authorization response was invalid".to_string())
    })?;
    if token.access_token.trim().is_empty() {
        return Err(Error::RustError(
            "upstream OAuth authorization response was invalid".to_string(),
        ));
    }
    let kind = match authorization.grant_kind.as_str() {
        "oauth" => UpstreamGrantKind::OAuth,
        "subscription" => UpstreamGrantKind::Subscription,
        _ => {
            return Err(Error::RustError(
                "provider OAuth authorization grant kind is invalid".to_string(),
            ));
        }
    };
    let account_id = authorization
        .account_id_json_pointer
        .as_deref()
        .and_then(|pointer| oauth_token_json_pointer_string(&token, pointer));
    let plan = authorization
        .subscription_plan_json_pointer
        .as_deref()
        .and_then(|pointer| oauth_token_json_pointer_string(&token, pointer));
    let scopes = token
        .scope
        .as_deref()
        .map(|scope| {
            scope
                .split_ascii_whitespace()
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_else(|| authorization.scopes.clone());
    let kv = env.kv("POLICY_KV").map_err(|error| {
        Error::RustError(format!(
            "POLICY_KV binding is required for OAuth authorization: {error}"
        ))
    })?;
    let existing = get_upstream_grant(&kv, &state.grant_key).await?;
    let grant = UpstreamGrantRecord {
        version: default_upstream_grant_version(),
        enabled: true,
        kind,
        provider: Some(provider.id.clone()),
        label: existing.as_ref().and_then(|grant| grant.label.clone()),
        credential: None,
        credentials: BTreeMap::new(),
        access_token: Some(token.access_token),
        refresh_token: token.refresh_token,
        token_type: token
            .token_type
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(default_oauth_token_type),
        expires_at: token.expires_in.map(timestamp_after_seconds),
        scopes,
        account_id,
        subscription: (kind == UpstreamGrantKind::Subscription).then_some(
            UpstreamGrantSubscription {
                plan,
                subject: None,
            },
        ),
        refresh: upstream_grant_refresh_from_manifest(provider),
        created_at: None,
        updated_at: None,
        revoked_at: None,
    };
    let grant = normalize_upstream_grant(grant, existing.as_ref()).map_err(Error::RustError)?;
    put_kv_record(&kv, &state.grant_key, &grant, "authorized upstream grant").await
}

fn oauth_authorization_client_id(
    env: &Env,
    authorization: &AuthAuthorizationConfig,
) -> Result<String> {
    if let Some(client_id) = authorization
        .client_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        return Ok(client_id.to_string());
    }
    exact_runtime_config_value(
        env,
        authorization
            .client_id_config
            .as_deref()
            .ok_or_else(|| Error::RustError("OAuth authorization client ID is missing".into()))?,
    )
}

fn oauth_authorization_result_redirect(status: &str, provider: &str) -> Result<Response> {
    redirect_to(&format!(
        "/dashboard/access?resource=upstream&oauth={}&provider={}",
        encode_component(status),
        encode_component(provider)
    ))
}

fn jwt_json_pointer_string(token: &str, pointer: &str) -> Option<String> {
    let (_, payload, _) = split_jwt(token)?;
    let payload = base64_url_decode(payload).ok()?;
    let value = serde_json::from_slice::<Value>(&payload).ok()?;
    value
        .pointer(pointer)?
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn oauth_token_json_pointer_string(token: &OAuthRefreshResponse, pointer: &str) -> Option<String> {
    token
        .id_token
        .as_deref()
        .and_then(|id_token| jwt_json_pointer_string(id_token, pointer))
        .or_else(|| jwt_json_pointer_string(&token.access_token, pointer))
}

async fn list_admin_upstream_grants(kv: &KvStore) -> Result<Vec<AdminUpstreamGrantResponse>> {
    let mut grants = Vec::new();
    let mut cursor = None;
    loop {
        let mut request = kv.list().prefix("oauth/".to_string()).limit(1000);
        if let Some(next_cursor) = cursor.take() {
            request = request.cursor(next_cursor);
        }
        let list = request.execute().await.map_err(|error| {
            Error::RustError(format!("failed to list upstream grants: {error}"))
        })?;
        for key in list.keys {
            let Some(record) = kv.get(&key.name).text().await.map_err(|error| {
                Error::RustError(format!("failed to read upstream grant: {error}"))
            })?
            else {
                continue;
            };
            let grant = parse_upstream_grant_record(&record)?;
            grants.push(admin_upstream_grant_response(&key.name, &grant)?);
        }
        if list.list_complete {
            break;
        }
        let Some(next_cursor) = list.cursor else {
            break;
        };
        cursor = Some(next_cursor);
    }
    grants.sort_by(|a, b| a.key.cmp(&b.key));
    Ok(grants)
}

async fn get_upstream_grant(kv: &KvStore, key: &str) -> Result<Option<UpstreamGrantRecord>> {
    let Some(record) = kv
        .get(key)
        .text()
        .await
        .map_err(|error| Error::RustError(format!("failed to read upstream grant: {error}")))?
    else {
        return Ok(None);
    };
    parse_upstream_grant_record(&record).map(Some)
}

fn normalize_upstream_grant(
    mut grant: UpstreamGrantRecord,
    existing: Option<&UpstreamGrantRecord>,
) -> std::result::Result<UpstreamGrantRecord, String> {
    if let Some(existing) = existing.filter(|record| record.enabled) {
        if existing.kind != grant.kind {
            return Err("revoke an enabled grant before changing its kind".to_string());
        }
        if existing
            .provider
            .as_deref()
            .zip(grant.provider.as_deref())
            .is_some_and(|(current, requested)| current != requested)
        {
            return Err("revoke an enabled grant before changing its provider".to_string());
        }
    }
    grant.version = default_upstream_grant_version();
    grant.provider = normalize_grant_optional_text(grant.provider, "provider", 128)?;
    grant.label = normalize_optional_label(grant.label).map_err(str::to_string)?;
    grant.account_id = normalize_grant_optional_text(grant.account_id, "accountId", 256)?;
    if let Some(subscription) = grant.subscription.as_mut() {
        subscription.plan =
            normalize_grant_optional_text(subscription.plan.take(), "subscription.plan", 128)?;
        subscription.subject = normalize_grant_optional_text(
            subscription.subject.take(),
            "subscription.subject",
            256,
        )?;
    }
    grant.scopes = normalize_grant_scopes(grant.scopes)?;
    grant.token_type = grant.token_type.trim().to_string();
    if grant.token_type.is_empty() || grant.token_type.len() > 32 {
        return Err("tokenType must be 1-32 characters".to_string());
    }
    let provider = if let Some(provider_id) = grant.provider.as_deref() {
        let snapshot = provider_snapshot().map_err(|error| error.to_string())?;
        let provider = snapshot
            .providers
            .iter()
            .find(|candidate| candidate.id == provider_id)
            .cloned()
            .ok_or_else(|| format!("provider `{provider_id}` is not registered"))?;
        Some(provider)
    } else {
        None
    };
    if let Some(expires_at) = grant.expires_at.as_deref() {
        if !js_sys::Date::parse(expires_at).is_finite() {
            return Err("expiresAt must be an ISO-8601 timestamp".to_string());
        }
    }
    merge_upstream_grant_secrets(&mut grant, existing);
    grant.credentials = normalize_grant_credentials(grant.credentials)?;
    validate_upstream_grant_secret_shape(&grant)?;
    if grant.enabled
        && provider
            .as_ref()
            .is_some_and(|provider| !upstream_grant_supports_provider(provider, &grant))
    {
        return Err(
            "upstream grant credentials do not satisfy the provider auth contract".to_string(),
        );
    }
    if grant.refresh.is_none() && grant.refresh_token.is_some() {
        grant.refresh = provider
            .as_ref()
            .and_then(upstream_grant_refresh_from_manifest);
    }
    if let Some(refresh) = grant.refresh.as_ref() {
        validate_upstream_grant_refresh(refresh)?;
        if provider
            .as_ref()
            .is_none_or(|provider| !provider_approves_refresh(provider, refresh))
        {
            return Err("provider manifest does not approve refresh configuration".to_string());
        }
    }
    if grant.enabled && !upstream_grant_has_primary_secret(&grant) {
        return Err(match grant.kind {
            UpstreamGrantKind::ApiKey => {
                "enabled API-key grant requires credential or credentials".to_string()
            }
            UpstreamGrantKind::OAuth | UpstreamGrantKind::Subscription => {
                "enabled OAuth or subscription grant requires accessToken".to_string()
            }
        });
    }
    let now = current_iso_timestamp();
    grant.created_at = existing
        .and_then(|record| record.created_at.clone())
        .or(grant.created_at)
        .or_else(|| Some(now.clone()));
    grant.updated_at = Some(now);
    if grant.enabled {
        grant.revoked_at = None;
    } else {
        revoke_upstream_grant(&mut grant);
    }
    Ok(grant)
}

fn validate_upstream_grant_secret_shape(
    grant: &UpstreamGrantRecord,
) -> std::result::Result<(), String> {
    match grant.kind {
        UpstreamGrantKind::ApiKey => {
            if grant.access_token.is_some() || grant.refresh_token.is_some() {
                return Err(
                    "API-key grants accept credential or credentials only; revoke before changing grant kind".to_string(),
                );
            }
        }
        UpstreamGrantKind::OAuth => {
            if grant.credential.is_some() || !grant.credentials.is_empty() {
                return Err(
                    "OAuth grants accept accessToken only; revoke before changing grant kind"
                        .to_string(),
                );
            }
        }
        UpstreamGrantKind::Subscription => {
            if !grant.credentials.is_empty()
                || grant.credential.is_some() && grant.access_token.is_some()
            {
                return Err("subscription grants accept exactly one primary credential".to_string());
            }
        }
    }
    Ok(())
}

fn normalize_grant_credentials(
    credentials: BTreeMap<String, String>,
) -> std::result::Result<BTreeMap<String, String>, String> {
    let mut normalized = BTreeMap::new();
    for (name, value) in credentials {
        let name = name.trim();
        if name.is_empty()
            || name.len() > 128
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
        {
            return Err("credentials contains an invalid field name".to_string());
        }
        if value.is_empty() || value.len() > 16_384 || value.bytes().any(|byte| byte == 0) {
            return Err("credentials contains an invalid secret value".to_string());
        }
        normalized.insert(name.to_string(), value);
    }
    Ok(normalized)
}

fn normalize_grant_optional_text(
    value: Option<String>,
    field: &str,
    max_len: usize,
) -> std::result::Result<Option<String>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    if value.len() > max_len || value.bytes().any(|byte| byte.is_ascii_control()) {
        return Err(format!(
            "{field} must be {max_len} or fewer characters without control characters"
        ));
    }
    Ok(Some(value.to_string()))
}

fn normalize_grant_scopes(scopes: Vec<String>) -> std::result::Result<Vec<String>, String> {
    let mut normalized = Vec::new();
    for scope in scopes {
        let Some(scope) = normalize_grant_optional_text(Some(scope), "scope", 256)? else {
            continue;
        };
        if !normalized.iter().any(|value| value == &scope) {
            normalized.push(scope);
        }
    }
    normalized.sort();
    Ok(normalized)
}

fn validate_upstream_grant_refresh(
    refresh: &UpstreamGrantRefresh,
) -> std::result::Result<(), String> {
    if !refresh.token_url.starts_with("https://")
        || refresh.token_url.contains('@')
        || refresh.token_url.contains('#')
    {
        return Err("refresh.tokenUrl must be a trusted HTTPS URL".to_string());
    }
    if refresh
        .client_id
        .as_deref()
        .is_none_or(|value| value.trim().is_empty())
        && refresh.client_id_config.is_none()
    {
        return Err("refresh requires clientId or clientIdConfig".to_string());
    }
    if let Some(value) = refresh.client_id.as_deref() {
        if value.len() > 256 || value.bytes().any(|byte| byte.is_ascii_control()) {
            return Err("refresh.clientId is invalid".to_string());
        }
    }
    if let Some(value) = refresh.client_id_config.as_deref() {
        validate_runtime_config_name(value, "refresh.clientIdConfig")?;
    }
    if let Some(value) = refresh.client_secret_config.as_deref() {
        validate_runtime_config_name(value, "refresh.clientSecretConfig")?;
    }
    for (name, value) in &refresh.extra_params {
        if name.is_empty()
            || name.len() > 128
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
            || value.len() > 1024
            || value.bytes().any(|byte| byte.is_ascii_control())
        {
            return Err("refresh.extraParams contains an invalid entry".to_string());
        }
    }
    Ok(())
}

fn validate_runtime_config_name(value: &str, field: &str) -> std::result::Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
    {
        return Err(format!("{field} must be an uppercase runtime binding name"));
    }
    Ok(())
}

fn merge_upstream_grant_secrets(
    grant: &mut UpstreamGrantRecord,
    existing: Option<&UpstreamGrantRecord>,
) {
    let Some(existing) = existing else {
        return;
    };
    if grant.credential.is_none() {
        grant.credential.clone_from(&existing.credential);
    }
    if grant.credentials.is_empty() {
        grant.credentials.clone_from(&existing.credentials);
    }
    if grant.access_token.is_none() {
        grant.access_token.clone_from(&existing.access_token);
    }
    if grant.refresh_token.is_none() {
        grant.refresh_token.clone_from(&existing.refresh_token);
    }
}

fn revoke_upstream_grant(grant: &mut UpstreamGrantRecord) {
    let now = current_iso_timestamp();
    grant.enabled = false;
    grant.credential = None;
    grant.credentials.clear();
    grant.access_token = None;
    grant.refresh_token = None;
    grant.updated_at = Some(now.clone());
    grant.revoked_at = Some(now);
}

fn current_iso_timestamp() -> String {
    js_sys::Date::new_0().to_iso_string().into()
}

fn admin_upstream_grant_response(
    key: &str,
    grant: &UpstreamGrantRecord,
) -> Result<AdminUpstreamGrantResponse> {
    let (scope, scope_id, token_ref) = parse_upstream_grant_key(key)?;
    Ok(AdminUpstreamGrantResponse {
        key: key.to_string(),
        scope,
        scope_id,
        token_ref,
        version: grant.version,
        enabled: grant.enabled,
        kind: grant.kind,
        provider: grant.provider.clone(),
        label: grant.label.clone(),
        token_type: grant.token_type.clone(),
        expires_at: grant.expires_at.clone(),
        scopes: grant.scopes.clone(),
        account_id: grant.account_id.clone(),
        subscription: grant.subscription.clone(),
        created_at: grant.created_at.clone(),
        updated_at: grant.updated_at.clone(),
        revoked_at: grant.revoked_at.clone(),
        has_credential: grant
            .credential
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty()),
        credential_fields: grant.credentials.keys().cloned().collect(),
        has_access_token: grant
            .access_token
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty()),
        has_refresh_token: grant
            .refresh_token
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty()),
        refresh_configured: grant.refresh.is_some(),
        refresh_token_url: grant
            .refresh
            .as_ref()
            .map(|refresh| refresh.token_url.clone()),
        client_id_config: grant
            .refresh
            .as_ref()
            .and_then(|refresh| refresh.client_id_config.clone()),
        client_secret_config: grant
            .refresh
            .as_ref()
            .and_then(|refresh| refresh.client_secret_config.clone()),
        usable: upstream_grant_usable_by_declared_provider(grant),
    })
}

fn parse_upstream_grant_key(key: &str) -> Result<(String, String, String)> {
    let Some(rest) = key.strip_prefix("oauth/") else {
        return Err(Error::RustError(
            "upstream grant key has invalid prefix".to_string(),
        ));
    };
    let (scope, scope_id, token_ref) = if let Some(rest) = rest.strip_prefix("tenants/") {
        let Some((scope_id, token_ref)) = rest.split_once('/') else {
            return Err(Error::RustError(
                "tenant upstream grant key is invalid".to_string(),
            ));
        };
        ("tenants", scope_id, token_ref)
    } else {
        let Some((scope_id, token_ref)) = rest.split_once('/') else {
            return Err(Error::RustError(
                "policy upstream grant key is invalid".to_string(),
            ));
        };
        ("policies", scope_id, token_ref)
    };
    Ok((
        scope.to_string(),
        scope_id.to_string(),
        token_ref.to_string(),
    ))
}

fn upstream_grant_secret(grant: &UpstreamGrantRecord) -> Option<&str> {
    let preferred = match grant.kind {
        UpstreamGrantKind::ApiKey => grant.credential.as_deref(),
        UpstreamGrantKind::OAuth => grant.access_token.as_deref(),
        UpstreamGrantKind::Subscription => grant
            .access_token
            .as_deref()
            .or(grant.credential.as_deref()),
    };
    preferred.filter(|value| !value.trim().is_empty())
}

fn upstream_grant_has_primary_secret(grant: &UpstreamGrantRecord) -> bool {
    upstream_grant_secret(grant).is_some() || !grant.credentials.is_empty()
}

fn upstream_grant_expired(grant: &UpstreamGrantRecord) -> bool {
    grant
        .expires_at
        .as_deref()
        .map(js_sys::Date::parse)
        .is_some_and(|expires_at| expires_at.is_finite() && expires_at <= js_sys::Date::now())
}

fn upstream_grant_needs_refresh(grant: &UpstreamGrantRecord) -> bool {
    grant
        .expires_at
        .as_deref()
        .map(js_sys::Date::parse)
        .is_some_and(|expires_at| {
            expires_at.is_finite()
                && expires_at <= js_sys::Date::now() + UPSTREAM_GRANT_REFRESH_WINDOW_MS
        })
}

fn upstream_grant_refreshable(grant: &UpstreamGrantRecord) -> bool {
    matches!(
        grant.kind,
        UpstreamGrantKind::OAuth | UpstreamGrantKind::Subscription
    ) && grant
        .refresh_token
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty())
        && grant.refresh.is_some()
}

fn upstream_grant_usable(grant: &UpstreamGrantRecord) -> bool {
    grant.enabled
        && upstream_grant_has_primary_secret(grant)
        && (!upstream_grant_expired(grant) || upstream_grant_refreshable(grant))
}

fn upstream_grant_usable_by_declared_provider(grant: &UpstreamGrantRecord) -> bool {
    let usable = upstream_grant_usable(grant);
    if !usable || grant.credentials.is_empty() {
        return usable;
    }
    let Some(provider_id) = grant.provider.as_deref() else {
        return false;
    };
    provider_snapshot()
        .ok()
        .and_then(|snapshot| {
            snapshot
                .providers
                .into_iter()
                .find(|provider| provider.id == provider_id)
        })
        .is_some_and(|provider| upstream_grant_supports_provider(&provider, grant))
}

fn upstream_grant_credential_field<'a>(
    grant: &'a UpstreamGrantRecord,
    field: &str,
) -> Option<&'a str> {
    grant
        .credentials
        .get(field)
        .map(String::as_str)
        .filter(|value| !value.is_empty())
}

fn upstream_grant_supports_provider(
    provider: &CompiledProvider,
    grant: &UpstreamGrantRecord,
) -> bool {
    match provider.auth.schemes.first() {
        Some(AuthScheme::SigV4 { .. }) => {
            upstream_grant_credential_field(grant, "accessKeyId").is_some()
                && upstream_grant_credential_field(grant, "secretAccessKey").is_some()
        }
        _ => grant.credentials.is_empty(),
    }
}

fn provider_readiness_rows(
    snapshot: &ProviderSnapshot,
    env: &Env,
    grants: &[OAuthGrantRecord],
    connections: &[ProviderConnectionRecord],
    health: &BTreeMap<String, ProviderHealthRecord>,
) -> Vec<ProviderReadinessRow> {
    snapshot
        .providers
        .iter()
        .map(|provider| {
            provider_readiness_row(
                provider,
                env,
                grants,
                provider_connection_enabled(connections, &provider.id),
                health.get(&provider.id),
            )
        })
        .collect()
}

fn provider_readiness_row(
    provider: &CompiledProvider,
    env: &Env,
    grants: &[OAuthGrantRecord],
    connection_enabled: bool,
    health: Option<&ProviderHealthRecord>,
) -> ProviderReadinessRow {
    let optional_config = provider_optional_config_keys(provider);
    let required_config = provider
        .config_keys
        .iter()
        .filter(|key| !optional_config.iter().any(|optional| optional == *key))
        .cloned()
        .collect::<Vec<_>>();
    let upstream_grant_count = provider_upstream_grant_count(provider, grants);
    let auth_secret_config = provider_auth_secret_config_keys(provider);
    let routable_endpoints = provider
        .endpoints
        .iter()
        .filter(|endpoint| supports_manifest_proxy(provider, endpoint))
        .collect::<Vec<_>>();
    let missing_config = required_config
        .iter()
        .filter(|key| {
            let covered_by_grants = auth_secret_config.contains(*key)
                && !routable_endpoints.is_empty()
                && routable_endpoints.iter().all(|endpoint| {
                    provider_endpoint_has_upstream_grant(provider, endpoint, grants)
                });
            !runtime_binding_present(env, key) && !covered_by_grants
        })
        .cloned()
        .collect::<Vec<_>>();
    let config_present = missing_config.is_empty();
    let oauth_grant_required = provider_requires_oauth(provider);
    let oauth_grant_count = if oauth_grant_required {
        upstream_grant_count
    } else {
        0
    };
    let openai_compatible = supports_openai_compatible_proxy(provider);
    let manifest_routes = routable_endpoints.len();
    let has_route = openai_compatible || manifest_routes > 0;
    let executable_endpoints = routable_endpoints
        .iter()
        .filter(|endpoint| {
            provider_endpoint_executable(
                provider,
                endpoint,
                env,
                grants,
                &required_config,
                &auth_secret_config,
                connection_enabled,
            )
        })
        .map(|endpoint| endpoint.id.clone())
        .collect::<Vec<_>>();
    let executable = !executable_endpoints.is_empty();
    let health_fresh = health.is_some_and(provider_health_is_fresh);
    let verified = health_fresh && health.is_some_and(|health| health.status == "verified");
    let health_failed = health.is_some_and(|health| health.status == "failed");
    let health_stale = health.is_some() && !health_fresh;
    let mut reasons = Vec::new();
    if !connection_enabled {
        reasons.push("provider connection disabled".to_string());
    }
    if !has_route {
        reasons.push("no executable edge route".to_string());
    }
    if !missing_config.is_empty() {
        reasons.push(format!("missing {}", missing_config.join(", ")));
    }
    if oauth_grant_required && oauth_grant_count == 0 {
        reasons.push("OAuth grant required".to_string());
    }
    if health_failed {
        reasons.push("last live check failed".to_string());
    }
    if health_stale {
        reasons.push("live check is stale".to_string());
    }
    let status = if !connection_enabled {
        "disabled"
    } else if executable && verified {
        "verified"
    } else if executable && health_stale {
        "stale"
    } else if executable && health_failed {
        "failed"
    } else if executable {
        "unverified"
    } else if !missing_config.is_empty() {
        "missing_config"
    } else if oauth_grant_required && oauth_grant_count == 0 {
        "grant_required"
    } else if has_route {
        "declared"
    } else {
        "unsupported"
    };

    ProviderReadinessRow {
        id: provider.id.clone(),
        display_name: provider.display_name.clone(),
        class: enum_label(&provider.class),
        service_kind: enum_label(&provider.service_kind),
        required_config,
        optional_config,
        missing_config,
        config_present,
        connection_enabled,
        oauth_grant_required,
        oauth_grant_count,
        upstream_grant_count,
        openai_compatible,
        manifest_routes,
        executable_endpoints,
        model_count: provider.models.len(),
        executable,
        verified,
        last_checked_at: health.map(|health| health.checked_at.clone()),
        latency_ms: health.and_then(|health| health.latency_ms),
        status: status.to_string(),
        reasons,
    }
}

fn provider_endpoint_executable(
    provider: &CompiledProvider,
    endpoint: &CompiledEndpoint,
    env: &Env,
    grants: &[OAuthGrantRecord],
    required_config: &[String],
    auth_secret_config: &BTreeSet<String>,
    connection_enabled: bool,
) -> bool {
    if !connection_enabled || !supports_manifest_proxy(provider, endpoint) {
        return false;
    }
    let has_grant = provider_endpoint_has_upstream_grant(provider, endpoint, grants);
    required_config.iter().all(|key| {
        runtime_binding_present(env, key) || (auth_secret_config.contains(key) && has_grant)
    }) && (!provider_requires_oauth(provider) || has_grant)
}

fn provider_health_is_fresh(health: &ProviderHealthRecord) -> bool {
    let checked_at = js_sys::Date::parse(&health.checked_at);
    let now = js_sys::Date::now();
    checked_at.is_finite() && checked_at <= now && now - checked_at <= PROVIDER_HEALTH_MAX_AGE_MS
}

fn provider_connection_enabled(
    connections: &[ProviderConnectionRecord],
    provider_id: &str,
) -> bool {
    connections
        .iter()
        .find(|connection| connection.provider_id == provider_id)
        .is_none_or(|connection| connection.enabled)
}

fn provider_optional_config_keys(provider: &CompiledProvider) -> Vec<String> {
    let optional_auth_config = provider
        .auth
        .schemes
        .iter()
        .filter_map(|scheme| match scheme {
            AuthScheme::Bearer {
                secret_kind,
                required: false,
                ..
            } => Some(secret_kind.as_str()),
            _ => None,
        })
        .flat_map(|secret_kind| secret_binding_candidates(provider, secret_kind))
        .collect::<BTreeSet<_>>();

    provider
        .config_keys
        .iter()
        .filter(|key| {
            matches!(
                key.as_str(),
                "AWS_SESSION_TOKEN"
                    | "AZURE_OPENAI_COMPLETION_TOKEN_DEPLOYMENTS"
                    | "AZURE_OPENAI_DEPLOYMENT"
            ) || optional_auth_config.contains(*key)
        })
        .cloned()
        .collect()
}

fn entitlement_oauth_grants(
    grants: &[OAuthGrantRecord],
    entries: &[&AccessPolicyEntry],
) -> Vec<OAuthGrantRecord> {
    grants
        .iter()
        .filter(|grant| {
            entries
                .iter()
                .any(|entry| oauth_grant_applies_to_policy_entry(grant, entry))
        })
        .cloned()
        .collect()
}

fn oauth_grant_applies_to_policy_entry(
    grant: &OAuthGrantRecord,
    entry: &AccessPolicyEntry,
) -> bool {
    if grant
        .key
        .starts_with(&format!("oauth/{}/", entry.policy_id))
    {
        return true;
    }
    let tenant = entry.policy.tenant_id.as_deref().unwrap_or("default");
    grant.key.starts_with(&format!("oauth/tenants/{tenant}/"))
}

fn provider_requires_oauth(provider: &CompiledProvider) -> bool {
    provider
        .auth
        .schemes
        .iter()
        .any(|scheme| matches!(scheme, AuthScheme::OAuth { .. }))
}

fn select_access_policy_for_provider<'a>(
    provider: Option<&CompiledProvider>,
    entries: &'a [&'a AccessPolicyEntry],
    grants: &[OAuthGrantRecord],
) -> Option<&'a AccessPolicyEntry> {
    let first_entry = entries.first().copied()?;
    if let Some(grant_entry) = provider.and_then(|provider| {
        entries.iter().copied().find(|entry| {
            let scoped_grants = entitlement_oauth_grants(grants, &[*entry]);
            provider_upstream_grant_count(provider, &scoped_grants) > 0
        })
    }) {
        return Some(grant_entry);
    }
    Some(first_entry)
}

fn runtime_binding_present(env: &Env, name: &str) -> bool {
    if let Ok(var) = env.var(name) {
        if !var.to_string().trim().is_empty() {
            return true;
        }
    }
    if let Ok(secret) = env.secret(name) {
        if !secret.to_string().trim().is_empty() {
            return true;
        }
    }
    false
}

fn provider_upstream_grant_count(
    provider: &CompiledProvider,
    grants: &[OAuthGrantRecord],
) -> usize {
    grants
        .iter()
        .filter(|grant| provider_upstream_grant_matches(provider, grant))
        .count()
}

fn provider_endpoint_has_upstream_grant(
    provider: &CompiledProvider,
    endpoint: &CompiledEndpoint,
    grants: &[OAuthGrantRecord],
) -> bool {
    grants.iter().any(|grant| {
        provider_upstream_grant_matches(provider, grant)
            && grant_kind_supports_endpoint(provider, endpoint, grant.kind)
    })
}

fn grant_kind_supports_endpoint(
    provider: &CompiledProvider,
    endpoint: &CompiledEndpoint,
    kind: UpstreamGrantKind,
) -> bool {
    provider
        .auth
        .grant_transports
        .get(&enum_label(&kind))
        .is_none_or(|transport| transport.endpoint_paths.contains_key(&endpoint.id))
}

fn provider_upstream_grant_matches(provider: &CompiledProvider, grant: &OAuthGrantRecord) -> bool {
    grant.enabled
        && grant.usable
        && grant
            .provider
            .as_deref()
            .is_none_or(|grant_provider| grant_provider == provider.id)
        && provider_upstream_grant_refs(provider)
            .iter()
            .any(|token_ref| grant.key.ends_with(token_ref))
}

fn provider_upstream_grant_refs(provider: &CompiledProvider) -> Vec<String> {
    let mut refs = Vec::new();
    for scheme in &provider.auth.schemes {
        if let AuthScheme::OAuth {
            provider: oauth_provider,
            token_ref,
            ..
        } = scheme
        {
            if let Some(token_ref) = token_ref.as_deref().filter(|value| !value.is_empty()) {
                refs.push(format!("/{token_ref}"));
            }
            if let Some(oauth_provider) =
                oauth_provider.as_deref().filter(|value| !value.is_empty())
            {
                refs.push(format!("/{oauth_provider}"));
            }
        }
    }
    refs.push(format!("/{}", provider.id));
    dedupe_preserving_order(&mut refs);
    refs
}

fn provider_auth_secret_config_keys(provider: &CompiledProvider) -> BTreeSet<String> {
    provider
        .auth
        .schemes
        .iter()
        .flat_map(|scheme| match scheme {
            AuthScheme::Bearer { secret_kind, .. }
            | AuthScheme::ApiKey { secret_kind, .. }
            | AuthScheme::QueryApiKey { secret_kind, .. } => Some(secret_kind),
            AuthScheme::SigV4 { .. } => None,
            _ => None,
        })
        .flat_map(|secret_kind| secret_binding_candidates(provider, secret_kind))
        .chain(
            provider
                .auth
                .schemes
                .iter()
                .filter(|scheme| matches!(scheme, AuthScheme::SigV4 { .. }))
                .flat_map(|_| {
                    ["access_key_id", "secret_access_key"]
                        .into_iter()
                        .flat_map(|name| template_binding_candidates(provider, name))
                }),
        )
        .collect()
}

fn enum_label<T: Serialize>(value: &T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_else(|| "unknown".to_string())
}

#[derive(Debug)]
enum AssignmentReconcileError {
    Client(String),
    Runtime(Error),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AssignmentMatch {
    Match,
    NoMatch,
    Unknown,
}

fn default_assignment_rule_version() -> u8 {
    1
}

fn validate_assignment_rule_id(value: &str) -> std::result::Result<String, &'static str> {
    if value.len() < 4
        || value.len() > 48
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
    {
        return Err("assignment rule id must use 4-48 lowercase letters, numbers, or underscores");
    }
    Ok(value.to_string())
}

fn assignment_rule_key(rule_id: &str) -> String {
    format!("access/assignment-rules/{rule_id}")
}

fn assignment_state_key(email: &str) -> String {
    format!("access/assignment-state/{email}")
}

fn assignment_rule_group(rule_id: &str) -> String {
    format!("assignment.{rule_id}")
}

fn normalize_assignment_domain(value: &str) -> std::result::Result<String, String> {
    let domain = value.trim().trim_start_matches('@').to_ascii_lowercase();
    if domain.is_empty()
        || domain.len() > 253
        || !domain.contains('.')
        || domain.starts_with('.')
        || domain.ends_with('.')
        || domain.contains("..")
        || !domain
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
    {
        return Err("email-domain subjects must be a valid lowercase domain".to_string());
    }
    Ok(domain)
}

fn normalize_github_subject(value: &str, team: bool) -> std::result::Result<String, String> {
    let value = value.trim().trim_matches('/').to_ascii_lowercase();
    let valid_segment = |segment: &str| {
        !segment.is_empty()
            && segment.len() <= 100
            && segment
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    };
    if team {
        let Some((org, team)) = value.split_once('/') else {
            return Err("GitHub team subjects must use org/team".to_string());
        };
        if value.matches('/').count() != 1 || !valid_segment(org) || !valid_segment(team) {
            return Err("GitHub team subjects must use a valid org/team slug".to_string());
        }
    } else if value.contains('/') || !valid_segment(&value) {
        return Err("GitHub organization subjects must use a valid organization slug".to_string());
    }
    Ok(value)
}

fn normalize_assignment_rule(
    rule_id: &str,
    mut rule: AssignmentRuleRecord,
    existing: Option<&AssignmentRuleRecord>,
) -> std::result::Result<AssignmentRuleRecord, String> {
    validate_assignment_rule_id(rule_id).map_err(str::to_string)?;
    rule.version = default_assignment_rule_version();
    rule.subject = match rule.kind {
        AssignmentRuleKind::ExactEmail => {
            normalize_access_email(&rule.subject).map_err(str::to_string)?
        }
        AssignmentRuleKind::EmailDomain => normalize_assignment_domain(&rule.subject)?,
        AssignmentRuleKind::GithubOrg => normalize_github_subject(&rule.subject, false)?,
        AssignmentRuleKind::GithubTeam => normalize_github_subject(&rule.subject, true)?,
    };
    rule.groups = normalize_access_groups(rule.groups)?;
    let mut policy_ids = BTreeSet::new();
    for policy_id in rule.policy_ids {
        policy_ids.insert(validate_admin_kid(policy_id.trim()).map_err(str::to_string)?);
    }
    if policy_ids.len() > 64 {
        return Err("an assignment rule can grant at most 64 policies".to_string());
    }
    rule.policy_ids = policy_ids.into_iter().collect();
    rule.provenance = rule.provenance.trim().to_string();
    if rule.provenance.is_empty()
        || rule.provenance.len() > 256
        || rule.provenance.bytes().any(|byte| byte.is_ascii_control())
    {
        return Err("assignment rule provenance must be 1-256 visible characters".to_string());
    }
    let now = current_iso_timestamp();
    rule.created_at = existing
        .and_then(|record| record.created_at.clone())
        .or(rule.created_at)
        .or_else(|| Some(now.clone()));
    rule.updated_at = Some(now);
    Ok(rule)
}

fn admin_assignment_rule_response(
    rule_id: &str,
    rule: AssignmentRuleRecord,
) -> AdminAssignmentRuleResponse {
    AdminAssignmentRuleResponse {
        rule_id: rule_id.to_string(),
        rule,
        generated_group: assignment_rule_group(rule_id),
    }
}

async fn get_assignment_rule(kv: &KvStore, rule_id: &str) -> Result<Option<AssignmentRuleRecord>> {
    let Some(record) = kv
        .get(&assignment_rule_key(rule_id))
        .text()
        .await
        .map_err(|error| Error::RustError(format!("failed to read assignment rule: {error}")))?
    else {
        return Ok(None);
    };
    serde_json::from_str(&record)
        .map(Some)
        .map_err(|error| Error::RustError(format!("assignment rule is invalid JSON: {error}")))
}

async fn list_assignment_rules(kv: &KvStore) -> Result<BTreeMap<String, AssignmentRuleRecord>> {
    let mut rules = BTreeMap::new();
    let mut cursor = None;
    loop {
        let mut request = kv
            .list()
            .prefix("access/assignment-rules/".to_string())
            .limit(1000);
        if let Some(next_cursor) = cursor.take() {
            request = request.cursor(next_cursor);
        }
        let list = request.execute().await.map_err(|error| {
            Error::RustError(format!("failed to list assignment rules: {error}"))
        })?;
        for key in list.keys {
            let Some(rule_id) = key.name.strip_prefix("access/assignment-rules/") else {
                continue;
            };
            validate_assignment_rule_id(rule_id).map_err(str::to_string)?;
            let Some(record) = kv.get(&key.name).text().await.map_err(|error| {
                Error::RustError(format!("failed to read assignment rule: {error}"))
            })?
            else {
                continue;
            };
            let rule = serde_json::from_str::<AssignmentRuleRecord>(&record).map_err(|error| {
                Error::RustError(format!("assignment rule is invalid JSON: {error}"))
            })?;
            rules.insert(rule_id.to_string(), rule);
        }
        if list.list_complete {
            break;
        }
        let Some(next_cursor) = list.cursor else {
            break;
        };
        cursor = Some(next_cursor);
    }
    Ok(rules)
}

fn normalize_assignment_evidence(
    mut evidence: AssignmentEvidence,
) -> std::result::Result<AssignmentEvidence, String> {
    evidence.source = evidence.source.trim().to_ascii_lowercase();
    if evidence.source != "github" || !evidence.verified {
        return Err("GitHub assignment evidence must be explicitly verified".to_string());
    }
    evidence.github_orgs = evidence
        .github_orgs
        .into_iter()
        .map(|value| normalize_github_subject(&value, false))
        .collect::<std::result::Result<BTreeSet<_>, _>>()?
        .into_iter()
        .collect();
    evidence.github_teams = evidence
        .github_teams
        .into_iter()
        .map(|value| normalize_github_subject(&value, true))
        .collect::<std::result::Result<BTreeSet<_>, _>>()?
        .into_iter()
        .collect();
    Ok(evidence)
}

fn assignment_rule_match(
    rule: &AssignmentRuleRecord,
    email: &str,
    evidence: Option<&AssignmentEvidence>,
) -> AssignmentMatch {
    if !rule.enabled {
        return AssignmentMatch::NoMatch;
    }
    match rule.kind {
        AssignmentRuleKind::ExactEmail => {
            if rule.subject == email {
                AssignmentMatch::Match
            } else {
                AssignmentMatch::NoMatch
            }
        }
        AssignmentRuleKind::EmailDomain => {
            if email
                .split_once('@')
                .is_some_and(|(_, domain)| domain == rule.subject)
            {
                AssignmentMatch::Match
            } else {
                AssignmentMatch::NoMatch
            }
        }
        AssignmentRuleKind::GithubOrg => match evidence {
            Some(evidence) if evidence.github_orgs.contains(&rule.subject) => {
                AssignmentMatch::Match
            }
            Some(_) => AssignmentMatch::NoMatch,
            None => AssignmentMatch::Unknown,
        },
        AssignmentRuleKind::GithubTeam => match evidence {
            Some(evidence) if evidence.github_teams.contains(&rule.subject) => {
                AssignmentMatch::Match
            }
            Some(_) => AssignmentMatch::NoMatch,
            None => AssignmentMatch::Unknown,
        },
    }
}

fn assignment_entry_for_rule(rule_id: &str, rule: &AssignmentRuleRecord) -> AssignmentStateEntry {
    let mut groups = rule.groups.clone();
    if !rule.policy_ids.is_empty() {
        groups.push(assignment_rule_group(rule_id));
    }
    groups.sort();
    groups.dedup();
    AssignmentStateEntry {
        groups,
        revoke_on_loss: rule.revoke_on_loss,
    }
}

fn reconcile_assignment_state(
    email: &str,
    rules: &BTreeMap<String, AssignmentRuleRecord>,
    evidence: Option<&AssignmentEvidence>,
    previous: AssignmentStateRecord,
) -> (AssignmentStateRecord, Vec<String>, Vec<String>) {
    reconcile_assignment_state_at(email, rules, evidence, previous, current_iso_timestamp())
}

fn reconcile_assignment_state_at(
    email: &str,
    rules: &BTreeMap<String, AssignmentRuleRecord>,
    evidence: Option<&AssignmentEvidence>,
    previous: AssignmentStateRecord,
    updated_at: String,
) -> (AssignmentStateRecord, Vec<String>, Vec<String>) {
    let mut assignments = BTreeMap::new();
    let mut matched = Vec::new();
    let mut retained = Vec::new();
    for (rule_id, rule) in rules {
        match assignment_rule_match(rule, email, evidence) {
            AssignmentMatch::Match => {
                assignments.insert(rule_id.clone(), assignment_entry_for_rule(rule_id, rule));
                matched.push(rule_id.clone());
            }
            AssignmentMatch::Unknown => {
                if let Some(entry) = previous.assignments.get(rule_id) {
                    assignments.insert(rule_id.clone(), entry.clone());
                    retained.push(rule_id.clone());
                }
            }
            AssignmentMatch::NoMatch if rule.enabled && !rule.revoke_on_loss => {
                if let Some(entry) = previous.assignments.get(rule_id) {
                    assignments.insert(rule_id.clone(), entry.clone());
                    retained.push(rule_id.clone());
                }
            }
            AssignmentMatch::NoMatch => {}
        }
    }
    (
        AssignmentStateRecord {
            version: default_assignment_rule_version(),
            assignments,
            updated_at: Some(updated_at),
        },
        matched,
        retained,
    )
}

async fn get_assignment_state(kv: &KvStore, email: &str) -> Result<AssignmentStateRecord> {
    let Some(record) = kv
        .get(&assignment_state_key(email))
        .text()
        .await
        .map_err(|error| Error::RustError(format!("failed to read assignment state: {error}")))?
    else {
        return Ok(AssignmentStateRecord::default());
    };
    serde_json::from_str(&record)
        .map_err(|error| Error::RustError(format!("assignment state is invalid JSON: {error}")))
}

fn assignment_state_groups(state: &AssignmentStateRecord) -> BTreeSet<String> {
    state
        .assignments
        .values()
        .flat_map(|entry| entry.groups.iter().cloned())
        .collect()
}

async fn reconcile_access_user_assignments(
    env: &Env,
    kv: &KvStore,
    email: &str,
    mut record: AccessUserRecord,
    evidence: Option<&AssignmentEvidence>,
) -> Result<(AccessUserRecord, AssignmentReconcileResult)> {
    let email = normalize_access_email(email).map_err(str::to_string)?;
    let rules = list_assignment_rules(kv).await?;
    let previous = get_assignment_state(kv, &email).await?;
    let previous_groups = assignment_state_groups(&previous);
    let (state, matched_rule_ids, retained_rule_ids) =
        reconcile_assignment_state(&email, &rules, evidence, previous);
    let managed_groups = assignment_state_groups(&state);
    let mut groups = record
        .groups
        .into_iter()
        .filter(|group| !previous_groups.contains(group))
        .collect::<BTreeSet<_>>();
    groups.extend(managed_groups);
    record.groups = normalize_access_groups(groups.into_iter().collect())?;
    // Access admins are derived from the runtime allowlist, never from a persisted user role.
    record.role = AccessRole::User;
    let namespace = access_control_namespace(env)?;
    let user = AccessControlUser {
        email: email.clone(),
        record: record.clone(),
    };
    put_access_control_user(&namespace, &user).await?;
    sync_kv_record_best_effort(
        kv,
        &format!("access/users/{email}"),
        &record,
        "access user compatibility record",
    )
    .await;
    put_kv_record(
        kv,
        &assignment_state_key(&email),
        &state,
        "assignment state",
    )
    .await?;
    let result = AssignmentReconcileResult {
        email,
        matched_rule_ids,
        retained_rule_ids,
        groups: record.groups.clone(),
    };
    Ok((record, result))
}

async fn reconcile_assignment_request(
    env: &Env,
    kv: &KvStore,
    request: AssignmentReconcileRequest,
) -> std::result::Result<Vec<AssignmentReconcileResult>, AssignmentReconcileError> {
    if request.all && request.email.is_some() {
        return Err(AssignmentReconcileError::Client(
            "use either email or all, not both".to_string(),
        ));
    }
    if request.all && request.evidence.is_some() {
        return Err(AssignmentReconcileError::Client(
            "verified GitHub evidence can reconcile only one email".to_string(),
        ));
    }
    let evidence = request
        .evidence
        .map(normalize_assignment_evidence)
        .transpose()
        .map_err(AssignmentReconcileError::Client)?;
    let emails = if request.all {
        list_admin_access_users(env, kv)
            .await
            .map_err(AssignmentReconcileError::Runtime)?
            .into_iter()
            .map(|user| user.email)
            .collect::<Vec<_>>()
    } else {
        vec![
            normalize_access_email(request.email.as_deref().unwrap_or_default())
                .map_err(|message| AssignmentReconcileError::Client(message.to_string()))?,
        ]
    };
    let mut results = Vec::new();
    for email in emails {
        let record = access_control_user_record(env, &email, &default_access_tenant(env))
            .await
            .map_err(AssignmentReconcileError::Runtime)?;
        let (_, result) =
            reconcile_access_user_assignments(env, kv, &email, record, evidence.as_ref())
                .await
                .map_err(AssignmentReconcileError::Runtime)?;
        results.push(result);
    }
    Ok(results)
}

async fn sync_assignment_rule_bindings(
    env: &Env,
    kv: &KvStore,
    rule_id: &str,
    existing: Option<&AssignmentRuleRecord>,
    rule: &AssignmentRuleRecord,
) -> Result<()> {
    let policy_ids = existing
        .into_iter()
        .flat_map(|record| record.policy_ids.iter().cloned())
        .chain(rule.policy_ids.iter().cloned())
        .collect::<BTreeSet<_>>();
    for policy_id in policy_ids.iter() {
        let binding = normalize_policy_binding(PolicyBindingRecord {
            policy_id: policy_id.clone(),
            principal_type: PrincipalType::Group,
            principal_id: assignment_rule_group(rule_id),
            enabled: rule.enabled && rule.policy_ids.contains(policy_id),
            priority: rule.priority,
        })
        .map_err(str::to_string)?;
        put_policy_binding_record(env, kv, &binding).await?;
    }
    Ok(())
}

async fn list_admin_access_users(env: &Env, kv: &KvStore) -> Result<Vec<AdminAccessUserResponse>> {
    let namespace = access_control_namespace(env)?;
    let mut response = list_access_control_users(&namespace).await?;
    if !response.initialized {
        let legacy_users = list_access_users_from_kv(kv).await?;
        initialize_all_access_control_users(&namespace, &legacy_users).await?;
        response = list_access_control_users(&namespace).await?;
    }
    let mut users = response
        .users
        .into_iter()
        .map(|user| access_user_response(&user.email, user.record, env))
        .collect::<Result<Vec<_>>>()?;
    users.sort_by(|a, b| a.email.cmp(&b.email));
    Ok(users)
}

async fn list_access_users_from_kv(kv: &KvStore) -> Result<Vec<AccessControlUser>> {
    let mut users = Vec::new();
    let mut cursor = None;
    loop {
        let mut request = kv.list().prefix("access/users/".to_string()).limit(1000);
        if let Some(next_cursor) = cursor.take() {
            request = request.cursor(next_cursor);
        }
        let list = request
            .execute()
            .await
            .map_err(|error| Error::RustError(format!("failed to list access users: {error}")))?;
        for key in list.keys {
            let Some(email) = key.name.strip_prefix("access/users/") else {
                continue;
            };
            let Some(record) = kv.get(&key.name).text().await.map_err(|error| {
                Error::RustError(format!("failed to read access user: {error}"))
            })?
            else {
                continue;
            };
            let user = serde_json::from_str::<AccessUserRecord>(&record).map_err(|error| {
                Error::RustError(format!("access user is invalid JSON: {error}"))
            })?;
            users.push(AccessControlUser {
                email: email.to_string(),
                record: user,
            });
        }
        if list.list_complete {
            break;
        }
        let Some(next_cursor) = list.cursor else {
            break;
        };
        cursor = Some(next_cursor);
    }
    Ok(users)
}

fn access_user_response(
    email: &str,
    record: AccessUserRecord,
    env: &Env,
) -> Result<AdminAccessUserResponse> {
    Ok(AdminAccessUserResponse {
        email: email.to_string(),
        role: if access_admin_for_email(env, email)? {
            AccessRole::Admin
        } else {
            AccessRole::User
        },
        tenant_id: record
            .tenant_id
            .filter(|tenant| !tenant.trim().is_empty())
            .unwrap_or_else(|| default_access_tenant(env)),
        enabled: record.enabled.unwrap_or(true),
        groups: normalize_access_groups(record.groups).map_err(Error::RustError)?,
        content_retention_disabled: record.content_retention_disabled,
    })
}

fn decode_access_user_email(value: &str) -> std::result::Result<String, &'static str> {
    let decoded = percent_decode_path_segment(value).ok_or("email path segment is malformed")?;
    normalize_access_email(&decoded)
}

fn normalize_access_email(value: &str) -> std::result::Result<String, &'static str> {
    let email = value.trim().to_ascii_lowercase();
    if email.len() > 254
        || email.contains('/')
        || email.bytes().any(|byte| byte.is_ascii_whitespace())
        || email.matches('@').count() != 1
    {
        return Err("email must be a single normalized address without spaces or slashes");
    }
    let Some((local, domain)) = email.split_once('@') else {
        return Err("email must contain @");
    };
    if local.is_empty() || domain.is_empty() || !domain.contains('.') {
        return Err("email must include a local part and domain");
    }
    Ok(email)
}

fn normalize_access_group(value: &str) -> std::result::Result<String, &'static str> {
    let group = value.trim().to_ascii_lowercase();
    if group.is_empty()
        || group.len() > 64
        || !group
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
    {
        return Err(
            "groups must use 1-64 lowercase letters, numbers, dots, underscores, or hyphens",
        );
    }
    Ok(group)
}

fn normalize_access_groups(groups: Vec<String>) -> std::result::Result<Vec<String>, String> {
    if groups.len() > 64 {
        return Err("an access user can belong to at most 64 groups".to_string());
    }
    groups
        .into_iter()
        .map(|group| normalize_access_group(&group).map_err(str::to_string))
        .collect::<std::result::Result<BTreeSet<_>, _>>()
        .map(|groups| groups.into_iter().collect())
}

fn normalize_policy_binding(
    mut binding: PolicyBindingRecord,
) -> std::result::Result<PolicyBindingRecord, &'static str> {
    binding.policy_id = validate_admin_kid(binding.policy_id.trim())?;
    binding.principal_id = match binding.principal_type {
        PrincipalType::User => normalize_access_email(&binding.principal_id)?,
        PrincipalType::Group => normalize_access_group(&binding.principal_id)?,
    };
    Ok(binding)
}

fn principal_type_label(principal_type: PrincipalType) -> &'static str {
    match principal_type {
        PrincipalType::User => "user",
        PrincipalType::Group => "group",
    }
}

fn policy_binding_prefix(principal_type: PrincipalType, principal_id: &str) -> String {
    format!(
        "access/bindings/{}/{}/",
        principal_type_label(principal_type),
        encode_component(principal_id)
    )
}

fn policy_binding_key(binding: &PolicyBindingRecord) -> String {
    format!(
        "{}{}",
        policy_binding_prefix(binding.principal_type, &binding.principal_id),
        binding.policy_id
    )
}

fn policy_binding_principal_key(principal: &PolicyBindingPrincipal) -> String {
    format!(
        "{}:{}",
        principal_type_label(principal.principal_type),
        encode_component(&principal.principal_id)
    )
}

fn normalize_policy_binding_records(
    bindings: &mut Vec<PolicyBindingRecord>,
    principal: &PolicyBindingPrincipal,
) {
    let mut normalized = BTreeMap::new();
    for binding in bindings.drain(..) {
        if binding.principal_type == principal.principal_type
            && binding.principal_id == principal.principal_id
        {
            normalized.insert(policy_binding_key(&binding), binding);
        }
    }
    *bindings = normalized.into_values().collect();
}

fn access_control_object_name() -> &'static str {
    // Keep the original object name so the expanded authority reuses existing binding state.
    "policy-bindings"
}

fn provider_connection_object_name(provider_id: &str) -> String {
    format!("provider-connection:{}", encode_component(provider_id))
}

fn percent_decode_path_segment(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return None;
            }
            let high = hex_value(bytes[index + 1])?;
            let low = hex_value(bytes[index + 2])?;
            decoded.push((high << 4) | low);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).ok()
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

async fn authorize_admin(
    method: &Method,
    headers: &Headers,
    url: &Url,
    env: &Env,
) -> Result<Option<Response>> {
    let auth = headers.get("authorization")?.unwrap_or_default();
    let token = auth.strip_prefix("Bearer ").unwrap_or("");
    if !token.is_empty() {
        let expected_hash = match admin_token_hash(env) {
            Ok(value) => value,
            Err(_) => {
                return json_error(
                    "admin_auth_unconfigured",
                    "CLAWROUTER_ADMIN_TOKEN_SHA256 is required for bearer admin requests",
                    503,
                )
                .map(Some);
            }
        };
        if !is_sha256_hex(&expected_hash) {
            return json_error(
                "admin_auth_misconfigured",
                "CLAWROUTER_ADMIN_TOKEN_SHA256 must be a 64-character hex string",
                500,
            )
            .map(Some);
        }
        if constant_time_eq(&sha256_hex(token), &expected_hash.to_ascii_lowercase()) {
            return Ok(None);
        }
    }

    if let Some(session) = verified_access_session(headers, env).await? {
        return if session.role == AccessRole::Admin {
            if access_admin_csrf_allowed(method, headers, url)? {
                Ok(None)
            } else {
                json_error(
                    "admin_csrf_required",
                    "Cloudflare Access admin mutations require a same-origin browser request",
                    403,
                )
                .map(Some)
            }
        } else {
            json_error(
                "access_admin_required",
                "Cloudflare Access user does not have the admin role",
                403,
            )
            .map(Some)
        };
    }

    json_error(
        "admin_auth_required",
        "a valid ClawRouter admin token or Cloudflare Access admin session is required",
        401,
    )
    .map(Some)
}

fn access_admin_csrf_allowed(method: &Method, headers: &Headers, url: &Url) -> Result<bool> {
    if method == &Method::Get || method == &Method::Head || method == &Method::Options {
        return Ok(true);
    }
    let origin = headers.get("origin")?.unwrap_or_default();
    if !origin.is_empty() {
        return Ok(origin == request_origin(url));
    }
    let fetch_site = headers.get("sec-fetch-site")?.unwrap_or_default();
    Ok(matches!(
        fetch_site.as_str(),
        "same-origin" | "same-site" | "none"
    ))
}

fn request_origin(url: &Url) -> String {
    url.origin().ascii_serialization()
}

fn admin_token_hash(env: &Env) -> Result<String> {
    if let Ok(secret) = env.secret("CLAWROUTER_ADMIN_TOKEN_SHA256") {
        return Ok(secret.to_string());
    }
    env.var("CLAWROUTER_ADMIN_TOKEN_SHA256")
        .map(|value| value.to_string())
}

fn constant_time_eq(left: &str, right: &str) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let diff = left
        .as_bytes()
        .iter()
        .zip(right.as_bytes())
        .fold(0_u8, |acc, (a, b)| acc | (a ^ b));
    diff == 0
}

fn optional_env_value(env: &Env, name: &str) -> Result<String> {
    if let Ok(secret) = env.secret(name) {
        return Ok(secret.to_string().trim().to_string());
    }
    Ok(env
        .var(name)
        .map(|value| value.to_string().trim().to_string())
        .unwrap_or_default())
}

fn default_access_tenant(env: &Env) -> String {
    optional_env_value(env, "CLAWROUTER_ACCESS_DEFAULT_TENANT")
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "default".to_string())
}

fn default_access_user_role() -> AccessRole {
    AccessRole::User
}

fn access_admin_for_email(env: &Env, email: &str) -> Result<bool> {
    Ok(
        csv_env_contains(env, "CLAWROUTER_ACCESS_ADMIN_EMAILS", email)?
            || email_domain_matches(env, email)?,
    )
}

fn csv_env_contains(env: &Env, name: &str, needle: &str) -> Result<bool> {
    Ok(optional_env_value(env, name)?
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .any(|value| value.eq_ignore_ascii_case(needle)))
}

fn email_domain_matches(env: &Env, email: &str) -> Result<bool> {
    let Some((_, domain)) = email.rsplit_once('@') else {
        return Ok(false);
    };
    Ok(optional_env_value(env, "CLAWROUTER_ACCESS_ADMIN_DOMAINS")?
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .any(|value| value.eq_ignore_ascii_case(domain)))
}

fn normalized_access_team_domain(value: &str) -> String {
    let mut trimmed = value.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("https://") {
        trimmed = &trimmed["https://".len()..];
    } else if lower.starts_with("http://") {
        trimmed = &trimmed["http://".len()..];
    }
    for separator in ['/', '?', '#'] {
        if let Some(index) = trimmed.find(separator) {
            trimmed = &trimmed[..index];
        }
    }
    trimmed.to_ascii_lowercase()
}

fn split_jwt(value: &str) -> Option<(&str, &str, &str)> {
    let mut parts = value.split('.');
    let header = parts.next()?;
    let payload = parts.next()?;
    let signature = parts.next()?;
    parts
        .next()
        .is_none()
        .then_some((header, payload, signature))
}

fn access_jwt_part(value: &str) -> Option<Vec<u8>> {
    base64_url_decode(value).ok()
}

fn subtle_crypto() -> Result<JsValue> {
    let crypto = Reflect::get(&js_sys::global(), &JsValue::from_str("crypto")).map_err(js_error)?;
    Reflect::get(&crypto, &JsValue::from_str("subtle")).map_err(js_error)
}

fn js_function(object: &JsValue, name: &str) -> Result<Function> {
    Reflect::get(object, &JsValue::from_str(name))
        .map_err(js_error)?
        .dyn_into::<Function>()
        .map_err(js_error)
}

fn js_set<T: Into<JsValue>>(object: &Object, name: &str, value: T) -> Result<()> {
    Reflect::set(object, &JsValue::from_str(name), &value.into())
        .map_err(js_error)?
        .then_some(())
        .ok_or_else(|| Error::RustError(format!("failed to set JavaScript property `{name}`")))
}

fn js_error(error: JsValue) -> Error {
    Error::RustError(
        error
            .as_string()
            .unwrap_or_else(|| "JavaScript runtime error".to_string()),
    )
}

fn base64_url_decode(value: &str) -> Result<Vec<u8>> {
    let mut bits = 0_u32;
    let mut bit_count = 0_u8;
    let mut out = Vec::with_capacity(value.len() * 3 / 4);
    for byte in value.bytes() {
        if byte == b'=' {
            break;
        }
        let sextet = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'-' | b'+' => 62,
            b'_' | b'/' => 63,
            _ => {
                return Err(Error::RustError(
                    "invalid base64url-encoded value".to_string(),
                ))
            }
        };
        bits = (bits << 6) | u32::from(sextet);
        bit_count += 6;
        if bit_count >= 8 {
            bit_count -= 8;
            out.push(((bits >> bit_count) & 0xff) as u8);
        }
    }
    Ok(out)
}

fn base64_url_encode(value: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut output = String::with_capacity(value.len().div_ceil(3) * 4);
    for chunk in value.chunks(3) {
        let a = chunk[0] as u32;
        let b = chunk.get(1).copied().unwrap_or_default() as u32;
        let c = chunk.get(2).copied().unwrap_or_default() as u32;
        let bits = (a << 16) | (b << 8) | c;
        output.push(ALPHABET[((bits >> 18) & 0x3f) as usize] as char);
        output.push(ALPHABET[((bits >> 12) & 0x3f) as usize] as char);
        if chunk.len() > 1 {
            output.push(ALPHABET[((bits >> 6) & 0x3f) as usize] as char);
        }
        if chunk.len() > 2 {
            output.push(ALPHABET[(bits & 0x3f) as usize] as char);
        }
    }
    output
}

fn random_hex(length: u32) -> Result<String> {
    let crypto = Reflect::get(&js_sys::global(), &JsValue::from_str("crypto")).map_err(js_error)?;
    let get_random_values = js_function(&crypto, "getRandomValues")?;
    let bytes = Uint8Array::new_with_length(length);
    get_random_values.call1(&crypto, &bytes).map_err(js_error)?;
    Ok(bytes_to_hex(&bytes.to_vec()))
}

fn default_true() -> bool {
    true
}

fn legacy_policy_generation() -> String {
    "legacy".to_string()
}

fn new_policy_generation() -> String {
    #[cfg(test)]
    {
        format!("policy_test_{}", next_usage_event_sequence())
    }
    #[cfg(not(test))]
    {
        let seq = next_usage_event_sequence();
        let nonce = (js_sys::Math::random() * MAX_SQL_BUDGET_MICROS as f64) as u64;
        format!("policy_{}_{}_{nonce:x}", Date::now().as_millis(), seq)
    }
}

fn credential_policy_generation_matches(
    credential: &ProxyCredential,
    policy: &AccessPolicy,
) -> bool {
    credential.policy_generation == policy.generation
}

fn preserve_existing_policy_generation(
    policy: &mut AccessPolicy,
    existing_policy: Option<&AccessPolicy>,
) {
    if let Some(existing_policy) = existing_policy {
        policy.generation.clone_from(&existing_policy.generation);
    }
}

fn preserve_existing_legacy_generation(
    policy: &mut LegacyKeyPolicy,
    existing_policy: Option<&AccessPolicy>,
) {
    if let Some(existing_policy) = existing_policy {
        policy.generation.clone_from(&existing_policy.generation);
    }
}

fn legacy_key_update_changes_policy_and_secret(
    existing_policy: Option<&AccessPolicy>,
    existing_credential: Option<&ProxyCredential>,
    policy: &AccessPolicy,
    credential: &ProxyCredential,
) -> bool {
    existing_policy.is_some_and(|existing| existing != policy)
        && existing_credential
            .is_some_and(|existing| existing.secret_sha256 != credential.secret_sha256)
}

fn is_pre_migration_legacy_key_policy(policy: &LegacyKeyPolicy) -> bool {
    policy.generation == legacy_policy_generation()
}

fn default_binding_priority() -> u16 {
    100
}

fn default_oauth_token_type() -> String {
    "Bearer".to_string()
}

fn default_upstream_grant_version() -> u8 {
    1
}

fn inspect_policy_for_response<'a>(
    verification: &str,
    policy: &'a AccessPolicy,
) -> Option<&'a AccessPolicy> {
    matches!(verification, "verified" | "policy_revoked").then_some(policy)
}

fn key_inspection_response(
    kid: &str,
    mode: &str,
    policy: Option<&AccessPolicy>,
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
        "tokenRole": policy.and_then(|policy| policy.token_role.as_deref()),
        "monthlyBudgetMicros": policy.and_then(|policy| policy.monthly_budget_micros),
        "requestCostMicros": policy.and_then(|policy| policy.request_cost_micros)
    }))
}

async fn authorize_proxy_key(
    headers: &Headers,
    env: &Env,
    provider_id: &str,
    attribution: &AgentAttribution,
) -> Result<AuthOutcome> {
    authorize_proxy_key_for_provider(headers, env, Some(provider_id), Some(attribution)).await
}

async fn authorize_request(
    headers: &Headers,
    env: &Env,
    provider_id: &str,
    mode: ProxyAuthMode,
    attribution: &AgentAttribution,
) -> Result<AuthOutcome> {
    match mode {
        ProxyAuthMode::ProxyKey => {
            authorize_proxy_key(headers, env, provider_id, attribution).await
        }
        ProxyAuthMode::AccessSession => {
            authorize_access_session(headers, env, provider_id, attribution).await
        }
    }
}

fn proxy_key_header_present(headers: &Headers) -> Result<bool> {
    Ok(proxy_key_from_headers(headers)?.is_some())
}

fn proxy_key_from_headers(headers: &Headers) -> Result<Option<ProxyKeyParts>> {
    let auth = headers.get("authorization")?.unwrap_or_default();
    let anthropic = headers.get("x-api-key")?.unwrap_or_default();
    let google = headers.get("x-goog-api-key")?.unwrap_or_default();
    let azure = headers.get("api-key")?.unwrap_or_default();
    Ok(parse_proxy_key_candidates([
        auth.strip_prefix("Bearer ").unwrap_or(""),
        &anthropic,
        &google,
        &azure,
    ]))
}

fn parse_proxy_key_candidates<'a>(
    candidates: impl IntoIterator<Item = &'a str>,
) -> Option<ProxyKeyParts> {
    candidates
        .into_iter()
        .find_map(|candidate| parse_proxy_key(candidate).ok())
}

async fn disabled_provider_connection_response(
    env: &Env,
    provider_id: &str,
) -> Result<Option<Response>> {
    let kv = env.kv("POLICY_KV").map_err(|error| {
        Error::RustError(format!(
            "POLICY_KV binding is required for provider connection authorization: {error}"
        ))
    })?;
    let connection = authoritative_provider_connection(env, &kv, provider_id.to_string()).await?;
    if connection.enabled {
        return Ok(None);
    }
    json_error(
        "provider_connection_disabled",
        "provider connection is disabled",
        403,
    )
    .map(Some)
}

async fn authorize_proxy_key_identity(headers: &Headers, env: &Env) -> Result<AuthOutcome> {
    authorize_proxy_key_for_provider(headers, env, None, None).await
}

async fn authorize_proxy_key_for_provider(
    headers: &Headers,
    env: &Env,
    provider_id: Option<&str>,
    attribution: Option<&AgentAttribution>,
) -> Result<AuthOutcome> {
    let key = match proxy_key_from_headers(headers)? {
        Some(key) => key,
        None => {
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
    let Some(credential) = authoritative_proxy_credential(env, &kv, &key.kid).await? else {
        return json_error("unknown_proxy_key", "proxy key is not registered", 401)
            .map(AuthOutcome::Denied);
    };
    if sha256_hex(&key.secret) != credential.secret_sha256 {
        return json_error("invalid_proxy_key", "proxy key secret is invalid", 401)
            .map(AuthOutcome::Denied);
    }
    let Some(policy) = authoritative_access_policy(env, &kv, &credential.policy_id).await? else {
        let response = json_error(
            "credential_policy_missing",
            "proxy credential references an unknown access policy",
            403,
        )?;
        if let Some(provider_id) = provider_id {
            let auth = AuthorizedKey {
                credential_id: Some(key.kid),
                principal_id: credential.principal_id.clone(),
                auth_type: "proxy_key",
                policy_id: credential.policy_id,
                policy: denied_access_policy(None),
                content_retention_disabled: false,
            };
            enqueue_denied_usage(
                env,
                DeniedUsageRecord {
                    auth: &auth,
                    provider: provider_id,
                    capability: "access.denied",
                    model: None,
                    request_id: &request_id(headers, "auth"),
                    status_code: response.status_code(),
                    attribution,
                },
            )
            .await;
        }
        return Ok(AuthOutcome::Denied(response));
    };
    let generation_matches = credential_policy_generation_matches(&credential, &policy);
    let content_retention_disabled = match credential.principal_id.as_deref() {
        Some(principal_id) => {
            access_control_user_record(env, principal_id, &default_access_tenant(env))
                .await?
                .content_retention_disabled
        }
        None => false,
    };
    let authorized = AuthorizedKey {
        credential_id: Some(key.kid),
        principal_id: credential.principal_id,
        auth_type: "proxy_key",
        policy_id: credential.policy_id,
        policy,
        content_retention_disabled,
    };
    if !credential.enabled {
        let response = json_error("proxy_key_revoked", "proxy key is revoked", 403)?;
        if let Some(provider_id) = provider_id {
            enqueue_denied_usage(
                env,
                DeniedUsageRecord {
                    auth: &authorized,
                    provider: provider_id,
                    capability: "access.denied",
                    model: None,
                    request_id: &request_id(headers, "auth"),
                    status_code: response.status_code(),
                    attribution,
                },
            )
            .await;
        }
        return Ok(AuthOutcome::Denied(response));
    }
    if !authorized.policy.enabled {
        let response = json_error("policy_revoked", "access policy is revoked", 403)?;
        if let Some(provider_id) = provider_id {
            enqueue_denied_usage(
                env,
                DeniedUsageRecord {
                    auth: &authorized,
                    provider: provider_id,
                    capability: "access.denied",
                    model: None,
                    request_id: &request_id(headers, "auth"),
                    status_code: response.status_code(),
                    attribution,
                },
            )
            .await;
        }
        return Ok(AuthOutcome::Denied(response));
    }
    if !generation_matches {
        let response = json_error(
            "credential_policy_stale",
            "proxy credential is not bound to the current access policy generation",
            403,
        )?;
        if let Some(provider_id) = provider_id {
            enqueue_denied_usage(
                env,
                DeniedUsageRecord {
                    auth: &authorized,
                    provider: provider_id,
                    capability: "access.denied",
                    model: None,
                    request_id: &request_id(headers, "auth"),
                    status_code: response.status_code(),
                    attribution,
                },
            )
            .await;
        }
        return Ok(AuthOutcome::Denied(response));
    }
    if let Some(provider_id) = provider_id {
        if !authorized.policy.providers.is_empty()
            && !authorized
                .policy
                .providers
                .iter()
                .any(|id| id == provider_id)
        {
            let response = json_error(
                "provider_not_allowed",
                "proxy key is not allowed to use this provider",
                403,
            )?;
            enqueue_denied_usage(
                env,
                DeniedUsageRecord {
                    auth: &authorized,
                    provider: provider_id,
                    capability: "access.denied",
                    model: None,
                    request_id: &request_id(headers, "auth"),
                    status_code: response.status_code(),
                    attribution,
                },
            )
            .await;
            return Ok(AuthOutcome::Denied(response));
        }
    }
    Ok(AuthOutcome::Allowed(authorized))
}

async fn authorize_access_session(
    headers: &Headers,
    env: &Env,
    provider_id: &str,
    attribution: &AgentAttribution,
) -> Result<AuthOutcome> {
    let Some(session) = verified_access_session(headers, env).await? else {
        return json_error(
            "access_session_required",
            "playground requests require a verified Cloudflare Access session",
            401,
        )
        .map(AuthOutcome::Denied);
    };
    let kv = match env.kv("POLICY_KV") {
        Ok(kv) => kv,
        Err(_) => {
            return json_error(
                "policy_store_unavailable",
                "POLICY_KV binding is required for Access playground requests",
                503,
            )
            .map(AuthOutcome::Denied);
        }
    };
    let entries = list_session_policy_entries(&kv, env, &session).await?;
    let matching_entries = entries
        .iter()
        .filter(|entry| policy_allows_provider(&entry.policy, provider_id))
        .collect::<Vec<_>>();
    let Some(first_entry) = matching_entries.first().copied() else {
        let response = json_error(
            "provider_not_allowed",
            "Cloudflare Access user is not allowed to use this provider",
            403,
        )?;
        let auth = AuthorizedKey {
            credential_id: None,
            principal_id: Some(session.email),
            auth_type: "access",
            policy_id: "access_unbound".to_string(),
            policy: denied_access_policy(Some(session.tenant_id)),
            content_retention_disabled: session.content_retention_disabled,
        };
        enqueue_denied_usage(
            env,
            DeniedUsageRecord {
                auth: &auth,
                provider: provider_id,
                capability: "access.denied",
                model: None,
                request_id: &request_id(headers, "auth"),
                status_code: response.status_code(),
                attribution: Some(attribution),
            },
        )
        .await;
        return Ok(AuthOutcome::Denied(response));
    };
    let snapshot = provider_snapshot()?;
    let provider = snapshot
        .providers
        .iter()
        .find(|provider| provider.id == provider_id);
    let grants = list_oauth_grants(&kv).await?;
    let selected_entry = select_access_policy_for_provider(provider, &matching_entries, &grants)
        .unwrap_or(first_entry);
    Ok(AuthOutcome::Allowed(AuthorizedKey {
        credential_id: None,
        principal_id: Some(session.email),
        auth_type: "access",
        policy_id: selected_entry.policy_id.clone(),
        policy: selected_entry.policy.clone(),
        content_retention_disabled: session.content_retention_disabled,
    }))
}

fn policy_allows_provider(policy: &AccessPolicy, provider_id: &str) -> bool {
    if !policy.enabled {
        return false;
    }
    policy.providers.is_empty() || policy.providers.iter().any(|id| id == provider_id)
}

fn denied_access_policy(tenant_id: Option<String>) -> AccessPolicy {
    AccessPolicy {
        enabled: false,
        generation: legacy_policy_generation(),
        providers: Vec::new(),
        tenant_id,
        token_role: None,
        monthly_budget_micros: None,
        request_cost_micros: None,
        retain_request_content: true,
    }
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
    pricing_ref: Option<String>,
    pricing: Option<ModelPricing>,
}

struct NativeModelSelection {
    model: String,
    upstream_model: String,
    pricing_ref: Option<String>,
    pricing: Option<ModelPricing>,
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
                pricing_ref: model_entry.pricing_ref.clone(),
                pricing: model_entry.pricing.clone(),
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
                pricing_ref: None,
                pricing: None,
            })
        })
    })
}

fn resolve_selected_upstream_model<F>(
    route: &SelectedRoute<'_>,
    resolve_template: F,
) -> Result<String>
where
    F: FnOnce(&CompiledProvider, &str) -> Result<String>,
{
    if contains_template(&route.upstream_model) {
        resolve_template(route.provider, &route.upstream_model)
    } else {
        Ok(route.upstream_model.clone())
    }
}

fn normalize_native_model(
    provider: &CompiledProvider,
    body: &mut Value,
) -> Option<NativeModelSelection> {
    let selection = select_native_model(provider, body)?;
    body["model"] = Value::String(selection.upstream_model.clone());
    Some(selection)
}

fn select_native_model(provider: &CompiledProvider, body: &Value) -> Option<NativeModelSelection> {
    select_model_value(provider, body.get("model")?.as_str()?)
}

fn select_model_value(provider: &CompiledProvider, model: &str) -> Option<NativeModelSelection> {
    let model = model.to_string();
    if let Some(entry) = provider.models.iter().find(|entry| {
        (entry.id == model && !contains_template(&entry.upstream)) || entry.upstream == model
    }) {
        return Some(NativeModelSelection {
            model,
            upstream_model: entry.upstream.clone(),
            pricing_ref: entry.pricing_ref.clone(),
            pricing: entry.pricing.clone(),
        });
    }
    let mut upstream_model = model.clone();
    for prefix in &provider.routing.model_prefixes {
        if let Some(upstream) = model.strip_prefix(prefix) {
            if !upstream.is_empty() {
                upstream_model = upstream.to_string();
                break;
            }
        }
    }
    Some(NativeModelSelection {
        model,
        upstream_model,
        pricing_ref: None,
        pricing: None,
    })
}

fn select_manifest_model_value<F>(
    provider: &CompiledProvider,
    model: &str,
    resolve_template: F,
) -> Option<NativeModelSelection>
where
    F: FnOnce(&str) -> Option<String>,
{
    if let Some(entry) = provider
        .models
        .iter()
        .find(|entry| entry.id == model && contains_template(&entry.upstream))
    {
        if let Some(upstream_model) = resolve_template(&entry.upstream) {
            return Some(NativeModelSelection {
                model: model.to_string(),
                upstream_model,
                pricing_ref: entry.pricing_ref.clone(),
                pricing: entry.pricing.clone(),
            });
        }
    }
    select_model_value(provider, model)
}

fn normalize_manifest_body_model<F>(
    provider: &CompiledProvider,
    body: &mut Value,
    resolve_template: F,
) -> Option<NativeModelSelection>
where
    F: FnOnce(&str) -> Option<String>,
{
    let selection =
        select_manifest_model_value(provider, body.get("model")?.as_str()?, resolve_template)?;
    body["model"] = Value::String(selection.upstream_model.clone());
    Some(selection)
}

fn normalize_manifest_path_model<F>(
    provider: &CompiledProvider,
    endpoint: &CompiledEndpoint,
    proxy: &mut ManifestProxyRequest,
    resolve_template: F,
) -> Option<NativeModelSelection>
where
    F: FnOnce(&str) -> Option<String>,
{
    let param = endpoint
        .path_params
        .iter()
        .find(|param| matches!(param.as_str(), "model" | "deployment"))?;
    let selection = select_manifest_model_value(
        provider,
        proxy.path_params.get(param)?.as_str()?,
        resolve_template,
    )?;
    proxy.path_params.insert(
        param.to_string(),
        Value::String(selection.upstream_model.clone()),
    );
    Some(selection)
}

fn supports_openai_compatible_proxy(provider: &CompiledProvider) -> bool {
    provider.class == ProviderClass::OpenaiCompatible
        && provider.adapter.request.as_deref() == Some("openai")
        && provider.adapter.response.as_deref() == Some("openai")
        && templates_supported_by_config(
            provider,
            provider
                .base_urls
                .get("default")
                .map(String::as_str)
                .unwrap_or(""),
        )
        && provider
            .endpoints
            .iter()
            .all(openai_endpoint_path_supported)
        && provider
            .adapter
            .inject_query
            .values()
            .all(|value| templates_supported_by_config(provider, value))
        && provider
            .adapter
            .inject_headers
            .values()
            .all(|value| templates_supported_by_config(provider, value))
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

fn normalize_openai_proxy_body(
    provider: &CompiledProvider,
    path: &str,
    upstream_model: &str,
    env: Option<&Env>,
    body: &mut Value,
) {
    let Some(object) = body.as_object_mut() else {
        return;
    };
    for transform in &provider.adapter.request_transforms.rename_fields {
        if !transform.paths.is_empty() && !transform.paths.iter().any(|candidate| candidate == path)
        {
            continue;
        }
        if !request_transform_matches_upstream(provider, transform, upstream_model, env) {
            continue;
        }
        let Some(value) = object.remove(&transform.from) else {
            continue;
        };
        object.entry(transform.to.clone()).or_insert(value);
    }
}

fn manifest_transform_path(endpoint: &CompiledEndpoint) -> &str {
    match endpoint.request_format.as_str() {
        "openai.chat_completions" => "/v1/chat/completions",
        "openai.embeddings" => "/v1/embeddings",
        "openai.responses" => "/v1/responses",
        _ => &endpoint.path,
    }
}

fn normalize_list_pricing_request(
    provider: &CompiledProvider,
    path: &str,
    listed_pricing: bool,
    body: &mut Value,
) -> std::result::Result<(), &'static str> {
    if !listed_pricing {
        return Ok(());
    }
    if provider.id == "google-gemini" {
        return if request_contains_audio_input(body) {
            Err(
                "Gemini audio inputs require an explicit fixed policy request price until modality-specific pricing is supported",
            )
        } else {
            Ok(())
        };
    }
    if provider.id == "xai" && path == "/v1/chat/completions" {
        let Some(object) = body.as_object() else {
            return Err("xAI list-priced requests must use a JSON object body");
        };
        return match object.get("service_tier") {
            None | Some(Value::Null) => Ok(()),
            Some(_) => Err(
                "xAI list-price enforcement supports only standard processing; use a fixed policy request price for priority processing",
            ),
        };
    }
    if provider.id != "openai" || !matches!(path, "/v1/responses" | "/v1/chat/completions") {
        return Ok(());
    }
    let Some(object) = body.as_object_mut() else {
        return Err("OpenAI list-priced requests must use a JSON object body");
    };
    if path == "/v1/responses" && object.get("background").and_then(Value::as_bool) == Some(true) {
        return Err(
            "OpenAI background Responses require an explicit fixed policy request price until terminal usage polling is supported",
        );
    }
    match object.get("service_tier") {
        None | Some(Value::Null) => {
            object.insert(
                "service_tier".to_string(),
                Value::String("default".to_string()),
            );
        }
        Some(Value::String(tier)) if tier == "auto" => {
            object.insert(
                "service_tier".to_string(),
                Value::String("default".to_string()),
            );
        }
        Some(Value::String(tier)) if tier == "default" => {}
        Some(_) => {
            return Err(
                "OpenAI list-price enforcement supports only the default service tier; use a fixed policy price or add versioned tier pricing",
            )
        }
    }
    if path == "/v1/chat/completions" && object.get("stream").and_then(Value::as_bool) == Some(true)
    {
        let stream_options = object
            .entry("stream_options".to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        if stream_options.is_null() {
            *stream_options = Value::Object(Map::new());
        }
        let Some(stream_options) = stream_options.as_object_mut() else {
            return Err("OpenAI stream_options must be a JSON object");
        };
        stream_options.insert("include_usage".to_string(), Value::Bool(true));
    }
    Ok(())
}

fn validate_native_list_pricing_request(
    provider: &CompiledProvider,
    path: &str,
    listed_pricing: bool,
    body: &Value,
) -> std::result::Result<(), &'static str> {
    if !listed_pricing {
        return Ok(());
    }
    if provider.id == "google-gemini" {
        return if request_contains_audio_input(body) {
            Err(
                "Gemini audio inputs require an explicit fixed policy request price until modality-specific pricing is supported",
            )
        } else {
            Ok(())
        };
    }
    if provider.id == "xai" && path == "/v1/chat/completions" {
        let Some(object) = body.as_object() else {
            return Err("xAI list-priced requests must use a JSON object body");
        };
        return match object.get("service_tier") {
            None | Some(Value::Null) => Ok(()),
            Some(_) => Err(
                "xAI list-price enforcement supports only standard processing; use a fixed policy request price for priority processing",
            ),
        };
    }
    if provider.id != "openai" || !matches!(path, "/v1/responses" | "/v1/chat/completions") {
        return Ok(());
    }
    let Some(object) = body.as_object() else {
        return Err("OpenAI list-priced requests must use a JSON object body");
    };
    if path == "/v1/responses" && object.get("background").and_then(Value::as_bool) == Some(true) {
        return Err(
            "OpenAI background Responses require an explicit fixed policy request price until terminal usage polling is supported",
        );
    }
    if object.get("service_tier").and_then(Value::as_str) != Some("default") {
        return Err(
            "OpenAI list-priced native requests must explicitly use the default service tier; use the compatibility route for normalization or configure a fixed policy price",
        );
    }
    if path == "/v1/chat/completions"
        && object.get("stream").and_then(Value::as_bool) == Some(true)
        && object
            .get("stream_options")
            .and_then(|options| options.get("include_usage"))
            .and_then(Value::as_bool)
            != Some(true)
    {
        return Err(
            "OpenAI list-priced native chat streams must explicitly request stream usage; use the compatibility route for normalization or configure a fixed policy price",
        );
    }
    Ok(())
}

fn request_contains_audio_input(value: &Value) -> bool {
    match value {
        Value::Array(values) => values.iter().any(request_contains_audio_input),
        Value::Object(object) => {
            let audio_mime = ["mimeType", "mime_type"].iter().any(|key| {
                object
                    .get(*key)
                    .and_then(Value::as_str)
                    .is_some_and(|mime| mime.to_ascii_lowercase().starts_with("audio/"))
            });
            let audio_type = object
                .get("type")
                .and_then(Value::as_str)
                .is_some_and(|kind| matches!(kind, "audio" | "input_audio"));
            audio_mime || audio_type || object.values().any(request_contains_audio_input)
        }
        _ => false,
    }
}

fn validate_request_tool_pricing(
    policy: &AccessPolicy,
    pricing: Option<&ModelPricing>,
    dialect: ProviderToolDialect,
    capability: &str,
    body: &Value,
) -> std::result::Result<(), &'static str> {
    if policy.request_cost_micros.is_some()
        || pricing.is_none()
        || capability == "llm.count_tokens"
        || !request_has_unpriced_provider_tools(dialect, body)
    {
        return Ok(());
    }
    Err(
        "server-side tools require an explicit fixed policy request price until versioned tool pricing is configured",
    )
}

fn validate_request_beta_pricing(
    policy: &AccessPolicy,
    pricing: Option<&ModelPricing>,
    dialect: ProviderToolDialect,
    capability: &str,
    anthropic_beta: Option<&str>,
) -> std::result::Result<(), &'static str> {
    if policy.request_cost_micros.is_some()
        || pricing.is_none()
        || dialect != ProviderToolDialect::Anthropic
        || capability == "llm.count_tokens"
    {
        return Ok(());
    }
    let requests_1m_context = anthropic_beta.is_some_and(|value| {
        value
            .split(',')
            .any(|beta| beta.trim().eq_ignore_ascii_case("context-1m-2025-08-07"))
    });
    let has_matching_long_context_price = pricing.is_some_and(|pricing| {
        pricing.long_context.is_some()
            && pricing.max_input_tokens >= ANTHROPIC_1M_CONTEXT_MIN_INPUT_TOKENS
    });
    if requests_1m_context && !has_matching_long_context_price {
        return Err(
            "Anthropic 1M-context beta requests require an explicit fixed policy request price or versioned long-context pricing",
        );
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ProviderToolDialect {
    Anthropic,
    GoogleGemini,
    OpenAi,
    Generic,
}

fn provider_tool_dialect(provider: &CompiledProvider) -> ProviderToolDialect {
    if provider.class == ProviderClass::AnthropicCompatible
        || provider.adapter.request.as_deref() == Some("anthropic")
        || provider.adapter.response.as_deref() == Some("anthropic")
    {
        ProviderToolDialect::Anthropic
    } else if provider.adapter.request.as_deref() == Some("google_gemini")
        || provider.adapter.response.as_deref() == Some("google_gemini")
    {
        ProviderToolDialect::GoogleGemini
    } else if provider.id == "openai" {
        ProviderToolDialect::OpenAi
    } else {
        ProviderToolDialect::Generic
    }
}

fn request_has_unpriced_provider_tools(dialect: ProviderToolDialect, body: &Value) -> bool {
    (dialect == ProviderToolDialect::Anthropic
        && body
            .get("mcp_servers")
            .and_then(Value::as_array)
            .is_some_and(|servers| !servers.is_empty()))
        || body
            .get("tools")
            .and_then(Value::as_array)
            .is_some_and(|tools| {
                tools
                    .iter()
                    .any(|tool| tool_has_unpriced_provider_cost(dialect, tool))
            })
}

fn tool_has_unpriced_provider_cost(dialect: ProviderToolDialect, tool: &Value) -> bool {
    if dialect == ProviderToolDialect::GoogleGemini {
        return [
            "google_search",
            "google_search_retrieval",
            "url_context",
            "code_execution",
        ]
        .iter()
        .any(|key| tool.get(*key).is_some());
    }

    let Some(kind) = tool.get("type").and_then(Value::as_str) else {
        // Anthropic custom tools and OpenAI-compatible function declarations are
        // executed by the caller and do not have a provider execution fee.
        return false;
    };
    if dialect == ProviderToolDialect::Anthropic
        && ["bash_", "text_editor_", "computer_", "memory_"]
            .iter()
            .any(|prefix| kind.starts_with(prefix))
    {
        return false;
    }
    if dialect == ProviderToolDialect::OpenAi && kind == "shell" {
        return tool
            .get("environment")
            .and_then(|environment| environment.get("type"))
            .and_then(Value::as_str)
            != Some("local");
    }
    !matches!(
        kind,
        "function" | "custom" | "namespace" | "local_shell" | "apply_patch"
    )
}

fn request_transform_matches_upstream(
    provider: &CompiledProvider,
    transform: &clawrouter_core::provider::FieldRenameTransform,
    upstream_model: &str,
    env: Option<&Env>,
) -> bool {
    if transform.upstreams.is_empty() && transform.upstream_config.is_none() {
        return true;
    }
    if transform
        .upstreams
        .iter()
        .any(|candidate| candidate == upstream_model)
    {
        return true;
    }
    let Some(config_name) = transform.upstream_config.as_deref() else {
        return false;
    };
    let Some(env) = env else {
        return false;
    };
    optional_provider_config_value(env, provider, config_name)
        .map(|configured| {
            split_config_list(&configured).any(|candidate| candidate == upstream_model)
        })
        .unwrap_or(false)
}

fn split_config_list(value: &str) -> impl Iterator<Item = &str> {
    value
        .split(|ch: char| ch == ',' || ch == ';' || ch.is_ascii_whitespace())
        .filter(|candidate| !candidate.is_empty())
}

fn usage_stream_requires_terminal_marker(stream_adapter: Option<&str>) -> bool {
    matches!(stream_adapter, Some("openai_sse" | "anthropic_sse"))
}

fn openai_upstream_url(
    provider: &CompiledProvider,
    endpoint: &CompiledEndpoint,
    env: &Env,
    upstream_model: &str,
    query_auth: Option<(String, String)>,
    grant: Option<&UpstreamGrantRecord>,
    transport_path: Option<&str>,
) -> std::result::Result<String, OpenAiProxyUrlError> {
    let base = provider_upstream_base_url(provider, grant).map_err(OpenAiProxyUrlError::Runtime)?;
    let base =
        resolve_template_value(provider, base, Some(env)).map_err(OpenAiProxyUrlError::Runtime)?;
    let path = match transport_path {
        Some(path) => path.to_string(),
        None => openai_endpoint_path(endpoint, upstream_model)?,
    };
    let mut url = format!("{}{}", base.trim_end_matches('/'), path);
    let mut query = resolved_template_map(provider, &provider.adapter.inject_query, Some(env))
        .map_err(OpenAiProxyUrlError::Runtime)?;
    if let Some((param, secret)) = query_auth {
        query.insert(param, secret);
    }
    append_query(&mut url, query);
    Ok(url)
}

fn contains_template(value: &str) -> bool {
    value.contains("${")
}

fn openai_endpoint_path_supported(endpoint: &CompiledEndpoint) -> bool {
    let placeholders = template_placeholders(&endpoint.path);
    placeholders.is_empty()
        || (endpoint.path_params.len() == 1
            && placeholders
                .iter()
                .all(|name| endpoint.path_params.iter().any(|param| param == name)))
}

#[derive(Debug)]
enum OpenAiProxyUrlError {
    Client(String),
    Runtime(Error),
}

fn openai_endpoint_path(
    endpoint: &CompiledEndpoint,
    upstream_model: &str,
) -> std::result::Result<String, OpenAiProxyUrlError> {
    if endpoint.path_params.is_empty() {
        return Ok(endpoint.path.clone());
    }
    if endpoint.path_params.len() != 1 {
        return Err(OpenAiProxyUrlError::Runtime(Error::RustError(format!(
            "provider endpoint `{}` needs more than one OpenAI path parameter",
            endpoint.id
        ))));
    }
    let param = &endpoint.path_params[0];
    let value =
        path_param_value(endpoint, param, upstream_model).map_err(OpenAiProxyUrlError::Client)?;
    Ok(endpoint.path.replace(&format!("${{{param}}}"), &value))
}

fn supports_manifest_proxy(provider: &CompiledProvider, endpoint: &CompiledEndpoint) -> bool {
    templates_supported_by_config(
        provider,
        provider
            .base_urls
            .get("default")
            .map(String::as_str)
            .unwrap_or(""),
    ) && provider
        .adapter
        .inject_headers
        .values()
        .all(|value| templates_supported_by_config(provider, value))
        && provider
            .adapter
            .inject_query
            .values()
            .all(|value| templates_supported_by_config(provider, value))
        && endpoint
            .headers
            .values()
            .all(|value| templates_supported_by_config(provider, value))
        && endpoint
            .query
            .values()
            .all(|value| templates_supported_by_config(provider, value))
        && supports_edge_auth(provider)
}

fn supports_edge_auth(provider: &CompiledProvider) -> bool {
    provider.auth.schemes.iter().all(|scheme| match scheme {
        AuthScheme::Bearer {
            secret_kind,
            required,
            ..
        } => !*required || provider_has_secret_candidate(provider, secret_kind),
        AuthScheme::ApiKey { secret_kind, .. } | AuthScheme::QueryApiKey { secret_kind, .. } => {
            provider_has_secret_candidate(provider, secret_kind)
        }
        AuthScheme::CloudflareBinding => true,
        AuthScheme::OAuth {
            provider,
            token_ref,
            ..
        } => {
            provider.as_deref().is_some_and(|value| !value.is_empty())
                || token_ref.as_deref().is_some_and(|value| !value.is_empty())
        }
        AuthScheme::SigV4 {
            service,
            region_param,
        } => {
            !service.is_empty()
                && template_has_config_key(provider, "access_key_id")
                && template_has_config_key(provider, "secret_access_key")
                && template_has_config_key(provider, region_param.as_deref().unwrap_or("region"))
        }
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
    query_auth: Option<(String, String)>,
    grant: Option<&UpstreamGrantRecord>,
    transport_path: Option<&str>,
) -> std::result::Result<String, ManifestProxyError> {
    let base = provider_upstream_base_url(provider, grant).map_err(ManifestProxyError::Runtime)?;
    let mut path = transport_path.unwrap_or(&endpoint.path).to_string();
    for param in &endpoint.path_params {
        let Some(value) = proxy.path_params.get(param).and_then(Value::as_str) else {
            return Err(ManifestProxyError::Client(format!(
                "endpoint `{}` requires path param `{param}`",
                endpoint.id
            )));
        };
        let value = path_param_value(endpoint, param, value).map_err(ManifestProxyError::Client)?;
        path = path.replace(&format!("${{{param}}}"), &value);
    }
    let base = resolve_template_value(provider, base, env).map_err(ManifestProxyError::Runtime)?;
    let mut url = format!("{}{}", base.trim_end_matches('/'), path);
    let mut query = resolved_template_map(provider, &endpoint.query, env)
        .map_err(ManifestProxyError::Runtime)?;
    for (name, value) in &proxy.query {
        if let Some(value) = query_value(value) {
            query.insert(name.clone(), value);
        }
    }
    for (name, value) in resolved_template_map(provider, &provider.adapter.inject_query, env)
        .map_err(ManifestProxyError::Runtime)?
    {
        query.insert(name, value);
    }
    if let Some((param, secret)) = query_auth {
        query.insert(param, secret);
    }
    append_query(&mut url, query);
    Ok(url)
}

fn validate_manifest_path_params(
    endpoint: &CompiledEndpoint,
    proxy: &ManifestProxyRequest,
) -> std::result::Result<(), ManifestProxyError> {
    for param in &endpoint.path_params {
        let Some(value) = proxy.path_params.get(param).and_then(Value::as_str) else {
            return Err(ManifestProxyError::Client(format!(
                "endpoint `{}` requires path param `{param}`",
                endpoint.id
            )));
        };
        path_param_value(endpoint, param, value).map_err(ManifestProxyError::Client)?;
    }
    Ok(())
}

#[derive(Debug)]
enum HeaderBuildError {
    Client {
        code: &'static str,
        message: &'static str,
        status: u16,
    },
    Runtime(Error),
}

#[derive(Clone, Copy)]
struct HeaderRequestContext<'a> {
    method: &'a str,
    url: &'a str,
    body: Option<&'a [u8]>,
}

fn grant_transport<'a>(
    provider: &'a CompiledProvider,
    grant: Option<&UpstreamGrantRecord>,
) -> Option<&'a GrantTransportConfig> {
    let grant = grant?;
    provider.auth.grant_transports.get(&enum_label(&grant.kind))
}

fn provider_upstream_base_url<'a>(
    provider: &'a CompiledProvider,
    grant: Option<&UpstreamGrantRecord>,
) -> Result<&'a str> {
    grant_transport(provider, grant)
        .and_then(|transport| transport.base_url.as_deref())
        .or_else(|| provider.base_urls.get("default").map(String::as_str))
        .ok_or_else(|| {
            Error::RustError(format!(
                "provider `{}` has no default base URL",
                provider.id
            ))
        })
}

fn endpoint_upstream_grant(
    provider: &CompiledProvider,
    endpoint: &CompiledEndpoint,
    grant: Option<UpstreamGrantRecord>,
) -> std::result::Result<(Option<UpstreamGrantRecord>, Option<String>), HeaderBuildError> {
    let Some(grant) = grant else {
        return Ok((None, None));
    };
    let Some(transport) = grant_transport(provider, Some(&grant)) else {
        return Ok((Some(grant), None));
    };
    let Some(path) = transport.endpoint_paths.get(&endpoint.id).cloned() else {
        if !provider_requires_oauth(provider) {
            // Provider policy grants shared fallback access; endpoint transports augment it.
            return Ok((None, None));
        }
        return Err(HeaderBuildError::Client {
            code: "upstream_grant_transport_unsupported",
            message: "upstream grant transport does not support this provider endpoint",
            status: 409,
        });
    };
    Ok((Some(grant), Some(path)))
}

fn apply_grant_transport_headers(
    headers: &Headers,
    provider: &CompiledProvider,
    grant: Option<&UpstreamGrantRecord>,
) -> std::result::Result<(), HeaderBuildError> {
    let Some(transport) = grant_transport(provider, grant) else {
        return Ok(());
    };
    let grant = grant.expect("grant transport requires a grant");
    for (name, value) in &transport.headers {
        headers
            .set(name, &resolve_grant_template(value, grant)?)
            .map_err(HeaderBuildError::Runtime)?;
    }
    Ok(())
}

fn resolve_grant_template(
    value: &str,
    grant: &UpstreamGrantRecord,
) -> std::result::Result<String, HeaderBuildError> {
    let mut resolved = value.to_string();
    for placeholder in template_placeholders(value) {
        let replacement = match placeholder.as_str() {
            "grant.accountId" => grant.account_id.as_deref(),
            "grant.provider" => grant.provider.as_deref(),
            "grant.subscription.plan" => grant
                .subscription
                .as_ref()
                .and_then(|subscription| subscription.plan.as_deref()),
            "grant.subscription.subject" => grant
                .subscription
                .as_ref()
                .and_then(|subscription| subscription.subject.as_deref()),
            _ => None,
        }
        .filter(|replacement| !replacement.trim().is_empty())
        .ok_or(HeaderBuildError::Client {
            code: "upstream_grant_invalid",
            message: "upstream grant is missing transport metadata",
            status: 409,
        })?;
        resolved = resolved.replace(&format!("${{{placeholder}}}"), replacement);
    }
    Ok(resolved)
}

async fn provider_headers(
    incoming: &Headers,
    env: &Env,
    provider: &CompiledProvider,
    endpoint: &CompiledEndpoint,
    grant: Option<&UpstreamGrantRecord>,
    context: HeaderRequestContext<'_>,
) -> std::result::Result<Headers, HeaderBuildError> {
    let headers = Headers::new();
    headers
        .set("content-type", "application/json")
        .map_err(HeaderBuildError::Runtime)?;
    for (name, value) in
        resolved_template_map(provider, &provider.adapter.inject_headers, Some(env))
            .map_err(HeaderBuildError::Runtime)?
    {
        headers
            .set(&name, &value)
            .map_err(HeaderBuildError::Runtime)?;
    }
    for (name, value) in resolved_template_map(provider, &endpoint.headers, Some(env))
        .map_err(HeaderBuildError::Runtime)?
    {
        headers
            .set(&name, &value)
            .map_err(HeaderBuildError::Runtime)?;
    }
    for header in provider
        .adapter
        .passthrough_headers
        .iter()
        .chain(endpoint.request_headers.iter())
    {
        if native_request_header_allowed(provider, endpoint, header) {
            if let Some(value) = incoming.get(header).map_err(HeaderBuildError::Runtime)? {
                headers
                    .set(header, &value)
                    .map_err(HeaderBuildError::Runtime)?;
            }
        }
    }
    apply_grant_transport_headers(&headers, provider, grant)?;
    apply_auth_headers(&headers, env, provider, grant, context)?;
    Ok(headers)
}

async fn native_provider_headers(
    incoming: &Headers,
    env: &Env,
    provider: &CompiledProvider,
    endpoint: &CompiledEndpoint,
    grant: Option<&UpstreamGrantRecord>,
    context: HeaderRequestContext<'_>,
) -> std::result::Result<Headers, HeaderBuildError> {
    let headers = Headers::new();
    for (name, value) in
        resolved_template_map(provider, &provider.adapter.inject_headers, Some(env))
            .map_err(HeaderBuildError::Runtime)?
    {
        headers
            .set(&name, &value)
            .map_err(HeaderBuildError::Runtime)?;
    }
    for (name, value) in resolved_template_map(provider, &endpoint.headers, Some(env))
        .map_err(HeaderBuildError::Runtime)?
    {
        headers
            .set(&name, &value)
            .map_err(HeaderBuildError::Runtime)?;
    }
    // A manifest-declared passthrough is an explicit compatibility contract.
    // Apply it after defaults so version/beta headers from native SDKs survive,
    // while native_request_header_allowed still strips credentials and hops.
    for (name, value) in incoming.entries() {
        if native_request_header_allowed(provider, endpoint, &name) {
            headers
                .set(&name, &value)
                .map_err(HeaderBuildError::Runtime)?;
        }
    }
    apply_grant_transport_headers(&headers, provider, grant)?;
    apply_auth_headers(&headers, env, provider, grant, context)?;
    Ok(headers)
}

fn native_request_header_allowed(
    provider: &CompiledProvider,
    endpoint: &CompiledEndpoint,
    name: &str,
) -> bool {
    let name = name.to_ascii_lowercase();
    if matches!(
        name.as_str(),
        "authorization"
            | "api-key"
            | "cookie"
            | "host"
            | "connection"
            | "content-length"
            | "proxy-authorization"
            | "proxy-connection"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
            | "x-api-key"
            | "x-goog-api-key"
    ) || name.starts_with("cf-")
    {
        return false;
    }
    matches!(
        name.as_str(),
        "accept" | "accept-encoding" | "content-encoding" | "content-type" | "x-request-id"
    ) || provider
        .adapter
        .passthrough_headers
        .iter()
        .chain(endpoint.request_headers.iter())
        .any(|candidate| candidate.eq_ignore_ascii_case(&name))
}

fn sanitize_native_response(response: Response, endpoint: &CompiledEndpoint) -> Result<Response> {
    let status = response.status_code();
    let body = response.body().clone();
    let headers = Headers::new();
    for (name, value) in response.headers().entries() {
        if native_response_header_allowed(endpoint, &name) {
            headers.set(&name, &value)?;
        }
    }
    headers.set(
        UPSTREAM_PROVIDER_HEADER,
        &response
            .headers()
            .get(UPSTREAM_PROVIDER_HEADER)?
            .unwrap_or_default(),
    )?;
    Ok(Response::from_body(body)?
        .with_status(status)
        .with_headers(headers))
}

fn native_response_header_allowed(endpoint: &CompiledEndpoint, name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    if matches!(
        name.as_str(),
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "proxy-connection"
            | "set-cookie"
            | "set-cookie2"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
    ) || name.starts_with("cf-")
    {
        return false;
    }
    matches!(
        name.as_str(),
        "accept-ranges"
            | "cache-control"
            | "content-disposition"
            | "content-encoding"
            | "content-language"
            | "content-length"
            | "content-range"
            | "content-type"
            | "etag"
            | "expires"
            | "last-modified"
            | "location"
            | "retry-after"
            | "request-id"
            | "x-request-id"
    ) || name.starts_with("ratelimit-")
        || name.starts_with("x-ratelimit-")
        || endpoint
            .response_headers
            .iter()
            .any(|candidate| candidate.eq_ignore_ascii_case(&name))
}

fn path_param_value(
    endpoint: &CompiledEndpoint,
    param: &str,
    value: &str,
) -> std::result::Result<String, String> {
    match endpoint
        .path_param_styles
        .get(param)
        .unwrap_or(&PathParamStyle::Segment)
    {
        PathParamStyle::Segment => path_param_segment(endpoint, param, value),
        PathParamStyle::RelativePath => relative_path_param(endpoint, param, value),
    }
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

fn relative_path_param(
    endpoint: &CompiledEndpoint,
    param: &str,
    value: &str,
) -> std::result::Result<String, String> {
    if value.is_empty()
        || value.starts_with('/')
        || value.ends_with('/')
        || value.contains('\\')
        || value.contains('?')
        || value.contains('#')
        || value.chars().any(char::is_control)
    {
        return Err(format!(
            "endpoint `{}` path param `{param}` must be a safe relative path",
            endpoint.id
        ));
    }
    let mut encoded = Vec::new();
    for segment in value.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." {
            return Err(format!(
                "endpoint `{}` path param `{param}` must be a safe relative path",
                endpoint.id
            ));
        }
        encoded.push(encode_component(segment));
    }
    Ok(encoded.join("/"))
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

fn optional_provider_secret(
    env: &Env,
    provider: &CompiledProvider,
    secret_kind: &str,
) -> Option<String> {
    for binding in secret_binding_candidates(provider, secret_kind) {
        if let Ok(secret) = env.secret(&binding) {
            let value = secret.to_string();
            if !value.trim().is_empty() {
                return Some(value);
            }
        }
        if let Ok(var) = env.var(&binding) {
            let value = var.to_string();
            if !value.trim().is_empty() {
                return Some(value);
            }
        }
    }
    None
}

fn resolve_template_value(
    provider: &CompiledProvider,
    value: &str,
    env: Option<&Env>,
) -> Result<String> {
    let placeholders = template_placeholders(value);
    if placeholders.is_empty() {
        return Ok(value.to_string());
    }
    let Some(env) = env else {
        return Err(Error::RustError(format!(
            "provider `{}` requires runtime config for `{value}`",
            provider.id
        )));
    };
    let mut resolved = value.to_string();
    for placeholder in placeholders {
        let replacement = provider_config_value(env, provider, &placeholder)?;
        resolved = resolved.replace(&format!("${{{placeholder}}}"), &replacement);
    }
    Ok(resolved)
}

fn resolved_template_map(
    provider: &CompiledProvider,
    values: &BTreeMap<String, String>,
    env: Option<&Env>,
) -> Result<BTreeMap<String, String>> {
    values
        .iter()
        .map(|(name, value)| {
            resolve_template_value(provider, value, env).map(|value| (name.clone(), value))
        })
        .collect()
}

fn provider_config_value(env: &Env, provider: &CompiledProvider, name: &str) -> Result<String> {
    for binding in template_binding_candidates(provider, name) {
        if let Ok(var) = env.var(&binding) {
            return Ok(var.to_string());
        }
        if let Ok(secret) = env.secret(&binding) {
            return Ok(secret.to_string());
        }
    }
    Err(Error::RustError(format!(
        "missing Cloudflare config value `{name}` for provider `{}`",
        provider.id
    )))
}

fn provider_runtime_error_response(error: Error) -> Result<Response> {
    if let Some(message) = provider_runtime_config_error_message(&error) {
        return json_error("provider_not_configured", &message, 503);
    }
    Err(error)
}

async fn send_upstream_request(request: Request, provider_id: &str) -> Result<Response> {
    match Fetch::Request(request).send().await {
        Ok(response) => {
            let headers = response.headers().clone();
            headers.set(UPSTREAM_PROVIDER_HEADER, provider_id)?;
            Ok(response.with_headers(headers))
        }
        Err(_) => {
            let mut response = json_error(
                "provider_unavailable",
                &provider_transport_error_message(provider_id),
                502,
            )?;
            response
                .headers_mut()
                .set(UPSTREAM_PROVIDER_HEADER, provider_id)?;
            Ok(response)
        }
    }
}

fn provider_transport_error_message(provider_id: &str) -> String {
    format!("upstream request to provider `{provider_id}` failed")
}

fn provider_runtime_config_error_message(error: &Error) -> Option<String> {
    let message = error.to_string();
    (message.starts_with("missing Cloudflare config value")
        || message.starts_with("missing Cloudflare secret")
        || message.contains("requires runtime config"))
    .then_some(message)
}

fn optional_provider_config_value(
    env: &Env,
    provider: &CompiledProvider,
    name: &str,
) -> Option<String> {
    for binding in template_binding_candidates(provider, name) {
        if let Ok(var) = env.var(&binding) {
            return Some(var.to_string());
        }
        if let Ok(secret) = env.secret(&binding) {
            return Some(secret.to_string());
        }
    }
    None
}

fn templates_supported_by_config(provider: &CompiledProvider, value: &str) -> bool {
    template_placeholders(value)
        .iter()
        .all(|name| template_has_config_key(provider, name))
}

fn template_has_config_key(provider: &CompiledProvider, name: &str) -> bool {
    template_binding_candidates(provider, name)
        .iter()
        .any(|candidate| provider.config_keys.iter().any(|key| key == candidate))
}

fn template_binding_candidates(provider: &CompiledProvider, name: &str) -> Vec<String> {
    let normalized_name = normalize_binding_segment(name);
    let mut candidates = Vec::new();
    push_declared_template_candidate(provider, &mut candidates, &normalized_name);
    push_declared_template_candidate(
        provider,
        &mut candidates,
        &format!(
            "{}_{}",
            normalize_binding_segment(&provider.id),
            normalized_name
        ),
    );
    push_declared_template_candidate(
        provider,
        &mut candidates,
        &format!(
            "{}_{}",
            normalize_binding_segment(&provider.service_platform),
            normalized_name
        ),
    );
    for key in &provider.config_keys {
        if key == &normalized_name || key.ends_with(&format!("_{normalized_name}")) {
            push_unique_candidate(&mut candidates, key);
        }
    }
    candidates
}

fn push_declared_template_candidate(
    provider: &CompiledProvider,
    candidates: &mut Vec<String>,
    candidate: &str,
) {
    if provider.config_keys.iter().any(|key| key == candidate) {
        push_unique_candidate(candidates, candidate);
    }
}

fn push_unique_candidate(candidates: &mut Vec<String>, candidate: &str) {
    if !candidates.iter().any(|existing| existing == candidate) {
        candidates.push(candidate.to_string());
    }
}

fn normalize_binding_segment(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_uppercase()
            } else {
                '_'
            }
        })
        .collect()
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

fn apply_auth_headers(
    headers: &Headers,
    env: &Env,
    provider: &CompiledProvider,
    grant: Option<&UpstreamGrantRecord>,
    context: HeaderRequestContext<'_>,
) -> std::result::Result<(), HeaderBuildError> {
    let Some(scheme) = provider.auth.schemes.first() else {
        return Ok(());
    };
    match scheme {
        AuthScheme::Bearer {
            header,
            format,
            secret_kind,
            required,
        } => {
            let secret = match grant.and_then(upstream_grant_secret).map(str::to_string) {
                Some(secret) => secret,
                None if !*required => {
                    let Some(secret) = optional_provider_secret(env, provider, secret_kind) else {
                        return Ok(());
                    };
                    secret
                }
                None => provider_secret(env, provider, secret_kind)
                    .map_err(HeaderBuildError::Runtime)?,
            };
            headers
                .set(header, &format.replace("${secret}", &secret))
                .map_err(HeaderBuildError::Runtime)?;
            Ok(())
        }
        AuthScheme::ApiKey {
            header,
            secret_kind,
        } => {
            let secret = grant
                .and_then(upstream_grant_secret)
                .map(str::to_string)
                .map(Ok)
                .unwrap_or_else(|| {
                    provider_secret(env, provider, secret_kind).map_err(HeaderBuildError::Runtime)
                })?;
            headers
                .set(header, &secret)
                .map_err(HeaderBuildError::Runtime)?;
            Ok(())
        }
        AuthScheme::QueryApiKey { .. } | AuthScheme::CloudflareBinding => Ok(()),
        AuthScheme::OAuth { .. } => {
            let token = grant.expect("required upstream grant resolver returned no grant");
            headers
                .set(
                    "authorization",
                    &format!(
                        "{} {}",
                        token.token_type,
                        upstream_grant_secret(token).unwrap_or_default()
                    ),
                )
                .map_err(HeaderBuildError::Runtime)?;
            Ok(())
        }
        AuthScheme::SigV4 {
            service,
            region_param,
        } => {
            let signed = sigv4_headers(
                env,
                provider,
                grant,
                service,
                region_param.as_deref(),
                context,
            )
            .map_err(HeaderBuildError::Runtime)?;
            for (name, value) in signed {
                headers
                    .set(&name, &value)
                    .map_err(HeaderBuildError::Runtime)?;
            }
            Ok(())
        }
    }
}

async fn upstream_grant_for_request(
    env: &Env,
    provider: &CompiledProvider,
    endpoint: &CompiledEndpoint,
    auth: &AuthorizedKey,
) -> std::result::Result<Option<UpstreamGrantRecord>, HeaderBuildError> {
    match provider.auth.schemes.first() {
        Some(AuthScheme::OAuth {
            provider: oauth_provider,
            token_ref,
            ..
        }) => {
            selected_upstream_grant(
                env,
                provider,
                endpoint,
                auth,
                oauth_provider.as_deref(),
                token_ref.as_deref(),
                true,
            )
            .await
        }
        Some(
            AuthScheme::Bearer { .. }
            | AuthScheme::ApiKey { .. }
            | AuthScheme::QueryApiKey { .. }
            | AuthScheme::SigV4 { .. },
        ) => selected_upstream_grant(env, provider, endpoint, auth, None, None, false).await,
        _ => Ok(None),
    }
}

async fn selected_upstream_grant(
    env: &Env,
    provider: &CompiledProvider,
    endpoint: &CompiledEndpoint,
    auth: &AuthorizedKey,
    oauth_provider: Option<&str>,
    token_ref: Option<&str>,
    required: bool,
) -> std::result::Result<Option<UpstreamGrantRecord>, HeaderBuildError> {
    let kv = match env.kv("POLICY_KV") {
        Ok(kv) => kv,
        Err(_) if !required => return Ok(None),
        Err(_) => {
            return Err(HeaderBuildError::Client {
                code: "policy_store_unavailable",
                message: "POLICY_KV binding is required for upstream grant requests",
                status: 503,
            });
        }
    };
    for key in upstream_grant_keys(provider, auth, oauth_provider, token_ref) {
        let Some(mut grant) = get_upstream_grant(&kv, &key)
            .await
            .map_err(HeaderBuildError::Runtime)?
        else {
            continue;
        };
        if !provider_requires_oauth(provider)
            && !grant_kind_supports_endpoint(provider, endpoint, grant.kind)
        {
            continue;
        }
        if grant.refresh.is_none() && grant.refresh_token.is_some() {
            grant.refresh = upstream_grant_refresh_from_manifest(provider);
        }
        if grant
            .provider
            .as_deref()
            .is_some_and(|grant_provider| grant_provider != provider.id)
        {
            return Err(HeaderBuildError::Client {
                code: "upstream_grant_invalid",
                message: "upstream grant does not match the requested provider",
                status: 403,
            });
        }
        if !grant.enabled {
            return Err(HeaderBuildError::Client {
                code: "upstream_grant_revoked",
                message: "upstream grant is revoked for this policy",
                status: 403,
            });
        }
        if upstream_grant_needs_refresh(&grant) {
            grant = refresh_upstream_grant(env, &kv, &key, grant, false).await?;
        }
        if !upstream_grant_usable(&grant) || !upstream_grant_supports_provider(provider, &grant) {
            return Err(HeaderBuildError::Client {
                code: "upstream_grant_invalid",
                message: "upstream grant is missing a usable credential",
                status: 403,
            });
        }
        return Ok(Some(grant));
    }
    if required {
        return Err(HeaderBuildError::Client {
            code: "upstream_grant_missing",
            message: "upstream grant is not registered for this policy",
            status: 403,
        });
    }
    Ok(None)
}

async fn refresh_upstream_grant(
    env: &Env,
    kv: &KvStore,
    key: &str,
    mut grant: UpstreamGrantRecord,
    force: bool,
) -> std::result::Result<UpstreamGrantRecord, HeaderBuildError> {
    if !force && !upstream_grant_needs_refresh(&grant) {
        return Ok(grant);
    }
    if !grant.enabled {
        return Err(HeaderBuildError::Client {
            code: "upstream_grant_revoked",
            message: "upstream grant is revoked for this policy",
            status: 403,
        });
    }
    if !matches!(
        grant.kind,
        UpstreamGrantKind::OAuth | UpstreamGrantKind::Subscription
    ) {
        return Err(HeaderBuildError::Client {
            code: "upstream_grant_not_refreshable",
            message: "upstream grant kind cannot be refreshed",
            status: 409,
        });
    }
    let Some(refresh_token) = grant
        .refresh_token
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    else {
        return Err(HeaderBuildError::Client {
            code: "upstream_grant_not_refreshable",
            message: "upstream grant has no refresh token",
            status: 409,
        });
    };
    let Some(refresh) = grant.refresh.as_ref() else {
        return Err(HeaderBuildError::Client {
            code: "upstream_grant_not_refreshable",
            message: "upstream grant has no refresh configuration",
            status: 409,
        });
    };
    let Some(provider_id) = grant.provider.as_deref() else {
        return Err(HeaderBuildError::Client {
            code: "upstream_grant_not_refreshable",
            message: "upstream grant must identify its provider before refresh",
            status: 409,
        });
    };
    let snapshot = provider_snapshot().map_err(HeaderBuildError::Runtime)?;
    let Some(provider) = snapshot
        .providers
        .iter()
        .find(|provider| provider.id == provider_id)
    else {
        return Err(HeaderBuildError::Client {
            code: "upstream_grant_not_refreshable",
            message: "upstream grant provider is not registered",
            status: 409,
        });
    };
    if !provider_approves_refresh(provider, refresh) {
        return Err(HeaderBuildError::Client {
            code: "upstream_grant_refresh_not_approved",
            message: "provider manifest does not approve this refresh configuration",
            status: 409,
        });
    }
    let client_id = match (
        refresh
            .client_id
            .as_deref()
            .filter(|value| !value.trim().is_empty()),
        refresh.client_id_config.as_deref(),
    ) {
        (Some(client_id), _) => client_id.to_string(),
        (None, Some(config)) => {
            exact_runtime_config_value(env, config).map_err(|_| HeaderBuildError::Client {
                code: "upstream_grant_refresh_not_configured",
                message: "OAuth refresh client configuration is missing",
                status: 503,
            })?
        }
        (None, None) => {
            return Err(HeaderBuildError::Client {
                code: "upstream_grant_refresh_not_configured",
                message: "OAuth refresh client configuration is missing",
                status: 503,
            });
        }
    };
    let client_secret = refresh
        .client_secret_config
        .as_deref()
        .map(|name| exact_runtime_config_value(env, name))
        .transpose()
        .map_err(|_| HeaderBuildError::Client {
            code: "upstream_grant_refresh_not_configured",
            message: "OAuth refresh client configuration is missing",
            status: 503,
        })?;
    let mut form = BTreeMap::from([
        ("client_id".to_string(), client_id),
        ("grant_type".to_string(), "refresh_token".to_string()),
        ("refresh_token".to_string(), refresh_token.to_string()),
    ]);
    if let Some(client_secret) = client_secret {
        form.insert("client_secret".to_string(), client_secret);
    }
    for (name, value) in &refresh.extra_params {
        form.insert(name.clone(), value.clone());
    }
    let body = form_urlencoded(&form);
    let headers = Headers::new();
    headers
        .set("accept", "application/json")
        .map_err(HeaderBuildError::Runtime)?;
    headers
        .set("content-type", "application/x-www-form-urlencoded")
        .map_err(HeaderBuildError::Runtime)?;
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(JsValue::from_str(&body)));
    let request =
        Request::new_with_init(&refresh.token_url, &init).map_err(HeaderBuildError::Runtime)?;
    let mut response =
        Fetch::Request(request)
            .send()
            .await
            .map_err(|_| HeaderBuildError::Client {
                code: "upstream_grant_refresh_failed",
                message: "upstream OAuth refresh request failed",
                status: 502,
            })?;
    if !(200..=299).contains(&response.status_code()) {
        return Err(HeaderBuildError::Client {
            code: "upstream_grant_refresh_failed",
            message: "upstream OAuth refresh request was rejected",
            status: 502,
        });
    }
    let refreshed =
        response
            .json::<OAuthRefreshResponse>()
            .await
            .map_err(|_| HeaderBuildError::Client {
                code: "upstream_grant_refresh_failed",
                message: "upstream OAuth refresh response was invalid",
                status: 502,
            })?;
    if refreshed.access_token.trim().is_empty() {
        return Err(HeaderBuildError::Client {
            code: "upstream_grant_refresh_failed",
            message: "upstream OAuth refresh response was invalid",
            status: 502,
        });
    }
    grant.access_token = Some(refreshed.access_token);
    if let Some(refresh_token) = refreshed
        .refresh_token
        .filter(|value| !value.trim().is_empty())
    {
        grant.refresh_token = Some(refresh_token);
    }
    if let Some(token_type) = refreshed
        .token_type
        .filter(|value| !value.trim().is_empty())
    {
        grant.token_type = token_type;
    }
    if let Some(expires_in) = refreshed.expires_in {
        grant.expires_at = Some(timestamp_after_seconds(expires_in));
    }
    if let Some(scope) = refreshed.scope {
        grant.scopes = normalize_grant_scopes(
            scope
                .split_ascii_whitespace()
                .map(str::to_string)
                .collect::<Vec<_>>(),
        )
        .map_err(|_| HeaderBuildError::Client {
            code: "upstream_grant_refresh_failed",
            message: "upstream OAuth refresh response was invalid",
            status: 502,
        })?;
    }
    grant.updated_at = Some(current_iso_timestamp());
    put_kv_record(kv, key, &grant, "refreshed upstream grant")
        .await
        .map_err(HeaderBuildError::Runtime)?;
    Ok(grant)
}

fn provider_approves_refresh(provider: &CompiledProvider, refresh: &UpstreamGrantRefresh) -> bool {
    provider.auth.refresh.as_ref().is_some_and(|approved| {
        approved.token_url == refresh.token_url
            && approved.client_id == refresh.client_id
            && approved.client_id_config == refresh.client_id_config
            && approved.client_secret_config == refresh.client_secret_config
            && approved.extra_params == refresh.extra_params
    })
}

fn upstream_grant_refresh_from_manifest(
    provider: &CompiledProvider,
) -> Option<UpstreamGrantRefresh> {
    let refresh = provider.auth.refresh.as_ref()?;
    Some(UpstreamGrantRefresh {
        token_url: refresh.token_url.clone(),
        client_id: refresh.client_id.clone(),
        client_id_config: refresh.client_id_config.clone(),
        client_secret_config: refresh.client_secret_config.clone(),
        extra_params: refresh.extra_params.clone(),
    })
}

fn exact_runtime_config_value(env: &Env, name: &str) -> Result<String> {
    if let Ok(secret) = env.secret(name) {
        let value = secret.to_string();
        if !value.trim().is_empty() {
            return Ok(value);
        }
    }
    if let Ok(var) = env.var(name) {
        let value = var.to_string();
        if !value.trim().is_empty() {
            return Ok(value);
        }
    }
    Err(Error::RustError(format!(
        "missing Cloudflare config value `{name}`"
    )))
}

fn form_urlencoded(values: &BTreeMap<String, String>) -> String {
    values
        .iter()
        .map(|(name, value)| format!("{}={}", encode_component(name), encode_component(value)))
        .collect::<Vec<_>>()
        .join("&")
}

fn timestamp_after_seconds(seconds: u64) -> String {
    let date = js_sys::Date::new(&JsValue::from_f64(
        js_sys::Date::now() + seconds as f64 * 1_000.0,
    ));
    date.to_iso_string().into()
}

fn timestamp_from_epoch_ms(epoch_ms: u64) -> String {
    let date = js_sys::Date::new(&JsValue::from_f64(epoch_ms as f64));
    date.to_iso_string().into()
}

fn parse_upstream_grant_record(raw: &str) -> Result<UpstreamGrantRecord> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(Error::RustError("upstream grant is empty".to_string()));
    }
    if !trimmed.starts_with('{') {
        return Ok(UpstreamGrantRecord {
            version: default_upstream_grant_version(),
            enabled: true,
            kind: UpstreamGrantKind::OAuth,
            provider: None,
            label: None,
            credential: None,
            credentials: BTreeMap::new(),
            access_token: Some(trimmed.to_string()),
            refresh_token: None,
            token_type: default_oauth_token_type(),
            expires_at: None,
            scopes: Vec::new(),
            account_id: None,
            subscription: None,
            refresh: None,
            created_at: None,
            updated_at: None,
            revoked_at: None,
        });
    }
    serde_json::from_str(trimmed)
        .map_err(|error| Error::RustError(format!("upstream grant is invalid JSON: {error}")))
}

fn upstream_grant_keys(
    provider: &CompiledProvider,
    auth: &AuthorizedKey,
    oauth_provider: Option<&str>,
    token_ref: Option<&str>,
) -> Vec<String> {
    let mut refs = Vec::new();
    if let Some(token_ref) = token_ref.filter(|value| !value.is_empty()) {
        refs.push(token_ref.to_string());
    }
    if let Some(oauth_provider) = oauth_provider.filter(|value| !value.is_empty()) {
        refs.push(oauth_provider.to_string());
    }
    refs.push(provider.id.clone());
    dedupe_preserving_order(&mut refs);

    let mut keys = refs
        .iter()
        .map(|token_ref| format!("oauth/{}/{token_ref}", auth.policy_id))
        .collect::<Vec<_>>();
    let tenant = tenant_id(auth);
    keys.extend(
        refs.iter()
            .map(|token_ref| format!("oauth/tenants/{tenant}/{token_ref}")),
    );
    keys
}

fn dedupe_preserving_order(values: &mut Vec<String>) {
    let mut deduped = Vec::with_capacity(values.len());
    for value in values.drain(..) {
        if !deduped.iter().any(|existing| existing == &value) {
            deduped.push(value);
        }
    }
    *values = deduped;
}

fn sigv4_headers(
    env: &Env,
    provider: &CompiledProvider,
    grant: Option<&UpstreamGrantRecord>,
    service: &str,
    region_param: Option<&str>,
    context: HeaderRequestContext<'_>,
) -> Result<BTreeMap<String, String>> {
    let access_key_id = grant
        .and_then(|grant| upstream_grant_credential_field(grant, "accessKeyId"))
        .map(str::to_string)
        .map(Ok)
        .unwrap_or_else(|| provider_config_value(env, provider, "access_key_id"))?;
    let secret_access_key = grant
        .and_then(|grant| upstream_grant_credential_field(grant, "secretAccessKey"))
        .map(str::to_string)
        .map(Ok)
        .unwrap_or_else(|| provider_config_value(env, provider, "secret_access_key"))?;
    let region = provider_config_value(env, provider, region_param.unwrap_or("region"))?;
    let session_token = grant
        .and_then(|grant| upstream_grant_credential_field(grant, "sessionToken"))
        .map(str::to_string)
        .or_else(|| optional_provider_config_value(env, provider, "session_token"));
    sigv4_headers_at(
        &access_key_id,
        &secret_access_key,
        session_token.as_deref(),
        &region,
        service,
        context,
        &aws_amz_date_now()?,
    )
}

fn sigv4_headers_at(
    access_key_id: &str,
    secret_access_key: &str,
    session_token: Option<&str>,
    region: &str,
    service: &str,
    context: HeaderRequestContext<'_>,
    amz_date: &str,
) -> Result<BTreeMap<String, String>> {
    let (host, canonical_uri, canonical_query) = sigv4_url_parts(context.url)?;
    let date_stamp = amz_date
        .get(0..8)
        .ok_or_else(|| Error::RustError("invalid SigV4 date".to_string()))?;
    let payload_hash = sha256_hex_bytes(context.body.unwrap_or_default());
    let mut canonical_headers = BTreeMap::from([
        ("host".to_string(), host.clone()),
        ("x-amz-content-sha256".to_string(), payload_hash.clone()),
        ("x-amz-date".to_string(), amz_date.to_string()),
    ]);
    if let Some(session_token) = session_token.filter(|value| !value.is_empty()) {
        canonical_headers.insert(
            "x-amz-security-token".to_string(),
            session_token.to_string(),
        );
    }
    let signed_headers = canonical_headers
        .keys()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .join(";");
    let canonical_header_block = canonical_headers
        .iter()
        .map(|(name, value)| format!("{name}:{}\n", value.trim()))
        .collect::<String>();
    let canonical_request = format!(
        "{}\n{}\n{}\n{}\n{}\n{}",
        context.method,
        canonical_uri,
        canonical_query,
        canonical_header_block,
        signed_headers,
        payload_hash
    );
    let credential_scope = format!("{date_stamp}/{region}/{service}/aws4_request");
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{}\n{}\n{}",
        amz_date,
        credential_scope,
        sha256_hex(&canonical_request)
    );
    let signing_key = sigv4_signing_key(secret_access_key, date_stamp, region, service)?;
    let signature = bytes_to_hex(&hmac_sha256(&signing_key, &string_to_sign)?);
    let authorization = format!(
        "AWS4-HMAC-SHA256 Credential={}/{}, SignedHeaders={}, Signature={}",
        access_key_id, credential_scope, signed_headers, signature
    );

    let mut headers = BTreeMap::from([
        ("authorization".to_string(), authorization),
        ("x-amz-content-sha256".to_string(), payload_hash),
        ("x-amz-date".to_string(), amz_date.to_string()),
    ]);
    if let Some(session_token) = session_token.filter(|value| !value.is_empty()) {
        headers.insert(
            "x-amz-security-token".to_string(),
            session_token.to_string(),
        );
    }
    Ok(headers)
}

fn sigv4_signing_key(
    secret_access_key: &str,
    date_stamp: &str,
    region: &str,
    service: &str,
) -> Result<Vec<u8>> {
    let date_key = hmac_sha256(format!("AWS4{secret_access_key}").as_bytes(), date_stamp)?;
    let region_key = hmac_sha256(&date_key, region)?;
    let service_key = hmac_sha256(&region_key, service)?;
    hmac_sha256(&service_key, "aws4_request")
}

fn hmac_sha256(key: &[u8], data: &str) -> Result<Vec<u8>> {
    let mut mac = HmacSha256::new_from_slice(key)
        .map_err(|error| Error::RustError(format!("failed to initialize HMAC: {error}")))?;
    mac.update(data.as_bytes());
    Ok(mac.finalize().into_bytes().to_vec())
}

fn sigv4_url_parts(url: &str) -> Result<(String, String, String)> {
    let without_scheme = url
        .strip_prefix("https://")
        .ok_or_else(|| Error::RustError("SigV4 upstream URL must use https".to_string()))?;
    let (host, path_query) = without_scheme
        .split_once('/')
        .map(|(host, rest)| (host, format!("/{rest}")))
        .unwrap_or((without_scheme, "/".to_string()));
    let (path, query) = path_query
        .split_once('?')
        .map(|(path, query)| (path.to_string(), query.to_string()))
        .unwrap_or((path_query, String::new()));
    Ok((host.to_ascii_lowercase(), path, query))
}

fn aws_amz_date_now() -> Result<String> {
    let iso: String = js_sys::Date::new_0().to_iso_string().into();
    let date = iso
        .get(0..10)
        .ok_or_else(|| Error::RustError("failed to format AWS date".to_string()))?
        .replace('-', "");
    let time = iso
        .get(11..19)
        .ok_or_else(|| Error::RustError("failed to format AWS time".to_string()))?
        .replace(':', "");
    Ok(format!("{date}T{time}Z"))
}

fn query_api_key_for_grant(
    provider: &CompiledProvider,
    env: &Env,
    grant: Option<&UpstreamGrantRecord>,
) -> std::result::Result<Option<(String, String)>, HeaderBuildError> {
    for scheme in &provider.auth.schemes {
        if let AuthScheme::QueryApiKey { param, secret_kind } = scheme {
            let secret = grant
                .and_then(upstream_grant_secret)
                .map(str::to_string)
                .map(Ok)
                .unwrap_or_else(|| {
                    provider_secret(env, provider, secret_kind).map_err(HeaderBuildError::Runtime)
                })?;
            return Ok(Some((param.clone(), secret)));
        }
    }
    Ok(None)
}

fn method_from_str(method: &str) -> Result<Method> {
    match method {
        "GET" => Ok(Method::Get),
        "HEAD" => Ok(Method::Head),
        "POST" => Ok(Method::Post),
        "PUT" => Ok(Method::Put),
        "PATCH" => Ok(Method::Patch),
        "DELETE" => Ok(Method::Delete),
        _ => Err(Error::RustError(format!("unsupported method `{method}`"))),
    }
}

fn method_allows_body(method: &str) -> bool {
    !matches!(method, "GET" | "HEAD")
}

fn native_request_needs_json_inspection(
    compatibility_route: bool,
    capability: &str,
    policy: &AccessPolicy,
) -> bool {
    compatibility_route || (capability.starts_with("llm.") && policy.request_cost_micros.is_none())
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

#[derive(Clone, Debug, Default)]
struct AgentAttribution {
    session_id: Option<String>,
    agent_id: Option<String>,
    parent_agent_id: Option<String>,
    project_id: Option<String>,
    client: Option<String>,
}

#[derive(Default)]
struct AttributionCandidates {
    explicit_session_id: Option<String>,
    claude_session_id: Option<String>,
    codex_session_id: Option<String>,
    explicit_agent_id: Option<String>,
    claude_agent_id: Option<String>,
    explicit_parent_agent_id: Option<String>,
    claude_parent_agent_id: Option<String>,
    project_id: Option<String>,
    explicit_client: Option<String>,
}

fn resolve_attribution(candidates: AttributionCandidates) -> AgentAttribution {
    let client = candidates
        .explicit_client
        .or_else(|| {
            candidates
                .claude_session_id
                .as_ref()
                .map(|_| "claude_code".to_string())
        })
        .or_else(|| {
            candidates
                .codex_session_id
                .as_ref()
                .map(|_| "codex".to_string())
        });
    AgentAttribution {
        session_id: candidates
            .explicit_session_id
            .or(candidates.claude_session_id)
            .or(candidates.codex_session_id),
        agent_id: candidates.explicit_agent_id.or(candidates.claude_agent_id),
        parent_agent_id: candidates
            .explicit_parent_agent_id
            .or(candidates.claude_parent_agent_id),
        project_id: candidates.project_id,
        client,
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum RequestCostBasis {
    FixedPolicy,
    ListedPrice,
    FlatFallback,
    #[default]
    None,
}

impl RequestCostBasis {
    fn label(self) -> &'static str {
        match self {
            Self::FixedPolicy => "fixed_policy",
            Self::ListedPrice => "listed_price",
            Self::FlatFallback => "flat_fallback",
            Self::None => "none",
        }
    }
}

#[derive(Clone, Debug, Default)]
struct RequestCost {
    reserve_micros: u64,
    estimate: RequestCostEstimate,
    pricing_ref: Option<String>,
    pricing: Option<ModelPricing>,
    basis: RequestCostBasis,
}

impl RequestCost {
    fn for_capability(
        capability: &str,
        policy: &AccessPolicy,
        pricing_ref: Option<&str>,
        pricing: Option<&ModelPricing>,
        request_body: &[u8],
        request_json: Option<&Value>,
    ) -> Self {
        if capability == "llm.count_tokens" {
            return Self::default();
        }
        Self::for_request(policy, pricing_ref, pricing, request_body, request_json)
    }

    fn for_request(
        policy: &AccessPolicy,
        pricing_ref: Option<&str>,
        pricing: Option<&ModelPricing>,
        request_body: &[u8],
        request_json: Option<&Value>,
    ) -> Self {
        if let Some(reserve_micros) = policy.request_cost_micros {
            return Self {
                reserve_micros,
                basis: RequestCostBasis::FixedPolicy,
                ..Self::default()
            };
        }
        if let Some(pricing) = pricing {
            let estimate = pricing.estimate_request_cost(request_body, request_json);
            return Self {
                reserve_micros: estimate.reserved_cost_micros,
                estimate,
                pricing_ref: pricing_ref.map(str::to_string),
                pricing: Some(pricing.clone()),
                basis: RequestCostBasis::ListedPrice,
            };
        }
        Self {
            reserve_micros: 1,
            basis: RequestCostBasis::FlatFallback,
            ..Self::default()
        }
    }

    fn actual_micros(&self, status_code: u16, tokens: UsageTokens, complete: bool) -> u64 {
        if !(200..=299).contains(&status_code) {
            return 0;
        }
        let Some(pricing) = self.pricing.as_ref() else {
            return self.reserve_micros;
        };
        let Some(input_tokens) = tokens.input else {
            return self.reserve_micros;
        };
        if !complete
            || (tokens.output.is_none() && pricing.output_tokens_are_billable(input_tokens))
        {
            return self.reserve_micros;
        }
        pricing.actual_cost_micros(PricedTokenUsage {
            input_tokens,
            output_tokens: tokens.output.unwrap_or_default(),
            cached_input_tokens: tokens.cached_input.unwrap_or_default(),
            cache_write_5m_input_tokens: tokens.cache_write_5m_input.unwrap_or_default(),
            cache_write_1h_input_tokens: tokens.cache_write_1h_input.unwrap_or_default(),
            cache_write_input_tokens: tokens.cache_write_input.unwrap_or_default(),
        })
    }
}

#[derive(Clone, Debug, Default)]
struct BudgetUsage {
    reservation_id: Option<String>,
    reserved_cost_micros: u64,
    actual_cost_micros: u64,
}

enum BudgetPreflight {
    Allowed(BudgetUsage),
    Denied(Response),
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BudgetReserveRequest {
    policy_id: String,
    window_key: String,
    limit_micros: u64,
    cost_micros: u64,
    reservation_id: String,
    capability: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BudgetReserveResponse {
    allowed: bool,
    policy_id: String,
    window_key: String,
    charged_micros: u64,
    spent_micros: u64,
    remaining_micros: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BudgetStatusResponse {
    policy_id: String,
    window_key: String,
    limit_micros: u64,
    spent_micros: u64,
    remaining_micros: u64,
}

#[derive(Debug, Deserialize)]
struct BudgetSpendRow {
    spent_micros: i64,
}

#[derive(Debug, Deserialize)]
struct BudgetReservationRow {
    window_key: String,
    policy_id: String,
    reserved_micros: i64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BudgetSettleRequest {
    reservation_id: String,
    actual_cost_micros: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BudgetSettleResponse {
    settled: bool,
    charged_micros: u64,
    spent_micros: u64,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum QueueMessage {
    Usage(Box<UsageEvent>),
    Job(QueueJob),
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum QueueJob {
    BudgetSettlement {
        tenant_id: String,
        policy_id: String,
        request: BudgetSettleRequest,
    },
}

#[durable_object]
pub struct PolicyBindingIndexObject {
    state: State,
    _env: Env,
}

impl DurableObject for PolicyBindingIndexObject {
    fn new(state: State, env: Env) -> Self {
        Self { state, _env: env }
    }

    async fn fetch(&self, mut req: Request) -> Result<Response> {
        let url = req.url()?;
        if req.method() == Method::Post && url.path() == "/resolve" {
            let request =
                serde_json::from_str::<PolicyBindingIndexResolveRequest>(&req.text().await?)
                    .map_err(|error| {
                        Error::RustError(format!(
                            "policy binding resolve request is invalid JSON: {error}"
                        ))
                    })?;
            let response = resolve_policy_binding_index_in_object(&self.state, request.principals)?;
            return Response::from_json(&response);
        }
        if req.method() == Method::Post && url.path() == "/initialize" {
            let seeds = serde_json::from_str::<Vec<PolicyBindingIndexSeed>>(&req.text().await?)
                .map_err(|error| {
                    Error::RustError(format!(
                        "policy binding initialize request is invalid JSON: {error}"
                    ))
                })?;
            initialize_policy_binding_index_in_object(&self.state, seeds)?;
            return Response::ok("initialized");
        }
        if req.method() == Method::Post && url.path() == "/initialize-all" {
            let bindings = serde_json::from_str::<Vec<PolicyBindingRecord>>(&req.text().await?)
                .map_err(|error| {
                    Error::RustError(format!(
                        "policy binding initialize-all request is invalid JSON: {error}"
                    ))
                })?;
            initialize_all_policy_bindings_in_object(&self.state, bindings)?;
            return Response::ok("initialized");
        }
        if req.method() == Method::Post && url.path() == "/list" {
            let response = list_policy_bindings_in_object(&self.state)?;
            return Response::from_json(&response);
        }
        if req.method() == Method::Post && url.path() == "/mutate" {
            let request =
                serde_json::from_str::<PolicyBindingIndexMutationRequest>(&req.text().await?)
                    .map_err(|error| {
                        Error::RustError(format!(
                            "policy binding mutation request is invalid JSON: {error}"
                        ))
                    })?;
            mutate_policy_binding_index_in_object(&self.state, request)?;
            return Response::ok("updated");
        }
        if req.method() == Method::Post && url.path() == "/users/resolve" {
            let request =
                serde_json::from_str::<AccessControlUsersResolveRequest>(&req.text().await?)
                    .map_err(|error| {
                        Error::RustError(format!(
                            "access user resolve request is invalid JSON: {error}"
                        ))
                    })?;
            let response = resolve_access_control_users_in_object(&self.state, request.emails)?;
            return Response::from_json(&response);
        }
        if req.method() == Method::Post && url.path() == "/users/initialize" {
            let users = serde_json::from_str::<Vec<AccessControlUser>>(&req.text().await?)
                .map_err(|error| {
                    Error::RustError(format!(
                        "access user initialize request is invalid JSON: {error}"
                    ))
                })?;
            initialize_access_control_users_in_object(&self.state, users)?;
            return Response::ok("initialized");
        }
        if req.method() == Method::Post && url.path() == "/users/initialize-all" {
            let users = serde_json::from_str::<Vec<AccessControlUser>>(&req.text().await?)
                .map_err(|error| {
                    Error::RustError(format!(
                        "access user initialize-all request is invalid JSON: {error}"
                    ))
                })?;
            initialize_all_access_control_users_in_object(&self.state, users)?;
            return Response::ok("initialized");
        }
        if req.method() == Method::Post && url.path() == "/users/list" {
            return Response::from_json(&list_access_control_users_in_object(&self.state)?);
        }
        if req.method() == Method::Post && url.path() == "/users/put" {
            let user =
                serde_json::from_str::<AccessControlUser>(&req.text().await?).map_err(|error| {
                    Error::RustError(format!("access user put request is invalid JSON: {error}"))
                })?;
            put_access_control_user_in_object(&self.state, user)?;
            return Response::ok("updated");
        }
        if req.method() == Method::Post && url.path() == "/users/put-bindings" {
            let request =
                serde_json::from_str::<AccessControlUserBindingsPutRequest>(&req.text().await?)
                    .map_err(|error| {
                        Error::RustError(format!(
                            "access user and bindings put request is invalid JSON: {error}"
                        ))
                    })?;
            let bindings = put_access_control_user_bindings_in_object(&self.state, request).await?;
            return Response::from_json(&AccessControlUserBindingsPutResponse { bindings });
        }
        if req.method() == Method::Post && url.path() == "/policies/resolve" {
            let request =
                serde_json::from_str::<AccessControlPoliciesResolveRequest>(&req.text().await?)
                    .map_err(|error| {
                        Error::RustError(format!(
                            "access policy resolve request is invalid JSON: {error}"
                        ))
                    })?;
            let response =
                resolve_access_control_policies_in_object(&self.state, request.policy_ids)?;
            return Response::from_json(&response);
        }
        if req.method() == Method::Post && url.path() == "/policies/initialize" {
            let policies = serde_json::from_str::<Vec<AccessPolicyEntry>>(&req.text().await?)
                .map_err(|error| {
                    Error::RustError(format!(
                        "access policy initialize request is invalid JSON: {error}"
                    ))
                })?;
            initialize_access_control_policies_in_object(&self.state, policies)?;
            return Response::ok("initialized");
        }
        if req.method() == Method::Post && url.path() == "/policies/put" {
            let policy =
                serde_json::from_str::<AccessPolicyEntry>(&req.text().await?).map_err(|error| {
                    Error::RustError(format!(
                        "access policy put request is invalid JSON: {error}"
                    ))
                })?;
            put_access_control_policy_in_object(&self.state, policy)?;
            return Response::ok("updated");
        }
        if req.method() == Method::Post && url.path() == "/policy-credentials/put" {
            let request =
                serde_json::from_str::<AccessControlPolicyCredentialPutRequest>(&req.text().await?)
                    .map_err(|error| {
                        Error::RustError(format!(
                            "policy and credential put request is invalid JSON: {error}"
                        ))
                    })?;
            put_access_control_policy_and_credential_in_object(&self.state, request).await?;
            return Response::ok("updated");
        }
        if req.method() == Method::Post && url.path() == "/policies/list" {
            return Response::from_json(&list_access_control_policies_in_object(&self.state)?);
        }
        if req.method() == Method::Post && url.path() == "/credentials/resolve" {
            let request =
                serde_json::from_str::<AccessControlCredentialsResolveRequest>(&req.text().await?)
                    .map_err(|error| {
                        Error::RustError(format!(
                            "proxy credential resolve request is invalid JSON: {error}"
                        ))
                    })?;
            let response =
                resolve_access_control_credentials_in_object(&self.state, request.credential_ids)?;
            return Response::from_json(&response);
        }
        if req.method() == Method::Post && url.path() == "/credentials/initialize" {
            let credentials = serde_json::from_str::<Vec<ProxyCredentialEntry>>(&req.text().await?)
                .map_err(|error| {
                    Error::RustError(format!(
                        "proxy credential initialize request is invalid JSON: {error}"
                    ))
                })?;
            initialize_access_control_credentials_in_object(&self.state, credentials)?;
            return Response::ok("initialized");
        }
        if req.method() == Method::Post && url.path() == "/credentials/put" {
            let credential = serde_json::from_str::<ProxyCredentialEntry>(&req.text().await?)
                .map_err(|error| {
                    Error::RustError(format!(
                        "proxy credential put request is invalid JSON: {error}"
                    ))
                })?;
            put_access_control_credential_in_object(&self.state, credential)?;
            return Response::ok("updated");
        }
        if req.method() == Method::Post && url.path() == "/credentials/list" {
            return Response::from_json(&list_access_control_credentials_in_object(&self.state)?);
        }
        if req.method() == Method::Post && url.path() == "/connections/resolve" {
            let request =
                serde_json::from_str::<AccessControlConnectionsResolveRequest>(&req.text().await?)
                    .map_err(|error| {
                        Error::RustError(format!(
                            "provider connection resolve request is invalid JSON: {error}"
                        ))
                    })?;
            let response =
                resolve_access_control_connections_in_object(&self.state, request.provider_ids)?;
            return Response::from_json(&response);
        }
        if req.method() == Method::Post && url.path() == "/connections/initialize" {
            let connections = serde_json::from_str::<Vec<ProviderConnectionRecord>>(
                &req.text().await?,
            )
            .map_err(|error| {
                Error::RustError(format!(
                    "provider connection initialize request is invalid JSON: {error}"
                ))
            })?;
            initialize_access_control_connections_in_object(&self.state, connections)?;
            return Response::ok("initialized");
        }
        if req.method() == Method::Post && url.path() == "/connections/put" {
            let connection = serde_json::from_str::<ProviderConnectionRecord>(&req.text().await?)
                .map_err(|error| {
                Error::RustError(format!(
                    "provider connection put request is invalid JSON: {error}"
                ))
            })?;
            put_access_control_connection_in_object(&self.state, connection)?;
            return Response::ok("updated");
        }
        if req.method() == Method::Post && url.path() == "/oauth-states/put" {
            let state = serde_json::from_str::<OAuthAuthorizationState>(&req.text().await?)
                .map_err(|error| {
                    Error::RustError(format!(
                        "OAuth authorization state put request is invalid JSON: {error}"
                    ))
                })?;
            put_oauth_authorization_state_in_object(&self.state, state)?;
            return Response::ok("updated");
        }
        if req.method() == Method::Post && url.path() == "/oauth-states/consume" {
            let request =
                serde_json::from_str::<OAuthAuthorizationStateConsumeRequest>(&req.text().await?)
                    .map_err(|error| {
                    Error::RustError(format!(
                        "OAuth authorization state consume request is invalid JSON: {error}"
                    ))
                })?;
            return Response::from_json(&OAuthAuthorizationStateConsumeResponse {
                state: consume_oauth_authorization_state_in_object(&self.state, request)?,
            });
        }
        json_error("route_not_found", "route not found", 404)
    }
}

#[durable_object]
pub struct BudgetLedgerObject {
    state: State,
    _env: Env,
}

impl DurableObject for BudgetLedgerObject {
    fn new(state: State, env: Env) -> Self {
        Self { state, _env: env }
    }

    async fn fetch(&self, mut req: Request) -> Result<Response> {
        let url = req.url()?;
        if req.method() == Method::Get && url.path() == "/status" {
            let Some(policy_id) = query_param(&url, "policy_id") else {
                return json_error("invalid_budget_request", "policy_id is required", 400);
            };
            let Some(window_key) = query_param(&url, "window_key") else {
                return json_error("invalid_budget_request", "window_key is required", 400);
            };
            let Some(limit_micros) = query_param(&url, "limit_micros") else {
                return json_error("invalid_budget_request", "limit_micros is required", 400);
            };
            let limit_micros = match limit_micros.parse::<u64>() {
                Ok(limit_micros) => limit_micros,
                Err(_) => {
                    return json_error(
                        "invalid_budget_request",
                        "limit_micros must be an unsigned integer",
                        400,
                    );
                }
            };
            let response =
                budget_status_in_object(&self.state, policy_id, window_key, limit_micros)?;
            ensure_budget_cleanup_alarm(&self.state).await?;
            return Ok(response);
        }
        if req.method() == Method::Post && url.path() == "/reserve" {
            let body = req.text().await?;
            let request = serde_json::from_str::<BudgetReserveRequest>(&body).map_err(|error| {
                Error::RustError(format!("budget reserve request is invalid JSON: {error}"))
            })?;
            let response = reserve_budget_in_object(&self.state, request)?;
            ensure_budget_cleanup_alarm(&self.state).await?;
            return Ok(response);
        }
        if req.method() == Method::Post && url.path() == "/settle" {
            let body = req.text().await?;
            let request = serde_json::from_str::<BudgetSettleRequest>(&body).map_err(|error| {
                Error::RustError(format!("budget settle request is invalid JSON: {error}"))
            })?;
            let response = settle_budget_in_object(&self.state, request)?;
            ensure_budget_cleanup_alarm(&self.state).await?;
            return Ok(response);
        }
        json_error("route_not_found", "route not found", 404)
    }

    async fn alarm(&self) -> Result<Response> {
        let sql = self.state.storage().sql();
        ensure_budget_schema(&sql)?;
        maintain_budget_reservations(&sql, Date::now().as_millis())?;
        ensure_budget_cleanup_alarm(&self.state).await?;
        Response::ok("stale budget reservations finalized")
    }
}

#[durable_object]
pub struct UsageLedgerObject {
    state: State,
    _env: Env,
}

impl DurableObject for UsageLedgerObject {
    fn new(state: State, env: Env) -> Self {
        Self { state, _env: env }
    }

    async fn fetch(&self, mut req: Request) -> Result<Response> {
        let url = req.url()?;
        if req.method() == Method::Post && url.path() == "/ingest" {
            let event =
                serde_json::from_str::<UsageEvent>(&req.text().await?).map_err(|error| {
                    Error::RustError(format!("usage event is invalid JSON: {error}"))
                })?;
            ingest_usage_event(&self.state, event)?;
            ensure_usage_cleanup_alarm(&self.state).await?;
            return Response::ok("accepted");
        }
        if req.method() == Method::Get && url.path() == "/snapshot" {
            let policy_id = query_param(&url, "policy_id");
            let limit = query_param(&url, "limit")
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or(USAGE_EVENT_LIMIT)
                .min(USAGE_EVENT_LIMIT);
            let snapshot = usage_snapshot_in_object(&self.state, policy_id.as_deref(), limit)?;
            ensure_usage_cleanup_alarm(&self.state).await?;
            return Response::from_json(&snapshot);
        }
        json_error("route_not_found", "route not found", 404)
    }

    async fn alarm(&self) -> Result<Response> {
        cleanup_usage_events(&self.state, Date::now().as_millis())?;
        ensure_usage_cleanup_alarm(&self.state).await?;
        Response::ok("usage retention applied")
    }
}

fn ensure_access_control_schema(sql: &SqlStorage) -> Result<()> {
    sql.exec(
        "CREATE TABLE IF NOT EXISTS policy_binding_principals (
            principal_key TEXT PRIMARY KEY
        )",
        None,
    )?;
    sql.exec(
        "CREATE TABLE IF NOT EXISTS policy_binding_entries (
            principal_key TEXT NOT NULL,
            binding_key TEXT NOT NULL,
            binding_json TEXT NOT NULL,
            PRIMARY KEY (principal_key, binding_key)
        )",
        None,
    )?;
    sql.exec(
        "CREATE TABLE IF NOT EXISTS policy_binding_meta (
            meta_key TEXT PRIMARY KEY
        )",
        None,
    )?;
    sql.exec(
        "CREATE TABLE IF NOT EXISTS access_users (
            email TEXT PRIMARY KEY,
            user_json TEXT NOT NULL
        )",
        None,
    )?;
    sql.exec(
        "CREATE TABLE IF NOT EXISTS access_policies (
            policy_id TEXT PRIMARY KEY,
            policy_json TEXT NOT NULL
        )",
        None,
    )?;
    sql.exec(
        "CREATE TABLE IF NOT EXISTS proxy_credentials (
            credential_id TEXT PRIMARY KEY,
            credential_json TEXT NOT NULL
        )",
        None,
    )?;
    sql.exec(
        "CREATE TABLE IF NOT EXISTS provider_connections (
            provider_id TEXT PRIMARY KEY,
            connection_json TEXT NOT NULL
        )",
        None,
    )?;
    sql.exec(
        "CREATE TABLE IF NOT EXISTS oauth_authorization_states (
            state TEXT PRIMARY KEY,
            state_json TEXT NOT NULL,
            expires_at_ms INTEGER NOT NULL
        )",
        None,
    )?;
    Ok(())
}

fn policy_binding_index_initialized(sql: &SqlStorage, principal_key: &str) -> Result<bool> {
    Ok(sql
        .exec_raw(
            "SELECT COUNT(*) AS principal_count
                FROM policy_binding_principals
                WHERE principal_key = ?",
            raw_bindings(vec![JsValue::from_str(principal_key)]),
        )?
        .to_array::<PolicyBindingIndexCountRow>()?
        .first()
        .is_some_and(|row| row.principal_count > 0))
}

fn initialize_policy_binding_index_in_object(
    state: &State,
    seeds: Vec<PolicyBindingIndexSeed>,
) -> Result<()> {
    let sql = state.storage().sql();
    ensure_access_control_schema(&sql)?;
    for seed in seeds {
        initialize_policy_binding_seed_in_sql(&sql, seed)?;
    }
    Ok(())
}

fn initialize_policy_binding_seed_in_sql(
    sql: &SqlStorage,
    mut seed: PolicyBindingIndexSeed,
) -> Result<()> {
    let principal_key = policy_binding_principal_key(&seed.principal);
    if policy_binding_index_initialized(sql, &principal_key)? {
        return Ok(());
    }
    normalize_policy_binding_records(&mut seed.bindings, &seed.principal);
    for binding in seed.bindings {
        upsert_policy_binding_in_sql(sql, &principal_key, &binding)?;
    }
    sql.exec_raw(
        "INSERT OR IGNORE INTO policy_binding_principals (principal_key) VALUES (?)",
        raw_bindings(vec![JsValue::from_str(&principal_key)]),
    )?;
    Ok(())
}

fn mutate_policy_binding_index_in_object(
    state: &State,
    request: PolicyBindingIndexMutationRequest,
) -> Result<()> {
    let principal = request.seed.principal.clone();
    let mut bindings = vec![request.binding.clone()];
    normalize_policy_binding_records(&mut bindings, &principal);
    if bindings.len() != 1 {
        return Err(Error::RustError(
            "policy binding mutation does not match its principal".to_string(),
        ));
    }
    initialize_policy_binding_index_in_object(state, vec![request.seed])?;
    let sql = state.storage().sql();
    let principal_key = policy_binding_principal_key(&principal);
    upsert_policy_binding_in_sql(&sql, &principal_key, &request.binding)
}

fn initialize_all_policy_bindings_in_object(
    state: &State,
    bindings: Vec<PolicyBindingRecord>,
) -> Result<()> {
    let mut seeds = BTreeMap::<String, PolicyBindingIndexSeed>::new();
    for binding in bindings {
        let principal = PolicyBindingPrincipal {
            principal_type: binding.principal_type,
            principal_id: binding.principal_id.clone(),
        };
        let principal_key = policy_binding_principal_key(&principal);
        seeds
            .entry(principal_key)
            .or_insert_with(|| PolicyBindingIndexSeed {
                principal,
                bindings: Vec::new(),
            })
            .bindings
            .push(binding);
    }
    initialize_policy_binding_index_in_object(state, seeds.into_values().collect())?;
    let sql = state.storage().sql();
    sql.exec(
        "INSERT OR IGNORE INTO policy_binding_meta (meta_key) VALUES ('bindings_global_initialized')",
        None,
    )?;
    Ok(())
}

fn upsert_policy_binding_in_sql(
    sql: &SqlStorage,
    principal_key: &str,
    binding: &PolicyBindingRecord,
) -> Result<()> {
    sql.exec_raw(
        "INSERT OR REPLACE INTO policy_binding_entries
            (principal_key, binding_key, binding_json)
            VALUES (?, ?, ?)",
        raw_bindings(vec![
            JsValue::from_str(principal_key),
            JsValue::from_str(&policy_binding_key(binding)),
            JsValue::from_str(&serde_json::to_string(binding)?),
        ]),
    )?;
    Ok(())
}

fn policy_binding_index_global_initialized(sql: &SqlStorage) -> Result<bool> {
    access_control_meta_initialized(sql, "bindings_global_initialized")
}

fn access_control_meta_initialized(sql: &SqlStorage, meta_key: &str) -> Result<bool> {
    Ok(sql
        .exec_raw(
            "SELECT COUNT(*) AS principal_count
                FROM policy_binding_meta
                WHERE meta_key = ?",
            raw_bindings(vec![JsValue::from_str(meta_key)]),
        )?
        .to_array::<PolicyBindingIndexCountRow>()?
        .first()
        .is_some_and(|row| row.principal_count > 0))
}

fn list_policy_bindings_in_object(state: &State) -> Result<PolicyBindingIndexListResponse> {
    let sql = state.storage().sql();
    ensure_access_control_schema(&sql)?;
    let mut bindings = sql
        .exec(
            "SELECT binding_json FROM policy_binding_entries
                ORDER BY principal_key, binding_key",
            None,
        )?
        .to_array::<PolicyBindingIndexEntryRow>()?
        .into_iter()
        .map(|row| {
            serde_json::from_str::<PolicyBindingRecord>(&row.binding_json).map_err(|error| {
                Error::RustError(format!("stored policy binding is invalid JSON: {error}"))
            })
        })
        .collect::<Result<Vec<_>>>()?;
    sort_policy_bindings(&mut bindings);
    Ok(PolicyBindingIndexListResponse {
        initialized: policy_binding_index_global_initialized(&sql)?,
        bindings,
    })
}

fn policy_bindings_for_principal_in_sql(
    sql: &SqlStorage,
    principal: &PolicyBindingPrincipal,
) -> Result<Vec<PolicyBindingRecord>> {
    let principal_key = policy_binding_principal_key(principal);
    if !policy_binding_index_initialized(sql, &principal_key)? {
        return Ok(Vec::new());
    }
    let mut bindings = sql
        .exec_raw(
            "SELECT binding_json FROM policy_binding_entries
                WHERE principal_key = ?
                ORDER BY binding_key",
            raw_bindings(vec![JsValue::from_str(&principal_key)]),
        )?
        .to_array::<PolicyBindingIndexEntryRow>()?
        .into_iter()
        .map(|row| {
            serde_json::from_str::<PolicyBindingRecord>(&row.binding_json).map_err(|error| {
                Error::RustError(format!("stored policy binding is invalid JSON: {error}"))
            })
        })
        .collect::<Result<Vec<_>>>()?;
    sort_policy_bindings(&mut bindings);
    Ok(bindings)
}

fn resolve_policy_binding_index_in_object(
    state: &State,
    principals: Vec<PolicyBindingPrincipal>,
) -> Result<PolicyBindingIndexResolveResponse> {
    let sql = state.storage().sql();
    ensure_access_control_schema(&sql)?;
    let mut bindings = Vec::new();
    let mut missing_principals = Vec::new();
    for principal in principals {
        let principal_key = policy_binding_principal_key(&principal);
        if !policy_binding_index_initialized(&sql, &principal_key)? {
            missing_principals.push(principal);
            continue;
        }
        bindings.extend(policy_bindings_for_principal_in_sql(&sql, &principal)?);
    }
    sort_policy_bindings(&mut bindings);
    Ok(PolicyBindingIndexResolveResponse {
        bindings,
        missing_principals,
    })
}

fn initialize_access_control_users_in_object(
    state: &State,
    users: Vec<AccessControlUser>,
) -> Result<()> {
    let sql = state.storage().sql();
    ensure_access_control_schema(&sql)?;
    for mut user in users {
        normalize_access_control_user(&mut user)?;
        if access_control_user_in_sql(&sql, &user.email)?.is_none() {
            put_access_control_user_in_sql(&sql, &user)?;
        }
    }
    Ok(())
}

fn initialize_all_access_control_users_in_object(
    state: &State,
    users: Vec<AccessControlUser>,
) -> Result<()> {
    initialize_access_control_users_in_object(state, users)?;
    state.storage().sql().exec(
        "INSERT OR IGNORE INTO policy_binding_meta (meta_key)
            VALUES ('users_global_initialized')",
        None,
    )?;
    Ok(())
}

fn put_access_control_user_in_object(state: &State, mut user: AccessControlUser) -> Result<()> {
    let sql = state.storage().sql();
    ensure_access_control_schema(&sql)?;
    normalize_access_control_user(&mut user)?;
    put_access_control_user_in_sql(&sql, &user)
}

async fn put_access_control_user_bindings_in_object(
    state: &State,
    mut request: AccessControlUserBindingsPutRequest,
) -> Result<Vec<PolicyBindingRecord>> {
    normalize_access_control_user(&mut request.user)?;
    let principal = PolicyBindingPrincipal {
        principal_type: PrincipalType::User,
        principal_id: request.user.email.clone(),
    };
    if request.seed.principal.principal_type != PrincipalType::User
        || normalize_access_email(&request.seed.principal.principal_id).map_err(str::to_string)?
            != principal.principal_id
    {
        return Err(Error::RustError(
            "access user binding seed does not match the requested user".to_string(),
        ));
    }
    request.seed.principal = principal.clone();
    let mut desired_policy_ids = BTreeSet::new();
    for policy_id in request.policy_ids {
        desired_policy_ids.insert(validate_admin_kid(policy_id.trim()).map_err(str::to_string)?);
    }
    let storage = state.storage();
    let sql = storage.sql();
    ensure_access_control_schema(&sql)?;
    let transaction_sql = sql.clone();
    let transaction_principal = principal.clone();
    storage
        .transaction(move |_| async move {
            initialize_policy_binding_seed_in_sql(&transaction_sql, request.seed)?;
            let current =
                policy_bindings_for_principal_in_sql(&transaction_sql, &transaction_principal)?;
            let bindings = reconcile_user_policy_bindings(
                &transaction_principal.principal_id,
                current,
                &desired_policy_ids,
            );
            put_access_control_user_in_sql(&transaction_sql, &request.user)?;
            let principal_key = policy_binding_principal_key(&transaction_principal);
            transaction_sql.exec_raw(
                "INSERT OR IGNORE INTO policy_binding_principals (principal_key) VALUES (?)",
                raw_bindings(vec![JsValue::from_str(&principal_key)]),
            )?;
            for binding in bindings {
                upsert_policy_binding_in_sql(&transaction_sql, &principal_key, &binding)?;
            }
            Ok(())
        })
        .await?;
    policy_bindings_for_principal_in_sql(&sql, &principal)
}

fn put_access_control_user_in_sql(sql: &SqlStorage, user: &AccessControlUser) -> Result<()> {
    sql.exec_raw(
        "INSERT OR REPLACE INTO access_users (email, user_json) VALUES (?, ?)",
        raw_bindings(vec![
            JsValue::from_str(&user.email),
            JsValue::from_str(&serde_json::to_string(&user.record)?),
        ]),
    )?;
    Ok(())
}

fn normalize_access_control_user(user: &mut AccessControlUser) -> Result<()> {
    user.email = normalize_access_email(&user.email).map_err(str::to_string)?;
    user.record.role = AccessRole::User;
    user.record.groups = normalize_access_groups(std::mem::take(&mut user.record.groups))
        .map_err(Error::RustError)?;
    Ok(())
}

fn access_control_user_in_sql(sql: &SqlStorage, email: &str) -> Result<Option<AccessControlUser>> {
    let Some(row) = sql
        .exec_raw(
            "SELECT user_json FROM access_users WHERE email = ? LIMIT 1",
            raw_bindings(vec![JsValue::from_str(email)]),
        )?
        .to_array::<AccessControlUserRow>()?
        .into_iter()
        .next()
    else {
        return Ok(None);
    };
    let record = serde_json::from_str::<AccessUserRecord>(&row.user_json).map_err(|error| {
        Error::RustError(format!("stored access user is invalid JSON: {error}"))
    })?;
    Ok(Some(AccessControlUser {
        email: email.to_string(),
        record,
    }))
}

fn resolve_access_control_users_in_object(
    state: &State,
    emails: Vec<String>,
) -> Result<AccessControlUsersResolveResponse> {
    let sql = state.storage().sql();
    ensure_access_control_schema(&sql)?;
    let mut users = Vec::new();
    let mut missing_emails = Vec::new();
    for email in emails {
        let email = normalize_access_email(&email).map_err(str::to_string)?;
        if let Some(user) = access_control_user_in_sql(&sql, &email)? {
            users.push(user);
        } else {
            missing_emails.push(email);
        }
    }
    Ok(AccessControlUsersResolveResponse {
        users,
        missing_emails,
    })
}

fn list_access_control_users_in_object(state: &State) -> Result<AccessControlUsersListResponse> {
    let sql = state.storage().sql();
    ensure_access_control_schema(&sql)?;
    let mut users = Vec::new();
    for row in sql
        .exec(
            "SELECT email, user_json FROM access_users ORDER BY email",
            None,
        )?
        .to_array::<AccessControlUserListRow>()?
    {
        let record = serde_json::from_str::<AccessUserRecord>(&row.user_json).map_err(|error| {
            Error::RustError(format!("stored access user is invalid JSON: {error}"))
        })?;
        users.push(AccessControlUser {
            email: row.email,
            record,
        });
    }
    Ok(AccessControlUsersListResponse {
        initialized: access_control_meta_initialized(&sql, "users_global_initialized")?,
        users,
    })
}

fn initialize_access_control_policies_in_object(
    state: &State,
    policies: Vec<AccessPolicyEntry>,
) -> Result<()> {
    let sql = state.storage().sql();
    ensure_access_control_schema(&sql)?;
    for mut policy in policies {
        normalize_access_control_policy(&mut policy)?;
        if access_control_policy_in_sql(&sql, &policy.policy_id)?.is_none() {
            put_access_control_policy_in_sql(&sql, &policy)?;
        }
    }
    Ok(())
}

fn put_access_control_policy_in_object(state: &State, mut policy: AccessPolicyEntry) -> Result<()> {
    let sql = state.storage().sql();
    ensure_access_control_schema(&sql)?;
    normalize_access_control_policy(&mut policy)?;
    put_access_control_policy_in_sql(&sql, &policy)
}

async fn put_access_control_policy_and_credential_in_object(
    state: &State,
    mut request: AccessControlPolicyCredentialPutRequest,
) -> Result<()> {
    let storage = state.storage();
    let sql = storage.sql();
    ensure_access_control_schema(&sql)?;
    normalize_access_control_policy(&mut request.policy)?;
    normalize_access_control_credential(&mut request.credential)?;
    storage
        .transaction(move |_| async move {
            put_access_control_policy_in_sql(&sql, &request.policy)?;
            put_access_control_credential_in_sql(&sql, &request.credential)?;
            Ok(())
        })
        .await
}

fn normalize_access_control_policy(policy: &mut AccessPolicyEntry) -> Result<()> {
    policy.policy_id = validate_admin_kid(policy.policy_id.trim()).map_err(str::to_string)?;
    Ok(())
}

fn put_access_control_policy_in_sql(sql: &SqlStorage, policy: &AccessPolicyEntry) -> Result<()> {
    sql.exec_raw(
        "INSERT OR REPLACE INTO access_policies (policy_id, policy_json) VALUES (?, ?)",
        raw_bindings(vec![
            JsValue::from_str(&policy.policy_id),
            JsValue::from_str(&serde_json::to_string(&policy.policy)?),
        ]),
    )?;
    Ok(())
}

fn access_control_policy_in_sql(
    sql: &SqlStorage,
    policy_id: &str,
) -> Result<Option<AccessPolicyEntry>> {
    let Some(row) = sql
        .exec_raw(
            "SELECT policy_json FROM access_policies WHERE policy_id = ? LIMIT 1",
            raw_bindings(vec![JsValue::from_str(policy_id)]),
        )?
        .to_array::<AccessControlPolicyRow>()?
        .into_iter()
        .next()
    else {
        return Ok(None);
    };
    let policy = serde_json::from_str::<AccessPolicy>(&row.policy_json).map_err(|error| {
        Error::RustError(format!("stored access policy is invalid JSON: {error}"))
    })?;
    Ok(Some(AccessPolicyEntry {
        policy_id: policy_id.to_string(),
        policy,
    }))
}

fn resolve_access_control_policies_in_object(
    state: &State,
    policy_ids: Vec<String>,
) -> Result<AccessControlPoliciesResolveResponse> {
    let sql = state.storage().sql();
    ensure_access_control_schema(&sql)?;
    let mut policies = Vec::new();
    let mut missing_policy_ids = Vec::new();
    for policy_id in policy_ids {
        let policy_id = validate_admin_kid(policy_id.trim()).map_err(str::to_string)?;
        if let Some(policy) = access_control_policy_in_sql(&sql, &policy_id)? {
            policies.push(policy);
        } else {
            missing_policy_ids.push(policy_id);
        }
    }
    Ok(AccessControlPoliciesResolveResponse {
        policies,
        missing_policy_ids,
    })
}

fn list_access_control_policies_in_object(
    state: &State,
) -> Result<AccessControlPoliciesListResponse> {
    let sql = state.storage().sql();
    ensure_access_control_schema(&sql)?;
    let policies = sql
        .exec(
            "SELECT policy_id, policy_json FROM access_policies ORDER BY policy_id",
            None,
        )?
        .to_array::<AccessControlPolicyListRow>()?
        .into_iter()
        .map(|row| {
            let policy =
                serde_json::from_str::<AccessPolicy>(&row.policy_json).map_err(|error| {
                    Error::RustError(format!("stored access policy is invalid JSON: {error}"))
                })?;
            Ok(AccessPolicyEntry {
                policy_id: row.policy_id,
                policy,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(AccessControlPoliciesListResponse { policies })
}

fn initialize_access_control_credentials_in_object(
    state: &State,
    credentials: Vec<ProxyCredentialEntry>,
) -> Result<()> {
    let sql = state.storage().sql();
    ensure_access_control_schema(&sql)?;
    for mut credential in credentials {
        normalize_access_control_credential(&mut credential)?;
        if access_control_credential_in_sql(&sql, &credential.credential_id)?.is_none() {
            put_access_control_credential_in_sql(&sql, &credential)?;
        }
    }
    Ok(())
}

fn put_access_control_credential_in_object(
    state: &State,
    mut credential: ProxyCredentialEntry,
) -> Result<()> {
    let sql = state.storage().sql();
    ensure_access_control_schema(&sql)?;
    normalize_access_control_credential(&mut credential)?;
    put_access_control_credential_in_sql(&sql, &credential)
}

fn normalize_access_control_credential(credential: &mut ProxyCredentialEntry) -> Result<()> {
    credential.credential_id =
        validate_admin_kid(credential.credential_id.trim()).map_err(str::to_string)?;
    credential.credential.policy_id =
        validate_admin_kid(credential.credential.policy_id.trim()).map_err(str::to_string)?;
    if !is_sha256_hex(&credential.credential.secret_sha256) {
        return Err(Error::RustError(
            "proxy credential secret hash is invalid".to_string(),
        ));
    }
    credential.credential.secret_sha256 = credential.credential.secret_sha256.to_ascii_lowercase();
    credential.credential.principal_id = credential
        .credential
        .principal_id
        .take()
        .map(|principal_id| normalize_access_email(&principal_id).map_err(str::to_string))
        .transpose()?;
    Ok(())
}

fn put_access_control_credential_in_sql(
    sql: &SqlStorage,
    credential: &ProxyCredentialEntry,
) -> Result<()> {
    sql.exec_raw(
        "INSERT OR REPLACE INTO proxy_credentials (credential_id, credential_json) VALUES (?, ?)",
        raw_bindings(vec![
            JsValue::from_str(&credential.credential_id),
            JsValue::from_str(&serde_json::to_string(&credential.credential)?),
        ]),
    )?;
    Ok(())
}

fn access_control_credential_in_sql(
    sql: &SqlStorage,
    credential_id: &str,
) -> Result<Option<ProxyCredentialEntry>> {
    let Some(row) = sql
        .exec_raw(
            "SELECT credential_json FROM proxy_credentials WHERE credential_id = ? LIMIT 1",
            raw_bindings(vec![JsValue::from_str(credential_id)]),
        )?
        .to_array::<AccessControlCredentialRow>()?
        .into_iter()
        .next()
    else {
        return Ok(None);
    };
    let credential =
        serde_json::from_str::<ProxyCredential>(&row.credential_json).map_err(|error| {
            Error::RustError(format!("stored proxy credential is invalid JSON: {error}"))
        })?;
    Ok(Some(ProxyCredentialEntry {
        credential_id: credential_id.to_string(),
        credential,
    }))
}

fn resolve_access_control_credentials_in_object(
    state: &State,
    credential_ids: Vec<String>,
) -> Result<AccessControlCredentialsResolveResponse> {
    let sql = state.storage().sql();
    ensure_access_control_schema(&sql)?;
    let mut credentials = Vec::new();
    let mut missing_credential_ids = Vec::new();
    for credential_id in credential_ids {
        let credential_id = validate_admin_kid(credential_id.trim()).map_err(str::to_string)?;
        if let Some(credential) = access_control_credential_in_sql(&sql, &credential_id)? {
            credentials.push(credential);
        } else {
            missing_credential_ids.push(credential_id);
        }
    }
    Ok(AccessControlCredentialsResolveResponse {
        credentials,
        missing_credential_ids,
    })
}

fn list_access_control_credentials_in_object(
    state: &State,
) -> Result<AccessControlCredentialsListResponse> {
    let sql = state.storage().sql();
    ensure_access_control_schema(&sql)?;
    let credentials = sql
        .exec(
            "SELECT credential_id, credential_json FROM proxy_credentials ORDER BY credential_id",
            None,
        )?
        .to_array::<AccessControlCredentialListRow>()?
        .into_iter()
        .map(|row| {
            let credential = serde_json::from_str::<ProxyCredential>(&row.credential_json)
                .map_err(|error| {
                    Error::RustError(format!("stored proxy credential is invalid JSON: {error}"))
                })?;
            Ok(ProxyCredentialEntry {
                credential_id: row.credential_id,
                credential,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(AccessControlCredentialsListResponse { credentials })
}

fn initialize_access_control_connections_in_object(
    state: &State,
    connections: Vec<ProviderConnectionRecord>,
) -> Result<()> {
    let sql = state.storage().sql();
    ensure_access_control_schema(&sql)?;
    for mut connection in connections {
        normalize_access_control_connection(&mut connection)?;
        if access_control_connection_in_sql(&sql, &connection.provider_id)?.is_none() {
            put_access_control_connection_in_sql(&sql, &connection)?;
        }
    }
    Ok(())
}

fn put_access_control_connection_in_object(
    state: &State,
    mut connection: ProviderConnectionRecord,
) -> Result<()> {
    let sql = state.storage().sql();
    ensure_access_control_schema(&sql)?;
    normalize_access_control_connection(&mut connection)?;
    put_access_control_connection_in_sql(&sql, &connection)
}

fn normalize_access_control_connection(connection: &mut ProviderConnectionRecord) -> Result<()> {
    connection.provider_id = connection.provider_id.trim().to_string();
    if connection.provider_id.is_empty() {
        return Err(Error::RustError(
            "provider connection id is required".to_string(),
        ));
    }
    Ok(())
}

fn put_access_control_connection_in_sql(
    sql: &SqlStorage,
    connection: &ProviderConnectionRecord,
) -> Result<()> {
    sql.exec_raw(
        "INSERT OR REPLACE INTO provider_connections (provider_id, connection_json)
            VALUES (?, ?)",
        raw_bindings(vec![
            JsValue::from_str(&connection.provider_id),
            JsValue::from_str(&serde_json::to_string(connection)?),
        ]),
    )?;
    Ok(())
}

fn access_control_connection_in_sql(
    sql: &SqlStorage,
    provider_id: &str,
) -> Result<Option<ProviderConnectionRecord>> {
    let Some(row) = sql
        .exec_raw(
            "SELECT connection_json FROM provider_connections WHERE provider_id = ? LIMIT 1",
            raw_bindings(vec![JsValue::from_str(provider_id)]),
        )?
        .to_array::<AccessControlConnectionRow>()?
        .into_iter()
        .next()
    else {
        return Ok(None);
    };
    let mut connection = serde_json::from_str::<ProviderConnectionRecord>(&row.connection_json)
        .map_err(|error| {
            Error::RustError(format!(
                "stored provider connection is invalid JSON: {error}"
            ))
        })?;
    connection.provider_id = provider_id.to_string();
    Ok(Some(connection))
}

fn resolve_access_control_connections_in_object(
    state: &State,
    provider_ids: Vec<String>,
) -> Result<AccessControlConnectionsResolveResponse> {
    let sql = state.storage().sql();
    ensure_access_control_schema(&sql)?;
    let mut connections = Vec::new();
    let mut missing_provider_ids = Vec::new();
    for provider_id in provider_ids {
        let provider_id = provider_id.trim().to_string();
        if provider_id.is_empty() {
            return Err(Error::RustError(
                "provider connection id is required".to_string(),
            ));
        }
        if let Some(connection) = access_control_connection_in_sql(&sql, &provider_id)? {
            connections.push(connection);
        } else {
            missing_provider_ids.push(provider_id);
        }
    }
    Ok(AccessControlConnectionsResolveResponse {
        connections,
        missing_provider_ids,
    })
}

fn put_oauth_authorization_state_in_object(
    state: &State,
    authorization: OAuthAuthorizationState,
) -> Result<()> {
    if authorization.state.len() < 32
        || authorization.verifier.len() < 43
        || authorization.actor_email.is_empty()
        || authorization.grant_key.is_empty()
        || authorization.provider.is_empty()
        || authorization.redirect_uri.is_empty()
        || authorization.expires_at_ms <= Date::now().as_millis()
    {
        return Err(Error::RustError(
            "OAuth authorization state is invalid".to_string(),
        ));
    }
    let sql = state.storage().sql();
    ensure_access_control_schema(&sql)?;
    sql.exec_raw(
        "DELETE FROM oauth_authorization_states WHERE expires_at_ms <= ?",
        raw_bindings(vec![JsValue::from_f64(Date::now().as_millis() as f64)]),
    )?;
    sql.exec_raw(
        "INSERT OR REPLACE INTO oauth_authorization_states
            (state, state_json, expires_at_ms) VALUES (?, ?, ?)",
        raw_bindings(vec![
            JsValue::from_str(&authorization.state),
            JsValue::from_str(&serde_json::to_string(&authorization)?),
            JsValue::from_f64(authorization.expires_at_ms as f64),
        ]),
    )?;
    Ok(())
}

fn consume_oauth_authorization_state_in_object(
    state: &State,
    request: OAuthAuthorizationStateConsumeRequest,
) -> Result<Option<OAuthAuthorizationState>> {
    let sql = state.storage().sql();
    ensure_access_control_schema(&sql)?;
    let Some(row) = sql
        .exec_raw(
            "SELECT state_json FROM oauth_authorization_states WHERE state = ? LIMIT 1",
            raw_bindings(vec![JsValue::from_str(&request.state)]),
        )?
        .to_array::<OAuthAuthorizationStateRow>()?
        .into_iter()
        .next()
    else {
        return Ok(None);
    };
    let authorization =
        serde_json::from_str::<OAuthAuthorizationState>(&row.state_json).map_err(|error| {
            Error::RustError(format!(
                "stored OAuth authorization state is invalid JSON: {error}"
            ))
        })?;
    if authorization.actor_email != request.actor_email {
        return Ok(None);
    }
    sql.exec_raw(
        "DELETE FROM oauth_authorization_states WHERE state = ?",
        raw_bindings(vec![JsValue::from_str(&request.state)]),
    )?;
    if authorization.expires_at_ms <= Date::now().as_millis() {
        return Ok(None);
    }
    Ok(Some(authorization))
}

async fn persist_usage_event(namespace: &ObjectNamespace, event: &UsageEvent) -> Result<()> {
    let stub = namespace.get_by_name(usage_object_name())?;
    let body = serde_json::to_string(event)?;
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_body(Some(JsValue::from_str(&body)));
    let req = Request::new_with_init("https://clawrouter.internal/ingest", &init)?;
    let mut response = stub.fetch_with_request(req).await?;
    let status = response.status_code();
    if !(200..=299).contains(&status) {
        let text = response.text().await?;
        return Err(Error::RustError(format!(
            "usage ledger rejected event with HTTP {status}: {text}"
        )));
    }
    Ok(())
}

fn ingest_usage_event(state: &State, mut event: UsageEvent) -> Result<()> {
    ensure_usage_schema(state)?;
    if event.occurred_at_ms == 0 {
        event.occurred_at_ms = Date::now().as_millis();
    }
    if event.policy_id.is_empty() {
        event.policy_id.clone_from(&event.key_id);
    }
    normalize_usage_event_metadata(&mut event);
    let event_json = serde_json::to_string(&event)?;
    state.storage().sql().exec_raw(
        "INSERT OR IGNORE INTO usage_events (
            id, occurred_at_ms, tenant_id, policy_id, provider, status, status_code,
            input_tokens, output_tokens, total_tokens, actual_cost_micros, event_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        raw_bindings(vec![
            JsValue::from_str(&event.id),
            sql_usage_number(event.occurred_at_ms, "occurred_at_ms")?,
            JsValue::from_str(&event.tenant_id),
            JsValue::from_str(&event.policy_id),
            JsValue::from_str(&event.provider),
            JsValue::from_str(usage_status_label(&event.status)),
            optional_sql_usage_number(event.status_code.map(u64::from), "status_code")?,
            optional_sql_usage_number(event.input_tokens, "input_tokens")?,
            optional_sql_usage_number(event.output_tokens, "output_tokens")?,
            optional_sql_usage_number(event.total_tokens, "total_tokens")?,
            sql_usage_number(event.actual_cost_micros, "actual_cost_micros")?,
            JsValue::from_str(&event_json),
        ]),
    )?;
    cleanup_usage_events(state, Date::now().as_millis())?;
    Ok(())
}

fn cleanup_usage_events(state: &State, now_ms: u64) -> Result<()> {
    ensure_usage_schema(state)?;
    let retention_cutoff = usage_retention_cutoff_ms(now_ms);
    state.storage().sql().exec_raw(
        "DELETE FROM usage_events WHERE occurred_at_ms < ?",
        raw_bindings(vec![sql_usage_number(
            retention_cutoff,
            "retention_cutoff",
        )?]),
    )?;
    Ok(())
}

async fn ensure_usage_cleanup_alarm(state: &State) -> Result<()> {
    if usage_has_events(state)? && state.storage().get_alarm().await?.is_none() {
        state.storage().set_alarm(USAGE_CLEANUP_INTERVAL_MS).await?;
    }
    Ok(())
}

fn usage_has_events(state: &State) -> Result<bool> {
    ensure_usage_schema(state)?;
    Ok(state
        .storage()
        .sql()
        .exec("SELECT COUNT(*) AS event_count FROM usage_events", None)?
        .to_array::<UsageEventCountRow>()?
        .first()
        .is_some_and(|row| row.event_count > 0))
}

fn usage_retention_cutoff_ms(now_ms: u64) -> u64 {
    now_ms.saturating_sub(USAGE_EVENT_RETENTION_MS)
}

fn ensure_usage_schema(state: &State) -> Result<()> {
    let sql = state.storage().sql();
    sql.exec(
        "CREATE TABLE IF NOT EXISTS usage_events (
            id TEXT PRIMARY KEY,
            occurred_at_ms INTEGER NOT NULL,
            tenant_id TEXT NOT NULL,
            policy_id TEXT NOT NULL,
            provider TEXT NOT NULL,
            status TEXT NOT NULL,
            status_code INTEGER,
            input_tokens INTEGER,
            output_tokens INTEGER,
            total_tokens INTEGER,
            actual_cost_micros INTEGER NOT NULL,
            event_json TEXT NOT NULL
        )",
        None,
    )?;
    sql.exec(
        "CREATE INDEX IF NOT EXISTS usage_events_occurred_at
            ON usage_events (occurred_at_ms DESC)",
        None,
    )?;
    sql.exec(
        "CREATE INDEX IF NOT EXISTS usage_events_policy
            ON usage_events (policy_id, occurred_at_ms DESC)",
        None,
    )?;
    Ok(())
}

fn usage_snapshot_in_object(
    state: &State,
    policy_id: Option<&str>,
    limit: usize,
) -> Result<UsageSnapshot> {
    ensure_usage_schema(state)?;
    let now_ms = Date::now().as_millis();
    cleanup_usage_events(state, now_ms)?;
    let retention_cutoff = usage_retention_cutoff_ms(now_ms);
    let sql = state.storage().sql();
    let event_rows = match policy_id {
        Some(policy_id) => sql.exec_raw(
            "SELECT event_json FROM usage_events
                WHERE policy_id = ? AND occurred_at_ms >= ?
                ORDER BY occurred_at_ms DESC LIMIT ?",
            raw_bindings(vec![
                JsValue::from_str(policy_id),
                sql_usage_number(retention_cutoff, "retention_cutoff")?,
                sql_usage_number(limit as u64, "limit")?,
            ]),
        )?,
        None => sql.exec_raw(
            "SELECT event_json FROM usage_events
                WHERE occurred_at_ms >= ?
                ORDER BY occurred_at_ms DESC LIMIT ?",
            raw_bindings(vec![
                sql_usage_number(retention_cutoff, "retention_cutoff")?,
                sql_usage_number(limit as u64, "limit")?,
            ]),
        )?,
    }
    .to_array::<UsageEventJsonRow>()?;
    let events = event_rows
        .into_iter()
        .map(|row| {
            serde_json::from_str::<UsageEvent>(&row.event_json).map_err(|error| {
                Error::RustError(format!("stored usage event is invalid JSON: {error}"))
            })
        })
        .collect::<Result<Vec<_>>>()?;

    let summary_row = usage_summary_cursor(&sql, policy_id, retention_cutoff)?
        .to_array::<UsageSummarySqlRow>()?
        .into_iter()
        .next()
        .unwrap_or_default();
    let providers = provider_usage_summary_cursor(&sql, policy_id, retention_cutoff)?
        .to_array::<ProviderUsageSummarySqlRow>()?
        .into_iter()
        .map(provider_usage_summary_from_sql)
        .collect();
    Ok(UsageSnapshot {
        ledger: "durable_object".to_string(),
        summary: usage_summary_from_sql(summary_row),
        providers,
        events,
    })
}

fn usage_summary_cursor(
    sql: &SqlStorage,
    policy_id: Option<&str>,
    retention_cutoff: u64,
) -> Result<SqlCursor> {
    let select = "SELECT
        COUNT(*) AS request_count,
        COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) AS success_count,
        COALESCE(SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END), 0) AS error_count,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        COALESCE(SUM(actual_cost_micros), 0) AS actual_cost_micros
        FROM usage_events";
    match policy_id {
        Some(policy_id) => sql.exec_raw(
            &format!("{select} WHERE policy_id = ? AND occurred_at_ms >= ?"),
            raw_bindings(vec![
                JsValue::from_str(policy_id),
                sql_usage_number(retention_cutoff, "retention_cutoff")?,
            ]),
        ),
        None => sql.exec_raw(
            &format!("{select} WHERE occurred_at_ms >= ?"),
            raw_bindings(vec![sql_usage_number(
                retention_cutoff,
                "retention_cutoff",
            )?]),
        ),
    }
}

fn provider_usage_summary_cursor(
    sql: &SqlStorage,
    policy_id: Option<&str>,
    retention_cutoff: u64,
) -> Result<SqlCursor> {
    let select = "SELECT
        provider,
        COUNT(*) AS request_count,
        COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) AS success_count,
        COALESCE(SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END), 0) AS error_count,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        COALESCE(SUM(actual_cost_micros), 0) AS actual_cost_micros
        FROM usage_events";
    match policy_id {
        Some(policy_id) => sql.exec_raw(
            &format!(
                "{select} WHERE policy_id = ? AND occurred_at_ms >= ?
                    GROUP BY provider ORDER BY request_count DESC"
            ),
            raw_bindings(vec![
                JsValue::from_str(policy_id),
                sql_usage_number(retention_cutoff, "retention_cutoff")?,
            ]),
        ),
        None => sql.exec_raw(
            &format!(
                "{select} WHERE occurred_at_ms >= ?
                    GROUP BY provider ORDER BY request_count DESC"
            ),
            raw_bindings(vec![sql_usage_number(
                retention_cutoff,
                "retention_cutoff",
            )?]),
        ),
    }
}

fn usage_summary_from_sql(row: UsageSummarySqlRow) -> UsageSummary {
    UsageSummary {
        request_count: sql_count(row.request_count),
        success_count: sql_count(row.success_count),
        error_count: sql_count(row.error_count),
        input_tokens: sql_count(row.input_tokens),
        output_tokens: sql_count(row.output_tokens),
        total_tokens: sql_count(row.total_tokens),
        actual_cost_micros: sql_count(row.actual_cost_micros),
    }
}

fn provider_usage_summary_from_sql(row: ProviderUsageSummarySqlRow) -> ProviderUsageSummary {
    ProviderUsageSummary {
        provider: row.provider,
        request_count: sql_count(row.request_count),
        success_count: sql_count(row.success_count),
        error_count: sql_count(row.error_count),
        total_tokens: sql_count(row.total_tokens),
        actual_cost_micros: sql_count(row.actual_cost_micros),
    }
}

fn sql_count(value: i64) -> u64 {
    value.max(0) as u64
}

fn sql_usage_number(value: u64, field: &str) -> Result<JsValue> {
    validate_budget_number(value, field).map(JsValue::from_f64)
}

fn optional_sql_usage_number(value: Option<u64>, field: &str) -> Result<JsValue> {
    value.map_or(Ok(JsValue::NULL), |value| sql_usage_number(value, field))
}

fn usage_status_label(status: &UsageStatus) -> &'static str {
    match status {
        UsageStatus::Success => "success",
        UsageStatus::ProviderError => "provider_error",
        UsageStatus::ClientError => "client_error",
        UsageStatus::Denied => "denied",
        UsageStatus::Timeout => "timeout",
    }
}

fn usage_object_name() -> &'static str {
    "global"
}

fn preflight_static_budget(policy: &AccessPolicy) -> Result<Option<Response>> {
    if policy.monthly_budget_micros == Some(0) {
        return json_error("budget_exhausted", "proxy key budget is exhausted", 402).map(Some);
    }
    Ok(None)
}

async fn preflight_budget(
    env: &Env,
    auth: &AuthorizedKey,
    capability: &str,
    request_cost: &RequestCost,
) -> Result<BudgetPreflight> {
    let Some(limit_micros) = auth.policy.monthly_budget_micros else {
        return Ok(BudgetPreflight::Allowed(BudgetUsage::default()));
    };
    if limit_micros == 0 {
        return json_error("budget_exhausted", "proxy key budget is exhausted", 402)
            .map(BudgetPreflight::Denied);
    }
    if budget_requires_declared_price(request_cost) {
        return json_error(
            "pricing_required",
            "budgeted requests require versioned manifest pricing or a fixed policy request price",
            400,
        )
        .map(BudgetPreflight::Denied);
    }

    let cost_micros = request_cost.reserve_micros;
    if cost_micros == 0 {
        return Ok(BudgetPreflight::Allowed(BudgetUsage::default()));
    }
    if limit_micros > MAX_SQL_BUDGET_MICROS || cost_micros > MAX_SQL_BUDGET_MICROS {
        return json_error(
            "invalid_budget_policy",
            "budget micros exceed the supported Durable Object SQL integer range",
            500,
        )
        .map(BudgetPreflight::Denied);
    }

    let Ok(namespace) = env.durable_object("BUDGET_LEDGER") else {
        return json_error(
            "budget_store_unavailable",
            "BUDGET_LEDGER Durable Object binding is required for budgeted proxy keys",
            503,
        )
        .map(BudgetPreflight::Denied);
    };

    let tenant_id = tenant_id(auth);
    let policy_id = budget_policy_id(&tenant_id, &auth.policy_id);
    let reservation_id = budget_reservation_id();
    let request = BudgetReserveRequest {
        window_key: current_month_window_key(&policy_id)?,
        policy_id,
        limit_micros,
        cost_micros,
        reservation_id: reservation_id.clone(),
        capability: capability.to_string(),
    };
    let response = reserve_budget(namespace, &tenant_id, &auth.policy_id, &request).await?;
    if response.allowed {
        return Ok(BudgetPreflight::Allowed(BudgetUsage {
            reservation_id: Some(reservation_id),
            reserved_cost_micros: response.charged_micros,
            actual_cost_micros: response.charged_micros,
        }));
    }

    json_error("budget_exhausted", "proxy key budget is exhausted", 402)
        .map(BudgetPreflight::Denied)
}

fn budget_requires_declared_price(request_cost: &RequestCost) -> bool {
    request_cost.basis == RequestCostBasis::FlatFallback
}

async fn reserve_budget(
    namespace: ObjectNamespace,
    tenant_id: &str,
    kid: &str,
    request: &BudgetReserveRequest,
) -> Result<BudgetReserveResponse> {
    let stub = namespace.get_by_name(&budget_object_name(tenant_id, kid))?;
    let body = serde_json::to_string(request)?;
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_body(Some(JsValue::from_str(&body)));
    let req = Request::new_with_init("https://clawrouter.internal/reserve", &init)?;
    let mut response = stub.fetch_with_request(req).await?;
    let status = response.status_code();
    let text = response.text().await?;
    if !(200..=299).contains(&status) {
        return Err(Error::RustError(format!(
            "budget ledger rejected reservation with HTTP {status}: {text}"
        )));
    }
    serde_json::from_str::<BudgetReserveResponse>(&text).map_err(|error| {
        Error::RustError(format!("budget ledger response is invalid JSON: {error}"))
    })
}

async fn settle_budget_after_response(
    env: &Env,
    auth: &AuthorizedKey,
    mut usage: BudgetUsage,
    actual_cost_micros: u64,
) -> BudgetUsage {
    if usage.reserved_cost_micros == 0 {
        usage.actual_cost_micros = actual_cost_micros;
        return usage;
    }
    let Some(reservation_id) = usage.reservation_id.as_deref() else {
        return usage;
    };
    let namespace = match env.durable_object("BUDGET_LEDGER") {
        Ok(namespace) => namespace,
        Err(error) => {
            console_error!(
                "failed to settle budget reservation {}: BUDGET_LEDGER binding is unavailable: {}",
                reservation_id,
                error
            );
            return usage;
        }
    };
    let request = BudgetSettleRequest {
        reservation_id: reservation_id.to_string(),
        actual_cost_micros,
    };
    usage.actual_cost_micros = request.actual_cost_micros;
    let mut last_error = String::new();
    for _ in 0..BUDGET_SETTLEMENT_ATTEMPTS {
        match settle_budget(&namespace, &tenant_id(auth), &auth.policy_id, &request).await {
            Ok(response) if response.settled => {
                usage.actual_cost_micros = response.charged_micros;
                return usage;
            }
            Ok(_) => {
                last_error =
                    format!("budget reservation {reservation_id} was not available for settlement");
            }
            Err(error) => {
                last_error = error.to_string();
            }
        }
    }
    console_error!(
        "failed to settle budget reservation {} after {} attempts; reservation remains charged: {}",
        reservation_id,
        BUDGET_SETTLEMENT_ATTEMPTS,
        last_error
    );
    if let Err(error) = enqueue_budget_settlement_retry(
        env,
        QueueJob::BudgetSettlement {
            tenant_id: tenant_id(auth),
            policy_id: auth.policy_id.clone(),
            request,
        },
    )
    .await
    {
        console_error!(
            "failed to enqueue budget settlement retry for {}: {}",
            reservation_id,
            error
        );
    }
    usage
}

async fn enqueue_budget_settlement_retry(env: &Env, job: QueueJob) -> Result<()> {
    let queue = env.queue("USAGE_QUEUE").map_err(|error| {
        Error::RustError(format!(
            "USAGE_QUEUE binding is required for budget settlement retries: {error}"
        ))
    })?;
    queue.send(job).await.map_err(|error| {
        Error::RustError(format!(
            "failed to persist budget settlement retry: {error}"
        ))
    })
}

async fn persist_budget_settlement(
    namespace: &ObjectNamespace,
    tenant_id: &str,
    policy_id: &str,
    request: &BudgetSettleRequest,
) -> Result<()> {
    let response = settle_budget(namespace, tenant_id, policy_id, request).await?;
    if response.settled {
        return Ok(());
    }
    Err(Error::RustError(format!(
        "budget reservation {} was not available for settlement",
        request.reservation_id
    )))
}

async fn settle_budget(
    namespace: &ObjectNamespace,
    tenant_id: &str,
    policy_id: &str,
    request: &BudgetSettleRequest,
) -> Result<BudgetSettleResponse> {
    let stub = namespace.get_by_name(&budget_object_name(tenant_id, policy_id))?;
    let body = serde_json::to_string(request)?;
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_body(Some(JsValue::from_str(&body)));
    let req = Request::new_with_init("https://clawrouter.internal/settle", &init)?;
    let mut response = stub.fetch_with_request(req).await?;
    let status = response.status_code();
    let text = response.text().await?;
    if !(200..=299).contains(&status) {
        return Err(Error::RustError(format!(
            "budget ledger rejected settlement with HTTP {status}: {text}"
        )));
    }
    serde_json::from_str::<BudgetSettleResponse>(&text).map_err(|error| {
        Error::RustError(format!(
            "budget ledger settlement response is invalid JSON: {error}"
        ))
    })
}

async fn budget_status_for_key(
    env: &Env,
    tenant_id: &str,
    kid: &str,
    limit_micros: Option<u64>,
) -> Result<BudgetStatusView> {
    let Some(limit_micros) = limit_micros else {
        return Ok(BudgetStatusView {
            configured: false,
            ledger: "unmetered",
            window_key: None,
            limit_micros: None,
            spent_micros: None,
            remaining_micros: None,
        });
    };

    let policy_id = budget_policy_id(tenant_id, kid);
    let window_key = current_month_window_key(&policy_id)?;
    if limit_micros > MAX_SQL_BUDGET_MICROS {
        return Ok(BudgetStatusView {
            configured: true,
            ledger: "invalid_policy",
            window_key: Some(window_key),
            limit_micros: Some(limit_micros),
            spent_micros: None,
            remaining_micros: None,
        });
    }
    if limit_micros == 0 {
        return Ok(BudgetStatusView {
            configured: true,
            ledger: "blocked",
            window_key: Some(window_key),
            limit_micros: Some(0),
            spent_micros: Some(0),
            remaining_micros: Some(0),
        });
    }

    let Ok(namespace) = env.durable_object("BUDGET_LEDGER") else {
        return Ok(BudgetStatusView {
            configured: true,
            ledger: "unavailable",
            window_key: Some(window_key),
            limit_micros: Some(limit_micros),
            spent_micros: None,
            remaining_micros: None,
        });
    };
    let status = fetch_budget_status(
        namespace,
        tenant_id,
        kid,
        &policy_id,
        &window_key,
        limit_micros,
    )
    .await?;
    Ok(BudgetStatusView {
        configured: true,
        ledger: "durable_object",
        window_key: Some(status.window_key),
        limit_micros: Some(status.limit_micros),
        spent_micros: Some(status.spent_micros),
        remaining_micros: Some(status.remaining_micros),
    })
}

async fn fetch_budget_status(
    namespace: ObjectNamespace,
    tenant_id: &str,
    kid: &str,
    policy_id: &str,
    window_key: &str,
    limit_micros: u64,
) -> Result<BudgetStatusResponse> {
    let stub = namespace.get_by_name(&budget_object_name(tenant_id, kid))?;
    let url = format!(
        "https://clawrouter.internal/status?policy_id={}&window_key={}&limit_micros={}",
        encode_component(policy_id),
        encode_component(window_key),
        limit_micros
    );
    let mut init = RequestInit::new();
    init.with_method(Method::Get);
    let req = Request::new_with_init(&url, &init)?;
    let mut response = stub.fetch_with_request(req).await?;
    let status = response.status_code();
    let text = response.text().await?;
    if !(200..=299).contains(&status) {
        return Err(Error::RustError(format!(
            "budget ledger rejected status request with HTTP {status}: {text}"
        )));
    }
    serde_json::from_str::<BudgetStatusResponse>(&text).map_err(|error| {
        Error::RustError(format!(
            "budget ledger status response is invalid JSON: {error}"
        ))
    })
}

fn reserve_budget_in_object(state: &State, request: BudgetReserveRequest) -> Result<Response> {
    let sql = state.storage().sql();
    ensure_budget_schema(&sql)?;
    maintain_budget_reservations(&sql, Date::now().as_millis())?;
    if let Some(existing) = budget_reservation(&sql, &request.reservation_id)? {
        let spent_micros = budget_effective_spent(&sql, &existing.window_key)?;
        return Response::from_json(&BudgetReserveResponse {
            allowed: true,
            policy_id: existing.policy_id,
            window_key: existing.window_key,
            charged_micros: sql_count(existing.reserved_micros),
            spent_micros,
            remaining_micros: request.limit_micros.saturating_sub(spent_micros),
        });
    }
    let spent_micros = budget_effective_spent(&sql, &request.window_key)?;
    let remaining_micros = request.limit_micros.saturating_sub(spent_micros);
    if request.cost_micros > remaining_micros {
        return Response::from_json(&BudgetReserveResponse {
            allowed: false,
            policy_id: request.policy_id,
            window_key: request.window_key,
            charged_micros: 0,
            spent_micros,
            remaining_micros,
        });
    }

    let next_spent = spent_micros.saturating_add(request.cost_micros);
    let remaining_after = request.limit_micros.saturating_sub(next_spent);
    sql.exec_raw(
        "INSERT INTO budget_reservations (
            reservation_id, window_key, policy_id, reserved_micros, created_at_ms, settled
        ) VALUES (?, ?, ?, ?, ?, 0)",
        raw_bindings(vec![
            JsValue::from_str(&request.reservation_id),
            JsValue::from_str(&request.window_key),
            JsValue::from_str(&request.policy_id),
            sql_budget_number(request.cost_micros, "reserved_micros")?,
            sql_budget_number(Date::now().as_millis(), "created_at_ms")?,
        ]),
    )?;

    Response::from_json(&BudgetReserveResponse {
        allowed: true,
        policy_id: request.policy_id,
        window_key: request.window_key,
        charged_micros: request.cost_micros,
        spent_micros: next_spent,
        remaining_micros: remaining_after,
    })
}

fn settle_budget_in_object(state: &State, request: BudgetSettleRequest) -> Result<Response> {
    let sql = state.storage().sql();
    ensure_budget_schema(&sql)?;
    maintain_budget_reservations(&sql, Date::now().as_millis())?;
    let Some(reservation) = budget_reservation(&sql, &request.reservation_id)? else {
        return Response::from_json(&BudgetSettleResponse {
            settled: false,
            charged_micros: 0,
            spent_micros: 0,
        });
    };
    let current_spent = budget_effective_spent(&sql, &reservation.window_key)?;
    let next_spent = current_spent
        .saturating_sub(sql_count(reservation.reserved_micros))
        .saturating_add(request.actual_cost_micros);
    sql.exec_raw(
        "UPDATE budget_reservations
            SET reserved_micros = ?, settled = 1
            WHERE reservation_id = ?",
        raw_bindings(vec![
            sql_budget_number(request.actual_cost_micros, "actual_cost_micros")?,
            JsValue::from_str(&request.reservation_id),
        ]),
    )?;
    Response::from_json(&BudgetSettleResponse {
        settled: true,
        charged_micros: request.actual_cost_micros,
        spent_micros: next_spent,
    })
}

fn budget_status_in_object(
    state: &State,
    policy_id: String,
    window_key: String,
    limit_micros: u64,
) -> Result<Response> {
    let sql = state.storage().sql();
    ensure_budget_schema(&sql)?;
    maintain_budget_reservations(&sql, Date::now().as_millis())?;
    let spent_micros = budget_effective_spent(&sql, &window_key)?;
    Response::from_json(&BudgetStatusResponse {
        policy_id,
        window_key,
        limit_micros,
        spent_micros,
        remaining_micros: limit_micros.saturating_sub(spent_micros),
    })
}

fn ensure_budget_schema(sql: &SqlStorage) -> Result<()> {
    sql.exec(
        "CREATE TABLE IF NOT EXISTS budget_windows (
            window_key TEXT PRIMARY KEY,
            policy_id TEXT NOT NULL,
            spent_micros INTEGER NOT NULL
        )",
        None,
    )?;
    sql.exec(
        "CREATE TABLE IF NOT EXISTS budget_reservations (
            reservation_id TEXT PRIMARY KEY,
            window_key TEXT NOT NULL,
            policy_id TEXT NOT NULL,
            reserved_micros INTEGER NOT NULL,
            created_at_ms INTEGER NOT NULL,
            settled INTEGER NOT NULL
        )",
        None,
    )?;
    let has_created_at_ms = sql
        .exec(
            "SELECT created_at_ms FROM budget_reservations LIMIT 0",
            None,
        )
        .is_ok();
    if legacy_budget_schema_requires_accounting_conversion(has_created_at_ms) {
        convert_legacy_reservation_accounting(sql)?;
        sql.exec(
            "ALTER TABLE budget_reservations
                ADD COLUMN created_at_ms INTEGER NOT NULL DEFAULT 0",
            None,
        )?;
        sql.exec_raw(
            "UPDATE budget_reservations SET created_at_ms = ? WHERE created_at_ms = 0",
            raw_bindings(vec![sql_budget_number(
                Date::now().as_millis(),
                "created_at_ms",
            )?]),
        )?;
    }
    if sql
        .exec("SELECT settled FROM budget_reservations LIMIT 0", None)
        .is_err()
    {
        sql.exec(
            "ALTER TABLE budget_reservations
                ADD COLUMN settled INTEGER NOT NULL DEFAULT 0",
            None,
        )?;
    }
    sql.exec(
        "CREATE INDEX IF NOT EXISTS budget_reservations_created_at
            ON budget_reservations (created_at_ms)",
        None,
    )?;
    sql.exec(
        "CREATE INDEX IF NOT EXISTS budget_reservations_pending
            ON budget_reservations (settled, created_at_ms)",
        None,
    )?;
    Ok(())
}

fn legacy_budget_schema_requires_accounting_conversion(has_created_at_ms: bool) -> bool {
    !has_created_at_ms
}

fn convert_legacy_reservation_accounting(sql: &SqlStorage) -> Result<()> {
    let legacy_reservations = sql
        .exec(
            "SELECT window_key, policy_id, reserved_micros
                FROM budget_reservations",
            None,
        )?
        .to_array::<BudgetReservationRow>()?;
    for reservation in legacy_reservations {
        let settled_micros = budget_spent(sql, &reservation.window_key)?
            .saturating_sub(sql_count(reservation.reserved_micros));
        write_budget_spent(
            sql,
            &reservation.window_key,
            &reservation.policy_id,
            settled_micros,
        )?;
    }
    Ok(())
}

fn budget_reservation(
    sql: &SqlStorage,
    reservation_id: &str,
) -> Result<Option<BudgetReservationRow>> {
    Ok(sql
        .exec_raw(
            "SELECT window_key, policy_id, reserved_micros
                FROM budget_reservations WHERE reservation_id = ? LIMIT 1",
            raw_bindings(vec![JsValue::from_str(reservation_id)]),
        )?
        .to_array::<BudgetReservationRow>()?
        .into_iter()
        .next())
}

async fn ensure_budget_cleanup_alarm(state: &State) -> Result<()> {
    let sql = state.storage().sql();
    ensure_budget_schema(&sql)?;
    if state.storage().get_alarm().await?.is_some() {
        return Ok(());
    }
    let delay_ms = if budget_has_pending_reservations(&sql)? {
        BUDGET_RESERVATION_LEASE_MS as i64
    } else if budget_has_any_reservations(&sql)? {
        BUDGET_CLEANUP_INTERVAL_MS
    } else {
        return Ok(());
    };
    state.storage().set_alarm(delay_ms).await?;
    Ok(())
}

fn maintain_budget_reservations(sql: &SqlStorage, now_ms: u64) -> Result<()> {
    sql.exec_raw(
        "UPDATE budget_reservations SET settled = 1
            WHERE settled = 0 AND created_at_ms < ?",
        raw_bindings(vec![sql_budget_number(
            budget_reservation_cutoff_ms(now_ms),
            "reservation_cutoff",
        )?]),
    )?;
    sql.exec_raw(
        "DELETE FROM budget_reservations
            WHERE settled = 1 AND created_at_ms < ?",
        raw_bindings(vec![sql_budget_number(
            budget_charge_retention_cutoff_ms(now_ms),
            "charge_retention_cutoff",
        )?]),
    )?;
    Ok(())
}

fn budget_reservation_cutoff_ms(now_ms: u64) -> u64 {
    now_ms.saturating_sub(BUDGET_RESERVATION_LEASE_MS)
}

fn budget_charge_retention_cutoff_ms(now_ms: u64) -> u64 {
    now_ms.saturating_sub(BUDGET_CHARGE_RETENTION_MS)
}

fn budget_has_pending_reservations(sql: &SqlStorage) -> Result<bool> {
    Ok(!sql
        .exec(
            "SELECT reserved_micros AS spent_micros
                FROM budget_reservations WHERE settled = 0 LIMIT 1",
            None,
        )?
        .to_array::<BudgetSpendRow>()?
        .is_empty())
}

fn budget_has_any_reservations(sql: &SqlStorage) -> Result<bool> {
    Ok(!sql
        .exec(
            "SELECT reserved_micros AS spent_micros
                FROM budget_reservations LIMIT 1",
            None,
        )?
        .to_array::<BudgetSpendRow>()?
        .is_empty())
}

fn budget_spent(sql: &SqlStorage, window_key: &str) -> Result<u64> {
    Ok(sql
        .exec_raw(
            "SELECT spent_micros FROM budget_windows WHERE window_key = ? LIMIT 1",
            raw_bindings(vec![JsValue::from_str(window_key)]),
        )?
        .to_array::<BudgetSpendRow>()?
        .first()
        .map(|row| row.spent_micros.max(0) as u64)
        .unwrap_or_default())
}

fn budget_reserved(sql: &SqlStorage, window_key: &str) -> Result<u64> {
    Ok(sql
        .exec_raw(
            "SELECT COALESCE(SUM(reserved_micros), 0) AS spent_micros
                FROM budget_reservations WHERE window_key = ?",
            raw_bindings(vec![JsValue::from_str(window_key)]),
        )?
        .to_array::<BudgetSpendRow>()?
        .first()
        .map(|row| row.spent_micros.max(0) as u64)
        .unwrap_or_default())
}

fn budget_effective_spent(sql: &SqlStorage, window_key: &str) -> Result<u64> {
    Ok(budget_spent(sql, window_key)?.saturating_add(budget_reserved(sql, window_key)?))
}

fn write_budget_spent(
    sql: &SqlStorage,
    window_key: &str,
    policy_id: &str,
    spent_micros: u64,
) -> Result<()> {
    sql.exec_raw(
        "INSERT INTO budget_windows (window_key, policy_id, spent_micros)
            VALUES (?, ?, ?)
            ON CONFLICT(window_key) DO UPDATE SET spent_micros = excluded.spent_micros",
        raw_bindings(vec![
            JsValue::from_str(window_key),
            JsValue::from_str(policy_id),
            sql_budget_number(spent_micros, "spent_micros")?,
        ]),
    )?;
    Ok(())
}

fn raw_bindings(values: Vec<JsValue>) -> Option<Vec<JsValue>> {
    Some(values)
}

fn sql_budget_number(value: u64, field: &str) -> Result<JsValue> {
    validate_budget_number(value, field).map(JsValue::from_f64)
}

fn validate_budget_number(value: u64, field: &str) -> Result<f64> {
    if value > MAX_SQL_BUDGET_MICROS {
        return Err(Error::RustError(format!(
            "budget field `{field}` exceeds Durable Object SQL integer range"
        )));
    }
    Ok(value as f64)
}

fn tenant_id(auth: &AuthorizedKey) -> String {
    auth.policy
        .tenant_id
        .clone()
        .unwrap_or_else(|| "default".to_string())
}

fn budget_policy_id(tenant_id: &str, kid: &str) -> String {
    format!("{tenant_id}/{kid}")
}

fn budget_object_name(tenant_id: &str, kid: &str) -> String {
    format!("{tenant_id}:{kid}")
}

fn content_retention_view(auth: &AuthorizedKey) -> ContentRetentionView {
    let policy_enabled = auth.policy.retain_request_content;
    let user_exempt = auth.content_retention_disabled;
    ContentRetentionView {
        enabled: policy_enabled && !user_exempt,
        retention_days: CONTENT_RETENTION_DAYS,
        policy_enabled,
        user_exempt,
    }
}

fn content_archive_key(tenant_id: &str, content_ref: &str) -> String {
    format!(
        "v1/{}/{}.json",
        encode_component(tenant_id),
        encode_component(content_ref)
    )
}

async fn retain_request_content(
    env: &Env,
    auth: &AuthorizedKey,
    provider: &str,
    capability: &str,
    model: Option<&str>,
    request_id: &str,
    body: Value,
) -> Result<Option<String>> {
    if !content_retention_view(auth).enabled || !capability.starts_with("llm.") {
        return Ok(None);
    }
    let occurred_at_ms = Date::now().as_millis();
    let content_ref = usage_event_id().replacen("usage_", "content_", 1);
    let record = RetainedRequestContent {
        version: "clawrouter.retained-request.v1",
        content_ref: content_ref.clone(),
        request_id: request_id.to_string(),
        occurred_at_ms,
        expires_at_ms: occurred_at_ms.saturating_add(CONTENT_RETENTION_MS),
        tenant_id: tenant_id(auth),
        policy_id: auth.policy_id.clone(),
        credential_id: auth.credential_id.clone(),
        principal_id: auth.principal_id.clone(),
        provider: provider.to_string(),
        capability: capability.to_string(),
        model: model.map(str::to_string),
        body,
    };
    let bucket = env.bucket("CONTENT_ARCHIVE").map_err(|error| {
        Error::RustError(format!("CONTENT_ARCHIVE binding is unavailable: {error}"))
    })?;
    bucket
        .put(
            content_archive_key(&record.tenant_id, &content_ref),
            serde_json::to_vec(&record)?,
        )
        .execute()
        .await
        .map_err(|error| {
            Error::RustError(format!("request content archive write failed: {error}"))
        })?;
    Ok(Some(content_ref))
}

fn budget_reservation_id() -> String {
    let seq = next_usage_event_sequence();
    let nonce = (js_sys::Math::random() * MAX_SQL_BUDGET_MICROS as f64) as u64;
    format!("budget_{}_{}_{nonce:x}", Date::now().as_millis(), seq)
}

fn current_month_window_key(policy_id: &str) -> Result<String> {
    let iso: String = js_sys::Date::new_0().to_iso_string().into();
    let month = iso
        .get(0..7)
        .ok_or_else(|| Error::RustError("failed to format budget month".to_string()))?;
    Ok(format!("{policy_id}/{month}"))
}

struct UsageRecord<'a> {
    auth: &'a AuthorizedKey,
    attribution: Option<&'a AgentAttribution>,
    provider: &'a str,
    capability: &'a str,
    model: Option<&'a str>,
    request_id: &'a str,
    budget: BudgetUsage,
    request_cost: Option<&'a RequestCost>,
    tokens: UsageTokens,
    status: UsageStatus,
    status_code: u16,
    duration_ms: u64,
    content_ref: Option<String>,
}

struct ProxyAuditContext<'a> {
    env: &'a Env,
    auth: &'a AuthorizedKey,
    provider: &'a str,
    capability: &'a str,
    model: Option<&'a str>,
    request_id: &'a str,
    attribution: &'a AgentAttribution,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct UsageTokens {
    input: Option<u64>,
    output: Option<u64>,
    total: Option<u64>,
    cached_input: Option<u64>,
    cache_write_total: Option<u64>,
    cache_write_input: Option<u64>,
    cache_write_5m_input: Option<u64>,
    cache_write_1h_input: Option<u64>,
}

impl UsageTokens {
    fn merge(&mut self, other: Self) {
        self.input = optional_max(self.input, other.input);
        self.output = optional_max(self.output, other.output);
        self.total = optional_max(self.total, other.total);
        self.cached_input = optional_max(self.cached_input, other.cached_input);
        self.cache_write_total = optional_max(self.cache_write_total, other.cache_write_total);
        self.cache_write_5m_input =
            optional_max(self.cache_write_5m_input, other.cache_write_5m_input);
        self.cache_write_1h_input =
            optional_max(self.cache_write_1h_input, other.cache_write_1h_input);
        self.reconcile_cache_write_breakdown();
        self.total = optional_max(
            self.total,
            self.input
                .zip(self.output)
                .map(|(input, output)| input.saturating_add(output)),
        );
    }

    fn reconcile_cache_write_breakdown(&mut self) {
        let detailed_total = optional_sum([self.cache_write_5m_input, self.cache_write_1h_input]);
        self.cache_write_total = optional_max(self.cache_write_total, detailed_total);
        self.cache_write_input = self
            .cache_write_total
            .map(|total| total.saturating_sub(detailed_total.unwrap_or_default()));
    }
}

fn optional_max(left: Option<u64>, right: Option<u64>) -> Option<u64> {
    match (left, right) {
        (Some(left), Some(right)) => Some(left.max(right)),
        (Some(value), None) | (None, Some(value)) => Some(value),
        (None, None) => None,
    }
}

#[derive(Default)]
struct JsonUsageAccumulator {
    body: Vec<u8>,
    overflowed: bool,
}

impl JsonUsageAccumulator {
    fn push(&mut self, chunk: &[u8]) {
        if !self.overflowed && !append_bounded_usage_body(&mut self.body, chunk) {
            self.overflowed = true;
            self.body.clear();
        }
    }

    fn finish(self) -> (UsageTokens, Option<UsageStatus>, bool) {
        if self.overflowed {
            return (
                UsageTokens::default(),
                Some(UsageStatus::ProviderError),
                false,
            );
        }
        match serde_json::from_slice::<Value>(&self.body) {
            Ok(value) => (
                usage_tokens_from_response(&value),
                json_response_status(&value),
                true,
            ),
            Err(_) => (
                UsageTokens::default(),
                Some(UsageStatus::ProviderError),
                false,
            ),
        }
    }

    fn result(self, transport_complete: bool) -> StreamUsageResult {
        let (tokens, payload_status, payload_complete) = if transport_complete {
            self.finish()
        } else {
            (UsageTokens::default(), None, false)
        };
        let complete = transport_complete && payload_complete;
        StreamUsageResult {
            tokens,
            complete,
            status: Some(if complete {
                payload_status.unwrap_or(UsageStatus::Success)
            } else {
                UsageStatus::ProviderError
            }),
        }
    }
}

fn append_bounded_usage_body(body: &mut Vec<u8>, chunk: &[u8]) -> bool {
    if chunk.len() > USAGE_TOKEN_RESPONSE_MAX_BYTES.saturating_sub(body.len()) {
        return false;
    }
    body.extend_from_slice(chunk);
    true
}

fn usage_tokens_from_response(value: &Value) -> UsageTokens {
    let base_input = first_json_u64(
        value,
        &[
            &["usage", "input_tokens"],
            &["usage", "inputTokens"],
            &["usage", "prompt_tokens"],
            &["response", "usage", "input_tokens"],
            &["response", "usage", "prompt_tokens"],
            &["message", "usage", "input_tokens"],
            &["usageMetadata", "promptTokenCount"],
            &["meta", "billed_units", "input_tokens"],
            &["input_tokens"],
        ],
    );
    let output = first_json_u64(
        value,
        &[
            &["usage", "output_tokens"],
            &["usage", "outputTokens"],
            &["usage", "completion_tokens"],
            &["response", "usage", "output_tokens"],
            &["response", "usage", "completion_tokens"],
            &["message", "usage", "output_tokens"],
            &["usageMetadata", "candidatesTokenCount"],
            &["meta", "billed_units", "output_tokens"],
        ],
    );
    let cached_input_inclusive = first_json_u64(
        value,
        &[
            &["usage", "input_tokens_details", "cached_tokens"],
            &["usage", "prompt_tokens_details", "cached_tokens"],
            &["response", "usage", "input_tokens_details", "cached_tokens"],
            &[
                "response",
                "usage",
                "prompt_tokens_details",
                "cached_tokens",
            ],
        ],
    );
    let cache_read_input = first_json_u64(
        value,
        &[
            &["usage", "cache_read_input_tokens"],
            &["message", "usage", "cache_read_input_tokens"],
        ],
    );
    let cached_input = optional_max(cached_input_inclusive, cache_read_input);
    let cache_write_total = first_json_u64(
        value,
        &[
            &["usage", "cache_creation_input_tokens"],
            &["message", "usage", "cache_creation_input_tokens"],
        ],
    );
    let cache_write_5m_input = first_json_u64(
        value,
        &[
            &["usage", "cache_creation", "ephemeral_5m_input_tokens"],
            &[
                "message",
                "usage",
                "cache_creation",
                "ephemeral_5m_input_tokens",
            ],
        ],
    );
    let cache_write_1h_input = first_json_u64(
        value,
        &[
            &["usage", "cache_creation", "ephemeral_1h_input_tokens"],
            &[
                "message",
                "usage",
                "cache_creation",
                "ephemeral_1h_input_tokens",
            ],
        ],
    );
    let normalized_cache_write_total = optional_max(
        cache_write_total,
        optional_sum([cache_write_5m_input, cache_write_1h_input]),
    );
    let input_excludes_cache = cache_read_input.is_some()
        || cache_write_total.is_some()
        || cache_write_5m_input.is_some()
        || cache_write_1h_input.is_some();
    let input = base_input.map(|input| {
        if input_excludes_cache {
            input
                .saturating_add(cached_input.unwrap_or_default())
                .saturating_add(normalized_cache_write_total.unwrap_or_default())
        } else {
            input
        }
    });
    let reported_total = first_json_u64(
        value,
        &[
            &["usage", "total_tokens"],
            &["usage", "totalTokens"],
            &["response", "usage", "total_tokens"],
            &["usageMetadata", "totalTokenCount"],
            &["input_tokens"],
        ],
    );
    let normalized_total = input
        .zip(output)
        .map(|(input, output)| input.saturating_add(output));
    let total = optional_max(reported_total, normalized_total);
    let mut tokens = UsageTokens {
        input,
        output,
        total,
        cached_input,
        cache_write_total: normalized_cache_write_total,
        cache_write_input: None,
        cache_write_5m_input,
        cache_write_1h_input,
    };
    tokens.reconcile_cache_write_breakdown();
    tokens
}

fn first_json_u64(value: &Value, paths: &[&[&str]]) -> Option<u64> {
    paths.iter().find_map(|path| {
        let mut current = value;
        for segment in *path {
            current = current.get(*segment)?;
        }
        current.as_u64()
    })
}

#[derive(Debug, Default)]
struct StreamUsageResult {
    tokens: UsageTokens,
    complete: bool,
    status: Option<UsageStatus>,
}

struct SseUsageParser {
    line: Vec<u8>,
    line_tail: VecDeque<u8>,
    line_overflowed: bool,
    event_data: Vec<u8>,
    event_tail: VecDeque<u8>,
    event_overflowed: bool,
    event_name: Option<String>,
    event_has_data: bool,
    tokens: UsageTokens,
    terminal: bool,
    terminal_status: Option<UsageStatus>,
    anthropic_stream_seen: bool,
    anthropic_final_usage_seen: bool,
}

impl SseUsageParser {
    fn new() -> Self {
        Self {
            line: Vec::new(),
            line_tail: VecDeque::new(),
            line_overflowed: false,
            event_data: Vec::new(),
            event_tail: VecDeque::new(),
            event_overflowed: false,
            event_name: None,
            event_has_data: false,
            tokens: UsageTokens::default(),
            terminal: false,
            terminal_status: None,
            anthropic_stream_seen: false,
            anthropic_final_usage_seen: false,
        }
    }

    fn push(&mut self, chunk: &[u8]) {
        for byte in chunk {
            if *byte == b'\n' {
                let mut line = std::mem::take(&mut self.line);
                let mut line_tail = std::mem::take(&mut self.line_tail);
                if self.line_overflowed && line_tail.back() == Some(&b'\r') {
                    line_tail.pop_back();
                } else if !self.line_overflowed && line.last() == Some(&b'\r') {
                    line.pop();
                }
                self.consume_line(&line, &line_tail, self.line_overflowed);
                self.line_overflowed = false;
            } else if self.line.len() < USAGE_SSE_EVENT_MAX_BYTES {
                self.line.push(*byte);
            } else {
                self.line_overflowed = true;
                bounded_tail_extend(&mut self.line_tail, &[*byte]);
            }
        }
    }

    fn finish(&mut self) {
        if !self.line.is_empty() || self.line_overflowed {
            let mut line = std::mem::take(&mut self.line);
            let mut line_tail = std::mem::take(&mut self.line_tail);
            if self.line_overflowed && line_tail.back() == Some(&b'\r') {
                line_tail.pop_back();
            } else if !self.line_overflowed && line.last() == Some(&b'\r') {
                line.pop();
            }
            self.consume_line(&line, &line_tail, self.line_overflowed);
            self.line_overflowed = false;
        }
        self.consume_event();
    }

    fn consume_line(&mut self, line: &[u8], overflow_tail: &VecDeque<u8>, line_overflowed: bool) {
        if !line_overflowed && line.is_empty() {
            self.consume_event();
            return;
        }
        if !line_overflowed {
            if let Some(event) = line.strip_prefix(b"event:") {
                let event = event.strip_prefix(b" ").unwrap_or(event);
                if let Ok(event) = std::str::from_utf8(event) {
                    self.event_name = Some(event.trim().to_string());
                }
                return;
            }
        }
        let Some(data) = line.strip_prefix(b"data:") else {
            return;
        };
        let data = data.strip_prefix(b" ").unwrap_or(data);
        if self.event_has_data {
            self.append_event_fragment(b"\n");
        }
        self.event_has_data = true;
        self.append_event_fragment(data);
        if line_overflowed {
            self.event_overflowed = true;
            let overflow_tail = overflow_tail.iter().copied().collect::<Vec<_>>();
            bounded_tail_extend(&mut self.event_tail, &overflow_tail);
        }
    }

    fn append_event_fragment(&mut self, fragment: &[u8]) {
        bounded_tail_extend(&mut self.event_tail, fragment);
        let available = USAGE_SSE_EVENT_MAX_BYTES.saturating_sub(self.event_data.len());
        let retained = available.min(fragment.len());
        self.event_data.extend_from_slice(&fragment[..retained]);
        if retained < fragment.len() {
            self.event_overflowed = true;
        }
    }

    fn consume_event(&mut self) {
        if let Some(status) = self
            .event_name
            .as_deref()
            .and_then(sse_terminal_event_status)
        {
            self.record_terminal(status);
        }
        if !self.event_overflowed && self.event_data.as_slice() == b"[DONE]" {
            self.record_terminal(UsageStatus::Success);
        } else if !self.event_overflowed && !self.event_data.is_empty() {
            if let Ok(value) = serde_json::from_slice::<Value>(&self.event_data) {
                if let Some(status) = sse_terminal_event_status_from_value(&value) {
                    self.record_terminal(status);
                }
                let event_type = value.get("type").and_then(Value::as_str);
                if matches!(
                    event_type,
                    Some("message_start" | "message_delta" | "message_stop")
                ) {
                    self.anthropic_stream_seen = true;
                }
                let mut tokens = usage_tokens_from_response(&value);
                if event_type == Some("message_start") {
                    // Anthropic's start event carries only a preliminary output
                    // count. Settlement must wait for the cumulative delta.
                    tokens.output = None;
                    tokens.total = None;
                } else if event_type == Some("message_delta")
                    && value
                        .get("usage")
                        .and_then(|usage| usage.get("output_tokens"))
                        .and_then(Value::as_u64)
                        .is_some()
                {
                    self.anthropic_final_usage_seen = true;
                }
                self.tokens.merge(tokens);
            }
        } else if self.event_overflowed {
            if let Some(status) = sse_terminal_event_status_from_prefix(&self.event_data) {
                self.record_terminal(status);
            }
            let event_tail = self.event_tail.iter().copied().collect::<Vec<_>>();
            self.tokens.merge(usage_tokens_from_json_tail(&event_tail));
        }
        self.event_data.clear();
        self.event_tail.clear();
        self.event_overflowed = false;
        self.event_name = None;
        self.event_has_data = false;
    }

    fn record_terminal(&mut self, status: UsageStatus) {
        self.terminal = true;
        if self.terminal_status != Some(UsageStatus::ProviderError) {
            self.terminal_status = Some(status);
        }
    }

    fn result(
        &self,
        transport_complete: bool,
        requires_terminal_marker: bool,
    ) -> StreamUsageResult {
        let terminal_complete = !requires_terminal_marker || self.terminal;
        let usage_complete = !self.anthropic_stream_seen || self.anthropic_final_usage_seen;
        let complete = transport_complete && terminal_complete && usage_complete;
        let status = if !complete {
            UsageStatus::ProviderError
        } else {
            self.terminal_status.clone().unwrap_or(UsageStatus::Success)
        };
        StreamUsageResult {
            tokens: self.tokens,
            complete,
            status: Some(status),
        }
    }
}

fn sse_terminal_event_status_from_value(value: &Value) -> Option<UsageStatus> {
    value
        .get("type")
        .and_then(Value::as_str)
        .and_then(sse_terminal_event_status)
}

fn sse_terminal_event_status(event: &str) -> Option<UsageStatus> {
    match event {
        "response.completed" | "message_stop" => Some(UsageStatus::Success),
        "response.cancelled" | "response.incomplete" | "response.failed" => {
            Some(UsageStatus::ProviderError)
        }
        _ => None,
    }
}

fn json_response_status(value: &Value) -> Option<UsageStatus> {
    value
        .get("status")
        .or_else(|| {
            value
                .get("response")
                .and_then(|response| response.get("status"))
        })
        .and_then(Value::as_str)
        .and_then(response_object_status)
}

fn response_object_status(status: &str) -> Option<UsageStatus> {
    match status {
        "completed" => Some(UsageStatus::Success),
        "cancelled" | "failed" | "incomplete" => Some(UsageStatus::ProviderError),
        _ => None,
    }
}

fn bounded_tail_extend(tail: &mut VecDeque<u8>, fragment: &[u8]) {
    if fragment.len() >= USAGE_SSE_EVENT_TAIL_BYTES {
        tail.clear();
        tail.extend(
            fragment[fragment.len() - USAGE_SSE_EVENT_TAIL_BYTES..]
                .iter()
                .copied(),
        );
        return;
    }
    while tail.len().saturating_add(fragment.len()) > USAGE_SSE_EVENT_TAIL_BYTES {
        tail.pop_front();
    }
    tail.extend(fragment.iter().copied());
}

fn sse_terminal_event_status_from_prefix(prefix: &[u8]) -> Option<UsageStatus> {
    json_field_value(prefix, "type", false)
        .as_ref()
        .and_then(Value::as_str)
        .and_then(sse_terminal_event_status)
}

fn usage_tokens_from_json_tail(tail: &[u8]) -> UsageTokens {
    let mut tokens = UsageTokens::default();
    if let Some(usage) = json_field_value(tail, "usage", true) {
        tokens.merge(usage_tokens_from_response(
            &serde_json::json!({"usage": usage}),
        ));
    }
    if let Some(usage_metadata) = json_field_value(tail, "usageMetadata", true) {
        tokens.merge(usage_tokens_from_response(
            &serde_json::json!({"usageMetadata": usage_metadata}),
        ));
    }
    if let Some(meta) = json_field_value(tail, "meta", true) {
        tokens.merge(usage_tokens_from_response(
            &serde_json::json!({"meta": meta}),
        ));
    }
    tokens
}

fn json_field_value(bytes: &[u8], field: &str, reverse: bool) -> Option<Value> {
    let pattern = format!("\"{field}\"");
    let parse_at = |offset: usize| {
        let mut cursor = offset + pattern.len();
        while bytes.get(cursor).is_some_and(u8::is_ascii_whitespace) {
            cursor += 1;
        }
        if bytes.get(cursor) != Some(&b':') {
            return None;
        }
        cursor += 1;
        while bytes.get(cursor).is_some_and(u8::is_ascii_whitespace) {
            cursor += 1;
        }
        let mut deserializer = serde_json::Deserializer::from_slice(bytes.get(cursor..)?);
        Value::deserialize(&mut deserializer).ok()
    };
    if reverse {
        bytes
            .windows(pattern.len())
            .enumerate()
            .rev()
            .filter_map(|(offset, candidate)| (candidate == pattern.as_bytes()).then_some(offset))
            .find_map(parse_at)
    } else {
        bytes
            .windows(pattern.len())
            .enumerate()
            .filter_map(|(offset, candidate)| (candidate == pattern.as_bytes()).then_some(offset))
            .find_map(parse_at)
    }
}

struct UsageMeteredStream {
    inner: Pin<Box<dyn Stream<Item = Result<Vec<u8>>> + 'static>>,
    parser: SseUsageParser,
    sender: Option<oneshot::Sender<StreamUsageResult>>,
    transport_complete: bool,
    requires_terminal_marker: bool,
}

impl UsageMeteredStream {
    fn new(
        inner: impl Stream<Item = Result<Vec<u8>>> + 'static,
        requires_terminal_marker: bool,
        sender: oneshot::Sender<StreamUsageResult>,
    ) -> Self {
        Self {
            inner: Box::pin(inner),
            parser: SseUsageParser::new(),
            sender: Some(sender),
            transport_complete: false,
            requires_terminal_marker,
        }
    }

    fn send_result(&mut self, finish_parser: bool) {
        if finish_parser {
            self.parser.finish();
        }
        let Some(sender) = self.sender.take() else {
            return;
        };
        let _ = sender.send(
            self.parser
                .result(finish_parser, self.requires_terminal_marker),
        );
    }
}

impl Stream for UsageMeteredStream {
    type Item = Result<Vec<u8>>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<Option<Self::Item>> {
        match self.inner.as_mut().poll_next(cx) {
            Poll::Ready(Some(Ok(chunk))) => {
                self.parser.push(&chunk);
                Poll::Ready(Some(Ok(chunk)))
            }
            Poll::Ready(Some(Err(error))) => {
                self.send_result(false);
                Poll::Ready(Some(Err(error)))
            }
            Poll::Ready(None) => {
                self.transport_complete = true;
                self.send_result(true);
                Poll::Ready(None)
            }
            Poll::Pending => Poll::Pending,
        }
    }
}

impl Drop for UsageMeteredStream {
    fn drop(&mut self) {
        if self.sender.is_some() {
            self.send_result(self.transport_complete);
        }
    }
}

struct JsonUsageMeteredStream {
    inner: Pin<Box<dyn Stream<Item = Result<Vec<u8>>> + 'static>>,
    accumulator: JsonUsageAccumulator,
    sender: Option<oneshot::Sender<StreamUsageResult>>,
    transport_complete: bool,
}

impl JsonUsageMeteredStream {
    fn new(
        inner: impl Stream<Item = Result<Vec<u8>>> + 'static,
        sender: oneshot::Sender<StreamUsageResult>,
    ) -> Self {
        Self {
            inner: Box::pin(inner),
            accumulator: JsonUsageAccumulator::default(),
            sender: Some(sender),
            transport_complete: false,
        }
    }

    fn send_result(&mut self, transport_complete: bool) {
        let Some(sender) = self.sender.take() else {
            return;
        };
        let accumulator = std::mem::take(&mut self.accumulator);
        let _ = sender.send(accumulator.result(transport_complete));
    }
}

impl Stream for JsonUsageMeteredStream {
    type Item = Result<Vec<u8>>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<Option<Self::Item>> {
        match self.inner.as_mut().poll_next(cx) {
            Poll::Ready(Some(Ok(chunk))) => {
                self.accumulator.push(&chunk);
                Poll::Ready(Some(Ok(chunk)))
            }
            Poll::Ready(Some(Err(error))) => {
                self.send_result(false);
                Poll::Ready(Some(Err(error)))
            }
            Poll::Ready(None) => {
                self.transport_complete = true;
                self.send_result(true);
                Poll::Ready(None)
            }
            Poll::Pending => Poll::Pending,
        }
    }
}

impl Drop for JsonUsageMeteredStream {
    fn drop(&mut self) {
        if self.sender.is_some() {
            self.send_result(self.transport_complete);
        }
    }
}

struct ProxyCompletion {
    env: Env,
    auth: AuthorizedKey,
    attribution: AgentAttribution,
    provider: String,
    capability: String,
    model: Option<String>,
    request_id: String,
    budget: BudgetUsage,
    request_cost: RequestCost,
    status_code: u16,
    started_at_ms: u64,
    stream_requires_terminal_marker: bool,
    content_ref: Option<String>,
}

impl ProxyCompletion {
    async fn finish(self, result: StreamUsageResult) {
        let StreamUsageResult {
            tokens,
            complete,
            status,
        } = result;
        let actual_cost_micros =
            self.request_cost
                .actual_micros(self.status_code, tokens, complete);
        let budget =
            settle_budget_after_response(&self.env, &self.auth, self.budget, actual_cost_micros)
                .await;
        let status = if (200..=299).contains(&self.status_code) {
            status.unwrap_or(UsageStatus::Success)
        } else {
            usage_status(self.status_code)
        };
        enqueue_usage(
            &self.env,
            UsageRecord {
                auth: &self.auth,
                attribution: Some(&self.attribution),
                provider: &self.provider,
                capability: &self.capability,
                model: self.model.as_deref(),
                request_id: &self.request_id,
                budget,
                request_cost: Some(&self.request_cost),
                tokens,
                status,
                status_code: self.status_code,
                duration_ms: Date::now().as_millis().saturating_sub(self.started_at_ms),
                content_ref: self.content_ref,
            },
        )
        .await;
    }
}

async fn finalize_proxy_response(
    mut response: Response,
    ctx: &Context,
    completion: ProxyCompletion,
) -> Result<Response> {
    let retention = content_retention_view(&completion.auth);
    response.headers_mut().set(
        CONTENT_RETENTION_HEADER,
        if retention.enabled {
            "on; retention-days=30"
        } else {
            "off"
        },
    )?;
    if !(200..=299).contains(&response.status_code()) {
        completion
            .finish(StreamUsageResult {
                tokens: UsageTokens::default(),
                complete: true,
                status: None,
            })
            .await;
        return Ok(response);
    }
    let is_sse = response
        .headers()
        .get("content-type")?
        .is_some_and(|value| value.to_ascii_lowercase().contains("text/event-stream"));
    let is_json = response
        .headers()
        .get("content-type")?
        .is_some_and(|value| value.to_ascii_lowercase().contains("json"));
    if !is_sse && is_json && completion.capability.starts_with("llm.") {
        let status = response.status_code();
        let headers = response.headers().clone();
        let stream = response.stream()?;
        let (sender, receiver) = oneshot::channel();
        ctx.wait_until(async move {
            let result = receiver.await.unwrap_or_default();
            completion.finish(result).await;
        });
        return Ok(
            Response::from_stream(JsonUsageMeteredStream::new(stream, sender))?
                .with_status(status)
                .with_headers(headers),
        );
    }
    if !is_sse {
        completion
            .finish(StreamUsageResult {
                tokens: UsageTokens::default(),
                complete: true,
                status: None,
            })
            .await;
        return Ok(response);
    }

    let status = response.status_code();
    let headers = response.headers().clone();
    let stream = response.stream()?;
    let requires_terminal_marker = completion.stream_requires_terminal_marker;
    let (sender, receiver) = oneshot::channel();
    ctx.wait_until(async move {
        let result = receiver.await.unwrap_or_default();
        completion.finish(result).await;
    });
    Ok(Response::from_stream(UsageMeteredStream::new(
        stream,
        requires_terminal_marker,
        sender,
    ))?
    .with_status(status)
    .with_headers(headers))
}

async fn enqueue_usage(env: &Env, record: UsageRecord<'_>) {
    let queue = match env.queue("USAGE_QUEUE") {
        Ok(queue) => queue,
        Err(error) => {
            console_error!("USAGE_QUEUE binding is unavailable: {}", error);
            return;
        }
    };
    let key_id = record
        .auth
        .credential_id
        .as_deref()
        .unwrap_or(&record.auth.policy_id);
    let mut event = UsageEvent::new_success(
        usage_event_id(),
        tenant_id(record.auth),
        key_id,
        record.request_id,
        record.provider,
        record.capability,
    );
    event.occurred_at_ms = Date::now().as_millis();
    event.policy_id.clone_from(&record.auth.policy_id);
    event.credential_id.clone_from(&record.auth.credential_id);
    event.principal_id.clone_from(&record.auth.principal_id);
    event.auth_type = record.auth.auth_type.to_string();
    if let Some(attribution) = record.attribution {
        event.session_id.clone_from(&attribution.session_id);
        event.agent_id.clone_from(&attribution.agent_id);
        event
            .parent_agent_id
            .clone_from(&attribution.parent_agent_id);
        event.project_id.clone_from(&attribution.project_id);
        event.client.clone_from(&attribution.client);
    }
    event.model = record.model.map(str::to_string);
    event.input_tokens = record.tokens.input;
    event.output_tokens = record.tokens.output;
    event.total_tokens = record.tokens.total;
    event.cached_input_tokens = record.tokens.cached_input;
    event.cache_write_input_tokens = optional_sum([
        record.tokens.cache_write_input,
        record.tokens.cache_write_5m_input,
        record.tokens.cache_write_1h_input,
    ]);
    event.reserved_cost_micros = record.budget.reserved_cost_micros;
    event.actual_cost_micros = record.budget.actual_cost_micros;
    if let Some(request_cost) = record.request_cost {
        event.reserved_input_tokens = Some(request_cost.estimate.input_tokens_upper_bound);
        event.reserved_output_tokens = Some(request_cost.estimate.output_tokens_upper_bound);
        event.pricing_ref.clone_from(&request_cost.pricing_ref);
        event.pricing_effective_at = request_cost
            .pricing
            .as_ref()
            .map(|pricing| pricing.effective_at.clone());
        event.cost_basis = request_cost.basis.label().to_string();
    }
    event.status_code = Some(record.status_code);
    event.duration_ms = Some(record.duration_ms);
    event.content_retained = record.content_ref.is_some();
    event.content_ref = record.content_ref;
    event.status = record.status;
    normalize_usage_event_metadata(&mut event);
    if let Err(error) = queue.send(event).await {
        console_error!(
            "failed to enqueue usage event for request {}: {}",
            record.request_id,
            error
        );
    }
}

fn optional_sum<const N: usize>(values: [Option<u64>; N]) -> Option<u64> {
    values
        .into_iter()
        .fold(None, |sum, value| match (sum, value) {
            (Some(sum), Some(value)) => Some(sum.saturating_add(value)),
            (Some(sum), None) => Some(sum),
            (None, Some(value)) => Some(value),
            (None, None) => None,
        })
}

struct DeniedUsageRecord<'a> {
    auth: &'a AuthorizedKey,
    provider: &'a str,
    capability: &'a str,
    model: Option<&'a str>,
    request_id: &'a str,
    status_code: u16,
    attribution: Option<&'a AgentAttribution>,
}

async fn enqueue_denied_usage(env: &Env, record: DeniedUsageRecord<'_>) {
    enqueue_usage(
        env,
        UsageRecord {
            auth: record.auth,
            attribution: record.attribution,
            provider: record.provider,
            capability: record.capability,
            model: record.model,
            request_id: record.request_id,
            budget: BudgetUsage::default(),
            request_cost: None,
            tokens: UsageTokens::default(),
            status: UsageStatus::Denied,
            status_code: record.status_code,
            duration_ms: 0,
            content_ref: None,
        },
    )
    .await;
}

impl ProxyAuditContext<'_> {
    async fn failure_response(&self, response: Response) -> Result<Response> {
        let status_code = response.status_code();
        enqueue_usage(
            self.env,
            UsageRecord {
                auth: self.auth,
                attribution: Some(self.attribution),
                provider: self.provider,
                capability: self.capability,
                model: self.model,
                request_id: self.request_id,
                budget: BudgetUsage::default(),
                request_cost: None,
                tokens: UsageTokens::default(),
                status: usage_status(status_code),
                status_code,
                duration_ms: 0,
                content_ref: None,
            },
        )
        .await;
        Ok(response)
    }
}

fn usage_event_id() -> String {
    let seq = next_usage_event_sequence();
    let nonce_a = (js_sys::Math::random() * MAX_SQL_BUDGET_MICROS as f64) as u64;
    let nonce_b = (js_sys::Math::random() * MAX_SQL_BUDGET_MICROS as f64) as u64;
    usage_event_id_from_parts(Date::now().as_millis(), seq, nonce_a, nonce_b)
}

fn usage_event_id_from_parts(now_ms: u64, seq: u64, nonce_a: u64, nonce_b: u64) -> String {
    format!("usage_{now_ms}_{seq}_{nonce_a:x}{nonce_b:x}")
}

fn normalize_usage_event_metadata(event: &mut UsageEvent) {
    event.id = truncate_audit_metadata(&event.id, USAGE_AUDIT_FIELD_MAX_BYTES);
    event.event_type = truncate_audit_metadata(&event.event_type, USAGE_AUDIT_FIELD_MAX_BYTES);
    event.tenant_id = truncate_audit_metadata(&event.tenant_id, USAGE_AUDIT_FIELD_MAX_BYTES);
    event.policy_id = truncate_audit_metadata(&event.policy_id, USAGE_AUDIT_FIELD_MAX_BYTES);
    event.credential_id = event
        .credential_id
        .as_deref()
        .map(|value| truncate_audit_metadata(value, USAGE_AUDIT_FIELD_MAX_BYTES));
    event.principal_id = event
        .principal_id
        .as_deref()
        .map(|value| truncate_audit_metadata(value, USAGE_AUDIT_PRINCIPAL_MAX_BYTES));
    event.content_ref = event
        .content_ref
        .as_deref()
        .map(|value| truncate_audit_metadata(value, USAGE_AUDIT_FIELD_MAX_BYTES));
    event.auth_type = truncate_audit_metadata(&event.auth_type, USAGE_AUDIT_FIELD_MAX_BYTES);
    event.session_id = bounded_audit_metadata(event.session_id.take());
    event.agent_id = bounded_audit_metadata(event.agent_id.take());
    event.parent_agent_id = bounded_audit_metadata(event.parent_agent_id.take());
    event.project_id = bounded_audit_metadata(event.project_id.take());
    event.client = bounded_audit_metadata(event.client.take());
    event.key_id = truncate_audit_metadata(&event.key_id, USAGE_AUDIT_FIELD_MAX_BYTES);
    event.request_id = truncate_audit_metadata(&event.request_id, USAGE_AUDIT_FIELD_MAX_BYTES);
    event.provider = truncate_audit_metadata(&event.provider, USAGE_AUDIT_FIELD_MAX_BYTES);
    event.capability = truncate_audit_metadata(&event.capability, USAGE_AUDIT_FIELD_MAX_BYTES);
    event.model = event
        .model
        .as_deref()
        .map(|value| truncate_audit_metadata(value, USAGE_AUDIT_MODEL_MAX_BYTES));
    event.pricing_ref = bounded_audit_metadata(event.pricing_ref.take());
    event.pricing_effective_at = bounded_audit_metadata(event.pricing_effective_at.take());
    event.cost_basis = truncate_audit_metadata(&event.cost_basis, USAGE_AUDIT_FIELD_MAX_BYTES);
}

fn bounded_audit_metadata(value: Option<String>) -> Option<String> {
    value.map(|value| truncate_audit_metadata(&value, USAGE_AUDIT_FIELD_MAX_BYTES))
}

fn truncate_audit_metadata(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_string()
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
        .map(|value| truncate_audit_metadata(&value, USAGE_AUDIT_FIELD_MAX_BYTES))
        .unwrap_or_else(|| format!("req_{}_{}", fallback, Date::now().as_millis()))
}

fn request_attribution(headers: &Headers) -> Result<AgentAttribution> {
    request_attribution_with(|names| bounded_header(headers, names))
}

fn request_attribution_with<E>(
    mut read_header: impl FnMut(&[&str]) -> std::result::Result<Option<String>, E>,
) -> std::result::Result<AgentAttribution, E> {
    Ok(resolve_attribution(AttributionCandidates {
        explicit_session_id: read_header(&["x-clawrouter-session-id"])?,
        claude_session_id: read_header(&["x-claude-code-session-id"])?,
        codex_session_id: read_header(&["session-id", "session_id"])?,
        explicit_agent_id: read_header(&["x-clawrouter-agent-id"])?,
        claude_agent_id: read_header(&["x-claude-code-agent-id"])?,
        explicit_parent_agent_id: read_header(&["x-clawrouter-parent-agent-id"])?,
        claude_parent_agent_id: read_header(&["x-claude-code-parent-agent-id"])?,
        project_id: read_header(&["x-clawrouter-project-id"])?,
        explicit_client: read_header(&["x-clawrouter-client"])?,
    }))
}

fn bounded_header(headers: &Headers, names: &[&str]) -> Result<Option<String>> {
    for name in names {
        if let Some(value) = headers.get(name)? {
            let value = value.trim();
            if !value.is_empty() {
                return Ok(Some(truncate_audit_metadata(
                    value,
                    USAGE_AUDIT_FIELD_MAX_BYTES,
                )));
            }
        }
    }
    Ok(None)
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

fn query_param(url: &Url, name: &str) -> Option<String> {
    url.query_pairs()
        .find_map(|(key, value)| (key == name).then(|| value.to_string()))
}

fn append_query(url: &mut String, query: BTreeMap<String, String>) {
    if query.is_empty() {
        return;
    }
    let pairs = query
        .iter()
        .map(|(name, value)| format!("{}={}", encode_component(name), encode_component(value)))
        .collect::<Vec<_>>()
        .join("&");
    url.push(if url.contains('?') { '&' } else { '?' });
    url.push_str(&pairs);
}

fn append_native_query(
    url: &mut String,
    incoming_query: Option<&str>,
    injected: BTreeMap<String, String>,
) -> Result<()> {
    if let Some(incoming_query) = incoming_query.filter(|query| !query.is_empty()) {
        let forwarded = if incoming_query
            .split('&')
            .any(|pair| raw_query_pair_is_controlled(pair, &injected))
        {
            incoming_query
                .split('&')
                .filter(|pair| !raw_query_pair_is_controlled(pair, &injected))
                .collect::<Vec<_>>()
                .join("&")
        } else {
            incoming_query.to_string()
        };
        if !forwarded.is_empty() {
            url.push(if url.contains('?') { '&' } else { '?' });
            url.push_str(&forwarded);
        }
    }
    append_query(url, injected);
    Ok(())
}

fn raw_query_pair_is_controlled(pair: &str, injected: &BTreeMap<String, String>) -> bool {
    let raw_name = pair.split_once('=').map(|(name, _)| name).unwrap_or(pair);
    let query_name = raw_name.replace('+', " ");
    percent_decode_path_segment(&query_name).is_some_and(|name| injected.contains_key(&name))
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
    sha256_hex_bytes(input.as_bytes())
}

fn sha256_hex_bytes(input: &[u8]) -> String {
    let digest = Sha256::digest(input);
    bytes_to_hex(&digest)
}

fn bytes_to_hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
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

fn cors_preflight() -> Result<Response> {
    with_cors(Response::empty()?.with_status(204))
}

fn cors_enabled_path(path: &str) -> bool {
    is_openai_compatible_path(path)
        || path.starts_with("/v1/proxy/")
        || path.starts_with("/v1/native/")
        || path.starts_with("/v1/playground")
        || matches!(
            path,
            "/v1/health"
                | "/v1/providers"
                | "/v1/routes"
                | "/v1/session"
                | "/v1/entitlements"
                | "/v1/session/usage"
                | "/v1/me"
                | "/v1/usage"
                | "/v1/models"
                | "/v1/catalog"
                | "/v1/key/inspect"
                | "/v1/messages"
                | "/v1/messages/count_tokens"
        )
        || path.starts_with("/v1/admin/")
}

fn with_cors(mut response: Response) -> Result<Response> {
    response
        .headers_mut()
        .set("access-control-allow-origin", CORS_ALLOW_ORIGIN)?;
    response
        .headers_mut()
        .set("access-control-allow-methods", CORS_ALLOW_METHODS)?;
    response
        .headers_mut()
        .set("access-control-allow-headers", CORS_ALLOW_HEADERS)?;
    response
        .headers_mut()
        .set("access-control-expose-headers", CONTENT_RETENTION_HEADER)?;
    response
        .headers_mut()
        .set("access-control-max-age", CORS_MAX_AGE)?;
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn oauth_test_provider() -> CompiledProvider {
        let snapshot = provider_snapshot().unwrap();
        let mut provider = snapshot
            .providers
            .iter()
            .find(|provider| provider.id == "tavily")
            .unwrap()
            .clone();
        provider.id = "oauth-test".to_string();
        provider.auth.schemes = vec![AuthScheme::OAuth {
            provider: Some("acme-oauth".to_string()),
            scopes: vec![],
            token_ref: Some("oauth.acme.access_token".to_string()),
        }];
        provider
    }

    fn relative_path_test_provider() -> CompiledProvider {
        let snapshot = provider_snapshot().unwrap();
        let mut provider = snapshot
            .providers
            .iter()
            .find(|provider| provider.id == "tavily")
            .unwrap()
            .clone();
        provider.id = "relative-path-test".to_string();
        provider
            .base_urls
            .insert("default".to_string(), "https://api.example.com".to_string());
        let endpoint = provider
            .endpoints
            .iter_mut()
            .find(|endpoint| endpoint.id == "search")
            .unwrap();
        endpoint.path = "/v1/${path}".to_string();
        endpoint.path_params = vec!["path".to_string()];
        endpoint
            .path_param_styles
            .insert("path".to_string(), PathParamStyle::RelativePath);
        provider
    }

    fn subscription_test_grant(provider: &str) -> UpstreamGrantRecord {
        UpstreamGrantRecord {
            version: 1,
            enabled: true,
            kind: UpstreamGrantKind::Subscription,
            provider: Some(provider.to_string()),
            label: Some("maintainer subscription".to_string()),
            credential: None,
            credentials: BTreeMap::new(),
            access_token: Some("test-access-token".to_string()),
            refresh_token: Some("test-refresh-token".to_string()),
            token_type: "Bearer".to_string(),
            expires_at: None,
            scopes: vec!["openid".to_string()],
            account_id: Some("acct_test".to_string()),
            subscription: Some(UpstreamGrantSubscription {
                plan: Some("plus".to_string()),
                subject: Some("subject_test".to_string()),
            }),
            refresh: None,
            created_at: Some("2026-06-16T00:00:00.000Z".to_string()),
            updated_at: Some("2026-06-16T00:00:00.000Z".to_string()),
            revoked_at: None,
        }
    }

    fn assignment_test_rule(
        kind: AssignmentRuleKind,
        subject: &str,
        revoke_on_loss: bool,
    ) -> AssignmentRuleRecord {
        AssignmentRuleRecord {
            version: 1,
            enabled: true,
            kind,
            subject: subject.to_string(),
            groups: vec!["maintainers".to_string()],
            policy_ids: vec!["svc_models".to_string()],
            priority: 10,
            revoke_on_loss,
            provenance: "test".to_string(),
            created_at: None,
            updated_at: None,
        }
    }

    fn entitlement_test_row(
        provider: &str,
        allowed: bool,
        executable: bool,
    ) -> EntitlementProviderRow {
        EntitlementProviderRow {
            provider: provider.to_string(),
            display_name: provider.to_string(),
            service_kind: "model_provider".to_string(),
            allowed,
            policies: if allowed {
                vec!["maintainers".to_string()]
            } else {
                Vec::new()
            },
            readiness: ProviderReadinessRow {
                id: provider.to_string(),
                display_name: provider.to_string(),
                class: "openai_compatible".to_string(),
                service_kind: "model_provider".to_string(),
                required_config: Vec::new(),
                optional_config: Vec::new(),
                missing_config: Vec::new(),
                config_present: true,
                connection_enabled: true,
                oauth_grant_required: false,
                oauth_grant_count: 0,
                upstream_grant_count: 0,
                openai_compatible: true,
                manifest_routes: 1,
                executable_endpoints: Vec::new(),
                model_count: 1,
                executable,
                verified: false,
                last_checked_at: None,
                latency_ms: None,
                status: if executable {
                    "unverified"
                } else {
                    "unsupported"
                }
                .to_string(),
                reasons: Vec::new(),
            },
        }
    }

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
        let route = select_model_route(&snapshot, "openai/gpt-4.1-mini").unwrap();
        assert_eq!(route.provider.id, "openai");
        assert_eq!(route.upstream_model, "gpt-4.1-mini");
        assert_eq!(
            route.pricing_ref.as_deref(),
            Some("openai-gpt-4.1-mini-standard-2026-06-19")
        );
        assert_eq!(
            route.pricing.as_ref().unwrap().output_micros_per_million,
            1_600_000
        );
    }

    #[test]
    fn native_models_rewrite_public_ids_and_keep_pricing() {
        let snapshot = provider_snapshot().unwrap();
        let anthropic = snapshot
            .providers
            .iter()
            .find(|provider| provider.id == "anthropic")
            .unwrap();
        let mut body =
            serde_json::json!({"model": "anthropic/claude-opus-4-8", "max_tokens": 1024});
        let original = body.clone();
        let selected = select_native_model(anthropic, &body).unwrap();
        assert_eq!(body, original);
        assert_eq!(selected.model, "anthropic/claude-opus-4-8");
        assert_eq!(selected.upstream_model, "claude-opus-4-8");
        let selection = normalize_native_model(anthropic, &mut body).unwrap();
        assert_eq!(selection.model, "anthropic/claude-opus-4-8");
        assert_eq!(body["model"], "claude-opus-4-8");
        assert_eq!(
            selection.pricing.unwrap().input_micros_per_million,
            5_000_000
        );
    }

    #[test]
    fn manifest_model_requests_keep_catalog_pricing_and_normalization() {
        let snapshot = provider_snapshot().unwrap();
        let openai = snapshot
            .providers
            .iter()
            .find(|provider| provider.id == "openai")
            .unwrap();
        let mut body = serde_json::json!({
            "model": "openai/gpt-5.4",
            "input": "hello",
            "max_output_tokens": 100
        });
        let selection = normalize_native_model(openai, &mut body).unwrap();
        normalize_list_pricing_request(openai, "/v1/responses", true, &mut body).unwrap();
        let serialized = serde_json::to_vec(&body).unwrap();
        let policy = AccessPolicy {
            enabled: true,
            generation: "test".to_string(),
            providers: vec!["openai".to_string()],
            tenant_id: Some("test".to_string()),
            token_role: None,
            monthly_budget_micros: Some(1_000_000),
            request_cost_micros: None,
            retain_request_content: true,
        };
        let cost = RequestCost::for_request(
            &policy,
            selection.pricing_ref.as_deref(),
            selection.pricing.as_ref(),
            &serialized,
            Some(&body),
        );
        assert_eq!(body["model"], "gpt-5.4");
        assert_eq!(body["service_tier"], "default");
        assert_eq!(cost.basis, RequestCostBasis::ListedPrice);
        assert!(cost.reserve_micros > 1);

        let count_cost = RequestCost::for_capability(
            "llm.count_tokens",
            &policy,
            selection.pricing_ref.as_deref(),
            selection.pricing.as_ref(),
            &serialized,
            Some(&body),
        );
        assert_eq!(count_cost.basis, RequestCostBasis::None);
        assert_eq!(count_cost.reserve_micros, 0);

        let unpriced_tool_cost = RequestCost::for_capability(
            "web.search",
            &policy,
            None,
            None,
            b"{}",
            Some(&serde_json::json!({})),
        );
        assert_eq!(unpriced_tool_cost.basis, RequestCostBasis::FlatFallback);
        assert!(budget_requires_declared_price(&unpriced_tool_cost));
    }

    #[test]
    fn client_catalog_and_models_filter_by_effective_entitlement() {
        let snapshot = provider_snapshot().unwrap();
        let mut openai = entitlement_test_row("openai", true, true);
        openai.readiness.executable_endpoints = vec!["responses".to_string()];
        let rows = vec![
            openai,
            entitlement_test_row("anthropic", false, true),
            entitlement_test_row("xai", true, false),
        ];
        let models = client_models_value(&snapshot, &rows);
        let ids = models["data"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|model| model["id"].as_str())
            .collect::<Vec<_>>();
        assert!(ids.contains(&"openai/gpt-4.1-mini"));
        assert!(!ids.contains(&"openai/text-embedding-3-large"));
        assert!(!ids.contains(&"anthropic/default"));
        assert!(!ids.contains(&"xai/default"));
        assert_eq!(
            models["data"][0]["capabilities"],
            serde_json::json!(["llm.responses"])
        );

        let catalog = client_catalog_value(&snapshot, rows);
        let providers = catalog["providers"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|provider| provider["id"].as_str())
            .collect::<Vec<_>>();
        assert_eq!(providers, vec!["openai", "xai"]);
        assert_eq!(
            catalog["providers"][0]["nativeBaseUrl"],
            "/v1/native/openai"
        );
        assert_eq!(catalog["providers"][0]["openaiCompatible"], true);
        assert_eq!(
            catalog["providers"][0]["routes"][0]["endpoint"],
            "responses"
        );
        assert_eq!(
            catalog["providers"][0]["routes"][0]["requestFormat"],
            "openai.responses"
        );
        assert_eq!(
            catalog["providers"][0]["routes"][0]["responseFormat"],
            "openai.responses"
        );
        assert_eq!(
            catalog["providers"][0]["models"][0]["capabilities"],
            serde_json::json!(["llm.responses"])
        );
        assert_eq!(catalog["providers"][1]["openaiCompatible"], false);
    }

    #[test]
    fn anthropic_model_discovery_uses_the_anthropic_page_shape() {
        let snapshot = provider_snapshot().unwrap();
        let mut anthropic = entitlement_test_row("anthropic", true, true);
        anthropic.readiness.executable_endpoints = vec!["messages".to_string()];
        let models = anthropic_models_value(&snapshot, &[anthropic]);
        assert_eq!(models["has_more"], false);
        assert_eq!(models["first_id"], "anthropic/claude-opus-4-8");
        assert_eq!(models["last_id"], "anthropic/claude-haiku-4-5");
        assert_eq!(models["data"][0]["id"], "anthropic/claude-opus-4-8");
        assert_eq!(models["data"][0]["type"], "model");
        assert_eq!(models["data"][0]["created_at"], "1970-01-01T00:00:00Z");
        assert!(models["data"][0]["capabilities"].is_null());
        assert_eq!(models["data"][0]["max_input_tokens"], 1_000_000);
        assert_eq!(models["data"][0]["max_tokens"], 128_000);
        assert!(models["data"][0].get("owned_by").is_none());
    }

    #[test]
    fn client_catalog_describes_native_transport_formats() {
        let snapshot = provider_snapshot().unwrap();
        let mut anthropic = entitlement_test_row("anthropic", true, true);
        anthropic.readiness.executable_endpoints = vec!["messages".to_string()];
        let catalog = client_catalog_value(&snapshot, vec![anthropic]);
        let provider = &catalog["providers"][0];
        assert_eq!(provider["openaiCompatible"], false);
        assert_eq!(provider["nativeBaseUrl"], "/v1/native/anthropic");
        assert_eq!(provider["routes"][0]["path"], "/v1/messages");
        assert_eq!(provider["routes"][0]["requestFormat"], "anthropic.messages");
        assert_eq!(
            provider["routes"][0]["responseFormat"],
            "anthropic.messages"
        );
    }

    #[test]
    fn anthropic_manifest_covers_claude_code_gateway_contract() {
        let snapshot = provider_snapshot().unwrap();
        let anthropic = snapshot
            .providers
            .iter()
            .find(|provider| provider.id == "anthropic")
            .unwrap();
        let messages = anthropic
            .endpoints
            .iter()
            .find(|endpoint| endpoint.id == "messages")
            .unwrap();
        let count_tokens = anthropic
            .endpoints
            .iter()
            .find(|endpoint| endpoint.id == "count_tokens")
            .unwrap();
        assert_eq!(messages.path, "/v1/messages");
        assert_eq!(count_tokens.path, "/v1/messages/count_tokens");
        assert!(native_request_header_allowed(
            anthropic,
            messages,
            "anthropic-beta"
        ));
        assert!(native_request_header_allowed(
            anthropic,
            messages,
            "anthropic-version"
        ));
    }

    #[test]
    fn openai_proxy_excludes_template_and_non_openai_adapters() {
        let snapshot = provider_snapshot().unwrap();
        let route = select_model_route(&snapshot, "azure-openai/my-deployment").unwrap();
        assert_eq!(route.provider.id, "azure-openai");
        assert_eq!(route.upstream_model, "my-deployment");
        assert!(select_model_route(&snapshot, "cohere/default").is_none());
        assert!(select_model_route(&snapshot, "cloudflare-ai-gateway/auto").is_none());
    }

    #[test]
    fn openai_proxy_resolves_configured_catalog_model_aliases() {
        let snapshot = provider_snapshot().unwrap();
        let route = select_model_route(&snapshot, "azure-openai/deployment").unwrap();
        assert_eq!(route.upstream_model, "${deployment}");
        let upstream_model = resolve_selected_upstream_model(&route, |provider, template| {
            (provider.id == "azure-openai" && template == "${deployment}")
                .then(|| "configured-deployment".to_string())
                .ok_or_else(|| Error::RustError("unexpected template".to_string()))
        })
        .unwrap();
        assert_eq!(route.provider.id, "azure-openai");
        assert_eq!(upstream_model, "configured-deployment");
        assert_eq!(
            route.pricing_ref.as_deref(),
            Some("azure-openai-deployment")
        );
    }

    #[test]
    fn configured_catalog_model_aliases_preserve_runtime_errors() {
        let snapshot = provider_snapshot().unwrap();
        let route = select_model_route(&snapshot, "azure-openai/deployment").unwrap();
        let result = resolve_selected_upstream_model(&route, |provider, _| {
            Err(Error::RustError(format!(
                "missing Cloudflare config value `deployment` for provider `{}`",
                provider.id
            )))
        });
        let Err(error) = result else {
            panic!("expected runtime configuration error");
        };
        assert!(provider_runtime_config_error_message(&error).is_some());
    }

    #[test]
    fn openai_proxy_support_filter_allows_config_backed_templates() {
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
        assert!(supports_openai_compatible_proxy(azure));
        assert_eq!(
            openai_endpoint_path(
                azure
                    .endpoints
                    .iter()
                    .find(|endpoint| endpoint.id == "chat_completions")
                    .unwrap(),
                "docs-deployment"
            )
            .unwrap(),
            "/openai/deployments/docs-deployment/chat/completions"
        );
    }

    #[test]
    fn openai_path_params_reject_slashy_model_suffixes_as_client_errors() {
        let snapshot = provider_snapshot().unwrap();
        let azure = snapshot
            .providers
            .iter()
            .find(|provider| provider.id == "azure-openai")
            .unwrap();
        let endpoint = azure
            .endpoints
            .iter()
            .find(|endpoint| endpoint.id == "chat_completions")
            .unwrap();
        let error = openai_endpoint_path(endpoint, "bad/deployment").unwrap_err();
        match error {
            OpenAiProxyUrlError::Client(message) => {
                assert!(message.contains("safe path segment"));
            }
            OpenAiProxyUrlError::Runtime(_) => panic!("expected client error"),
        }
    }

    #[test]
    fn openai_proxy_support_filter_accepts_declared_templated_headers() {
        let snapshot = provider_snapshot().unwrap();
        let openrouter = snapshot
            .providers
            .iter()
            .find(|provider| provider.id == "openrouter")
            .unwrap();
        assert!(supports_openai_compatible_proxy(openrouter));
        assert!(template_binding_candidates(openrouter, "site_url")
            .iter()
            .any(|binding| binding == "OPENROUTER_SITE_URL"));
    }

    #[test]
    fn azure_openai_chat_requests_use_completion_token_limit() {
        let snapshot = provider_snapshot().unwrap();
        let provider = snapshot
            .providers
            .iter()
            .find(|provider| provider.id == "azure-openai")
            .unwrap();
        let mut body = serde_json::json!({
            "model": "gpt-54-mini-live",
            "messages": [{"role": "user", "content": "reply with ok"}],
            "max_tokens": 16
        });
        let mut provider = provider.clone();
        provider.adapter.request_transforms.rename_fields[0].upstreams =
            vec!["gpt-54-mini-live".to_string()];
        provider.adapter.request_transforms.rename_fields[0].upstream_config = None;

        normalize_openai_proxy_body(
            &provider,
            "/v1/chat/completions",
            "gpt-54-mini-live",
            None,
            &mut body,
        );
        assert!(body.get("max_tokens").is_none());
        assert_eq!(body["max_completion_tokens"], 16);

        let mut explicit_body = serde_json::json!({
            "model": "gpt-54-mini-live",
            "messages": [{"role": "user", "content": "reply with ok"}],
            "max_tokens": 16,
            "max_completion_tokens": 32
        });
        normalize_openai_proxy_body(
            &provider,
            "/v1/chat/completions",
            "gpt-54-mini-live",
            None,
            &mut explicit_body,
        );
        assert!(explicit_body.get("max_tokens").is_none());
        assert_eq!(explicit_body["max_completion_tokens"], 32);

        let mut generic_body = serde_json::json!({
            "model": "old-chat-deployment",
            "messages": [{"role": "user", "content": "reply with ok"}],
            "max_tokens": 16
        });
        normalize_openai_proxy_body(
            &provider,
            "/v1/chat/completions",
            "old-chat-deployment",
            None,
            &mut generic_body,
        );
        assert_eq!(generic_body["max_tokens"], 16);
        assert!(generic_body.get("max_completion_tokens").is_none());
    }

    #[test]
    fn azure_manifest_chat_requests_use_completion_token_limit() {
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
        let mut provider = provider.clone();
        provider.adapter.request_transforms.rename_fields[0].upstreams =
            vec!["configured-deployment".to_string()];
        provider.adapter.request_transforms.rename_fields[0].upstream_config = None;
        let mut body = serde_json::json!({
            "model": "configured-deployment",
            "messages": [{"role": "user", "content": "reply with ok"}],
            "max_tokens": 16
        });

        normalize_openai_proxy_body(
            &provider,
            manifest_transform_path(endpoint),
            "configured-deployment",
            None,
            &mut body,
        );

        assert!(body.get("max_tokens").is_none());
        assert_eq!(body["max_completion_tokens"], 16);
    }

    #[test]
    fn openai_list_pricing_pins_default_and_rejects_undeclared_tiers() {
        let snapshot = provider_snapshot().unwrap();
        let provider = snapshot
            .providers
            .iter()
            .find(|provider| provider.id == "openai")
            .unwrap();
        let mut body = serde_json::json!({"model": "gpt-5.4", "input": "hello"});
        normalize_list_pricing_request(provider, "/v1/responses", true, &mut body).unwrap();
        assert_eq!(body["service_tier"], "default");

        let mut auto = serde_json::json!({"service_tier": "auto"});
        normalize_list_pricing_request(provider, "/v1/chat/completions", true, &mut auto).unwrap();
        assert_eq!(auto["service_tier"], "default");

        let mut nullable_tier = serde_json::json!({"service_tier": null});
        normalize_list_pricing_request(provider, "/v1/chat/completions", true, &mut nullable_tier)
            .unwrap();
        assert_eq!(nullable_tier["service_tier"], "default");

        let mut streaming = serde_json::json!({
            "stream": true,
            "stream_options": {"include_usage": false, "include_obfuscation": false}
        });
        normalize_list_pricing_request(provider, "/v1/chat/completions", true, &mut streaming)
            .unwrap();
        assert_eq!(streaming["stream_options"]["include_usage"], true);
        assert_eq!(streaming["stream_options"]["include_obfuscation"], false);

        let mut nullable_stream_options = serde_json::json!({
            "stream": true,
            "stream_options": null
        });
        normalize_list_pricing_request(
            provider,
            "/v1/chat/completions",
            true,
            &mut nullable_stream_options,
        )
        .unwrap();
        assert_eq!(
            nullable_stream_options["stream_options"]["include_usage"],
            true
        );

        for tier in ["priority", "flex", "scale"] {
            let mut premium = serde_json::json!({"service_tier": tier});
            assert!(
                normalize_list_pricing_request(provider, "/v1/responses", true, &mut premium)
                    .is_err()
            );
        }

        let mut fixed_price = serde_json::json!({"service_tier": "priority"});
        normalize_list_pricing_request(provider, "/v1/responses", false, &mut fixed_price).unwrap();
        assert_eq!(fixed_price["service_tier"], "priority");

        let mut background = serde_json::json!({"background": true});
        assert!(
            normalize_list_pricing_request(provider, "/v1/responses", true, &mut background)
                .unwrap_err()
                .contains("background Responses")
        );
        normalize_list_pricing_request(provider, "/v1/responses", false, &mut background).unwrap();

        let native = serde_json::json!({
            "model": "gpt-5.4",
            "service_tier": "default",
            "stream": true,
            "stream_options": {"include_usage": true}
        });
        let original = native.clone();
        validate_native_list_pricing_request(provider, "/v1/chat/completions", true, &native)
            .unwrap();
        assert_eq!(native, original);
        assert!(validate_native_list_pricing_request(
            provider,
            "/v1/responses",
            true,
            &serde_json::json!({"model": "gpt-5.4"}),
        )
        .is_err());
        assert!(validate_native_list_pricing_request(
            provider,
            "/v1/chat/completions",
            true,
            &serde_json::json!({
                "service_tier": "default",
                "stream": true
            }),
        )
        .is_err());
        assert!(validate_native_list_pricing_request(
            provider,
            "/v1/responses",
            true,
            &serde_json::json!({
                "service_tier": "default",
                "background": true
            }),
        )
        .unwrap_err()
        .contains("background Responses"));
    }

    #[test]
    fn provider_list_pricing_rejects_unpriced_tiers_and_modalities() {
        let snapshot = provider_snapshot().unwrap();
        let xai = snapshot
            .providers
            .iter()
            .find(|provider| provider.id == "xai")
            .unwrap();
        let google = snapshot
            .providers
            .iter()
            .find(|provider| provider.id == "google-gemini")
            .unwrap();

        let mut standard = serde_json::json!({"model": "xai/default"});
        normalize_list_pricing_request(xai, "/v1/chat/completions", true, &mut standard).unwrap();
        let mut priority = serde_json::json!({"service_tier": "priority"});
        assert!(
            normalize_list_pricing_request(xai, "/v1/chat/completions", true, &mut priority,)
                .unwrap_err()
                .contains("standard processing")
        );
        normalize_list_pricing_request(xai, "/v1/chat/completions", false, &mut priority).unwrap();
        assert!(validate_native_list_pricing_request(
            xai,
            "/v1/chat/completions",
            true,
            &serde_json::json!({"service_tier": "priority"}),
        )
        .is_err());

        let mut text = serde_json::json!({
            "contents": [{"parts": [{"text": "hello"}]}]
        });
        normalize_list_pricing_request(
            google,
            "/v1beta/models/${model}:generateContent",
            true,
            &mut text,
        )
        .unwrap();
        let mut audio = serde_json::json!({
            "contents": [{"parts": [{"inlineData": {"mimeType": "audio/mpeg", "data": "AA=="}}]}]
        });
        assert!(normalize_list_pricing_request(
            google,
            "/v1beta/models/${model}:generateContent",
            true,
            &mut audio,
        )
        .unwrap_err()
        .contains("audio inputs"));
        normalize_list_pricing_request(
            google,
            "/v1beta/models/${model}:generateContent",
            false,
            &mut audio,
        )
        .unwrap();
    }

    #[test]
    fn listed_model_pricing_rejects_server_tools_without_a_fixed_price() {
        let policy = AccessPolicy {
            enabled: true,
            generation: "test".to_string(),
            providers: vec!["anthropic".to_string()],
            tenant_id: Some("test".to_string()),
            token_role: None,
            monthly_budget_micros: Some(1_000_000),
            request_cost_micros: None,
            retain_request_content: true,
        };
        let pricing = ModelPricing {
            effective_at: "2026-06-19".to_string(),
            source: "https://example.com/pricing".to_string(),
            input_micros_per_million: 1,
            output_micros_per_million: 1,
            cached_input_micros_per_million: None,
            cache_write_5m_input_micros_per_million: None,
            cache_write_1h_input_micros_per_million: None,
            max_input_tokens: 1_000,
            max_request_input_tokens: None,
            default_max_output_tokens: 100,
            input_token_overhead: 0,
            long_context: None,
        };
        assert!(validate_request_beta_pricing(
            &policy,
            Some(&pricing),
            ProviderToolDialect::Anthropic,
            "llm.messages",
            Some("prompt-caching-2024-07-31, context-1m-2025-08-07"),
        )
        .is_err());
        validate_request_beta_pricing(
            &policy,
            Some(&pricing),
            ProviderToolDialect::Anthropic,
            "llm.messages",
            Some("prompt-caching-2024-07-31"),
        )
        .unwrap();
        let mut long_context_pricing = pricing.clone();
        long_context_pricing.max_input_tokens = ANTHROPIC_1M_CONTEXT_MIN_INPUT_TOKENS;
        long_context_pricing.long_context = Some(clawrouter_core::pricing::LongContextPricing {
            threshold_input_tokens: 200_000,
            input_micros_per_million: 2,
            output_micros_per_million: 2,
            cached_input_micros_per_million: None,
            cache_write_5m_input_micros_per_million: None,
            cache_write_1h_input_micros_per_million: None,
        });
        validate_request_beta_pricing(
            &policy,
            Some(&long_context_pricing),
            ProviderToolDialect::Anthropic,
            "llm.messages",
            Some("context-1m-2025-08-07"),
        )
        .unwrap();
        validate_request_beta_pricing(
            &policy,
            Some(&pricing),
            ProviderToolDialect::Anthropic,
            "llm.count_tokens",
            Some("context-1m-2025-08-07"),
        )
        .unwrap();
        let server_tool = serde_json::json!({
            "tools": [{"type": "web_search_20260209", "name": "web_search"}]
        });
        assert!(validate_request_tool_pricing(
            &policy,
            Some(&pricing),
            ProviderToolDialect::Anthropic,
            "llm.messages",
            &server_tool
        )
        .is_err());

        let token_only_web_fetch = serde_json::json!({
            "tools": [{
                "type": "web_fetch_20250910",
                "name": "web_fetch",
                "max_content_tokens": 500
            }]
        });
        assert!(validate_request_tool_pricing(
            &policy,
            Some(&pricing),
            ProviderToolDialect::Anthropic,
            "llm.messages",
            &token_only_web_fetch,
        )
        .is_err());

        let mut fixed_policy = policy.clone();
        fixed_policy.request_cost_micros = Some(100);
        validate_request_beta_pricing(
            &fixed_policy,
            Some(&pricing),
            ProviderToolDialect::Anthropic,
            "llm.messages",
            Some("context-1m-2025-08-07"),
        )
        .unwrap();
        validate_request_tool_pricing(
            &fixed_policy,
            Some(&pricing),
            ProviderToolDialect::Anthropic,
            "llm.messages",
            &token_only_web_fetch,
        )
        .unwrap();

        let indirect_mcp = serde_json::json!({
            "mcp_servers": [{
                "type": "url",
                "url": "https://example.com/mcp",
                "name": "remote",
                "tool_configuration": {"enabled": true}
            }]
        });
        assert!(validate_request_tool_pricing(
            &policy,
            Some(&pricing),
            ProviderToolDialect::Anthropic,
            "llm.messages",
            &indirect_mcp,
        )
        .is_err());

        for client_tool in [
            serde_json::json!({"tools": [{"name": "read", "input_schema": {}}]}),
            serde_json::json!({"tools": [{"type": "function", "function": {"name": "read"}}]}),
            serde_json::json!({"tools": [{"type": "namespace", "name": "mcp"}]}),
            serde_json::json!({"tools": [{"type": "local_shell"}]}),
            serde_json::json!({"tools": [{"type": "bash_20250124", "name": "bash"}]}),
            serde_json::json!({"tools": [{"type": "text_editor_20250728", "name": "editor"}]}),
            serde_json::json!({"tools": [{"type": "computer_20250124", "name": "computer"}]}),
            serde_json::json!({"tools": [{"type": "memory_20250818", "name": "memory"}]}),
        ] {
            validate_request_tool_pricing(
                &policy,
                Some(&pricing),
                ProviderToolDialect::Anthropic,
                "llm.messages",
                &client_tool,
            )
            .unwrap();
        }

        let local_openai_shell = serde_json::json!({
            "tools": [{"type": "shell", "environment": {"type": "local"}}]
        });
        validate_request_tool_pricing(
            &policy,
            Some(&pricing),
            ProviderToolDialect::OpenAi,
            "llm.responses",
            &local_openai_shell,
        )
        .unwrap();
        let hosted_openai_shell = serde_json::json!({
            "tools": [{"type": "shell", "environment": {"type": "container_auto"}}]
        });
        assert!(validate_request_tool_pricing(
            &policy,
            Some(&pricing),
            ProviderToolDialect::OpenAi,
            "llm.responses",
            &hosted_openai_shell,
        )
        .is_err());

        validate_request_tool_pricing(
            &policy,
            Some(&pricing),
            ProviderToolDialect::Anthropic,
            "llm.count_tokens",
            &server_tool,
        )
        .unwrap();

        let fixed = AccessPolicy {
            request_cost_micros: Some(10_000),
            ..policy
        };
        validate_request_tool_pricing(
            &fixed,
            Some(&pricing),
            ProviderToolDialect::Anthropic,
            "llm.messages",
            &server_tool,
        )
        .unwrap();
    }

    #[test]
    fn tool_pricing_dialect_comes_from_manifest_contract_not_provider_id() {
        let snapshot = provider_snapshot().unwrap();
        let mut provider = snapshot
            .providers
            .iter()
            .find(|provider| provider.id == "anthropic")
            .unwrap()
            .clone();
        provider.id = "enterprise-claude-gateway".to_string();
        assert_eq!(
            provider_tool_dialect(&provider),
            ProviderToolDialect::Anthropic
        );
    }

    #[test]
    fn manifest_proxy_accepts_config_backed_base_templates() {
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
        assert!(supports_manifest_proxy(provider, endpoint));
    }

    #[test]
    fn template_resolution_uses_declared_config_keys_only() {
        let snapshot = provider_snapshot().unwrap();
        let azure = snapshot
            .providers
            .iter()
            .find(|provider| provider.id == "azure-openai")
            .unwrap();
        let endpoint_candidates = template_binding_candidates(azure, "endpoint");
        assert_eq!(endpoint_candidates, vec!["AZURE_OPENAI_ENDPOINT"]);
        assert!(!endpoint_candidates
            .iter()
            .any(|key| key == "AZURE_ENDPOINT"));
        let optional = provider_optional_config_keys(azure);
        assert!(optional
            .iter()
            .any(|key| key == "AZURE_OPENAI_COMPLETION_TOKEN_DEPLOYMENTS"));
    }

    #[test]
    fn firecrawl_keyless_manifest_is_routable() {
        let snapshot = provider_snapshot().unwrap();
        let provider = snapshot
            .providers
            .iter()
            .find(|provider| provider.id == "firecrawl")
            .unwrap();
        let endpoint = provider
            .endpoints
            .iter()
            .find(|endpoint| endpoint.id == "scrape")
            .unwrap();

        assert!(supports_manifest_proxy(provider, endpoint));
        assert_eq!(
            provider_optional_config_keys(provider),
            vec!["FIRECRAWL_API_KEY".to_string()]
        );
        assert_eq!(provider.auth_schemes, vec!["bearer:api_key:optional"]);
        assert_eq!(endpoint.path, "/v2/scrape");
    }

    #[test]
    fn manifest_proxy_supports_oauth_with_token_refs() {
        let provider = oauth_test_provider();
        let endpoint = provider
            .endpoints
            .iter()
            .find(|endpoint| endpoint.id == "search")
            .unwrap();
        assert!(supports_manifest_proxy(&provider, endpoint));
    }

    #[test]
    fn manifest_proxy_supports_sigv4_when_configured() {
        let snapshot = provider_snapshot().unwrap();
        let provider = snapshot
            .providers
            .iter()
            .find(|provider| provider.id == "aws-bedrock")
            .unwrap();
        let endpoint = provider
            .endpoints
            .iter()
            .find(|endpoint| endpoint.id == "invoke_model")
            .unwrap();
        assert!(supports_manifest_proxy(provider, endpoint));
        assert!(template_binding_candidates(provider, "access_key_id")
            .iter()
            .any(|binding| binding == "AWS_ACCESS_KEY_ID"));
        assert!(template_binding_candidates(provider, "secret_access_key")
            .iter()
            .any(|binding| binding == "AWS_SECRET_ACCESS_KEY"));
        assert_eq!(
            provider_auth_secret_config_keys(provider),
            BTreeSet::from([
                "AWS_ACCESS_KEY_ID".to_string(),
                "AWS_SECRET_ACCESS_KEY".to_string(),
            ])
        );
    }

    #[test]
    fn route_catalog_lists_proxy_surfaces() {
        let snapshot = provider_snapshot().unwrap();
        let catalog = route_catalog(&snapshot);
        let openai_routes = catalog
            .get("openaiCompatible")
            .and_then(Value::as_array)
            .unwrap();
        let manifest_routes = catalog
            .get("manifestProxy")
            .and_then(Value::as_array)
            .unwrap();
        let native_routes = catalog
            .get("nativeProxy")
            .and_then(Value::as_array)
            .unwrap();

        assert!(openai_routes
            .iter()
            .any(|route| route.get("provider").and_then(Value::as_str) == Some("openai")));
        assert!(manifest_routes.iter().any(|route| {
            route.get("provider").and_then(Value::as_str) == Some("tavily")
                && route.get("endpoint").and_then(Value::as_str) == Some("search")
                && route.get("route").and_then(Value::as_str) == Some("/v1/proxy/tavily/search")
                && route.get("requestFormat").and_then(Value::as_str) == Some("tavily.search")
                && route.get("sampleModel").and_then(Value::as_str) == Some("tavily/search")
        }));
        assert!(manifest_routes.iter().any(|route| {
            route.get("provider").and_then(Value::as_str) == Some("anthropic")
                && route.get("endpoint").and_then(Value::as_str) == Some("messages")
                && route
                    .get("models")
                    .and_then(Value::as_array)
                    .is_some_and(|models| {
                        models.iter().any(|model| {
                            model.get("id").and_then(Value::as_str)
                                == Some("anthropic/claude-opus-4-8")
                        })
                    })
        }));
        assert!(manifest_routes.iter().any(|route| {
            route.get("provider").and_then(Value::as_str) == Some("firecrawl")
                && route.get("endpoint").and_then(Value::as_str) == Some("scrape")
                && route.get("route").and_then(Value::as_str) == Some("/v1/proxy/firecrawl/scrape")
        }));
        assert!(native_routes.iter().any(|route| {
            route.get("provider").and_then(Value::as_str) == Some("anthropic")
                && route.get("endpoint").and_then(Value::as_str) == Some("messages")
                && route.get("route").and_then(Value::as_str)
                    == Some("/v1/native/anthropic/v1/messages")
        }));
        assert!(manifest_routes.iter().any(|route| {
            route.get("provider").and_then(Value::as_str) == Some("replicate")
                && route.get("endpoint").and_then(Value::as_str) == Some("prediction")
                && route
                    .get("pathParams")
                    .and_then(Value::as_array)
                    .is_some_and(|params| {
                        params
                            .iter()
                            .any(|param| param.as_str() == Some("prediction_id"))
                    })
        }));

        for route in manifest_routes {
            assert!(route.get("requestFormat").is_some_and(Value::is_string));
            let provider_id = route.get("provider").and_then(Value::as_str).unwrap();
            let endpoint_id = route.get("endpoint").and_then(Value::as_str).unwrap();
            let provider = snapshot
                .providers
                .iter()
                .find(|provider| provider.id == provider_id)
                .unwrap();
            let endpoint_capabilities = provider
                .capabilities
                .iter()
                .filter(|capability| capability.endpoint == endpoint_id)
                .map(|capability| capability.id.as_str())
                .collect::<Vec<_>>();
            let expected_model = provider.models.iter().find(|model| {
                model
                    .capabilities
                    .iter()
                    .any(|capability| endpoint_capabilities.contains(&capability.as_str()))
            });
            assert_eq!(
                route.get("sampleModel").and_then(Value::as_str),
                expected_model.map(|model| model.id.as_str())
            );
        }

        for route in openai_routes {
            let provider_id = route.get("provider").and_then(Value::as_str).unwrap();
            let provider = snapshot
                .providers
                .iter()
                .find(|provider| provider.id == provider_id)
                .unwrap();
            let provider_capabilities = provider
                .capabilities
                .iter()
                .map(|capability| capability.id.clone())
                .collect::<Vec<_>>();
            for endpoint in route
                .get("endpoints")
                .and_then(Value::as_array)
                .unwrap()
                .iter()
                .map(Value::as_str)
            {
                assert!(
                    select_endpoint(provider, &provider_capabilities, endpoint.unwrap()).is_some()
                );
            }
            for model in route.get("models").and_then(Value::as_array).unwrap() {
                let capabilities = model
                    .get("capabilities")
                    .and_then(Value::as_array)
                    .unwrap()
                    .iter()
                    .map(|value| value.as_str().unwrap().to_string())
                    .collect::<Vec<_>>();
                for endpoint in model
                    .get("endpoints")
                    .and_then(Value::as_array)
                    .unwrap()
                    .iter()
                    .map(Value::as_str)
                {
                    assert!(select_endpoint(provider, &capabilities, endpoint.unwrap()).is_some());
                }
            }
        }
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
        let credential = ProxyCredential {
            enabled: true,
            secret_sha256: sha256_hex("secret"),
            policy_id: "svc_docs".to_string(),
            policy_generation: "gen_1".to_string(),
            principal_id: None,
        };
        let policy = AccessPolicy {
            enabled: true,
            generation: "gen_1".to_string(),
            providers: vec!["openai".to_string()],
            tenant_id: Some("team_docs".to_string()),
            token_role: Some("service".to_string()),
            monthly_budget_micros: Some(100),
            request_cost_micros: Some(10),
            retain_request_content: true,
        };

        assert_eq!(key_verification("secret", &credential), "verified");
        assert_eq!(key_verification("wrong", &credential), "invalid_secret");
        assert_eq!(
            key_inspection_verification("secret", &credential, &policy),
            "verified"
        );
        assert!(inspect_policy_for_response("verified", &policy).is_some());
        assert!(inspect_policy_for_response("invalid_secret", &policy).is_none());
        let revoked_policy = AccessPolicy {
            enabled: false,
            ..policy.clone()
        };
        assert_eq!(
            key_inspection_verification("secret", &credential, &revoked_policy),
            "policy_revoked"
        );
        assert_eq!(
            key_inspection_verification("wrong", &credential, &revoked_policy),
            "invalid_secret"
        );
        assert!(inspect_policy_for_response("policy_revoked", &revoked_policy).is_some());
        let stale_credential = ProxyCredential {
            policy_generation: "gen_0".to_string(),
            ..credential.clone()
        };
        assert!(!credential_policy_generation_matches(
            &stale_credential,
            &policy
        ));
        assert_eq!(
            key_inspection_verification("secret", &stale_credential, &policy),
            "policy_generation_mismatch"
        );
        assert_eq!(policy.request_cost_micros, Some(10));
    }

    #[test]
    fn gravatar_avatar_urls_hash_normalized_emails() {
        let url = gravatar_avatar_url("  Person@Example.COM ");
        assert_eq!(
            url,
            format!(
                "https://www.gravatar.com/avatar/{}?s=60&d=identicon&r=g",
                sha256_hex("person@example.com")
            )
        );
        assert!(!url.contains("Person"));
        assert!(!url.contains("example.com"));
    }

    #[test]
    fn legacy_key_records_split_policy_from_proxy_credential() {
        let legacy_policy =
            serde_json::from_str::<AccessPolicy>(r#"{"enabled":true,"providers":["openai"]}"#)
                .unwrap();
        let legacy_credential = serde_json::from_str::<ProxyCredential>(
            r#"{"enabled":true,"secretSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","policyId":"svc_docs"}"#,
        )
        .unwrap();
        assert_eq!(legacy_policy.generation, "legacy");
        assert!(credential_policy_generation_matches(
            &legacy_credential,
            &legacy_policy
        ));

        let legacy = LegacyKeyPolicy {
            enabled: true,
            secret_sha256: sha256_hex("secret"),
            generation: "gen_1".to_string(),
            providers: vec!["openai".to_string()],
            tenant_id: Some("team_docs".to_string()),
            token_role: Some("service".to_string()),
            monthly_budget_micros: Some(100),
            request_cost_micros: Some(10),
            retain_request_content: true,
        };
        let policy = legacy.access_policy();
        let credential = legacy.credential("svc_docs");
        let policy_json = serde_json::to_value(&policy).unwrap();
        let credential_json = serde_json::to_value(&credential).unwrap();

        assert!(policy_json.get("secretSha256").is_none());
        assert_eq!(policy_json["generation"], "gen_1");
        assert_eq!(credential_json["policyId"], "svc_docs");
        assert_eq!(credential_json["policyGeneration"], "gen_1");
        assert_eq!(credential_json["secretSha256"], sha256_hex("secret"));

        let rollback = legacy_compatibility_tombstone(&policy, &credential);
        assert!(!rollback.enabled);
        assert_eq!(rollback.generation, "gen_1");
        assert_eq!(rollback.providers, vec!["openai"]);
        let rollback = legacy_compatibility_tombstone(
            &policy,
            &ProxyCredential {
                enabled: false,
                ..credential
            },
        );
        assert!(!rollback.enabled);
        assert!(!is_pre_migration_legacy_key_policy(&legacy));
        let pre_migration = LegacyKeyPolicy {
            generation: legacy_policy_generation(),
            ..legacy
        };
        assert!(is_pre_migration_legacy_key_policy(&pre_migration));
    }

    #[test]
    fn canonical_policy_edits_preserve_generation_and_legacy_combined_updates_fail() {
        let existing_policy = AccessPolicy {
            enabled: true,
            generation: "gen_existing".to_string(),
            providers: vec!["openai".to_string()],
            tenant_id: Some("team_docs".to_string()),
            token_role: Some("service".to_string()),
            monthly_budget_micros: Some(100),
            request_cost_micros: Some(10),
            retain_request_content: true,
        };
        let existing_credential = ProxyCredential {
            enabled: true,
            secret_sha256: sha256_hex("old-secret"),
            policy_id: "svc_docs".to_string(),
            policy_generation: existing_policy.generation.clone(),
            principal_id: None,
        };
        let mut updated_policy = AccessPolicy {
            generation: new_policy_generation(),
            providers: vec!["openai".to_string(), "tavily".to_string()],
            ..existing_policy.clone()
        };
        preserve_existing_policy_generation(&mut updated_policy, Some(&existing_policy));
        assert_eq!(updated_policy.generation, "gen_existing");

        let changed_credential = ProxyCredential {
            secret_sha256: sha256_hex("new-secret"),
            ..existing_credential.clone()
        };
        assert!(legacy_key_update_changes_policy_and_secret(
            Some(&existing_policy),
            Some(&existing_credential),
            &updated_policy,
            &changed_credential,
        ));
        assert!(!legacy_key_update_changes_policy_and_secret(
            Some(&existing_policy),
            Some(&existing_credential),
            &updated_policy,
            &existing_credential,
        ));
    }

    #[test]
    fn admin_policy_validation_accepts_known_provider_hashes() {
        let request = AdminKeyPolicyRequest {
            enabled: true,
            secret_sha256: Some(sha256_hex("secret")),
            providers: Some(vec!["openai".to_string(), "tavily".to_string()]),
            all_providers: false,
            tenant_id: Some("team_docs".to_string()),
            token_role: Some("User".to_string()),
            monthly_budget_micros: Some(100),
            request_cost_micros: Some(10),
            retain_request_content: true,
        };
        let legacy = request.try_into_policy(None, false).unwrap();
        let policy = legacy.access_policy();
        assert!(legacy.generation.starts_with("policy_test_"));
        assert_eq!(policy.generation, legacy.generation);
        validate_policy_providers(&policy).unwrap();
        let response = admin_policy_response("svc_docs", "team_docs", &policy);
        assert_eq!(response.kid, "svc_docs");
        assert_eq!(response.policy_id, "team_docs");
        assert!(response.enabled);
        assert_eq!(response.providers, vec!["openai", "tavily"]);
        assert_eq!(response.token_role.as_deref(), Some("user"));
        assert_eq!(response.monthly_budget_micros, Some(100));
        assert_eq!(response.request_cost_micros, Some(10));
    }

    #[test]
    fn admin_policy_validation_rejects_invalid_token_role_metadata() {
        let request = AdminKeyPolicyRequest {
            enabled: true,
            secret_sha256: Some(sha256_hex("secret")),
            providers: Some(vec!["openai".to_string()]),
            all_providers: false,
            tenant_id: Some("team_docs".to_string()),
            token_role: Some("bad role!".to_string()),
            monthly_budget_micros: Some(100),
            request_cost_micros: Some(10),
            retain_request_content: true,
        };
        assert_eq!(
            request.try_into_policy(None, false).unwrap_err(),
            "tokenRole must be 32 or fewer ASCII letters, numbers, underscores, or hyphens"
        );
    }

    #[test]
    fn admin_policy_edits_can_preserve_existing_secret_hash() {
        let existing_hash = sha256_hex("existing");
        let request = AdminKeyPolicyRequest {
            enabled: true,
            secret_sha256: None,
            providers: Some(vec!["openai".to_string()]),
            all_providers: false,
            tenant_id: Some("team_docs".to_string()),
            token_role: Some("service".to_string()),
            monthly_budget_micros: Some(200),
            request_cost_micros: Some(20),
            retain_request_content: true,
        };
        let policy = request
            .try_into_policy(Some(existing_hash.clone()), false)
            .unwrap();
        assert_eq!(policy.secret_sha256, existing_hash);

        let new_key = AdminKeyPolicyRequest {
            enabled: true,
            secret_sha256: None,
            providers: Some(vec!["openai".to_string()]),
            all_providers: false,
            tenant_id: None,
            token_role: None,
            monthly_budget_micros: None,
            request_cost_micros: None,
            retain_request_content: true,
        };
        assert_eq!(
            new_key.try_into_policy(None, false).unwrap_err(),
            "secretSha256 is required for new proxy keys"
        );
    }

    #[test]
    fn access_playground_policy_scope_is_provider_only() {
        let policy = AccessPolicy {
            enabled: true,
            generation: "gen_1".to_string(),
            providers: vec!["openai".to_string()],
            tenant_id: Some("team_docs".to_string()),
            token_role: Some("user".to_string()),
            monthly_budget_micros: Some(100),
            request_cost_micros: Some(10),
            retain_request_content: true,
        };

        assert!(policy_allows_provider(&policy, "openai"));
        assert!(!policy_allows_provider(&policy, "anthropic"));

        let denied = denied_access_policy(Some("team_docs".to_string()));
        assert!(!denied.enabled);
        assert_eq!(denied.tenant_id.as_deref(), Some("team_docs"));
        assert!(!policy_allows_provider(&denied, "openai"));
    }

    #[test]
    fn policy_bindings_are_principal_indexed_and_normalized() {
        let binding = normalize_policy_binding(PolicyBindingRecord {
            policy_id: "svc_docs".to_string(),
            principal_type: PrincipalType::User,
            principal_id: " Writer@Example.com ".to_string(),
            enabled: true,
            priority: 10,
        })
        .unwrap();
        assert_eq!(binding.principal_id, "writer@example.com");
        assert_eq!(
            policy_binding_key(&binding),
            "access/bindings/user/writer%40example.com/svc_docs"
        );
        assert_eq!(
            policy_binding_principal_key(&PolicyBindingPrincipal {
                principal_type: binding.principal_type,
                principal_id: binding.principal_id.clone(),
            }),
            "user:writer%40example.com"
        );

        let groups = normalize_access_groups(vec![
            "Maintainers".to_string(),
            "docs".to_string(),
            "maintainers".to_string(),
        ])
        .unwrap();
        assert_eq!(groups, vec!["docs", "maintainers"]);
    }

    #[test]
    fn assignment_rules_match_verified_identity_evidence_only() {
        let email_rule = assignment_test_rule(AssignmentRuleKind::EmailDomain, "example.com", true);
        let github_rule =
            assignment_test_rule(AssignmentRuleKind::GithubTeam, "openclaw/maintainers", true);
        let evidence = AssignmentEvidence {
            source: "github".to_string(),
            verified: true,
            github_orgs: vec!["openclaw".to_string()],
            github_teams: vec!["openclaw/maintainers".to_string()],
        };

        assert_eq!(
            assignment_rule_match(&email_rule, "user@example.com", None),
            AssignmentMatch::Match
        );
        assert_eq!(
            assignment_rule_match(&github_rule, "user@example.com", None),
            AssignmentMatch::Unknown
        );
        assert_eq!(
            assignment_rule_match(&github_rule, "user@example.com", Some(&evidence)),
            AssignmentMatch::Match
        );
    }

    #[test]
    fn assignment_reconciliation_retains_unknown_and_revokes_verified_loss() {
        let rule =
            assignment_test_rule(AssignmentRuleKind::GithubTeam, "openclaw/maintainers", true);
        let rules = BTreeMap::from([("maintainers".to_string(), rule)]);
        let previous = AssignmentStateRecord {
            version: 1,
            assignments: BTreeMap::from([(
                "maintainers".to_string(),
                AssignmentStateEntry {
                    groups: vec![
                        "assignment.maintainers".to_string(),
                        "maintainers".to_string(),
                    ],
                    revoke_on_loss: true,
                },
            )]),
            updated_at: None,
        };
        let (unknown, matched, retained) = reconcile_assignment_state_at(
            "user@example.com",
            &rules,
            None,
            previous.clone(),
            "2026-06-16T00:00:00.000Z".to_string(),
        );
        assert!(matched.is_empty());
        assert_eq!(retained, vec!["maintainers"]);
        assert!(unknown.assignments.contains_key("maintainers"));

        let evidence = AssignmentEvidence {
            source: "github".to_string(),
            verified: true,
            github_orgs: Vec::new(),
            github_teams: Vec::new(),
        };
        let (lost, matched, retained) = reconcile_assignment_state_at(
            "user@example.com",
            &rules,
            Some(&evidence),
            previous,
            "2026-06-16T00:00:00.000Z".to_string(),
        );
        assert!(matched.is_empty());
        assert!(retained.is_empty());
        assert!(lost.assignments.is_empty());
    }

    #[test]
    fn assignment_reconciliation_runs_once_per_access_session() {
        let issued_at = "2026-06-16T00:00:00.000Z";
        assert!(assignment_state_predates_issued_at(
            &AssignmentStateRecord::default(),
            issued_at
        ));
        assert!(assignment_state_predates_issued_at(
            &AssignmentStateRecord {
                updated_at: Some("2026-06-15T23:59:59.999Z".to_string()),
                ..AssignmentStateRecord::default()
            },
            issued_at
        ));
        assert!(!assignment_state_predates_issued_at(
            &AssignmentStateRecord {
                updated_at: Some(issued_at.to_string()),
                ..AssignmentStateRecord::default()
            },
            issued_at
        ));
        assert!(!assignment_state_predates_issued_at(
            &AssignmentStateRecord {
                updated_at: Some("2026-06-16T00:00:00.001Z".to_string()),
                ..AssignmentStateRecord::default()
            },
            issued_at
        ));
    }

    #[test]
    fn user_grant_mutations_reconcile_direct_bindings_as_one_authority_request() {
        let request = serde_json::from_str::<AdminAccessUserGrantsRequest>(
            r#"{"tenantId":"openclaw","enabled":true,"groups":["maintainers"],"policyIds":["svc_tools","svc_tools"]}"#,
        )
        .unwrap();
        assert_eq!(request.record.tenant_id.as_deref(), Some("openclaw"));
        assert_eq!(request.policy_ids, vec!["svc_tools", "svc_tools"]);

        let bindings = reconcile_user_policy_bindings(
            "user@example.com",
            vec![
                PolicyBindingRecord {
                    policy_id: "svc_models".to_string(),
                    principal_type: PrincipalType::User,
                    principal_id: "user@example.com".to_string(),
                    enabled: true,
                    priority: 8,
                },
                PolicyBindingRecord {
                    policy_id: "svc_other".to_string(),
                    principal_type: PrincipalType::User,
                    principal_id: "other@example.com".to_string(),
                    enabled: true,
                    priority: 10,
                },
            ],
            &BTreeSet::from(["svc_tools".to_string()]),
        );
        assert_eq!(bindings.len(), 2);
        assert_eq!(bindings[0].policy_id, "svc_models");
        assert!(!bindings[0].enabled);
        assert_eq!(bindings[0].priority, 8);
        assert_eq!(bindings[1].policy_id, "svc_tools");
        assert!(bindings[1].enabled);
        assert_eq!(bindings[1].priority, default_binding_priority());
    }

    #[test]
    fn policy_binding_indexes_only_keep_their_principal_keys() {
        let principal = PolicyBindingPrincipal {
            principal_type: PrincipalType::Group,
            principal_id: "docs".to_string(),
        };
        let binding = |policy_id: &str, principal_id: &str| PolicyBindingRecord {
            policy_id: policy_id.to_string(),
            principal_type: PrincipalType::Group,
            principal_id: principal_id.to_string(),
            enabled: true,
            priority: 100,
        };
        let mut bindings = vec![
            binding("read", "docs"),
            binding("admin", "ops"),
            binding("read", "docs"),
            binding("write", "docs"),
        ];

        normalize_policy_binding_records(&mut bindings, &principal);

        assert_eq!(
            bindings
                .into_iter()
                .map(|binding| binding.policy_id)
                .collect::<Vec<_>>(),
            vec!["read", "write"]
        );
    }

    #[test]
    fn admin_sessions_have_no_implicit_policy_binding_index() {
        let session = AccessSession {
            authenticated: true,
            auth: "cloudflare_access",
            role: AccessRole::Admin,
            email: "admin@example.com".to_string(),
            subject: None,
            tenant_id: "ops".to_string(),
            groups: Vec::new(),
            content_retention_disabled: false,
        };

        assert_eq!(
            session_binding_principals(&session)
                .into_iter()
                .map(|principal| policy_binding_principal_key(&principal))
                .collect::<Vec<_>>(),
            vec!["user:admin%40example.com"]
        );
    }

    #[test]
    fn session_bindings_collapse_large_group_sets_without_implicit_access() {
        let session = AccessSession {
            authenticated: true,
            auth: "cloudflare_access",
            role: AccessRole::User,
            email: "writer@example.com".to_string(),
            subject: None,
            tenant_id: "docs".to_string(),
            groups: (0..64).map(|index| format!("group-{index}")).collect(),
            content_retention_disabled: false,
        };
        let bindings = vec![
            PolicyBindingRecord {
                policy_id: "direct".to_string(),
                principal_type: PrincipalType::User,
                principal_id: session.email.clone(),
                enabled: true,
                priority: 20,
            },
            PolicyBindingRecord {
                policy_id: "shared".to_string(),
                principal_type: PrincipalType::Group,
                principal_id: "group-63".to_string(),
                enabled: true,
                priority: 50,
            },
            PolicyBindingRecord {
                policy_id: "shared".to_string(),
                principal_type: PrincipalType::Group,
                principal_id: "group-0".to_string(),
                enabled: true,
                priority: 10,
            },
            PolicyBindingRecord {
                policy_id: "disabled".to_string(),
                principal_type: PrincipalType::User,
                principal_id: session.email.clone(),
                enabled: false,
                priority: 1,
            },
            PolicyBindingRecord {
                policy_id: "unrelated".to_string(),
                principal_type: PrincipalType::Group,
                principal_id: "other".to_string(),
                enabled: true,
                priority: 1,
            },
        ];

        assert_eq!(
            session_binding_priorities(&session, &bindings),
            BTreeMap::from([("direct".to_string(), 20), ("shared".to_string(), 10)])
        );
    }

    #[test]
    fn admin_key_listing_joins_each_credential_to_its_authoritative_policy() {
        let active_policy = AccessPolicy {
            enabled: true,
            generation: "gen_active".to_string(),
            providers: vec!["openai".to_string()],
            tenant_id: Some("team_docs".to_string()),
            token_role: Some("service".to_string()),
            monthly_budget_micros: Some(100),
            request_cost_micros: Some(10),
            retain_request_content: true,
        };
        let revoked_policy = AccessPolicy {
            enabled: false,
            generation: "gen_revoked".to_string(),
            ..active_policy.clone()
        };
        let credentials = vec![
            (
                "key_a".to_string(),
                ProxyCredential {
                    enabled: true,
                    secret_sha256: sha256_hex("a"),
                    policy_id: "shared".to_string(),
                    policy_generation: active_policy.generation.clone(),
                    principal_id: None,
                },
            ),
            (
                "key_b".to_string(),
                ProxyCredential {
                    enabled: false,
                    secret_sha256: sha256_hex("b"),
                    policy_id: "shared".to_string(),
                    policy_generation: active_policy.generation.clone(),
                    principal_id: None,
                },
            ),
            (
                "key_c".to_string(),
                ProxyCredential {
                    enabled: true,
                    secret_sha256: sha256_hex("c"),
                    policy_id: "revoked".to_string(),
                    policy_generation: revoked_policy.generation.clone(),
                    principal_id: None,
                },
            ),
            (
                "key_d".to_string(),
                ProxyCredential {
                    enabled: true,
                    secret_sha256: sha256_hex("d"),
                    policy_id: "shared".to_string(),
                    policy_generation: "stale_generation".to_string(),
                    principal_id: None,
                },
            ),
        ];
        let policies = BTreeMap::from([
            ("revoked".to_string(), revoked_policy),
            ("shared".to_string(), active_policy),
        ]);

        let entries = admin_key_policy_responses(credentials.clone(), &policies);

        assert_eq!(
            entries
                .iter()
                .map(|entry| entry.kid.as_str())
                .collect::<Vec<_>>(),
            vec!["key_a", "key_b", "key_c", "key_d"]
        );
        assert!(entries[0].enabled);
        assert!(!entries[1].enabled);
        assert!(!entries[2].enabled);
        assert!(!entries[3].enabled);
        assert_eq!(entries[0].policy_id, "shared");
        assert_eq!(entries[1].policy_id, "shared");

        let credentials = admin_credential_responses(
            [
                credentials,
                vec![(
                    "key_missing".to_string(),
                    ProxyCredential {
                        enabled: true,
                        secret_sha256: sha256_hex("missing"),
                        policy_id: "missing".to_string(),
                        policy_generation: "gen_missing".to_string(),
                        principal_id: None,
                    },
                )],
            ]
            .concat(),
            &policies,
        );
        assert!(credentials[0].active);
        assert!(credentials[0].policy_enabled);
        assert!(credentials[0].generation_matches);
        assert!(!credentials[1].active);
        assert!(!credentials[2].active);
        assert!(!credentials[3].active);
        assert!(!credentials[3].generation_matches);
        assert!(!credentials[4].active);
        assert!(!credentials[4].policy_enabled);
    }

    #[test]
    fn admin_overview_and_tenants_keep_policy_and_credential_counts_separate() {
        let policies = vec![
            AdminKeyPolicyResponse {
                kid: "svc_docs".to_string(),
                policy_id: "svc_docs".to_string(),
                enabled: true,
                providers: vec!["openai".to_string(), "tavily".to_string()],
                tenant_id: Some("team_docs".to_string()),
                token_role: Some("user".to_string()),
                monthly_budget_micros: Some(100),
                request_cost_micros: Some(10),
                retain_request_content: true,
            },
            AdminKeyPolicyResponse {
                kid: "svc_ops".to_string(),
                policy_id: "svc_ops".to_string(),
                enabled: true,
                providers: vec![],
                tenant_id: Some("team_docs".to_string()),
                token_role: Some("ops".to_string()),
                monthly_budget_micros: Some(200),
                request_cost_micros: None,
                retain_request_content: true,
            },
            AdminKeyPolicyResponse {
                kid: "svc_default".to_string(),
                policy_id: "svc_default".to_string(),
                enabled: true,
                providers: vec!["replicate".to_string()],
                tenant_id: None,
                token_role: Some("service".to_string()),
                monthly_budget_micros: None,
                request_cost_micros: Some(5),
                retain_request_content: true,
            },
            AdminKeyPolicyResponse {
                kid: "svc_retired".to_string(),
                policy_id: "svc_retired".to_string(),
                enabled: false,
                providers: vec![],
                tenant_id: Some("retired".to_string()),
                token_role: Some("sandbox".to_string()),
                monthly_budget_micros: Some(50),
                request_cost_micros: None,
                retain_request_content: true,
            },
        ];
        let keys = vec![
            AdminKeyPolicyResponse {
                kid: "key_docs_a".to_string(),
                policy_id: "svc_docs".to_string(),
                enabled: true,
                ..policies[0].clone()
            },
            AdminKeyPolicyResponse {
                kid: "key_docs_b".to_string(),
                policy_id: "svc_docs".to_string(),
                enabled: false,
                ..policies[0].clone()
            },
            AdminKeyPolicyResponse {
                kid: "key_ops".to_string(),
                policy_id: "svc_ops".to_string(),
                ..policies[1].clone()
            },
            AdminKeyPolicyResponse {
                kid: "key_default".to_string(),
                policy_id: "svc_default".to_string(),
                ..policies[2].clone()
            },
        ];
        let tenants = admin_tenant_summaries(&policies, &keys);
        let docs = tenants
            .iter()
            .find(|tenant| tenant.tenant_id == "team_docs")
            .unwrap();
        assert_eq!(docs.policies, 2);
        assert_eq!(docs.active_policies, 2);
        assert_eq!(docs.keys, 3);
        assert_eq!(docs.active_keys, 2);
        assert_eq!(docs.providers, vec!["openai", "tavily"]);
        assert!(docs.all_providers);
        assert_eq!(docs.monthly_budget_micros, 300);
        let retired = tenants
            .iter()
            .find(|tenant| tenant.tenant_id == "retired")
            .unwrap();
        assert_eq!(retired.policies, 1);
        assert_eq!(retired.keys, 0);
        assert_eq!(retired.active_keys, 0);
        assert!(!retired.all_providers);
        let overview = admin_overview(&policies, &keys, &provider_snapshot().unwrap());
        assert_eq!(overview.policies_total, 4);
        assert_eq!(overview.policies_active, 3);
        assert_eq!(overview.keys_total, 4);
        assert_eq!(overview.keys_active, 3);
        assert!(retired.providers.is_empty());

        let overview = admin_overview(&policies, &keys, &provider_snapshot().unwrap());
        assert_eq!(overview.keys_total, 4);
        assert_eq!(overview.keys_active, 3);
        assert_eq!(overview.tenants_total, 3);
        assert_eq!(overview.monthly_budget_micros, 350);
        assert_eq!(overview.request_cost_micros, 15);
    }

    #[test]
    fn admin_policy_validation_rejects_bad_hashes_and_unknown_providers() {
        let bad_hash = AdminKeyPolicyRequest {
            enabled: true,
            secret_sha256: Some("not-a-hash".to_string()),
            providers: Some(vec!["openai".to_string()]),
            all_providers: false,
            tenant_id: None,
            token_role: None,
            monthly_budget_micros: None,
            request_cost_micros: None,
            retain_request_content: true,
        };
        assert_eq!(
            bad_hash.try_into_policy(None, false).unwrap_err(),
            "secretSha256 must be a 64-character hex string"
        );

        let wildcard_providers = AdminKeyPolicyRequest {
            enabled: true,
            secret_sha256: Some(sha256_hex("secret")),
            providers: Some(Vec::new()),
            all_providers: false,
            tenant_id: None,
            token_role: None,
            monthly_budget_micros: None,
            request_cost_micros: None,
            retain_request_content: true,
        };
        assert_eq!(
            wildcard_providers.try_into_policy(None, false).unwrap_err(),
            "providers must contain at least one provider id"
        );
        let wildcard_providers = AdminKeyPolicyRequest {
            enabled: true,
            secret_sha256: Some(sha256_hex("secret")),
            providers: Some(Vec::new()),
            all_providers: false,
            tenant_id: None,
            token_role: None,
            monthly_budget_micros: None,
            request_cost_micros: None,
            retain_request_content: true,
        };
        let wildcard_policy = wildcard_providers.try_into_policy(None, true).unwrap();
        assert!(wildcard_policy.providers.is_empty());
        validate_policy_providers(&wildcard_policy.access_policy()).unwrap();

        let explicit_wildcard = AdminKeyPolicyRequest {
            enabled: true,
            secret_sha256: Some(sha256_hex("secret")),
            providers: Some(Vec::new()),
            all_providers: true,
            tenant_id: None,
            token_role: None,
            monthly_budget_micros: None,
            request_cost_micros: None,
            retain_request_content: true,
        };
        assert!(explicit_wildcard
            .try_into_policy(None, false)
            .unwrap()
            .providers
            .is_empty());

        let omitted_providers = AdminKeyPolicyRequest {
            enabled: true,
            secret_sha256: Some(sha256_hex("secret")),
            providers: None,
            all_providers: false,
            tenant_id: None,
            token_role: None,
            monthly_budget_micros: None,
            request_cost_micros: None,
            retain_request_content: true,
        };
        assert_eq!(
            omitted_providers.try_into_policy(None, false).unwrap_err(),
            "providers is required"
        );

        let unknown_provider = AccessPolicy {
            enabled: true,
            generation: "gen_1".to_string(),
            providers: vec!["not-real".to_string()],
            tenant_id: None,
            token_role: None,
            monthly_budget_micros: None,
            request_cost_micros: None,
            retain_request_content: true,
        };
        assert_eq!(
            validate_policy_providers(&unknown_provider).unwrap_err(),
            "unknown provider `not-real`"
        );

        let invalid_budget = AccessPolicy {
            enabled: true,
            generation: "gen_1".to_string(),
            providers: vec!["openai".to_string()],
            tenant_id: None,
            token_role: None,
            monthly_budget_micros: Some(MAX_SQL_BUDGET_MICROS + 1),
            request_cost_micros: None,
            retain_request_content: true,
        };
        assert_eq!(
            validate_policy_budget(&invalid_budget).unwrap_err(),
            "monthlyBudgetMicros exceeds the durable ledger limit"
        );

        let omitted_providers =
            serde_json::from_str::<AdminAccessPolicyRequest>(r#"{"enabled":true}"#)
                .unwrap()
                .try_into_policy()
                .unwrap_err();
        assert_eq!(omitted_providers, "providers is required");

        let implicit_wildcard =
            serde_json::from_str::<AdminAccessPolicyRequest>(r#"{"enabled":true,"providers":[]}"#)
                .unwrap()
                .try_into_policy()
                .unwrap_err();
        assert_eq!(
            implicit_wildcard,
            "allProviders must be true for wildcard provider access"
        );

        let explicit_wildcard = serde_json::from_str::<AdminAccessPolicyRequest>(
            r#"{"enabled":true,"providers":[],"allProviders":true}"#,
        )
        .unwrap()
        .try_into_policy()
        .unwrap();
        assert!(explicit_wildcard.providers.is_empty());
        assert!(explicit_wildcard.generation.starts_with("policy_test_"));

        let ambiguous_scope = serde_json::from_str::<AdminAccessPolicyRequest>(
            r#"{"enabled":true,"providers":["openai"],"allProviders":true}"#,
        )
        .unwrap()
        .try_into_policy()
        .unwrap_err();
        assert_eq!(
            ambiguous_scope,
            "allProviders cannot be combined with provider ids"
        );
    }

    #[test]
    fn admin_key_ids_and_token_hashes_are_strict() {
        assert_eq!(validate_admin_kid("svc_docs").unwrap(), "svc_docs");
        assert!(validate_admin_kid("bad/key").is_err());
        assert!(validate_admin_kid("svc-docs").is_err());
        assert!(is_sha256_hex(&sha256_hex("admin")));
        assert!(constant_time_eq(&sha256_hex("admin"), &sha256_hex("admin")));
        assert!(!constant_time_eq(
            &sha256_hex("admin"),
            &sha256_hex("other")
        ));
    }

    #[test]
    fn session_usage_merges_effective_policy_totals_without_events() {
        let mut target = UsageSnapshot {
            ledger: "durable_object".to_string(),
            summary: UsageSummary {
                request_count: 2,
                success_count: 2,
                total_tokens: 30,
                actual_cost_micros: 120,
                ..UsageSummary::default()
            },
            providers: vec![ProviderUsageSummary {
                provider: "openai".to_string(),
                request_count: 2,
                success_count: 2,
                error_count: 0,
                total_tokens: 30,
                actual_cost_micros: 120,
            }],
            events: Vec::new(),
        };
        let source = UsageSnapshot {
            ledger: "durable_object".to_string(),
            summary: UsageSummary {
                request_count: 4,
                success_count: 3,
                error_count: 1,
                total_tokens: 90,
                actual_cost_micros: 380,
                ..UsageSummary::default()
            },
            providers: vec![
                ProviderUsageSummary {
                    provider: "anthropic".to_string(),
                    request_count: 3,
                    success_count: 2,
                    error_count: 1,
                    total_tokens: 70,
                    actual_cost_micros: 300,
                },
                ProviderUsageSummary {
                    provider: "openai".to_string(),
                    request_count: 1,
                    success_count: 1,
                    error_count: 0,
                    total_tokens: 20,
                    actual_cost_micros: 80,
                },
            ],
            events: Vec::new(),
        };

        merge_usage_snapshot(&mut target, source);

        assert_eq!(target.summary.request_count, 6);
        assert_eq!(target.summary.success_count, 5);
        assert_eq!(target.summary.error_count, 1);
        assert_eq!(target.summary.total_tokens, 120);
        assert_eq!(target.summary.actual_cost_micros, 500);
        assert_eq!(target.providers[0].provider, "anthropic");
        assert_eq!(target.providers[1].provider, "openai");
        assert_eq!(target.providers[1].request_count, 3);
        assert!(target.events.is_empty());
    }

    #[test]
    fn cors_policy_allows_admin_and_anthropic_browser_clients() {
        assert_eq!(CORS_ALLOW_ORIGIN, "*");
        assert_eq!(CORS_ALLOW_METHODS, "GET,POST,PUT,OPTIONS");
        assert!(CORS_ALLOW_HEADERS.contains("authorization"));
        assert!(CORS_ALLOW_HEADERS.contains("content-type"));
        assert!(CORS_ALLOW_HEADERS.contains("x-clawrouter-client"));
        for header in [
            "anthropic-dangerous-direct-browser-access",
            "x-stainless-retry-count",
            "x-stainless-timeout",
            "x-stainless-lang",
            "x-stainless-package-version",
            "x-stainless-os",
            "x-stainless-arch",
            "x-stainless-runtime",
            "x-stainless-runtime-version",
            "x-stainless-helper-method",
            "x-stainless-helper",
        ] {
            assert!(CORS_ALLOW_HEADERS.split(',').any(|value| value == header));
        }
        assert!(cors_enabled_path("/v1/admin/keys"));
        assert!(cors_enabled_path("/v1/providers"));
        assert!(cors_enabled_path("/v1/routes"));
        assert!(cors_enabled_path("/v1/session"));
        assert!(cors_enabled_path("/v1/entitlements"));
        assert!(cors_enabled_path("/v1/session/usage"));
        assert!(cors_enabled_path("/v1/me"));
        assert!(cors_enabled_path("/v1/usage"));
        assert!(cors_enabled_path("/v1/messages"));
        assert!(cors_enabled_path("/v1/messages/count_tokens"));
        assert!(cors_enabled_path("/v1/chat/completions"));
        assert!(cors_enabled_path("/v1/proxy/tavily/search"));
        assert!(cors_enabled_path("/v1/native/openai/v1/responses"));
        assert_eq!(CONTENT_RETENTION_HEADER, "x-clawrouter-content-retention");
    }

    #[test]
    fn interface_routes_require_the_admin_shell() {
        assert!(!interface_path("/dashboard"));
        assert!(interface_path("/dashboard/home"));
        assert!(interface_path("/dashboard/access"));
        assert!(interface_path("/dashboard/catalog"));
        assert!(interface_path("/dashboard/playground"));
        assert!(interface_path("/dashboard/usage"));
        assert!(interface_path("/dashboard/users"));
        assert!(!interface_path("/access"));
        assert!(!interface_path("/v1/admin/keys"));
    }

    #[test]
    fn legacy_interface_routes_redirect_under_dashboard() {
        assert_eq!(
            legacy_interface_redirect("/access"),
            Some("/dashboard/access")
        );
        assert_eq!(
            legacy_interface_redirect("/catalog"),
            Some("/dashboard/catalog")
        );
        assert_eq!(
            legacy_interface_redirect("/playground"),
            Some("/dashboard/playground")
        );
        assert_eq!(
            legacy_interface_redirect("/usage"),
            Some("/dashboard/usage")
        );
        assert_eq!(legacy_interface_redirect("/v1/routes"), None);
    }

    #[test]
    fn provider_icon_manifest_covers_all_bundled_providers() {
        let icons = serde_json::from_str::<Value>(PROVIDER_ICONS).unwrap();
        let icons = icons.get("icons").and_then(Value::as_object).unwrap();
        let snapshot = provider_snapshot().unwrap();

        for provider in snapshot.providers {
            let icon = icons
                .get(&provider.id)
                .unwrap_or_else(|| panic!("missing provider icon for {}", provider.id));
            assert!(
                icon.get("viewBox").and_then(Value::as_str).is_some(),
                "provider icon {} is missing a viewBox",
                provider.id
            );
            assert!(
                icon.get("body")
                    .and_then(Value::as_str)
                    .is_some_and(|body| body.contains("<path")),
                "provider icon {} is missing SVG path data",
                provider.id
            );
        }
    }

    #[test]
    fn root_redirect_points_to_dashboard() {
        assert_eq!(ROOT_REDIRECT_PATH, "/dashboard");
        assert_eq!(
            redirect_location(ROOT_REDIRECT_PATH, Some("demo")),
            "/dashboard?demo"
        );
        assert_eq!(
            redirect_location("/dashboard/home", Some("demo")),
            "/dashboard/home?demo"
        );
    }

    #[test]
    fn api_aliases_map_to_canonical_v1_routes() {
        assert_eq!(canonical_api_path("/api/route"), "/v1/routes");
        assert_eq!(canonical_api_path("/api/routes"), "/v1/routes");
        assert_eq!(canonical_api_path("/api/session"), "/v1/session");
        assert_eq!(canonical_api_path("/api/entitlements"), "/v1/entitlements");
        assert_eq!(canonical_api_path("/api/me"), "/v1/me");
        assert_eq!(canonical_api_path("/api/usage"), "/v1/usage");
        assert_eq!(
            canonical_api_path("/api/admin/overview"),
            "/v1/admin/overview"
        );
        assert_eq!(canonical_api_path("/v1/providers"), "/v1/providers");
    }

    #[test]
    fn access_helpers_normalize_and_decode_cloudflare_jwts() {
        assert_eq!(
            normalized_access_team_domain("https://Team.Example.cloudflareaccess.com/path"),
            "team.example.cloudflareaccess.com"
        );
        assert_eq!(split_jwt("a.b.c"), Some(("a", "b", "c")));
        assert_eq!(split_jwt("a.b.c.d"), None);
        assert_eq!(
            String::from_utf8(base64_url_decode("eyJyb2xlIjoiYWRtaW4ifQ").unwrap()).unwrap(),
            r#"{"role":"admin"}"#
        );
        assert!(access_jwt_part("*").is_none());

        let payload = AccessJwtPayload {
            aud: Some(AccessAud::Many(vec![
                "first".to_string(),
                "second".to_string(),
            ])),
            email: None,
            exp: None,
            iat: None,
            iss: None,
            nbf: None,
            sub: None,
        };
        assert_eq!(access_audiences(&payload), vec!["first", "second"]);
    }

    #[test]
    fn access_user_email_segments_are_strictly_decoded() {
        assert_eq!(
            decode_access_user_email("Ops%2Bdocs%40Example.com").unwrap(),
            "ops+docs@example.com"
        );
        assert!(decode_access_user_email("ops%ZZexample.com").is_err());
        assert!(decode_access_user_email("ops/example.com").is_err());
        assert!(decode_access_user_email("ops@example").is_err());
        assert_eq!(percent_decode_path_segment("a%2Fb").unwrap(), "a/b");
    }

    #[test]
    fn access_user_records_default_to_enabled_user() {
        let record: AccessUserRecord = serde_json::from_str(r#"{"tenantId":"default"}"#).unwrap();
        assert_eq!(record.role, AccessRole::User);
        assert_eq!(record.tenant_id.as_deref(), Some("default"));
        assert_eq!(record.enabled, None);
        assert!(record.groups.is_empty());
    }

    #[test]
    fn access_control_users_are_normalized_without_role_grants() {
        let mut user = AccessControlUser {
            email: " Ops@Example.COM ".to_string(),
            record: AccessUserRecord {
                role: AccessRole::Admin,
                tenant_id: Some("default".to_string()),
                enabled: Some(false),
                groups: vec![" Docs ".to_string(), "docs".to_string()],
                content_retention_disabled: false,
            },
        };

        normalize_access_control_user(&mut user).unwrap();

        assert_eq!(user.email, "ops@example.com");
        assert_eq!(user.record.role, AccessRole::User);
        assert_eq!(user.record.enabled, Some(false));
        assert_eq!(user.record.groups, vec!["docs"]);
    }

    #[test]
    fn legacy_access_user_patches_preserve_omitted_groups() {
        let existing = AccessUserRecord {
            role: AccessRole::User,
            tenant_id: Some("old".to_string()),
            enabled: Some(false),
            groups: vec!["maintainers".to_string()],
            content_retention_disabled: true,
        };
        let patch = serde_json::from_str::<AdminAccessUserPatchRequest>(
            r#"{"tenantId":"new","enabled":true}"#,
        )
        .unwrap();
        let updated = apply_access_user_patch(existing.clone(), patch).unwrap();
        assert_eq!(updated.tenant_id.as_deref(), Some("new"));
        assert_eq!(updated.enabled, Some(true));
        assert_eq!(updated.groups, vec!["maintainers"]);
        assert!(updated.content_retention_disabled);

        let clear =
            serde_json::from_str::<AdminAccessUserPatchRequest>(r#"{"groups":[]}"#).unwrap();
        assert!(apply_access_user_patch(existing, clear)
            .unwrap()
            .groups
            .is_empty());

        let clear_exemption = serde_json::from_str::<AdminAccessUserPatchRequest>(
            r#"{"contentRetentionDisabled":false}"#,
        )
        .unwrap();
        assert!(
            !apply_access_user_patch(updated, clear_exemption)
                .unwrap()
                .content_retention_disabled
        );
    }

    #[test]
    fn provider_connection_ids_are_normalized_for_authority_writes() {
        let mut connection = ProviderConnectionRecord {
            provider_id: " openai ".to_string(),
            enabled: false,
            label: Some("Primary".to_string()),
        };

        normalize_access_control_connection(&mut connection).unwrap();

        assert_eq!(connection.provider_id, "openai");
        assert!(!connection.enabled);
        assert!(
            normalize_access_control_connection(&mut ProviderConnectionRecord {
                provider_id: " ".to_string(),
                enabled: true,
                label: None,
            })
            .is_err()
        );
    }

    #[test]
    fn provider_connection_authority_is_sharded_by_provider() {
        assert_eq!(access_control_object_name(), "policy-bindings");
        assert_eq!(
            provider_connection_object_name("openai"),
            "provider-connection:openai"
        );
        assert_eq!(
            provider_connection_object_name("provider/path"),
            "provider-connection:provider%2Fpath"
        );
        assert_ne!(
            provider_connection_object_name("openai"),
            provider_connection_object_name("anthropic")
        );
    }

    #[test]
    fn provider_config_errors_are_client_visible() {
        let missing_secret =
            Error::RustError("missing Cloudflare secret for provider `openai`".to_string());
        assert_eq!(
            provider_runtime_config_error_message(&missing_secret).as_deref(),
            Some("missing Cloudflare secret for provider `openai`")
        );

        let unrelated = Error::RustError("upstream response was malformed".to_string());
        assert!(provider_runtime_config_error_message(&unrelated).is_none());
        assert_eq!(
            provider_transport_error_message("openai"),
            "upstream request to provider `openai` failed"
        );
    }

    #[test]
    fn budget_names_are_stable_per_tenant_key() {
        assert_eq!(
            budget_policy_id("team_docs", "svc_docs"),
            "team_docs/svc_docs"
        );
        assert_eq!(
            budget_object_name("team_docs", "svc_docs"),
            "team_docs:svc_docs"
        );
    }

    #[test]
    fn budget_spend_rows_accept_sql_column_names() {
        let row = serde_json::from_value::<BudgetSpendRow>(serde_json::json!({
            "spent_micros": 42
        }))
        .unwrap();
        assert_eq!(row.spent_micros, 42);
    }

    #[test]
    fn budget_sql_integer_conversion_is_checked() {
        assert_eq!(validate_budget_number(42, "spent_micros").unwrap(), 42.0);
        assert!(validate_budget_number(MAX_SQL_BUDGET_MICROS + 1, "spent_micros").is_err());
    }

    #[test]
    fn budget_settlement_only_charges_successful_upstream_requests() {
        let request_cost = RequestCost {
            reserve_micros: 42,
            basis: RequestCostBasis::FixedPolicy,
            ..RequestCost::default()
        };
        assert_eq!(
            request_cost.actual_micros(200, UsageTokens::default(), true),
            42
        );
        assert_eq!(
            request_cost.actual_micros(299, UsageTokens::default(), true),
            42
        );
        assert_eq!(
            request_cost.actual_micros(400, UsageTokens::default(), true),
            0
        );
        assert_eq!(
            request_cost.actual_micros(502, UsageTokens::default(), true),
            0
        );
    }

    #[test]
    fn missing_output_usage_keeps_long_context_reservation() {
        let pricing = ModelPricing {
            effective_at: "2026-06-19".to_string(),
            source: "https://example.com/pricing".to_string(),
            input_micros_per_million: 1,
            output_micros_per_million: 0,
            cached_input_micros_per_million: None,
            cache_write_5m_input_micros_per_million: None,
            cache_write_1h_input_micros_per_million: None,
            max_input_tokens: 1_000,
            max_request_input_tokens: None,
            default_max_output_tokens: 100,
            input_token_overhead: 0,
            long_context: Some(clawrouter_core::pricing::LongContextPricing {
                threshold_input_tokens: 500,
                input_micros_per_million: 2,
                output_micros_per_million: 3,
                cached_input_micros_per_million: None,
                cache_write_5m_input_micros_per_million: None,
                cache_write_1h_input_micros_per_million: None,
            }),
        };
        let request_cost = RequestCost {
            reserve_micros: 42,
            pricing: Some(pricing),
            basis: RequestCostBasis::ListedPrice,
            ..RequestCost::default()
        };
        assert_eq!(
            request_cost.actual_micros(
                200,
                UsageTokens {
                    input: Some(600),
                    ..UsageTokens::default()
                },
                true,
            ),
            42
        );
    }

    #[test]
    fn authenticated_proxy_failures_keep_client_and_provider_outcomes_distinct() {
        assert_eq!(usage_status(400), UsageStatus::ClientError);
        assert_eq!(usage_status(405), UsageStatus::ClientError);
        assert_eq!(usage_status(500), UsageStatus::ProviderError);
        assert_eq!(usage_status(503), UsageStatus::ProviderError);
    }

    #[test]
    fn queue_messages_accept_legacy_usage_and_tagged_settlement_jobs() {
        let usage = UsageEvent::new_success(
            "usage_1",
            "default",
            "credential_1",
            "request_1",
            "openai",
            "llm.chat",
        );
        let legacy = serde_json::to_value(&usage).unwrap();
        assert!(matches!(
            serde_json::from_value::<QueueMessage>(legacy).unwrap(),
            QueueMessage::Usage(event) if event.id == "usage_1"
        ));

        let job = QueueJob::BudgetSettlement {
            tenant_id: "default".to_string(),
            policy_id: "policy_1".to_string(),
            request: BudgetSettleRequest {
                reservation_id: "budget_1".to_string(),
                actual_cost_micros: 0,
            },
        };
        let encoded = serde_json::to_value(&job).unwrap();
        assert_eq!(encoded["kind"], "budget_settlement");
        assert!(matches!(
            serde_json::from_value::<QueueMessage>(encoded).unwrap(),
            QueueMessage::Job(QueueJob::BudgetSettlement { request, .. })
                if request.reservation_id == "budget_1"
        ));
    }

    #[test]
    fn usage_tokens_cover_common_provider_response_shapes() {
        assert_eq!(
            usage_tokens_from_response(&serde_json::json!({
                "usage": {
                    "prompt_tokens": 12,
                    "completion_tokens": 4,
                    "total_tokens": 16
                }
            })),
            UsageTokens {
                input: Some(12),
                output: Some(4),
                total: Some(16),
                ..UsageTokens::default()
            }
        );
        assert_eq!(
            usage_tokens_from_response(&serde_json::json!({
                "usage": {
                    "input_tokens": 9,
                    "output_tokens": 3
                }
            })),
            UsageTokens {
                input: Some(9),
                output: Some(3),
                total: Some(12),
                ..UsageTokens::default()
            }
        );
        assert_eq!(
            usage_tokens_from_response(&serde_json::json!({
                "usageMetadata": {
                    "promptTokenCount": 8,
                    "candidatesTokenCount": 5,
                    "totalTokenCount": 17
                }
            })),
            UsageTokens {
                input: Some(8),
                output: Some(5),
                total: Some(17),
                ..UsageTokens::default()
            }
        );
        assert_eq!(
            usage_tokens_from_response(&serde_json::json!({"input_tokens": 21})),
            UsageTokens {
                input: Some(21),
                total: Some(21),
                ..UsageTokens::default()
            }
        );
    }

    #[test]
    fn usage_tokens_normalize_cache_exclusive_accounting_by_shape() {
        let tokens = usage_tokens_from_response(&serde_json::json!({
            "usage": {
                "input_tokens": 10,
                "output_tokens": 4,
                "cache_read_input_tokens": 20,
                "cache_creation_input_tokens": 8,
                "cache_creation": {
                    "ephemeral_5m_input_tokens": 3,
                    "ephemeral_1h_input_tokens": 5
                }
            }
        }));
        assert_eq!(tokens.input, Some(38));
        assert_eq!(tokens.output, Some(4));
        assert_eq!(tokens.total, Some(42));
        assert_eq!(tokens.cached_input, Some(20));
        assert_eq!(tokens.cache_write_total, Some(8));
        assert_eq!(tokens.cache_write_5m_input, Some(3));
        assert_eq!(tokens.cache_write_1h_input, Some(5));
        assert_eq!(tokens.cache_write_input, Some(0));
    }

    #[test]
    fn sse_usage_parser_handles_split_openai_final_event() {
        let mut parser = SseUsageParser::new();
        parser.push(b"event: response.completed\ndata: {\"type\":\"response.comp");
        parser.push(b"leted\",\"response\":{\"usage\":{\"input_tokens\":100,\"output_tokens\":20,\"input_tokens_details\":{\"cached_tokens\":40}}}}\n\n");
        parser.finish();
        assert_eq!(parser.tokens.input, Some(100));
        assert_eq!(parser.tokens.output, Some(20));
        assert_eq!(parser.tokens.total, Some(120));
        assert_eq!(parser.tokens.cached_input, Some(40));
        assert!(parser.terminal);
        assert_eq!(parser.terminal_status, Some(UsageStatus::Success));
    }

    #[test]
    fn sse_usage_parser_settles_oversized_openai_terminal_event() {
        let padding = "x".repeat(USAGE_SSE_EVENT_MAX_BYTES + 8 * 1024);
        let event = format!(
            "data: {{\"type\":\"response.completed\",\"response\":{{\"output\":[{{\"text\":\"{padding}\"}}],\"usage\":{{\"input_tokens\":100,\"output_tokens\":20,\"input_tokens_details\":{{\"cached_tokens\":40}}}}}}}}\n\n"
        );
        let mut parser = SseUsageParser::new();
        for chunk in event.as_bytes().chunks(8191) {
            parser.push(chunk);
        }
        parser.finish();

        assert_eq!(parser.tokens.input, Some(100));
        assert_eq!(parser.tokens.output, Some(20));
        assert_eq!(parser.tokens.total, Some(120));
        assert_eq!(parser.tokens.cached_input, Some(40));
        assert!(parser.terminal);
        assert_eq!(parser.terminal_status, Some(UsageStatus::Success));
    }

    #[test]
    fn sse_usage_parser_merges_anthropic_start_and_delta_usage() {
        let mut parser = SseUsageParser::new();
        parser.push(b"data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":10,\"cache_read_input_tokens\":20}}}\n\n");
        parser.push(b"data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":7}}\n\n");
        parser.finish();
        assert_eq!(parser.tokens.input, Some(30));
        assert_eq!(parser.tokens.output, Some(7));
        assert_eq!(parser.tokens.total, Some(37));
        assert!(!parser.terminal);
        parser.push(b"data: {\"type\":\"message_stop\"}\n\n");
        assert!(parser.terminal);
        assert_eq!(parser.terminal_status, Some(UsageStatus::Success));
    }

    #[test]
    fn sse_usage_parser_reconciles_anthropic_cumulative_cache_totals() {
        let mut parser = SseUsageParser::new();
        parser.push(b"data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":10,\"cache_creation_input_tokens\":8,\"cache_creation\":{\"ephemeral_5m_input_tokens\":3,\"ephemeral_1h_input_tokens\":5}}}}\n\n");
        parser.push(b"data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":7,\"cache_creation_input_tokens\":8}}\n\n");
        parser.push(b"data: {\"type\":\"message_stop\"}\n\n");
        assert_eq!(parser.tokens.input, Some(18));
        assert_eq!(parser.tokens.output, Some(7));
        assert_eq!(parser.tokens.total, Some(25));
        assert_eq!(parser.tokens.cache_write_total, Some(8));
        assert_eq!(parser.tokens.cache_write_5m_input, Some(3));
        assert_eq!(parser.tokens.cache_write_1h_input, Some(5));
        assert_eq!(parser.tokens.cache_write_input, Some(0));
    }

    #[test]
    fn sse_usage_parser_requires_anthropic_final_usage_delta() {
        let mut parser = SseUsageParser::new();
        parser.push(b"data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":10,\"output_tokens\":1}}}\n\n");
        parser.push(b"data: {\"type\":\"message_stop\"}\n\n");
        let result = parser.result(true, true);
        assert_eq!(result.tokens.input, Some(10));
        assert_eq!(result.tokens.output, None);
        assert!(!result.complete);
        assert_eq!(result.status, Some(UsageStatus::ProviderError));
    }

    #[test]
    fn sse_usage_parser_requires_a_protocol_terminal_marker() {
        let mut parser = SseUsageParser::new();
        parser.push(b"data: {\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":2}}\n\n");
        parser.finish();
        assert!(!parser.terminal);
        let missing_terminal = parser.result(true, true);
        assert!(!missing_terminal.complete);
        assert_eq!(missing_terminal.status, Some(UsageStatus::ProviderError));
        parser.push(b"data: [DONE]\n\n");
        assert!(parser.terminal);
        assert_eq!(parser.terminal_status, Some(UsageStatus::Success));
    }

    #[test]
    fn sse_usage_parser_accepts_clean_eof_for_non_terminal_protocols() {
        assert!(usage_stream_requires_terminal_marker(Some("openai_sse")));
        assert!(usage_stream_requires_terminal_marker(Some("anthropic_sse")));
        assert!(!usage_stream_requires_terminal_marker(Some("google_sse")));
        assert!(!usage_stream_requires_terminal_marker(Some("cohere_sse")));

        let parser = SseUsageParser::new();
        let complete = parser.result(true, false);
        assert!(complete.complete);
        assert_eq!(complete.status, Some(UsageStatus::Success));

        let interrupted = parser.result(false, false);
        assert!(!interrupted.complete);
        assert_eq!(interrupted.status, Some(UsageStatus::ProviderError));
    }

    #[test]
    fn sse_usage_parser_marks_failed_and_incomplete_terminals_as_provider_errors() {
        for terminal in ["response.failed", "response.incomplete"] {
            let mut parser = SseUsageParser::new();
            parser.push(format!("data: {{\"type\":\"{terminal}\"}}\n\n").as_bytes());
            assert!(parser.terminal);
            assert_eq!(parser.terminal_status, Some(UsageStatus::ProviderError));
        }
    }

    #[test]
    fn request_attribution_supports_claude_and_explicit_agent_headers() {
        let attribution = resolve_attribution(AttributionCandidates {
            claude_session_id: Some("claude-session".to_string()),
            claude_agent_id: Some("claude-agent".to_string()),
            explicit_agent_id: Some("explicit-agent".to_string()),
            project_id: Some("project-a".to_string()),
            ..AttributionCandidates::default()
        });
        assert_eq!(attribution.session_id.as_deref(), Some("claude-session"));
        assert_eq!(attribution.agent_id.as_deref(), Some("explicit-agent"));
        assert_eq!(attribution.project_id.as_deref(), Some("project-a"));
        assert_eq!(attribution.client.as_deref(), Some("claude_code"));
    }

    #[test]
    fn request_attribution_reads_codex_session_header() {
        let attribution = request_attribution_with(|names| {
            Ok::<_, ()>(
                names
                    .contains(&"session-id")
                    .then(|| "codex-session".to_string()),
            )
        })
        .unwrap();
        assert_eq!(attribution.session_id.as_deref(), Some("codex-session"));
        assert_eq!(attribution.client.as_deref(), Some("codex"));
    }

    #[test]
    fn oversized_json_usage_retains_the_conservative_reservation() {
        let mut accumulator = JsonUsageAccumulator::default();
        accumulator.push(b"{\"data\":\"");
        accumulator.push(&vec![b'x'; USAGE_TOKEN_RESPONSE_MAX_BYTES + 1]);
        accumulator.push(br#","usage":{"prompt_tokens":7,"total_tokens":7}}"#);
        assert!(accumulator.overflowed);
        assert!(accumulator.body.is_empty());
        let result = accumulator.result(true);
        assert_eq!(result.tokens, UsageTokens::default());
        assert!(!result.complete);
        assert_eq!(result.status, Some(UsageStatus::ProviderError));
    }

    #[test]
    fn json_usage_meter_classifies_incomplete_responses_as_provider_errors() {
        let mut accumulator = JsonUsageAccumulator::default();
        accumulator
            .push(br#"{"status":"incomplete","usage":{"input_tokens":7,"output_tokens":2}}"#);
        let result = accumulator.result(true);
        assert_eq!(result.tokens.input, Some(7));
        assert_eq!(result.tokens.output, Some(2));
        assert_eq!(result.status, Some(UsageStatus::ProviderError));
    }

    #[test]
    fn json_usage_meter_rejects_truncated_json_even_when_transport_completed() {
        let mut accumulator = JsonUsageAccumulator::default();
        accumulator.push(br#"{"usage":{"input_tokens":7"#);
        let result = accumulator.result(true);
        assert_eq!(result.tokens, UsageTokens::default());
        assert!(!result.complete);
        assert_eq!(result.status, Some(UsageStatus::ProviderError));
    }

    #[test]
    fn native_json_inspection_is_bounded_and_skips_fixed_price_raw_routes() {
        let mut policy = AccessPolicy {
            enabled: true,
            generation: "test".to_string(),
            providers: vec!["openai".to_string()],
            tenant_id: None,
            token_role: None,
            monthly_budget_micros: Some(1_000_000),
            request_cost_micros: None,
            retain_request_content: true,
        };
        assert!(native_request_needs_json_inspection(
            false,
            "llm.responses",
            &policy
        ));
        policy.request_cost_micros = Some(100);
        assert!(!native_request_needs_json_inspection(
            false,
            "llm.responses",
            &policy
        ));
        assert!(native_request_needs_json_inspection(
            true,
            "llm.messages",
            &policy
        ));
        assert!(!native_request_needs_json_inspection(
            false,
            "tool.invoke",
            &policy
        ));
    }

    #[test]
    fn budget_reservation_cutoff_saturates_before_the_lease_window() {
        assert_eq!(
            budget_reservation_cutoff_ms(BUDGET_RESERVATION_LEASE_MS - 1),
            0
        );
        assert_eq!(
            budget_reservation_cutoff_ms(BUDGET_RESERVATION_LEASE_MS + 42),
            42
        );
        assert_eq!(
            budget_charge_retention_cutoff_ms(BUDGET_CHARGE_RETENTION_MS + 42),
            42
        );
    }

    #[test]
    fn budget_accounting_conversion_only_applies_before_created_at() {
        assert!(legacy_budget_schema_requires_accounting_conversion(false));
        assert!(!legacy_budget_schema_requires_accounting_conversion(true));
    }

    #[test]
    fn budget_status_serializes_for_console_usage() {
        let status = BudgetStatusView {
            configured: true,
            ledger: "durable_object",
            window_key: Some("team_docs/svc_docs/2026-06".to_string()),
            limit_micros: Some(100),
            spent_micros: Some(40),
            remaining_micros: Some(60),
        };
        let value = serde_json::to_value(status).unwrap();
        assert_eq!(value["ledger"], "durable_object");
        assert_eq!(value["limitMicros"], 100);
        assert_eq!(value["remainingMicros"], 60);
    }

    #[test]
    fn provider_upstream_grant_refs_cover_token_ref_and_provider_fallbacks() {
        let provider = oauth_test_provider();
        let refs = provider_upstream_grant_refs(&provider);

        assert!(refs.iter().any(|value| value == "/oauth.acme.access_token"));
        assert!(refs.iter().any(|value| value == "/acme-oauth"));
    }

    #[test]
    fn provider_upstream_grant_count_requires_enabled_usable_records() {
        let provider = oauth_test_provider();
        let grants = vec![
            OAuthGrantRecord {
                key: "oauth/svc_docs/oauth.acme.access_token".to_string(),
                kind: UpstreamGrantKind::OAuth,
                provider: None,
                enabled: true,
                usable: true,
            },
            OAuthGrantRecord {
                key: "oauth/tenants/default/acme-oauth".to_string(),
                kind: UpstreamGrantKind::OAuth,
                provider: None,
                enabled: false,
                usable: true,
            },
            OAuthGrantRecord {
                key: "oauth/svc_docs/acme-oauth".to_string(),
                kind: UpstreamGrantKind::OAuth,
                provider: None,
                enabled: true,
                usable: false,
            },
            OAuthGrantRecord {
                key: "oauth/svc_docs/acme-oauth".to_string(),
                kind: UpstreamGrantKind::OAuth,
                provider: Some("other-provider".to_string()),
                enabled: true,
                usable: true,
            },
        ];

        assert_eq!(provider_upstream_grant_count(&provider, &grants), 1);
    }

    #[test]
    fn entitlement_oauth_grants_are_scoped_to_matching_policies() {
        let grants = vec![
            OAuthGrantRecord {
                key: "oauth/svc_docs/acme-oauth".to_string(),
                kind: UpstreamGrantKind::OAuth,
                provider: None,
                enabled: true,
                usable: true,
            },
            OAuthGrantRecord {
                key: "oauth/tenants/research/acme-oauth".to_string(),
                kind: UpstreamGrantKind::OAuth,
                provider: None,
                enabled: true,
                usable: true,
            },
            OAuthGrantRecord {
                key: "oauth/svc_other/acme-oauth".to_string(),
                kind: UpstreamGrantKind::OAuth,
                provider: None,
                enabled: true,
                usable: true,
            },
        ];
        let docs = AccessPolicyEntry {
            policy_id: "svc_docs".to_string(),
            policy: AccessPolicy {
                enabled: true,
                generation: "gen_1".to_string(),
                providers: vec!["oauth-test".to_string()],
                tenant_id: Some("team_docs".to_string()),
                token_role: None,
                monthly_budget_micros: None,
                request_cost_micros: None,
                retain_request_content: true,
            },
        };
        let research = AccessPolicyEntry {
            policy_id: "svc_research".to_string(),
            policy: AccessPolicy {
                tenant_id: Some("research".to_string()),
                ..docs.policy.clone()
            },
        };

        let scoped = entitlement_oauth_grants(&grants, &[&docs, &research]);
        assert_eq!(scoped.len(), 2);
        assert!(scoped
            .iter()
            .any(|grant| grant.key == "oauth/svc_docs/acme-oauth"));
        assert!(scoped
            .iter()
            .any(|grant| grant.key == "oauth/tenants/research/acme-oauth"));
        assert!(!scoped
            .iter()
            .any(|grant| grant.key == "oauth/svc_other/acme-oauth"));
    }

    #[test]
    fn access_policy_selection_prefers_oauth_grant_backed_policy() {
        let provider = oauth_test_provider();
        let docs = AccessPolicyEntry {
            policy_id: "svc_docs".to_string(),
            policy: AccessPolicy {
                enabled: true,
                generation: "gen_1".to_string(),
                providers: vec!["oauth-test".to_string()],
                tenant_id: Some("team_docs".to_string()),
                token_role: None,
                monthly_budget_micros: None,
                request_cost_micros: None,
                retain_request_content: true,
            },
        };
        let research = AccessPolicyEntry {
            policy_id: "svc_research".to_string(),
            policy: AccessPolicy {
                tenant_id: Some("research".to_string()),
                ..docs.policy.clone()
            },
        };
        let grants = vec![OAuthGrantRecord {
            key: "oauth/svc_research/acme-oauth".to_string(),
            kind: UpstreamGrantKind::OAuth,
            provider: None,
            enabled: true,
            usable: true,
        }];

        let entries = [&docs, &research];
        let selected =
            select_access_policy_for_provider(Some(&provider), &entries, &grants).unwrap();

        assert_eq!(selected.policy_id, "svc_research");
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
        let url =
            manifest_upstream_url(provider, endpoint, &proxy, None, None, None, None).unwrap();
        assert_eq!(url, "https://api.tavily.com/search?topic=news");
    }

    #[test]
    fn manifest_path_models_map_to_upstream_and_select_pricing() {
        let snapshot = provider_snapshot().unwrap();
        let provider = snapshot
            .providers
            .iter()
            .find(|provider| provider.id == "google-gemini")
            .unwrap();
        let endpoint = provider
            .endpoints
            .iter()
            .find(|endpoint| endpoint.id == "generate_content")
            .unwrap();
        let mut proxy = ManifestProxyRequest {
            method: Some("POST".to_string()),
            path_params: Map::from_iter([(
                "model".to_string(),
                Value::String("google/gemini-3.5-flash".to_string()),
            )]),
            body: Some(serde_json::json!({
                "contents": [{"parts": [{"text": "hello"}]}]
            })),
            ..ManifestProxyRequest::default()
        };

        let selection =
            normalize_manifest_path_model(provider, endpoint, &mut proxy, |_| None).unwrap();
        assert_eq!(selection.model, "google/gemini-3.5-flash");
        assert_eq!(selection.upstream_model, "gemini-3.5-flash");
        assert_eq!(
            selection.pricing_ref.as_deref(),
            Some("google-gemini-3-5-flash-standard-2026-06-22")
        );
        assert_eq!(
            proxy.path_params.get("model").and_then(Value::as_str),
            Some("gemini-3.5-flash")
        );
        assert_eq!(
            manifest_upstream_url(provider, endpoint, &proxy, None, None, None, None).unwrap(),
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent"
        );
    }

    #[test]
    fn manifest_path_models_strip_public_prefixes_for_template_catalog_entries() {
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
        let mut proxy = ManifestProxyRequest {
            path_params: Map::from_iter([(
                "deployment".to_string(),
                Value::String("azure-openai/deployment".to_string()),
            )]),
            body: Some(serde_json::json!({
                "model": "azure-openai/deployment",
                "messages": [{"role": "user", "content": "hello"}]
            })),
            ..ManifestProxyRequest::default()
        };

        let path_selection = normalize_manifest_path_model(provider, endpoint, &mut proxy, |_| {
            Some("configured-deployment".to_string())
        })
        .unwrap();
        assert_eq!(path_selection.upstream_model, "configured-deployment");
        assert_eq!(proxy.path_params["deployment"], "configured-deployment");
        let body = proxy.body.as_mut().unwrap();
        let selection = normalize_manifest_body_model(provider, body, |_| {
            Some("configured-deployment".to_string())
        })
        .unwrap();
        assert_eq!(selection.upstream_model, "configured-deployment");
        assert_eq!(body["model"], "configured-deployment");
    }

    #[test]
    fn native_proxy_matches_only_manifest_declared_paths_and_methods() {
        let snapshot = provider_snapshot().unwrap();
        let google = snapshot
            .providers
            .iter()
            .find(|provider| provider.id == "google-gemini")
            .unwrap();
        let generate = google
            .endpoints
            .iter()
            .find(|endpoint| endpoint.id == "generate_content")
            .unwrap();
        assert!(native_endpoint_path_matches(
            generate,
            "/v1beta/models/gemini-2.5-pro:generateContent"
        ));
        assert!(!native_endpoint_path_matches(
            generate,
            "/v1beta/models/gemini-2.5-pro:streamGenerateContent"
        ));
        assert!(!native_endpoint_path_matches(
            generate,
            "/v1beta/models/gemini%2F2.5-pro:generateContent"
        ));
        assert!(!native_endpoint_path_matches(
            generate,
            "/v1beta/models/%2e%2e:generateContent"
        ));
        assert_eq!(
            select_native_endpoint(
                google,
                "POST",
                "/v1beta/models/gemini-2.5-pro:generateContent"
            )
            .map(|endpoint| endpoint.id.as_str()),
            Some("generate_content")
        );
        assert!(select_native_endpoint(
            google,
            "DELETE",
            "/v1beta/models/gemini-2.5-pro:generateContent"
        )
        .is_none());
    }

    #[test]
    fn openai_subscription_grants_augment_responses_and_fallback_for_chat() {
        let snapshot = provider_snapshot().unwrap();
        let provider = snapshot
            .providers
            .iter()
            .find(|provider| provider.id == "openai")
            .unwrap();
        let grant = subscription_test_grant("openai");
        let responses = provider
            .endpoints
            .iter()
            .find(|endpoint| endpoint.id == "responses")
            .unwrap();
        let chat = provider
            .endpoints
            .iter()
            .find(|endpoint| endpoint.id == "chat_completions")
            .unwrap();
        let discovery_grants = vec![OAuthGrantRecord {
            key: "oauth/svc_models/openai".to_string(),
            kind: UpstreamGrantKind::Subscription,
            provider: Some("openai".to_string()),
            enabled: true,
            usable: true,
        }];

        assert_eq!(
            provider_upstream_base_url(provider, Some(&grant)).unwrap(),
            "https://chatgpt.com/backend-api/codex"
        );
        assert!(provider_endpoint_has_upstream_grant(
            provider,
            responses,
            &discovery_grants
        ));
        assert!(!provider_endpoint_has_upstream_grant(
            provider,
            chat,
            &discovery_grants
        ));
        assert!(grant_kind_supports_endpoint(
            provider,
            responses,
            UpstreamGrantKind::Subscription
        ));
        assert!(!grant_kind_supports_endpoint(
            provider,
            chat,
            UpstreamGrantKind::Subscription
        ));
        let (responses_grant, responses_path) =
            endpoint_upstream_grant(provider, responses, Some(grant.clone())).unwrap();
        assert!(responses_grant.is_some());
        assert_eq!(responses_path, Some("/responses".to_string()));
        let (chat_grant, chat_path) =
            endpoint_upstream_grant(provider, chat, Some(grant.clone())).unwrap();
        assert!(chat_grant.is_none());
        assert!(chat_path.is_none());
        assert_eq!(
            resolve_grant_template("${grant.accountId}", &grant).unwrap(),
            "acct_test"
        );
    }

    #[test]
    fn openai_manifest_declares_browser_oauth_with_account_metadata() {
        let snapshot = provider_snapshot().unwrap();
        let authorization = snapshot
            .providers
            .iter()
            .find(|provider| provider.id == "openai")
            .unwrap()
            .auth
            .authorization
            .as_ref()
            .unwrap();

        assert_eq!(
            authorization.authorize_url,
            "https://auth.openai.com/oauth/authorize"
        );
        assert_eq!(authorization.grant_kind, "subscription");
        assert_eq!(
            authorization.account_id_json_pointer.as_deref(),
            Some("/https:~1~1api.openai.com~1auth/chatgpt_account_id")
        );
    }

    #[test]
    fn oauth_callback_metadata_prefers_id_token_with_access_token_fallback() {
        let access_payload = serde_json::json!({
            "https://api.openai.com/auth": {
                "chatgpt_account_id": "acct_access",
                "chatgpt_plan_type": "plus"
            }
        });
        let id_payload = serde_json::json!({
            "https://api.openai.com/auth": {
                "chatgpt_account_id": "acct_id"
            }
        });
        let access_token = format!(
            "{}.{}.{}",
            base64_url_encode(br#"{"alg":"none"}"#),
            base64_url_encode(serde_json::to_string(&access_payload).unwrap().as_bytes()),
            base64_url_encode(b"signature")
        );
        let id_token = format!(
            "{}.{}.{}",
            base64_url_encode(br#"{"alg":"none"}"#),
            base64_url_encode(serde_json::to_string(&id_payload).unwrap().as_bytes()),
            base64_url_encode(b"signature")
        );
        let token = OAuthRefreshResponse {
            access_token,
            id_token: Some(id_token),
            refresh_token: None,
            token_type: None,
            expires_in: None,
            scope: None,
        };

        assert_eq!(
            oauth_token_json_pointer_string(
                &token,
                "/https:~1~1api.openai.com~1auth/chatgpt_account_id"
            )
            .as_deref(),
            Some("acct_id")
        );
        assert_eq!(
            oauth_token_json_pointer_string(
                &token,
                "/https:~1~1api.openai.com~1auth/chatgpt_plan_type"
            )
            .as_deref(),
            Some("plus")
        );
    }

    #[test]
    fn upstream_grant_routes_accept_browser_authorization_action() {
        let route = parse_admin_upstream_grant_route("policies/svc_docs/openai/authorize").unwrap();
        assert_eq!(route.key, "oauth/svc_docs/openai");
        assert_eq!(route.action.as_deref(), Some("authorize"));
    }

    #[test]
    fn sigv4_grants_require_and_hide_multi_field_credentials() {
        let snapshot = provider_snapshot().unwrap();
        let provider = snapshot
            .providers
            .iter()
            .find(|provider| provider.id == "aws-bedrock")
            .unwrap();
        let mut grant = subscription_test_grant("aws-bedrock");
        grant.kind = UpstreamGrantKind::ApiKey;
        grant.credential = None;
        grant.access_token = None;
        grant.refresh_token = None;
        grant.subscription = None;
        grant.credentials = BTreeMap::from([
            ("accessKeyId".to_string(), "AKID_PLACEHOLDER".to_string()),
            (
                "secretAccessKey".to_string(),
                "secret-placeholder".to_string(),
            ),
        ]);

        assert!(upstream_grant_usable(&grant));
        assert!(upstream_grant_supports_provider(provider, &grant));
        assert_eq!(provider_connection_types(provider), vec!["api_key"]);
        let response = admin_upstream_grant_response("oauth/svc_docs/aws-bedrock", &grant).unwrap();
        let raw = serde_json::to_string(&response).unwrap();
        assert_eq!(
            response.credential_fields,
            vec!["accessKeyId".to_string(), "secretAccessKey".to_string()]
        );
        assert!(!raw.contains("AKID_PLACEHOLDER"));
        assert!(!raw.contains("secret-placeholder"));
    }

    #[test]
    fn sigv4_grants_reject_incomplete_provider_credentials() {
        let mut grant = subscription_test_grant("aws-bedrock");
        grant.kind = UpstreamGrantKind::ApiKey;
        grant.credential = None;
        grant.access_token = None;
        grant.refresh_token = None;
        grant.subscription = None;
        grant.credentials =
            BTreeMap::from([("accessKeyId".to_string(), "AKID_PLACEHOLDER".to_string())]);

        assert_eq!(
            normalize_upstream_grant(grant, None).unwrap_err(),
            "upstream grant credentials do not satisfy the provider auth contract"
        );
    }

    #[test]
    fn named_credential_bundles_require_a_provider_auth_consumer() {
        let mut grant = subscription_test_grant("anthropic");
        grant.kind = UpstreamGrantKind::ApiKey;
        grant.credential = None;
        grant.access_token = None;
        grant.refresh_token = None;
        grant.subscription = None;
        grant.credentials =
            BTreeMap::from([("apiKey".to_string(), "secret-placeholder".to_string())]);

        assert!(upstream_grant_usable(&grant));
        assert!(!upstream_grant_usable_by_declared_provider(&grant));
        assert_eq!(
            normalize_upstream_grant(grant, None).unwrap_err(),
            "upstream grant credentials do not satisfy the provider auth contract"
        );
    }

    #[test]
    fn upstream_grant_admin_metadata_never_serializes_secrets() {
        let grant = subscription_test_grant("openai");
        let value = serde_json::to_value(
            admin_upstream_grant_response("oauth/svc_docs/openai", &grant).unwrap(),
        )
        .unwrap();
        let raw = serde_json::to_string(&value).unwrap();

        assert_eq!(value["scope"], "policies");
        assert_eq!(value["scopeId"], "svc_docs");
        assert_eq!(value["tokenRef"], "openai");
        assert_eq!(value["hasAccessToken"], true);
        assert_eq!(value["hasRefreshToken"], true);
        assert!(!raw.contains("test-access-token"));
        assert!(!raw.contains("test-refresh-token"));
    }

    #[test]
    fn upstream_grant_secret_shapes_do_not_cross_kind_boundaries() {
        let mut grant = subscription_test_grant("openai");
        grant.kind = UpstreamGrantKind::ApiKey;
        grant.credential = None;
        assert!(upstream_grant_secret(&grant).is_none());
        assert!(validate_upstream_grant_secret_shape(&grant).is_err());

        grant.kind = UpstreamGrantKind::OAuth;
        grant.access_token = None;
        grant.refresh_token = None;
        grant.credential = Some("api-key-placeholder".to_string());
        assert!(upstream_grant_secret(&grant).is_none());
        assert!(validate_upstream_grant_secret_shape(&grant).is_err());

        grant.kind = UpstreamGrantKind::Subscription;
        grant.access_token = Some("subscription-token-placeholder".to_string());
        assert!(validate_upstream_grant_secret_shape(&grant).is_err());
    }

    #[test]
    fn enabled_upstream_grants_require_revoke_before_identity_changes() {
        let existing = subscription_test_grant("openai");
        let mut changed_kind = existing.clone();
        changed_kind.kind = UpstreamGrantKind::OAuth;
        assert_eq!(
            normalize_upstream_grant(changed_kind, Some(&existing)).unwrap_err(),
            "revoke an enabled grant before changing its kind"
        );

        let mut changed_provider = existing.clone();
        changed_provider.provider = Some("anthropic".to_string());
        assert_eq!(
            normalize_upstream_grant(changed_provider, Some(&existing)).unwrap_err(),
            "revoke an enabled grant before changing its provider"
        );
    }

    #[test]
    fn native_proxy_relative_paths_still_reject_traversal() {
        let provider = relative_path_test_provider();
        let endpoint = provider
            .endpoints
            .iter()
            .find(|endpoint| endpoint.id == "search")
            .unwrap();
        assert!(native_endpoint_path_matches(
            endpoint,
            "/v1/repos/openclaw/clawrouter"
        ));
        assert!(!native_endpoint_path_matches(
            endpoint,
            "/v1/repos/../secrets"
        ));
        assert_eq!(
            native_endpoint_path(endpoint, "/v1/repos/openclaw%2Fclawrouter").as_deref(),
            Some("/v1/repos/openclaw/clawrouter")
        );
        assert!(native_endpoint_path(endpoint, "/v1/repos/openclaw%2F..%2Fsecrets").is_none());
    }

    #[test]
    fn native_proxy_header_filters_strip_client_credentials_and_cookies() {
        let snapshot = provider_snapshot().unwrap();
        let openai = snapshot
            .providers
            .iter()
            .find(|provider| provider.id == "openai")
            .unwrap();
        let endpoint = openai
            .endpoints
            .iter()
            .find(|endpoint| endpoint.id == "responses")
            .unwrap();
        assert!(native_request_header_allowed(
            openai,
            endpoint,
            "content-type"
        ));
        assert!(native_request_header_allowed(
            openai,
            endpoint,
            "openai-organization"
        ));
        assert!(!native_request_header_allowed(
            openai,
            endpoint,
            "authorization"
        ));
        assert!(!native_request_header_allowed(openai, endpoint, "api-key"));
        assert!(!native_request_header_allowed(
            openai,
            endpoint,
            "x-api-key"
        ));
        assert!(!native_request_header_allowed(
            openai,
            endpoint,
            "x-goog-api-key"
        ));
        assert!(!native_request_header_allowed(openai, endpoint, "cookie"));
        assert!(native_response_header_allowed(
            endpoint,
            "x-ratelimit-limit"
        ));
        assert!(!native_response_header_allowed(endpoint, "set-cookie"));
        let mut manifest_allowed = endpoint.clone();
        manifest_allowed.response_headers.extend([
            "connection".to_string(),
            "cf-ray".to_string(),
            "set-cookie".to_string(),
            "x-provider-trace".to_string(),
        ]);
        assert!(!native_response_header_allowed(
            &manifest_allowed,
            "connection"
        ));
        assert!(!native_response_header_allowed(&manifest_allowed, "cf-ray"));
        assert!(!native_response_header_allowed(
            &manifest_allowed,
            "set-cookie"
        ));
        assert!(native_response_header_allowed(
            &manifest_allowed,
            "x-provider-trace"
        ));
    }

    #[test]
    fn proxy_key_candidates_accept_native_sdk_credentials_after_bearer() {
        let key = parse_proxy_key_candidates([
            "not-a-clawrouter-key",
            "ocpk_test_native01_secret1234",
            "ocpk_live_later01_secret5678",
        ])
        .unwrap();
        assert_eq!(key.kid, "native01");

        let key = parse_proxy_key_candidates([
            "ocpk_live_bearer01_secret1234",
            "ocpk_test_native01_secret5678",
        ])
        .unwrap();
        assert_eq!(key.kid, "bearer01");
    }

    #[test]
    fn native_query_injection_preserves_unowned_duplicates_and_overrides_controlled_values() {
        let mut url = "https://example.com/v1/models".to_string();
        append_native_query(
            &mut url,
            Some("tag=one+two&%61pi-version=caller&flag&tag=%2Fraw"),
            BTreeMap::from([
                ("api-version".to_string(), "configured".to_string()),
                ("key".to_string(), "secret".to_string()),
            ]),
        )
        .unwrap();
        assert_eq!(
            url,
            "https://example.com/v1/models?tag=one+two&flag&tag=%2Fraw&api-version=configured&key=secret"
        );

        let mut passthrough = "https://example.com/v1/models".to_string();
        append_native_query(
            &mut passthrough,
            Some("tag=one+two&&flag&empty=&encoded=%2f"),
            BTreeMap::new(),
        )
        .unwrap();
        assert_eq!(
            passthrough,
            "https://example.com/v1/models?tag=one+two&&flag&empty=&encoded=%2f"
        );
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
        let url =
            manifest_upstream_url(provider, endpoint, &proxy, None, None, None, None).unwrap();
        assert_eq!(url, "https://api.replicate.com/v1/predictions/abc%20123");
    }

    #[test]
    fn manifest_proxy_encodes_declared_relative_path_params() {
        let provider = relative_path_test_provider();
        let endpoint = provider
            .endpoints
            .iter()
            .find(|endpoint| endpoint.id == "search")
            .unwrap();
        let proxy = ManifestProxyRequest {
            method: Some("GET".to_string()),
            path_params: Map::from_iter([(
                "path".to_string(),
                Value::String("repos/openclaw/clawrouter".to_string()),
            )]),
            ..ManifestProxyRequest::default()
        };
        let url =
            manifest_upstream_url(&provider, endpoint, &proxy, None, None, None, None).unwrap();
        assert_eq!(url, "https://api.example.com/v1/repos/openclaw/clawrouter");
    }

    #[test]
    fn manifest_proxy_rejects_relative_paths_that_escape() {
        let provider = relative_path_test_provider();
        let endpoint = provider
            .endpoints
            .iter()
            .find(|endpoint| endpoint.id == "search")
            .unwrap();
        let proxy = ManifestProxyRequest {
            method: Some("GET".to_string()),
            path_params: Map::from_iter([(
                "path".to_string(),
                Value::String("repos/../secrets".to_string()),
            )]),
            ..ManifestProxyRequest::default()
        };
        let error =
            manifest_upstream_url(&provider, endpoint, &proxy, None, None, None, None).unwrap_err();
        match error {
            ManifestProxyError::Client(message) => {
                assert!(message.contains("safe relative path"));
            }
            ManifestProxyError::Runtime(_) => panic!("expected client error"),
        }
    }

    #[test]
    fn upstream_grant_keys_prefer_policy_scope_before_tenant_fallbacks() {
        let provider = oauth_test_provider();
        let mut auth = AuthorizedKey {
            credential_id: Some("cred_docs".to_string()),
            principal_id: None,
            auth_type: "proxy_key",
            policy_id: "svc_docs".to_string(),
            policy: AccessPolicy {
                enabled: true,
                generation: "gen_1".to_string(),
                providers: vec!["oauth-test".to_string()],
                tenant_id: Some("team_docs".to_string()),
                token_role: Some("service".to_string()),
                monthly_budget_micros: None,
                request_cost_micros: None,
                retain_request_content: true,
            },
            content_retention_disabled: false,
        };

        assert_eq!(
            upstream_grant_keys(
                &provider,
                &auth,
                Some("acme-oauth"),
                Some("oauth.acme.access_token")
            ),
            vec![
                "oauth/svc_docs/oauth.acme.access_token",
                "oauth/svc_docs/acme-oauth",
                "oauth/svc_docs/oauth-test",
                "oauth/tenants/team_docs/oauth.acme.access_token",
                "oauth/tenants/team_docs/acme-oauth",
                "oauth/tenants/team_docs/oauth-test",
            ]
        );
        auth.policy.tenant_id = None;
        assert_eq!(
            upstream_grant_keys(&provider, &auth, None, None),
            vec![
                "oauth/svc_docs/oauth-test",
                "oauth/tenants/default/oauth-test",
            ]
        );
    }

    #[test]
    fn content_retention_defaults_on_and_user_exemption_wins() {
        let policy: AccessPolicy =
            serde_json::from_str(r#"{"enabled":true,"providers":["openai"]}"#).unwrap();
        let mut auth = AuthorizedKey {
            credential_id: Some("cred_docs".to_string()),
            principal_id: Some("user@example.com".to_string()),
            auth_type: "proxy_key",
            policy_id: "svc_docs".to_string(),
            policy,
            content_retention_disabled: false,
        };
        assert!(content_retention_view(&auth).enabled);
        auth.content_retention_disabled = true;
        let retention = content_retention_view(&auth);
        assert!(!retention.enabled);
        assert!(retention.policy_enabled);
        assert!(retention.user_exempt);
    }

    #[test]
    fn content_archive_keys_are_tenant_scoped_and_encoded() {
        assert_eq!(
            content_archive_key("team/docs", "req 1"),
            "v1/team%2Fdocs/req%201.json"
        );
    }

    #[test]
    fn upstream_grant_records_accept_json_or_raw_tokens() {
        let json = parse_upstream_grant_record(
            r#"{"enabled":true,"accessToken":"gho_test","tokenType":"Bearer"}"#,
        )
        .unwrap();
        assert_eq!(json.access_token.as_deref(), Some("gho_test"));
        assert_eq!(json.token_type, "Bearer");

        let raw = parse_upstream_grant_record("xoxb-test").unwrap();
        assert_eq!(raw.access_token.as_deref(), Some("xoxb-test"));
        assert_eq!(raw.token_type, "Bearer");
        let tombstone =
            parse_upstream_grant_record(r#"{"enabled":false,"tokenType":"Bearer"}"#).unwrap();
        assert!(!tombstone.enabled);
        assert_eq!(tombstone.access_token, None);
        assert!(parse_upstream_grant_record("   ").is_err());
    }

    #[test]
    fn manifest_proxy_omits_bodies_for_get_and_head() {
        assert!(!method_allows_body("GET"));
        assert!(!method_allows_body("HEAD"));
        assert!(method_allows_body("POST"));
        assert!(method_allows_body("PATCH"));
    }

    #[test]
    fn sigv4_headers_include_canonical_aws_fields() {
        let context = HeaderRequestContext {
            method: "POST",
            url: "https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude/invoke",
            body: Some(br#"{"inputText":"ok"}"#),
        };
        let headers = sigv4_headers_at(
            "AKIDEXAMPLE",
            "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
            Some("session-token"),
            "us-east-1",
            "bedrock",
            context,
            "20260605T010203Z",
        )
        .unwrap();

        assert_eq!(headers["x-amz-date"], "20260605T010203Z");
        assert_eq!(headers["x-amz-security-token"], "session-token");
        assert!(headers["authorization"]
            .contains("Credential=AKIDEXAMPLE/20260605/us-east-1/bedrock/aws4_request"));
        assert!(headers["authorization"]
            .contains("SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token"));
        assert_eq!(
            sigv4_url_parts(context.url).unwrap(),
            (
                "bedrock-runtime.us-east-1.amazonaws.com".to_string(),
                "/model/anthropic.claude/invoke".to_string(),
                String::new()
            )
        );
    }

    #[test]
    fn usage_event_ids_are_internal_and_unique() {
        let first = usage_event_id_from_parts(42, 1, 2, 3);
        let second = usage_event_id_from_parts(42, 2, 2, 3);
        assert_ne!(first, second);
        assert_eq!(first, "usage_42_1_23");
    }

    #[test]
    fn usage_audit_metadata_is_bounded_at_utf8_boundaries() {
        let multibyte = "é".repeat(USAGE_AUDIT_MODEL_MAX_BYTES);
        let mut event = UsageEvent::new_success(
            "x".repeat(USAGE_AUDIT_FIELD_MAX_BYTES + 1),
            "x".repeat(USAGE_AUDIT_FIELD_MAX_BYTES + 1),
            "x".repeat(USAGE_AUDIT_FIELD_MAX_BYTES + 1),
            multibyte.clone(),
            "x".repeat(USAGE_AUDIT_FIELD_MAX_BYTES + 1),
            "x".repeat(USAGE_AUDIT_FIELD_MAX_BYTES + 1),
        );
        event.policy_id = "x".repeat(USAGE_AUDIT_FIELD_MAX_BYTES + 1);
        event.credential_id = Some("x".repeat(USAGE_AUDIT_FIELD_MAX_BYTES + 1));
        event.principal_id = Some("x".repeat(USAGE_AUDIT_PRINCIPAL_MAX_BYTES + 1));
        event.event_type = "x".repeat(USAGE_AUDIT_FIELD_MAX_BYTES + 1);
        event.auth_type = "x".repeat(USAGE_AUDIT_FIELD_MAX_BYTES + 1);
        event.model = Some(multibyte);

        normalize_usage_event_metadata(&mut event);

        assert_eq!(event.id.len(), USAGE_AUDIT_FIELD_MAX_BYTES);
        assert_eq!(event.event_type.len(), USAGE_AUDIT_FIELD_MAX_BYTES);
        assert_eq!(event.tenant_id.len(), USAGE_AUDIT_FIELD_MAX_BYTES);
        assert_eq!(event.policy_id.len(), USAGE_AUDIT_FIELD_MAX_BYTES);
        assert_eq!(
            event.credential_id.as_deref().unwrap().len(),
            USAGE_AUDIT_FIELD_MAX_BYTES
        );
        assert_eq!(
            event.principal_id.as_deref().unwrap().len(),
            USAGE_AUDIT_PRINCIPAL_MAX_BYTES
        );
        assert_eq!(event.auth_type.len(), USAGE_AUDIT_FIELD_MAX_BYTES);
        assert_eq!(event.key_id.len(), USAGE_AUDIT_FIELD_MAX_BYTES);
        assert_eq!(event.request_id.len(), USAGE_AUDIT_FIELD_MAX_BYTES);
        assert_eq!(
            event.request_id.chars().count(),
            USAGE_AUDIT_FIELD_MAX_BYTES / 2
        );
        assert_eq!(event.provider.len(), USAGE_AUDIT_FIELD_MAX_BYTES);
        assert_eq!(event.capability.len(), USAGE_AUDIT_FIELD_MAX_BYTES);
        assert_eq!(
            event.model.as_deref().unwrap().len(),
            USAGE_AUDIT_MODEL_MAX_BYTES
        );
        assert_eq!(
            event.model.as_deref().unwrap().chars().count(),
            USAGE_AUDIT_MODEL_MAX_BYTES / 2
        );
    }

    #[test]
    fn usage_retention_cutoff_saturates_before_the_retention_window() {
        assert_eq!(usage_retention_cutoff_ms(USAGE_EVENT_RETENTION_MS - 1), 0);
        assert_eq!(usage_retention_cutoff_ms(USAGE_EVENT_RETENTION_MS + 42), 42);
    }
}
