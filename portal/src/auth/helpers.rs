//! Pure helper functions for authentication
//!
//! This module contains stateless helper functions for URL building,
//! cookie extraction, HTTP clients, and service probing.
//!
//! All functions are pure (no side effects) except for probe_service_reachable
//! which performs HTTP requests.

use axum::http::HeaderMap;
use std::time::Duration;

use crate::services::AuthType;

// =============================================================================
// JWT Helpers (for logout token validation)
// =============================================================================

/// Check if a JWT token is expired (without signature verification)
///
/// This is used for logout to avoid sending expired id_token_hint to Keycloak,
/// which would cause "expired_code" warnings in Keycloak logs.
///
/// Returns true if the token is expired or malformed.
pub fn is_jwt_expired(token: &str) -> bool {
    // JWT format: header.payload.signature
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return true; // Malformed
    }

    // Decode payload (base64url)
    let payload = match base64_url_decode(parts[1]) {
        Some(p) => p,
        None => return true, // Can't decode
    };

    // Parse as JSON and extract exp claim
    let json: serde_json::Value = match serde_json::from_slice(&payload) {
        Ok(v) => v,
        Err(_) => return true, // Can't parse
    };

    let exp = match json.get("exp").and_then(|v| v.as_i64()) {
        Some(e) => e,
        None => return true, // No exp claim
    };

    // Check if expired (with 5 second buffer for clock skew)
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    exp < (now - 5)
}

/// Decode base64url string (JWT uses base64url without padding)
fn base64_url_decode(input: &str) -> Option<Vec<u8>> {
    // Replace URL-safe characters and add padding
    let mut s = input.replace('-', "+").replace('_', "/");
    match s.len() % 4 {
        2 => s.push_str("=="),
        3 => s.push('='),
        _ => {}
    }

    // Use a simple base64 decoder
    // Note: We're using a minimal approach to avoid adding dependencies
    let bytes: Result<Vec<u8>, _> = base64_decode_simple(&s);
    bytes.ok()
}

/// Simple base64 decoder (standard alphabet)
fn base64_decode_simple(input: &str) -> Result<Vec<u8>, ()> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    let mut output = Vec::new();
    let mut buf = 0u32;
    let mut bits = 0;

    for c in input.bytes() {
        if c == b'=' {
            break;
        }
        let val = ALPHABET.iter().position(|&x| x == c).ok_or(())? as u32;
        buf = (buf << 6) | val;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            output.push((buf >> bits) as u8);
            buf &= (1 << bits) - 1;
        }
    }
    Ok(output)
}

// =============================================================================
// HTTP Client Builders
// =============================================================================

/// Create a reqwest client for OAuth2 HTTP requests using config timeouts
pub fn create_http_client(
    connect_timeout_secs: u64,
    request_timeout_secs: u64,
) -> Result<reqwest::Client, reqwest::Error> {
    reqwest::ClientBuilder::new()
        .redirect(reqwest::redirect::Policy::none()) // Security: prevent SSRF
        .connect_timeout(Duration::from_secs(connect_timeout_secs))
        .timeout(Duration::from_secs(request_timeout_secs))
        .build()
}

/// Build a reqwest client for reachability probes with appropriate timeouts.
pub fn build_probe_client(
    connect_timeout_ms: u64,
    request_timeout_ms: u64,
) -> Result<reqwest::Client, reqwest::Error> {
    reqwest::ClientBuilder::new()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_millis(connect_timeout_ms))
        .timeout(Duration::from_millis(request_timeout_ms))
        .build()
}

// =============================================================================
// URL Builders
// =============================================================================

/// Build portal logout continue URL
pub fn build_portal_logout_continue_url(portal_public_url: &str, next_service_id: &str) -> String {
    format!(
        "{}/auth/logout?serviceId={}",
        portal_public_url, next_service_id
    )
}

/// Build oauth2-proxy sign out URL with redirect
pub fn build_oauth2_proxy_sign_out_url(service_url: &str, rd_url: &str) -> String {
    let encoded_rd = urlencoding::encode(rd_url);
    format!("{}/oauth2/sign_out?rd={}", service_url, encoded_rd)
}

