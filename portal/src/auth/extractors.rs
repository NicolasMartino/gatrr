use crate::auth::helpers::extract_cookie;
use crate::auth::jwt::{Claims, JwtValidator};
use axum::{
    extract::FromRequestParts,
    http::{request::Parts, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use std::sync::Arc;

/// Custom authentication error type
#[derive(Debug)]
pub enum AuthError {
    Unauthenticated(String),
    Forbidden(String),
    Internal(String),
}

impl IntoResponse for AuthError {
    fn into_response(self) -> Response {
        match self {
            AuthError::Unauthenticated(msg) => (
                StatusCode::UNAUTHORIZED,
                Json(json!({
                    "error": "Authentication required",
                    "message": msg,
                    "code": "UNAUTHENTICATED"
                })),
            )
                .into_response(),

            AuthError::Forbidden(msg) => (
                StatusCode::FORBIDDEN,
                Json(json!({
                    "error": "Access denied",
                    "message": msg,
                    "code": "FORBIDDEN"
                })),
            )
                .into_response(),

            AuthError::Internal(msg) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({
                    "error": "Internal server error",
                    "message": msg
                })),
            )
                .into_response(),
        }
    }
}

/// Authenticated user extractor - validates JWT from cookie
///
/// This extractor provides both user claims and roles in a convenient structure.
/// It will fail (return AuthError) if authentication is missing or invalid.
///
/// Usage:
/// ```rust,ignore
/// async fn handler(AuthenticatedUser { claims, roles, .. }: AuthenticatedUser) {
///     // User is authenticated, access claims and roles directly
///     println!("User: {}, Roles: {:?}", claims.sub, roles);
/// }
/// ```
pub struct AuthenticatedUser {
    pub claims: Claims,
    pub roles: Vec<String>,
}

impl<S> FromRequestParts<S> for AuthenticatedUser
where
    S: Send + Sync,
{
    type Rejection = AuthError;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        // 1. Extract access_token from cookies using shared helper
        let token = extract_cookie(&parts.headers, "access_token")
            .ok_or_else(|| AuthError::Unauthenticated("Missing access_token cookie".to_string()))?;

        // 2. Get JwtValidator from extensions
        let validator = parts
            .extensions
            .get::<Arc<JwtValidator>>()
            .ok_or_else(|| AuthError::Internal("Missing JwtValidator extension".to_string()))?;

        // 3. Validate JWT asynchronously
        let claims = validator
            .validate_async(&token)
            .await
            .map_err(|e| AuthError::Unauthenticated(format!("Invalid token: {}", e)))?;

        // 4. Extract roles for easy access
        let roles = claims.roles();

        // Defensive logging: warn if token has no roles
        // This helps diagnose Keycloak misconfiguration (e.g., missing realm_access.roles mapper)
        if roles.is_empty() {
            tracing::warn!(
                user = %claims.sub,
                has_realm_access = claims.has_realm_access(),
                "JWT token has no realm roles - user will not see any protected services. \
                 Check Keycloak client scope configuration for realm_access.roles mapper."
            );
        } else {
            tracing::debug!(
                user = %claims.sub,
                roles = ?roles,
                "User authenticated via cookie"
            );
        }

        Ok(AuthenticatedUser { claims, roles })
    }
}

