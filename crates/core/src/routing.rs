use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RouteMatch {
    pub provider: Option<String>,
    pub capability: Option<String>,
    pub model_pattern: Option<String>,
}

pub fn match_model(pattern: &str, model: &str) -> bool {
    if pattern == "*" || pattern == model {
        return true;
    }
    if pattern.ends_with('/') {
        return model.starts_with(pattern);
    }
    let parts: Vec<&str> = pattern.split('*').collect();
    if parts.len() == 1 {
        return pattern == model;
    }
    let mut cursor = 0usize;
    let anchored_start = !pattern.starts_with('*');
    let anchored_end = !pattern.ends_with('*');
    for (index, part) in parts.iter().filter(|part| !part.is_empty()).enumerate() {
        let Some(found) = model[cursor..].find(part) else {
            return false;
        };
        if anchored_start && index == 0 && found != 0 {
            return false;
        }
        cursor += found + part.len();
    }
    !anchored_end || parts.last().is_some_and(|part| model.ends_with(part))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_provider_prefixes() {
        assert!(match_model("openai/", "openai/gpt-5.5-mini"));
        assert!(match_model("tavily/", "tavily/search"));
        assert!(match_model("openai/gpt-*", "openai/gpt-5.5-mini"));
        assert!(match_model("minimax/*", "minimax/MiniMax-M3"));
        assert!(!match_model("openai/", "openrouter/auto"));
        assert!(!match_model("openai/*", "tavily/search"));
    }
}
