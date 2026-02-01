pub mod authz;
pub mod descriptor;
mod descriptor_gen;
pub mod models;

pub use authz::{build_role_set, can_access_service, ADMIN_ROLE};
pub use descriptor::{
    AuthType, Descriptor, DescriptorError, DescriptorSource, DescriptorSummary, KeycloakDescriptor,
    PortalDescriptor, ServiceDescriptor,
};
// Re-export generated types for direct access
pub use descriptor_gen::{KeycloakConfig, PortalConfig, Service};
pub use models::ServiceCard;

use crate::config::{DescriptorConfig, DescriptorSource as ConfigSource};

/// Load and validate the portal descriptor from the configured source
///
/// This function:
/// 1. Loads the descriptor from the configured source (env var or file)
/// 2. Validates the descriptor against strict rules
/// 3. Returns the descriptor or a detailed error
///
/// Note: This function never logs the raw descriptor JSON to avoid
/// accidental leakage if someone violates the "non-secret" rule.
pub fn load_descriptor(config: &DescriptorConfig) -> anyhow::Result<Descriptor> {
    let (descriptor, source) = match &config.source {
        ConfigSource::Json(json) => {
            let desc = Descriptor::from_json_with_source(json, DescriptorSource::EnvJson)
                .map_err(|e| anyhow::anyhow!("{}", e))?;
            (desc, DescriptorSource::EnvJson)
        }
        ConfigSource::File(path) => {
            let desc = Descriptor::from_file(path).map_err(|e| anyhow::anyhow!("{}", e))?;
            (desc, DescriptorSource::FilePath)
        }
    };

    // Validate the descriptor
    if let Err(error) = descriptor.validate() {
        // Log which source was used, but never log the raw JSON
        tracing::error!(
            source = %source,
            error = %error,
            "Descriptor validation failed"
        );
        return Err(anyhow::anyhow!(
            "Descriptor validation failed ({}): {}",
            source,
            error
        ));
    }

    // Log summary (non-sensitive) for debugging
    let summary = descriptor.summary();
    tracing::info!(
        source = %source,
        deployment_id = %summary.deployment_id,
        environment = %summary.environment,
        base_domain = %summary.base_domain,
        portal_url = %summary.portal_url,
        keycloak_url = %summary.keycloak_url,
        total_services = summary.total_services,
        protected_services = summary.protected_services,
        public_services = summary.public_services,
        "Descriptor loaded successfully"
    );

    Ok(descriptor)
}

/// Convert descriptor services to ServiceCard for UI rendering
pub fn services_from_descriptor(descriptor: &Descriptor) -> Vec<ServiceCard> {
    descriptor
        .services
        .iter()
        .map(|s| ServiceCard {
            id: s.id.clone(),
            name: s.name.clone(),
            url: s.url.clone(),
            icon: s.icon.clone().unwrap_or_else(|| "box".to_string()),
            description: s.description.clone(),
            protected: s.protected,
            auth_type: s.auth_type.clone(),
            required_realm_roles: s.required_realm_roles.clone(),
        })
        .collect()
}

