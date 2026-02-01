//! Authentication handlers for login, callback, and logout flows
//!
//! This module contains the Axum HTTP handlers for the OAuth2/OIDC authentication flow:
//! - `login_handler`: Initiates OAuth2 authorization code flow
//! - `callback_handler`: Handles OAuth2 callback and token exchange
//! - `logout_handler`: Cascading logout through oauth2-proxy services and Keycloak
//! - `logout_complete_handler`: Final landing page after logout

use axum::{
    extract::{Query, State},
    http::{header::InvalidHeaderValue, HeaderValue, StatusCode},
    response::{IntoResponse, Redirect, Response},
    Json,
};
use oauth2::{
    basic::{BasicErrorResponseType, BasicTokenType},
    AuthUrl, AuthorizationCode, ClientId, ClientSecret, CsrfToken, EndpointSet, ExtraTokenFields,
    RedirectUrl, Scope, StandardErrorResponse, StandardRevocableToken,
    StandardTokenIntrospectionResponse, StandardTokenResponse, TokenResponse, TokenUrl,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use super::helpers::{
    build_keycloak_logout_url, build_oauth2_proxy_sign_out_url, build_portal_logout_continue_url,
    create_http_client, extract_cookie, find_next_reachable_service, list_oauth2_proxy_services,
    FindReachableResult,
};

// =============================================================================
// Types
// =============================================================================

/// Custom extra fields to capture id_token from OIDC response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OidcTokenFields {
    pub id_token: Option<String>,
}

impl ExtraTokenFields for OidcTokenFields {}

/// Type alias for our configured OAuth client with OIDC support
type ConfiguredOAuthClient = oauth2::Client<
    StandardErrorResponse<BasicErrorResponseType>,
    StandardTokenResponse<OidcTokenFields, BasicTokenType>,
    StandardTokenIntrospectionResponse<OidcTokenFields, BasicTokenType>,
    StandardRevocableToken,
    StandardErrorResponse<oauth2::RevocationErrorResponseType>,
    EndpointSet,            // HasAuthUrl
    oauth2::EndpointNotSet, // HasDeviceAuthUrl
    oauth2::EndpointNotSet, // HasIntrospectionUrl
    oauth2::EndpointNotSet, // HasRevocationUrl
    EndpointSet,            // HasTokenUrl
>;

#[derive(Deserialize)]
pub struct CallbackParams {
    pub code: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
    pub error_description: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct LogoutQuery {
    #[serde(rename = "serviceId")]
    pub service_id: Option<String>,
}

// =============================================================================
// Internal Helpers
// =============================================================================

/// Create a HeaderValue from a string, returning an error response if invalid.
/// This prevents panics from malformed cookie values.
fn header_value(s: &str) -> Result<HeaderValue, Box<Response>> {
    HeaderValue::from_str(s).map_err(|e: InvalidHeaderValue| {
        tracing::error!(
            error = %e,
            value_len = s.len(),
            "Failed to create header value - possible malformed token"
        );
        Box::new(
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "Internal error setting response headers"})),
            )
                .into_response(),
        )
    })
}

/// Initialize OAuth2 client from environment
fn create_oauth_client(
    keycloak_callback_url: &str,
    keycloak_url: &str,
    realm: &str,
    client_id: &str,
    client_secret: &str,
    redirect_uri: &str,
) -> Result<ConfiguredOAuthClient, String> {
    let client_id = ClientId::new(client_id.to_string());
    let client_secret = ClientSecret::new(client_secret.to_string());

    // Use public URL for browser redirects
    let auth_url = AuthUrl::new(format!(
        "{}/realms/{}/protocol/openid-connect/auth",
        keycloak_callback_url, realm
    ))
    .map_err(|e| format!("Invalid auth URL: {}", e))?;

    // Use internal URL for token exchange
    let token_url = TokenUrl::new(format!(
        "{}/realms/{}/protocol/openid-connect/token",
        keycloak_url, realm
    ))
    .map_err(|e| format!("Invalid token URL: {}", e))?;

    let redirect_url = RedirectUrl::new(redirect_uri.to_string())
        .map_err(|e| format!("Invalid redirect URL: {}", e))?;

    // Create client with custom extra fields for OIDC
    let client = oauth2::Client::new(client_id)
        .set_client_secret(client_secret)
        .set_auth_uri(auth_url)
        .set_token_uri(token_url)
        .set_redirect_uri(redirect_url);

    Ok(client)
}

// =============================================================================
// Handlers
// =============================================================================

