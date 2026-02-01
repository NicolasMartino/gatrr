use anyhow::Result;
use portal::{assets, auth::jwt::JwtValidator, services, web, AppState};
use std::sync::Arc;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

#[tokio::main]
async fn main() -> Result<()> {
    // Initialize tracing
    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .with(tracing_subscriber::fmt::layer())
        .init();

    tracing::info!("Starting portal service");

    // Load configuration from environment
    let config = portal::config::Config::load()?;
    tracing::info!(
        environment = ?config.environment,
        keycloak_realm = %config.keycloak_realm,
        "Configuration loaded"
    );

    // Initialize JWT validator with JWKS caching and issuer/audience validation
    let jwt_validator = Arc::new(
        JwtValidator::new(
            config.keycloak_url.clone(),           // Internal URL for JWKS fetching
            config.keycloak_callback_url.clone(),  // Public URL for issuer validation
            config.keycloak_realm.clone(),
            config.client_id.clone(),              // Expected audience
            config.http_connect_timeout_secs,
            config.http_request_timeout_secs,
            config.jwks_cache_ttl_secs,
        )
        .map_err(|e| anyhow::anyhow!("Failed to initialize JWT validator: {}", e))?,
    );
    tracing::info!("JWT validator initialized with issuer and audience validation");

    // Prefetch JWKS at startup to ensure /readyz returns 200 immediately
    jwt_validator
        .prefetch_jwks()
        .await
        .map_err(|e| anyhow::anyhow!("Failed to prefetch JWKS at startup: {}", e))?;
    tracing::info!("JWKS prefetched successfully - readiness check will pass");

    // Load and validate descriptor (logs summary internally)
    let descriptor = services::load_descriptor(&config.descriptor)?;
    let services = services::services_from_descriptor(&descriptor);

    // Discover logos at runtime
    let logos = assets::discover_logos().unwrap_or_default();
    tracing::info!("Discovered {} logos", logos.len());

    // Create shared application state
    let config_arc = Arc::new(config.clone());
    let descriptor_arc = Arc::new(descriptor);
    let state = Arc::new(AppState {
        services,
        logos,
        jwt_validator: jwt_validator.clone(),
        config: config_arc,
        descriptor: descriptor_arc,
    });

    // Build router with JWT validator extension
    let app = web::create_router(state, jwt_validator);

    // Bind and serve
    let bind_address = config.bind_address();
    let listener = tokio::net::TcpListener::bind(&bind_address).await?;
    tracing::info!("Portal listening on {}", bind_address);

    axum::serve(listener, app).await?;

    Ok(())
}