/// Filter services to only those accessible by a user with the given roles
///
/// Per plan.md 2.7: Portal should only show service cards the user can access.
/// This is UI-only filtering; oauth2-proxy remains the enforcement point.
///
/// Uses a precomputed HashSet for efficient role lookups across all services.
pub fn filter_services_for_user(
    services: &[ServiceCard],
    user_roles: &[String],
) -> Vec<ServiceCard> {
    let role_set = build_role_set(user_roles);
    services
        .iter()
        .filter(|service| service.is_accessible_by_role_set(&role_set))
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_descriptor_json() -> &'static str {
        r#"{
            "version": "1",
            "deploymentId": "local",
            "environment": "dev",
            "baseDomain": "localhost",
            "portal": { "publicUrl": "http://localhost" },
            "keycloak": {
                "publicUrl": "http://keycloak.localhost",
                "issuerUrl": "http://keycloak.localhost/realms/dev",
                "realm": "dev"
            },
            "services": [
                {
                    "id": "demo",
                    "name": "Demo App",
                    "url": "http://demo.localhost",
                    "protected": true,
                    "authType": "oauth2-proxy",
                    "requiredRealmRoles": ["admin", "dev"]
                }
            ]
        }"#
    }

    #[test]
    fn test_load_descriptor_from_json_config() {
        let config = DescriptorConfig {
            source: ConfigSource::Json(sample_descriptor_json().to_string()),
        };
        let result = load_descriptor(&config);
        assert!(result.is_ok());
        let descriptor = result.unwrap();
        assert_eq!(descriptor.deployment_id, "local");
    }

    #[test]
    fn test_load_descriptor_from_file_config() {
        // Write a temp file
        let temp_dir = std::env::temp_dir();
        let temp_file = temp_dir.join("test_descriptor.json");
        std::fs::write(&temp_file, sample_descriptor_json()).unwrap();

        let config = DescriptorConfig {
            source: ConfigSource::File(temp_file.to_string_lossy().to_string()),
        };
        let result = load_descriptor(&config);
        assert!(result.is_ok());
        let descriptor = result.unwrap();
        assert_eq!(descriptor.deployment_id, "local");

        // Cleanup
        std::fs::remove_file(&temp_file).ok();
    }

    #[test]
    fn test_services_from_descriptor() {
        let descriptor =
            Descriptor::from_json_with_source(sample_descriptor_json(), DescriptorSource::EnvJson)
                .unwrap();
        let services = services_from_descriptor(&descriptor);
        assert_eq!(services.len(), 1);
        assert_eq!(services[0].id, "demo");
        assert_eq!(services[0].name, "Demo App");
        assert!(services[0].protected);
    }

    // =========================================================================
    // End-to-end test for filter_services_for_user
    // Verifies wiring between ServiceCard and authz module
    // =========================================================================

    #[test]
    fn test_filter_services_for_user_end_to_end() {
        // Create ServiceCards matching Phase 2.7 acceptance criteria:
        // - demo: oauth2-proxy, required roles: admin|dev
        // - dozzle: oauth2-proxy, required roles: admin only
        // - docs: public (authType: none)
        // - admin-panel: portal-auth, required roles: admin
        let services = vec![
            ServiceCard {
                id: "demo".to_string(),
                name: "Demo App".to_string(),
                url: "http://demo.localhost".to_string(),
                icon: "rocket".to_string(),
                description: Some("Demo application".to_string()),
                protected: true,
                auth_type: AuthType::Oauth2Proxy,
                required_realm_roles: Some(vec!["admin".to_string(), "dev".to_string()]),
            },
            ServiceCard {
                id: "dozzle".to_string(),
                name: "Dozzle".to_string(),
                url: "http://dozzle.localhost".to_string(),
                icon: "logs".to_string(),
                description: Some("Log viewer".to_string()),
                protected: true,
                auth_type: AuthType::Oauth2Proxy,
                required_realm_roles: Some(vec!["admin".to_string()]),
            },
            ServiceCard {
                id: "docs".to_string(),
                name: "Documentation".to_string(),
                url: "http://docs.localhost".to_string(),
                icon: "book".to_string(),
                description: None,
                protected: false,
                auth_type: AuthType::None,
                required_realm_roles: None,
            },
            ServiceCard {
                id: "admin-panel".to_string(),
                name: "Admin Panel".to_string(),
                url: "http://admin.localhost".to_string(),
                icon: "settings".to_string(),
                description: Some("Admin dashboard".to_string()),
                protected: true,
                auth_type: AuthType::Portal,
                required_realm_roles: Some(vec!["admin".to_string()]),
            },
        ];

        // Test: dev user sees demo + docs only (not dozzle, not admin-panel)
        let dev_roles = vec!["dev".to_string()];
        let dev_services = filter_services_for_user(&services, &dev_roles);
        let dev_ids: Vec<&str> = dev_services.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(dev_ids, vec!["demo", "docs"]);

        // Test: admin user sees everything
        let admin_roles = vec!["admin".to_string()];
        let admin_services = filter_services_for_user(&services, &admin_roles);
        let admin_ids: Vec<&str> = admin_services.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(admin_ids, vec!["demo", "dozzle", "docs", "admin-panel"]);

        // Test: user with no roles sees only public services
        let no_roles: Vec<String> = vec![];
        let no_role_services = filter_services_for_user(&services, &no_roles);
        let no_role_ids: Vec<&str> = no_role_services.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(no_role_ids, vec!["docs"]);
    }
}
