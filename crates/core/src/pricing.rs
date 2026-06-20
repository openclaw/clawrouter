use serde::{Deserialize, Serialize};
use serde_json::Value;

const TOKENS_PER_MILLION: u64 = 1_000_000;

fn default_input_token_overhead() -> u64 {
    1_024
}

/// Versioned public list pricing for one model.
///
/// Values are micro-US-dollars per one million tokens. Keeping all arithmetic
/// integral lets the budget authority reserve and settle without floating-point
/// drift.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelPricing {
    pub effective_at: String,
    pub source: String,
    pub input_micros_per_million: u64,
    pub output_micros_per_million: u64,
    #[serde(default)]
    pub cached_input_micros_per_million: Option<u64>,
    #[serde(default)]
    pub cache_write_5m_input_micros_per_million: Option<u64>,
    #[serde(default)]
    pub cache_write_1h_input_micros_per_million: Option<u64>,
    pub max_input_tokens: u64,
    #[serde(default)]
    pub max_request_input_tokens: Option<u64>,
    pub default_max_output_tokens: u64,
    #[serde(default = "default_input_token_overhead")]
    pub input_token_overhead: u64,
    #[serde(default)]
    pub long_context: Option<LongContextPricing>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LongContextPricing {
    pub threshold_input_tokens: u64,
    pub input_micros_per_million: u64,
    pub output_micros_per_million: u64,
    #[serde(default)]
    pub cached_input_micros_per_million: Option<u64>,
    #[serde(default)]
    pub cache_write_5m_input_micros_per_million: Option<u64>,
    #[serde(default)]
    pub cache_write_1h_input_micros_per_million: Option<u64>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PricedTokenUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cached_input_tokens: u64,
    pub cache_write_5m_input_tokens: u64,
    pub cache_write_1h_input_tokens: u64,
    /// Cache-write tokens reported without a TTL-specific breakdown.
    pub cache_write_input_tokens: u64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RequestCostEstimate {
    pub input_tokens_upper_bound: u64,
    pub output_tokens_upper_bound: u64,
    pub reserved_cost_micros: u64,
}

#[derive(Clone, Copy)]
struct EffectiveRates {
    input: u64,
    output: u64,
    cached_input: Option<u64>,
    cache_write_5m_input: Option<u64>,
    cache_write_1h_input: Option<u64>,
}

impl ModelPricing {
    pub fn estimate_request_cost(
        &self,
        request_body: &[u8],
        request_json: Option<&Value>,
    ) -> RequestCostEstimate {
        // Byte length is a conservative upper bound for byte-level tokenizers.
        // The fixed overhead covers provider-added message framing and special
        // tokens that do not appear in the serialized request.
        let serialized_input_upper_bound =
            (request_body.len() as u64).saturating_add(self.input_token_overhead);
        let request_input_limit = self
            .max_request_input_tokens
            .unwrap_or(self.max_input_tokens);
        let input_tokens_upper_bound = if request_json.is_some_and(request_has_unbounded_input) {
            request_input_limit
        } else {
            serialized_input_upper_bound.min(request_input_limit)
        };
        let output_tokens_upper_bound = request_json
            .and_then(request_max_output_tokens)
            .unwrap_or(self.default_max_output_tokens)
            .saturating_mul(request_json.map(request_choice_count).unwrap_or(1));
        let rates = self.reservation_rates_for_input_tokens(input_tokens_upper_bound);
        let input_rate = self.reservation_input_rate(request_json, rates);
        let reserved_cost_micros = token_cost_micros(input_tokens_upper_bound, input_rate)
            .saturating_add(token_cost_micros(output_tokens_upper_bound, rates.output));
        RequestCostEstimate {
            input_tokens_upper_bound,
            output_tokens_upper_bound,
            reserved_cost_micros,
        }
    }

    pub fn actual_cost_micros(&self, usage: PricedTokenUsage) -> u64 {
        let rates = self.rates_for_input_tokens(usage.input_tokens);
        let cached_input_tokens = usage.cached_input_tokens.min(usage.input_tokens);
        let remaining_after_cache_read = usage.input_tokens.saturating_sub(cached_input_tokens);
        let cache_write_5m_input_tokens = usage
            .cache_write_5m_input_tokens
            .min(remaining_after_cache_read);
        let remaining_after_5m =
            remaining_after_cache_read.saturating_sub(cache_write_5m_input_tokens);
        let cache_write_1h_input_tokens = usage.cache_write_1h_input_tokens.min(remaining_after_5m);
        let remaining_after_1h = remaining_after_5m.saturating_sub(cache_write_1h_input_tokens);
        let cache_write_input_tokens = usage.cache_write_input_tokens.min(remaining_after_1h);
        let standard_input_tokens = remaining_after_1h.saturating_sub(cache_write_input_tokens);

        let cached_rate = rates.cached_input.unwrap_or(rates.input);
        let cache_write_5m_rate = rates.cache_write_5m_input.unwrap_or(rates.input);
        let cache_write_1h_rate = rates.cache_write_1h_input.unwrap_or(cache_write_5m_rate);
        let unknown_cache_write_rate = cache_write_5m_rate.max(cache_write_1h_rate);

        weighted_token_cost_micros([
            (standard_input_tokens, rates.input),
            (cached_input_tokens, cached_rate),
            (cache_write_5m_input_tokens, cache_write_5m_rate),
            (cache_write_1h_input_tokens, cache_write_1h_rate),
            (cache_write_input_tokens, unknown_cache_write_rate),
        ])
        .saturating_add(token_cost_micros(usage.output_tokens, rates.output))
    }

    pub fn output_tokens_are_billable(&self, input_tokens: u64) -> bool {
        self.rates_for_input_tokens(input_tokens).output > 0
    }

    fn rates_for_input_tokens(&self, input_tokens: u64) -> EffectiveRates {
        if let Some(long_context) = self
            .long_context
            .as_ref()
            .filter(|long_context| input_tokens > long_context.threshold_input_tokens)
        {
            return EffectiveRates {
                input: long_context.input_micros_per_million,
                output: long_context.output_micros_per_million,
                cached_input: long_context.cached_input_micros_per_million,
                cache_write_5m_input: long_context.cache_write_5m_input_micros_per_million,
                cache_write_1h_input: long_context.cache_write_1h_input_micros_per_million,
            };
        }
        EffectiveRates {
            input: self.input_micros_per_million,
            output: self.output_micros_per_million,
            cached_input: self.cached_input_micros_per_million,
            cache_write_5m_input: self.cache_write_5m_input_micros_per_million,
            cache_write_1h_input: self.cache_write_1h_input_micros_per_million,
        }
    }

    fn reservation_rates_for_input_tokens(&self, input_tokens: u64) -> EffectiveRates {
        let base = self.rates_for_input_tokens(0);
        let Some(long_context) = self
            .long_context
            .as_ref()
            .filter(|long_context| input_tokens > long_context.threshold_input_tokens)
        else {
            return base;
        };
        let long = EffectiveRates {
            input: long_context.input_micros_per_million,
            output: long_context.output_micros_per_million,
            cached_input: long_context.cached_input_micros_per_million,
            cache_write_5m_input: long_context.cache_write_5m_input_micros_per_million,
            cache_write_1h_input: long_context.cache_write_1h_input_micros_per_million,
        };
        EffectiveRates {
            input: base.input.max(long.input),
            output: base.output.max(long.output),
            cached_input: max_optional_rate(base.cached_input, long.cached_input),
            cache_write_5m_input: max_optional_rate(
                base.cache_write_5m_input,
                long.cache_write_5m_input,
            ),
            cache_write_1h_input: max_optional_rate(
                base.cache_write_1h_input,
                long.cache_write_1h_input,
            ),
        }
    }

    fn reservation_input_rate(&self, request_json: Option<&Value>, rates: EffectiveRates) -> u64 {
        // Cache reads may be applied automatically by the provider, so their
        // rate must always participate in the reservation upper bound.
        let input_rate = rates.input.max(rates.cached_input.unwrap_or(rates.input));
        let Some(request_json) = request_json else {
            return input_rate;
        };
        if json_has_cache_ttl(request_json, "1h") {
            return input_rate.max(rates.cache_write_1h_input.unwrap_or(rates.input));
        }
        if json_has_key(request_json, "cache_control") {
            return input_rate.max(rates.cache_write_5m_input.unwrap_or(rates.input));
        }
        input_rate
    }
}

fn max_optional_rate(left: Option<u64>, right: Option<u64>) -> Option<u64> {
    match (left, right) {
        (Some(left), Some(right)) => Some(left.max(right)),
        (Some(value), None) | (None, Some(value)) => Some(value),
        (None, None) => None,
    }
}

fn request_max_output_tokens(value: &Value) -> Option<u64> {
    ["max_output_tokens", "max_completion_tokens", "max_tokens"]
        .into_iter()
        .filter_map(|field| value.get(field).and_then(Value::as_u64))
        .max()
}

fn request_choice_count(value: &Value) -> u64 {
    value.get("n").and_then(Value::as_u64).unwrap_or(1).max(1)
}

fn json_has_key(value: &Value, target: &str) -> bool {
    match value {
        Value::Object(values) => {
            values.contains_key(target) || values.values().any(|value| json_has_key(value, target))
        }
        Value::Array(values) => values.iter().any(|value| json_has_key(value, target)),
        _ => false,
    }
}

fn json_has_cache_ttl(value: &Value, ttl: &str) -> bool {
    match value {
        Value::Object(values) => {
            values
                .get("cache_control")
                .and_then(Value::as_object)
                .and_then(|cache| cache.get("ttl"))
                .and_then(Value::as_str)
                == Some(ttl)
                || values.values().any(|value| json_has_cache_ttl(value, ttl))
        }
        Value::Array(values) => values.iter().any(|value| json_has_cache_ttl(value, ttl)),
        _ => false,
    }
}

fn request_has_unbounded_input(value: &Value) -> bool {
    let Some(request) = value.as_object() else {
        return false;
    };
    ["previous_response_id", "conversation", "prompt"]
        .into_iter()
        .any(|field| request.get(field).is_some_and(|value| !value.is_null()))
        || request
            .get("input")
            .is_some_and(content_has_unbounded_input)
        || request
            .get("messages")
            .and_then(Value::as_array)
            .is_some_and(|messages| {
                messages.iter().any(|message| {
                    message
                        .get("content")
                        .is_some_and(content_has_unbounded_input)
                })
            })
        || request
            .get("tools")
            .and_then(Value::as_array)
            .is_some_and(|tools| tools.iter().any(tool_has_provider_added_tokens))
}

fn tool_has_provider_added_tokens(tool: &Value) -> bool {
    tool.get("type")
        .and_then(Value::as_str)
        .is_some_and(|kind| {
            kind.starts_with("web_fetch_")
                || ["bash_", "text_editor_", "computer_", "memory_"]
                    .iter()
                    .any(|prefix| kind.starts_with(prefix))
        })
}

fn content_has_unbounded_input(value: &Value) -> bool {
    match value {
        Value::Object(values) => {
            values
                .get("type")
                .and_then(Value::as_str)
                .is_some_and(|kind| {
                    matches!(
                        kind,
                        "image"
                            | "image_url"
                            | "document"
                            | "file"
                            | "input_image"
                            | "input_file"
                            | "item_reference"
                            | "computer_screenshot"
                    )
                })
                || values.contains_key("image_url")
                || values.contains_key("file_id")
                || values.values().any(content_has_unbounded_input)
        }
        Value::Array(values) => values.iter().any(content_has_unbounded_input),
        _ => false,
    }
}

fn token_cost_micros(tokens: u64, micros_per_million: u64) -> u64 {
    weighted_token_cost_micros([(tokens, micros_per_million)])
}

fn weighted_token_cost_micros<const N: usize>(components: [(u64, u64); N]) -> u64 {
    let numerator = components
        .into_iter()
        .fold(0_u128, |total, (tokens, rate)| {
            total.saturating_add((tokens as u128).saturating_mul(rate as u128))
        });
    if numerator == 0 {
        return 0;
    }
    let rounded =
        numerator.saturating_add((TOKENS_PER_MILLION - 1) as u128) / TOKENS_PER_MILLION as u128;
    rounded.min(u64::MAX as u128) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pricing() -> ModelPricing {
        ModelPricing {
            effective_at: "2026-06-19".to_string(),
            source: "https://example.com/pricing".to_string(),
            input_micros_per_million: 2_500_000,
            output_micros_per_million: 15_000_000,
            cached_input_micros_per_million: Some(250_000),
            cache_write_5m_input_micros_per_million: Some(3_125_000),
            cache_write_1h_input_micros_per_million: Some(5_000_000),
            max_input_tokens: 1_050_000,
            max_request_input_tokens: None,
            default_max_output_tokens: 128_000,
            input_token_overhead: 1_024,
            long_context: None,
        }
    }

    #[test]
    fn reserves_conservative_input_and_requested_output() {
        let body = br#"{"model":"openai/gpt-5.4","input":"hello","max_output_tokens":2000}"#;
        let json: Value = serde_json::from_slice(body).unwrap();
        let estimate = pricing().estimate_request_cost(body, Some(&json));
        assert_eq!(estimate.input_tokens_upper_bound, body.len() as u64 + 1_024);
        assert_eq!(estimate.output_tokens_upper_bound, 2_000);
        assert!(estimate.reserved_cost_micros > 30_000);
    }

    #[test]
    fn absent_output_limit_uses_the_model_maximum() {
        let body = br#"{"model":"openai/gpt-5.4","input":"hello"}"#;
        let json: Value = serde_json::from_slice(body).unwrap();
        let estimate = pricing().estimate_request_cost(body, Some(&json));
        assert_eq!(estimate.output_tokens_upper_bound, 128_000);
    }

    #[test]
    fn cache_write_reservation_uses_the_declared_ttl_rate() {
        let body = br#"{"cache_control":{"type":"ephemeral","ttl":"1h"},"max_tokens":1}"#;
        let json: Value = serde_json::from_slice(body).unwrap();
        let estimate = pricing().estimate_request_cost(body, Some(&json));
        let standard = token_cost_micros(
            estimate.input_tokens_upper_bound,
            pricing().input_micros_per_million,
        )
        .saturating_add(token_cost_micros(1, pricing().output_micros_per_million));
        assert!(estimate.reserved_cost_micros > standard);
    }

    #[test]
    fn automatic_cache_reads_cannot_settle_above_the_reservation() {
        let mut pricing = pricing();
        pricing.cached_input_micros_per_million = Some(30_000_000);
        let body = br#"{"input":"hello","max_output_tokens":1}"#;
        let json: Value = serde_json::from_slice(body).unwrap();
        let estimate = pricing.estimate_request_cost(body, Some(&json));
        let actual = pricing.actual_cost_micros(PricedTokenUsage {
            input_tokens: estimate.input_tokens_upper_bound,
            output_tokens: 1,
            cached_input_tokens: estimate.input_tokens_upper_bound,
            ..PricedTokenUsage::default()
        });
        assert!(actual <= estimate.reserved_cost_micros);
    }

    #[test]
    fn file_and_image_inputs_reserve_the_full_input_window() {
        let body = br#"{"input":[{"type":"input_image","image_url":"https://example.com/image.png"}],"max_output_tokens":1}"#;
        let json: Value = serde_json::from_slice(body).unwrap();
        let estimate = pricing().estimate_request_cost(body, Some(&json));
        assert_eq!(estimate.input_tokens_upper_bound, 1_050_000);
    }

    #[test]
    fn opaque_inputs_never_reserve_above_the_model_input_window() {
        let request = serde_json::json!({
            "input": [{
                "type": "input_image",
                "image_url": format!("data:image/png;base64,{}", "a".repeat(1_100_000))
            }],
            "max_output_tokens": 1
        });
        let body = serde_json::to_vec(&request).unwrap();
        assert!(body.len() as u64 > pricing().max_input_tokens);
        let estimate = pricing().estimate_request_cost(&body, Some(&request));
        assert_eq!(estimate.input_tokens_upper_bound, 1_050_000);
    }

    #[test]
    fn textual_inputs_never_reserve_above_the_model_input_window() {
        let request = serde_json::json!({
            "input": "a".repeat(1_100_000),
            "max_output_tokens": 1
        });
        let body = serde_json::to_vec(&request).unwrap();
        assert!(body.len() as u64 > pricing().max_input_tokens);
        let estimate = pricing().estimate_request_cost(&body, Some(&request));
        assert_eq!(estimate.input_tokens_upper_bound, 1_050_000);
    }

    #[test]
    fn tool_schema_file_fields_do_not_reserve_the_full_input_window() {
        let body = br#"{"input":"hello","tools":[{"type":"function","parameters":{"properties":{"file_id":{"type":"string"}}}}],"max_output_tokens":1}"#;
        let json: Value = serde_json::from_slice(body).unwrap();
        let estimate = pricing().estimate_request_cost(body, Some(&json));
        assert_eq!(estimate.input_tokens_upper_bound, body.len() as u64 + 1_024);
    }

    #[test]
    fn provider_added_tools_reserve_the_full_input_window() {
        for tool_type in [
            "bash_20250124",
            "text_editor_20250728",
            "computer_20250124",
            "memory_20250818",
            "web_fetch_20250910",
        ] {
            let request = serde_json::json!({
                "tools": [{"type": tool_type, "name": "client_tool"}],
                "max_tokens": 1
            });
            let body = serde_json::to_vec(&request).unwrap();
            let estimate = pricing().estimate_request_cost(&body, Some(&request));
            assert_eq!(estimate.input_tokens_upper_bound, 1_050_000);
        }
    }

    #[test]
    fn server_side_context_references_reserve_the_full_input_window() {
        for request in [
            serde_json::json!({"input": "hello", "previous_response_id": "resp_1"}),
            serde_json::json!({"input": "hello", "conversation": {"id": "conv_1"}}),
            serde_json::json!({"input": "hello", "prompt": {"id": "pmpt_1"}}),
            serde_json::json!({"input": [{"type": "item_reference", "id": "item_1"}]}),
        ] {
            let body = serde_json::to_vec(&request).unwrap();
            let estimate = pricing().estimate_request_cost(&body, Some(&request));
            assert_eq!(estimate.input_tokens_upper_bound, 1_050_000);
        }
    }

    #[test]
    fn output_reservation_covers_multiple_chat_choices() {
        let body = br#"{"messages":[{"role":"user","content":"hello"}],"max_completion_tokens":1000,"n":4}"#;
        let json: Value = serde_json::from_slice(body).unwrap();
        let estimate = pricing().estimate_request_cost(body, Some(&json));
        assert_eq!(estimate.output_tokens_upper_bound, 4_000);
    }

    #[test]
    fn output_reservation_uses_the_largest_supplied_limit_alias() {
        let body = br#"{"max_output_tokens":100,"max_completion_tokens":3000,"max_tokens":2000}"#;
        let json: Value = serde_json::from_slice(body).unwrap();
        let estimate = pricing().estimate_request_cost(body, Some(&json));
        assert_eq!(estimate.output_tokens_upper_bound, 3_000);
    }

    #[test]
    fn long_context_rates_cover_reservation_and_settlement() {
        let mut pricing = pricing();
        pricing.long_context = Some(LongContextPricing {
            threshold_input_tokens: 10_000,
            input_micros_per_million: 5_000_000,
            output_micros_per_million: 22_500_000,
            cached_input_micros_per_million: Some(500_000),
            cache_write_5m_input_micros_per_million: None,
            cache_write_1h_input_micros_per_million: None,
        });
        let body = vec![b'x'; 10_001];
        let request = serde_json::json!({"max_output_tokens": 1_000});
        let estimate = pricing.estimate_request_cost(&body, Some(&request));
        let actual = pricing.actual_cost_micros(PricedTokenUsage {
            input_tokens: 10_001,
            output_tokens: 1_000,
            ..PricedTokenUsage::default()
        });
        assert_eq!(actual, 72_505);
        assert!(actual <= estimate.reserved_cost_micros);
    }

    #[test]
    fn reservation_covers_both_sides_of_a_discounted_long_context_tier() {
        let mut pricing = pricing();
        pricing.long_context = Some(LongContextPricing {
            threshold_input_tokens: 10_000,
            input_micros_per_million: 1_000_000,
            output_micros_per_million: 2_000_000,
            cached_input_micros_per_million: Some(100_000),
            cache_write_5m_input_micros_per_million: None,
            cache_write_1h_input_micros_per_million: None,
        });
        let body = vec![b'x'; 10_001];
        let request = serde_json::json!({"max_output_tokens": 1_000});
        let estimate = pricing.estimate_request_cost(&body, Some(&request));
        for input_tokens in [9_999, 10_001] {
            let actual = pricing.actual_cost_micros(PricedTokenUsage {
                input_tokens,
                output_tokens: 1_000,
                ..PricedTokenUsage::default()
            });
            assert!(actual <= estimate.reserved_cost_micros);
        }
    }

    #[test]
    fn batched_inputs_reserve_the_request_level_token_limit() {
        let mut pricing = pricing();
        pricing.max_input_tokens = 8_192;
        pricing.max_request_input_tokens = Some(300_000);
        let request = serde_json::json!({"input": [{"type": "input_file", "file_id": "file_1"}]});
        let body = serde_json::to_vec(&request).unwrap();
        let estimate = pricing.estimate_request_cost(&body, Some(&request));
        assert_eq!(estimate.input_tokens_upper_bound, 300_000);
    }

    #[test]
    fn actual_cost_applies_cache_read_and_write_rates() {
        let usage = PricedTokenUsage {
            input_tokens: 1_000_000,
            output_tokens: 100_000,
            cached_input_tokens: 200_000,
            cache_write_5m_input_tokens: 100_000,
            cache_write_1h_input_tokens: 100_000,
            cache_write_input_tokens: 0,
        };
        assert_eq!(pricing().actual_cost_micros(usage), 3_862_500);
    }

    #[test]
    fn categorized_input_rounding_stays_within_the_aggregate_reservation() {
        let mut pricing = pricing();
        pricing.input_micros_per_million = 1;
        pricing.cached_input_micros_per_million = Some(1);
        pricing.cache_write_5m_input_micros_per_million = Some(1);
        pricing.cache_write_1h_input_micros_per_million = Some(1);
        pricing.output_micros_per_million = 0;
        pricing.default_max_output_tokens = 0;
        pricing.input_token_overhead = 0;
        let body = vec![b'x'; 5];
        let estimate = pricing.estimate_request_cost(&body, None);
        let actual = pricing.actual_cost_micros(PricedTokenUsage {
            input_tokens: 5,
            cached_input_tokens: 1,
            cache_write_5m_input_tokens: 1,
            cache_write_1h_input_tokens: 1,
            cache_write_input_tokens: 1,
            ..PricedTokenUsage::default()
        });
        assert_eq!(actual, 1);
        assert!(actual <= estimate.reserved_cost_micros);
    }

    #[test]
    fn actual_cost_cannot_exceed_a_matching_conservative_reservation() {
        let body = vec![b'x'; 100_000];
        let request = serde_json::json!({"max_output_tokens": 10_000});
        let estimate = pricing().estimate_request_cost(&body, Some(&request));
        let actual = pricing().actual_cost_micros(PricedTokenUsage {
            input_tokens: 100_000,
            output_tokens: 10_000,
            ..PricedTokenUsage::default()
        });
        assert!(actual <= estimate.reserved_cost_micros);
    }
}
