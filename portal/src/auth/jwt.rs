use anyhow::{Context, Result};
use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

// Helper struct for deserializing Keycloak's realm_access structure
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct RealmAccess {
    pub(crate) roles: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String,
    pub exp: usize,
    #[serde(default)]
    pub preferred_username: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub(crate) realm_access: Option<RealmAccess>,
    #[serde(default)]
    pub(crate) resource_access: Option<serde_json::Value>,
}

impl Claims {
    /// Get all roles from the JWT token
    /// Keycloak stores roles in realm_access.roles and optionally in resource_access
    pub fn roles(&self) -> Vec<String> {
        self.realm_access
            .as_ref()
            .map(|ra| ra.roles.clone())
            .unwrap_or_default()
    }

    /// Check if the token has realm_access claim at all
    /// Used for diagnostic logging when roles are empty
    pub fn has_realm_access(&self) -> bool {
        self.realm_access.is_some()
    }
}

#[derive(Debug, Deserialize)]
struct JwksResponse {
    keys: Vec<Jwk>,
}

#[derive(Debug, Deserialize)]
struct Jwk {
    kid: String,
    n: String,
    e: String,
}

struct JwksCache {
    keys: HashMap<String, DecodingKey>,
    fetched_at: Instant,
}

pub struct JwtValidator {
    keycloak_internal_url: String,
    realm: String,
    /// Expected issuer URL (Keycloak public URL + realm path)
    expected_issuer: String,
    /// Expected audience (typically the client_id)
    expected_audience: String,
    client: reqwest::Client,
    jwks_cache: RwLock<Option<JwksCache>>,
    cache_ttl: Duration,
}

impl JwtValidator {
    /// Create Keycloak JWT validator (RS256 with JWKS)
    ///
    /// # Arguments
    /// * `keycloak_internal_url` - Internal URL for JWKS fetching (container-to-container)
    /// * `keycloak_public_url` - Public URL for issuer validation (what browser sees)
    /// * `realm` - Keycloak realm name
    /// * `expected_audience` - Expected audience claim (typically client_id)
    /// * `connect_timeout_secs` - HTTP connect timeout
    /// * `request_timeout_secs` - HTTP request timeout
    /// * `jwks_cache_ttl_secs` - JWKS cache TTL
    pub fn new(
        keycloak_internal_url: String,
        keycloak_public_url: String,
        realm: String,
        expected_audience: String,
        connect_timeout_secs: u64,
        request_timeout_secs: u64,
        jwks_cache_ttl_secs: u64,
    ) -> Result<Self, String> {
        // Normalize URLs by trimming trailing slashes to prevent double-slash issues
        // e.g., "https://keycloak.example.com/" -> "https://keycloak.example.com"
        let keycloak_internal_url = keycloak_internal_url.trim_end_matches('/').to_string();
        let keycloak_public_url = keycloak_public_url.trim_end_matches('/');

        // Build expected issuer URL: {keycloak_public_url}/realms/{realm}
        let expected_issuer = format!("{}/realms/{}", keycloak_public_url, realm);

        tracing::info!(
            keycloak_internal_url = %keycloak_internal_url,
            expected_issuer = %expected_issuer,
            expected_audience = %expected_audience,
            jwks_cache_ttl_secs = jwks_cache_ttl_secs,
            "JWT validator initialized with issuer and audience validation"
        );

        // Security: Add timeouts to prevent Slowloris DoS attacks
        let client = reqwest::ClientBuilder::new()
            .connect_timeout(std::time::Duration::from_secs(connect_timeout_secs))
            .timeout(std::time::Duration::from_secs(request_timeout_secs))
            .build()
            .map_err(|e| format!("Failed to build HTTP client for JWKS: {}", e))?;

        Ok(Self {
            keycloak_internal_url,
            realm,
            expected_issuer,
            expected_audience,
            client,
            jwks_cache: RwLock::new(None),
            cache_ttl: Duration::from_secs(jwks_cache_ttl_secs),
        })
    }

