use std::env;

#[derive(Debug, Clone, PartialEq)]
pub enum Environment {
    Development,
    Production,
}

/// Source for the portal descriptor
#[derive(Debug, Clone)]
pub enum DescriptorSource {
    /// Descriptor provided as JSON string via PORTAL_DESCRIPTOR_JSON env var
    Json(String),
    /// Descriptor loaded from file path via PORTAL_DESCRIPTOR_PATH env var
    File(String),
}

/// Descriptor configuration
#[derive(Debug, Clone)]
pub struct DescriptorConfig {
    pub source: DescriptorSource,
}

#[derive(Debug, Clone)]
pub struct Config {
    // Environment configuration
    pub environment: Environment,

    // Server configuration
    pub server_host: String,
    pub server_port: u16,

    // Portal public URL (for logout redirects)
    pub portal_public_url: String,

    // Keycloak configuration
    pub keycloak_url: String, // Internal URL for server-to-server (http://keycloak:8080)
    pub keycloak_callback_url: String, // Public URL for browser redirects (http://keycloak.localhost)
    pub keycloak_realm: String,
    pub client_id: String,
    pub client_secret: String,
    pub redirect_uri: String,

    // Cookie configuration (None = host-only cookie, Some = domain cookie)
    pub cookie_domain: Option<String>,

    // HTTP client timeout configuration (in seconds)
    pub http_connect_timeout_secs: u64,
    pub http_request_timeout_secs: u64,

    // JWKS cache configuration (in seconds)
    pub jwks_cache_ttl_secs: u64,

    // Logout reachability probe configuration (in milliseconds)
    // Per plan.md 2.8.1: short timeouts to keep logout fast
    pub logout_probe_connect_timeout_ms: u64,
    pub logout_probe_request_timeout_ms: u64,

    // Internal Traefik URL for reachability probes (container-to-container)
    // The portal probes services through Traefik using Host headers since
    // public URLs (e.g., dozzle.localhost) are not resolvable inside Docker.
    pub traefik_internal_url: Option<String>,

    // Descriptor configuration (replaces service discovery)
    pub descriptor: DescriptorConfig,
}

impl Config {
    /// Load configuration from environment variables using std::env::var
    pub fn load() -> anyhow::Result<Self> {
        // Parse environment type
        let environment = match env::var("ENVIRONMENT")
            .unwrap_or_else(|_| "development".to_string())
            .to_lowercase()
            .as_str()
        {
            "production" | "prod" => Environment::Production,
            _ => Environment::Development,
        };

        // Required variables
        let keycloak_url = env::var("KEYCLOAK_URL")
            .map_err(|_| anyhow::anyhow!("KEYCLOAK_URL environment variable is required"))?;

        let keycloak_callback_url = env::var("KEYCLOAK_CALLBACK_URL").map_err(|_| {
            anyhow::anyhow!("KEYCLOAK_CALLBACK_URL environment variable is required")
        })?;

        let keycloak_realm = env::var("KEYCLOAK_REALM")
            .map_err(|_| anyhow::anyhow!("KEYCLOAK_REALM environment variable is required"))?;

        let client_id = env::var("CLIENT_ID")
            .map_err(|_| anyhow::anyhow!("CLIENT_ID environment variable is required"))?;

        let client_secret = env::var("CLIENT_SECRET")
            .map_err(|_| anyhow::anyhow!("CLIENT_SECRET environment variable is required"))?;

        let redirect_uri = env::var("REDIRECT_URI")
            .map_err(|_| anyhow::anyhow!("REDIRECT_URI environment variable is required"))?;

        // Portal public URL - derive from REDIRECT_URI by stripping the path
        // e.g., http://portal.localhost/auth/callback -> http://portal.localhost
        let portal_public_url = env::var("PORTAL_PUBLIC_URL").unwrap_or_else(|_| {
            // Derive from redirect_uri by finding the third slash
            redirect_uri
                .find("://")
                .and_then(|scheme_end| {
                    redirect_uri[scheme_end + 3..]
                        .find('/')
                        .map(|path_start| redirect_uri[..scheme_end + 3 + path_start].to_string())
                })
                .unwrap_or_else(|| redirect_uri.clone())
        });

        // Optional variables with defaults
        let server_host = env::var("SERVER_HOST").unwrap_or_else(|_| "0.0.0.0".to_string());

        let server_port = env::var("SERVER_PORT")
            .ok()
            .and_then(|s| s.parse::<u16>().ok())
            .unwrap_or(3000);

        // Cookie domain: if not set or empty, use host-only cookies (no Domain attribute)
        let cookie_domain = env::var("COOKIE_DOMAIN").ok().filter(|s| !s.is_empty());

        let http_connect_timeout_secs = env::var("HTTP_CONNECT_TIMEOUT_SECS")
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(10);

        let http_request_timeout_secs = env::var("HTTP_REQUEST_TIMEOUT_SECS")
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(30);

        let jwks_cache_ttl_secs = env::var("JWKS_CACHE_TTL_SECS")
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(3600);

        // Logout reachability probe timeouts (per plan.md 2.8.1)
        // Short timeouts to keep logout fast; defaults: 300ms connect, 750ms total
        let logout_probe_connect_timeout_ms = env::var("LOGOUT_PROBE_CONNECT_TIMEOUT_MS")
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(300);

        let logout_probe_request_timeout_ms = env::var("LOGOUT_PROBE_REQUEST_TIMEOUT_MS")
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(750);

        // Internal Traefik URL for reachability probes
        // e.g., http://local-traefik:80 or http://traefik:80
        let traefik_internal_url = env::var("TRAEFIK_INTERNAL_URL")
            .ok()
            .filter(|s| !s.is_empty());

        // Descriptor configuration (primary: JSON env var, fallback: file path)
        let descriptor_source = if let Ok(json) = env::var("PORTAL_DESCRIPTOR_JSON") {
            DescriptorSource::Json(json)
        } else if let Ok(path) = env::var("PORTAL_DESCRIPTOR_PATH") {
            DescriptorSource::File(path)
        } else {
            return Err(anyhow::anyhow!(
                "Either PORTAL_DESCRIPTOR_JSON or PORTAL_DESCRIPTOR_PATH environment variable is required"
            ));
        };

        Ok(Config {
            environment,
            server_host,
            server_port,
            portal_public_url,
            keycloak_url,
            keycloak_callback_url,
            keycloak_realm,
            client_id,
            client_secret,
            redirect_uri,
            cookie_domain,
            http_connect_timeout_secs,
            http_request_timeout_secs,
            jwks_cache_ttl_secs,
            logout_probe_connect_timeout_ms,
            logout_probe_request_timeout_ms,
            traefik_internal_url,
            descriptor: DescriptorConfig {
                source: descriptor_source,
            },
        })
    }

    /// Check if running in production mode
    pub fn is_production(&self) -> bool {
        self.environment == Environment::Production
    }

    /// Get cookie security flags based on environment
    pub fn cookie_secure_flag(&self) -> &str {
        if self.is_production() {
            "; Secure"
        } else {
            ""
        }
    }

    /// Get cookie domain attribute string (empty if host-only cookie)
    pub fn cookie_domain_attr(&self) -> String {
        match &self.cookie_domain {
            Some(domain) => format!("; Domain={}", domain),
            None => String::new(),
        }
    }

    /// Get bind address for server
    pub fn bind_address(&self) -> String {
        format!("{}:{}", self.server_host, self.server_port)
    }
}