/// Login handler - initiates OAuth2 authorization code flow
pub async fn login_handler(
    State(state): State<Arc<crate::AppState>>,
) -> Result<Response, Response> {
    tracing::info!("Login requested");

    let oauth_client = match create_oauth_client(
        &state.config.keycloak_callback_url,
        &state.config.keycloak_url,
        &state.config.keycloak_realm,
        &state.config.client_id,
        &state.config.client_secret,
        &state.config.redirect_uri,
    ) {
        Ok(client) => client,
        Err(e) => {
            tracing::error!(error = %e, "Failed to create OAuth client");
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": "OAuth configuration error"
                })),
            )
                .into_response());
        }
    };

    // Generate authorization URL with CSRF protection
    let (auth_url, csrf_token) = oauth_client
        .authorize_url(CsrfToken::new_random)
        .add_scope(Scope::new("openid".to_string()))
        .add_scope(Scope::new("profile".to_string()))
        .add_scope(Scope::new("email".to_string()))
        .url();

    tracing::info!(
        keycloak_public_url = %state.config.keycloak_callback_url,
        realm = %state.config.keycloak_realm,
        "Redirecting to Keycloak for authentication"
    );

    // Store CSRF token in httponly cookie (expires in 10 minutes)
    // Use SameSite=Lax for CSRF protection (allows top-level navigations)
    let csrf_cookie = format!(
        "oauth_state={}; HttpOnly; Path=/auth; Max-Age=600; SameSite=Lax{}{}",
        csrf_token.secret(),
        state.config.cookie_domain_attr(),
        state.config.cookie_secure_flag()
    );

    let mut response = Redirect::to(auth_url.as_str()).into_response();
    response.headers_mut().insert(
        axum::http::header::SET_COOKIE,
        header_value(&csrf_cookie).map_err(|e| *e)?,
    );

    Ok(response)
}

/// Callback handler - handles OAuth2 callback and token exchange
pub async fn callback_handler(
    Query(params): Query<CallbackParams>,
    State(state): State<Arc<crate::AppState>>,
    headers: axum::http::HeaderMap,
) -> Response {
    tracing::info!("OAuth callback received");

    // Check for OAuth errors
    if let Some(error) = params.error {
        tracing::warn!(
            error = %error,
            description = ?params.error_description,
            "OAuth authorization failed"
        );
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({
                "error": error,
                "error_description": params.error_description
            })),
        )
            .into_response();
    }

    // CSRF Protection: Validate state parameter matches stored cookie
    let state_from_callback = match params.state {
        Some(ref s) => s,
        None => {
            tracing::warn!("CSRF validation failed: No state parameter in callback");
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": "Missing state parameter"
                })),
            )
                .into_response();
        }
    };

    // Extract state from cookie using shared helper
    let Some(stored_state) = extract_cookie(&headers, "oauth_state") else {
        tracing::warn!(
            has_cookie_header = headers.get("cookie").is_some(),
            "CSRF validation failed: No oauth_state cookie found"
        );
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({
                "error": "CSRF validation failed: missing state cookie"
            })),
        )
            .into_response();
    };

    // Compare states
    if state_from_callback != &stored_state {
        tracing::warn!("CSRF validation failed: State mismatch (callback vs cookie)");
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({
                "error": "CSRF validation failed: state mismatch"
            })),
        )
            .into_response();
    }

    tracing::info!("CSRF validation successful");

    let Some(code) = params.code else {
        tracing::warn!("No authorization code received");
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "Missing authorization code"
            })),
        )
            .into_response();
    };

    tracing::debug!(code_length = code.len(), "Authorization code received");

    // Create OAuth client
    let oauth_client = match create_oauth_client(
        &state.config.keycloak_callback_url,
        &state.config.keycloak_url,
        &state.config.keycloak_realm,
        &state.config.client_id,
        &state.config.client_secret,
        &state.config.redirect_uri,
    ) {
        Ok(client) => client,
        Err(e) => {
            tracing::error!(error = %e, "Failed to create OAuth client");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": "OAuth configuration error"
                })),
            )
                .into_response();
        }
    };

    tracing::info!("Exchanging authorization code for tokens");

    // Exchange authorization code for access token
    let http_client = match create_http_client(
        state.config.http_connect_timeout_secs,
        state.config.http_request_timeout_secs,
    ) {
        Ok(client) => client,
        Err(e) => {
            tracing::error!(error = %e, "Failed to build HTTP client for token exchange");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "Internal server error"})),
            )
                .into_response();
        }
    };
    let token_result = oauth_client
        .exchange_code(AuthorizationCode::new(code))
        .request_async(&http_client)
        .await;

    let token_response = match token_result {
        Ok(token) => token,
        Err(e) => {
            tracing::error!(error = %e, "Failed to exchange code for tokens");
            return (
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({"error": "Token exchange failed"})),
            )
                .into_response();
        }
    };

    let access_token = token_response.access_token().secret();
    let expires_in = token_response
        .expires_in()
        .map(|d| d.as_secs())
        .unwrap_or(3600);

    // Extract id_token from extra fields
    let id_token = token_response.extra_fields().id_token.clone();

    tracing::info!(
        has_id_token = id_token.is_some(),
        "Successfully obtained access token"
    );

    // Set access_token as httponly cookie with proper security attributes
    let access_cookie = format!(
        "access_token={}; HttpOnly; Path=/; Max-Age={}; SameSite=Lax{}{}",
        access_token,
        expires_in,
        state.config.cookie_domain_attr(),
        state.config.cookie_secure_flag()
    );

    let mut response = Redirect::to("/dashboard").into_response();

    // Set access token cookie - return error if header creation fails
    let access_header = match header_value(&access_cookie) {
        Ok(h) => h,
        Err(e) => return *e,
    };
    response.headers_mut().insert(
        axum::http::header::SET_COOKIE,
        access_header,
    );

    // Set id_token as httponly cookie for logout with proper security attributes
    if let Some(id_token_value) = id_token {
        let id_cookie = format!(
            "id_token={}; HttpOnly; Path=/; Max-Age={}; SameSite=Lax{}{}",
            id_token_value,
            expires_in,
            state.config.cookie_domain_attr(),
            state.config.cookie_secure_flag()
        );
        let id_header = match header_value(&id_cookie) {
            Ok(h) => h,
            Err(e) => return *e,
        };
        response.headers_mut().append(
            axum::http::header::SET_COOKIE,
            id_header,
        );
        tracing::info!("id_token stored in cookie for logout");
    } else {
        tracing::warn!("No id_token received from Keycloak - logout may fail");
    }

    // Clear the oauth_state cookie after successful authentication
    let clear_state_cookie = format!(
        "oauth_state=; HttpOnly; Path=/auth; Max-Age=0; SameSite=Lax{}{}",
        state.config.cookie_domain_attr(),
        state.config.cookie_secure_flag()
    );
    let clear_header = match header_value(&clear_state_cookie) {
        Ok(h) => h,
        Err(e) => return *e,
    };
    response.headers_mut().append(
        axum::http::header::SET_COOKIE,
        clear_header,
    );

    tracing::info!("Authentication successful, redirecting to dashboard");
    response
}

