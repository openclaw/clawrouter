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
    pub tenant_id: String,
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
            tenant_id: tenant_id.into(),
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
            status: UsageStatus::Success,
        }
    }
}