    /// Validate JWT token asynchronously (fetches JWKS if not cached or expired)
    pub async fn validate_async(&self, token: &str) -> Result<Claims> {
        tracing::debug!(token_len = token.len(), "Validating JWT token (async)");

        let header = decode_header(token).context("Invalid token header")?;
        let kid = header.kid.context("Token missing kid")?;

        tracing::debug!(kid = %kid, "Token kid extracted");

        // Try to get key from cache first
        let decoding_key = match self.get_cached_key(&kid).await? {
            Some(key) => key,
            None => {
                // Key not found in cache - refresh and try again
                tracing::warn!(
                    kid = %kid,
                    "Key ID not found in cache, forcing JWKS refresh"
                );
                self.refresh_jwks().await?;

                match self.get_cached_key(&kid).await? {
                    Some(key) => key,
                    None => {
                        let cache = self.jwks_cache.read().await;
                        let available_kids: Vec<_> = cache
                            .as_ref()
                            .map(|c| c.keys.keys().collect())
                            .unwrap_or_default();
                        tracing::error!(
                            kid = %kid,
                            available_kids = ?available_kids,
                            "Unknown key ID - kid not found in JWKS even after refresh"
                        );
                        anyhow::bail!("Unknown key ID: {}", kid);
                    }
                }
            }
        };

        let mut validation = Validation::new(Algorithm::RS256);
        validation.validate_exp = true;
        // Security: Validate issuer to reject tokens from other Keycloak realms/servers
        validation.set_issuer(&[&self.expected_issuer]);
        // Security: Validate audience to prevent token reuse across clients
        validation.set_audience(&[&self.expected_audience]);

        let token_data = match decode::<Claims>(token, &decoding_key, &validation) {
            Ok(data) => data,
            Err(e) => {
                // Security audit logging - log failure details for forensics
                let token_hash = format!("{:x}", md5::compute(token));
                tracing::error!(
                    error = ?e,
                    kid = %kid,
                    alg = ?header.alg,
                    token_hash = %token_hash,
                    token_len = token.len(),
                    "JWT decode/validation failed - potential security incident"
                );
                anyhow::bail!("Token validation failed: {}", e);
            }
        };

        let roles = token_data.claims.roles();
        tracing::info!(
            sub = %token_data.claims.sub,
            username = ?token_data.claims.preferred_username,
            roles = ?roles,
            "Token validated successfully"
        );

        Ok(token_data.claims)
    }

    /// Check if JWKS is cached (for health checks)
    pub async fn is_jwks_cached(&self) -> bool {
        self.jwks_cache.read().await.is_some()
    }

    /// Prefetch JWKS at startup to ensure readiness checks pass immediately.
    /// This should be called once during application initialization.
    pub async fn prefetch_jwks(&self) -> Result<()> {
        tracing::info!("Prefetching JWKS at startup for readiness");
        self.refresh_jwks().await
    }

    /// Get cached key if available and not expired
    async fn get_cached_key(&self, kid: &str) -> Result<Option<DecodingKey>> {
        // Check cache validity first
        let needs_refresh = {
            let cache = self.jwks_cache.read().await;

            if let Some(jwks_cache) = cache.as_ref() {
                // Check if cache is still valid
                if jwks_cache.fetched_at.elapsed() < self.cache_ttl {
                    // Cache is valid, try to get key
                    return Ok(jwks_cache.keys.get(kid).cloned());
                }
                // Cache expired
                tracing::info!(
                    elapsed_secs = jwks_cache.fetched_at.elapsed().as_secs(),
                    ttl_secs = self.cache_ttl.as_secs(),
                    "JWKS cache expired, will refresh"
                );
                true
            } else {
                // No cache at all
                true
            }
        }; // Lock is dropped here

        if needs_refresh {
            self.refresh_jwks().await?;

            let cache = self.jwks_cache.read().await;
            Ok(cache.as_ref().and_then(|c| c.keys.get(kid).cloned()))
        } else {
            Ok(None)
        }
    }

    /// Refresh JWKS cache from Keycloak
    async fn refresh_jwks(&self) -> Result<()> {
        let url = format!(
            "{}/realms/{}/protocol/openid-connect/certs",
            self.keycloak_internal_url, self.realm
        );

        tracing::info!(url = %url, "Fetching JWKS from Keycloak");

        let response: JwksResponse = self
            .client
            .get(&url)
            .send()
            .await
            .context("Failed to fetch JWKS")?
            .json()
            .await
            .context("Failed to parse JWKS")?;

        tracing::info!(key_count = response.keys.len(), "JWKS fetched successfully");

        let mut keys = HashMap::new();
        for jwk in response.keys {
            let key = DecodingKey::from_rsa_components(&jwk.n, &jwk.e)
                .context("Failed to create decoding key")?;
            keys.insert(jwk.kid.clone(), key);
            tracing::debug!(kid = %jwk.kid, "Added key to cache");
        }

        let mut cache = self.jwks_cache.write().await;
        *cache = Some(JwksCache {
            keys,
            fetched_at: Instant::now(),
        });

        Ok(())
    }
}