/// Build Keycloak logout URL
///
/// Keycloak requires either `client_id` or `id_token_hint` when using `post_logout_redirect_uri`.
/// We prefer `id_token_hint` when available and not expired, falling back to `client_id`.
pub fn build_keycloak_logout_url(
    keycloak_callback_url: &str,
    keycloak_realm: &str,
    portal_public_url: &str,
    client_id: &str,
    id_token: Option<&str>,
) -> String {
    let logout_complete_url = format!("{}/auth/logout/complete", portal_public_url);
    let post_logout_redirect = urlencoding::encode(&logout_complete_url);

    // Check if we have a valid, non-expired id_token
    let valid_id_token = id_token
        .filter(|t| !t.trim().is_empty())
        .filter(|t| {
            if is_jwt_expired(t) {
                tracing::info!("id_token expired, using client_id for Keycloak logout");
                false
            } else {
                true
            }
        });

    if let Some(id_token) = valid_id_token {
        // Prefer id_token_hint when available (more secure, identifies the session)
        let encoded_id_token = urlencoding::encode(id_token);
        format!(
            "{}/realms/{}/protocol/openid-connect/logout?id_token_hint={}&post_logout_redirect_uri={}",
            keycloak_callback_url,
            keycloak_realm,
            encoded_id_token,
            post_logout_redirect
        )
    } else {
        // Fallback to client_id when id_token is not available or expired
        if id_token.is_none() {
            tracing::warn!("No id_token available, using client_id for Keycloak logout");
        }
        format!(
            "{}/realms/{}/protocol/openid-connect/logout?client_id={}&post_logout_redirect_uri={}",
            keycloak_callback_url,
            keycloak_realm,
            urlencoding::encode(client_id),
            post_logout_redirect
        )
    }
}

// =============================================================================
// Cookie Extraction
// =============================================================================

/// Extract a cookie value from headers
///
/// Handles multiple Cookie headers (some proxies fold/duplicate headers).
/// Uses `get_all` to collect all Cookie header values.
pub fn extract_cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    let prefix = format!("{}=", name);

    // Iterate over all Cookie headers (proxies may send multiple)
    for header_value in headers.get_all("cookie") {
        if let Ok(cookie_str) = header_value.to_str() {
            if let Some(value) = cookie_str
                .split(';')
                .map(|c| c.trim())
                .find(|c| c.starts_with(&prefix))
                .and_then(|c| c.strip_prefix(&prefix))
            {
                return Some(value.to_string());
            }
        }
    }
    None
}

// =============================================================================
// Service URL Parsing
// =============================================================================

/// Result of parsing a service URL for probing
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedServiceUrl {
    /// Host without port (for Host header in Traefik mode)
    pub host: String,
}

/// Parse a service URL using url::Url for reliable extraction.
///
/// Returns the host (without port) for use in Host headers.
pub fn parse_service_url(service_url: &str) -> Option<ParsedServiceUrl> {
    let parsed = url::Url::parse(service_url).ok()?;
    let host = parsed.host_str()?.to_string();
    Some(ParsedServiceUrl { host })
}

// =============================================================================
// OAuth2-Proxy Service Discovery
// =============================================================================

/// Lightweight representation of an OAuth2-Proxy protected service
#[derive(Debug, Clone)]
pub struct Oauth2ProxyService {
    pub id: String,
    pub url: String,
}

/// List all OAuth2-Proxy protected services from the descriptor
pub fn list_oauth2_proxy_services(descriptor: &crate::services::Descriptor) -> Vec<Oauth2ProxyService> {
    descriptor
        .services
        .iter()
        .filter(|s| s.auth_type == AuthType::Oauth2Proxy)
        .map(|s| Oauth2ProxyService {
            id: s.id.clone(),
            url: s.url.clone(),
        })
        .collect()
}

// =============================================================================
// Service Reachability Probing
// =============================================================================

/// Result of a reachability probe
#[derive(Debug, Clone, PartialEq)]
pub enum ProbeResult {
    /// Service is reachable (got a valid response, not 404)
    Reachable,
    /// Service host is up but Traefik returned 404 (no matching router)
    NoMatchingRoute,
    /// Network error (DNS failure, connection refused, timeout)
    NetworkError,
    /// Failed to parse service URL
    InvalidUrl,
}

impl ProbeResult {
    pub fn is_reachable(&self) -> bool {
        matches!(self, ProbeResult::Reachable)
    }
}

