use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProxyKeyParts {
    pub mode: KeyMode,
    pub kid: String,
    pub secret: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyMode {
    Live,
    Test,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum KeyError {
    #[error("unsupported key prefix")]
    UnsupportedPrefix,
    #[error("malformed key")]
    Malformed,
}

pub fn parse_proxy_key(input: &str) -> Result<ProxyKeyParts, KeyError> {
    if let Some(rest) = input.strip_prefix("clawrouter-live-") {
        return parse_dash_key(rest, KeyMode::Live);
    }
    if let Some(rest) = input.strip_prefix("clawrouter-test-") {
        return parse_dash_key(rest, KeyMode::Test);
    }
    if let Some(rest) = input.strip_prefix("ocpk_live_") {
        return parse_underscore_key(rest, KeyMode::Live);
    }
    if let Some(rest) = input.strip_prefix("ocpk_test_") {
        return parse_underscore_key(rest, KeyMode::Test);
    }
    Err(KeyError::UnsupportedPrefix)
}

fn parse_dash_key(rest: &str, mode: KeyMode) -> Result<ProxyKeyParts, KeyError> {
    let (kid, secret) = rest.split_once('-').ok_or(KeyError::Malformed)?;
    finish(mode, kid, secret, b'-')
}

fn parse_underscore_key(rest: &str, mode: KeyMode) -> Result<ProxyKeyParts, KeyError> {
    let (kid, secret) = rest.split_once('_').ok_or(KeyError::Malformed)?;
    finish(mode, kid, secret, b'_')
}

fn finish(
    mode: KeyMode,
    kid: &str,
    secret: &str,
    kid_delimiter: u8,
) -> Result<ProxyKeyParts, KeyError> {
    if kid.len() < 4
        || secret.len() < 8
        || !is_tokenish(kid)
        || kid.bytes().any(|b| b == kid_delimiter)
        || !is_tokenish(secret)
    {
        return Err(KeyError::Malformed);
    }
    Ok(ProxyKeyParts {
        mode,
        kid: kid.to_string(),
        secret: secret.to_string(),
    })
}

fn is_tokenish(value: &str) -> bool {
    value
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_live_dash_key() {
        let key = parse_proxy_key("clawrouter-live-ab12cd-secret_1234").unwrap();
        assert_eq!(key.mode, KeyMode::Live);
        assert_eq!(key.kid, "ab12cd");
        assert_eq!(key.secret, "secret_1234");
    }

    #[test]
    fn parses_test_ocpk_key() {
        let key = parse_proxy_key("ocpk_test_ab12cd_secret-1234").unwrap();
        assert_eq!(key.mode, KeyMode::Test);
        assert_eq!(key.kid, "ab12cd");
        assert_eq!(key.secret, "secret-1234");
    }

    #[test]
    fn rejects_unknown_prefix() {
        assert_eq!(
            parse_proxy_key("sk-not-clawrouter").unwrap_err(),
            KeyError::UnsupportedPrefix
        );
    }

    #[test]
    fn rejects_dash_delimited_kid_with_dash() {
        assert_eq!(
            parse_proxy_key("clawrouter-live-ab-12cd-secret_1234").unwrap_err(),
            KeyError::Malformed
        );
    }

    #[test]
    fn rejects_underscore_delimited_kid_with_underscore() {
        assert_eq!(
            parse_proxy_key("ocpk_test_ab_12cd_secret-1234").unwrap_err(),
            KeyError::Malformed
        );
    }
}
