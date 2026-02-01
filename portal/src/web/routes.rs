use super::handlers::{dashboard_handler, healthz_handler, landing_handler, readyz_handler};
use crate::{
    auth::{
        callback_handler, jwt::JwtValidator, login_handler, logout_complete_handler, logout_handler,
    },
    AppState,
};
use axum::{routing::get, Extension, Router};
use std::sync::Arc;
use tower_http::services::ServeDir;

pub fn create_router(state: Arc<AppState>, jwt_validator: Arc<JwtValidator>) -> Router {
    Router::new()
        .route("/", get(landing_handler))
        .route("/healthz", get(healthz_handler))
        .route("/readyz", get(readyz_handler))
        .route("/dashboard", get(dashboard_handler))
        .route("/auth/login", get(login_handler))
        .route("/auth/callback", get(callback_handler))
        // Support both POST (form submission, CSRF-safe) and GET (redirect continuation from oauth2-proxy)
        .route("/auth/logout", get(logout_handler).post(logout_handler))
        .route("/auth/logout/complete", get(logout_complete_handler))
        .nest_service("/static", ServeDir::new("static"))
        .layer(Extension(jwt_validator))
        .with_state(state)
}
