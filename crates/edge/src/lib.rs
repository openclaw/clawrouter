use clawrouter_core::parse_proxy_key;
use worker::*;

const PROVIDER_SNAPSHOT: &str = include_str!(concat!(env!("OUT_DIR"), "/provider-snapshot.json"));

#[event(fetch)]
async fn fetch(req: Request, _env: Env, _ctx: Context) -> Result<Response> {
    let url = req.url()?;
    if req.method() == Method::Get && url.path() == "/v1/health" {
        return Response::from_json(&serde_json::json!({
            "ok": true,
            "service": "clawrouter-edge",
            "runtime": "rust-wasm"
        }));
    }

    if req.method() == Method::Get && url.path() == "/v1/providers" {
        let snapshot = serde_json::from_str::<serde_json::Value>(PROVIDER_SNAPSHOT)?;
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

    Response::from_json(&serde_json::json!({
        "error": {
            "code": "route_not_found",
            "message": "route not found"
        }
    }))
    .map(|resp| resp.with_status(404))
}