/// Logout handler - clears portal session, then clears oauth2-proxy sessions via top-level redirects
///
/// NOTE: We intentionally avoid iframe fan-out because modern browser cookie policies can block
/// cross-site iframe flows, which breaks oauth2-proxy CSRF cookies during redirects.
///
/// Per plan.md 2.8.1: Before redirecting to each oauth2-proxy service, we probe it to check
/// reachability. Unreachable services are skipped to prevent stranding the user.
pub async fn logout_handler(
    State(state): State<Arc<crate::AppState>>,
    Query(query): Query<LogoutQuery>,
    headers: axum::http::HeaderMap,
) -> Response {
    let span = tracing::info_span!(
        "logout_flow",
        service_id = ?query.service_id,
        oauth2_proxy_services = tracing::field::Empty,
    );
    let _guard = span.enter();

    let oauth2_proxy_services = list_oauth2_proxy_services(&state.descriptor);
    tracing::Span::current().record("oauth2_proxy_services", oauth2_proxy_services.len());

    match query.service_id.as_deref() {
        None => {
            tracing::info!(event = "logout_start", "Logout requested");
        }
        Some(service_id) => {
            tracing::info!(
                event = "logout_continue",
                last_service_id = service_id,
                "Continuing logout flow"
            );
        }
    }

    // Extract id_token for Keycloak logout (do not log token)
    let id_token = extract_cookie(&headers, "id_token");
    let has_id_token = id_token.is_some();

    // Determine the starting index for finding the next oauth2-proxy service.
    // Semantics: ?serviceId=<id> means "we just signed out from <id>; continue to the next one".
    let start_index = match query.service_id.as_deref() {
        None => 0,
        Some(last_id) => oauth2_proxy_services
            .iter()
            .position(|s| s.id == last_id)
            .map(|i| i + 1)
            .unwrap_or_else(|| {
                tracing::warn!(
                    event = "logout_unknown_service_id",
                    service_id = last_id,
                    "Unknown serviceId; restarting logout from first service"
                );
                0
            }),
    };

    // Security: In production, require TRAEFIK_INTERNAL_URL to prevent SSRF via direct probing
    // In development, direct probing is allowed for convenience
    let skip_service_probes = state.config.is_production()
        && state.config.traefik_internal_url.is_none()
        && !oauth2_proxy_services.is_empty();

    if skip_service_probes {
        tracing::warn!(
            event = "logout_missing_traefik_url",
            "TRAEFIK_INTERNAL_URL not set in production; skipping service probes for security"
        );
    }

    // Find the next reachable service (per plan.md 2.8.1)
    // Skip probing entirely if TRAEFIK_INTERNAL_URL is missing in production
    let find_result = if skip_service_probes {
        // Go straight to Keycloak logout - safer than allowing arbitrary URL probing
        FindReachableResult { service: None }
    } else {
        find_next_reachable_service(
            &oauth2_proxy_services,
            start_index,
            state.config.traefik_internal_url.as_deref(),
            state.config.logout_probe_connect_timeout_ms,
            state.config.logout_probe_request_timeout_ms,
        )
        .await
    };

    // Clear portal access cookie on every hop so the portal session ends immediately.
    let access_cookie = format!(
        "access_token=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax{}{}",
        state.config.cookie_domain_attr(),
        state.config.cookie_secure_flag()
    );

    // Also clear any stale oauth_state CSRF cookie (best-effort cleanup).
    let oauth_state_cookie = format!(
        "oauth_state=; HttpOnly; Path=/auth; Max-Age=0; SameSite=Lax{}{}",
        state.config.cookie_domain_attr(),
        state.config.cookie_secure_flag()
    );

    let (redirect_target, should_clear_id_token) = match find_result.service {
        Some(next) => {
            let rd_url =
                build_portal_logout_continue_url(&state.config.portal_public_url, &next.id);
            let sign_out_url = build_oauth2_proxy_sign_out_url(&next.url, &rd_url);

            tracing::info!(
                event = "oauth2_proxy_logout_redirect",
                next_service_id = %next.id,
                next_service_url = %next.url,
                rd_url = %rd_url,
                sign_out_url = %sign_out_url,
                "Redirecting to oauth2-proxy sign_out"
            );

            (sign_out_url, false)
        }
        None => {
            if oauth2_proxy_services.is_empty() {
                tracing::info!(
                    event = "logout_no_oauth2proxy_services",
                    "No oauth2-proxy services configured; redirecting to Keycloak logout"
                );
            } else {
                tracing::info!(
                    event = "logout_services_complete",
                    "All oauth2-proxy services processed; redirecting to Keycloak logout"
                );
            }

            let keycloak_logout_url = build_keycloak_logout_url(
                &state.config.keycloak_callback_url,
                &state.config.keycloak_realm,
                &state.config.portal_public_url,
                &state.config.client_id,
                id_token.as_deref(),
            );

            // Security: Do not log the full URL as it may contain id_token_hint (JWT)
            tracing::info!(
                event = "keycloak_logout_redirect",
                has_id_token = has_id_token,
                keycloak_realm = %state.config.keycloak_realm,
                "Redirecting to Keycloak end-session"
            );

            (keycloak_logout_url, true)
        }
    };

    let mut response = Redirect::to(&redirect_target).into_response();

    // Set cookie headers - for logout we continue even if header creation fails
    // since clearing cookies is best-effort and we shouldn't block the logout flow
    if let Ok(h) = header_value(&access_cookie) {
        response.headers_mut().insert(axum::http::header::SET_COOKIE, h);
    }
    if let Ok(h) = header_value(&oauth_state_cookie) {
        response.headers_mut().append(axum::http::header::SET_COOKIE, h);
    }

    if should_clear_id_token {
        let id_cookie = format!(
            "id_token=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax{}{}",
            state.config.cookie_domain_attr(),
            state.config.cookie_secure_flag()
        );
        if let Ok(h) = header_value(&id_cookie) {
            response.headers_mut().append(axum::http::header::SET_COOKIE, h);
        }

        tracing::info!(event = "portal_id_token_cleared", "Cleared id_token cookie");
    }

    tracing::info!(
        event = "portal_access_token_cleared",
        "Cleared access_token cookie"
    );

    response
}

/// Logout complete handler - landing page after Keycloak logout
///
/// Per plan.md 2.8.2 step 4: Final landing spot after logout flow completes.
/// Simply redirects to the landing page.
pub async fn logout_complete_handler() -> Response {
    tracing::info!(
        event = "logout_complete",
        redirect_to = "/",
        "Logout complete"
    );
    Redirect::to("/").into_response()
}
