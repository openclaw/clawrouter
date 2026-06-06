use clawrouter_core::{
    parse_proxy_key, AuthScheme, CompiledEndpoint, CompiledProvider, PathParamStyle, ProviderClass,
    ProviderSnapshot, UsageEvent, UsageStatus,
};
use hmac::{Hmac, Mac};
use js_sys::{Array, Function, Object, Promise, Reflect, Uint8Array};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicU64, Ordering};
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;
use worker::*;

const PROVIDER_SNAPSHOT: &str = include_str!(concat!(env!("OUT_DIR"), "/provider-snapshot.json"));
static USAGE_EVENT_COUNTER: AtomicU64 = AtomicU64::new(0);
const MAX_SQL_BUDGET_MICROS: u64 = 9_007_199_254_740_991;
const CORS_ALLOW_ORIGIN: &str = "*";
const CORS_ALLOW_METHODS: &str = "GET,POST,PUT,OPTIONS";
const CORS_ALLOW_HEADERS: &str = "authorization,content-type,x-request-id";
const CORS_MAX_AGE: &str = "600";
type HmacSha256 = Hmac<Sha256>;
const INTERFACE_HTML: &str = r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ClawRouter Console</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #080908;
      --surface: #0d0f0e;
      --surface-2: #121614;
      --surface-3: #171d1a;
      --ink: #f2f4ef;
      --muted: #a3aaa1;
      --faint: #6e766f;
      --line: #242b27;
      --line-strong: #39423d;
      --accent: #e7f8c8;
      --accent-soft: #243323;
      --accent-ink: #10140e;
      --warn: #ff8b68;
      --shadow: 0 18px 54px rgba(0, 0, 0, .34);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background:
        linear-gradient(rgba(255,255,255,.025) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255,255,255,.025) 1px, transparent 1px),
        radial-gradient(circle at 75% -15%, rgba(231, 248, 200, .10), transparent 34%),
        var(--bg);
      background-size: 34px 34px, 34px 34px, auto, auto;
      color: var(--ink);
      line-height: 1.45;
    }
    header {
      border-bottom: 1px solid var(--line);
      background: rgba(8, 9, 8, .88);
      backdrop-filter: blur(18px);
      position: sticky;
      top: 0;
      z-index: 2;
    }
    .wrap {
      width: min(1240px, calc(100vw - 32px));
      margin: 0 auto;
    }
    .top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      min-height: 74px;
      padding: 14px 0;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 13px;
      min-width: 0;
    }
    .brandmark {
      width: 42px;
      height: 42px;
      display: grid;
      place-items: center;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: linear-gradient(180deg, var(--surface-3), var(--surface));
      color: var(--accent);
      font-weight: 800;
      box-shadow: inset 0 1px 0 rgba(255,255,255,.08);
    }
    .eyebrow {
      margin: 0 0 4px;
      color: var(--faint);
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: .08em;
    }
    h1 { margin: 0; font-size: 24px; line-height: 1; letter-spacing: 0; }
    h2 { margin: 0 0 14px; font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); }
    p { margin: 6px 0 0; color: var(--muted); }
    nav {
      display: flex;
      gap: 4px;
      flex-wrap: wrap;
      padding: 3px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: var(--surface);
    }
    button, input, select {
      font: inherit;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--surface-2);
      color: var(--ink);
    }
    button {
      min-height: 38px;
      padding: 0 12px;
      cursor: pointer;
      transition: background .16s ease, border-color .16s ease, color .16s ease, transform .16s ease;
    }
    button:hover { transform: translateY(-1px); border-color: var(--line-strong); }
    nav button {
      border-color: transparent;
      background: transparent;
      color: var(--muted);
      border-radius: 999px;
    }
    button.active, button.primary {
      background: var(--ink);
      color: var(--accent-ink);
      border-color: var(--ink);
    }
    main { padding: 18px 0 42px; }
    .toolbar {
      display: grid;
      grid-template-columns: 1fr 1fr auto;
      gap: 10px;
      align-items: end;
      margin-bottom: 12px;
      padding: 10px;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: rgba(13, 15, 14, .82);
      box-shadow: var(--shadow);
    }
    label { display: grid; gap: 5px; color: var(--faint); font-size: 12px; font-weight: 650; }
    input, select { min-height: 38px; padding: 0 10px; width: 100%; }
    input:focus-visible, button:focus-visible {
      outline: 2px solid rgba(231, 248, 200, .34);
      outline-offset: 2px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(12, 1fr);
      gap: 14px;
    }
    .panel {
      grid-column: span 6;
      background: linear-gradient(180deg, rgba(23, 29, 26, .92), rgba(13, 15, 14, .94));
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 16px;
      min-width: 0;
      overflow-x: auto;
      box-shadow: var(--shadow);
    }
    .wide { grid-column: 1 / -1; }
    .metrics {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
    }
    .metric {
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 13px 14px;
      background: var(--surface);
    }
    .metric strong { display: block; font-size: 25px; line-height: 1.1; letter-spacing: 0; }
    .metric span { color: var(--faint); font-size: 12px; font-weight: 650; }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
      min-width: 520px;
    }
    th, td {
      padding: 10px 8px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: top;
    }
    tbody tr:hover { background: rgba(231, 248, 200, .035); }
    th { color: var(--faint); font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
    code {
      background: #0a0d0b;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 2px 5px;
      word-break: break-word;
      color: #dbeec8;
    }
    .status {
      display: inline-flex;
      align-items: center;
      min-height: 28px;
      margin: 0 0 16px;
      padding: 0 9px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: var(--surface);
      color: var(--muted);
      font-size: 13px;
    }
    .bad { color: var(--warn); border-color: color-mix(in oklch, var(--warn), white 50%); }
    .hidden { display: none; }
    @media (max-width: 820px) {
      .top, .toolbar { grid-template-columns: 1fr; display: grid; }
      .brand { align-items: flex-start; }
      nav { width: 100%; }
      nav button { flex: 1 1 46%; }
      .panel { grid-column: 1 / -1; }
      .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 520px) {
      .wrap { width: min(100vw - 20px, 1180px); }
      .metrics { grid-template-columns: 1fr; }
      .brandmark { display: none; }
    }
  </style>
</head>
<body>
  <header>
    <div class="wrap top">
      <div class="brand">
        <div class="brandmark">CR</div>
        <div>
          <p class="eyebrow">gateway console</p>
          <h1>ClawRouter</h1>
          <p>Model routing, proxy keys, tenant budgets, and usage controls.</p>
        </div>
      </div>
      <nav aria-label="console views">
        <button data-view="dashboard" class="active">Dashboard</button>
        <button data-view="admin">Admin</button>
        <button data-view="account">Account</button>
        <button data-view="routes">Routes</button>
      </nav>
    </div>
  </header>
  <main class="wrap">
    <section class="toolbar">
      <label>Admin token<input id="adminToken" type="password" autocomplete="off" placeholder="optional bearer fallback"></label>
      <label>Proxy key<input id="proxyKey" type="password" autocomplete="off" placeholder="required for account views"></label>
      <button id="refresh" class="primary">Refresh</button>
    </section>
    <p id="status" class="status">idle</p>
    <section id="dashboard" class="view grid">
      <div class="panel wide">
        <h2>Service</h2>
        <div id="serviceMetrics" class="metrics"></div>
      </div>
      <div class="panel">
        <h2>Provider Classes</h2>
        <div id="providerClasses"></div>
      </div>
      <div class="panel">
        <h2>Configured Routes</h2>
        <div id="routeSummary"></div>
      </div>
    </section>
    <section id="admin" class="view grid hidden">
      <div class="panel wide">
        <h2>Admin Overview</h2>
        <div id="adminMetrics" class="metrics"></div>
      </div>
      <div class="panel">
        <h2>Users / Tenants</h2>
        <div id="adminUsers"></div>
      </div>
      <div class="panel">
        <h2>Usage</h2>
        <div id="adminUsage"></div>
      </div>
    </section>
    <section id="account" class="view grid hidden">
      <div class="panel">
        <h2>Profile</h2>
        <div id="profile"></div>
      </div>
      <div class="panel">
        <h2>Budget</h2>
        <div id="usage"></div>
      </div>
    </section>
    <section id="routes" class="view grid hidden">
      <div class="panel wide">
        <h2>Route Catalog</h2>
        <div id="routesTable"></div>
      </div>
    </section>
  </main>
  <script>
    const initialView = ({
      "/admin": "admin",
      "/account": "account",
      "/routes": "routes",
      "/console": "dashboard",
      "/dashboard": "dashboard"
    })[window.location.pathname] || "dashboard";
    const state = { view: initialView, service: null, session: null, providers: null, routes: null };
    const $ = (id) => document.getElementById(id);
    const status = (text, bad = false) => {
      $("status").textContent = text;
      $("status").className = bad ? "status bad" : "status";
    };
    const authHeaders = (kind) => {
      if (kind !== "admin" && kind !== "proxy") return {};
      const token = kind === "admin" ? $("adminToken").value.trim() : $("proxyKey").value.trim();
      return token ? { authorization: `Bearer ${token}` } : {};
    };
    async function api(path, kind) {
      const response = await fetch(path, { headers: authHeaders(kind) });
      const text = await response.text();
      const data = text ? JSON.parse(text) : {};
      if (!response.ok) {
        throw new Error(data.error?.message || `${path} failed with ${response.status}`);
      }
      return data;
    }
    const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#39;"
    })[char]);
    const raw = (html) => ({ html });
    const code = (value) => raw(`<code>${esc(value)}</code>`);
    const cell = (item) => item && typeof item === "object" && "html" in item ? item.html : esc(item);
    const money = (value) => value == null ? "none" : `$${(value / 1000000).toFixed(2)}`;
    const number = (value) => value == null ? "none" : new Intl.NumberFormat().format(value);
    const metric = (label, value) => `<div class="metric"><strong>${esc(value)}</strong><span>${esc(label)}</span></div>`;
    const row = (items) => `<tr>${items.map((item) => `<td>${cell(item)}</td>`).join("")}</tr>`;
    const table = (heads, rows) => `<table><thead><tr>${heads.map((head) => `<th>${esc(head)}</th>`).join("")}</tr></thead><tbody>${rows.join("") || row([raw(`<span class="status">no rows</span>`)])}</tbody></table>`;
    function renderDashboard() {
      const providers = state.providers?.providers || [];
      const routes = state.routes || { openaiCompatible: [], manifestProxy: [] };
      $("serviceMetrics").innerHTML = [
        metric("providers", providers.length),
        metric("openai compatible", routes.openaiCompatible.length),
        metric("manifest routes", routes.manifestProxy.length),
        metric("session", state.session?.authenticated ? `${state.session.role} · ${state.session.email}` : "not signed in")
      ].join("");
      const classes = providers.reduce((acc, provider) => {
        acc[provider.class] = (acc[provider.class] || 0) + 1;
        return acc;
      }, {});
      $("providerClasses").innerHTML = table(["class", "providers"], Object.entries(classes).map(([name, count]) => row([name, count])));
      $("routeSummary").innerHTML = table(["surface", "count"], [
        row(["OpenAI-compatible", routes.openaiCompatible.length]),
        row(["manifest proxy", routes.manifestProxy.length])
      ]);
    }
    function renderRoutes() {
      const routes = state.routes || { openaiCompatible: [], manifestProxy: [] };
      const rows = [
        ...routes.openaiCompatible.map((route) => row([route.provider, "openai", route.endpoints.join(", "), String(route.models.length)])),
        ...routes.manifestProxy.map((route) => row([route.provider, route.endpoint, code(route.route), route.methods.join(", ")]))
      ];
      $("routesTable").innerHTML = table(["provider", "route", "surface", "models/methods"], rows);
    }
    async function renderAdmin() {
      const [overview, users, usage] = await Promise.all([
        api("/v1/admin/overview", "admin"),
        api("/v1/admin/users", "admin"),
        api("/v1/admin/usage", "admin")
      ]);
      $("adminMetrics").innerHTML = [
        metric("keys", overview.keysTotal),
        metric("active keys", overview.keysActive),
        metric("tenants", overview.tenantsTotal),
        metric("monthly budget", money(overview.monthlyBudgetMicros))
      ].join("");
      $("adminUsers").innerHTML = table(["tenant", "keys", "active", "providers"], users.tenants.map((tenant) => row([
        tenant.tenantId,
        tenant.keys,
        tenant.activeKeys,
        tenant.providers.join(", ")
      ])));
      $("adminUsage").innerHTML = table(["key", "tenant", "budget", "spent", "remaining", "ledger"], usage.keys.map((key) => row([
        code(key.kid),
        key.tenantId,
        money(key.monthlyBudgetMicros),
        number(key.budget.spentMicros),
        number(key.budget.remainingMicros),
        key.budget.ledger
      ])));
    }
    async function renderAccount() {
      const [me, usage] = await Promise.all([api("/v1/me", "proxy"), api("/v1/usage", "proxy")]);
      $("profile").innerHTML = table(["field", "value"], [
        row(["key", code(me.key.kid)]),
        row(["tenant", me.key.tenantId]),
        row(["enabled", String(me.key.enabled)]),
        row(["providers", me.key.providers.join(", ")])
      ]);
      $("usage").innerHTML = table(["field", "value"], [
        row(["monthly budget", money(usage.budget.limitMicros)]),
        row(["spent", number(usage.budget.spentMicros)]),
        row(["remaining", number(usage.budget.remainingMicros)]),
        row(["request cost", number(usage.key.requestCostMicros)]),
        row(["ledger", usage.budget.ledger])
      ]);
    }
    async function refresh() {
      try {
        status("loading");
        state.service = await api("/v1");
        [state.session, state.providers, state.routes] = await Promise.all([api("/v1/session"), api("/v1/providers"), api("/v1/routes")]);
        renderDashboard();
        renderRoutes();
        if (state.view === "admin") await renderAdmin();
        if (state.view === "account") await renderAccount();
        status("loaded");
      } catch (error) {
        status(error.message || String(error), true);
      }
    }
    function syncView() {
      document.querySelectorAll("nav button").forEach((item) => item.classList.toggle("active", item.dataset.view === state.view));
      document.querySelectorAll(".view").forEach((view) => view.classList.toggle("hidden", view.id !== state.view));
    }
    document.querySelectorAll("nav button").forEach((button) => {
      button.addEventListener("click", async () => {
        state.view = button.dataset.view;
        syncView();
        await refresh();
      });
    });
    $("refresh").addEventListener("click", refresh);
    syncView();
    refresh();
  </script>