/// Probe if a service is reachable (per plan.md 2.8.1)
///
/// **Important**: This probe checks "is the host up and routable?" not "is the
/// service healthy?". The goal is to avoid stranding the user on a network error
/// page during logout, not to verify service health.
///
/// When probing through Traefik:
/// - Uses the Host header (without port) so Traefik can route correctly
/// - Treats 404 as "no matching route" (unreachable for our purposes)
/// - Any other response (including 401, 403, 500) means the route exists
///
/// When probing directly (no Traefik URL):
/// - Probes the service URL directly
/// - Any response means reachable
pub async fn probe_service_reachable(
    client: &reqwest::Client,
    service_url: &str,
    traefik_internal_url: Option<&str>,
) -> ProbeResult {
    // Parse the service URL
    let parsed = match parse_service_url(service_url) {
        Some(p) => p,
        None => {
            tracing::warn!(
                service_url = %service_url,
                "Failed to parse service URL for reachability probe"
            );
            return ProbeResult::InvalidUrl;
        }
    };

    // Determine probe target and Host header
    let (probe_url, host_header) = match traefik_internal_url {
        Some(traefik_url) => {
            // Probe through Traefik with Host header (without port)
            (traefik_url, Some(parsed.host.as_str()))
        }
        None => {
            // Direct probe - no Host header needed
            (service_url, None)
        }
    };

    // Build the request
    let mut request = client.head(probe_url);
    if let Some(host) = host_header {
        request = request.header("Host", host);
    }

    // Execute the probe
    match request.send().await {
        Ok(response) => {
            let status = response.status();

            // When probing through Traefik, 404 means no matching router
            if traefik_internal_url.is_some() && status == reqwest::StatusCode::NOT_FOUND {
                tracing::debug!(
                    service_url = %service_url,
                    probe_url = %probe_url,
                    host_header = ?host_header,
                    status = %status,
                    "Traefik returned 404 - no matching route"
                );
                ProbeResult::NoMatchingRoute
            } else {
                // Any other response means the route exists and host is up
                ProbeResult::Reachable
            }
        }
        Err(e) => {
            // Connection refused, DNS failure, timeout, etc.
            tracing::debug!(
                service_url = %service_url,
                probe_url = %probe_url,
                host_header = ?host_header,
                error = %e,
                "Network error during reachability probe"
            );
            ProbeResult::NetworkError
        }
    }
}

/// Result of finding the next reachable service
#[derive(Debug)]
pub struct FindReachableResult<'a> {
    /// The next reachable service, if any
    pub service: Option<&'a Oauth2ProxyService>,
}

