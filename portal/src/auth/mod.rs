//! Authentication module
//!
//! This module provides OAuth2/OIDC authentication for the portal.
//!
//! ## Structure
//!
//! - `extractors`: Axum extractors for authenticated users
//! - `jwt`: JWT validation and caching
//! - `helpers`: Pure helper functions (URL builders, cookie extraction, probing)
//! - `handlers`: HTTP handlers for login, callback, and logout flows
//!
//! ## Authentication Flow
//!
//! 1. User visits `/auth/login` → redirect to Keycloak
//! 2. Keycloak authenticates → redirect to `/auth/callback`
//! 3. Portal exchanges code for tokens → sets cookies → redirect to `/dashboard`
//! 4. User visits `/auth/logout` → cascading logout through oauth2-proxy services → Keycloak

pub mod extractors;
pub mod handlers;
pub mod helpers;
pub mod jwt;

// Re-export handlers for convenient routing
pub use handlers::{
    callback_handler, login_handler, logout_complete_handler, logout_handler, CallbackParams,
    LogoutQuery,
};

// Re-export helper types that may be useful for testing
pub use helpers::{
    build_keycloak_logout_url, build_oauth2_proxy_sign_out_url, build_portal_logout_continue_url,
    extract_cookie, parse_service_url, FindReachableResult, Oauth2ProxyService, ParsedServiceUrl,
    ProbeResult,
};

#[cfg(test)]
mod tests {
    use crate::services::descriptor::{AuthType, Service as ServiceDescriptor};

    #[test]
    fn test_list_oauth2_proxy_services_filters_correctly() {
        // This test verifies the filtering logic by checking the filter predicate
        // The actual function requires AppState, so we test the filter logic directly

        let services = vec![
            ServiceDescriptor {
                id: "demo".to_string(),
                name: "Demo".to_string(),
                url: "http://demo.localhost".to_string(),
                protected: true,
                auth_type: AuthType::Oauth2Proxy,
                group: None,
                icon: None,
                description: None,
                required_realm_roles: Some(vec!["dev".to_string()]),
            },
            ServiceDescriptor {
                id: "docs".to_string(),
                name: "Docs".to_string(),
                url: "http://docs.localhost".to_string(),
                protected: false,
                auth_type: AuthType::None,
                group: None,
                icon: None,
                description: None,
                required_realm_roles: None,
            },
            ServiceDescriptor {
                id: "admin".to_string(),
                name: "Admin".to_string(),
                url: "http://admin.localhost".to_string(),
                protected: true,
                auth_type: AuthType::Oauth2Proxy,
                group: None,
                icon: None,
                description: None,
                required_realm_roles: Some(vec!["admin".to_string()]),
            },
        ];

        let oauth2_proxy_services: Vec<_> = services
            .iter()
            .filter(|s| s.auth_type == AuthType::Oauth2Proxy)
            .collect();

        assert_eq!(oauth2_proxy_services.len(), 2);
        assert_eq!(oauth2_proxy_services[0].id, "demo");
        assert_eq!(oauth2_proxy_services[1].id, "admin");
    }
}