</body>
</html>"#;

#[event(fetch)]
async fn fetch(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    let url = req.url()?;
    let request_path = url.path().to_string();
    let api_path = canonical_api_path(&request_path);
    if req.method() == Method::Options && cors_enabled_path(&api_path) {
        return cors_preflight();
    }
    if req.method() == Method::Get && request_path == "/" {
        return protected_interface_shell(req.headers(), &env).await;
    }
    if req.method() == Method::Get && url.path() == "/v1" {
        return service_index().and_then(with_cors);
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

    if req.method() == Method::Get && api_path == "/v1/me" {
        return user_profile(req.headers(), &env).await.and_then(with_cors);
    }

    if req.method() == Method::Get && api_path == "/v1/usage" {
        return user_usage(req.headers(), &env).await.and_then(with_cors);
    }

    if api_path.starts_with("/v1/admin/") {
        return admin_api(req, env, &api_path).await.and_then(with_cors);
    }

    if url.path() == "/v1/key/inspect" {
        return inspect_proxy_key(req.headers(), &env)
            .await
            .and_then(with_cors);
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

fn service_index() -> Result<Response> {
    Response::from_json(&serde_json::json!({
        "ok": true,
        "service": "clawrouter-edge",
        "runtime": "rust-wasm",
        "interface": {
            "root": "/",
            "dashboard": "/dashboard",
            "admin": "/admin",
            "account": "/account"
        },
        "endpoints": {
            "health": "/v1/health",
            "providers": "/v1/providers",
            "routes": "/v1/routes",
            "session": "/v1/session",
            "me": "/v1/me",
            "usage": "/v1/usage",
            "keyInspect": "/v1/key/inspect",
            "adminOverview": "/v1/admin/overview",
            "adminUsers": "/v1/admin/users",
            "adminUsage": "/v1/admin/usage",
            "adminKeys": "/v1/admin/keys",
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
        }
    }))
}

fn interface_path(path: &str) -> bool {
    matches!(
        path,
        "/dashboard" | "/admin" | "/account" | "/console" | "/routes"
    )
}

fn canonical_api_path(path: &str) -> String {
    match path {
        "/api/route" | "/api/routes" => "/v1/routes".to_string(),
        "/api/session" => "/v1/session".to_string(),
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
    let mut response = Response::from_html(INTERFACE_HTML)?;
    response
        .headers_mut()
        .set("cache-control", "no-store, max-age=0")?;
    Ok(response)
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
                serde_json::json!({
                    "provider": provider.id,
                    "endpoint": endpoint.id,
                    "route": format!("/v1/proxy/{}/{}", provider.id, endpoint.id),
                    "methods": &endpoint.methods,
                    "streaming": &endpoint.streaming
                })
            })
        })
        .collect::<Vec<_>>();

    serde_json::json!({
        "version": "clawrouter.route-catalog.v1",
        "openaiCompatible": openai_compatible,
        "manifestProxy": manifest_proxy
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
    if let Some(response) = preflight_static_budget(&auth.policy)? {
        return Ok(response);
    }
    if let Err(error) = openai_endpoint_path(endpoint, &route.upstream_model) {
        match error {
            OpenAiProxyUrlError::Client(message) => {
                return json_error("invalid_model", &message, 400);
            }
            OpenAiProxyUrlError::Runtime(error) => return Err(error),
        }
    }
    let upstream_url =
        match openai_upstream_url(route.provider, endpoint, &env, &route.upstream_model) {
            Ok(url) => url,
            Err(OpenAiProxyUrlError::Client(message)) => {
                return json_error("invalid_model", &message, 400);
            }
            Err(OpenAiProxyUrlError::Runtime(error)) => return Err(error),
        };
    body["model"] = Value::String(route.upstream_model.clone());
    let upstream_body = serde_json::to_string(&body)?;

    let header_context = HeaderRequestContext {
        method: "POST",
        url: &upstream_url,
        body: Some(&upstream_body),
    };
    let headers = match provider_headers(
        req.headers(),
        &env,
        route.provider,
        endpoint,
        &auth,
        header_context,
    )
    .await
    {
        Ok(headers) => headers,
        Err(HeaderBuildError::Client {
            code,
            message,
            status,
        }) => return json_error(code, message, status),
        Err(HeaderBuildError::Runtime(error)) => return Err(error),
    };
    let budget = match preflight_budget(&env, &auth, capability, &request_id).await? {
        BudgetPreflight::Allowed(budget) => budget,
        BudgetPreflight::Denied(response) => return Ok(response),
    };

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
            budget,
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
    let request_id = request_id(req.headers(), endpoint_id);
    if let Some(response) = preflight_static_budget(&auth.policy)? {
        return Ok(response);
    }
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
    if let Err(ManifestProxyError::Client(message)) =
        validate_manifest_path_params(endpoint, &proxy)
    {
        return json_error("invalid_proxy_request", &message, 400);
    }
    let upstream_url = match manifest_upstream_url(provider, endpoint, &proxy, Some(&env)) {
        Ok(url) => url,
        Err(ManifestProxyError::Client(message)) => {
            return json_error("invalid_proxy_request", &message, 400);
        }
        Err(ManifestProxyError::Runtime(error)) => return Err(error),
    };
    let upstream_body = method_allows_body(&upstream_method)
        .then(|| serde_json::to_string(&proxy.body.unwrap_or(Value::Object(Map::new()))))
        .transpose()?;
    let header_context = HeaderRequestContext {
        method: &upstream_method,
        url: &upstream_url,
        body: upstream_body.as_deref(),
    };
    let headers = match provider_headers(
        req.headers(),
        &env,
        provider,
        endpoint,
        &auth,
        header_context,
    )
    .await
    {
        Ok(headers) => headers,
        Err(HeaderBuildError::Client {
            code,
            message,
            status,
        }) => return json_error(code, message, status),
        Err(HeaderBuildError::Runtime(error)) => return Err(error),
    };
    let budget = match preflight_budget(&env, &auth, capability, &request_id).await? {
        BudgetPreflight::Allowed(budget) => budget,
        BudgetPreflight::Denied(response) => return Ok(response),
    };

    let mut init = RequestInit::new();
    init.with_method(method_from_str(&upstream_method)?)
        .with_headers(headers);
    if let Some(upstream_body) = upstream_body {
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
            budget,
            status: usage_status(response.status_code()),
        },
    )
    .await;
    Ok(response)
}

#[derive(Debug, Clone, Deserialize, Serialize)]
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
    #[serde(default)]
    request_cost_micros: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AdminKeyPolicyRequest {
    secret_sha256: String,
    #[serde(default)]
    providers: Vec<String>,
    #[serde(default)]
    tenant_id: Option<String>,
    #[serde(default)]
    monthly_budget_micros: Option<u64>,
    #[serde(default)]
    request_cost_micros: Option<u64>,
    #[serde(default = "default_true")]
    enabled: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AdminKeyPolicyResponse {
    kid: String,
    enabled: bool,
    providers: Vec<String>,
    tenant_id: Option<String>,
    monthly_budget_micros: Option<u64>,
    request_cost_micros: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct KeyProfileResponse {
    kid: String,
    enabled: bool,
    providers: Vec<String>,
    tenant_id: String,
    monthly_budget_micros: Option<u64>,
    request_cost_micros: Option<u64>,
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
    keys: usize,
    active_keys: usize,
    providers: Vec<String>,
    monthly_budget_micros: u64,
    request_cost_micros: u64,
}

#[derive(Debug, Default)]
struct TenantAccumulator {
    keys: usize,
    active_keys: usize,
    providers: BTreeSet<String>,
    monthly_budget_micros: u64,
    request_cost_micros: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AdminUsageRow {
    kid: String,
    tenant_id: String,
    enabled: bool,
    providers: Vec<String>,
    monthly_budget_micros: Option<u64>,
    request_cost_micros: Option<u64>,
    budget: BudgetStatusView,
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
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccessUserRecord {
    role: AccessRole,
    #[serde(default)]
    tenant_id: Option<String>,
    #[serde(default)]
    enabled: Option<bool>,
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OAuthTokenRecord {
    #[serde(default = "default_true")]
    enabled: bool,
    #[serde(default, alias = "access_token")]
    access_token: Option<String>,
    #[serde(default = "default_oauth_token_type", alias = "token_type")]
    token_type: String,
}

struct AuthorizedKey {
    kid: String,
    policy: KeyPolicy,
}

enum AuthOutcome {
    Allowed(AuthorizedKey),
    Denied(Response),
}

async fn session_profile(headers: &Headers, env: &Env) -> Result<Response> {
    if let Some(session) = verified_access_session(headers, env).await? {
        return Response::from_json(&session);
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

    if req.method() == Method::Get && path == "/v1/admin/overview" {
        let entries = list_admin_key_policies(&kv).await?;
        let snapshot = provider_snapshot()?;
        return Response::from_json(&admin_overview(&entries, &snapshot));
    }

    if req.method() == Method::Get && path == "/v1/admin/users" {
        let entries = list_admin_key_policies(&kv).await?;
        return Response::from_json(&serde_json::json!({
            "tenants": admin_tenant_summaries(&entries)
        }));
    }

    if req.method() == Method::Get && path == "/v1/admin/usage" {
        let entries = list_admin_key_policies(&kv).await?;
        let mut rows = Vec::new();
        for entry in entries {
            rows.push(admin_usage_row(&env, entry).await?);
        }
        return Response::from_json(&serde_json::json!({ "keys": rows }));
    }

    if req.method() == Method::Get && path == "/v1/admin/keys" {
        let entries = list_admin_key_policies(&kv).await?;
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
        let policy = match request.try_into_policy() {
            Ok(policy) => policy,
            Err(message) => return json_error("invalid_admin_policy", message, 400),
        };
        if let Err(message) = validate_policy_providers(&policy) {
            return json_error("invalid_admin_policy", &message, 400);
        }
        let value = serde_json::to_string(&policy)?;
        kv.put(&format!("keys/{kid}"), value)
            .map_err(|error| Error::RustError(format!("failed to prepare key policy: {error}")))?
            .execute()
            .await
            .map_err(|error| Error::RustError(format!("failed to write key policy: {error}")))?;
        return Response::from_json(&admin_policy_response(&kid, &policy));
    }

    if req.method() == Method::Post {
        let Some(kid) = rest.strip_suffix("/revoke") else {
            return json_error("route_not_found", "route not found", 404);
        };
        let kid = match validate_admin_kid(kid.trim_end_matches('/')) {
            Ok(kid) => kid,
            Err(message) => return json_error("invalid_admin_key", message, 400),
        };
        let Some(record) = kv
            .get(&format!("keys/{kid}"))
            .text()
            .await
            .map_err(|error| Error::RustError(format!("failed to read key policy: {error}")))?
        else {
            return json_error("unknown_proxy_key", "proxy key is not registered", 404);
        };
        let mut policy = serde_json::from_str::<KeyPolicy>(&record)
            .map_err(|error| Error::RustError(format!("key policy is invalid JSON: {error}")))?;
        policy.enabled = false;
        let value = serde_json::to_string(&policy)?;
        kv.put(&format!("keys/{kid}"), value)
            .map_err(|error| Error::RustError(format!("failed to prepare key policy: {error}")))?
            .execute()
            .await
            .map_err(|error| Error::RustError(format!("failed to write key policy: {error}")))?;
        return Response::from_json(&admin_policy_response(&kid, &policy));
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
    let Some((role, tenant_id)) = access_role_for_email(env, &normalized_email).await? else {
        return Ok(None);
    };
    Ok(Some(AccessSession {
        authenticated: true,
        auth: "cloudflare_access",
        role,
        email: normalized_email,
        subject: payload.sub,
        tenant_id,
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
    access_audiences(payload)
        .iter()
        .any(|audience| *audience == expected_aud)
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

async fn access_role_for_email(env: &Env, email: &str) -> Result<Option<(AccessRole, String)>> {
    if let Ok(kv) = env.kv("POLICY_KV") {
        if let Some(record) = kv
            .get(&format!("access/users/{email}"))
            .text()
            .await
            .map_err(|error| Error::RustError(format!("failed to read access user: {error}")))?
        {
            let user = serde_json::from_str::<AccessUserRecord>(&record).map_err(|error| {
                Error::RustError(format!("access user is invalid JSON: {error}"))
            })?;
            if user.enabled.unwrap_or(true) {
                return Ok(Some((
                    user.role,
                    user.tenant_id
                        .filter(|tenant| !tenant.trim().is_empty())
                        .unwrap_or_else(|| default_access_tenant(env)),
                )));
            }
            return Ok(None);
        }
    }
    let role = if csv_env_contains(env, "CLAWROUTER_ACCESS_ADMIN_EMAILS", email)?
        || email_domain_matches(env, email)?
    {
        AccessRole::Admin
    } else {
        AccessRole::User
    };
    Ok(Some((role, default_access_tenant(env))))
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
    let budget = budget_status_for_key(
        env,
        &tenant_id(&auth),
        &auth.kid,
        auth.policy.monthly_budget_micros,
    )
    .await?;
    Response::from_json(&serde_json::json!({
        "key": key_profile_response(&auth),
        "budget": budget
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

impl AdminKeyPolicyRequest {
    fn try_into_policy(self) -> std::result::Result<KeyPolicy, &'static str> {
        if !is_sha256_hex(&self.secret_sha256) {
            return Err("secretSha256 must be a 64-character hex string");
        }
        if self.providers.is_empty() {
            return Err("providers must contain at least one provider id");
        }
        if let Some(value) = self.monthly_budget_micros {
            validate_admin_budget(value, "monthlyBudgetMicros")?;
        }
        if let Some(value) = self.request_cost_micros {
            validate_admin_budget(value, "requestCostMicros")?;
        }
        Ok(KeyPolicy {
            enabled: self.enabled,
            secret_sha256: self.secret_sha256.to_ascii_lowercase(),
            providers: self.providers,
            tenant_id: self.tenant_id,
            monthly_budget_micros: self.monthly_budget_micros,
            request_cost_micros: self.request_cost_micros,
        })
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

fn validate_policy_providers(policy: &KeyPolicy) -> std::result::Result<(), String> {
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

fn admin_policy_response(kid: &str, policy: &KeyPolicy) -> AdminKeyPolicyResponse {
    AdminKeyPolicyResponse {
        kid: kid.to_string(),
        enabled: policy.enabled,
        providers: policy.providers.clone(),
        tenant_id: policy.tenant_id.clone(),
        monthly_budget_micros: policy.monthly_budget_micros,
        request_cost_micros: policy.request_cost_micros,
    }
}

fn key_profile_response(auth: &AuthorizedKey) -> KeyProfileResponse {
    KeyProfileResponse {
        kid: auth.kid.clone(),
        enabled: auth.policy.enabled,
        providers: auth.policy.providers.clone(),
        tenant_id: tenant_id(auth),
        monthly_budget_micros: auth.policy.monthly_budget_micros,
        request_cost_micros: auth.policy.request_cost_micros,
    }
}

fn admin_overview(
    entries: &[AdminKeyPolicyResponse],
    snapshot: &ProviderSnapshot,
) -> AdminOverviewResponse {
    let route_catalog = route_catalog(snapshot);
    AdminOverviewResponse {
        keys_total: entries.len(),
        keys_active: entries.iter().filter(|entry| entry.enabled).count(),
        tenants_total: admin_tenant_summaries(entries).len(),
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
            entries.iter().map(|entry| entry.monthly_budget_micros),
        ),
        request_cost_micros: sum_optional_micros(
            entries.iter().map(|entry| entry.request_cost_micros),
        ),
    }
}

fn admin_tenant_summaries(entries: &[AdminKeyPolicyResponse]) -> Vec<AdminTenantSummary> {
    let mut tenants = BTreeMap::<String, TenantAccumulator>::new();
    for entry in entries {
        let tenant_id = response_tenant_id(entry);
        let summary = tenants.entry(tenant_id).or_default();
        summary.keys += 1;
        if entry.enabled {
            summary.active_keys += 1;
        }
        summary.monthly_budget_micros = summary
            .monthly_budget_micros
            .saturating_add(entry.monthly_budget_micros.unwrap_or_default());
        summary.request_cost_micros = summary
            .request_cost_micros
            .saturating_add(entry.request_cost_micros.unwrap_or_default());
        summary.providers.extend(entry.providers.iter().cloned());
    }
    tenants
        .into_iter()
        .map(|(tenant_id, summary)| AdminTenantSummary {
            tenant_id,
            keys: summary.keys,
            active_keys: summary.active_keys,
            providers: summary.providers.into_iter().collect(),
            monthly_budget_micros: summary.monthly_budget_micros,
            request_cost_micros: summary.request_cost_micros,
        })
        .collect()
}

async fn admin_usage_row(env: &Env, entry: AdminKeyPolicyResponse) -> Result<AdminUsageRow> {
    let tenant_id = response_tenant_id(&entry);
    let budget =
        budget_status_for_key(env, &tenant_id, &entry.kid, entry.monthly_budget_micros).await?;
    Ok(AdminUsageRow {
        kid: entry.kid,
        tenant_id,
        enabled: entry.enabled,
        providers: entry.providers,
        monthly_budget_micros: entry.monthly_budget_micros,
        request_cost_micros: entry.request_cost_micros,
        budget,
    })
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

async fn list_admin_key_policies(kv: &KvStore) -> Result<Vec<AdminKeyPolicyResponse>> {
    let mut entries = Vec::new();
    let mut cursor = None;
    loop {
        let mut request = kv.list().prefix("keys/".to_string()).limit(1000);
        if let Some(next_cursor) = cursor.take() {
            request = request.cursor(next_cursor);
        }
        let list = request
            .execute()
            .await
            .map_err(|error| Error::RustError(format!("failed to list key policies: {error}")))?;
        for key in list.keys {
            let Some(kid) = key.name.strip_prefix("keys/") else {
                continue;
            };
            let Some(record) =
                kv.get(&key.name).text().await.map_err(|error| {
                    Error::RustError(format!("failed to read key policy: {error}"))
                })?
            else {
                continue;
            };
            let policy = serde_json::from_str::<KeyPolicy>(&record).map_err(|error| {
                Error::RustError(format!("key policy is invalid JSON: {error}"))
            })?;
            entries.push(admin_policy_response(kid, &policy));
        }
        if list.list_complete {
            break;
        }
        let Some(next_cursor) = list.cursor else {
            break;
        };
        cursor = Some(next_cursor);
    }
    entries.sort_by(|a, b| a.kid.cmp(&b.kid));
    Ok(entries)
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

fn default_true() -> bool {
    true
}

fn default_oauth_token_type() -> String {
    "Bearer".to_string()
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
    authorize_proxy_key_for_provider(headers, env, Some(provider_id)).await
}

async fn authorize_proxy_key_identity(headers: &Headers, env: &Env) -> Result<AuthOutcome> {
    authorize_proxy_key_for_provider(headers, env, None).await
}

async fn authorize_proxy_key_for_provider(
    headers: &Headers,
    env: &Env,
    provider_id: Option<&str>,
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
    if let Some(provider_id) = provider_id {
        if !policy.providers.is_empty() && !policy.providers.iter().any(|id| id == provider_id) {
            return json_error(
                "provider_not_allowed",
                "proxy key is not allowed to use this provider",
                403,
            )
            .map(AuthOutcome::Denied);
        }
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
        if let Some(model_entry) = provider
            .models
            .iter()
            .find(|entry| entry.id == model && !contains_template(&entry.upstream))
        {
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

fn openai_upstream_url(
    provider: &CompiledProvider,
    endpoint: &CompiledEndpoint,
    env: &Env,
    upstream_model: &str,
) -> std::result::Result<String, OpenAiProxyUrlError> {
    let base = provider.base_urls.get("default").ok_or_else(|| {
        OpenAiProxyUrlError::Runtime(Error::RustError(format!(
            "provider `{}` has no default base URL",
            provider.id
        )))
    })?;
    let base =
        resolve_template_value(provider, base, Some(env)).map_err(OpenAiProxyUrlError::Runtime)?;
    let path = openai_endpoint_path(endpoint, upstream_model)?;
    let mut url = format!("{}{}", base.trim_end_matches('/'), path);
    let query = resolved_template_map(provider, &provider.adapter.inject_query, Some(env))
        .map_err(OpenAiProxyUrlError::Runtime)?;
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
        AuthScheme::Bearer { secret_kind, .. }
        | AuthScheme::ApiKey { secret_kind, .. }
        | AuthScheme::QueryApiKey { secret_kind, .. } => {
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
    if let Some((param, secret)) =
        query_api_key(provider, env).map_err(ManifestProxyError::Runtime)?
    {
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
    body: Option<&'a str>,
}

async fn provider_headers(
    incoming: &Headers,
    env: &Env,
    provider: &CompiledProvider,
    endpoint: &CompiledEndpoint,
    auth: &AuthorizedKey,
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
    for header in &provider.adapter.passthrough_headers {
        if let Some(value) = incoming.get(header).map_err(HeaderBuildError::Runtime)? {
            headers
                .set(header, &value)
                .map_err(HeaderBuildError::Runtime)?;
        }
    }
    apply_auth_headers(&headers, env, provider, auth, context).await?;
    Ok(headers)
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

async fn apply_auth_headers(
    headers: &Headers,
    env: &Env,
    provider: &CompiledProvider,
    auth: &AuthorizedKey,
    context: HeaderRequestContext<'_>,
) -> std::result::Result<(), HeaderBuildError> {
    for scheme in &provider.auth.schemes {
        match scheme {
            AuthScheme::Bearer {
                header,
                format,
                secret_kind,
            } => {
                let secret = provider_secret(env, provider, secret_kind)
                    .map_err(HeaderBuildError::Runtime)?;
                headers
                    .set(header, &format.replace("${secret}", &secret))
                    .map_err(HeaderBuildError::Runtime)?;
                return Ok(());
            }
            AuthScheme::ApiKey {
                header,
                secret_kind,
            } => {
                let secret = provider_secret(env, provider, secret_kind)
                    .map_err(HeaderBuildError::Runtime)?;
                headers
                    .set(header, &secret)
                    .map_err(HeaderBuildError::Runtime)?;
                return Ok(());
            }
            AuthScheme::QueryApiKey { .. } => {
                return Ok(());
            }
            AuthScheme::OAuth {
                provider: oauth_provider,
                token_ref,
                ..
            } => {
                let token = oauth_token(
                    env,
                    provider,
                    auth,
                    oauth_provider.as_deref(),
                    token_ref.as_deref(),
                )
                .await?;
                headers
                    .set(
                        "authorization",
                        &format!(
                            "{} {}",
                            token.token_type,
                            token.access_token.as_deref().unwrap_or_default()
                        ),
                    )
                    .map_err(HeaderBuildError::Runtime)?;
                return Ok(());
            }
            AuthScheme::SigV4 {
                service,
                region_param,
            } => {
                let signed =
                    sigv4_headers(env, provider, service, region_param.as_deref(), context)
                        .map_err(HeaderBuildError::Runtime)?;
                for (name, value) in signed {
                    headers
                        .set(&name, &value)
                        .map_err(HeaderBuildError::Runtime)?;
                }
                return Ok(());
            }
            AuthScheme::CloudflareBinding => return Ok(()),
        }
    }
    Ok(())
}

async fn oauth_token(
    env: &Env,
    provider: &CompiledProvider,
    auth: &AuthorizedKey,
    oauth_provider: Option<&str>,
    token_ref: Option<&str>,
) -> std::result::Result<OAuthTokenRecord, HeaderBuildError> {
    let kv = env.kv("POLICY_KV").map_err(|_| HeaderBuildError::Client {
        code: "policy_store_unavailable",
        message: "POLICY_KV binding is required for OAuth-backed proxy requests",
        status: 503,
    })?;
    for key in oauth_token_keys(provider, auth, oauth_provider, token_ref) {
        let record = kv.get(&key).text().await.map_err(|error| {
            HeaderBuildError::Runtime(Error::RustError(format!(
                "failed to read OAuth token grant: {error}"
            )))
        })?;
        let Some(record) = record else {
            continue;
        };
        let token = parse_oauth_token_record(&record).map_err(HeaderBuildError::Runtime)?;
        if !token.enabled {
            return Err(HeaderBuildError::Client {
                code: "oauth_grant_revoked",
                message: "OAuth grant is revoked for this proxy key",
                status: 403,
            });
        }
        if !token
            .access_token
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
        {
            return Err(HeaderBuildError::Client {
                code: "oauth_grant_invalid",
                message: "OAuth grant is missing an access token",
                status: 403,
            });
        }
        return Ok(token);
    }
    Err(HeaderBuildError::Client {
        code: "oauth_grant_missing",
        message: "OAuth grant is not registered for this proxy key",
        status: 403,
    })
}

fn parse_oauth_token_record(raw: &str) -> Result<OAuthTokenRecord> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(Error::RustError("OAuth token grant is empty".to_string()));
    }
    if !trimmed.starts_with('{') {
        return Ok(OAuthTokenRecord {
            enabled: true,
            access_token: Some(trimmed.to_string()),
            token_type: default_oauth_token_type(),
        });
    }
    serde_json::from_str(trimmed)
        .map_err(|error| Error::RustError(format!("OAuth token grant is invalid JSON: {error}")))
}

fn oauth_token_keys(
    provider: &CompiledProvider,
    auth: &AuthorizedKey,
    oauth_provider: Option<&str>,
    token_ref: Option<&str>,
) -> Vec<String> {
    let mut keys = Vec::new();
    if let Some(token_ref) = token_ref.filter(|value| !value.is_empty()) {
        keys.push(format!("oauth/{}/{}", auth.kid, token_ref));
        if let Some(tenant) = auth
            .policy
            .tenant_id
            .as_deref()
            .filter(|value| !value.is_empty())
        {
            keys.push(format!("oauth/tenants/{tenant}/{token_ref}"));
        }
    }
    if let Some(oauth_provider) = oauth_provider.filter(|value| !value.is_empty()) {
        keys.push(format!("oauth/{}/{}", auth.kid, oauth_provider));
        if let Some(tenant) = auth
            .policy
            .tenant_id
            .as_deref()
            .filter(|value| !value.is_empty())
        {
            keys.push(format!("oauth/tenants/{tenant}/{oauth_provider}"));
        }
    }
    keys.push(format!("oauth/{}/{}", auth.kid, provider.id));
    if let Some(tenant) = auth
        .policy
        .tenant_id
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        keys.push(format!("oauth/tenants/{tenant}/{}", provider.id));
    }
    dedupe_preserving_order(&mut keys);
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
    service: &str,
    region_param: Option<&str>,
    context: HeaderRequestContext<'_>,
) -> Result<BTreeMap<String, String>> {
    let access_key_id = provider_config_value(env, provider, "access_key_id")?;
    let secret_access_key = provider_config_value(env, provider, "secret_access_key")?;
    let region = provider_config_value(env, provider, region_param.unwrap_or("region"))?;
    let session_token = optional_provider_config_value(env, provider, "session_token");
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
    let payload_hash = sha256_hex(context.body.unwrap_or(""));
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

#[derive(Clone, Copy, Debug, Default)]
struct BudgetUsage {
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
    request_id: String,
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
            return budget_status_in_object(&self.state, policy_id, window_key, limit_micros);
        }
        if req.method() != Method::Post || url.path() != "/reserve" {
            return json_error("route_not_found", "route not found", 404);
        }
        let body = req.text().await?;
        let request = serde_json::from_str::<BudgetReserveRequest>(&body).map_err(|error| {
            Error::RustError(format!("budget request is invalid JSON: {error}"))
        })?;
        reserve_budget_in_object(&self.state, request)
    }
}

fn preflight_static_budget(policy: &KeyPolicy) -> Result<Option<Response>> {
    if policy.monthly_budget_micros == Some(0) {
        return json_error("budget_exhausted", "proxy key budget is exhausted", 402).map(Some);
    }
    Ok(None)
}

async fn preflight_budget(
    env: &Env,
    auth: &AuthorizedKey,
    capability: &str,
    request_id: &str,
) -> Result<BudgetPreflight> {
    let Some(limit_micros) = auth.policy.monthly_budget_micros else {
        return Ok(BudgetPreflight::Allowed(BudgetUsage::default()));
    };
    if limit_micros == 0 {
        return json_error("budget_exhausted", "proxy key budget is exhausted", 402)
            .map(BudgetPreflight::Denied);
    }

    let cost_micros = auth.policy.request_cost_micros.unwrap_or(1);
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
    let policy_id = budget_policy_id(&tenant_id, &auth.kid);
    let request = BudgetReserveRequest {
        window_key: current_month_window_key(&policy_id)?,
        policy_id,
        limit_micros,
        cost_micros,
        request_id: request_id.to_string(),
        capability: capability.to_string(),
    };
    let response = reserve_budget(namespace, &tenant_id, &auth.kid, &request).await?;
    if response.allowed {
        return Ok(BudgetPreflight::Allowed(BudgetUsage {
            reserved_cost_micros: response.charged_micros,
            actual_cost_micros: response.charged_micros,
        }));
    }

    json_error("budget_exhausted", "proxy key budget is exhausted", 402)
        .map(BudgetPreflight::Denied)
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
    sql.exec(
        "CREATE TABLE IF NOT EXISTS budget_windows (
            window_key TEXT PRIMARY KEY,
            policy_id TEXT NOT NULL,
            spent_micros INTEGER NOT NULL
        )",
        None,
    )?;
    let spent_micros = sql
        .exec_raw(
            "SELECT spent_micros FROM budget_windows WHERE window_key = ? LIMIT 1",
            raw_bindings(vec![JsValue::from_str(&request.window_key)]),
        )?
        .to_array::<BudgetSpendRow>()?
        .first()
        .map(|row| row.spent_micros.max(0) as u64)
        .unwrap_or_default();
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
    let next_spent_sql = sql_budget_number(next_spent, "spent_micros")?;
    let remaining_after = request.limit_micros.saturating_sub(next_spent);
    sql.exec_raw(
        "INSERT INTO budget_windows (window_key, policy_id, spent_micros)
            VALUES (?, ?, ?)
            ON CONFLICT(window_key) DO UPDATE SET spent_micros = excluded.spent_micros",
        raw_bindings(vec![
            JsValue::from_str(&request.window_key),
            JsValue::from_str(&request.policy_id),
            next_spent_sql.clone(),
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

fn budget_status_in_object(
    state: &State,
    policy_id: String,
    window_key: String,
    limit_micros: u64,
) -> Result<Response> {
    let sql = state.storage().sql();
    sql.exec(
        "CREATE TABLE IF NOT EXISTS budget_windows (
            window_key TEXT PRIMARY KEY,
            policy_id TEXT NOT NULL,
            spent_micros INTEGER NOT NULL
        )",
        None,
    )?;
    let spent_micros = sql
        .exec_raw(
            "SELECT spent_micros FROM budget_windows WHERE window_key = ? LIMIT 1",
            raw_bindings(vec![JsValue::from_str(&window_key)]),
        )?
        .to_array::<BudgetSpendRow>()?
        .first()
        .map(|row| row.spent_micros.max(0) as u64)
        .unwrap_or_default();
    Response::from_json(&BudgetStatusResponse {
        policy_id,
        window_key,
        limit_micros,
        spent_micros,
        remaining_micros: limit_micros.saturating_sub(spent_micros),
    })
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

fn current_month_window_key(policy_id: &str) -> Result<String> {
    let iso: String = js_sys::Date::new_0().to_iso_string().into();
    let month = iso
        .get(0..7)
        .ok_or_else(|| Error::RustError("failed to format budget month".to_string()))?;
    Ok(format!("{policy_id}/{month}"))
}

struct UsageRecord<'a> {
    auth: &'a AuthorizedKey,
    provider: &'a CompiledProvider,
    capability: &'a str,
    model: Option<&'a str>,
    request_id: &'a str,
    budget: BudgetUsage,
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
    event.reserved_cost_micros = record.budget.reserved_cost_micros;
    event.actual_cost_micros = record.budget.actual_cost_micros;
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
    url.push('?');
    url.push_str(&pairs);
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
    let digest = Sha256::digest(input.as_bytes());
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
    matches!(
        path,
        "/v1/health"
            | "/v1/providers"
            | "/v1/routes"
            | "/v1/session"
            | "/v1/me"
            | "/v1/usage"
            | "/v1/key/inspect"
    ) || path.starts_with("/v1/admin/")
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
        .set("access-control-max-age", CORS_MAX_AGE)?;
    Ok(response)
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
        let route = select_model_route(&snapshot, "azure-openai/my-deployment").unwrap();
        assert_eq!(route.provider.id, "azure-openai");
        assert_eq!(route.upstream_model, "my-deployment");
        assert!(select_model_route(&snapshot, "cohere/default").is_none());
        assert!(select_model_route(&snapshot, "cloudflare-ai-gateway/auto").is_none());
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
    }

    #[test]
    fn manifest_proxy_supports_oauth_with_token_refs() {
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
        assert!(supports_manifest_proxy(provider, endpoint));
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

        assert!(openai_routes
            .iter()
            .any(|route| route.get("provider").and_then(Value::as_str) == Some("openai")));
        assert!(manifest_routes.iter().any(|route| {
            route.get("provider").and_then(Value::as_str) == Some("tavily")
                && route.get("endpoint").and_then(Value::as_str) == Some("search")
                && route.get("route").and_then(Value::as_str) == Some("/v1/proxy/tavily/search")
        }));

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
        let policy = KeyPolicy {
            enabled: true,
            secret_sha256: sha256_hex("secret"),
            providers: vec!["openai".to_string()],
            tenant_id: Some("team_docs".to_string()),
            monthly_budget_micros: Some(100),
            request_cost_micros: Some(10),
        };

        assert_eq!(key_verification("secret", &policy), "verified");
        assert_eq!(key_verification("wrong", &policy), "invalid_secret");
        assert!(inspect_policy_for_response("verified", &policy).is_some());
        assert!(inspect_policy_for_response("invalid_secret", &policy).is_none());
        assert_eq!(policy.request_cost_micros, Some(10));
    }

    #[test]
    fn admin_policy_validation_accepts_known_provider_hashes() {
        let request = AdminKeyPolicyRequest {
            enabled: true,
            secret_sha256: sha256_hex("secret"),
            providers: vec!["openai".to_string(), "tavily".to_string()],
            tenant_id: Some("team_docs".to_string()),
            monthly_budget_micros: Some(100),
            request_cost_micros: Some(10),
        };
        let policy = request.try_into_policy().unwrap();
        validate_policy_providers(&policy).unwrap();
        let response = admin_policy_response("svc_docs", &policy);
        assert_eq!(response.kid, "svc_docs");
        assert!(response.enabled);
        assert_eq!(response.providers, vec!["openai", "tavily"]);
        assert_eq!(response.monthly_budget_micros, Some(100));
        assert_eq!(response.request_cost_micros, Some(10));
    }

    #[test]
    fn admin_overview_and_tenants_are_derived_from_key_policies() {
        let entries = vec![
            AdminKeyPolicyResponse {
                kid: "svc_docs".to_string(),
                enabled: true,
                providers: vec!["openai".to_string(), "tavily".to_string()],
                tenant_id: Some("team_docs".to_string()),
                monthly_budget_micros: Some(100),
                request_cost_micros: Some(10),
            },
            AdminKeyPolicyResponse {
                kid: "svc_ops".to_string(),
                enabled: false,
                providers: vec!["openai".to_string()],
                tenant_id: Some("team_docs".to_string()),
                monthly_budget_micros: Some(200),
                request_cost_micros: None,
            },
            AdminKeyPolicyResponse {
                kid: "svc_default".to_string(),
                enabled: true,
                providers: vec!["github".to_string()],
                tenant_id: None,
                monthly_budget_micros: None,
                request_cost_micros: Some(5),
            },
        ];
        let tenants = admin_tenant_summaries(&entries);
        let docs = tenants
            .iter()
            .find(|tenant| tenant.tenant_id == "team_docs")
            .unwrap();
        assert_eq!(docs.keys, 2);
        assert_eq!(docs.active_keys, 1);
        assert_eq!(docs.providers, vec!["openai", "tavily"]);
        assert_eq!(docs.monthly_budget_micros, 300);

        let overview = admin_overview(&entries, &provider_snapshot().unwrap());
        assert_eq!(overview.keys_total, 3);
        assert_eq!(overview.keys_active, 2);
        assert_eq!(overview.tenants_total, 2);
        assert_eq!(overview.monthly_budget_micros, 300);
        assert_eq!(overview.request_cost_micros, 15);
    }

    #[test]
    fn admin_policy_validation_rejects_bad_hashes_and_unknown_providers() {
        let bad_hash = AdminKeyPolicyRequest {
            enabled: true,
            secret_sha256: "not-a-hash".to_string(),
            providers: vec!["openai".to_string()],
            tenant_id: None,
            monthly_budget_micros: None,
            request_cost_micros: None,
        };
        assert_eq!(
            bad_hash.try_into_policy().unwrap_err(),
            "secretSha256 must be a 64-character hex string"
        );

        let no_providers = AdminKeyPolicyRequest {
            enabled: true,
            secret_sha256: sha256_hex("secret"),
            providers: Vec::new(),
            tenant_id: None,
            monthly_budget_micros: None,
            request_cost_micros: None,
        };
        assert_eq!(
            no_providers.try_into_policy().unwrap_err(),
            "providers must contain at least one provider id"
        );

        let unknown_provider = KeyPolicy {
            enabled: true,
            secret_sha256: sha256_hex("secret"),
            providers: vec!["not-real".to_string()],
            tenant_id: None,
            monthly_budget_micros: None,
            request_cost_micros: None,
        };
        assert_eq!(
            validate_policy_providers(&unknown_provider).unwrap_err(),
            "unknown provider `not-real`"
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
    fn cors_policy_allows_admin_browser_clients() {
        assert_eq!(CORS_ALLOW_ORIGIN, "*");
        assert_eq!(CORS_ALLOW_METHODS, "GET,POST,PUT,OPTIONS");
        assert!(CORS_ALLOW_HEADERS.contains("authorization"));
        assert!(CORS_ALLOW_HEADERS.contains("content-type"));
        assert!(cors_enabled_path("/v1/admin/keys"));
        assert!(cors_enabled_path("/v1/providers"));
        assert!(cors_enabled_path("/v1/routes"));
        assert!(cors_enabled_path("/v1/session"));
        assert!(cors_enabled_path("/v1/me"));
        assert!(cors_enabled_path("/v1/usage"));
        assert!(!cors_enabled_path("/v1/chat/completions"));
        assert!(!cors_enabled_path("/v1/proxy/tavily/search"));
    }

    #[test]
    fn interface_routes_use_the_embedded_shell() {
        assert!(interface_path("/dashboard"));
        assert!(interface_path("/admin"));
        assert!(interface_path("/account"));
        assert!(interface_path("/routes"));
        assert!(!interface_path("/v1/admin/keys"));
    }

    #[test]
    fn api_aliases_map_to_canonical_v1_routes() {
        assert_eq!(canonical_api_path("/api/route"), "/v1/routes");
        assert_eq!(canonical_api_path("/api/routes"), "/v1/routes");
        assert_eq!(canonical_api_path("/api/session"), "/v1/session");
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
            iss: None,
            nbf: None,
            sub: None,
        };
        assert_eq!(access_audiences(&payload), vec!["first", "second"]);
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
    fn manifest_proxy_encodes_declared_relative_path_params() {
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
        let url = manifest_upstream_url(provider, endpoint, &proxy, None).unwrap();
        assert_eq!(url, "https://api.github.com/repos/openclaw/clawrouter");
    }

    #[test]
    fn manifest_proxy_rejects_relative_paths_that_escape() {
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
                Value::String("repos/../secrets".to_string()),
            )]),
            ..ManifestProxyRequest::default()
        };
        let error = manifest_upstream_url(provider, endpoint, &proxy, None).unwrap_err();
        match error {
            ManifestProxyError::Client(message) => {
                assert!(message.contains("safe relative path"));
            }
            ManifestProxyError::Runtime(_) => panic!("expected client error"),
        }
    }

    #[test]
    fn oauth_token_keys_prefer_key_token_ref_before_fallbacks() {
        let snapshot = provider_snapshot().unwrap();
        let provider = snapshot
            .providers
            .iter()
            .find(|provider| provider.id == "github")
            .unwrap();
        let auth = AuthorizedKey {
            kid: "svc_docs".to_string(),
            policy: KeyPolicy {
                enabled: true,
                secret_sha256: sha256_hex("secret"),
                providers: vec!["github".to_string()],
                tenant_id: Some("team_docs".to_string()),
                monthly_budget_micros: None,
                request_cost_micros: None,
            },
        };

        assert_eq!(
            oauth_token_keys(
                provider,
                &auth,
                Some("github"),
                Some("oauth.github.access_token")
            ),
            vec![
                "oauth/svc_docs/oauth.github.access_token",
                "oauth/tenants/team_docs/oauth.github.access_token",
                "oauth/svc_docs/github",
                "oauth/tenants/team_docs/github",
            ]
        );
    }

    #[test]
    fn oauth_token_records_accept_json_or_raw_tokens() {
        let json = parse_oauth_token_record(
            r#"{"enabled":true,"accessToken":"gho_test","tokenType":"Bearer"}"#,
        )
        .unwrap();
        assert_eq!(json.access_token.as_deref(), Some("gho_test"));
        assert_eq!(json.token_type, "Bearer");

        let raw = parse_oauth_token_record("xoxb-test").unwrap();
        assert_eq!(raw.access_token.as_deref(), Some("xoxb-test"));
        assert_eq!(raw.token_type, "Bearer");
        let tombstone =
            parse_oauth_token_record(r#"{"enabled":false,"tokenType":"Bearer"}"#).unwrap();
        assert!(!tombstone.enabled);
        assert_eq!(tombstone.access_token, None);
        assert!(parse_oauth_token_record("   ").is_err());
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
            body: Some(r#"{"inputText":"ok"}"#),
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
    fn usage_event_ids_include_a_sequence_component() {
        let first = next_usage_event_sequence();
        let second = next_usage_event_sequence();
        assert_ne!(first, second);
    }
}