/// Find the next reachable oauth2-proxy service starting from a given index.
///
/// Per plan.md 2.8.1: probe each service before redirecting to avoid stranding
/// the user on a network error page if a service is down.
///
/// Uses a single HTTP client for all probes (performance optimization).
pub async fn find_next_reachable_service<'a>(
    services: &'a [Oauth2ProxyService],
    start_index: usize,
    traefik_internal_url: Option<&str>,
    connect_timeout_ms: u64,
    request_timeout_ms: u64,
) -> FindReachableResult<'a> {
    // Build a single client for all probes (reuse connections, reduce allocations)
    let client = match build_probe_client(connect_timeout_ms, request_timeout_ms) {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!(
                error = %e,
                "Failed to build HTTP client for reachability probes"
            );
            return FindReachableResult { service: None };
        }
    };

    let mut skipped_count = 0;

    for (offset, service) in services.iter().skip(start_index).enumerate() {
        let index = start_index + offset;
        let probe_result = probe_service_reachable(
            &client,
            &service.url,
            traefik_internal_url,
        )
        .await;

        if probe_result.is_reachable() {
            tracing::info!(
                event = "logout_service_reachable",
                service_id = %service.id,
                service_url = %service.url,
                index = index,
                skipped_before = skipped_count,
                "Service is reachable"
            );
            return FindReachableResult {
                service: Some(service),
            };
        } else {
            // Warn for each unreachable service - this is operationally important
            tracing::warn!(
                event = "logout_service_unreachable",
                service_id = %service.id,
                service_url = %service.url,
                index = index,
                result = ?probe_result,
                "Service unreachable, skipping during logout"
            );
            skipped_count += 1;
        }
    }

    // Summary when all services are unreachable
    if skipped_count > 0 {
        tracing::warn!(
            event = "logout_all_services_unreachable",
            skipped_count = skipped_count,
            start_index = start_index,
            total_services = services.len(),
            "All remaining oauth2-proxy services are unreachable"
        );
    }

    FindReachableResult { service: None }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_portal_logout_continue_url() {
        let url = build_portal_logout_continue_url("http://portal.localhost", "demo");
        assert_eq!(url, "http://portal.localhost/auth/logout?serviceId=demo");
    }

    #[test]
    fn test_build_oauth2_proxy_sign_out_url() {
        let rd_url = "http://portal.localhost/auth/logout?serviceId=demo";
        let url = build_oauth2_proxy_sign_out_url("http://demo.localhost", rd_url);
        assert!(url.starts_with("http://demo.localhost/oauth2/sign_out?rd="));
        assert!(url.contains("portal.localhost"));
        // Verify URL encoding
        assert!(url.contains("%3A")); // encoded ':'
        assert!(url.contains("%2F")); // encoded '/'
    }

    #[test]
    fn test_extract_cookie_finds_value() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "cookie",
            axum::http::HeaderValue::from_static("foo=bar; id_token=abc123; baz=qux"),
        );

        let result = extract_cookie(&headers, "id_token");
        assert_eq!(result, Some("abc123".to_string()));
    }

    #[test]
    fn test_extract_cookie_missing_cookie() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "cookie",
            axum::http::HeaderValue::from_static("foo=bar; baz=qux"),
        );

        let result = extract_cookie(&headers, "id_token");
        assert_eq!(result, None);
    }

    #[test]
    fn test_extract_cookie_no_cookie_header() {
        let headers = HeaderMap::new();
        let result = extract_cookie(&headers, "id_token");
        assert_eq!(result, None);
    }

    #[test]
    fn test_extract_cookie_multiple_headers() {
        // Some proxies send multiple Cookie headers instead of one combined header
        let mut headers = HeaderMap::new();
        headers.append(
            "cookie",
            axum::http::HeaderValue::from_static("foo=bar"),
        );
        headers.append(
            "cookie",
            axum::http::HeaderValue::from_static("id_token=secret123; baz=qux"),
        );

        let result = extract_cookie(&headers, "id_token");
        assert_eq!(result, Some("secret123".to_string()));
    }

    #[test]
    fn test_extract_cookie_multiple_headers_first_match() {
        // If cookie appears in first header, should find it
        let mut headers = HeaderMap::new();
        headers.append(
            "cookie",
            axum::http::HeaderValue::from_static("id_token=first_value"),
        );
        headers.append(
            "cookie",
            axum::http::HeaderValue::from_static("id_token=second_value"),
        );

        // Should return first occurrence
        let result = extract_cookie(&headers, "id_token");
        assert_eq!(result, Some("first_value".to_string()));
    }

    // Tests for parse_service_url (proper URL parsing)

    #[test]
    fn test_parse_service_url_simple() {
        let result = parse_service_url("http://demo.localhost").unwrap();
        assert_eq!(result.host, "demo.localhost");
    }

    #[test]
    fn test_parse_service_url_with_path() {
        let result = parse_service_url("http://demo.localhost/some/path").unwrap();
        assert_eq!(result.host, "demo.localhost");
    }

    #[test]
    fn test_parse_service_url_https() {
        let result = parse_service_url("https://demo.example.com/path").unwrap();
        assert_eq!(result.host, "demo.example.com");
    }

    #[test]
    fn test_parse_service_url_with_port() {
        // Host header should NOT include port (for Traefik routing)
        let result = parse_service_url("http://demo.localhost:8080/path").unwrap();
        assert_eq!(result.host, "demo.localhost");
    }

    #[test]
    fn test_parse_service_url_with_query() {
        let result = parse_service_url("http://demo.localhost/path?foo=bar").unwrap();
        assert_eq!(result.host, "demo.localhost");
    }

    #[test]
    fn test_parse_service_url_invalid() {
        assert!(parse_service_url("not-a-url").is_none());
    }

    #[test]
    fn test_parse_service_url_missing_scheme() {
        assert!(parse_service_url("demo.localhost").is_none());
    }

    // Tests for ProbeResult

    #[test]
    fn test_probe_result_is_reachable() {
        assert!(ProbeResult::Reachable.is_reachable());
        assert!(!ProbeResult::NoMatchingRoute.is_reachable());
        assert!(!ProbeResult::NetworkError.is_reachable());
        assert!(!ProbeResult::InvalidUrl.is_reachable());
    }

    // Tests for JWT expiration checking

    #[test]
    fn test_is_jwt_expired_malformed() {
        assert!(is_jwt_expired("not-a-jwt"));
        assert!(is_jwt_expired("only.two"));
        assert!(is_jwt_expired(""));
    }

    #[test]
    fn test_is_jwt_expired_with_valid_token() {
        // Create a JWT with exp far in the future (year 2099)
        // Header: {"alg":"none","typ":"JWT"}
        // Payload: {"exp":4102444800} (Jan 1, 2100)
        let header = "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0";
        let payload = "eyJleHAiOjQxMDI0NDQ4MDB9";
        let signature = "";
        let token = format!("{}.{}.{}", header, payload, signature);

        assert!(!is_jwt_expired(&token));
    }

    #[test]
    fn test_is_jwt_expired_with_expired_token() {
        // Create a JWT with exp in the past (year 2020)
        // Header: {"alg":"none","typ":"JWT"}
        // Payload: {"exp":1577836800} (Jan 1, 2020)
        let header = "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0";
        let payload = "eyJleHAiOjE1Nzc4MzY4MDB9";
        let signature = "";
        let token = format!("{}.{}.{}", header, payload, signature);

        assert!(is_jwt_expired(&token));
    }
}
