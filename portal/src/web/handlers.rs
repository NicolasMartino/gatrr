use super::templates::{DashboardTemplate, LandingTemplate};
use crate::{auth::extractors::AuthenticatedUser, services::filter_services_for_user, AppState};
use askama::Template;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{Html, IntoResponse};
use std::sync::Arc;

/// Liveness probe - always returns OK if the process is running
pub async fn healthz_handler() -> impl IntoResponse {
    StatusCode::OK
}

/// Readiness probe - checks if the service is ready to handle requests
///
/// Returns 200 OK if:
/// - JWKS cache has been populated (Keycloak is reachable)
///
/// Returns 503 Service Unavailable if:
/// - JWKS cache is empty (Keycloak not yet contacted or unreachable)
pub async fn readyz_handler(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    // Check if JWKS has been cached (indicates Keycloak connectivity)
    let jwks_cached = state.jwt_validator.is_jwks_cached().await;

    if jwks_cached {
        (StatusCode::OK, "ready")
    } else {
        tracing::warn!("Readiness check failed: JWKS not cached");
        (StatusCode::SERVICE_UNAVAILABLE, "not ready: JWKS not cached")
    }
}

pub async fn landing_handler(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    // Pick a random logo each time the landing page is loaded
    let logo_url = if !state.logos.is_empty() {
        let random_index = fastrand::usize(..state.logos.len());
        Some(format!("/static/logos/{}", state.logos[random_index]))
    } else {
        None
    };

    let template = LandingTemplate { logo_url };
    match template.render() {
        Ok(html) => Html(html).into_response(),
        Err(_) => (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "Template error",
        )
            .into_response(),
    }
}

pub async fn dashboard_handler(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser { claims, .. }: AuthenticatedUser,
) -> impl IntoResponse {
    // Get user's realm roles from JWT claims
    let user_roles = claims.roles();

    // Filter services to only those the user can access (per plan.md 2.7)
    let accessible_services = filter_services_for_user(&state.services, &user_roles);

    tracing::debug!(
        username = ?claims.preferred_username,
        user_roles = ?user_roles,
        total_services = state.services.len(),
        accessible_services = accessible_services.len(),
        "Filtered services for user"
    );

    let template = DashboardTemplate {
        username: claims
            .preferred_username
            .clone()
            .unwrap_or_else(|| claims.sub.clone()),
        email: claims.email.clone(),
        services: accessible_services,
    };

    match template.render() {
        Ok(html) => Html(html).into_response(),
        Err(_) => (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "Template error",
        )
            .into_response(),
    }
}
