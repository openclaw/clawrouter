use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UsageStatus {
    Success,
    ProviderError,
    ClientError,
    Denied,
    Timeout,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UsageEvent {
    pub id: String,
    #[serde(rename = "type")]
    pub event_type: String,
    #[serde(default)]
    pub occurred_at_ms: u64,
    pub tenant_id: String,
    #[serde(default)]
    pub policy_id: String,
    #[serde(default)]
    pub credential_id: Option<String>,
    #[serde(default)]
    pub principal_id: Option<String>,
    #[serde(default)]
    pub auth_type: String,
    #[serde(default)]
    pub key_id: String,
    pub request_id: String,
    pub provider: String,
    pub capability: String,
    pub model: Option<String>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
    pub reserved_cost_micros: u64,
    pub actual_cost_micros: u64,
    #[serde(default)]
    pub status_code: Option<u16>,
    #[serde(default)]
    pub duration_ms: Option<u64>,
    pub status: UsageStatus,
}

impl UsageEvent {
    pub fn new_success(
        id: impl Into<String>,
        tenant_id: impl Into<String>,
        key_id: impl Into<String>,
        request_id: impl Into<String>,
        provider: impl Into<String>,
        capability: impl Into<String>,
    ) -> Self {
        Self {
            id: id.into(),
            event_type: "clawrouter.usage.v1".to_string(),
            occurred_at_ms: 0,
            tenant_id: tenant_id.into(),
            policy_id: String::new(),
            credential_id: None,
            principal_id: None,
            auth_type: String::new(),
            key_id: key_id.into(),
            request_id: request_id.into(),
            provider: provider.into(),
            capability: capability.into(),
            model: None,
            input_tokens: None,
            output_tokens: None,
            total_tokens: None,
            reserved_cost_micros: 0,
            actual_cost_micros: 0,
            status_code: None,
            duration_ms: None,
            status: UsageStatus::Success,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_usage_events_deserialize_with_audit_defaults() {
        let event = serde_json::from_value::<UsageEvent>(serde_json::json!({
            "id": "usage_1",
            "type": "clawrouter.usage.v1",
            "tenant_id": "default",
            "key_id": "legacy_key",
            "request_id": "req_1",
            "provider": "openai",
            "capability": "llm.chat",
            "model": null,
            "input_tokens": null,
            "output_tokens": null,
            "total_tokens": null,
            "reserved_cost_micros": 1,
            "actual_cost_micros": 1,
            "status": "success"
        }))
        .expect("legacy usage event");

        assert_eq!(event.occurred_at_ms, 0);
        assert!(event.policy_id.is_empty());
        assert!(event.credential_id.is_none());
        assert!(event.principal_id.is_none());
        assert!(event.auth_type.is_empty());
        assert!(event.status_code.is_none());
        assert!(event.duration_ms.is_none());
    }

    #[test]
    fn new_usage_events_include_audit_fields() {
        let mut event = UsageEvent::new_success(
            "usage_1",
            "openclaw",
            "credential_1",
            "req_1",
            "openai",
            "llm.chat",
        );
        event.occurred_at_ms = 1;
        event.policy_id = "maintainers".to_string();
        event.credential_id = Some("credential_1".to_string());
        event.principal_id = Some("maintainer@example.com".to_string());
        event.auth_type = "access".to_string();
        event.status_code = Some(200);
        event.duration_ms = Some(42);

        let encoded = serde_json::to_value(&event).expect("usage event JSON");
        assert_eq!(encoded["policy_id"], "maintainers");
        assert_eq!(encoded["principal_id"], "maintainer@example.com");
        assert_eq!(encoded["status_code"], 200);
        assert_eq!(encoded["duration_ms"], 42);
    }
}
